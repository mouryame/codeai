# CodeAI Agentic System - Complete Implementation

## Overview

CodeAI now features a **full-fledged agentic system** similar to Cascade, with autonomous reasoning, tool calling, multi-step planning, and action execution capabilities.

## Architecture

```
User Request
    ↓
AgenticOrchestrator.runAgenticTask()
    ↓
┌─────────────────────────────────────────────────────────┐
│  Agentic Reasoning Loop (max 10 iterations)             │
│                                                          │
│  1. Build Context (memory + retrieval + open files)     │
│  2. Call Reasoning Model with system prompt             │
│  3. Parse Response:                                      │
│     - Tool Call? → Execute → Add result → Continue      │
│     - Final Answer? → Return to user                    │
│  4. Repeat until done or max iterations                 │
└─────────────────────────────────────────────────────────┘
    ↓
Stream results + tool execution feedback to user
```

## Available Tools (10 Total)

### 1. **read_file**
- **Purpose**: Read complete file contents
- **Use Case**: Examine code, configuration, documentation
- **Parameters**: `path` (workspace-relative)
- **Example**: `{"tool": "read_file", "arguments": {"path": "src/main.ts"}}`

### 2. **write_file**
- **Purpose**: Create new file or completely overwrite existing
- **Use Case**: Generate new files, replace entire file contents
- **Parameters**: `path`, `content`
- **Example**: `{"tool": "write_file", "arguments": {"path": "src/new.ts", "content": "..."}}`

### 3. **edit_file**
- **Purpose**: Make targeted search-and-replace edits
- **Use Case**: Precise modifications without rewriting entire file
- **Parameters**: `path`, `old_string`, `new_string`
- **Example**: `{"tool": "edit_file", "arguments": {"path": "src/auth.ts", "old_string": "const x = 1", "new_string": "const x = 2"}}`

### 4. **search_code**
- **Purpose**: Semantic code search using retrieval system
- **Use Case**: Find relevant code chunks across codebase
- **Parameters**: `query`, `max_results` (optional, default: 5)
- **Example**: `{"tool": "search_code", "arguments": {"query": "authentication logic", "max_results": 10}}`

### 5. **list_files**
- **Purpose**: List files matching pattern or in directory
- **Use Case**: Explore codebase structure, find files
- **Parameters**: `path` (directory or glob pattern)
- **Example**: `{"tool": "list_files", "arguments": {"path": "src/**/*.ts"}}`

### 6. **list_open_files**
- **Purpose**: Get all currently open editor files
- **Use Case**: Understand current working context
- **Parameters**: None
- **Example**: `{"tool": "list_open_files", "arguments": {}}`

### 7. **get_workspace_structure**
- **Purpose**: Get overview of workspace folder structure
- **Use Case**: Understand project organization
- **Parameters**: None
- **Example**: `{"tool": "get_workspace_structure", "arguments": {}}`

### 8. **get_project_memory**
- **Purpose**: Access persistent project knowledge
- **Use Case**: Retrieve architecture notes, key files, decisions
- **Parameters**: None
- **Example**: `{"tool": "get_project_memory", "arguments": {}}`

### 9. **analyze_code**
- **Purpose**: Analyze code structure (functions, classes, imports)
- **Use Case**: Quick code overview without full read
- **Parameters**: `path`
- **Example**: `{"tool": "analyze_code", "arguments": {"path": "src/utils.ts"}}`

### 10. **run_command**
- **Purpose**: Execute shell commands (DISABLED for security)
- **Use Case**: N/A - returns error
- **Parameters**: `command`
- **Note**: Disabled for security reasons

## Tool Execution Flow

```typescript
// Agent decides to call a tool
<think>I need to read the authentication file to understand the bug</think>

```tool
{
  "tool": "read_file",
  "arguments": {
    "path": "src/auth/authService.ts"
  }
}
```

// Tool executes
→ File content returned

// Agent continues reasoning
<think>I see the issue on line 45. Let me fix it</think>

```tool
{
  "tool": "edit_file",
  "arguments": {
    "path": "src/auth/authService.ts",
    "old_string": "if (token === null)",
    "new_string": "if (!token || token === null)"
  }
}
```

// Edit applied
→ Success message

// Agent provides final answer
Here's what I fixed: The authentication bug was caused by...
```

