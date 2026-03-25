# ⚡ CodeAI (Local) — Offline AI Coding Assistant

**CodeAI** is a fully offline, self-contained AI coding assistant integrated into VS Code:. It uses local GGUF models via llama-server with no external providers, automatic logging, memory-aware model management, and Cascade-style orchestration.

---

## 🎯 Features

- **Fully Offline**: No API keys, no cloud providers — all inference runs locally via llama-server
- **Dual Model Architecture**: Reasoning model + Coding model with automatic routing
- **Memory-Aware**: Dynamically loads/unloads models based on system memory pressure (85% threshold)
- **Context-Aware**: Automatic thread pruning to stay within model context windows
- **Auditable**: All plans and code changes logged to `.codeai/logs/`
- **Cascade Orchestration**: Phase-based workflow (understanding → planning → reading → applying → completed)
- **Streaming Support**: Real-time token-by-token generation with abort signals
- **Embedded Configuration**: Edit model paths and parameters directly in `modelsConfig.ts`
- **Thinking Process UI**: Collapsible accordion for ` ...` tags in responses
- **Codebase Context**: Automatic inclusion of open files and workspace structure in prompts

---

## 📁 Complete Directory Structure

```
src/vs/workbench/contrib/codeai/
├── browser/
│   ├── codeai.contribution.ts    # Main entry point, service registration, view registration
│   ├── codeaiViewPane.ts         # View pane container (combines plan + chat)
│   ├── sidebarChat.ts            # Chat UI component with streaming, thinking UI, log buttons
│   └── planProgress.ts           # Plan progress widget with phase indicators
├── common/
│   ├── codeai.ts                 # Service interfaces, types, constants
│   ├── modelsConfig.ts           # Embedded model configuration (EDIT THIS)
│   └── logService.ts             # Logging service for changes.md and plan.md
├── services/
│   ├── localModelsService.ts     # Model lifecycle and memory management
│   ├── localModelRunner.ts       # GGUF inference via llama-server HTTP API
│   ├── cascadeOrchestrator.ts    # Phase tracking, routing, thread management, logging
│   ├── codebaseContext.ts        # Workspace and open files context gathering
│   └── node-llama-cpp.d.ts       # Type declarations for optional dependency
├── edit/
│   └── editCodeService.ts        # Fast/slow apply, diff zones
├── test-inference.cjs            # Diagnostic script to verify setup
└── README.md                     # This file
```

---

## 🚀 Quick Start

### 1. Install llama.cpp Server

**macOS:**

```bash
brew install llama.cpp
```

**Linux (build from source):**

```bash
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp && make
sudo cp llama-server /usr/local/bin/
```

**Verify installation:**

```bash
llama-server --version
```

### 2. Configure Models

Edit `src/vs/workbench/contrib/codeai/common/modelsConfig.ts`:

```typescript
export const modelsConfig: IModelsConfig = {
	models: [
		{
			id: "reasoning-model",
			path: "/path/to/your/reasoning.gguf",
			role: "reasoning",
			contextWindow: 32768,
			maxTokens: 4096,
			temperature: 0.7,
			threads: 4,
			serverPort: 8080, // ← llama-server port for reasoning
		},
		{
			id: "coding-model",
			path: "/path/to/your/coding.gguf",
			role: "coding",
			contextWindow: 32768,
			maxTokens: 4096,
			temperature: 0.2,
			threads: 4,
			serverPort: 8081, // ← llama-server port for coding
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
```

### 3. Start Model Servers

**Terminal 1 - Reasoning Model:**

```bash
llama-server -m "/path/to/reasoning.gguf" --port 8080 -c 32768
```

**Terminal 2 - Coding Model:**

```bash
llama-server -m "/path/to/coding.gguf" --port 8081 -c 32768
```

### 4. Build VS Code:

```bash
npm run compile
```

### 5. Launch:

```bash
./scripts/code.sh
```

### 6. Open CodeAI:

- **View → Appearance → Auxiliary Bar** (or `Cmd+Opt+B` on macOS)
- Look for **⚡ CodeAI (Local)** in the sidebar

---

## 🧠 Architecture

### Service Layer

#### `ILocalModelsService` (`localModelsService.ts`)

**Purpose**: Manages model lifecycle and memory pressure.

**Key Methods:**

