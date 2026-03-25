/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Embedded model configuration for CodeAI local inference.
 * Users can modify paths and parameters directly in this file.
 */

export interface IMLXOptions {
	readonly trustRemoteCode: boolean;
	readonly quantize: string;
}

export interface IModelConfig {
	readonly id: string;
	readonly path: string;
	readonly role: "reasoning" | "coding";
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly temperature: number;
	readonly threads: number;
	readonly serverPort?: number; // Port for llama-server (e.g., 8080 for reasoning, 8081 for coding)
	readonly mlxOptions?: IMLXOptions;
}

export interface IRoutingConfig {
	readonly planning: string;
	readonly tool_selection: string;
	readonly code_generation: string;
	readonly code_editing: string;
	readonly general_chat: string;
}

export interface IModelsConfig {
	readonly models: IModelConfig[];
	readonly routing: IRoutingConfig;
}

export const modelsConfig: IModelsConfig = {
	models: [
		{
			id: "reasoning-model",
			path: "/Users/mouryachiranjeevi/.lmstudio/models/lmstudio-community/DeepSeek-R1-Distill-Qwen-7B-GGUF/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf",
			role: "reasoning",
			contextWindow: 32768,
			maxTokens: 4096,
			temperature: 0.7,
			threads: 4,
			serverPort: 8080,
		},
		{
			id: "coding-model",
			path: "/Users/mouryachiranjeevi/.lmstudio/models/lmstudio-community/Qwen2.5-14B-Instruct-GGUF/Qwen2.5-14B-Instruct-Q4_K_M.gguf",
			role: "coding",
			contextWindow: 32768,
			maxTokens: 4096,
			temperature: 0.2,
			threads: 4,
			serverPort: 8081,
		},
	],
	routing: {
		planning: "reasoning-model",
		tool_selection: "reasoning-model",
		code_generation: "coding-model",
		code_editing: "coding-model",
		general_chat: "reasoning-model",
	},
};
