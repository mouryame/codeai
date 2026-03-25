/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { generateUuid } from "../../../../base/common/uuid.js";
import {
	CascadePhase,
	ICascadeOrchestrator,
	IGenerateRequest,
	IGenerateResult,
	ILocalModelsService,
	IPlanStep,
	IStreamCallbacks,
	IThreadMessage,
	IMemoryService,
	IAgenticOrchestrator,
} from "../common/codeai.js";
import { ICodeAILogService } from "../common/logService.js";
import { ICodebaseContextService } from "./codebaseContext.js";
import { AutonomousOrchestrator } from "./autonomousOrchestrator.js";

/**
 * Estimates token count from text using a simple heuristic (≈4 chars per token).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Singleton orchestrator that manages thread state, phase tracking,
 * plan logging, and role-based model routing for the CodeAI system.
 */
export class CascadeOrchestrator
	extends Disposable
	implements ICascadeOrchestrator
{
	readonly _serviceBrand: undefined;

	// ── Events ──────────────────────────────────────────────────────────────

	private readonly _onDidChangePhase = this._register(
		new Emitter<CascadePhase>(),
	);
	readonly onDidChangePhase: Event<CascadePhase> = this._onDidChangePhase.event;

	private readonly _onDidUpdatePlan = this._register(
		new Emitter<IPlanStep[]>(),
	);
	readonly onDidUpdatePlan: Event<IPlanStep[]> = this._onDidUpdatePlan.event;

	// ── State ───────────────────────────────────────────────────────────────

	private _currentPhase: CascadePhase = "understanding";
	private _planSteps: IPlanStep[] = [];
	private _thread: IThreadMessage[] = [];
	private readonly autonomousOrchestrator: AutonomousOrchestrator;

	constructor(
		@ILocalModelsService private readonly modelsService: ILocalModelsService,
		@ICodeAILogService private readonly codeaiLogService: ICodeAILogService,
		@ILogService private readonly logService: ILogService,
		@ICodebaseContextService
		private readonly codebaseContext: ICodebaseContextService,
		@IMemoryService private readonly memoryService: IMemoryService,
		@IAgenticOrchestrator
		private readonly agenticOrchestrator: IAgenticOrchestrator,
	) {
		super();

		// Initialize autonomous orchestrator for closed-loop tool execution
		this.autonomousOrchestrator = this
			.agenticOrchestrator as any as AutonomousOrchestrator;

		// React to config changes
		this._register(
			this.modelsService.onDidChangeConfig(() => {
				this.logService.info(
					"[CodeAI] Orchestrator detected config change — runners will be refreshed on next request.",
				);
			}),
		);
	}

	// ── Phase ───────────────────────────────────────────────────────────────

	get currentPhase(): CascadePhase {
		return this._currentPhase;
	}

	get planSteps(): readonly IPlanStep[] {
		return this._planSteps;
	}

	private setPhase(phase: CascadePhase): void {
		if (this._currentPhase !== phase) {
			this._currentPhase = phase;
			this.logService.trace(`[CodeAI] Phase → ${phase}`);
			this._onDidChangePhase.fire(phase);
		}
	}

	// ── Thread management ───────────────────────────────────────────────────

	addUserMessage(content: string): void {
		this._thread.push({
			role: "user",
			content,
			tokenCount: estimateTokens(content),
			timestamp: Date.now(),
		});
		this.pruneThread("reasoning");
	}

	clearThread(): void {
		this._thread = [];
		this._planSteps = [];
		this.setPhase("understanding");
	}

	/**
	 * Prune the oldest messages from the thread when the cumulative token
	 * count approaches the model's context window.
	 */
	private pruneThread(role: "reasoning" | "coding"): void {
		const runner = this.modelsService.getModelByRole(role);
		const maxContext = runner.config.contextWindow;
		let total = this._thread.reduce((sum, m) => sum + m.tokenCount, 0);

		while (total > maxContext * 0.9 && this._thread.length > 1) {
			const removed = this._thread.shift()!;
			total -= removed.tokenCount;
			this.logService.trace(
				`[CodeAI] Pruned message (${removed.tokenCount} tokens) — total now ${total}`,
			);
		}
	}

	// ── Routing helpers ─────────────────────────────────────────────────────

	private buildPromptFromThread(systemPrompt?: string): string {
		const parts: string[] = [];
		if (systemPrompt) {
			parts.push(`[system]\n${systemPrompt}`);
		}
		for (const msg of this._thread) {
			parts.push(`[${msg.role}]\n${msg.content}`);
		}
		return parts.join("\n\n");
	}

	private async buildCodebaseContext(query: string): Promise<string> {
		try {
			// Use new enriched context with retrieval and memory
			return await this.codebaseContext.buildFullContext(query);
		} catch (err) {
			this.logService.warn("[CodeAI] Failed to build codebase context:", err);
			// Fallback to basic context
			try {
				const openFiles = await this.codebaseContext.getOpenFilesContext();
				const workspace = await this.codebaseContext.getWorkspaceStructure();
				return workspace + openFiles;
			} catch (fallbackErr) {
				return "";
			}
		}
	}

	private async routeToModel(
		role: "reasoning" | "coding",
		prompt: string,
		systemPrompt: string | undefined,
		callbacks: IStreamCallbacks | undefined,
	): Promise<IGenerateResult> {
		// Ensure memory budget before loading
		await this.modelsService.ensureMemoryBudget(role);

		const runner = this.modelsService.getModelByRole(role);
		this.pruneThread(role);

		// Build enriched context from workspace with retrieval
		const codebaseContext = await this.buildCodebaseContext(prompt);
		const fullPrompt =
			this.buildPromptFromThread(systemPrompt) +
			codebaseContext +
			`\n\n[user]\n${prompt}`;

		const request: IGenerateRequest = {
			prompt: fullPrompt,
			role,
			systemPrompt,
			maxTokens: runner.config.maxTokens,
			temperature: runner.config.temperature,
		};

		const result = await runner.generate(request, callbacks);

		// Record assistant response in thread
		this._thread.push({
			role: "assistant",
			content: result.text,
			tokenCount: result.tokensUsed,
			timestamp: Date.now(),
		});

		return result;
	}

	// ── Public API ──────────────────────────────────────────────────────────

	async runPlanning(
		prompt: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		this.setPhase("planning");

		const step: IPlanStep = {
			id: generateUuid(),
			description: prompt.slice(0, 120),
			phase: "planning",
			status: "in_progress",
			timestamp: Date.now(),
		};
		this._planSteps.push(step);
		this._onDidUpdatePlan.fire([...this._planSteps]);

		const result = await this.routeToModel(
			"reasoning",
			prompt,
			"You are a planning assistant. Wrap your reasoning in <think></think> tags, then provide clear, actionable steps in markdown format.",
			callbacks,
		);

		// Update step status
		const idx = this._planSteps.findIndex((s) => s.id === step.id);
		if (idx !== -1) {
			this._planSteps[idx] = { ...step, status: "completed" };
			this._onDidUpdatePlan.fire([...this._planSteps]);
		}

		// Log plan
		await this.codeaiLogService.appendPlan(
			`**Planning** — ${prompt.slice(0, 120)}\n\n${result.text}`,
		);

		this.setPhase("reading");
		return result;
	}

	async runCodeEdit(
		prompt: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		this.setPhase("applying");

		const step: IPlanStep = {
			id: generateUuid(),
			description: `Code edit: ${prompt.slice(0, 100)}`,
			phase: "applying",
			status: "in_progress",
			timestamp: Date.now(),
		};
		this._planSteps.push(step);
		this._onDidUpdatePlan.fire([...this._planSteps]);

		const result = await this.routeToModel(
			"coding",
			prompt,
			"You are a code editing assistant. Produce only the changed code.",
			callbacks,
		);

		// Update step status
		const idx = this._planSteps.findIndex((s) => s.id === step.id);
		if (idx !== -1) {
			this._planSteps[idx] = { ...step, status: "completed" };
			this._onDidUpdatePlan.fire([...this._planSteps]);
		}

		// Log change
		await this.codeaiLogService.appendChange(
			`**Code Edit** — ${prompt.slice(0, 100)}\n\n\`\`\`\n${result.text}\n\`\`\``,
		);

		// Record change in memory
		await this.memoryService.recordChange(`Code edit: ${prompt.slice(0, 100)}`);

		this.setPhase("completed");
		return result;
	}

	async runChat(
		prompt: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		this.setPhase("understanding");

		// Use autonomous orchestrator for closed-loop tool execution
		// This ensures the agent NEVER exposes tools to the user
		// and operates in a fully autonomous manner
		const result = await this.autonomousOrchestrator.runAgenticTask(
			prompt,
			callbacks,
		);

		this.setPhase("completed");
		return result;
	}
}
