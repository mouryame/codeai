# CodeAI Persistent Indexing & Retrieval System

## Overview

This document describes the persistent indexing and retrieval system that transforms CodeAI from shallow context awareness to deep codebase understanding with persistent memory.

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    User Query                                │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              CascadeOrchestrator                             │
│  - Routes queries to appropriate models                      │
│  - Manages conversation thread                               │
│  - Records changes to memory                                 │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│           CodebaseContextService                             │
│  - Builds enriched context using:                            │
│    1. Memory (project knowledge)                             │
│    2. Retrieved code chunks (relevant code)                  │
│    3. Open files (current context)                           │
│    4. Workspace structure                                    │
└────┬────────────────────┬───────────────────┬───────────────┘
     │                    │                   │
     ▼                    ▼                   ▼
┌──────────┐    ┌──────────────────┐   ┌─────────────┐
│ Memory   │    │ Retrieval        │   │ Index       │
│ Service  │    │ Service          │   │ Service     │
└──────────┘    └──────────────────┘   └─────────────┘
     │                    │                   │
     │                    │                   │
     ▼                    ▼                   ▼
┌──────────┐    ┌──────────────────┐   ┌─────────────┐
│.codeai/  │    │ Keyword Scoring  │   │ File        │
│memory.md │    │ + AI Re-ranking  │   │ Chunking    │
└──────────┘    └──────────────────┘   └─────────────┘
                         │                   │
                         └───────┬───────────┘
                                 ▼
                         ┌─────────────┐
                         │.codeai/     │
                         │index.json   │
                         └─────────────┘
