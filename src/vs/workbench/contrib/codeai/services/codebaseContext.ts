/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelService } from "../../../../editor/common/services/model.js";
import { ITextFileService } from "../../../services/textfile/common/textfiles.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { URI } from "../../../../base/common/uri.js";
import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { IRetrievalService, IRetrievalQuery } from "../common/codeai.js";
import { IMemoryService } from "../common/codeai.js";

export const ICodebaseContextService = createDecorator<ICodebaseContextService>(
	"codebaseContextService",
);

export interface ICodebaseContextService {
	readonly _serviceBrand: undefined;

	/**
	 * Get context about currently open files
	 */
	getOpenFilesContext(): Promise<string>;

	/**
	 * Get context about a specific file
	 */
	getFileContext(uri: URI): Promise<string>;

	/**
	 * Get workspace structure overview
	 */
	getWorkspaceStructure(): Promise<string>;

	/**
	 * Get enriched context for a query using retrieval and memory
	 */
	getEnrichedContext(query: string): Promise<string>;

	/**
	 * Build full context for a prompt (memory + retrieval + open files)
	 */
	buildFullContext(query: string): Promise<string>;
}

export class CodebaseContextService implements ICodebaseContextService {
	readonly _serviceBrand: undefined;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IWorkspaceContextService
		private readonly workspaceContextService: IWorkspaceContextService,
		@IRetrievalService private readonly retrievalService: IRetrievalService,
		@IMemoryService private readonly memoryService: IMemoryService,
	) {}

	async getOpenFilesContext(): Promise<string> {
		const models = this.modelService.getModels();
		const openFiles: string[] = [];

		for (const model of models) {
			const uri = model.uri;
			// Skip non-file URIs and very large files
			if (uri.scheme !== "file" || model.getValueLength() > 50000) {
				continue;
			}

			const content = model.getValue();
			const relativePath = this.getRelativePath(uri);

			openFiles.push(
				`\n### File: ${relativePath}\n\`\`\`\n${content}\n\`\`\`\n`,
			);

			// Limit to first 5 files to avoid token overflow
			if (openFiles.length >= 5) {
				break;
			}
		}

		if (openFiles.length === 0) {
			return "";
		}

		return `\n## Currently Open Files\n${openFiles.join("\n")}`;
	}

	async getFileContext(uri: URI): Promise<string> {
		try {
			const model = this.modelService.getModel(uri);
			if (model) {
				const content = model.getValue();
				const relativePath = this.getRelativePath(uri);
				return `\n### File: ${relativePath}\n\`\`\`\n${content}\n\`\`\`\n`;
			}

			// Try to read from disk if not in model service
			const fileContent = await this.textFileService.read(uri);
			const relativePath = this.getRelativePath(uri);
			return `\n### File: ${relativePath}\n\`\`\`\n${fileContent.value}\n\`\`\`\n`;
		} catch (err) {
			return "";
		}
	}

	async getWorkspaceStructure(): Promise<string> {
		const workspace = this.workspaceContextService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return "";
		}

		const folders = workspace.folders.map((f) => f.name).join(", ");
		return `\n## Workspace\nFolders: ${folders}\n`;
	}

	async getEnrichedContext(query: string): Promise<string> {
		try {
			const retrievalQuery: IRetrievalQuery = {
				query,
				maxResults: 10,
				minScore: 0.2,
			};

			const results = await this.retrievalService.retrieve(retrievalQuery);

			if (results.length === 0) {
				return "";
			}

			const chunks = results.slice(0, 5).map((result, idx) => {
				const relativePath = this.getRelativePathFromString(
					result.chunk.filePath,
				);
				return (
					`\n### Retrieved Code [${idx + 1}] - ${relativePath}:${result.chunk.startLine}\n` +
					`Symbol: ${result.chunk.symbolName || "N/A"} | Type: ${result.chunk.type} | Score: ${result.score.toFixed(2)}\n` +
					`\`\`\`\n${result.chunk.content}\n\`\`\`\n`
				);
			});

			return `\n## Retrieved Relevant Code\n${chunks.join("\n")}`;
		} catch (err) {
			return "";
		}
	}

	async buildFullContext(query: string): Promise<string> {
		const parts: string[] = [];

		// 1. Memory context (highest priority)
		const memoryContext = await this.memoryService.getMemoryContext();
		if (memoryContext) {
			parts.push(memoryContext);
		}

		// 2. Retrieved relevant code
		const retrievedContext = await this.getEnrichedContext(query);
		if (retrievedContext) {
			parts.push(retrievedContext);
		}

		// 3. Open files (current working context)
		const openFiles = await this.getOpenFilesContext();
		if (openFiles) {
			parts.push(openFiles);
		}

		// 4. Workspace structure
		const workspace = await this.getWorkspaceStructure();
		if (workspace) {
			parts.push(workspace);
		}

		return parts.join("\n");
	}

	private getRelativePath(uri: URI): string {
		const workspace = this.workspaceContextService.getWorkspace();
		if (workspace && workspace.folders.length > 0) {
			const folder = workspace.folders[0];
			if (uri.path.startsWith(folder.uri.path)) {
				return uri.path.substring(folder.uri.path.length + 1);
			}
		}
		return uri.path;
	}

	private getRelativePathFromString(filePath: string): string {
		const workspace = this.workspaceContextService.getWorkspace();
		if (workspace && workspace.folders.length > 0) {
			const folder = workspace.folders[0];
			if (filePath.startsWith(folder.uri.path)) {
				return filePath.substring(folder.uri.path.length + 1);
			}
		}
		return filePath;
	}
}
