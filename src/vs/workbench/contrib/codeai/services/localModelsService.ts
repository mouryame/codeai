/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from "../../../../base/common/event.js";
import {
	Disposable,
	DisposableMap,
} from "../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import {
	IModelsConfig,
	IModelConfig,
	modelsConfig,
} from "../common/modelsConfig.js";
import { ILocalModelsService, ILocalModelRunner } from "../common/codeai.js";
import { LocalModelRunner } from "./localModelRunner.js";

/**
 * Memory pressure threshold (0–1). When system memory usage exceeds this
 * ratio the service will unload the less-needed model to free resources.
 */
const MEMORY_PRESSURE_THRESHOLD = 0.85;

export class LocalModelsService
	extends Disposable
	implements ILocalModelsService
{
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeConfig = this._register(
		new Emitter<IModelsConfig>(),
	);
	readonly onDidChangeConfig: Event<IModelsConfig> =
		this._onDidChangeConfig.event;

	private _config: IModelsConfig;
	private readonly _runners = this._register(
		new DisposableMap<string, LocalModelRunner>(),
	);

	constructor(
		@ILogService private readonly logService: ILogService,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._config = modelsConfig;
	}

	// ── Public API ──────────────────────────────────────────────────────────

	getConfig(): IModelsConfig {
		return this._config;
	}

	async loadModels(): Promise<void> {
		this.logService.info(
			"[CodeAI] Loading models from embedded configuration…",
		);

		for (const modelCfg of this._config.models) {
			this.ensureRunner(modelCfg);
		}

		// Eagerly load both models if memory allows
		const memUsage = this.getMemoryUsage();
		if (memUsage < MEMORY_PRESSURE_THRESHOLD) {
			for (const [, runner] of this._runners) {
				if (!runner.isLoaded()) {
					await runner.load();
				}
			}
		} else {
			this.logService.warn(
				`[CodeAI] Memory usage at ${(memUsage * 100).toFixed(1)}% — deferring model loads.`,
			);
		}
	}

	getModelByRole(role: "reasoning" | "coding"): ILocalModelRunner {
		for (const [, runner] of this._runners) {
			if (runner.config.role === role) {
				return runner;
			}
		}
		throw new Error(`[CodeAI] No model configured for role "${role}".`);
	}

	getMemoryUsage(): number {
		// In Electron / Node.js we can read process.memoryUsage() and
		// os.totalmem()/os.freemem(). In a browser context we fall back
		// to the Performance API when available.
		try {
			const nodeProcess: { memoryUsage?: () => { rss: number } } | undefined =
				typeof globalThis !== "undefined"
					? ((globalThis as Record<string, unknown>).process as {
							memoryUsage?: () => { rss: number };
						})
					: undefined;
			if (nodeProcess && typeof nodeProcess.memoryUsage === "function") {
				const mem = nodeProcess.memoryUsage();
				// rss relative to a 16 GB baseline (configurable)
				const totalEstimate = 16 * 1024 * 1024 * 1024;
				return Math.min(1, mem.rss / totalEstimate);
			}
			// eslint-disable-next-line no-restricted-syntax
			const perfMemory = (
				performance as {
					memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
				}
			).memory;
			if (perfMemory) {
				return perfMemory.usedJSHeapSize / perfMemory.jsHeapSizeLimit;
			}
		} catch {
			// Ignore – fallback below
		}
		return 0;
	}

	async ensureMemoryBudget(
		requiredRole: "reasoning" | "coding",
	): Promise<void> {
		const usage = this.getMemoryUsage();
		if (usage < MEMORY_PRESSURE_THRESHOLD) {
			return;
		}

		this.logService.warn(
			`[CodeAI] Memory pressure detected (${(usage * 100).toFixed(1)}%). ` +
				`Unloading models not needed for role "${requiredRole}".`,
		);

		const oppositeRole: "reasoning" | "coding" =
			requiredRole === "reasoning" ? "coding" : "reasoning";
		for (const [, runner] of this._runners) {
			if (runner.config.role === oppositeRole && runner.isLoaded()) {
				await runner.unload();
			}
		}
	}

	/**
	 * Hot-reload configuration at runtime. Called when the user edits
	 * modelsConfig.ts or an equivalent settings UI.
	 */
	updateConfig(newConfig: IModelsConfig): void {
		this._config = newConfig;
		this.logService.info(
			"[CodeAI] Model configuration updated — re-initialising runners.",
		);

		// Dispose old runners that are no longer in the config
		const newIds = new Set(newConfig.models.map((m) => m.id));
		for (const [id] of this._runners) {
			if (!newIds.has(id)) {
				this._runners.deleteAndDispose(id);
			}
		}

		// Ensure runners exist for all new models
		for (const modelCfg of newConfig.models) {
			if (!this._runners.has(modelCfg.id)) {
				this.ensureRunner(modelCfg);
			}
		}

		this._onDidChangeConfig.fire(newConfig);
	}

	// ── Private ─────────────────────────────────────────────────────────────

	private ensureRunner(modelCfg: IModelConfig): LocalModelRunner {
		let runner = this._runners.get(modelCfg.id);
		if (!runner) {
			runner = this.instantiationService.createInstance(
				LocalModelRunner,
				modelCfg,
			);
			this._runners.set(modelCfg.id, runner);
		}
		return runner;
	}
}
