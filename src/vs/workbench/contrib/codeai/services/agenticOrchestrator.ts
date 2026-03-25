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
	ICodebaseIndexService,
	IRetrievalService,
	IMemoryService,
	IAgenticOrchestrator,
} from "../common/codeai.js";
import { ICodeAILogService } from "../common/logService.js";
import { ICodebaseContextService } from "./codebaseContext.js";
import { basename, dirname, extname } from "../../../../base/common/path.js";

interface ITool {
	name: string;
	description: string;
	parameters: Record<
		string,
		{ type: string; description: string; required?: boolean }
	>;
}

interface IToolCall {
	tool: string;
	arguments: Record<string, any>;
}

interface IToolResult {
	tool: string;
	result: string;
	error?: string;
}

const AVAILABLE_TOOLS: ITool[] = [
	{
		name: "read_file",
		description:
			"Read the complete contents of a file. Use this to examine code, configuration, or documentation.",
		parameters: {
			path: {
				type: "string",
				description: 'Workspace-relative path (e.g., "src/main.ts")',
				required: true,
			},
		},
	},
	{
		name: "write_file",
		description:
			"Write or overwrite a file with new content. Use for creating new files or completely replacing existing ones.",
		parameters: {
			path: {
				type: "string",
				description: "Workspace-relative path",
				required: true,
			},
			content: {
				type: "string",
				description: "Complete file content to write",
				required: true,
			},
		},
	},
	{
		name: "edit_file",
		description:
			"Make targeted edits to a file using search-and-replace. More precise than write_file for modifications.",
		parameters: {
			path: {
				type: "string",
				description: "Workspace-relative path",
				required: true,
			},
			old_string: {
				type: "string",
				description: "Exact text to find and replace",
				required: true,
			},
			new_string: {
				type: "string",
				description: "Replacement text",
				required: true,
			},
		},
	},
	{
		name: "search_code",
		description:
			"Search the codebase using semantic search. Returns relevant code chunks with context.",
		parameters: {
			query: {
				type: "string",
				description: 'Natural language query (e.g., "authentication logic")',
				required: true,
			},
			max_results: {
				type: "number",
				description: "Maximum results to return (default: 5)",
			},
		},
	},
	{
		name: "list_files",
		description:
			"List files in a directory or matching a pattern. Useful for exploring the codebase structure.",
		parameters: {
			path: {
				type: "string",
				description: 'Directory path or glob pattern (e.g., "src/**/*.ts")',
				required: true,
			},
		},
	},
	{
		name: "list_open_files",
		description: "Get a list of all files currently open in the editor.",
		parameters: {},
	},
	{
		name: "get_workspace_structure",
		description: "Get an overview of the workspace folder structure.",
		parameters: {},
	},
	{
		name: "get_project_memory",
		description:
			"Access persistent project knowledge including architecture notes, key files, and recent decisions.",
		parameters: {},
	},
	{
		name: "analyze_code",
		description:
			"Analyze code structure and extract information about functions, classes, imports, etc.",
		parameters: {
			path: {
				type: "string",
				description: "File path to analyze",
				required: true,
			},
		},
	},
	{
		name: "run_command",
		description:
			"Execute a shell command in the workspace. Use carefully and only when necessary.",
		parameters: {
			command: {
				type: "string",
				description: "Command to execute",
				required: true,
			},
		},
	},
];

/**
 * Agentic orchestrator that can reason, plan, and execute actions using tools.
 * This is the core of CodeAI's autonomous capabilities.
 */