```

## Services

### 1. CodebaseIndexService

**Purpose**: Builds and maintains a semantic index of the entire codebase.

**Key Features**:
- Scans workspace recursively (respects .gitignore patterns)
- Chunks files into semantic units:
  - Functions
  - Classes
  - Interfaces
  - Types
  - Logical blocks (~200-500 tokens)
- Stores metadata for each chunk:
  - File path
  - Symbol name
  - Type (function/class/etc)
  - Content
  - Line range
  - Token count
  - Keywords (for retrieval)
- Persists index to `.codeai/index.json`
- Skips large files (>100KB)
- Language-aware chunking for TypeScript, JavaScript, Python

**File**: `services/codebaseIndexService.ts`

**API**:
```typescript
interface ICodebaseIndexService {
  buildIndex(): Promise<void>;
  updateFile(filePath: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
  getFileChunks(filePath: string): ICodeChunk[];
  getStats(): { totalFiles: number; totalChunks: number; lastUpdated: number };
  isReady(): boolean;
  getAllFiles(): string[];
}
```

**Index Structure**:
```json
{
  "version": 1,
  "files": {
    "/path/to/file.ts": {
      "filePath": "/path/to/file.ts",
      "chunks": [
        {
          "id": "uuid",
          "filePath": "/path/to/file.ts",
          "symbolName": "myFunction",
          "type": "function",
          "content": "function myFunction() { ... }",
          "startLine": 10,
          "endLine": 25,
          "tokens": 150,
          "keywords": ["function", "myFunction", "return"]
        }
      ],
      "lastModified": 1234567890,
      "fileSize": 5000,
      "language": "typescript",
      "importanceScore": 1.3
    }
  },
  "totalChunks": 1500,
  "lastUpdated": 1234567890
}
```

### 2. RetrievalService

**Purpose**: Retrieves relevant code chunks using hybrid keyword + AI re-ranking.

**Retrieval Pipeline**:

1. **Keyword Scoring** (Fast, broad search):
   - Extract query terms
   - Score chunks based on:
     - Symbol name exact match (10.0)
     - Symbol name contains term (5.0)
     - File name match (3.0)
     - Keyword match (2.0)
     - Content frequency (0.5 per match, max 3.0)
   - Boost by chunk type (functions/classes: 1.2x)
   - Boost by file importance (src files: 1.1x)
   - Penalize large chunks (>1000 tokens: 0.8x)

2. **AI Re-ranking** (Precise, top 10 candidates):
   - Send top 10 candidates to reasoning model
   - Model selects most relevant chunks
   - Blend keyword score (30%) + AI ranking (70%)

**File**: `services/retrievalService.ts`

**API**:
```typescript
interface IRetrievalService {
  retrieve(query: IRetrievalQuery): Promise<IRetrievalResult[]>;
  getChunksByFile(filePath: string): Promise<ICodeChunk[]>;
  getChunksBySymbol(symbolName: string): Promise<ICodeChunk[]>;
}

interface IRetrievalQuery {
  query: string;
  maxResults?: number;      // Default: 20
  minScore?: number;        // Default: 0.1
  filePatterns?: string[];  // e.g., ["*.ts", "src/**"]
  excludePatterns?: string[]; // e.g., ["**/test/**"]
}

interface IRetrievalResult {
  chunk: ICodeChunk;
  score: number;
  reason?: string; // "keyword_match" or "ai_reranked"
}
```

### 3. MemoryService

**Purpose**: Maintains persistent project knowledge across sessions.

**Memory Structure**:
- **Project Summary**: High-level overview
- **Architecture Notes**: Key architectural decisions (max 20)
- **Key Files**: Important files and their purposes
- **Decisions**: Recent decisions with timestamps (max 10)
- **Recent Changes**: Change summaries (max 15)

**File**: `services/memoryService.ts`

**Storage**: `.codeai/memory.md` (Markdown format)

**API**:
```typescript
interface IMemoryService {
  getMemory(): Promise<IProjectMemory>;
  updateSummary(summary: string): Promise<void>;
  addArchitectureNote(note: string): Promise<void>;
  recordKeyFile(filePath: string, purpose: string): Promise<void>;
  addDecision(content: string, relatedFiles?: string[]): Promise<void>;
  recordChange(content: string, relatedFiles?: string[]): Promise<void>;
  getMemoryContext(): Promise<string>; // Formatted for prompts
  pruneMemory(maxTokens: number): Promise<void>;
}
```

**Memory Format** (`.codeai/memory.md`):
```markdown
# CodeAI Project Memory

_Version: 1 | Last Updated: 2026-03-25T14:30:00.000Z_

## Project Summary
This is a VS Code extension that provides...

## Architecture Notes
- Uses dependency injection via IInstantiationService
- Services are registered as singletons
- View layer uses ViewPane pattern

## Key Files
- `src/vs/workbench/contrib/codeai/browser/codeai.contribution.ts`: Main entry point
- `src/vs/workbench/contrib/codeai/services/cascadeOrchestrator.ts`: Orchestration logic

## Decisions

### [2026-03-25T14:30:00.000Z]
Decided to use llama-server instead of node-llama-cpp for better performance
_Related: services/localModelRunner.ts_

## Recent Changes

### [2026-03-25T15:00:00.000Z]
Added persistent indexing system for deep codebase understanding
_Related: services/codebaseIndexService.ts, services/retrievalService.ts_
```

### 4. IndexWatcherService

**Purpose**: Watches file changes and incrementally updates the index.

**Features**:
- Watches workspace for file changes
- Debounces updates (500ms)
- Handles:
  - File additions → index file
  - File updates → re-index file
  - File deletions → remove from index
- Only processes indexable file types

**File**: `services/indexWatcherService.ts`

### 5. ContextLogService

**Purpose**: Logs context retrieval operations for debugging and transparency.

**Features**:
- Logs each retrieval query
- Records which chunks were retrieved
- Includes scores and reasons
- Stored in `.codeai/context.md`

**File**: `services/contextLogService.ts`

**Log Format**:
```markdown
## [2026-03-25T14:30:00.000Z]

**Query:** How does the indexing system work?

**Retrieved 5 chunks:**

1. `services/codebaseIndexService.ts`
   - Score: 0.850
   - Reason: ai_reranked

2. `services/retrievalService.ts`
   - Score: 0.720
   - Reason: ai_reranked

---
```

## Integration with Existing System

### CodebaseContextService (Upgraded)

**New Methods**:
```typescript
// Get enriched context using retrieval
getEnrichedContext(query: string): Promise<string>

// Build full context (memory + retrieval + open files + workspace)
buildFullContext(query: string): Promise<string>
```

**Context Building Order** (Priority):
1. **Memory** (highest priority - persistent knowledge)
2. **Retrieved Code** (relevant chunks based on query)
3. **Open Files** (current working context)
4. **Workspace Structure** (folder overview)

### CascadeOrchestrator (Enhanced)

**Changes**:
- `buildCodebaseContext()` now takes query parameter
- Uses `codebaseContext.buildFullContext(query)` for enriched context
- Records changes to memory after code edits
- Passes user query to context builder for intelligent retrieval

**Before**:
```typescript
const context = workspace + openFiles;
```

**After**:
```typescript
const context = memory + retrievedCode + openFiles + workspace;
```

## Data Flow Example

### User Query: "How does authentication work?"

```
1. User sends query
   ↓
2. CascadeOrchestrator.runChat("How does authentication work?")
   ↓
3. CodebaseContextService.buildFullContext("How does authentication work?")
   ↓
4. Parallel context gathering:
   
