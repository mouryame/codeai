/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IModelService } from "../../../../editor/common/services/model.js";
import { URI } from "../../../../base/common/uri.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import {
	ILocalModelsService,
	IStreamCallbacks,
	IGenerateResult,
	IAgenticOrchestrator,
	ICodebaseIndexService,
	IRetrievalService,
	IMemoryService,
} from "../common/codeai.js";
import { ICodeAILogService } from "../common/logService.js";
import { ICodebaseContextService } from "./codebaseContext.js";

// ── Response Types ──────────────────────────────────────────────────────────

interface IToolCall {
	type: "tool_call";
	tool: string;
	input: Record<string, any>;
	reasoning?: string;
}

interface IFinalAnswer {
	type: "final_answer";
	content: string;
}

type IAgentResponse = IToolCall | IFinalAnswer;

interface IToolResult {
	success: boolean;
	data?: string;
	error?: string;
}

interface IThreadMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	tool_name?: string;
}

// ── Autonomous Orchestrator ─────────────────────────────────────────────────

export class AutonomousOrchestrator
	extends Disposable
	implements IAgenticOrchestrator
{
	readonly _serviceBrand: undefined;
	private readonly maxIterations = 15;
	private readonly maxRetries = 2;

	constructor(
		@ILocalModelsService private readonly modelsService: ILocalModelsService,
		@IFileService private readonly fileService: IFileService,
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService,
		@ICodebaseIndexService private readonly indexService: ICodebaseIndexService,
		@IRetrievalService private readonly retrievalService: IRetrievalService,
		@IMemoryService _memoryService: IMemoryService,
		@ICodebaseContextService _contextService: ICodebaseContextService,
		@ICodeAILogService private readonly codeaiLogService: ICodeAILogService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/**
	 * IAgenticOrchestrator interface implementation.
	 * Executes autonomous closed-loop tool-using agent.
	 * Returns only the final answer - all tool execution is hidden.
	 */
	async runAgenticTask(
		userRequest: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		this.logService.info("[Autonomous Agent] Starting execution");

		const thread: IThreadMessage[] = [{ role: "user", content: userRequest }];

		let iteration = 0;
		let finalAnswer = "";
		let totalTokens = 0;

		// Show user we're working (but not tool details)
		if (callbacks?.onText) {
			callbacks.onText("_Analyzing request..._\n\n");
		}

		while (iteration < this.maxIterations) {
			iteration++;
			this.logService.info(`[Autonomous Agent] Iteration ${iteration}`);

			// Generate response from model
			const response = await this.callModel(thread);
			totalTokens += response.tokensUsed;

			// Parse structured response
			const agentResponse = this.parseResponse(response.text);

			if (!agentResponse) {
				this.logService.warn(
					"[Autonomous Agent] Failed to parse response, treating as final answer",
				);
				// If model can't produce JSON after a few tries, just return the text
				if (iteration > 2) {
					finalAnswer = response.text;
					break;
				}
				thread.push({
					role: "assistant",
					content:
						'ERROR: You must respond with valid JSON only. Format: {"type": "tool_call" or "final_answer", ...}',
				});
				continue;
			}

			// Handle tool call
			if (agentResponse.type === "tool_call") {
				this.logService.info(
					`[Autonomous Agent] Tool call: ${agentResponse.tool}`,
				);

				// Execute tool (with retry logic)
				const toolResult = await this.executeToolWithRetry(
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
				// Check if this is a codebase question answered without using tools
				const usedTools = thread.filter((m) => m.role === "tool").length > 0;
				const looksLikeCodeQuestion = this.isCodebaseQuestion(userRequest);

				if (looksLikeCodeQuestion && !usedTools && iteration <= 2) {
					// Model isn't calling tools - inject list_files to get project structure
					this.logService.warn(
						"[Autonomous Agent] Codebase question detected but no tools used, auto-injecting list_files",
					);

					// Get workspace structure first
					const listResult = await this.executeToolWithRetry("list_files", {
						pattern: "**/*",
					});

					// Add to thread
					thread.push({
						role: "tool",
						tool_name: "list_files",
						content: JSON.stringify(listResult),
					});

					// Also add instruction to read key files
					thread.push({
						role: "assistant",
						content:
							"Now that you have the file list, use read_file to examine relevant files before answering.",
					});

					// Continue loop with file list
					continue;
				}

				finalAnswer = agentResponse.content;
				this.logService.info("[Autonomous Agent] Final answer generated");

				// Stream the final answer to UI
				if (callbacks?.onText) {
					callbacks.onText(finalAnswer);
				}
				break;
			}
		}

		if (iteration >= this.maxIterations) {
			this.logService.warn("[Autonomous Agent] Max iterations reached");
			finalAnswer =
				"I apologize, but I reached the maximum number of reasoning steps. Please try rephrasing your request or breaking it into smaller tasks.";

			// Stream error message to UI
			if (callbacks?.onText) {
				callbacks.onText(finalAnswer);
			}
		}

		// Log execution
		await this.codeaiLogService.appendPlan(
			`**Autonomous Execution**\nRequest: ${userRequest.slice(0, 100)}\nIterations: ${iteration}\nTools used: ${thread.filter((m) => m.role === "tool").length}\n\n${finalAnswer.slice(0, 500)}`,
		);

		return {
			text: finalAnswer,
			tokensUsed: totalTokens,
			modelId: "autonomous-agent",
		};
	}

	// ── Helper Methods ──────────────────────────────────────────────────────

	private isCodebaseQuestion(userRequest: string): boolean {
		const lowerRequest = userRequest.toLowerCase();
		const codebaseKeywords = [
			"code",
			"file",
			"function",
			"class",
			"method",
			"variable",
			"how does",
			"what does",
			"where is",
			"find",
			"search",
			"explain",
			"show me",
			"look at",
			"check",
			"review",
			"bug",
			"error",
			"fix",
			"change",
			"modify",
			"update",
			"implement",
			"add",
			"remove",
			"delete",
			"refactor",
			"src/",
			"import",
			"export",
			"module",
			"component",
		];

		return codebaseKeywords.some((keyword) => lowerRequest.includes(keyword));
	}

	// ── System Prompt ───────────────────────────────────────────────────────

	private buildSystemPrompt(): string {
		return `You are a coding assistant with access to tools. You MUST respond with ONLY valid JSON.

Two response formats:

1. Tool call:
{"type": "tool_call", "tool": "read_file", "input": {"path": "src/file.ts"}}

2. Final answer:
{"type": "final_answer", "content": "Complete answer here"}

Available tools:
- search_code: Search codebase semantically
- read_file: Read complete file contents
- list_files: List files matching pattern
- analyze_code: Extract code structure
- write_file: Create/overwrite file
- edit_file: Modify file content
- get_open_files: List open editor files

CRITICAL RULES:
1. For ANY question about code/codebase: MUST use search_code or read_file FIRST
2. NEVER answer codebase questions without using tools
3. ALWAYS gather context before answering
4. Output ONLY valid JSON (no extra text)
5. Do NOT use markdown code blocks

Example workflow:
User asks about code → search_code → read_file → final_answer
User asks to modify → read_file → edit_file → final_answer`;
	}

	// ── Model Interaction ───────────────────────────────────────────────────

	private async callModel(thread: IThreadMessage[]): Promise<IGenerateResult> {
		await this.modelsService.ensureMemoryBudget("reasoning");
		const runner = this.modelsService.getModelByRole("reasoning");

		// Build prompt from thread
		const systemPrompt = this.buildSystemPrompt();
		const conversationPrompt = this.buildConversationPrompt(thread);
		const fullPrompt = `${systemPrompt}\n\n${conversationPrompt}`;

		const result = await runner.generate({
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

			// Extract JSON object - find first { and try to find matching }
			const startIdx = jsonText.indexOf("{");
			if (startIdx === -1) {
				this.logService.warn(
					"[Autonomous Agent] No JSON found in response:",
					text.slice(0, 200),
				);
				return null;
			}

			// Try to extract complete JSON object
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
				this.logService.warn(
					"[Autonomous Agent] Incomplete JSON, braces don't match:",
					jsonStr.slice(0, 200),
				);
				return null;
			}

			const parsed = JSON.parse(jsonStr);
			this.logService.info("[Autonomous Agent] Parsed response:", parsed);

			// Validate structure
			if (parsed.type === "tool_call") {
				if (!parsed.tool || !parsed.input) {
					this.logService.warn(
						"[Autonomous Agent] Invalid tool_call structure",
					);
					return null;
				}
				return parsed as IToolCall;
			}

			if (parsed.type === "final_answer") {
				if (!parsed.content) {
					this.logService.warn(
						"[Autonomous Agent] Invalid final_answer structure",
					);
					return null;
				}
				return parsed as IFinalAnswer;
			}

			this.logService.warn(
				"[Autonomous Agent] Unknown response type:",
				parsed.type,
			);
			return null;
		} catch (err) {
			this.logService.error(
				"[Autonomous Agent] Parse error:",
				err,
				"Text:",
				text.slice(0, 200),
			);
			return null;
		}
	}

	// ── Tool Execution ──────────────────────────────────────────────────────

	private async executeToolWithRetry(
		toolName: string,
		input: Record<string, any>,
	): Promise<IToolResult> {
		let lastError: string | undefined;

		for (let attempt = 0; attempt < this.maxRetries; attempt++) {
			try {
				const result = await this.executeTool(toolName, input);
				if (result.success) {
					return result;
				}
				lastError = result.error;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
			}

			// Wait before retry
			if (attempt < this.maxRetries - 1) {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}

		return {
			success: false,
			error: `Tool failed after ${this.maxRetries} attempts: ${lastError}`,
		};
	}

	private async executeTool(
		toolName: string,
		input: Record<string, any>,
	): Promise<IToolResult> {
		this.logService.info(`[Tool] Executing ${toolName}`, input);

		try {
			switch (toolName) {
				case "list_files":
					return await this.toolListFiles(input.pattern);

				case "read_file":
					return await this.toolReadFile(input.path);

				case "search_code":
					return await this.toolSearchCode(input.query, input.max_results || 5);

				case "analyze_code":
					return await this.toolAnalyzeCode(input.path);

				case "write_file":
					return await this.toolWriteFile(input.path, input.content);

				case "edit_file":
					return await this.toolEditFile(
						input.path,
						input.old_string,
						input.new_string,
					);

				case "get_open_files":
					return await this.toolGetOpenFiles();

				default:
					return {
						success: false,
						error: `Unknown tool: ${toolName}`,
					};
			}
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ── Tool Implementations ────────────────────────────────────────────────

	private async toolListFiles(pattern: string): Promise<IToolResult> {
		const allFiles = this.indexService.getAllFiles();
		const filtered = allFiles.filter((f) => {
			if (pattern.includes("*")) {
				const regex = new RegExp(pattern.replace(/\*/g, ".*"));
				return regex.test(f);
			}
			return f.startsWith(pattern) || f.includes(pattern);
		});

		return {
			success: true,
			data: JSON.stringify({
				count: filtered.length,
				files: filtered.slice(0, 100),
			}),
		};
	}

	private async toolReadFile(path: string): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return { success: false, error: "No workspace open" };
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		const content = await this.fileService.readFile(fileUri);

		return {
			success: true,
			data: JSON.stringify({
				path,
				content: content.value.toString(),
				size: content.value.byteLength,
			}),
		};
	}

	private async toolSearchCode(
		query: string,
		maxResults: number,
	): Promise<IToolResult> {
		const results = await this.retrievalService.retrieve({
			query,
			maxResults,
		});

		const formatted = results.map((r) => ({
			file: r.chunk.filePath,
			line: r.chunk.startLine,
			symbol: r.chunk.symbolName,
			type: r.chunk.type,
			content: r.chunk.content.slice(0, 300),
			score: r.score,
		}));

		return {
			success: true,
			data: JSON.stringify({
				count: results.length,
				results: formatted,
			}),
		};
	}

	private async toolAnalyzeCode(path: string): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return { success: false, error: "No workspace open" };
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		const content = await this.fileService.readFile(fileUri);
		const text = content.value.toString();

		const analysis = {
			path,
			lines: text.split("\n").length,
			size: text.length,
			functions: (text.match(/(?:function|const|let|var)\s+\w+\s*=/g) || [])
				.length,
			classes: (text.match(/class\s+\w+/g) || []).length,
			imports: (text.match(/import\s+.*from/g) || []).length,
			exports: (text.match(/export\s+/g) || []).length,
		};

		return {
			success: true,
			data: JSON.stringify(analysis),
		};
	}

	private async toolWriteFile(
		path: string,
		content: string,
	): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return { success: false, error: "No workspace open" };
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));

		await this.codeaiLogService.appendChange(
			`**File Written**: ${path}\n\`\`\`\n${content.slice(0, 500)}\n\`\`\``,
		);

		return {
			success: true,
			data: JSON.stringify({ path, bytes: content.length }),
		};
	}

	private async toolEditFile(
		path: string,
		oldString: string,
		newString: string,
	): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return { success: false, error: "No workspace open" };
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		const content = await this.fileService.readFile(fileUri);
		const originalText = content.value.toString();

		if (!originalText.includes(oldString)) {
			return {
				success: false,
				error: `String not found in file: "${oldString.slice(0, 50)}..."`,
			};
		}

		const newText = originalText.replace(oldString, newString);
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(newText));

		await this.codeaiLogService.appendChange(
			`**File Edited**: ${path}\nOld: \`${oldString.slice(0, 100)}\`\nNew: \`${newString.slice(0, 100)}\``,
		);

		return {
			success: true,
			data: JSON.stringify({ path, changed: true }),
		};
	}

	private async toolGetOpenFiles(): Promise<IToolResult> {
		const models = this.modelService.getModels();
		const files = models
			.filter((m) => m.uri.scheme === "file")
			.map((m) => m.uri.path);

		return {
			success: true,
			data: JSON.stringify({ files }),
		};
	}
}