export class AgenticOrchestrator
	extends Disposable
	implements IAgenticOrchestrator
{
	readonly _serviceBrand: undefined;
	private readonly maxIterations = 10;

	constructor(
		@ILocalModelsService private readonly modelsService: ILocalModelsService,
		@IFileService private readonly fileService: IFileService,
		@IModelService private readonly modelService: IModelService,
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService,
		@ICodebaseIndexService private readonly indexService: ICodebaseIndexService,
		@IRetrievalService private readonly retrievalService: IRetrievalService,
		@IMemoryService private readonly memoryService: IMemoryService,
		@ICodebaseContextService
		private readonly contextService: ICodebaseContextService,
		@ICodeAILogService private readonly codeaiLogService: ICodeAILogService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/**
	 * Run an agentic task: reason about the request, plan actions, execute tools, and respond.
	 */
	async runAgenticTask(
		userRequest: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		this.logService.info("[CodeAI Agentic] Starting agentic task");

		let iteration = 0;
		let conversationHistory = "";
		let finalResponse = "";

		// Build initial context
		const initialContext =
			await this.contextService.buildFullContext(userRequest);

		// System prompt for agentic reasoning
		const systemPrompt = this.buildAgenticSystemPrompt();

		// Initial prompt with context
		const initialPrompt = `${systemPrompt}\n\n## Context\n${initialContext}\n\n## User Request\n${userRequest}\n\n## Your Task\nAnalyze the request and decide what actions to take. You can use tools to gather information or make changes. Wrap your reasoning in <think></think> tags, then either call a tool or provide a final response.`;

		conversationHistory = initialPrompt;

		while (iteration < this.maxIterations) {
			iteration++;
			this.logService.info(
				`[CodeAI Agentic] Iteration ${iteration}/${this.maxIterations}`,
			);

			// Get reasoning model response
			const reasoningResult = await this.callReasoningModel(
				conversationHistory,
				callbacks,
			);

			const response = reasoningResult.text;

			// Check if the model wants to call a tool
			const toolCall = this.parseToolCall(response);

			if (toolCall) {
				this.logService.info(`[CodeAI Agentic] Tool call: ${toolCall.tool}`);

				// Execute the tool
				const toolResult = await this.executeTool(toolCall);

				// Add to conversation history
				conversationHistory += `\n\n## Assistant (Iteration ${iteration})\n${response}\n\n## Tool Result (${toolCall.tool})\n${toolResult.error || toolResult.result}`;

				// Stream tool execution to user
				if (callbacks?.onText) {
					callbacks.onText(
						`\n\n**[Tool: ${toolCall.tool}]**\n${toolResult.error ? `Error: ${toolResult.error}` : "Executed successfully"}\n`,
					);
				}

				// Continue reasoning loop
				continue;
			}

			// Check if this is a final response (no more tool calls)
			if (this.isFinalResponse(response)) {
				finalResponse = response;
				this.logService.info("[CodeAI Agentic] Final response generated");
				break;
			}

			// If no tool call and not final, add to history and continue
			conversationHistory += `\n\n## Assistant (Iteration ${iteration})\n${response}`;
		}

		if (iteration >= this.maxIterations) {
			this.logService.warn("[CodeAI Agentic] Max iterations reached");
			finalResponse =
				conversationHistory +
				"\n\n**Note:** Maximum reasoning iterations reached.";
		}

		// Log the agentic session
		await this.codeaiLogService.appendPlan(
			`**Agentic Task** — ${userRequest.slice(0, 100)}\n\nIterations: ${iteration}\n\n${finalResponse}`,
		);

		return {
			text: finalResponse,
			tokensUsed: 0, // TODO: track actual tokens
			modelId: "agentic-orchestrator",
		};
	}

	private buildAgenticSystemPrompt(): string {
		const toolsDescription = AVAILABLE_TOOLS.map(
			(tool) =>
				`- **${tool.name}**: ${tool.description}\n  Parameters: ${JSON.stringify(tool.parameters, null, 2)}`,
		).join("\n");

		return `You are CodeAI, an autonomous AI coding assistant with access to tools.

## Your Capabilities
You can:
1. Read and analyze code files
2. Search for relevant code using semantic search
3. Edit files to implement changes
4. Access project memory and context
5. Reason through complex problems step-by-step

## Available Tools
${toolsDescription}

## How to Use Tools
To call a tool, use this exact format:
\`\`\`tool
{
  "tool": "tool_name",
  "arguments": {
    "param1": "value1"
  }
}
\`\`\`

## Reasoning Process
1. Wrap your thinking in <think></think> tags
2. Analyze what information you need
3. Call tools to gather information or make changes
4. Synthesize the information
5. Provide a final response when ready

## Important Rules
- Always think before acting
- Use tools to gather information before making changes
- When editing files, use the coding model for actual code generation
- Provide clear, helpful responses
- If you can't complete a task, explain why

Now, analyze the user's request and take appropriate actions.`;
	}

	private async callReasoningModel(
		prompt: string,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		await this.modelsService.ensureMemoryBudget("reasoning");
		const runner = this.modelsService.getModelByRole("reasoning");

		const result = await runner.generate(
			{
				prompt,
				role: "reasoning",
				maxTokens: runner.config.maxTokens,
				temperature: runner.config.temperature,
			},
			callbacks,
		);

		return result;
	}

	private parseToolCall(response: string): IToolCall | null {
		// Look for ```tool ... ``` blocks
		const toolBlockRegex = /```tool\s*\n([\s\S]*?)\n```/;
		const match = response.match(toolBlockRegex);

		if (!match) {
			return null;
		}

		try {
			const toolCall = JSON.parse(match[1]);
			if (toolCall.tool && typeof toolCall.tool === "string") {
				return {
					tool: toolCall.tool,
					arguments: toolCall.arguments || {},
				};
			}
		} catch (err) {
			this.logService.warn("[CodeAI Agentic] Failed to parse tool call:", err);
		}

		return null;
	}

	private isFinalResponse(response: string): boolean {
		// If response contains a tool call, it's not final
		if (this.parseToolCall(response)) {
			return false;
		}

		// If response explicitly says it's done or provides a clear answer
		const finalIndicators = [
			/here(?:'s| is) (?:the|your)/i,
			/I(?:'ve| have) (?:completed|finished|done)/i,
			/the (?:answer|solution|result) is/i,
			/in summary/i,
			/to summarize/i,
		];

		return finalIndicators.some((regex) => regex.test(response));
	}

	private async executeTool(toolCall: IToolCall): Promise<IToolResult> {
		try {
			switch (toolCall.tool) {
				case "read_file":
					return await this.toolReadFile(toolCall.arguments.path);

				case "write_file":
					return await this.toolWriteFile(
						toolCall.arguments.path,
						toolCall.arguments.content,
					);

				case "edit_file":
					return await this.toolEditFile(
						toolCall.arguments.path,
						toolCall.arguments.old_string,
						toolCall.arguments.new_string,
					);

				case "search_code":
					return await this.toolSearchCode(
						toolCall.arguments.query,
						toolCall.arguments.max_results || 5,
					);

				case "list_files":
					return await this.toolListFiles(toolCall.arguments.path);

				case "list_open_files":
					return await this.toolListOpenFiles();

				case "get_workspace_structure":
					return await this.toolGetWorkspaceStructure();

				case "get_project_memory":
					return await this.toolGetProjectMemory();

				case "analyze_code":
					return await this.toolAnalyzeCode(toolCall.arguments.path);

				case "run_command":
					return await this.toolRunCommand(toolCall.arguments.command);

				default:
					return {
						tool: toolCall.tool,
						result: "",
						error: `Unknown tool: ${toolCall.tool}`,
					};
			}
		} catch (err) {
			return {
				tool: toolCall.tool,
				result: "",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async toolReadFile(path: string): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return {
				tool: "read_file",
				result: "",
				error: "No workspace folder open",
			};
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		const content = await this.fileService.readFile(fileUri);

		return {
			tool: "read_file",
			result: `File: ${path}\n\n${content.value.toString()}`,
		};
	}

	private async toolWriteFile(
		path: string,
		content: string,
	): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return {
				tool: "write_file",
				result: "",
				error: "No workspace folder open",
			};
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));

		await this.codeaiLogService.appendChange(
			`**File Written**: ${path}\n\n\`\`\`\n${content.slice(0, 500)}${content.length > 500 ? "..." : ""}\n\`\`\``,
		);

		return {
			tool: "write_file",
			result: `Successfully wrote ${content.length} characters to ${path}`,
		};
	}

	private async toolListFiles(pathPattern: string): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return {
				tool: "list_files",
				result: "",
				error: "No workspace folder open",
			};
		}

		const allFiles = this.indexService.getAllFiles();
		const filtered = allFiles.filter((f) => {
			if (pathPattern.includes("*")) {
				const regex = new RegExp(pathPattern.replace(/\*/g, ".*"));
				return regex.test(f);
			}
			return f.startsWith(pathPattern) || f.includes(pathPattern);
		});

		const result =
			filtered.length > 0
				? `Found ${filtered.length} files:\n${filtered.slice(0, 50).join("\n")}${filtered.length > 50 ? "\n... and more" : ""}`
				: "No files found matching pattern";

		return { tool: "list_files", result };
	}

	private async toolSearchCode(
		query: string,
		maxResults: number,
	): Promise<IToolResult> {
		const results = await this.retrievalService.retrieve({
			query,
			maxResults,
		});

		if (results.length === 0) {
			return { tool: "search_code", result: "No relevant code found" };
		}

		const formatted = results
			.map((r, idx) => {
				const preview =
					r.chunk.content.length > 300
						? r.chunk.content.slice(0, 300) + "..."
						: r.chunk.content;
				return `${idx + 1}. **${r.chunk.filePath}:${r.chunk.startLine}** (score: ${r.score.toFixed(2)})\n   Symbol: ${r.chunk.symbolName || "N/A"} | Type: ${r.chunk.type}\n   \`\`\`\n${preview}\n\`\`\``;
			})
			.join("\n\n");

		return {
			tool: "search_code",
			result: `Found ${results.length} relevant code chunks:\n\n${formatted}`,
		};
	}

	private async toolListOpenFiles(): Promise<IToolResult> {
		const models = this.modelService.getModels();
		const files = models
			.filter((m) => m.uri.scheme === "file")
			.map((m) => m.uri.path)
			.join("\n");

		return {
			tool: "list_open_files",
			result: files || "No files currently open",
		};
	}

	private async toolEditFile(
		path: string,
		oldString: string,
		newString: string,
	): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return {
				tool: "edit_file",
				result: "",
				error: "No workspace folder open",
			};
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		const content = await this.fileService.readFile(fileUri);
		const originalText = content.value.toString();

		if (!originalText.includes(oldString)) {
			return {
				tool: "edit_file",
				result: "",
				error: `String not found in file: "${oldString.slice(0, 100)}..."`,
			};
		}

		const newText = originalText.replace(oldString, newString);
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(newText));

		await this.codeaiLogService.appendChange(
			`**File Edited**: ${path}\n\nOld:\n\`\`\`\n${oldString}\n\`\`\`\n\nNew:\n\`\`\`\n${newString}\n\`\`\``,
		);

		return {
			tool: "edit_file",
			result: `Successfully edited ${path}. Replaced ${oldString.length} characters with ${newString.length} characters.`,
		};
	}

	private async toolGetWorkspaceStructure(): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return {
				tool: "get_workspace_structure",
				result: "",
				error: "No workspace folder open",
			};
		}

		const allFiles = this.indexService.getAllFiles();
		const structure = new Map<string, string[]>();

		for (const file of allFiles) {
			const dir = dirname(file);
			if (!structure.has(dir)) {
				structure.set(dir, []);
			}
			structure.get(dir)!.push(basename(file));
		}

		const formatted = Array.from(structure.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.slice(0, 20)
			.map(
				([dir, files]) =>
					`${dir}/\n  ${files.slice(0, 10).join(", ")}${files.length > 10 ? "..." : ""}`,
			)
			.join("\n");

		return {
			tool: "get_workspace_structure",
			result: `Workspace structure (${allFiles.length} files total):\n\n${formatted}`,
		};
	}

	private async toolAnalyzeCode(path: string): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return {
				tool: "analyze_code",
				result: "",
				error: "No workspace folder open",
			};
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		const content = await this.fileService.readFile(fileUri);
		const text = content.value.toString();

		const ext = extname(path);
		const lines = text.split("\n");
		const analysis: string[] = [];

		analysis.push(`File: ${path}`);
		analysis.push(`Lines: ${lines.length}`);
		analysis.push(`Size: ${text.length} bytes`);
		analysis.push(`Type: ${ext}`);

		if (ext === ".ts" || ext === ".js" || ext === ".tsx" || ext === ".jsx") {
			const functions =
				text.match(/(?:function|const|let|var)\s+(\w+)\s*=/g) || [];
			const classes = text.match(/class\s+(\w+)/g) || [];
			const imports = text.match(/import\s+.*from/g) || [];
			const exports = text.match(/export\s+/g) || [];

			analysis.push(`\nCode Structure:`);
			analysis.push(`- Functions/Variables: ${functions.length}`);
			analysis.push(`- Classes: ${classes.length}`);
			analysis.push(`- Imports: ${imports.length}`);
			analysis.push(`- Exports: ${exports.length}`);
		}

		return { tool: "analyze_code", result: analysis.join("\n") };
	}

	private async toolRunCommand(command: string): Promise<IToolResult> {
		return {
			tool: "run_command",
			result: "",
			error:
				"Command execution is disabled for security reasons. Please run commands manually.",
		};
	}

	private async toolGetProjectMemory(): Promise<IToolResult> {
		const memory = await this.memoryService.getMemoryContext();

		return {
			tool: "get_project_memory",
			result: memory || "No project memory available",
		};
	}
}
