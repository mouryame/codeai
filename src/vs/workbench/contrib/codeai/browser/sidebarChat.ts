/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from "../../../../base/browser/dom.js";
import { sanitizeHtml } from "../../../../base/browser/domSanitize.js";
import { renderMarkdown } from "../../../../base/browser/markdownRenderer.js";
import {
	Disposable,
	DisposableStore,
} from "../../../../base/common/lifecycle.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import {
	CODEAI_VIEW_TITLE,
	ICascadeOrchestrator,
	IStreamCallbacks,
} from "../common/codeai.js";
import { ICodeAILogService } from "../common/logService.js";

/**
 * Sidebar chat panel for ⚡ CodeAI (Local).
 *
 * Renders a simple chat UI inside a provided container element.
 * All messages are routed through the CascadeOrchestrator.
 */
export class SidebarChat extends Disposable {
	private readonly _disposables = this._register(new DisposableStore());

	private _container!: HTMLElement;
	private _messagesEl!: HTMLElement;
	private _inputEl!: HTMLTextAreaElement;
	private _sendBtn!: HTMLButtonElement;
	private _logBtns!: HTMLElement;

	constructor(
		parent: HTMLElement,
		@ICascadeOrchestrator private readonly orchestrator: ICascadeOrchestrator,
		@ICodeAILogService private readonly codeaiLogService: ICodeAILogService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.createUI(parent);
	}

	// ── UI construction ─────────────────────────────────────────────────────

	private createUI(parent: HTMLElement): void {
		this._container = append(parent, $(".codeai-sidebar-chat"));
		this._container.style.display = "flex";
		this._container.style.flexDirection = "column";
		this._container.style.height = "100%";
		this._container.style.overflow = "hidden";

		// Header
		const header = append(this._container, $(".codeai-header"));
		header.textContent = CODEAI_VIEW_TITLE;
		header.style.fontWeight = "bold";
		header.style.fontSize = "14px";
		header.style.padding = "8px 12px";
		header.style.borderBottom = "1px solid var(--vscode-panel-border)";
		header.style.flexShrink = "0";

		// Messages area
		this._messagesEl = append(this._container, $(".codeai-messages"));
		this._messagesEl.style.flex = "1 1 auto";
		this._messagesEl.style.overflowY = "auto";
		this._messagesEl.style.overflowX = "hidden";
		this._messagesEl.style.padding = "8px 12px";
		this._messagesEl.style.display = "flex";
		this._messagesEl.style.flexDirection = "column";
		this._messagesEl.style.minHeight = "0";

		// Input area
		const inputArea = append(this._container, $(".codeai-input-area"));
		inputArea.style.display = "flex";
		inputArea.style.padding = "8px 12px";
		inputArea.style.borderTop = "1px solid var(--vscode-panel-border)";
		inputArea.style.flexShrink = "0";

		this._inputEl = append(
			inputArea,
			$("textarea.codeai-input"),
		) as HTMLTextAreaElement;
		this._inputEl.placeholder = "Ask CodeAI anything…";
		this._inputEl.style.flex = "1";
		this._inputEl.style.resize = "none";
		this._inputEl.style.minHeight = "36px";
		this._inputEl.style.maxHeight = "120px";
		this._inputEl.style.padding = "6px 8px";
		this._inputEl.style.borderRadius = "4px";
		this._inputEl.style.border = "1px solid var(--vscode-input-border)";
		this._inputEl.style.background = "var(--vscode-input-background)";
		this._inputEl.style.color = "var(--vscode-input-foreground)";
		this._inputEl.style.fontFamily = "var(--vscode-font-family)";
		this._inputEl.style.fontSize = "var(--vscode-font-size)";

		this._sendBtn = append(
			inputArea,
			$("button.codeai-send"),
		) as HTMLButtonElement;
		this._sendBtn.textContent = "Send";
		this._sendBtn.style.marginLeft = "8px";
		this._sendBtn.style.padding = "6px 14px";
		this._sendBtn.style.borderRadius = "4px";
		this._sendBtn.style.border = "none";
		this._sendBtn.style.background = "var(--vscode-button-background)";
		this._sendBtn.style.color = "var(--vscode-button-foreground)";
		this._sendBtn.style.cursor = "pointer";
		this._sendBtn.style.fontFamily = "var(--vscode-font-family)";

		// Log buttons
		this._logBtns = append(this._container, $(".codeai-log-buttons"));
		this._logBtns.style.display = "flex";
		this._logBtns.style.gap = "8px";
		this._logBtns.style.padding = "4px 12px 8px";
		this._logBtns.style.flexShrink = "0";

		const planBtn = append(this._logBtns, $("button")) as HTMLButtonElement;
		planBtn.textContent = "View Plan Log";
		planBtn.style.fontSize = "11px";
		planBtn.style.cursor = "pointer";
		planBtn.style.background = "transparent";
		planBtn.style.color = "var(--vscode-textLink-foreground)";
		planBtn.style.border = "none";
		planBtn.style.textDecoration = "underline";

		const changesBtn = append(this._logBtns, $("button")) as HTMLButtonElement;
		changesBtn.textContent = "View Changes Log";
		changesBtn.style.fontSize = "11px";
		changesBtn.style.cursor = "pointer";
		changesBtn.style.background = "transparent";
		changesBtn.style.color = "var(--vscode-textLink-foreground)";
		changesBtn.style.border = "none";
		changesBtn.style.textDecoration = "underline";

		// ── Event listeners ─────────────────────────────────────────────────

		this._disposables.add({
			dispose: () => {
				this._sendBtn.removeEventListener("click", this._onSendClick);
				this._inputEl.removeEventListener("keydown", this._onInputKeyDown);
				planBtn.removeEventListener("click", this._onPlanClick);
				changesBtn.removeEventListener("click", this._onChangesClick);
			},
		});

		this._onSendClick = this._onSendClick.bind(this);
		this._onInputKeyDown = this._onInputKeyDown.bind(this);
		this._onPlanClick = this._onPlanClick.bind(this);
		this._onChangesClick = this._onChangesClick.bind(this);

		this._sendBtn.addEventListener("click", this._onSendClick);
		this._inputEl.addEventListener("keydown", this._onInputKeyDown);
		planBtn.addEventListener("click", this._onPlanClick);
		changesBtn.addEventListener("click", this._onChangesClick);
	}

