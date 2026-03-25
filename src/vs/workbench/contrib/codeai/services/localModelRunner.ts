/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IModelConfig } from "../common/modelsConfig.js";
import {
	IGenerateRequest,
	IGenerateResult,
	ILocalModelRunner,
	IStreamCallbacks,
} from "../common/codeai.js";

/**
 * LocalModelRunner dispatches generation requests to either a GGUF runtime
 * (for reasoning models) or an MLX runtime (for coding models).
 *
 * It supports streaming via callbacks, abort signals, and tracks loaded state.
 */
export class LocalModelRunner extends Disposable implements ILocalModelRunner {
	readonly _serviceBrand: undefined;

	private _loaded = false;
	private _aborter: (() => void) | undefined;
	private _currentAbortController: AbortController | undefined;
	private _ggufModel:
		| { model?: any; context?: any; useCLI?: boolean }
		| undefined;
	private _serverUrl: string;

	constructor(
		public readonly config: IModelConfig,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		// Use configured port or default to 8080
		const port = this.config.serverPort ?? 8080;
		this._serverUrl = `http://localhost:${port}`;
	}

	isLoaded(): boolean {
		return this._loaded;
	}

	async load(): Promise<void> {
		if (this._loaded) {
			return;
		}
		this.logService.info(
			`[CodeAI] Loading model "${this.config.id}" from "${this.config.path}" (role: ${this.config.role})`,
		);

		// Use GGUF if serverPort is configured, otherwise use MLX
		if (this.config.serverPort) {
			await this.loadGGUF();
		} else {
			await this.loadMLX();
		}

		this._loaded = true;
		this.logService.info(
			`[CodeAI] Model "${this.config.id}" loaded successfully.`,
		);
	}

	async unload(): Promise<void> {
		if (!this._loaded) {
			return;
		}
		this.logService.info(`[CodeAI] Unloading model "${this.config.id}".`);
		// Release native handles / memory.
		// In a real implementation this would call into native bindings.
		this._loaded = false;
	}

	abort(): void {
		if (this._aborter) {
			this._aborter();
			this._aborter = undefined;
		}
		if (this._currentAbortController) {
			this._currentAbortController.abort();
			this._currentAbortController = undefined;
		}
	}

	async generate(
		request: IGenerateRequest,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		if (!this._loaded) {
			await this.load();
		}

		this._currentAbortController = new AbortController();
		const signal = request.signal ?? this._currentAbortController.signal;

		try {
			// Use GGUF if serverPort is configured, otherwise use MLX
			const result = this.config.serverPort
				? await this.generateGGUF(request, signal, callbacks)
				: await this.generateMLX(request, signal, callbacks);

			return result;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			if (callbacks?.onError) {
				callbacks.onError(error);
			}
			throw error;
		} finally {
			this._currentAbortController = undefined;
		}
	}

	// ── GGUF Runtime (reasoning) ────────────────────────────────────────────

