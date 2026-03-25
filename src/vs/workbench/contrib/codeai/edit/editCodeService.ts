/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import {
	ICascadeOrchestrator,
	IDiffZone,
	IEditCodeService,
	IEditOperation,
	IStreamCallbacks,
} from '../common/codeai.js';
import { ICodeAILogService } from '../common/logService.js';

export class EditCodeService extends Disposable implements IEditCodeService {
	readonly _serviceBrand: undefined;

	private readonly _onDidApplyEdit = this._register(new Emitter<IEditOperation>());
	readonly onDidApplyEdit: Event<IEditOperation> = this._onDidApplyEdit.event;

	/** Active diff zones keyed by file path. */
	private readonly _diffZones = new Map<string, IDiffZone[]>();

	constructor(
		@ICascadeOrchestrator private readonly orchestrator: ICascadeOrchestrator,
		@ICodeAILogService private readonly codeaiLogService: ICodeAILogService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// ── Fast Apply (search / replace) ───────────────────────────────────────

	async fastApply(filePath: string, oldText: string, newText: string, description: string): Promise<void> {
		this.logService.info(`[CodeAI] Fast apply on "${filePath}": ${description}`);

		const uri = URI.file(filePath);
		const content = await this.fileService.readFile(uri);
		const source = content.value.toString();

		if (!source.includes(oldText)) {
			throw new Error(`[CodeAI] Fast apply failed — old text not found in "${filePath}".`);
		}

		const updated = source.replace(oldText, newText);
		await this.fileService.writeFile(uri, VSBuffer.fromString(updated));

		const op: IEditOperation = {
			filePath,
			mode: 'fast',
			oldText,
			newText,
			description,
		};
		this._onDidApplyEdit.fire(op);

		// Track diff zone
		this.recordDiffZone(filePath, source, updated, oldText, newText);

		// Append to change log
		await this.codeaiLogService.appendChange(
			`**Fast Apply** — \`${filePath}\`\n\n${description}\n\n` +
			`\`\`\`diff\n- ${oldText.split('\n').join('\n- ')}\n+ ${newText.split('\n').join('\n+ ')}\n\`\`\``
		);
	}

	// ── Slow Apply (full rewrite via coding model) ──────────────────────────

	async slowApply(filePath: string, prompt: string, description: string, callbacks?: IStreamCallbacks): Promise<void> {
		this.logService.info(`[CodeAI] Slow apply on "${filePath}": ${description}`);

		const uri = URI.file(filePath);
		let originalSource = '';
		try {
			const content = await this.fileService.readFile(uri);
			originalSource = content.value.toString();
		} catch {
			// File may not exist yet — that's OK for new-file creation
		}

		const fullPrompt =
			`File: ${filePath}\n` +
			`Current contents:\n\`\`\`\n${originalSource}\n\`\`\`\n\n` +
			`Task: ${prompt}\n\n` +
			`Produce the full updated file contents.`;

		const result = await this.orchestrator.runCodeEdit(fullPrompt, callbacks);

		// Write the coding model's output as the new file content
		const newContent = this.extractCodeBlock(result.text) ?? result.text;
		await this.fileService.writeFile(uri, VSBuffer.fromString(newContent));

		const op: IEditOperation = {
			filePath,
			mode: 'slow',
			oldText: originalSource,
			newText: newContent,
			description,
		};
		this._onDidApplyEdit.fire(op);

		// Track diff zone
		this.recordDiffZone(filePath, originalSource, newContent, originalSource, newContent);

		// Append to change log (the orchestrator already logs the raw model output)
		await this.codeaiLogService.appendChange(
			`**Slow Apply** — \`${filePath}\`\n\n${description}`
		);
	}

	// ── Diff Zones ──────────────────────────────────────────────────────────

	getDiffZones(filePath: string): IDiffZone[] {
		return this._diffZones.get(filePath) ?? [];
	}

	private recordDiffZone(
		filePath: string,
		originalFull: string,
		_updatedFull: string,
		oldText: string,
		newText: string,
	): void {
		const startLine = originalFull.substring(0, originalFull.indexOf(oldText)).split('\n').length;
		const endLine = startLine + oldText.split('\n').length - 1;

		const zone: IDiffZone = {
			startLine,
			endLine,
			originalContent: oldText,
			newContent: newText,
		};

		const zones = this._diffZones.get(filePath) ?? [];
		zones.push(zone);
		this._diffZones.set(filePath, zones);
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	/**
	 * Extract the first fenced code block from model output.
	 */
	private extractCodeBlock(text: string): string | undefined {
		const match = /```[\w]*\n([\s\S]*?)```/.exec(text);
		return match ? match[1] : undefined;
	}
}