	// ── Event handlers ──────────────────────────────────────────────────────

	private _onSendClick(): void {
		this.sendMessage();
	}

	private _onInputKeyDown(e: KeyboardEvent): void {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this.sendMessage();
		}
	}

	private async _onPlanClick(): Promise<void> {
		const content = await this.codeaiLogService.readPlan();
		this.showLogOverlay("Plan Log", content);
	}

	private async _onChangesClick(): Promise<void> {
		const content = await this.codeaiLogService.readChanges();
		this.showLogOverlay("Changes Log", content);
	}

	// ── Message handling ────────────────────────────────────────────────────

	private async sendMessage(): Promise<void> {
		const text = this._inputEl.value.trim();
		if (!text) {
			return;
		}
		this._inputEl.value = "";
		this.appendBubble("user", text);
		this.orchestrator.addUserMessage(text);

		// Determine if this looks like a code-edit request
		const isCodeEdit =
			/\b(edit|change|fix|refactor|modify|update|rewrite|add|remove|delete|implement)\b/i.test(
				text,
			);

		// Show thinking indicator
		const assistantBubble = this.appendBubble("assistant", "");
		const thinkingHtml = sanitizeHtml(
			'<span style="opacity: 0.6; font-style: italic;"> Thinking...</span>',
			{
				allowedTags: { augment: ["span"] },
				allowedAttributes: { augment: ["style"] },
			},
		);
		assistantBubble.innerHTML = thinkingHtml as unknown as string;
		let accumulated = "";
		let hasReceivedFirstToken = false;

		const callbacks: IStreamCallbacks = {
			onText: (chunk: string) => {
				if (!hasReceivedFirstToken) {
					hasReceivedFirstToken = true;
					this.logService.info(
						"[CodeAI] First token received, starting stream",
					);
				}
				accumulated += chunk;
				this.renderMessageContent(assistantBubble, accumulated);
				this.scrollToBottom();
			},
			onFinalMessage: (full: string) => {
				this.logService.info("[CodeAI] Final message received");
				this.renderMessageContent(assistantBubble, full);
				this.scrollToBottom();
			},
			onError: (err: Error) => {
				assistantBubble.textContent = `Error: ${err.message}`;
				assistantBubble.style.color = "var(--vscode-errorForeground)";
			},
		};

		try {
			if (isCodeEdit) {
				await this.orchestrator.runCodeEdit(text, callbacks);
			} else {
				await this.orchestrator.runChat(text, callbacks);
			}
		} catch (err) {
			this.logService.error(`[CodeAI] Chat error:`, err);
			assistantBubble.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
			assistantBubble.style.color = "var(--vscode-errorForeground)";
		}
	}

	private appendBubble(
		role: "user" | "assistant",
		content: string,
	): HTMLElement {
		const bubble = append(
			this._messagesEl,
			$(`.codeai-bubble.codeai-bubble-${role}`),
		);
		if (role === "user") {
			bubble.textContent = content;
		} else {
			this.renderMessageContent(bubble, content);
		}
		bubble.style.padding = "6px 10px";
		bubble.style.marginBottom = "6px";
		bubble.style.borderRadius = "6px";
		bubble.style.maxWidth = "90%";
		bubble.style.whiteSpace = "pre-wrap";
		bubble.style.wordBreak = "break-word";
		bubble.style.fontSize = "var(--vscode-font-size)";

		if (role === "user") {
			bubble.style.background = "var(--vscode-button-background)";
			bubble.style.color = "var(--vscode-button-foreground)";
			bubble.style.alignSelf = "flex-end";
			bubble.style.marginLeft = "auto";
		} else {
			bubble.style.background = "var(--vscode-editor-background)";
			bubble.style.color = "var(--vscode-editor-foreground)";
			bubble.style.border = "1px solid var(--vscode-panel-border)";
		}

		this.scrollToBottom();
		return bubble;
	}

	private scrollToBottom(): void {
		this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
	}

	private renderMessageContent(bubble: HTMLElement, content: string): void {
		// Clear existing content
		clearNode(bubble);

		this.logService.info(
			`[CodeAI] Rendering content (${content.length} chars)`,
		);

		// Parse <think>...</think> tags (case-insensitive, multiline)
		const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
		const parts: Array<{ type: "think" | "text"; content: string }> = [];
		let lastIndex = 0;
		let match;

		while ((match = thinkRegex.exec(content)) !== null) {
			this.logService.info(`[CodeAI] Found <think> tag at ${match.index}`);

			// Add text before <think>
			if (match.index > lastIndex) {
				const textBefore = content.substring(lastIndex, match.index);
				if (textBefore.trim()) {
					parts.push({ type: "text", content: textBefore });
				}
			}

			// Add <think> content
			const thinkContent = match[1].trim();
			if (thinkContent) {
				this.logService.info(
					`[CodeAI] Think content: ${thinkContent.length} chars`,
				);
				parts.push({ type: "think", content: thinkContent });
			}

			lastIndex = thinkRegex.lastIndex;
		}

		// Add remaining text after last <think>
		if (lastIndex < content.length) {
			const remaining = content.substring(lastIndex).trim();
			if (remaining) {
				parts.push({ type: "text", content: remaining });
			}
		}

		// If no parts were found, treat entire content as text
		if (parts.length === 0 && content.trim()) {
			parts.push({ type: "text", content: content });
		}

		this.logService.info(`[CodeAI] Parsed ${parts.length} parts`);

		// Render each part
		for (const part of parts) {
			if (part.type === "think") {
				this.renderThinkingSection(bubble, part.content);
			} else {
				this.renderMarkdownSection(bubble, part.content);
			}
		}
	}

	private renderThinkingSection(container: HTMLElement, content: string): void {
		// Create collapsible accordion for thinking
		const accordion = append(container, $(".codeai-think-accordion"));
		accordion.style.margin = "8px 0";
		accordion.style.border = "1px solid var(--vscode-textBlockQuote-border)";
		accordion.style.borderRadius = "4px";
		accordion.style.overflow = "hidden";

		// Header (clickable)
		const header = append(accordion, $(".codeai-think-header"));
		header.style.display = "flex";
		header.style.alignItems = "center";
		header.style.padding = "8px 12px";
		header.style.background = "var(--vscode-textBlockQuote-background)";
		header.style.cursor = "pointer";
		header.style.userSelect = "none";
		header.style.fontWeight = "bold";
		header.style.fontSize = "12px";

		const icon = append(header, $("span"));
		icon.textContent = "▶";
		icon.style.marginRight = "6px";
		icon.style.transition = "transform 0.2s";
		icon.style.display = "inline-block";

		const title = append(header, $("span"));
		title.textContent = "💭 Thinking Process";

		// Content (collapsible)
		const contentEl = append(accordion, $(".codeai-think-content"));
		contentEl.style.display = "none";
		contentEl.style.padding = "12px";
		contentEl.style.background = "var(--vscode-editor-background)";
		contentEl.style.borderTop = "1px solid var(--vscode-textBlockQuote-border)";
		contentEl.style.fontFamily = "var(--vscode-editor-font-family)";
		contentEl.style.fontSize = "13px";
		contentEl.style.whiteSpace = "pre-wrap";
		contentEl.style.opacity = "0.85";
		contentEl.textContent = content;

		// Toggle functionality
		let isExpanded = false;
		header.addEventListener("click", () => {
			isExpanded = !isExpanded;
			contentEl.style.display = isExpanded ? "block" : "none";
			icon.style.transform = isExpanded ? "rotate(90deg)" : "rotate(0deg)";
			icon.textContent = isExpanded ? "▼" : "▶";
		});
	}

	private renderMarkdownSection(container: HTMLElement, content: string): void {
		// Render markdown content
		const mdContainer = append(container, $(".codeai-markdown"));
		mdContainer.style.margin = "8px 0";
		mdContainer.style.lineHeight = "1.6";

		try {
			const rendered = renderMarkdown(
				{ value: content },
				{
					sanitizerConfig: {
						allowedTags: {
							override: [
								"p",
								"strong",
								"em",
								"code",
								"pre",
								"a",
								"ul",
								"ol",
								"li",
								"blockquote",
								"h1",
								"h2",
								"h3",
								"h4",
								"h5",
								"h6",
								"br",
								"hr",
								"table",
								"thead",
								"tbody",
								"tr",
								"th",
								"td",
								"span",
								"div",
							],
						},
					},
				},
			);
			mdContainer.appendChild(rendered.element);
		} catch (err) {
			// Fallback to plain text if markdown rendering fails
			mdContainer.textContent = content;
		}
	}

	// ── Log overlay ─────────────────────────────────────────────────────────

	private showLogOverlay(title: string, content: string): void {
		const overlay = append(this._container, $(".codeai-log-overlay"));
		overlay.style.position = "absolute";
		overlay.style.inset = "0";
		overlay.style.background = "var(--vscode-editor-background)";
		overlay.style.zIndex = "100";
		overlay.style.display = "flex";
		overlay.style.flexDirection = "column";
		overlay.style.overflow = "hidden";

		const hdr = append(overlay, $(".codeai-log-overlay-header"));
		hdr.style.display = "flex";
		hdr.style.justifyContent = "space-between";
		hdr.style.alignItems = "center";
		hdr.style.padding = "8px 12px";
		hdr.style.borderBottom = "1px solid var(--vscode-panel-border)";

		const titleEl = append(hdr, $("span"));
		titleEl.textContent = `${CODEAI_VIEW_TITLE} — ${title}`;
		titleEl.style.fontWeight = "bold";

		const closeBtn = append(hdr, $("button")) as HTMLButtonElement;
		closeBtn.textContent = "Close";
		closeBtn.style.cursor = "pointer";
		closeBtn.style.background = "var(--vscode-button-background)";
		closeBtn.style.color = "var(--vscode-button-foreground)";
		closeBtn.style.border = "none";
		closeBtn.style.borderRadius = "4px";
		closeBtn.style.padding = "4px 10px";
		closeBtn.addEventListener("click", () => {
			clearNode(overlay);
			overlay.remove();
		});

		const body = append(overlay, $("pre.codeai-log-body"));
		body.textContent = content || "(empty)";
		body.style.flex = "1";
		body.style.overflow = "auto";
		body.style.padding = "12px";
		body.style.margin = "0";
		body.style.whiteSpace = "pre-wrap";
		body.style.fontSize = "var(--vscode-font-size)";
		body.style.fontFamily = "var(--vscode-editor-font-family)";
	}
}
