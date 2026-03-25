/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import {
	IFileService,
	FileChangeType,
} from "../../../../platform/files/common/files.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { ICodebaseIndexService } from "../common/codeai.js";
import { RunOnceScheduler } from "../../../../base/common/async.js";

/**
 * Service that watches file changes and incrementally updates the index.
 */
export class IndexWatcherService extends Disposable {
	private readonly updateScheduler: RunOnceScheduler;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService
		private readonly workspaceService: IWorkspaceContextService,
		@ICodebaseIndexService private readonly indexService: ICodebaseIndexService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Debounce updates by 500ms
		this.updateScheduler = this._register(
			new RunOnceScheduler(() => this.processQueuedUpdates(), 500),
		);

		this.startWatching();
	}

	private pendingUpdates = new Set<string>();
	private pendingDeletes = new Set<string>();

	private startWatching(): void {
		const workspace = this.workspaceService.getWorkspace();
		if (!workspace || workspace.folders.length === 0) {
			return;
		}

		for (const folder of workspace.folders) {
			this._register(
				this.fileService.watch(folder.uri, { recursive: true, excludes: [] }),
			);
		}

		this._register(
			this.fileService.onDidFilesChange((event) => {
				// Process all files in workspace
				const workspace = this.workspaceService.getWorkspace();
				if (!workspace || workspace.folders.length === 0) {
					return;
				}

				// Check for changes in indexed files
				const allFiles = this.indexService.getAllFiles();
				for (const filePath of allFiles) {
					const uri = { scheme: "file", path: filePath } as any;

					if (event.contains(uri, FileChangeType.DELETED)) {
						this.pendingDeletes.add(filePath);
						this.pendingUpdates.delete(filePath);
					} else if (
						event.contains(uri, FileChangeType.UPDATED) ||
						event.contains(uri, FileChangeType.ADDED)
					) {
						this.pendingUpdates.add(filePath);
						this.pendingDeletes.delete(filePath);
					}
				}

				if (this.pendingUpdates.size > 0 || this.pendingDeletes.size > 0) {
					this.updateScheduler.schedule();
				}
			}),
		);

		this.logService.info("[CodeAI] Index watcher started");
	}

	private async processQueuedUpdates(): Promise<void> {
		const updates = Array.from(this.pendingUpdates);
		const deletes = Array.from(this.pendingDeletes);

		this.pendingUpdates.clear();
		this.pendingDeletes.clear();

		// Process deletions
		for (const filePath of deletes) {
			try {
				await this.indexService.removeFile(filePath);
			} catch (err) {
				this.logService.trace(
					`[CodeAI] Failed to remove ${filePath} from index:`,
					err,
				);
			}
		}

		// Process updates
		for (const filePath of updates) {
			try {
				await this.indexService.updateFile(filePath);
			} catch (err) {
				this.logService.trace(
					`[CodeAI] Failed to update ${filePath} in index:`,
					err,
				);
			}
		}

		if (updates.length > 0 || deletes.length > 0) {
			this.logService.trace(
				`[CodeAI] Processed ${updates.length} updates and ${deletes.length} deletions`,
			);
		}
	}
}
