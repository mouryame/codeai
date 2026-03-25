/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import {
	CascadePhase,
	CODEAI_VIEW_TITLE,
	ICascadeOrchestrator,
	IPlanStep,
} from '../common/codeai.js';

/**
 * Plan progress widget for ⚡ CodeAI (Local).
 *
 * Displays the current cascade phase and all plan steps with their statuses
 * inside a provided container element.
 */
export class PlanProgress extends Disposable {

	private readonly _disposables = this._register(new DisposableStore());

	private _container!: HTMLElement;
	private _phaseEl!: HTMLElement;
	private _stepsEl!: HTMLElement;

	constructor(
		parent: HTMLElement,
		@ICascadeOrchestrator private readonly orchestrator: ICascadeOrchestrator,
	) {
		super();
		this.createUI(parent);
		this.bindEvents();
	}

	// ── UI Construction ─────────────────────────────────────────────────────

	private createUI(parent: HTMLElement): void {
		this._container = append(parent, $('.codeai-plan-progress'));
		this._container.style.padding = '8px 12px';
		this._container.style.borderBottom = '1px solid var(--vscode-panel-border)';

		// Title
		const title = append(this._container, $('div.codeai-plan-title'));
		title.textContent = `${CODEAI_VIEW_TITLE} — Plan Progress`;
		title.style.fontWeight = 'bold';
		title.style.marginBottom = '6px';
		title.style.fontSize = '12px';

		// Phase indicator
		this._phaseEl = append(this._container, $('div.codeai-phase'));
		this._phaseEl.style.fontSize = '11px';
		this._phaseEl.style.marginBottom = '8px';
		this._phaseEl.style.color = 'var(--vscode-descriptionForeground)';
		this.renderPhase(this.orchestrator.currentPhase);

		// Steps list
		this._stepsEl = append(this._container, $('div.codeai-steps'));
	}

	// ── Event binding ───────────────────────────────────────────────────────

	private bindEvents(): void {
		this._disposables.add(
			this.orchestrator.onDidChangePhase(phase => this.renderPhase(phase))
		);
		this._disposables.add(
			this.orchestrator.onDidUpdatePlan(steps => this.renderSteps(steps))
		);
	}

	// ── Rendering ───────────────────────────────────────────────────────────

	private renderPhase(phase: CascadePhase): void {
		const phaseLabels: Record<CascadePhase, string> = {
			understanding: '🔍 Understanding',
			planning: '📋 Planning',
			reading: '📖 Reading',
			applying: '✏️ Applying',
			completed: '✅ Completed',
		};
		this._phaseEl.textContent = `Phase: ${phaseLabels[phase]}`;
	}

	private renderSteps(steps: IPlanStep[]): void {
		clearNode(this._stepsEl);

		for (const step of steps) {
			const row = append(this._stepsEl, $('div.codeai-step'));
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '6px';
			row.style.padding = '2px 0';
			row.style.fontSize = '11px';

			const icon = append(row, $('span.codeai-step-icon'));
			icon.textContent = this.statusIcon(step.status);

			const label = append(row, $('span.codeai-step-label'));
			label.textContent = step.description;
			label.style.flex = '1';
			label.style.overflow = 'hidden';
			label.style.textOverflow = 'ellipsis';
			label.style.whiteSpace = 'nowrap';

			if (step.status === 'completed') {
				label.style.color = 'var(--vscode-testing-iconPassed)';
			} else if (step.status === 'failed') {
				label.style.color = 'var(--vscode-testing-iconFailed)';
			} else if (step.status === 'in_progress') {
				label.style.color = 'var(--vscode-progressBar-background)';
			} else {
				label.style.color = 'var(--vscode-descriptionForeground)';
			}
		}
	}

	private statusIcon(status: IPlanStep['status']): string {
		switch (status) {
			case 'pending': return '○';
			case 'in_progress': return '◑';
			case 'completed': return '●';
			case 'failed': return '✕';
		}
	}
}
