/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import {
	ICodebaseIndexService,
	ICodeChunk,
	ILocalModelsService,
	IRetrievalQuery,
	IRetrievalResult,
	IRetrievalService,
} from "../common/codeai.js";

/**
 * Service that retrieves relevant code chunks using hybrid keyword + AI re-ranking.
 */
export class RetrievalService extends Disposable implements IRetrievalService {
	readonly _serviceBrand: undefined;

	constructor(
		@ICodebaseIndexService private readonly indexService: ICodebaseIndexService,
		@ILocalModelsService private readonly modelsService: ILocalModelsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async retrieve(query: IRetrievalQuery): Promise<IRetrievalResult[]> {
		if (!this.indexService.isReady()) {
			this.logService.warn("[CodeAI] Index not ready for retrieval");
			return [];
		}

		const startTime = Date.now();

		// Step 1: Keyword-based scoring
		const candidates = await this.keywordSearch(query);

		if (candidates.length === 0) {
			this.logService.trace("[CodeAI] No candidates found for query");
			return [];
		}

		// Step 2: AI re-ranking (top 10 candidates)
		const topCandidates = candidates.slice(0, 10);
		const reranked = await this.aiRerank(query.query, topCandidates);

		const duration = Date.now() - startTime;
		this.logService.trace(
			`[CodeAI] Retrieved ${reranked.length} chunks in ${duration}ms (from ${candidates.length} candidates)`,
		);

		return reranked;
	}

	async getChunksByFile(filePath: string): Promise<ICodeChunk[]> {
		return this.indexService.getFileChunks(filePath);
	}

	async getChunksBySymbol(symbolName: string): Promise<ICodeChunk[]> {
		const results: ICodeChunk[] = [];

		// This is inefficient but works for now - in production, we'd maintain a symbol index
		const allFiles = this.indexService.getAllFiles();
		for (const filePath of allFiles) {
			const chunks = this.indexService.getFileChunks(filePath);
			for (const chunk of chunks) {
				if (chunk.symbolName?.toLowerCase() === symbolName.toLowerCase()) {
					results.push(chunk);
				}
			}
		}

		return results;
	}

	// ── Private Methods ─────────────────────────────────────────────────────

	private async keywordSearch(
		query: IRetrievalQuery,
	): Promise<IRetrievalResult[]> {
		const queryTerms = this.extractQueryTerms(query.query);
		const results: IRetrievalResult[] = [];

		const allFiles = this.indexService.getAllFiles();

		for (const filePath of allFiles) {
			// Apply file pattern filters
			if (
				query.filePatterns &&
				!this.matchesPatterns(filePath, query.filePatterns)
			) {
				continue;
			}

			if (
				query.excludePatterns &&
				this.matchesPatterns(filePath, query.excludePatterns)
			) {
				continue;
			}

			const chunks = this.indexService.getFileChunks(filePath);

			for (const chunk of chunks) {
				const score = this.calculateKeywordScore(chunk, queryTerms, filePath);

				if (score > (query.minScore || 0.1)) {
					results.push({
						chunk,
						score,
						reason: "keyword_match",
					});
				}
			}
		}

		// Sort by score descending
		results.sort((a, b) => b.score - a.score);

		// Limit results
		const maxResults = query.maxResults || 20;
		return results.slice(0, maxResults);
	}

	private calculateKeywordScore(
		chunk: ICodeChunk,
		queryTerms: string[],
		filePath: string,
	): number {
		let score = 0;

		const chunkText = chunk.content.toLowerCase();
		const chunkKeywords = new Set(chunk.keywords);
		const fileName = filePath.toLowerCase();

		// TF-IDF-like scoring
		for (const term of queryTerms) {
			const termLower = term.toLowerCase();

			// Exact symbol name match (highest weight)
			if (chunk.symbolName?.toLowerCase() === termLower) {
				score += 10.0;
			}

			// Symbol name contains term
			if (chunk.symbolName?.toLowerCase().includes(termLower)) {
				score += 5.0;
			}

			// File name match
			if (fileName.includes(termLower)) {
				score += 3.0;
			}

			// Keyword match
			if (chunkKeywords.has(termLower)) {
				score += 2.0;
			}

			// Content match (with frequency)
			const regex = new RegExp(`\\b${this.escapeRegex(termLower)}\\b`, "gi");
			const matches = chunkText.match(regex);
			if (matches) {
				score += Math.min(matches.length * 0.5, 3.0);
			}
		}

		// Boost by chunk type
		if (chunk.type === "function" || chunk.type === "class") {
			score *= 1.2;
		}

		// Boost by file importance (from index)
		// We'd need to access this from the index - for now, simple heuristic
		if (filePath.includes("/src/")) {
			score *= 1.1;
		}

		// Penalize very large chunks (might be less focused)
		if (chunk.tokens > 1000) {
			score *= 0.8;
		}

		return score;
	}

	private async aiRerank(
		query: string,
		candidates: IRetrievalResult[],
	): Promise<IRetrievalResult[]> {
		if (candidates.length === 0) {
			return [];
		}

		try {
			// Build prompt for AI re-ranking
			const prompt = this.buildRerankPrompt(query, candidates);

			// Use reasoning model for re-ranking
			const runner = this.modelsService.getModelByRole("reasoning");

			const result = await runner.generate({
				prompt,
				role: "reasoning",
				systemPrompt:
					"You are a code relevance analyzer. Given a query and code chunks, select the most relevant ones. Respond with ONLY a JSON array of chunk IDs in order of relevance.",
				maxTokens: 500,
				temperature: 0.1,
			});

			// Parse AI response
			const rankedIds = this.parseRerankResponse(result.text);

			// Reorder candidates based on AI ranking
			const reranked: IRetrievalResult[] = [];
			const candidateMap = new Map(candidates.map((c) => [c.chunk.id, c]));

			for (let i = 0; i < rankedIds.length; i++) {
				const candidate = candidateMap.get(rankedIds[i]);
				if (candidate) {
					// Update score based on AI ranking position
					const aiScore = (rankedIds.length - i) / rankedIds.length;
					reranked.push({
						...candidate,
						score: candidate.score * 0.3 + aiScore * 0.7, // Blend keyword + AI scores
						reason: "ai_reranked",
					});
				}
			}

			// Add any candidates not ranked by AI (at the end)
			for (const candidate of candidates) {
				if (!rankedIds.includes(candidate.chunk.id)) {
					reranked.push({
						...candidate,
						score: candidate.score * 0.3, // Heavily penalize
					});
				}
			}

			return reranked;
		} catch (err) {
			this.logService.warn(
				"[CodeAI] AI re-ranking failed, falling back to keyword scores:",
				err,
			);
			return candidates;
		}
	}

	private buildRerankPrompt(
		query: string,
		candidates: IRetrievalResult[],
	): string {
		const chunks = candidates.map((c, idx) => {
			const preview = c.chunk.content.slice(0, 300);
			return `[${idx}] ID: ${c.chunk.id}
File: ${c.chunk.filePath}
Symbol: ${c.chunk.symbolName || "N/A"}
Type: ${c.chunk.type}
Preview: ${preview}...
`;
		});

		return `Query: "${query}"

Code Chunks:
${chunks.join("\n")}

Select the chunk IDs most relevant to the query. Return ONLY a JSON array of IDs, e.g., ["id1", "id2", "id3"]`;
	}

	private parseRerankResponse(response: string): string[] {
		try {
			// Try to extract JSON array from response
			const jsonMatch = response.match(/\[[\s\S]*\]/);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]);
				if (Array.isArray(parsed)) {
					return parsed.filter((id) => typeof id === "string");
				}
			}
		} catch (err) {
			this.logService.trace(
				"[CodeAI] Failed to parse AI rerank response:",
				err,
			);
		}
		return [];
	}

	private extractQueryTerms(query: string): string[] {
		// Extract meaningful terms from query
		const terms = query
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((term) => term.length > 2 && !this.isStopWord(term));

		return Array.from(new Set(terms));
	}

	private isStopWord(word: string): boolean {
		const stopWords = new Set([
			"the",
			"and",
			"for",
			"this",
			"that",
			"with",
			"from",
			"how",
			"what",
			"where",
			"when",
			"why",
			"which",
			"who",
			"can",
			"could",
			"should",
			"would",
			"will",
			"does",
			"did",
			"has",
			"have",
			"had",
			"are",
			"was",
			"were",
			"been",
			"being",
		]);
		return stopWords.has(word);
	}

	private matchesPatterns(filePath: string, patterns: string[]): boolean {
		for (const pattern of patterns) {
			const regex = new RegExp(pattern.replace(/\*/g, ".*"));
			if (regex.test(filePath)) {
				return true;
			}
		}
		return false;
	}

	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
}
