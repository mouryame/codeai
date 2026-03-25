import {
	ILocalModelsService,
	IGenerateResult,
	IStreamCallbacks,
} from "../common/codeai.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { ToolExecutor } from "./toolExecutor.js";

// ── Message Types ───────────────────────────────────────────────────────────

interface IThreadMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	tool_name?: string;
}

interface IToolCallResponse {
	type: "tool_call";
	tool: string;
	input: Record<string, any>;
}

interface IFinalAnswerResponse {
	type: "final_answer";
	content: string;
}

type IAgentResponse = IToolCallResponse | IFinalAnswerResponse;

// ── Reasoning Orchestrator ──────────────────────────────────────────────────

export class ReasoningOrchestrator {
	private readonly maxIterations = 20;

	constructor(
		private readonly modelsService: ILocalModelsService,
		private readonly toolExecutor: ToolExecutor,
		private readonly platformLogService: ILogService,
	) {}

	async orchestrate(
		userRequest: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		this.platformLogService.info(
			"[ReasoningOrchestrator] Starting orchestration",
		);

		const thread: IThreadMessage[] = [{ role: "user", content: userRequest }];
		let iteration = 0;
		let finalAnswer = "";
		let totalTokens = 0;

		// Notify user we're working
		if (callbacks?.onText) {
			callbacks.onText("_Thinking..._\n\n");
		}

		while (iteration < this.maxIterations) {
			iteration++;
			this.platformLogService.info(
				`[ReasoningOrchestrator] Iteration ${iteration}`,
			);

			// Call reasoning model
			const response = await this.callReasoningModel(thread);
			totalTokens += response.tokensUsed;

			// Parse JSON response
			const agentResponse = this.parseResponse(response.text);

			if (!agentResponse) {
				this.platformLogService.warn(
					"[ReasoningOrchestrator] Failed to parse response",
				);

				// Give model one more chance with error feedback
				if (iteration <= 3) {
					thread.push({
						role: "assistant",
						content:
							'ERROR: Invalid JSON. You must respond with {"type": "tool_call", ...} or {"type": "final_answer", ...}',
					});
					continue;
				}

				// Fallback: treat as final answer
				finalAnswer = response.text;
				break;
			}

			// Handle tool call
			if (agentResponse.type === "tool_call") {
				this.platformLogService.info(
					`[ReasoningOrchestrator] Tool call: ${agentResponse.tool}`,
				);

				// Execute tool
				const toolResult = await this.toolExecutor.executeTool(
					agentResponse.tool,
					agentResponse.input,
				);

				// Add tool result to thread
				thread.push({
					role: "tool",
					tool_name: agentResponse.tool,
					content: JSON.stringify(toolResult),
				});

				// Continue loop
				continue;
			}

			// Handle final answer
			if (agentResponse.type === "final_answer") {
				finalAnswer = agentResponse.content;
				this.platformLogService.info(
					"[ReasoningOrchestrator] Final answer generated",
				);

				// Stream final answer to UI
				if (callbacks?.onText) {
					callbacks.onText(finalAnswer);
				}
				break;
			}
		}

		if (iteration >= this.maxIterations) {
			this.platformLogService.warn(
				"[ReasoningOrchestrator] Max iterations reached",
			);
			finalAnswer =
				"I've reached the maximum reasoning steps. The task may be too complex. Please try breaking it into smaller parts.";

			if (callbacks?.onText) {
				callbacks.onText(finalAnswer);
			}
		}

		return {
			text: finalAnswer,
			tokensUsed: totalTokens,
			modelId: "reasoning-orchestrator",
		};
	}

	// ── System Prompt ───────────────────────────────────────────────────────

	private buildSystemPrompt(): string {
		return `You are an autonomous coding agent orchestrator.

ROLE: You are the brain of the system. You control everything.

CAPABILITIES:
- Analyze user requests
- Retrieve context using tools
- Invoke coding model for implementation
- Control execution flow step-by-step

AVAILABLE TOOLS:
1. list_files - List files matching pattern
   Input: {"pattern": "**/*.ts"}

2. read_file - Read complete file contents
   Input: {"path": "src/file.ts"}

3. search_code - Search codebase semantically
   Input: {"query": "authentication logic", "max_results": 5}

4. get_context - Get dynamic context (broad/focused/file)
   Input: {"query": "user auth flow", "scope": "focused"}

5. call_coding_model - Execute code generation/editing
   Input: {"task": "add validation", "context": "...", "mode": "edit", "target_file": "auth.ts"}
   Modes: generate, edit, refactor

6. write_file - Create new file
   Input: {"path": "new.ts", "content": "..."}

7. edit_file - Modify existing file
   Input: {"path": "file.ts", "old_string": "...", "new_string": "..."}

8. get_open_files - List currently open files
   Input: {}

CRITICAL RULES:
1. NEVER generate code yourself - use call_coding_model
2. ALWAYS gather context before acting (use read_file, search_code, get_context)
3. Think step-by-step: understand → gather context → act → verify
4. Output ONLY valid JSON (no explanations, no markdown)
5. Do NOT explain tools to the user
6. Do NOT output natural language during execution

RESPONSE FORMAT (JSON ONLY):

Tool call:
{"type": "tool_call", "tool": "tool_name", "input": {"param": "value"}}

Final answer (only when task is complete):
{"type": "final_answer", "content": "Complete answer to user"}

WORKFLOW EXAMPLE:
User: "Add validation to login form"
1. {"type": "tool_call", "tool": "search_code", "input": {"query": "login form", "max_results": 3}}
2. {"type": "tool_call", "tool": "read_file", "input": {"path": "login.ts"}}
3. {"type": "tool_call", "tool": "get_context", "input": {"query": "form validation", "scope": "focused"}}
4. {"type": "tool_call", "tool": "call_coding_model", "input": {"task": "Add email and password validation", "context": "...", "mode": "edit", "target_file": "login.ts"}}
5. {"type": "final_answer", "content": "Added validation to login form with email format and password strength checks."}

IMPORTANT:
- Start with minimal context, expand as needed
- Use get_context for broad understanding
- Use read_file for specific files
- Use call_coding_model for ALL code generation/editing
- Provide clear final_answer when done

Output JSON only. No other text.`;
	}

