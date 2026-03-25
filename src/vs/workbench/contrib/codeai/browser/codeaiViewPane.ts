/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IViewPaneOptions,
	ViewPane,
} from "../../../browser/parts/views/viewPane.js";
import { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { IContextKeyService } from "../../../../platform/contextkey/common/contextkey.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IViewDescriptorService } from "../../../common/views.js";
import { IOpenerService } from "../../../../platform/opener/common/opener.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { IHoverService } from "../../../../platform/hover/browser/hover.js";
import { SidebarChat } from "./sidebarChat.js";
import { PlanProgress } from "./planProgress.js";
import { $ } from "../../../../base/browser/dom.js";

export class CodeAIViewPane extends ViewPane {
	private _sidebarChat: SidebarChat | undefined;
	private _planProgress: PlanProgress | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService
		protected override readonly instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService,
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.style.display = "flex";
		container.style.flexDirection = "column";
		container.style.height = "100%";
		container.style.position = "relative";

		// Plan progress widget at the top
		const planContainer = $("div.codeai-plan-container");
		container.appendChild(planContainer);
		this._planProgress = this.instantiationService.createInstance(
			PlanProgress,
			planContainer,
		);
		this._register(this._planProgress);

		// Chat panel fills the rest
		const chatContainer = $("div.codeai-chat-container");
		chatContainer.style.flex = "1";
		chatContainer.style.display = "flex";
		chatContainer.style.flexDirection = "column";
		chatContainer.style.overflow = "hidden";
		container.appendChild(chatContainer);
		this._sidebarChat = this.instantiationService.createInstance(
			SidebarChat,
			chatContainer,
		);
		this._register(this._sidebarChat);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}