## System Prompt

The agent operates with a comprehensive system prompt that includes:

1. **Capabilities Overview**: What the agent can do
2. **Tool Descriptions**: All 10 tools with parameters
3. **Tool Call Format**: Exact JSON format required
4. **Reasoning Process**: Step-by-step guidelines
5. **Important Rules**: Best practices and constraints

## Example Agentic Workflows

### Workflow 1: Bug Fix
```
User: "Fix the authentication timeout bug"

Iteration 1:
  <think>Need to find auth code</think>
  → search_code("authentication timeout")
  → Found 3 relevant files

Iteration 2:
  <think>Let me read the main auth file</think>
  → read_file("src/auth/authService.ts")
  → File content retrieved

Iteration 3:
  <think>I see the bug - timeout is hardcoded. Let me check config</think>
  → search_code("timeout configuration")
  → Found config file

Iteration 4:
  <think>Now I'll fix it</think>
  → edit_file(path, old_timeout, new_timeout)
  → Edit successful

Final: Bug fixed! Changed hardcoded timeout to use config value.
```

### Workflow 2: Feature Implementation
```
User: "Add logging to the payment service"

Iteration 1:
  <think>Need to understand current payment service structure</think>
  → analyze_code("src/payment/paymentService.ts")
  → Structure analyzed

Iteration 2:
  <think>Let me read the full file</think>
  → read_file("src/payment/paymentService.ts")
  → File content retrieved

Iteration 3:
  <think>I'll add logging imports and calls</think>
  → edit_file(path, old_imports, new_imports_with_logger)
  → Import added

Iteration 4:
  <think>Now add logging to each method</think>
  → edit_file(path, old_method, new_method_with_logging)
  → Logging added

Final: Added comprehensive logging to payment service.
```

### Workflow 3: Code Analysis
```
User: "Explain how the authentication system works"

Iteration 1:
  <think>Let me find auth-related files</think>
  → search_code("authentication")
  → Found 5 files

Iteration 2:
  <think>Read the main auth service</think>
  → read_file("src/auth/authService.ts")
  → Content retrieved

Iteration 3:
  <think>Check for token management</think>
  → search_code("token management")
  → Found token handler

Iteration 4:
  <think>Read token handler</think>
  → read_file("src/auth/tokenHandler.ts")
  → Content retrieved

Iteration 5:
  <think>Get project memory for context</think>
  → get_project_memory()
  → Retrieved architecture notes

Final: Here's how authentication works: [detailed explanation]
```

## Integration Points

### 1. CascadeOrchestrator
```typescript
async runChat(prompt: string, callbacks?: IStreamCallbacks): Promise<IGenerateResult> {
  this.setPhase("understanding");
  
  // Routes to agentic orchestrator
  const result = await this.agenticOrchestrator.runAgenticTask(prompt, callbacks);
  
  this.setPhase("completed");
  return result;
}
```

### 2. Streaming Feedback
Tool execution is streamed to user in real-time:
```
**[Tool: search_code]**
Executed successfully

**[Tool: read_file]**
Executed successfully

**[Tool: edit_file]**
Executed successfully
```

### 3. Logging
All tool executions are logged to `.codeai/logs/changes.md` and `.codeai/logs/plan.md`

## Performance Characteristics

- **Max Iterations**: 10 (configurable)
- **Tool Execution**: Async with error handling
- **Context Building**: Includes memory + retrieval + open files
- **Streaming**: Real-time feedback to user
- **Error Recovery**: Graceful fallback on tool failures

## Comparison: CodeAI vs Cascade