- `loadModels()` - Loads all configured models from `modelsConfig.ts`
- `getModelByRole(role)` - Returns runner for 'reasoning' or 'coding'
- `getMemoryUsage()` - Returns 0-1 ratio of memory pressure
- `ensureMemoryBudget(role)` - Unloads opposite role model if pressure > 85%
- `updateConfig(newConfig)` - Hot-reload configuration at runtime

**Memory Management:**

```typescript
const MEMORY_PRESSURE_THRESHOLD = 0.85;
// Uses process.memoryUsage().rss / 16GB baseline in Node.js
// Falls back to performance.memory API in browser
```

#### `ILocalModelRunner` (`localModelRunner.ts`)

**Purpose**: Dispatches generation requests to llama-server via HTTP.

**Key Methods:**

- `load()` - Health check to llama-server /health endpoint
- `generate(request, callbacks)` - Streaming generation via /completion endpoint
- `abort()` - Cancel in-flight request via AbortController
- `unload()` - Release resources

**HTTP Endpoints Used:**

- `GET  /health` - Server health check
- `POST /completion` - Streaming text generation with JSON lines format

**Request Format:**

```json
{
	"prompt": "...",
	"n_predict": 4096,
	"temperature": 0.7,
	"stream": true
}
```

**Response Format (streaming):**

```
data: {"content": "Hello"}
data: {"content": " world"}
data: {"stop": true}
```

#### `ICascadeOrchestrator` (`cascadeOrchestrator.ts`)

**Purpose**: Routes tasks to correct model, manages thread state, phases, and logging.

**Cascade Phases:**

1. `understanding` - Initial user message analysis
2. `planning` - Reasoning model creates action plan
3. `reading` - Reading relevant code context
4. `applying` - Coding model generates/edits code
5. `completed` - Task finished

**Thread Management:**

- Token estimation: `Math.ceil(text.length / 4)` (≈4 chars per token)
- Automatic pruning when thread exceeds 90% of context window
- Removes oldest messages first

**System Prompts:**

- **Planning**: `"You are a planning assistant. Wrap your reasoning in  ... tags, then provide clear, actionable steps in markdown format."`
- **Code Edit**: `"You are a code editing assistant. Produce only the changed code."`
- **Chat**: `"You are CodeAI, a helpful local AI coding assistant. When reasoning through problems, wrap your thinking process in  ... tags. After your thinking, provide your final response in clear markdown format."`

**Key Methods:**

- `runPlanning(prompt, callbacks)` → reasoning model
- `runCodeEdit(prompt, callbacks)` → coding model
- `runChat(prompt, callbacks)` → reasoning model
- `addUserMessage(content)` - Adds to thread with pruning
- `clearThread()` - Resets thread and plan steps

#### `ICodebaseContextService` (`codebaseContext.ts`)

**Purpose**: Gathers workspace context for prompts.

**Key Methods:**

- `getOpenFilesContext()` - Returns content of up to 5 open files (skips files >50KB)
- `getFileContext(uri)` - Gets specific file content
- `getWorkspaceStructure()` - Returns folder names

**Context Format:**

````markdown
## Workspace

Folders: project-name

## Currently Open Files

### File: src/main.ts

```typescript
// ... file content ...
```
````

````

#### `IEditCodeService` (`editCodeService.ts`)

**Purpose**: Applies code changes with audit logging.

**Modes:**
- **Fast Apply**: Search/replace within file
- **Slow Apply**: Full rewrite via coding model

**Key Methods:**
- `fastApply(filePath, oldText, newText, description)` - Precise edit
- `slowApply(filePath, prompt, description, callbacks)` - AI-generated rewrite
- `getDiffZones(filePath)` - Returns tracked changes for UI

#### `ICodeAILogService` (`logService.ts`)

**Purpose**: Writes timestamped entries to workspace logs.

**Log Locations:**
- `.codeai/logs/changes.md` - All code edits
- `.codeai/logs/plan.md` - All plans and chat