	private async loadGGUF(): Promise<void> {
		this.logService.info(
			`[CodeAI] GGUF engine: connecting to llama-server at ${this._serverUrl}`,
		);

		// Check if llama-server is running using XMLHttpRequest
		try {
			const statusCode = await new Promise<number>((resolve, reject) => {
				const xhr = new XMLHttpRequest();
				xhr.timeout = 2000;
				xhr.open("GET", `${this._serverUrl}/health`, true);

				xhr.onload = () => resolve(xhr.status);
				xhr.onerror = () => reject(new Error("Connection failed"));
				xhr.ontimeout = () => reject(new Error("Connection timeout"));

				xhr.send();
			});

			if (statusCode === 200) {
				this._ggufModel = {};
				this.logService.info(`[CodeAI] Connected to llama-server successfully`);
			} else {
				throw new Error(`Server returned status ${statusCode}`);
			}
		} catch (err) {
			this.logService.warn(
				`[CodeAI] llama-server connection failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.logService.warn(
				`[CodeAI] Start llama-server with: llama-server -m "${this.config.path}" --port ${this.config.serverPort ?? 8080}`,
			);
			this._ggufModel = { useCLI: true };
		}
	}

	private async generateGGUF(
		request: IGenerateRequest,
		signal: AbortSignal,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		this.logService.trace(
			`[CodeAI] GGUF generate: prompt length=${request.prompt.length}`,
		);

		const maxTokens = request.maxTokens ?? this.config.maxTokens;
		const temperature = request.temperature ?? this.config.temperature;

		if (this._ggufModel?.useCLI) {
			const errorMsg = `[CodeAI] llama-server not running. Start it with: llama-server -m "${this.config.path}" --port 8080`;
			this.logService.error(errorMsg);
			throw new Error(errorMsg);
		}

		try {
			// Use XMLHttpRequest for HTTP calls (works in Electron renderer)
			const postData = JSON.stringify({
				prompt: request.prompt,
				n_predict: maxTokens,
				temperature: temperature,
				stream: true,
			});

			let generated = "";
			let tokenCount = 0;
			let lastProcessedIndex = 0;

			const result = await new Promise<{ text: string; tokensUsed: number }>(
				(resolve, reject) => {
					const xhr = new XMLHttpRequest();
					xhr.open("POST", `${this._serverUrl}/completion`, true);
					xhr.setRequestHeader("Content-Type", "application/json");

					// Process chunks as they arrive
					xhr.onprogress = () => {
						const responseText = xhr.responseText;
						const newText = responseText.substring(lastProcessedIndex);
						lastProcessedIndex = responseText.length;

						// Process new lines
						const lines = newText.split("\n");
						for (const line of lines) {
							if (signal.aborted) {
								xhr.abort();
								return;
							}

							if (!line.trim() || !line.startsWith("data: ")) {
								continue;
							}

							try {
								const data = JSON.parse(line.substring(6));
								if (data.content) {
									generated += data.content;
									tokenCount++;
									if (callbacks?.onText) {
										callbacks.onText(data.content);
									}
								}
							} catch (e) {
								// Ignore JSON parse errors for incomplete lines
							}
						}
					};

					xhr.onload = () => {
						if (xhr.status === 200) {
							if (callbacks?.onFinalMessage) {
								callbacks.onFinalMessage(generated);
							}
							resolve({ text: generated, tokensUsed: tokenCount });
						} else {
							reject(new Error(`Server returned status ${xhr.status}`));
						}
					};

					xhr.onerror = () => reject(new Error("Request failed"));

					signal.addEventListener("abort", () => {
						xhr.abort();
						reject(new Error("Request aborted"));
					});

					xhr.send(postData);
				},
			);

			return {
				text: result.text,
				tokensUsed: result.tokensUsed,
				modelId: this.config.id,
			};
		} catch (err) {
			this.logService.error(`[CodeAI] GGUF generation failed: ${err}`);
			throw err;
		}
	}

	// ── MLX Runtime (coding) ────────────────────────────────────────────────

	private async loadMLX(): Promise<void> {
		const opts = this.config.mlxOptions;
		this.logService.info(
			`[CodeAI] MLX engine: loading "${this.config.path}", quantize=${opts?.quantize ?? "none"}, trustRemoteCode=${opts?.trustRemoteCode ?? false}`,
		);
		// MLX models are loaded on-demand via Python subprocess
	}

	private async generateMLX(
		request: IGenerateRequest,
		signal: AbortSignal,
		callbacks?: IStreamCallbacks,
	): Promise<IGenerateResult> {
		this.logService.trace(
			`[CodeAI] MLX generate: prompt length=${request.prompt.length}`,
		);

		const errorMsg = `[CodeAI] MLX inference requires a utility process worker. For now, use GGUF models for both reasoning and coding roles.`;
		this.logService.error(errorMsg);
		throw new Error(errorMsg);
	}
}