| Feature | CodeAI Agentic | Cascade |
|---------|---------------|---------|
| **Autonomous Reasoning** | ✅ 10 iterations | ✅ Multi-step |
| **Tool Calling** | ✅ 10 tools | ✅ Extensive tools |
| **File Operations** | ✅ Read/Write/Edit | ✅ Full file ops |
| **Code Search** | ✅ Semantic search | ✅ Advanced search |
| **Workspace Scanning** | ✅ Structure + List | ✅ Full scanning |
| **Code Analysis** | ✅ Basic analysis | ✅ AST-based |
| **Memory Integration** | ✅ Project memory | ✅ Context memory |
| **Streaming Feedback** | ✅ Real-time | ✅ Real-time |
| **Error Recovery** | ✅ Try-catch | ✅ Robust |
| **Offline** | ✅ 100% local | ❌ Cloud-based |
| **Privacy** | ✅ All local | ⚠️ Cloud data |

## Configuration

### Adjust Max Iterations
```typescript
// In agenticOrchestrator.ts
private readonly maxIterations = 10; // Change this value
```

### Customize System Prompt
```typescript
// In buildAgenticSystemPrompt()
return `You are CodeAI, an autonomous AI coding assistant...`;
```

### Add New Tools
```typescript
// 1. Add to AVAILABLE_TOOLS array
{
  name: 'new_tool',
  description: 'Tool description',
  parameters: { ... }
}

// 2. Add case to executeTool()
case 'new_tool':
  return await this.toolNewTool(args);

// 3. Implement tool method
private async toolNewTool(args): Promise<IToolResult> {
  // Implementation
}
```

## Security Considerations

1. **Command Execution**: Disabled by default (`run_command` returns error)
2. **File Access**: Limited to workspace folder
3. **Path Validation**: All paths are workspace-relative
4. **Error Handling**: All tool calls wrapped in try-catch
5. **Logging**: All actions logged for auditability

## Troubleshooting

### Agent Not Calling Tools
- Check system prompt includes tool descriptions
- Verify tool call format in response
- Check reasoning model temperature (should be ~0.7)

### Tool Execution Fails
- Check workspace folder is open
- Verify file paths are workspace-relative
- Check file permissions
- Review error messages in logs

### Max Iterations Reached
- Increase `maxIterations` if needed
- Check if agent is stuck in loop
- Review reasoning quality

### No Context Retrieved
- Verify index is built (`indexService.isReady()`)
- Check retrieval service is working
- Ensure memory service is loaded

## Future Enhancements

1. **Advanced Code Analysis**: AST-based parsing
2. **Multi-file Edits**: Batch edit operations
3. **Undo/Redo**: Edit history and rollback
4. **Better File Search**: Glob pattern support
5. **Command Execution**: Sandboxed shell access
6. **Parallel Tool Calls**: Execute multiple tools simultaneously
7. **Tool Result Caching**: Avoid redundant operations
8. **Smarter Iteration Limits**: Dynamic based on task complexity

## Usage Examples

### Ask Agent to Fix a Bug
```
User: "Fix the null pointer exception in the user service"

Agent will:
1. Search for user service code
2. Read relevant files
3. Identify the null pointer issue
4. Edit the file with the fix
5. Explain what was changed
```

### Ask Agent to Implement Feature
```
User: "Add input validation to the login form"

Agent will:
1. Find the login form code
2. Analyze current validation
3. Search for validation utilities
4. Edit form to add validation
5. Provide implementation summary
```

### Ask Agent to Explain Code
```
User: "How does the caching system work?"

Agent will:
1. Search for caching-related code
2. Read cache implementation files
3. Analyze code structure
4. Access project memory for context
5. Provide detailed explanation
```

## Conclusion

CodeAI now has a **production-ready agentic system** that rivals Cascade in capabilities while being:
- ✅ **100% offline**
- ✅ **Fully autonomous**
- ✅ **Privacy-preserving**
- ✅ **Transparent** (all actions logged)
- ✅ **Extensible** (easy to add tools)

The agent can autonomously:
- Read and analyze code
- Search the codebase semantically
- Make targeted file edits
- Create new files
- Access project memory
- Reason through complex multi-step tasks
- Provide informed, context-aware responses

**CodeAI is now a true autonomous coding assistant, not just a chatbot.**