**Entry Format:**
```markdown
## [2026-03-25T14:30:00.000Z]

**Planning** — Task description

Plan content...
````

### UI Layer

#### `CodeAIViewPane` (`codeaiViewPane.ts`)

- Extends VS Code:'s `ViewPane`
- Container that hosts `PlanProgress` (top) and `SidebarChat` (bottom)
- Registered in AuxiliaryBar (right sidebar)
- View ID: `workbench.view.codeai.chat`

#### `SidebarChat` (`sidebarChat.ts`)

**Components:**

- Header with title
- Messages area (scrollable, flex: 1)
- Input textarea (auto-resize, Enter to send, Shift+Enter for newline)
- Send button
- Log buttons ("View Plan Log", "View Changes Log")

**Features:**

- Streaming token display in real-time
- ` ...` parsing with collapsible accordion UI
- Markdown rendering with syntax highlighting
- Auto-scroll to bottom on new messages
- Log overlay modal for viewing .codeai/logs/ contents

**Intent Detection:**

```typescript
const isCodeEdit =
	/\b(edit|change|fix|refactor|modify|update|rewrite|add|remove|delete|implement)\b/i.test(
		text,
	);
```

**Message Bubbles:**

- User: Right-aligned, button background
- Assistant: Left-aligned, editor background with border

**Thinking Accordion:**

- Collapsed by default (shows ▶ icon)
- Click to expand (shows ▼ icon with rotated animation)
- Uses `var(--vscode-textBlockQuote-background)` for styling

#### `PlanProgress` (`planProgress.ts`)

**Components:**

- Title: "⚡ CodeAI (Local) — Plan Progress"
- Phase indicator with emoji icons
- Steps list with status icons

**Phase Icons:**

- `understanding`: 🔍 Understanding
- `planning`: 📋 Planning
- `reading`: 📖 Reading
- `applying`: ✏️ Applying
- `completed`: ✅ Completed

**Step Status Icons:**

- `pending`: ○
- `in_progress`: ◑
- `completed`: ●
- `failed`: ✕

---

## 📊 Memory Management

CodeAI monitors system memory and automatically unloads models when pressure exceeds 85%:

```typescript
// Memory estimation logic
if (nodeProcess?.memoryUsage) {
	return mem.rss / (16 * 1024 * 1024 * 1024); // 16GB baseline
}
// Browser fallback
return performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;
```

**Unload Strategy:**

- When loading reasoning model → unloads coding model if memory > 85%
- When loading coding model → unloads reasoning model if memory > 85%

---

## 📝 Logging System

All operations logged to `.codeai/logs/` in workspace root:

### `changes.md`

````markdown
# CodeAI Log

## [2026-03-25T14:30:00.000Z]

**Fast Apply** — `src/file.ts`

Description

```diff
- old line
+ new line
```
````

````

### `plan.md`

```markdown
# CodeAI Log

## [2026-03-25T14:30:00.000Z]

**Planning** — Task description

Plan content with reasoning...
````

---

## 🔧 Configuration Reference

### `IModelConfig` Interface

```typescript
interface IModelConfig {
	readonly id: string; // Unique identifier
	readonly path: string; // Path to .gguf file
	readonly role: "reasoning" | "coding"; // Model purpose
	readonly contextWindow: number; // Max tokens in context (e.g., 32768)
	readonly maxTokens: number; // Max tokens to generate (e.g., 4096)
	readonly temperature: number; // Randomness 0-1 (reasoning: 0.7, coding: 0.2)
	readonly threads: number; // CPU threads for inference
	readonly serverPort?: number; // llama-server port (8080, 8081)
	readonly mlxOptions?: IMLXOptions; // Unused (reserved)
}
```

### `IRoutingConfig` Interface

```typescript
interface IRoutingConfig {
	readonly planning: string; // Model ID for planning tasks
	readonly tool_selection: string; // Model ID for tool decisions
	readonly code_generation: string; // Model ID for code generation
	readonly code_editing: string; // Model ID for code editing
	readonly general_chat: string; // Model ID for general chat
}
```

---

## 🧪 Verification & Testing

### Diagnostic Script

```bash
node src/vs/workbench/contrib/codeai/test-inference.cjs
```

Checks:

1. GGUF model file exists
2. MLX model directory exists (optional)
3. node-llama-cpp availability (optional)
4. mlx-lm Python package (optional)

### Manual Testing Checklist

1. **Start llama-server** instances on ports 8080 and 8081
2. **Build VS Code::** `npm run compile`
3. **Launch:** `./scripts/code.sh`
4. **Open Auxiliary Bar** (Cmd+Opt+B)
5. **Send test message**: "Explain this codebase"
6. **Verify streaming**: Tokens appear one-by-one
7. **Test thinking UI**: Ask a reasoning question, verify accordion appears
8. **Test code edit**: Say "Add a comment to the top of file.ts"
9. **Check logs**: Click "View Plan Log" and "View Changes Log"

