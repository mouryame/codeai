/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from "../../../../base/common/event.js";
import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { IModelConfig, IModelsConfig } from "./modelsConfig.js";

// ── Orchestrator Phase ──────────────────────────────────────────────────────

export type CascadePhase =
	| "understanding"
	| "planning"
	| "reading"
	| "applying"
	| "completed";

// ── Streaming Callbacks ─────────────────────────────────────────────────────

export interface IStreamCallbacks {
	onText?(chunk: string): void;
	onFinalMessage?(full: string): void;
	onError?(error: Error): void;
}

// ── Generation Request / Result ─────────────────────────────────────────────

export interface IGenerateRequest {
	readonly prompt: string;
	readonly role: "reasoning" | "coding";
	readonly systemPrompt?: string;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly signal?: AbortSignal;
}

export interface IGenerateResult {
	readonly text: string;
	readonly tokensUsed: number;
	readonly modelId: string;
}

// ── Thread Message ──────────────────────────────────────────────────────────

export interface IThreadMessage {
	readonly role: "user" | "assistant" | "system";
	readonly content: string;
	readonly tokenCount: number;
	readonly timestamp: number;
}

// ── Plan Step ───────────────────────────────────────────────────────────────

export interface IPlanStep {
	readonly id: string;
	readonly description: string;
	readonly phase: CascadePhase;
	readonly status: "pending" | "in_progress" | "completed" | "failed";
	readonly timestamp: number;
}

// ── Edit Operation ──────────────────────────────────────────────────────────

export type EditMode = "fast" | "slow";

export interface IEditOperation {
	readonly filePath: string;
	readonly mode: EditMode;
	readonly oldText?: string;
	readonly newText: string;
	readonly description: string;
}

export interface IDiffZone {
	readonly startLine: number;
	readonly endLine: number;
	readonly originalContent: string;
	readonly newContent: string;
}

// ── ILocalModelRunner ───────────────────────────────────────────────────────

export const ILocalModelRunner = createDecorator<ILocalModelRunner>(
	"codeaiLocalModelRunner",
);

export interface ILocalModelRunner {
	readonly _serviceBrand: undefined;

	/**
	 * Generate text from a prompt with streaming support.
	 */
	generate(
		request: IGenerateRequest,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult>;

	/**
	 * Whether the underlying model is currently loaded in memory.
	 */
	isLoaded(): boolean;

	/**
	 * Load the model into memory.
	 */
	load(): Promise<void>;

	/**
	 * Unload the model from memory.
	 */
	unload(): Promise<void>;

	/**
	 * Abort the current generation.
	 */
	abort(): void;

	/**
	 * The configuration for this runner's model.
	 */
	readonly config: IModelConfig;
}

// ── ILocalModelsService ─────────────────────────────────────────────────────

export const ILocalModelsService = createDecorator<ILocalModelsService>(
	"codeaiLocalModelsService",
);

export interface ILocalModelsService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the model configuration changes.
	 */
	readonly onDidChangeConfig: Event<IModelsConfig>;

	/**
	 * Load all models from the embedded configuration.
	 */
	loadModels(): Promise<void>;

	/**
	 * Get a model runner by its role.
	 */
	getModelByRole(role: "reasoning" | "coding"): ILocalModelRunner;

	/**
	 * Get the current models configuration.
	 */
	getConfig(): IModelsConfig;

	/**
	 * Returns the current system memory usage ratio (0–1).
	 */
	getMemoryUsage(): number;

	/**
	 * Perform memory-aware fallback: unload unused models if pressure is high.
	 */
	ensureMemoryBudget(requiredRole: "reasoning" | "coding"): Promise<void>;
}

// ── ICascadeOrchestrator ────────────────────────────────────────────────────

export const ICascadeOrchestrator = createDecorator<ICascadeOrchestrator>(
	"codeaiCascadeOrchestrator",
);

export interface ICascadeOrchestrator {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the orchestrator phase changes.
	 */
	readonly onDidChangePhase: Event<CascadePhase>;

	/**
	 * Fires when a new plan step is added or updated.
	 */
	readonly onDidUpdatePlan: Event<IPlanStep[]>;

