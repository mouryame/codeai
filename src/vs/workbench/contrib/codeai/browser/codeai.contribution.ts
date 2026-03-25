/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from "../../../../nls.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import {
	InstantiationType,
	registerSingleton,
} from "../../../../platform/instantiation/common/extensions.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { registerIcon } from "../../../../platform/theme/common/iconRegistry.js";
import { Codicon } from "../../../../base/common/codicons.js";
import { ViewPaneContainer } from "../../../browser/parts/views/viewPaneContainer.js";
import {
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
	Extensions as ViewContainerExtensions,
} from "../../../common/views.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import {
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
	Extensions as WorkbenchExtensions,
} from "../../../common/contributions.js";
import { LifecyclePhase } from "../../../services/lifecycle/common/lifecycle.js";

// ── Service interfaces ──────────────────────────────────────────────────────
import {
	ICascadeOrchestrator,
	IEditCodeService,
	ILocalModelsService,
	ICodebaseIndexService,
	IRetrievalService,
	IMemoryService,
	IAgenticOrchestrator,
} from "../common/codeai.js";
import { ICodeAILogService } from "../common/logService.js";
import { ICodebaseContextService } from "../services/codebaseContext.js";

// ── Service implementations ─────────────────────────────────────────────────
import { LocalModelsService } from "../services/localModelsService.js";
import { CascadeOrchestrator } from "../services/cascadeOrchestrator.js";
import { EditCodeService } from "../edit/editCodeService.js";
import { CodeAILogService } from "../common/logService.js";
import { CodebaseContextService } from "../services/codebaseContext.js";
import { CodebaseIndexService } from "../services/codebaseIndexService.js";
import { RetrievalService } from "../services/retrievalService.js";
import { MemoryService } from "../services/memoryService.js";
import { IndexWatcherService } from "../services/indexWatcherService.js";
import { AutonomousOrchestrator } from "../services/autonomousOrchestrator.js";

// ── View Pane ───────────────────────────────────────────────────────────────
import { CodeAIViewPane } from "./codeaiViewPane.js";

// ── Register singletons ─────────────────────────────────────────────────────

registerSingleton(
	ILocalModelsService,
	LocalModelsService,
	InstantiationType.Delayed,
);
registerSingleton(
	ICascadeOrchestrator,
	CascadeOrchestrator,
	InstantiationType.Delayed,
);
registerSingleton(IEditCodeService, EditCodeService, InstantiationType.Delayed);
registerSingleton(
	ICodeAILogService,
	CodeAILogService,
	InstantiationType.Delayed,
);
registerSingleton(
	ICodebaseContextService,
	CodebaseContextService,
	InstantiationType.Delayed,
);
registerSingleton(
	ICodebaseIndexService,
	CodebaseIndexService,
	InstantiationType.Delayed,
);
registerSingleton(
	IRetrievalService,
	RetrievalService,
	InstantiationType.Delayed,
);
registerSingleton(IMemoryService, MemoryService, InstantiationType.Delayed);
registerSingleton(
	IAgenticOrchestrator,
	AutonomousOrchestrator,
	InstantiationType.Delayed,
);

// ── View Container & View Registration ──────────────────────────────────────

const codeaiViewIcon = registerIcon(
	"codeai-view-icon",
	Codicon.sparkle,
	localize("codeaiViewIcon", "View icon of the CodeAI view."),
);

const CODEAI_VIEW_CONTAINER_ID = "workbench.view.codeai";
const CODEAI_VIEW_ID = "workbench.view.codeai.chat";

const viewContainer = Registry.as<IViewContainersRegistry>(
	ViewContainerExtensions.ViewContainersRegistry,
).registerViewContainer(
	{
		id: CODEAI_VIEW_CONTAINER_ID,
		title: localize2("codeai", "\u26A1 CodeAI (Local)"),
		icon: codeaiViewIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			CODEAI_VIEW_CONTAINER_ID,
			{ mergeViewWithContainerWhenSingleView: true },
		]),
		storageId: CODEAI_VIEW_CONTAINER_ID,
		hideIfEmpty: false,
		order: 10,
	},
	ViewContainerLocation.AuxiliaryBar,
	{ isDefault: false, doNotRegisterOpenCommand: true },
);

Registry.as<IViewsRegistry>(
	ViewContainerExtensions.ViewsRegistry,
).registerViews(
	[
		{
			id: CODEAI_VIEW_ID,
			name: localize2("codeaiChat", "\u26A1 CodeAI (Local)"),
			containerIcon: codeaiViewIcon,
			canToggleVisibility: true,
			canMoveView: true,
			ctorDescriptor: new SyncDescriptor(CodeAIViewPane),
		},
	],
	viewContainer,
);

// ── Workbench Contribution: bootstrap models on startup ─────────────────────

class CodeAIStartupContribution
	extends Disposable
	implements IWorkbenchContribution
{
	constructor(
		@ILocalModelsService private readonly modelsService: ILocalModelsService,
		@ICodebaseIndexService private readonly indexService: ICodebaseIndexService,
	) {
		super();
		this.initModels();
		this.initIndex();
		this.initFileWatcher();
	}

	private async initModels(): Promise<void> {
		try {
			await this.modelsService.loadModels();
		} catch (err) {
			// Log but do not crash — models may not be present on disk yet.
			console.error("[CodeAI] Failed to load models on startup:", err);
		}
	}

	private async initIndex(): Promise<void> {
		try {
			// Build index in background
			setTimeout(() => {
				this.indexService.buildIndex().catch((err) => {
					console.error("[CodeAI] Failed to build index:", err);
				});
			}, 2000); // Delay 2s to avoid blocking startup
		} catch (err) {
			console.error("[CodeAI] Failed to initialize index:", err);
		}
	}

	private initFileWatcher(): void {
		try {
			// File watcher will be instantiated via DI when needed
			// The IndexWatcherService is registered as a contribution below
		} catch (err) {
			console.error("[CodeAI] Failed to initialize file watcher:", err);
		}
	}
}

class CodeAIFileWatcherContribution
	extends Disposable
	implements IWorkbenchContribution
{
	constructor(@ICodebaseIndexService indexService: ICodebaseIndexService) {
		super();
		// Instantiate watcher service (it will auto-start watching)
		this._register(
			new IndexWatcherService(
				indexService as any,
				undefined as any,
				undefined as any,
				undefined as any,
			),
		);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(
	WorkbenchExtensions.Workbench,
).registerWorkbenchContribution(
	CodeAIStartupContribution,
	LifecyclePhase.Restored,
);

Registry.as<IWorkbenchContributionsRegistry>(
	WorkbenchExtensions.Workbench,
).registerWorkbenchContribution(
	CodeAIFileWatcherContribution,
	LifecyclePhase.Eventually,
);
