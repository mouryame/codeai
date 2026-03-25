# CodeAI Architecture: Controller-Executor Pattern

## 🎯 Core Principle

**Reasoning Model = Orchestrator (Brain)**  
**Coding Model = Tool (Executor)**

---

## 📐 System Layers

```
┌─────────────────────────────────────────────────────────────┐
│                         USER REQUEST                         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    CASCADE ORCHESTRATOR                      │
│  - Entry point for all requests                             │
│  - Routes to ReasoningOrchestrator                          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  REASONING ORCHESTRATOR                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ REASONING MODEL (Qwen, Llama, etc.)                   │  │
│  │ - Autonomous decision making                          │  │
│  │ - Tool selection                                      │  │
│  │ - Context planning                                    │  │
│  │ - Execution control                                   │  │
│  └───────────────────────────────────────────────────────┘  │
│                              ↓                               │
│                    JSON-ONLY OUTPUT                          │
│              {"type": "tool_call", ...}                      │
│              {"type": "final_answer", ...}                   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                       TOOL EXECUTOR                          │
│  - list_files                                               │
│  - read_file                                                │
│  - search_code                                              │
│  - get_context ────────────┐                                │
│  - call_coding_model ──┐   │                                │
│  - write_file          │   │                                │
│  - edit_file           │   │                                │
└────────────────────────┼───┼────────────────────────────────┘
                         │   │
        ┌────────────────┘   └──────────────────┐
        ↓                                       ↓
┌──────────────────────┐           ┌──────────────────────────┐
│   CODING MODEL       │           │ CONTEXT CONSTRUCTION     │
│   (DeepSeek, etc.)   │           │ SERVICE                  │
│                      │           │                          │
│ - Code generation    │           │ - Dynamic retrieval      │
│ - Code editing       │           │ - Scope-based context    │
│ - Code refactoring   │           │ - Index + Memory         │
│                      │           │ - Smart ranking          │
│ NO DECISION MAKING   │           └──────────────────────────┘
└──────────────────────┘
```

---

## 🧠 Reasoning Model Responsibilities

### MUST DO:
- Analyze user request
- Decide what information is needed
- Call tools to gather context
- Decide when to invoke coding model
- Control the execution loop
- Provide final answer

### MUST NOT DO:
- Generate code directly
- Make assumptions without context
- Skip tool usage
- Explain tools to user

---

## 🔧 Coding Model Responsibilities

### MUST DO:
- Execute code generation tasks
- Follow exact instructions
- Use provided context only

### MUST NOT DO:
- Decide what to implement
- Plan architecture
- Retrieve context
- Make autonomous decisions

---

## 🛠️ Tool System

### Available Tools for Reasoning Model:

#### 1. **list_files**
```json
{
  "type": "tool_call",
  "tool": "list_files",
  "input": {
    "pattern": "**/*.ts"
  }
}
```

#### 2. **read_file**
```json
{
  "type": "tool_call",
  "tool": "read_file",
  "input": {
    "path": "src/file.ts"
  }
}
```

#### 3. **search_code**
```json
{
  "type": "tool_call",
  "tool": "search_code",
  "input": {
    "query": "authentication logic",
    "max_results": 5
  }
}
```

#### 4. **get_context** (NEW)
```json
{
  "type": "tool_call",
  "tool": "get_context",
  "input": {
    "query": "user authentication flow",
    "scope": "focused"
  }
}
```
Scopes: `broad`, `focused`, `file`

#### 5. **call_coding_model** (CRITICAL)
```json
{
  "type": "tool_call",
  "tool": "call_coding_model",
  "input": {
    "task": "Add login validation",
    "context": "...",
    "mode": "edit",
    "target_file": "auth.ts"
  }
}
```
Modes: `generate`, `edit`, `refactor`

#### 6. **write_file**
```json
{
  "type": "tool_call",
  "tool": "write_file",
  "input": {
    "path": "new-file.ts",
    "content": "..."
  }
}
```

#### 7. **edit_file**
```json
{
  "type": "tool_call",
  "tool": "edit_file",
  "input": {
    "path": "file.ts",
    "old_string": "...",
    "new_string": "..."
  }
}
```

---

## 🔄 Execution Loop