	// ── Model Interaction ───────────────────────────────────────────────────

	private async callReasoningModel(
		thread: IThreadMessage[],
	): Promise<IGenerateResult> {
		await this.modelsService.ensureMemoryBudget("reasoning");
		const reasoningModel = this.modelsService.getModelByRole("reasoning");

		const systemPrompt = this.buildSystemPrompt();
		const conversationPrompt = this.buildConversationPrompt(thread);
		const fullPrompt = `${systemPrompt}\n\n${conversationPrompt}`;

		const result = await reasoningModel.generate({
			prompt: fullPrompt,
			role: "reasoning",
			maxTokens: 2048,
			temperature: 0.7,
		});

		return result;
	}

	private buildConversationPrompt(thread: IThreadMessage[]): string {
		let prompt = "# CONVERSATION\n\n";

		for (const msg of thread) {
			if (msg.role === "user") {
				prompt += `USER REQUEST:\n${msg.content}\n\n`;
			} else if (msg.role === "tool") {
				prompt += `TOOL RESULT (${msg.tool_name}):\n${msg.content}\n\n`;
			} else if (msg.role === "assistant") {
				prompt += `SYSTEM FEEDBACK:\n${msg.content}\n\n`;
			}
		}

		prompt += "YOUR RESPONSE (JSON only):";
		return prompt;
	}

	// ── Response Parsing ────────────────────────────────────────────────────

	private parseResponse(text: string): IAgentResponse | null {
		try {
			let jsonText = text.trim();

			// Remove markdown code blocks if present
			const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
			if (codeBlockMatch) {
				jsonText = codeBlockMatch[1].trim();
			}

			// Extract JSON object using brace matching
			const startIdx = jsonText.indexOf("{");
			if (startIdx === -1) {
				this.platformLogService.warn(
					"[ReasoningOrchestrator] No JSON found in response",
				);
				return null;
			}

			let jsonStr = "";
			let braceCount = 0;
			let inString = false;
			let escapeNext = false;

			for (let i = startIdx; i < jsonText.length; i++) {
				const char = jsonText[i];

				if (escapeNext) {
					escapeNext = false;
					jsonStr += char;
					continue;
				}

				if (char === "\\") {
					escapeNext = true;
					jsonStr += char;
					continue;
				}

				if (char === '"' && !inString) {
					inString = true;
				} else if (char === '"' && inString) {
					inString = false;
				}

				if (!inString) {
					if (char === "{") braceCount++;
					if (char === "}") braceCount--;
				}

				jsonStr += char;

				if (braceCount === 0 && jsonStr.length > 0) {
					break;
				}
			}

			if (braceCount !== 0) {
				this.platformLogService.warn("[ReasoningOrchestrator] Incomplete JSON");
				return null;
			}

			const parsed = JSON.parse(jsonStr);
			this.platformLogService.info(
				"[ReasoningOrchestrator] Parsed response:",
				parsed,
			);

			// Validate structure
			if (parsed.type === "tool_call") {
				if (!parsed.tool || !parsed.input) {
					this.platformLogService.warn(
						"[ReasoningOrchestrator] Invalid tool_call structure",
					);
					return null;
				}
				return parsed as IToolCallResponse;
			}

			if (parsed.type === "final_answer") {
				if (!parsed.content) {
					this.platformLogService.warn(
						"[ReasoningOrchestrator] Invalid final_answer structure",
					);
					return null;
				}
				return parsed as IFinalAnswerResponse;
			}

			this.platformLogService.warn(
				"[ReasoningOrchestrator] Unknown response type:",
				parsed.type,
			);
			return null;
		} catch (err) {
			this.platformLogService.error(
				"[ReasoningOrchestrator] Parse error:",
				err,
			);
			return null;
		}
	}
}
