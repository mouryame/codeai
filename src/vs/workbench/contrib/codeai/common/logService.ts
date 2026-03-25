/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

export const ICodeAILogService = createDecorator<ICodeAILogService>('codeaiLogService');

export interface ICodeAILogService {
	readonly _serviceBrand: undefined;

	readonly onDidAppendChange: Event<string>;
	readonly onDidAppendPlan: Event<string>;

	/**
	 * Append an entry to `logs/changes.md`.
	 */
	appendChange(entry: string): Promise<void>;

	/**
	 * Append an entry to `logs/plan.md`.
	 */
	appendPlan(entry: string): Promise<void>;

	/**
	 * Read the full contents of `logs/changes.md`.
	 */
	readChanges(): Promise<string>;

	/**
	 * Read the full contents of `logs/plan.md`.
	 */
	readPlan(): Promise<string>;
}

export class CodeAILogService extends Disposable implements ICodeAILogService {
	readonly _serviceBrand: undefined;

	private readonly _onDidAppendChange = this._register(new Emitter<string>());
	readonly onDidAppendChange = this._onDidAppendChange.event;

	private readonly _onDidAppendPlan = this._register(new Emitter<string>());
	readonly onDidAppendPlan = this._onDidAppendPlan.event;

	private _changesUri: URI | undefined;
	private _planUri: URI | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	private getLogsRoot(): URI {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const root = folders.length > 0
			? folders[0].uri
			: URI.file('/tmp/codeai');
		return URI.joinPath(root, '.codeai', 'logs');
	}

	private getChangesUri(): URI {
		if (!this._changesUri) {
			this._changesUri = URI.joinPath(this.getLogsRoot(), 'changes.md');
		}
		return this._changesUri;
	}

	private getPlanUri(): URI {
		if (!this._planUri) {
			this._planUri = URI.joinPath(this.getLogsRoot(), 'plan.md');
		}
		return this._planUri;
	}

	private formatTimestamp(): string {
		return new Date().toISOString();
	}

	private async appendToFile(uri: URI, entry: string): Promise<void> {
		const formatted = `\n## [${this.formatTimestamp()}]\n${entry}\n`;
		let existing = '';
		try {
			const content = await this.fileService.readFile(uri);
			existing = content.value.toString();
		} catch {
			// File does not exist yet — start with a header
			existing = `# CodeAI Log\n`;
		}
		const updated = existing + formatted;
		await this.fileService.writeFile(uri, VSBuffer.fromString(updated));
	}

	async appendChange(entry: string): Promise<void> {
		await this.appendToFile(this.getChangesUri(), entry);
		this._onDidAppendChange.fire(entry);
	}

	async appendPlan(entry: string): Promise<void> {
		await this.appendToFile(this.getPlanUri(), entry);
		this._onDidAppendPlan.fire(entry);
	}

	async readChanges(): Promise<string> {
		try {
			const content = await this.fileService.readFile(this.getChangesUri());
			return content.value.toString();
		} catch {
			return '';
		}
	}

	async readPlan(): Promise<string> {
		try {
			const content = await this.fileService.readFile(this.getPlanUri());
			return content.value.toString();
		} catch {
			return '';
		}
	}
}