```typescript
async function orchestrationLoop(userRequest: string) {
  const thread = [{ role: "user", content: userRequest }];
  
  while (iteration < MAX_ITERATIONS) {
    // 1. Reasoning model decides next action
    const response = await reasoningModel.generate({
      prompt: buildPrompt(thread),
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT
    });
    
    // 2. Parse JSON response
    const action = parseJSON(response.text);
    
    // 3. Execute tool or return answer
    if (action.type === "tool_call") {
      const result = await executeTool(action.tool, action.input);
      
      thread.push({
        role: "tool",
        tool_name: action.tool,
        content: JSON.stringify(result)
      });
      
      continue; // Loop again
    }
    
    if (action.type === "final_answer") {
      return action.content;
    }
  }
}
```

---

## 📋 System Prompt (Reasoning Model)

```
You are an autonomous coding agent orchestrator.

ROLE: You are the brain. You decide everything.

CAPABILITIES:
- Analyze requests
- Retrieve context via tools
- Invoke coding model for implementation
- Control execution flow

TOOLS AVAILABLE:
- list_files: List files matching pattern
- read_file: Read file contents
- search_code: Search codebase
- get_context: Get focused/broad context
- call_coding_model: Execute code generation/editing
- write_file: Create files
- edit_file: Modify files

CRITICAL RULES:
1. NEVER generate code yourself
2. ALWAYS use tools to gather context before acting
3. Use call_coding_model for ALL code generation/editing
4. Output ONLY valid JSON (no explanations)
5. Think step-by-step

RESPONSE FORMAT:

Tool call:
{"type": "tool_call", "tool": "tool_name", "input": {...}}

Final answer:
{"type": "final_answer", "content": "answer"}

WORKFLOW:
1. Understand request
2. Gather context (list_files, read_file, get_context)
3. If code needed: call_coding_model
4. Verify results
5. Provide final_answer

NO natural language during execution. JSON only.
```

---

## 🎯 Example Execution Trace

### User Request: "Add input validation to the login form"

```
[ITERATION 1]
Reasoning Model Output:
{
  "type": "tool_call",
  "tool": "search_code",
  "input": {
    "query": "login form",
    "max_results": 3
  }
}

Tool Result: [Found: login.ts, auth.service.ts, form.component.ts]

[ITERATION 2]
Reasoning Model Output:
{
  "type": "tool_call",
  "tool": "read_file",
  "input": {
    "path": "login.ts"
  }
}

Tool Result: [File contents...]

[ITERATION 3]
Reasoning Model Output:
{
  "type": "tool_call",
  "tool": "get_context",
  "input": {
    "query": "form validation patterns",
    "scope": "focused"
  }
}

Tool Result: [Context about validation...]

[ITERATION 4]
Reasoning Model Output:
{
  "type": "tool_call",
  "tool": "call_coding_model",
  "input": {
    "task": "Add email and password validation to login form",
    "context": "Current login.ts code + validation patterns",
    "mode": "edit",
    "target_file": "login.ts"
  }
}

Tool Result: [Coding model generates validation code]

[ITERATION 5]
Reasoning Model Output:
{
  "type": "final_answer",
  "content": "Added input validation to login form with email format checking and password strength requirements."
}
```

---

## 🔐 Key Design Decisions

### 1. Strict Separation
- Reasoning model NEVER sees coding model internals
- Coding model NEVER makes decisions
- Tools are the ONLY interface

### 2. Context on Demand
- Reasoning model requests context dynamically
- No upfront context loading
- Minimal → Expand strategy

### 3. JSON Protocol
- All reasoning model output is JSON
- No natural language during execution
- User only sees final_answer

### 4. Tool Isolation
- Each tool has single responsibility
- call_coding_model is just another tool
- No special treatment

---

## 📊 Benefits

✅ **Clear separation of concerns**  
✅ **Reasoning model controls flow**  
✅ **Coding model is stateless executor**  
✅ **Easy to test and debug**  
✅ **Matches Cursor/Windsurf architecture**  
✅ **Scalable and maintainable**

---

## 🚀 Implementation Files

1. `reasoningOrchestrator.ts` - Main orchestration loop
2. `toolExecutor.ts` - Tool execution logic
3. `codingModelTool.ts` - Coding model as a tool
4. `contextConstructionService.ts` - Enhanced context retrieval
5. `cascadeOrchestrator.ts` - Entry point (simplified)
