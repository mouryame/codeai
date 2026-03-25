/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CODEAI_CONTEXT_LOG } from '../common/codeai.js';

/**
 * Service that logs context retrieval operations for debugging and transparency.
 */
export class ContextLogService extends Disposable {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async logRetrieval(query: string, chunks: Array<{ filePath: string; score: number; reason?: string }>): Promise<void> {
		try {
			const workspace = this.workspaceService.getWorkspace();
			if (!workspace || workspace.folders.length === 0) {
				return;
			}

			const timestamp = new Date().toISOString();
			const entry = this.formatRetrievalEntry(timestamp, query, chunks);

			const codeaiDir = URI.joinPath(workspace.folders[0].uri, '.codeai');
			await this.fileService.createFolder(codeaiDir);

			const logUri = URI.joinPath(codeaiDir, CODEAI_CONTEXT_LOG);

			// Append to existing log
			let existingContent = '';
			try {
				const existing = await this.fileService.readFile(logUri);
				existingContent = existing.value.toString();
			} catch {
				existingContent = '# CodeAI Context Retrieval Log\n\n';
			}

			const newContent = existingContent + entry;
			await this.fileService.writeFile(logUri, VSBuffer.fromString(newContent));

			this.logService.trace('[CodeAI] Logged context retrieval');
		} catch (err) {
			this.logService.warn('[CodeAI] Failed to log context retrieval:', err);
		}
	}

	private formatRetrievalEntry(
		timestamp: string,
		query: string,
		chunks: Array<{ filePath: string; score: number; reason?: string }>,
	): string {
		const lines: string[] = [];

		lines.push(`## [${timestamp}]`);
		lines.push('');
		lines.push(`**Query:** ${query}`);
		lines.push('');
		lines.push(`**Retrieved ${chunks.length} chunks:**`);
		lines.push('');

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			lines.push(`${i + 1}. \`${chunk.filePath}\``);
			lines.push(`   - Score: ${chunk.score.toFixed(3)}`);
			if (chunk.reason) {
				lines.push(`   - Reason: ${chunk.reason}`);
			}
		}

		lines.push('');
		lines.push('---');
		lines.push('');

		return lines.join('\n');
	}
}
