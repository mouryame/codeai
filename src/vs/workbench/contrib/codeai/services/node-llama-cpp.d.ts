/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Type declarations for optional node-llama-cpp dependency.
 * This module is loaded dynamically at runtime and may not be installed.
 */

declare module 'node-llama-cpp' {
	export class LlamaModel {
		constructor(options: { modelPath: string });
	}

	export class LlamaContext {
		constructor(options: {
			model: LlamaModel;
			contextSize: number;
			threads: number;
		});
		decode(tokens: number[]): string;
	}

	export class LlamaChatSession {
		constructor(options: { context: LlamaContext });
		prompt(
			text: string,
			options: {
				maxTokens: number;
				temperature: number;
				onToken?: (tokens: number[]) => boolean;
			}
		): Promise<string>;
	}
}