### Type Checking

```bash
npm run compile-check-ts-native
```

### Layer Validation

```bash
npm run valid-layers-check
```

---

## 🐛 Troubleshooting

### Models Not Loading

**Symptom**: Console shows `[CodeAI] Failed to load models on startup`

**Fix**:

1. Verify paths in `modelsConfig.ts` point to valid .gguf files
2. Ensure llama-server is running on configured ports
3. Check server health: `curl http://localhost:8080/health`

### llama-server Connection Failed

**Symptom**: `[CodeAI] llama-server connection failed`

**Fix**:

```bash
# Start server manually to see errors
llama-server -m "/path/to/model.gguf" --port 8080 -c 32768

# Test with curl
curl http://localhost:8080/health
curl -X POST http://localhost:8080/completion \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "n_predict": 10}'
```

### No Streaming Output

**Symptom**: Chat shows full response at once instead of token-by-token

**Fix**:

- Verify llama-server is running with streaming support
- Check browser console for XMLHttpRequest errors
- Ensure `stream: true` is in the request

### High Memory Usage

**Symptom**: IDE becomes sluggish

**Fix**:

- CodeAI auto-unloads at 85% threshold (check console for warnings)
- Reduce `contextWindow` in `modelsConfig.ts`
- Use smaller quantized models (Q4_K_M instead of Q8_0)
- Run only one llama-server if needed

### Build Errors

**Symptom**: TypeScript compilation fails

**Fix**:

```bash
# Clean build
npm run compile

# If errors in CodeAI files:
# 1. Check import paths use .js extensions
# 2. Verify service registrations in codeai.contribution.ts
# 3. Check for missing dependencies in package.json
```

---

## 🔒 Security & Privacy

- **No Telemetry**: CodeAI does not send any data to external servers
- **Local Inference**: All model execution happens via local llama-server
- **Audit Trail**: Every change logged to `.codeai/logs/` for review
- **No API Keys**: No credentials required or stored
- **Workspace Isolation**: Logs written only to current workspace

---

## 🛠️ Development Guide

### Adding a New Service

1. **Define interface** in `common/codeai.ts`:

```typescript
export const IMyService = createDecorator<IMyService>("codeaiMyService");
export interface IMyService {
	readonly _serviceBrand: undefined;
	doSomething(): Promise<void>;
}
```

2. **Implement** in `services/myService.ts`:

```typescript
export class MyService extends Disposable implements IMyService {
	readonly _serviceBrand: undefined;
	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}
	async doSomething(): Promise<void> {
		// Implementation
	}
}
```

3. **Register** in `browser/codeai.contribution.ts`:

```typescript
registerSingleton(IMyService, MyService, InstantiationType.Delayed);
```

### Code Style

- **Indentation**: Tabs (per VS Code: guidelines)
- **Imports**: Use `.js` extensions
- **Comments**: JSDoc for public APIs
- **Strings**: Single quotes for internal, double quotes for user-facing
- **Copyright**: Include Microsoft header in all files

### Service Dependencies

Common dependency injection pattern:

```typescript
constructor(
    @ILocalModelsService private readonly modelsService: ILocalModelsService,
    @ICodeAILogService private readonly codeaiLogService: ICodeAILogService,
    @ILogService private readonly logService: ILogService,
    @IInstantiationService private readonly instantiationService: IInstantiationService,
) {
    super();
}
```

---

## 📚 API Reference

### Key Interfaces

#### `IGenerateRequest`

```typescript
interface IGenerateRequest {
	readonly prompt: string;
	readonly role: "reasoning" | "coding";
	readonly systemPrompt?: string;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly signal?: AbortSignal;
}
```

#### `IGenerateResult`

```typescript
interface IGenerateResult {
	readonly text: string;
	readonly tokensUsed: number;
	readonly modelId: string;
}
```

#### `IStreamCallbacks`

```typescript
interface IStreamCallbacks {
	onText?(chunk: string): void;
	onFinalMessage?(full: string): void;
	onError?(error: Error): void;
}
```

#### `IPlanStep`