   a) MemoryService.getMemoryContext()
      → Returns: "## Project Memory\n### Key Files\n- auth/authService.ts: Handles authentication..."
   
   b) RetrievalService.retrieve({ query: "How does authentication work?" })
      → Keyword scoring finds 50 candidates
      → AI re-ranks top 10
      → Returns top 5 chunks:
        - auth/authService.ts (score: 0.95)
        - auth/tokenManager.ts (score: 0.82)
        - middleware/authMiddleware.ts (score: 0.75)
   
   c) getOpenFilesContext()
      → Returns currently open files
   
   d) getWorkspaceStructure()
      → Returns folder names
   ↓
5. Context assembled:
   ```
   ## Project Memory
   [memory content]
   
   ## Retrieved Relevant Code
   ### Retrieved Code [1] - auth/authService.ts:15
   Symbol: authenticate | Type: function | Score: 0.95
   ```typescript
   async function authenticate(credentials) { ... }
   ```
   
   ## Currently Open Files
   [open files]
   
   ## Workspace
   Folders: my-project
   ```
   ↓
6. Full prompt sent to reasoning model:
   [system prompt]
   [thread history]
   [assembled context]
   [user query]
   ↓
7. Model generates response with deep understanding
   ↓
8. Response streamed to user
```

## Performance Characteristics

### Index Building
- **Initial build**: ~2-5 seconds for 1000 files
- **Incremental update**: <100ms per file
- **Memory usage**: ~50MB for 10,000 chunks

### Retrieval
- **Keyword search**: <50ms for 10,000 chunks
- **AI re-ranking**: ~500ms (depends on model)
- **Total retrieval**: ~550ms

### Memory Operations
- **Load memory**: <10ms
- **Save memory**: <50ms
- **Memory size**: ~10-50KB (auto-pruned to 2000 tokens)

## File Structure

```
.codeai/
├── index.json          # Codebase index (auto-generated)
├── memory.md           # Project memory (persistent)
├── context.md          # Context retrieval log (debug)
└── logs/
    ├── changes.md      # Code changes log
    └── plan.md         # Plans and chat log
