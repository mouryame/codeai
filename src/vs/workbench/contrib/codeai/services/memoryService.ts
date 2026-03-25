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
import { VSBuffer } from "../../../../base/common/buffer.js";
import {
	CODEAI_MEMORY_FILE,
	IMemoryEntry,
	IMemoryService,
	IProjectMemory,
} from "../common/codeai.js";

const MEMORY_VERSION = 1;
const MAX_DECISIONS = 10;
const MAX_CHANGES = 15;

/**
 * Estimates token count from text using a simple heuristic (≈4 chars per token).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Service that maintains persistent project memory across sessions.
 */
export class MemoryService extends Disposable implements IMemoryService {
	readonly _serviceBrand: undefined;

	private readonly _onDidUpdateMemory = this._register(new Emitter<void>());
	readonly onDidUpdateMemory: Event<void> = this._onDidUpdateMemory.event;

	private _memory: IProjectMemory = {
		summary: "",
		architecture: [],
		keyFiles: new Map(),
		decisions: [],
		recentChanges: [],
		version: MEMORY_VERSION,
	};

	private _loaded = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.loadMemory();
	}

	async getMemory(): Promise<IProjectMemory> {
		if (!this._loaded) {
			await this.loadMemory();
		}
		return this._memory;
	}

	async updateSummary(summary: string): Promise<void> {
		this._memory = {
			...this._memory,
			summary,
		};
		await this.saveMemory();
		this._onDidUpdateMemory.fire();
	}

	async addArchitectureNote(note: string): Promise<void> {
		const architecture = [...this._memory.architecture];
		architecture.push(note);

		// Keep only last 20 notes
		if (architecture.length > 20) {
			architecture.shift();
		}

		this._memory = {
			...this._memory,
			architecture,
		};
		await this.saveMemory();
		this._onDidUpdateMemory.fire();
	}

	async recordKeyFile(filePath: string, purpose: string): Promise<void> {
		const keyFiles = new Map(this._memory.keyFiles);
		keyFiles.set(filePath, purpose);

		this._memory = {
			...this._memory,
			keyFiles,
		};
		await this.saveMemory();
		this._onDidUpdateMemory.fire();
	}

	async addDecision(content: string, relatedFiles?: string[]): Promise<void> {
		const entry: IMemoryEntry = {
			timestamp: Date.now(),
			category: "decision",
			content,
			relatedFiles,
		};

		const decisions = [...this._memory.decisions, entry];

		// Keep only recent decisions
		if (decisions.length > MAX_DECISIONS) {
			decisions.shift();
		}

		this._memory = {
			...this._memory,
			decisions,
		};
		await this.saveMemory();
		this._onDidUpdateMemory.fire();
	}

	async recordChange(content: string, relatedFiles?: string[]): Promise<void> {
		const entry: IMemoryEntry = {
			timestamp: Date.now(),
			category: "change",
			content,
			relatedFiles,
		};

		const recentChanges = [...this._memory.recentChanges, entry];

		// Keep only recent changes
		if (recentChanges.length > MAX_CHANGES) {
			recentChanges.shift();
		}

		this._memory = {
			...this._memory,
			recentChanges,
		};
		await this.saveMemory();
		this._onDidUpdateMemory.fire();
	}

	async getMemoryContext(): Promise<string> {
		const parts: string[] = [];

		if (this._memory.summary) {
			parts.push(`## Project Summary\n${this._memory.summary}\n`);
		}

		if (this._memory.architecture.length > 0) {
			parts.push(
				`## Architecture Notes\n${this._memory.architecture.map((n) => `- ${n}`).join("\n")}\n`,
			);
		}

		if (this._memory.keyFiles.size > 0) {
			const keyFilesStr = Array.from(this._memory.keyFiles.entries())
				.map(([path, purpose]) => `- \`${path}\`: ${purpose}`)
				.join("\n");
			parts.push(`## Key Files\n${keyFilesStr}\n`);
		}

		if (this._memory.decisions.length > 0) {
			const decisionsStr = this._memory.decisions
				.slice(-5)
				.map((d) => `- ${d.content}`)
				.join("\n");
			parts.push(`## Recent Decisions\n${decisionsStr}\n`);
		}

		if (this._memory.recentChanges.length > 0) {
			const changesStr = this._memory.recentChanges
				.slice(-5)
				.map((c) => `- ${c.content}`)
				.join("\n");
			parts.push(`## Recent Changes\n${changesStr}\n`);
		}

		if (parts.length === 0) {
			return "";
		}

		return `\n## Project Memory\n\n${parts.join("\n")}`;
	}

	async pruneMemory(maxTokens: number): Promise<void> {
		let totalTokens = estimateTokens(this._memory.summary);

		// Prune architecture notes
		while (
			this._memory.architecture.length > 0 &&
			totalTokens > maxTokens * 0.5
		) {
			this._memory.architecture.shift();
			totalTokens = this.calculateTotalTokens();
		}

		// Prune decisions
		while (this._memory.decisions.length > 0 && totalTokens > maxTokens * 0.7) {
			this._memory.decisions.shift();
			totalTokens = this.calculateTotalTokens();
		}

		// Prune changes
		while (
			this._memory.recentChanges.length > 0 &&
			totalTokens > maxTokens * 0.9
		) {
			this._memory.recentChanges.shift();
			totalTokens = this.calculateTotalTokens();
		}

		await this.saveMemory();
		this._onDidUpdateMemory.fire();
	}

	// ── Private Methods ─────────────────────────────────────────────────────

	private async loadMemory(): Promise<void> {
		try {
			const workspace = this.workspaceService.getWorkspace();
			if (!workspace || workspace.folders.length === 0) {
				this._loaded = true;
				return;
			}

			const memoryUri = URI.joinPath(
				workspace.folders[0].uri,
				".codeai",
				CODEAI_MEMORY_FILE,
			);
			const content = await this.fileService.readFile(memoryUri);
			const text = content.value.toString();

			// Parse markdown format
			this._memory = this.parseMemoryMarkdown(text);
			this._loaded = true;

			this.logService.info("[CodeAI] Loaded project memory");
		} catch (err) {
			this.logService.trace(
				"[CodeAI] No existing memory found, starting fresh",
			);
			this._loaded = true;
		}
	}

	private async saveMemory(): Promise<void> {
		try {
			const workspace = this.workspaceService.getWorkspace();
			if (!workspace || workspace.folders.length === 0) {
				return;
			}

			const codeaiDir = URI.joinPath(workspace.folders[0].uri, ".codeai");
			await this.fileService.createFolder(codeaiDir);

			const markdown = this.formatMemoryMarkdown();
			const memoryUri = URI.joinPath(codeaiDir, CODEAI_MEMORY_FILE);
			await this.fileService.writeFile(
				memoryUri,
				VSBuffer.fromString(markdown),
			);

			this.logService.trace("[CodeAI] Saved project memory");
		} catch (err) {
			this.logService.warn("[CodeAI] Failed to save memory:", err);
		}
	}

	private formatMemoryMarkdown(): string {
		const parts: string[] = [];

		parts.push("# CodeAI Project Memory\n");
		parts.push(
			`_Version: ${MEMORY_VERSION} | Last Updated: ${new Date().toISOString()}_\n`,
		);

		if (this._memory.summary) {
			parts.push("## Project Summary\n");
			parts.push(`${this._memory.summary}\n`);
		}

		if (this._memory.architecture.length > 0) {
			parts.push("## Architecture Notes\n");
			for (const note of this._memory.architecture) {
				parts.push(`- ${note}`);
			}
			parts.push("");
		}

		if (this._memory.keyFiles.size > 0) {
			parts.push("## Key Files\n");
			for (const [path, purpose] of this._memory.keyFiles.entries()) {
				parts.push(`- \`${path}\`: ${purpose}`);
			}
			parts.push("");
		}

		if (this._memory.decisions.length > 0) {
			parts.push("## Decisions\n");
			for (const decision of this._memory.decisions) {
				const date = new Date(decision.timestamp).toISOString();
				parts.push(`### [${date}]`);
				parts.push(decision.content);
				if (decision.relatedFiles && decision.relatedFiles.length > 0) {
					parts.push(`_Related: ${decision.relatedFiles.join(", ")}_`);
				}
				parts.push("");
			}
		}

		if (this._memory.recentChanges.length > 0) {
			parts.push("## Recent Changes\n");
			for (const change of this._memory.recentChanges) {
				const date = new Date(change.timestamp).toISOString();
				parts.push(`### [${date}]`);
				parts.push(change.content);
				if (change.relatedFiles && change.relatedFiles.length > 0) {
					parts.push(`_Related: ${change.relatedFiles.join(", ")}_`);
				}
				parts.push("");
			}
		}

		return parts.join("\n");
	}

	private parseMemoryMarkdown(text: string): IProjectMemory {
		let summaryText = "";
		const architecture: string[] = [];
		const keyFiles = new Map<string, string>();
		const decisions: IMemoryEntry[] = [];
		const recentChanges: IMemoryEntry[] = [];

		const lines = text.split("\n");
		let currentSection = "";
		let currentEntryTimestamp = Date.now();
		let currentEntryContent = "";
		let currentEntryFiles: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			if (line.startsWith("## Project Summary")) {
				currentSection = "summary";
				continue;
			} else if (line.startsWith("## Architecture Notes")) {
				currentSection = "architecture";
				continue;
			} else if (line.startsWith("## Key Files")) {
				currentSection = "keyFiles";
				continue;
			} else if (line.startsWith("## Decisions")) {
				currentSection = "decisions";
				continue;
			} else if (line.startsWith("## Recent Changes")) {
				currentSection = "changes";
				continue;
			}

			if (
				currentSection === "summary" &&
				line.trim() &&
				!line.startsWith("_")
			) {
				summaryText += line + "\n";
			} else if (currentSection === "architecture" && line.startsWith("- ")) {
				architecture.push(line.substring(2));
			} else if (currentSection === "keyFiles" && line.startsWith("- `")) {
				const match = line.match(/- `([^`]+)`: (.+)/);
				if (match) {
					keyFiles.set(match[1], match[2]);
				}
			} else if (
				currentSection === "decisions" ||
				currentSection === "changes"
			) {
				if (line.startsWith("### [")) {
					if (currentEntryContent) {
						const entry: IMemoryEntry = {
							timestamp: currentEntryTimestamp,
							category: currentSection === "decisions" ? "decision" : "change",
							content: currentEntryContent.trim(),
							relatedFiles:
								currentEntryFiles.length > 0 ? currentEntryFiles : undefined,
						};
						if (currentSection === "decisions") {
							decisions.push(entry);
						} else {
							recentChanges.push(entry);
						}
					}

					const timestampMatch = line.match(/\[([^\]]+)\]/);
					currentEntryTimestamp = timestampMatch
						? new Date(timestampMatch[1]).getTime()
						: Date.now();
					currentEntryContent = "";
					currentEntryFiles = [];
				} else if (line.startsWith("_Related:")) {
					const filesMatch = line.match(/_Related: (.+)_/);
					if (filesMatch) {
						currentEntryFiles = filesMatch[1].split(", ");
					}
				} else if (line.trim() && !line.startsWith("_")) {
					currentEntryContent += line + "\n";
				}
			}
		}

		// Add last entry
		if (currentEntryContent) {
			const entry: IMemoryEntry = {
				timestamp: currentEntryTimestamp,
				category: currentSection === "decisions" ? "decision" : "change",
				content: currentEntryContent.trim(),
				relatedFiles:
					currentEntryFiles.length > 0 ? currentEntryFiles : undefined,
			};
			if (currentSection === "decisions") {
				decisions.push(entry);
			} else {
				recentChanges.push(entry);
			}
		}

		return {
			summary: summaryText.trim(),
			architecture,
			keyFiles,
			decisions,
			recentChanges,
			version: MEMORY_VERSION,
		};
	}

	private calculateTotalTokens(): number {
		let total = estimateTokens(this._memory.summary);

		for (const note of this._memory.architecture) {
			total += estimateTokens(note);
		}

		for (const [path, purpose] of this._memory.keyFiles.entries()) {
			total += estimateTokens(path + purpose);
		}

		for (const decision of this._memory.decisions) {
			total += estimateTokens(decision.content);
		}

		for (const change of this._memory.recentChanges) {
			total += estimateTokens(change.content);
		}

		return total;
	}
}