```typescript
interface IPlanStep {
	readonly id: string;
	readonly description: string;
	readonly phase: CascadePhase;
	readonly status: "pending" | "in_progress" | "completed" | "failed";
	readonly timestamp: number;
}
```

#### `IEditOperation`

```typescript
interface IEditOperation {
	readonly filePath: string;
	readonly mode: "fast" | "slow";
	readonly oldText?: string;
	readonly newText: string;
	readonly description: string;
}
```

---

## 📖 Integration Points

### VS Code: Workbench Integration

**View Container Registration** (`codeai.contribution.ts:84-101`):

```typescript
Registry.as<IViewContainersRegistry>(...).registerViewContainer({
    id: CODEAI_VIEW_CONTAINER_ID,
    title: localize2("codeai", "⚡ CodeAI (Local)"),
    icon: codeaiViewIcon,
    // ...
}, ViewContainerLocation.AuxiliaryBar)
```

**View Registration** (`codeai.contribution.ts:103-117`):

```typescript
Registry.as<IViewsRegistry>(...).registerViews([{
    id: CODEAI_VIEW_ID,
    name: localize2("codeaiChat", "⚡ CodeAI (Local)"),
    ctorDescriptor: new SyncDescriptor(CodeAIViewPane),
}], viewContainer)
```

**Startup Contribution** (`codeai.contribution.ts:121-147`):

```typescript
class CodeAIStartupContribution extends Disposable implements IWorkbenchContribution {
    constructor(@ILocalModelsService private readonly modelsService: ILocalModelsService) {
        this.initModels();
    }
    private async initModels(): Promise<void> {
        await this.modelsService.loadModels();
    }
}
Registry.as<IWorkbenchContributionsRegistry>(...).registerWorkbenchContribution(
    CodeAIStartupContribution,
    LifecyclePhase.Restored,
)
```

---

## 🎉 Summary

**CodeAI** is a **fully offline, memory-aware, auditable** AI coding assistant built directly into VS Code:. It uses local llama-server instances for real GGUF inference with streaming support, automatic routing, context management, and comprehensive logging.

### Files by Purpose

| Purpose               | File                              |
| --------------------- | --------------------------------- |
| **Configuration**     | `common/modelsConfig.ts`          |
| **Entry Point**       | `browser/codeai.contribution.ts`  |
| **Chat UI**           | `browser/sidebarChat.ts`          |
| **Plan UI**           | `browser/planProgress.ts`         |
| **View Container**    | `browser/codeaiViewPane.ts`       |
| **Interfaces**        | `common/codeai.ts`                |
| **Logging**           | `common/logService.ts`            |
| **Orchestration**     | `services/cascadeOrchestrator.ts` |
| **Inference**         | `services/localModelRunner.ts`    |
| **Model Management**  | `services/localModelsService.ts`  |
| **Context**           | `services/codebaseContext.ts`     |
| **Code Editing**      | `edit/editCodeService.ts`         |
| **Type Declarations** | `services/node-llama-cpp.d.ts`    |
| **Diagnostics**       | `test-inference.cjs`              |

### What's Working

- ✅ Real GGUF inference via llama-server HTTP API
- ✅ Streaming token generation with XMLHttpRequest
- ✅ Memory-aware model loading/unloading (85% threshold)
- ✅ Automatic context pruning (90% threshold)
- ✅ Complete audit logging to `.codeai/logs/`
- ✅ Cascade phase tracking and UI
- ✅ Thinking process accordion UI for ` ` tags
- ✅ Codebase context (open files + workspace structure)
- ✅ Fast/slow code editing with diff tracking
- ✅ Cross-platform support (macOS, Linux via llama.cpp)

### Current Limitations

- Requires manual llama-server startup (two terminals)
- MLX inference not implemented (GGUF recommended for both roles)
- No tool/function calling yet
- No settings UI (edit `modelsConfig.ts` directly)

### Next Steps / Future Enhancements

1. **Auto-start llama-server**: Detect and spawn servers automatically
2. **Tool calling**: Add file system tools, search, grep
3. **Settings UI**: Visual configuration instead of editing TS
4. **Diff UI**: Show changes inline in editor
5. **Tests**: Unit and integration test coverage
6. **Model download**: Integrate with Hugging Face Hub

---

**License**: MIT (same as VS Code:)
**Maintainer**: Internal VS Code: Team
**Version**: 1.0.0-alpha
**Last Updated**: 2026-03-25