```

## Configuration

### Index Settings (in `codebaseIndexService.ts`)
```typescript
const MAX_FILE_SIZE = 100 * 1024;  // Skip files >100KB
const MIN_CHUNK_LINES = 5;          // Minimum lines per chunk
const INDEX_VERSION = 1;            // Index format version
```

### Retrieval Settings (in `retrievalService.ts`)
```typescript
// Default query parameters
maxResults: 20        // Max chunks to return
minScore: 0.1         // Minimum relevance score
```

### Memory Settings (in `memoryService.ts`)
```typescript
const MAX_MEMORY_TOKENS = 2000;  // Auto-prune threshold
const MAX_DECISIONS = 10;         // Keep last 10 decisions
const MAX_CHANGES = 15;           // Keep last 15 changes
```

## Startup Sequence

1. **LifecyclePhase.Restored**: `CodeAIStartupContribution`
   - Load models
   - Build index (delayed 2s, background)

2. **LifecyclePhase.Eventually**: `CodeAIFileWatcherContribution`
   - Start file watcher
   - Monitor for changes

## Comparison with Windsurf/Cursor

| Feature | CodeAI | Windsurf/Cursor |
|---------|--------|-----------------|
| **Indexing** | ✅ Semantic chunking | ✅ AST-based |
| **Retrieval** | ✅ Keyword + AI | ✅ Embeddings + Vector DB |
| **Memory** | ✅ Markdown-based | ✅ Structured DB |
| **Offline** | ✅ 100% offline | ❌ Requires cloud |
| **Incremental** | ✅ File watcher | ✅ File watcher |
| **Context Logging** | ✅ Transparent | ⚠️ Limited |

## Future Enhancements

1. **Symbol Index**: Maintain separate index for fast symbol lookup
2. **Dependency Graph**: Track imports/exports for better context
3. **Embeddings**: Optional local embeddings for semantic search
4. **Multi-workspace**: Support multiple workspace folders
5. **Index Compression**: Compress index for large codebases
6. **Smart Pruning**: Intelligently prune less relevant chunks
7. **User Feedback**: Learn from user interactions

## Troubleshooting

### Index not building
- Check console for errors
- Verify workspace folder exists
- Check `.codeai/index.json` permissions

### Retrieval returns no results
- Verify index is ready: `indexService.isReady()`
- Check query terms are meaningful
- Lower `minScore` threshold

### Memory not persisting
- Check `.codeai/memory.md` exists
- Verify write permissions
- Check for file system errors in console

### High memory usage
- Reduce `MAX_MEMORY_TOKENS`
- Prune index manually
- Skip large files

## API Summary

### New Interfaces

```typescript
// Indexing
ICodebaseIndexService
ICodeChunk
IFileIndex

// Retrieval
IRetrievalService
IRetrievalQuery
IRetrievalResult

// Memory
IMemoryService
IProjectMemory
IMemoryEntry
```

### Updated Interfaces

```typescript
// CodebaseContextService
+ getEnrichedContext(query: string): Promise<string>
+ buildFullContext(query: string): Promise<string>

// CascadeOrchestrator
~ buildCodebaseContext(query: string): Promise<string> // Now takes query
```

## Testing

### Manual Testing
```typescript
// 1. Test index building
const indexService = accessor.get(ICodebaseIndexService);
await indexService.buildIndex();
console.log(indexService.getStats());

// 2. Test retrieval
const retrievalService = accessor.get(IRetrievalService);
const results = await retrievalService.retrieve({
  query: "authentication",
  maxResults: 5
});
console.log(results);

// 3. Test memory
const memoryService = accessor.get(IMemoryService);
await memoryService.updateSummary("Test project");
const memory = await memoryService.getMemory();
console.log(memory);
```

### Integration Testing
1. Open VS Code with CodeAI
2. Wait for index to build (check console)
3. Ask: "Explain the architecture of this codebase"
4. Verify response includes:
   - Memory context
   - Retrieved code chunks
   - Open files
5. Check `.codeai/context.md` for retrieval log

## Conclusion

This persistent indexing and retrieval system transforms CodeAI from a shallow context assistant to a deep codebase understanding agent, similar to Windsurf/Cursor, but **100% offline** and **fully transparent**.

The system provides:
- ✅ Deep codebase understanding
- ✅ Intelligent code retrieval
- ✅ Persistent project memory
- ✅ Incremental updates
- ✅ Full transparency (all logs visible)
- ✅ No external dependencies
- ✅ Privacy-preserving (all local)
