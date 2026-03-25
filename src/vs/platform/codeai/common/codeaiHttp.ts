/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ICodeAIHttpService = createDecorator<ICodeAIHttpService>('codeaiHttpService');

export interface ICodeAIHttpRequest {
	url: string;
	method: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	timeout?: number;
}

export interface ICodeAIHttpResponse {
	status: number;
	body: string;
}

export interface ICodeAIHttpService {
	readonly _serviceBrand: undefined;
	request(options: ICodeAIHttpRequest): Promise<ICodeAIHttpResponse>;
}