	/**
	 * Run a planning task through the reasoning model.
	 */
	runPlanning(
		prompt: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult>;

	/**
	 * Run a code edit task through the coding model.
	 */
	runCodeEdit(
		prompt: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult>;

	/**
	 * Run a general chat message through the reasoning model.
	 */
	runChat(
		prompt: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult>;

	/**
	 * Get the current phase.
	 */
	readonly currentPhase: CascadePhase;

	/**
	 * Get the current plan steps.
	 */
	readonly planSteps: readonly IPlanStep[];

	/**
	 * Add a user message to the thread.
	 */
	addUserMessage(content: string): void;

	/**
	 * Clear the thread.
	 */
	clearThread(): void;
}

// ── IEditCodeService ────────────────────────────────────────────────────────

export const IEditCodeService = createDecorator<IEditCodeService>(
	"codeaiEditCodeService",
);

export interface IEditCodeService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when an edit operation is applied.
	 */
	readonly onDidApplyEdit: Event<IEditOperation>;

	/**
	 * Apply a fast edit (search/replace).
	 */
	fastApply(
		filePath: string,
		oldText: string,
		newText: string,
		description: string,
	): Promise<void>;

	/**
	 * Apply a slow edit (full rewrite via coding model).
	 */
	slowApply(
		filePath: string,
		prompt: string,
		description: string,
		callbacks?: IStreamCallbacks,
	): Promise<void>;

	/**
	 * Get streaming diff zones for a file being edited.
	 */
	getDiffZones(filePath: string): IDiffZone[];
}

// ── Indexing & Retrieval ────────────────────────────────────────────────────

export type ChunkType =
	| "function"
	| "class"
	| "interface"
	| "type"
	| "export"
	| "block";

export interface ICodeChunk {
	readonly id: string;
	readonly filePath: string;
	readonly symbolName?: string;
	readonly type: ChunkType;
	readonly content: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly tokens: number;
	readonly summary?: string;
	readonly keywords: string[];
}

export interface IFileIndex {
	readonly filePath: string;
	readonly chunks: ICodeChunk[];
	readonly lastModified: number;
	readonly fileSize: number;
	readonly language?: string;
	readonly importanceScore: number;
}

export interface ICodebaseIndex {
	readonly version: number;
	readonly files: Map<string, IFileIndex>;
	readonly totalChunks: number;
	readonly lastUpdated: number;
}

export interface IRetrievalResult {
	readonly chunk: ICodeChunk;
	readonly score: number;
	readonly reason?: string;
}

export interface IRetrievalQuery {
	readonly query: string;
	readonly maxResults?: number;
	readonly minScore?: number;
	readonly filePatterns?: string[];
	readonly excludePatterns?: string[];
}

export interface IMemoryEntry {
	readonly timestamp: number;
	readonly category: "architecture" | "decision" | "change" | "summary";
	readonly content: string;
	readonly relatedFiles?: string[];
}

export interface IProjectMemory {
	readonly summary: string;
	readonly architecture: string[];
	readonly keyFiles: Map<string, string>;
	readonly decisions: IMemoryEntry[];
	readonly recentChanges: IMemoryEntry[];
	readonly version: number;
}

// ── ICodebaseIndexService ───────────────────────────────────────────────────

export const ICodebaseIndexService = createDecorator<ICodebaseIndexService>(
	"codebaseIndexService",
);

export interface ICodebaseIndexService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when the index is updated.
	 */
	readonly onDidUpdateIndex: Event<void>;

	/**
	 * Build the initial index for the workspace.
	 */
	buildIndex(): Promise<void>;

	/**
	 * Update index for a specific file.
	 */
	updateFile(filePath: string): Promise<void>;

	/**
	 * Remove a file from the index.
	 */
	removeFile(filePath: string): Promise<void>;

	/**
	 * Get all chunks for a file.
	 */
	getFileChunks(filePath: string): ICodeChunk[];

	/**
	 * Get the current index statistics.
	 */
	getStats(): { totalFiles: number; totalChunks: number; lastUpdated: number };

	/**
	 * Check if the index is ready.
	 */
	isReady(): boolean;

	/**
	 * Get all indexed file paths.
	 */
	getAllFiles(): string[];
}

// ── IRetrievalService ───────────────────────────────────────────────────────

export const IRetrievalService = createDecorator<IRetrievalService>(
	"codeaiRetrievalService",
);

export interface IRetrievalService {
	readonly _serviceBrand: undefined;

	/**
	 * Retrieve relevant code chunks for a query.
	 */
	retrieve(query: IRetrievalQuery): Promise<IRetrievalResult[]>;

	/**
	 * Get chunks by file path.
	 */
	getChunksByFile(filePath: string): Promise<ICodeChunk[]>;

	/**
	 * Get chunks by symbol name.
	 */
	getChunksBySymbol(symbolName: string): Promise<ICodeChunk[]>;
}

// ── IMemoryService ──────────────────────────────────────────────────────────

export const IMemoryService = createDecorator<IMemoryService>(
	"codeaiMemoryService",
);

export interface IMemoryService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when memory is updated.
	 */
	readonly onDidUpdateMemory: Event<void>;

	/**
	 * Get the current project memory.
	 */
	getMemory(): Promise<IProjectMemory>;

	/**
	 * Update project summary.
	 */
	updateSummary(summary: string): Promise<void>;

	/**
	 * Add an architecture note.
	 */
	addArchitectureNote(note: string): Promise<void>;

	/**
	 * Record a key file and its purpose.
	 */
	recordKeyFile(filePath: string, purpose: string): Promise<void>;

	/**
	 * Add a decision entry.
	 */
	addDecision(content: string, relatedFiles?: string[]): Promise<void>;

	/**
	 * Record a change summary.
	 */
	recordChange(content: string, relatedFiles?: string[]): Promise<void>;

	/**
	 * Get a formatted memory context string for prompts.
	 */
	getMemoryContext(): Promise<string>;

	/**
	 * Prune old entries to stay within token budget.
	 */
	pruneMemory(maxTokens: number): Promise<void>;
}

// ── IAgenticOrchestrator ────────────────────────────────────────────────────

export const IAgenticOrchestrator = createDecorator<IAgenticOrchestrator>(
	"codeaiAgenticOrchestrator",
);

export interface IAgenticOrchestrator {
	readonly _serviceBrand: undefined;

	/**
	 * Run an agentic task with autonomous reasoning, tool calling, and action execution.
	 */
	runAgenticTask(
		userRequest: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult>;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const CODEAI_VIEWLET_ID = "workbench.view.codeai";
export const CODEAI_VIEW_TITLE = "\u26A1 CodeAI (Local)";
export const CODEAI_LOG_CHANGES = "logs/changes.md";
export const CODEAI_LOG_PLAN = "logs/plan.md";
export const CODEAI_INDEX_FILE = "index.json";
export const CODEAI_MEMORY_FILE = "memory.md";
export const CODEAI_CONTEXT_LOG = "context.md";
