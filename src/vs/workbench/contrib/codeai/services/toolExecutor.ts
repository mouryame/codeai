import { URI } from "../../../../base/common/uri.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import {
	ILocalModelsService,
	ICodebaseIndexService,
	IRetrievalService,
	IRetrievalResult,
} from "../common/codeai.js";
import { ICodeAILogService } from "../common/logService.js";

// ── Tool Result Types ───────────────────────────────────────────────────────

export interface IToolResult {
	success: boolean;
	data?: any;
	error?: string;
}

export interface IToolCall {
	tool: string;
	input: Record<string, any>;
}

// ── Tool Executor ───────────────────────────────────────────────────────────

export class ToolExecutor {
	constructor(
		private readonly fileService: IFileService,
		private readonly workspaceService: IWorkspaceContextService,
		private readonly modelsService: ILocalModelsService,
		private readonly indexService: ICodebaseIndexService,
		private readonly retrievalService: IRetrievalService,
		private readonly logService: ICodeAILogService,
		private readonly platformLogService: ILogService,
	) {}

	async executeTool(
		toolName: string,
		input: Record<string, any>,
	): Promise<IToolResult> {
		this.platformLogService.info(
			`[ToolExecutor] Executing: ${toolName}`,
			input,
		);

		try {
			switch (toolName) {
				case "list_files":
					return await this.toolListFiles(input.pattern);

				case "read_file":
					return await this.toolReadFile(input.path);

				case "search_code":
					return await this.toolSearchCode(input.query, input.max_results || 5);

				case "get_context":
					return await this.toolGetContext(
						input.query,
						input.scope || "focused",
					);

				case "call_coding_model":
					return await this.toolCallCodingModel(
						input.task,
						input.context,
						input.mode,
						input.target_file,
					);

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
			this.platformLogService.error(
				`[ToolExecutor] Error in ${toolName}:`,
				err,
			);
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// ── Tool Implementations ────────────────────────────────────────────────

	private async toolListFiles(pattern: string): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return { success: false, error: "No workspace folder open" };
		}

		const files = this.indexService.getAllFiles();
		return {
			success: true,
			data: {
				files: files.slice(0, 100), // Limit to 100 files
				total: files.length,
			},
		};
	}

	private async toolReadFile(path: string): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return { success: false, error: "No workspace folder open" };
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		const content = await this.fileService.readFile(fileUri);

		return {
			success: true,
			data: {
				path,
				content: content.value.toString(),
				size: content.size,
			},
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

		return {
			success: true,
			data: {
				query,
				results: results.map((r: IRetrievalResult) => ({
					file: r.chunk.filePath,
					content: r.chunk.content,
					score: r.score,
				})),
				count: results.length,
			},
		};
	}

	private async toolGetContext(
		query: string,
		scope: string,
	): Promise<IToolResult> {
		// For now, use retrieval service as a simple context provider
		// TODO: Implement full IContextConstructionService when available
		const maxResults = scope === "broad" ? 10 : scope === "focused" ? 5 : 3;

		const results = await this.retrievalService.retrieve({
			query,
			maxResults,
		});

		const contextText = results
			.map((r) => `File: ${r.chunk.filePath}\n${r.chunk.content}`)
			.join("\n\n---\n\n");

		return {
			success: true,
			data: {
				query,
				scope,
				context: contextText,
				sources: results.map((r) => r.chunk.filePath),
				tokenCount: Math.ceil(contextText.length / 4),
			},
		};
	}

	private async toolCallCodingModel(
		task: string,
		context: string,
		mode: string,
		targetFile?: string,
	): Promise<IToolResult> {
		this.platformLogService.info(
			`[ToolExecutor] Calling coding model - Mode: ${mode}, Task: ${task.slice(0, 100)}`,
		);

		// Ensure coding model is loaded
		await this.modelsService.ensureMemoryBudget("coding");
		const codingModel = this.modelsService.getModelByRole("coding");

		// Build instruction based on mode
		let instruction = "";
		switch (mode) {
			case "generate":
				instruction = `Generate new code for the following task:\n\n${task}`;
				break;
			case "edit":
				instruction = `Edit the existing code to accomplish:\n\n${task}`;
				break;
			case "refactor":
				instruction = `Refactor the code to:\n\n${task}`;
				break;
			default:
				instruction = task;
		}

		// Build prompt for coding model
		const prompt = this.buildCodingModelPrompt(
			instruction,
			context,
			targetFile,
		);

		// Call coding model
		const result = await codingModel.generate({
			prompt,
			role: "coding",
			maxTokens: 4096,
			temperature: 0.2, // Lower temperature for code generation
		});

		// Log the change
		await this.logService.appendChange(
			`**Coding Model Invoked**\nMode: ${mode}\nTask: ${task}\nTarget: ${targetFile || "N/A"}\n\nGenerated ${result.text.length} characters`,
		);

		return {
			success: true,
			data: {
				mode,
				task,
				targetFile,
				generatedCode: result.text,
				tokensUsed: result.tokensUsed,
			},
		};
	}

	private buildCodingModelPrompt(
		instruction: string,
		context: string,
		targetFile?: string,
	): string {
		let prompt = "# CODING TASK\n\n";
		prompt += `${instruction}\n\n`;

		if (targetFile) {
			prompt += `## Target File\n${targetFile}\n\n`;
		}

		if (context) {
			prompt += `## Context\n\n${context}\n\n`;
		}

		prompt += `## Instructions\n`;
		prompt += `- Generate clean, production-ready code\n`;
		prompt += `- Follow existing code style\n`;
		prompt += `- Add necessary imports\n`;
		prompt += `- Include error handling\n`;
		prompt += `- Output ONLY the code, no explanations\n\n`;
		prompt += `## Output\n`;

		return prompt;
	}

	private async toolWriteFile(
		path: string,
		content: string,
	): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return { success: false, error: "No workspace folder open" };
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));

		await this.logService.appendChange(
			`**File Created**: ${path}\n\nSize: ${content.length} characters`,
		);

		return {
			success: true,
			data: {
				path,
				size: content.length,
			},
		};
	}

	private async toolEditFile(
		path: string,
		oldString: string,
		newString: string,
	): Promise<IToolResult> {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return { success: false, error: "No workspace folder open" };
		}

		const fileUri = URI.joinPath(workspace.folders[0].uri, path);
		const fileContent = await this.fileService.readFile(fileUri);
		const originalText = fileContent.value.toString();

		if (!originalText.includes(oldString)) {
			return {
				success: false,
				error: `String not found in file: "${oldString.slice(0, 100)}..."`,
			};
		}

		const newText = originalText.replace(oldString, newString);
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(newText));

		await this.logService.appendChange(
			`**File Edited**: ${path}\n\nReplaced ${oldString.length} characters with ${newString.length} characters`,
		);

		return {
			success: true,
			data: {
				path,
				oldLength: oldString.length,
				newLength: newString.length,
			},
		};
	}

	private async toolGetOpenFiles(): Promise<IToolResult> {
		// This would integrate with VS Code's editor service
		// For now, return empty array
		return {
			success: true,
			data: {
				files: [],
			},
		};
	}
}
