/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { URI } from "../../../../base/common/uri.js";
import { generateUuid } from "../../../../base/common/uuid.js";
import {
	ChunkType,
	CODEAI_INDEX_FILE,
	ICodebaseIndexService,
	ICodeChunk,
	IFileIndex,
} from "../common/codeai.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import { basename, extname } from "../../../../base/common/path.js";

interface ISerializableFileIndex {
	filePath: string;
	chunks: ICodeChunk[];
	lastModified: number;
	fileSize: number;
	language?: string;
	importanceScore: number;
}

interface ISerializableIndex {
	version: number;
	files: { [key: string]: ISerializableFileIndex };
	totalChunks: number;
	lastUpdated: number;
}

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MIN_CHUNK_LINES = 5;
const INDEX_VERSION = 1;

/**
 * Estimates token count from text using a simple heuristic (≈4 chars per token).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Service that builds and maintains a semantic index of the codebase.
 * Chunks files into functions, classes, and logical blocks for retrieval.
 */
export class CodebaseIndexService
	extends Disposable
	implements ICodebaseIndexService
{
	readonly _serviceBrand: undefined;

	private readonly _onDidUpdateIndex = this._register(new Emitter<void>());
	readonly onDidUpdateIndex: Event<void> = this._onDidUpdateIndex.event;

	private _index: Map<string, IFileIndex> = new Map();
	private _ready = false;
	private _indexing = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async buildIndex(): Promise<void> {
		if (this._indexing) {
			this.logService.trace("[CodeAI] Index build already in progress");
			return;
		}

		this._indexing = true;
		this._ready = false;

		try {
			this.logService.info("[CodeAI] Starting codebase indexing...");
			const startTime = Date.now();

			const workspace = this.workspaceService.getWorkspace();
			if (!workspace || workspace.folders.length === 0) {
				this.logService.warn("[CodeAI] No workspace folders to index");
				return;
			}

			// Try to load existing index first
			await this.loadIndexFromDisk();

			// Scan workspace for files
			const rootFolder = workspace.folders[0].uri;
			await this.scanDirectory(rootFolder);

			// Save index to disk
			await this.saveIndexToDisk();

			const duration = Date.now() - startTime;
			const stats = this.getStats();
			this.logService.info(
				`[CodeAI] Indexing complete: ${stats.totalFiles} files, ${stats.totalChunks} chunks in ${duration}ms`,
			);

			this._ready = true;
			this._onDidUpdateIndex.fire();
		} catch (err) {
			this.logService.error("[CodeAI] Index build failed:", err);
		} finally {
			this._indexing = false;
		}
	}

	async updateFile(filePath: string): Promise<void> {
		try {
			const uri = URI.file(filePath);
			const stat = await this.fileService.stat(uri);

			// Skip large files
			if (stat.size > MAX_FILE_SIZE) {
				return;
			}

			const content = await this.fileService.readFile(uri);
			const text = content.value.toString();

			const chunks = this.chunkFile(filePath, text);
			const language = this.detectLanguage(filePath);
			const importanceScore = this.calculateImportance(filePath);

			const fileIndex: IFileIndex = {
				filePath,
				chunks,
				lastModified: stat.mtime,
				fileSize: stat.size,
				language,
				importanceScore,
			};

			this._index.set(filePath, fileIndex);
			this._onDidUpdateIndex.fire();

			this.logService.trace(
				`[CodeAI] Updated index for ${filePath}: ${chunks.length} chunks`,
			);
		} catch (err) {
			this.logService.warn(
				`[CodeAI] Failed to update index for ${filePath}:`,
				err,
			);
		}
	}

	async removeFile(filePath: string): Promise<void> {
		if (this._index.delete(filePath)) {
			this._onDidUpdateIndex.fire();
			this.logService.trace(`[CodeAI] Removed ${filePath} from index`);
		}
	}

	getFileChunks(filePath: string): ICodeChunk[] {
		const fileIndex = this._index.get(filePath);
		return fileIndex ? fileIndex.chunks : [];
	}

	getStats(): { totalFiles: number; totalChunks: number; lastUpdated: number } {
		let totalChunks = 0;
		for (const fileIndex of this._index.values()) {
			totalChunks += fileIndex.chunks.length;
		}

		return {
			totalFiles: this._index.size,
			totalChunks,
			lastUpdated: Date.now(),
		};
	}

	isReady(): boolean {
		return this._ready;
	}

	getAllFiles(): string[] {
		return Array.from(this._index.keys());
	}

	// ── Private Methods ─────────────────────────────────────────────────────

	private async scanDirectory(uri: URI): Promise<void> {
		try {
			const entries = await this.fileService.resolve(uri);
			if (!entries.children) {
				return;
			}

			for (const entry of entries.children) {
				// Skip hidden files and common ignore patterns
				const name = basename(entry.resource.path);
				if (this.shouldIgnore(name)) {
					continue;
				}

				if (entry.isDirectory) {
					await this.scanDirectory(entry.resource);
				} else if (this.isIndexableFile(entry.resource.path)) {
					await this.indexFile(entry.resource);
				}
			}
		} catch (err) {
			this.logService.trace(
				`[CodeAI] Failed to scan directory ${uri.path}:`,
				err,
			);
		}
	}

	private async indexFile(uri: URI): Promise<void> {
		try {
			const stat = await this.fileService.stat(uri);

			// Skip large files
			if (stat.size > MAX_FILE_SIZE) {
				this.logService.trace(
					`[CodeAI] Skipping large file: ${uri.path} (${stat.size} bytes)`,
				);
				return;
			}

			// Check if file is already indexed and up-to-date
			const existing = this._index.get(uri.path);
			if (existing && existing.lastModified >= stat.mtime) {
				return;
			}

			const content = await this.fileService.readFile(uri);
			const text = content.value.toString();

			const chunks = this.chunkFile(uri.path, text);
			const language = this.detectLanguage(uri.path);
			const importanceScore = this.calculateImportance(uri.path);

			const fileIndex: IFileIndex = {
				filePath: uri.path,
				chunks,
				lastModified: stat.mtime,
				fileSize: stat.size,
				language,
				importanceScore,
			};

			this._index.set(uri.path, fileIndex);
		} catch (err) {
			this.logService.trace(`[CodeAI] Failed to index file ${uri.path}:`, err);
		}
	}

	private chunkFile(filePath: string, content: string): ICodeChunk[] {
		const chunks: ICodeChunk[] = [];
		const lines = content.split("\n");
		const language = this.detectLanguage(filePath);

		if (language === "typescript" || language === "javascript") {
			chunks.push(...this.chunkTypeScript(filePath, lines));
		} else if (language === "python") {
			chunks.push(...this.chunkPython(filePath, lines));
		} else {
			chunks.push(...this.chunkGeneric(filePath, lines));
		}

		return chunks;
	}

	private chunkTypeScript(filePath: string, lines: string[]): ICodeChunk[] {
		const chunks: ICodeChunk[] = [];
		let i = 0;

		while (i < lines.length) {
			const line = lines[i].trim();

			// Function declaration
			if (
				line.match(/^(export\s+)?(async\s+)?function\s+\w+/) ||
				line.match(/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/) ||
				line.match(/^(private|public|protected)\s+(async\s+)?\w+\s*\(/)
			) {
				const chunk = this.extractBlock(filePath, lines, i, "function");
				if (chunk) {
					chunks.push(chunk);
					i = chunk.endLine;
					continue;
				}
			}

			// Class declaration
			if (line.match(/^(export\s+)?(abstract\s+)?class\s+\w+/)) {
				const chunk = this.extractBlock(filePath, lines, i, "class");
				if (chunk) {
					chunks.push(chunk);
					i = chunk.endLine;
					continue;
				}
			}

			// Interface declaration
			if (line.match(/^(export\s+)?interface\s+\w+/)) {
				const chunk = this.extractBlock(filePath, lines, i, "interface");
				if (chunk) {
					chunks.push(chunk);
					i = chunk.endLine;
					continue;
				}
			}

			// Type declaration
			if (line.match(/^(export\s+)?type\s+\w+/)) {
				const chunk = this.extractBlock(filePath, lines, i, "type");
				if (chunk) {
					chunks.push(chunk);
					i = chunk.endLine;
					continue;
				}
			}

			// Export statement
			if (line.match(/^export\s+\{/)) {
				const chunk = this.extractBlock(filePath, lines, i, "export");
				if (chunk) {
					chunks.push(chunk);
					i = chunk.endLine;
					continue;
				}
			}

			i++;
		}

		// Fill gaps with generic blocks
		chunks.push(...this.fillGaps(filePath, lines, chunks));

		return chunks;
	}

	private chunkPython(filePath: string, lines: string[]): ICodeChunk[] {
		const chunks: ICodeChunk[] = [];
		let i = 0;

		while (i < lines.length) {
			const line = lines[i].trim();

			// Function or method
			if (line.match(/^(async\s+)?def\s+\w+/)) {
				const chunk = this.extractPythonBlock(filePath, lines, i, "function");
				if (chunk) {
					chunks.push(chunk);
					i = chunk.endLine;
					continue;
				}
			}

			// Class
			if (line.match(/^class\s+\w+/)) {
				const chunk = this.extractPythonBlock(filePath, lines, i, "class");
				if (chunk) {
					chunks.push(chunk);
					i = chunk.endLine;
					continue;
				}
			}

			i++;
		}

		chunks.push(...this.fillGaps(filePath, lines, chunks));
		return chunks;
	}

	private chunkGeneric(filePath: string, lines: string[]): ICodeChunk[] {
		const chunks: ICodeChunk[] = [];
		let startLine = 0;

		while (startLine < lines.length) {
			const endLine = Math.min(startLine + 50, lines.length - 1);
			const content = lines.slice(startLine, endLine + 1).join("\n");
			const tokens = estimateTokens(content);

			if (tokens > 10) {
				const keywords = this.extractKeywords(content);
				chunks.push({
					id: generateUuid(),
					filePath,
					type: "block",
					content,
					startLine,
					endLine,
					tokens,
					keywords,
				});
			}

			startLine = endLine + 1;
		}

		return chunks;
	}

	private extractBlock(
		filePath: string,
		lines: string[],
		startLine: number,
		type: ChunkType,
	): ICodeChunk | null {
		const firstLine = lines[startLine];
		const symbolMatch = firstLine.match(
			/(?:function|class|interface|type)\s+(\w+)/,
		);
		const symbolName = symbolMatch ? symbolMatch[1] : undefined;

		let braceCount = 0;
		let endLine = startLine;
		let foundBrace = false;

		for (let i = startLine; i < lines.length; i++) {
			const line = lines[i];
			for (const char of line) {
				if (char === "{") {
					braceCount++;
					foundBrace = true;
				} else if (char === "}") {
					braceCount--;
				}
			}

			if (foundBrace && braceCount === 0) {
				endLine = i;
				break;
			}

			// Safety limit
			if (i - startLine > 500) {
				endLine = i;
				break;
			}
		}

		if (endLine === startLine) {
			endLine = Math.min(startLine + 10, lines.length - 1);
		}

		const content = lines.slice(startLine, endLine + 1).join("\n");
		const tokens = estimateTokens(content);
		const keywords = this.extractKeywords(content);

		return {
			id: generateUuid(),
			filePath,
			symbolName,
			type,
			content,
			startLine,
			endLine,
			tokens,
			keywords,
		};
	}

	private extractPythonBlock(
		filePath: string,
		lines: string[],
		startLine: number,
		type: ChunkType,
	): ICodeChunk | null {
		const firstLine = lines[startLine];
		const symbolMatch = firstLine.match(/(?:def|class)\s+(\w+)/);
		const symbolName = symbolMatch ? symbolMatch[1] : undefined;

		const baseIndent = firstLine.search(/\S/);
		let endLine = startLine;

		for (let i = startLine + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() === "") {
				continue;
			}

			const indent = line.search(/\S/);
			if (indent <= baseIndent && line.trim().length > 0) {
				endLine = i - 1;
				break;
			}

			endLine = i;

			// Safety limit
			if (i - startLine > 500) {
				break;
			}
		}

		const content = lines.slice(startLine, endLine + 1).join("\n");
		const tokens = estimateTokens(content);
		const keywords = this.extractKeywords(content);

		return {
			id: generateUuid(),
			filePath,
			symbolName,
			type,
			content,
			startLine,
			endLine,
			tokens,
			keywords,
		};
	}

	private fillGaps(
		filePath: string,
		lines: string[],
		existingChunks: ICodeChunk[],
	): ICodeChunk[] {
		const gaps: ICodeChunk[] = [];
		const covered = new Set<number>();

		for (const chunk of existingChunks) {
			for (let i = chunk.startLine; i <= chunk.endLine; i++) {
				covered.add(i);
			}
		}

		let gapStart = -1;
		for (let i = 0; i < lines.length; i++) {
			if (!covered.has(i)) {
				if (gapStart === -1) {
					gapStart = i;
				}
			} else {
				if (gapStart !== -1 && i - gapStart >= MIN_CHUNK_LINES) {
					const content = lines.slice(gapStart, i).join("\n");
					const tokens = estimateTokens(content);
					if (tokens > 10) {
						const keywords = this.extractKeywords(content);
						gaps.push({
							id: generateUuid(),
							filePath,
							type: "block",
							content,
							startLine: gapStart,
							endLine: i - 1,
							tokens,
							keywords,
						});
					}
				}
				gapStart = -1;
			}
		}

		return gaps;
	}

	private extractKeywords(content: string): string[] {
		const keywords = new Set<string>();
		const words = content.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g) || [];

		for (const word of words) {
			if (word.length > 2 && !this.isCommonWord(word)) {
				keywords.add(word.toLowerCase());
			}
		}

		return Array.from(keywords).slice(0, 20);
	}

	private isCommonWord(word: string): boolean {
		const common = new Set([
			"the",
			"and",
			"for",
			"this",
			"that",
			"with",
			"from",
			"return",
			"const",
			"let",
			"var",
			"function",
			"class",
			"interface",
			"type",
			"import",
			"export",
			"async",
			"await",
			"true",
			"false",
			"null",
			"undefined",
		]);
		return common.has(word.toLowerCase());
	}

	private detectLanguage(filePath: string): string | undefined {
		const ext = extname(filePath).toLowerCase();
		const langMap: { [key: string]: string } = {
			".ts": "typescript",
			".tsx": "typescript",
			".js": "javascript",
			".jsx": "javascript",
			".py": "python",
			".java": "java",
			".cpp": "cpp",
			".c": "c",
			".cs": "csharp",
			".go": "go",
			".rs": "rust",
			".rb": "ruby",
			".php": "php",
		};
		return langMap[ext];
	}

	private calculateImportance(filePath: string): number {
		let score = 1.0;

		// Boost source files
		if (filePath.includes("/src/")) {
			score += 0.3;
		}

		// Boost service files
		if (filePath.includes("service") || filePath.includes("Service")) {
			score += 0.2;
		}

		// Boost main/index files
		if (filePath.includes("index") || filePath.includes("main")) {
			score += 0.2;
		}

		// Penalize test files
		if (
			filePath.includes("test") ||
			filePath.includes("spec") ||
			filePath.includes("__tests__")
		) {
			score -= 0.5;
		}

		// Penalize build/dist files
		if (
			filePath.includes("/dist/") ||
			filePath.includes("/build/") ||
			filePath.includes("/node_modules/")
		) {
			score -= 0.8;
		}

		return Math.max(0.1, score);
	}

	private shouldIgnore(name: string): boolean {
		const ignorePatterns = [
			"node_modules",
			".git",
			".vscode",
			"dist",
			"build",
			"out",
			"coverage",
			".next",
			".cache",
			"__pycache__",
			".pytest_cache",
			"vendor",
			"target",
		];

		return name.startsWith(".") || ignorePatterns.includes(name);
	}

	private isIndexableFile(filePath: string): boolean {
		const ext = extname(filePath).toLowerCase();
		const indexableExts = [
			".ts",
			".tsx",
			".js",
			".jsx",
			".py",
			".java",
			".cpp",
			".c",
			".h",
			".cs",
			".go",
			".rs",
			".rb",
			".php",
			".swift",
			".kt",
		];
		return indexableExts.includes(ext);
	}

	private async loadIndexFromDisk(): Promise<void> {
		try {
			const workspace = this.workspaceService.getWorkspace();
			if (!workspace || workspace.folders.length === 0) {
				return;
			}

			const indexUri = URI.joinPath(
				workspace.folders[0].uri,
				".codeai",
				CODEAI_INDEX_FILE,
			);
			const content = await this.fileService.readFile(indexUri);
			const data: ISerializableIndex = JSON.parse(content.value.toString());

			if (data.version === INDEX_VERSION) {
				this._index.clear();
				for (const [path, fileIndex] of Object.entries(data.files)) {
					this._index.set(path, fileIndex);
				}
				this.logService.info(
					`[CodeAI] Loaded index from disk: ${this._index.size} files`,
				);
			}
		} catch (err) {
			this.logService.trace(
				"[CodeAI] No existing index found or failed to load",
			);
		}
	}

	private async saveIndexToDisk(): Promise<void> {
		try {
			const workspace = this.workspaceService.getWorkspace();
			if (!workspace || workspace.folders.length === 0) {
				return;
			}

			const codeaiDir = URI.joinPath(workspace.folders[0].uri, ".codeai");
			await this.fileService.createFolder(codeaiDir);

			const files: { [key: string]: ISerializableFileIndex } = {};
			for (const [path, fileIndex] of this._index.entries()) {
				files[path] = fileIndex;
			}

			const data: ISerializableIndex = {
				version: INDEX_VERSION,
				files,
				totalChunks: this.getStats().totalChunks,
				lastUpdated: Date.now(),
			};

			const indexUri = URI.joinPath(codeaiDir, CODEAI_INDEX_FILE);
			await this.fileService.writeFile(
				indexUri,
				VSBuffer.fromString(JSON.stringify(data, null, 2)),
			);

			this.logService.trace("[CodeAI] Saved index to disk");
		} catch (err) {
			this.logService.warn("[CodeAI] Failed to save index to disk:", err);
		}
	}
}
