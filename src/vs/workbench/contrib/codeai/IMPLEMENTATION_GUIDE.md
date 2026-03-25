# Implementation Guide: Controller-Executor Architecture

## 📋 Overview

This guide explains how to integrate the new **Reasoning Model as Orchestrator** architecture into your VS Code CodeAI system.

---

## 🎯 What Changed

### Before (WRONG):
```
User Request → Cascade Orchestrator → Reasoning Model (generates code)
                                    → Coding Model (generates code)
```
**Problem**: Both models generate code. No clear separation.

### After (CORRECT):
```
User Request → Cascade Orchestrator → Reasoning Orchestrator (brain)
                                    ↓
                              Tool Executor
                                    ↓
                    ┌───────────────┴───────────────┐
                    ↓                               ↓
            Coding Model (tool)            Context Service (tool)
            read_file (tool)               search_code (tool)
            list_files (tool)              etc...
```
**Solution**: Reasoning model orchestrates. Coding model is just a tool.

---

## 📁 New Files Created

1. **`ARCHITECTURE.md`** - Complete architecture documentation
2. **`toolExecutor.ts`** - Tool execution engine (includes `call_coding_model`)
3. **`reasoningOrchestrator.ts`** - Main orchestration loop
4. **`IMPLEMENTATION_GUIDE.md`** - This file

---

## 🔧 Integration Steps

### Step 1: Update CascadeOrchestrator

Replace the current `runChat` method:

```typescript
// OLD (autonomousOrchestrator.ts approach)
async runChat(prompt: string, callbacks?: IStreamCallbacks): Promise<IGenerateResult> {
    this.setPhase("understanding");
    const result = await this.autonomousOrchestrator.runAgenticTask(prompt, callbacks);
    this.setPhase("completed");
    return result;
}

// NEW (reasoningOrchestrator.ts approach)
async runChat(prompt: string, callbacks?: IStreamCallbacks): Promise<IGenerateResult> {
    this.setPhase("understanding");
    const result = await this.reasoningOrchestrator.orchestrate(prompt, callbacks);
    this.setPhase("completed");
    return result;
}
```

### Step 2: Initialize Services in Constructor

```typescript
constructor(
    @ILocalModelsService private readonly modelsService: ILocalModelsService,
    @ICodeAILogService private readonly codeaiLogService: ICodeAILogService,
    @IFileService private readonly fileService: IFileService,
    @IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
    @ICodebaseIndexService private readonly indexService: ICodebaseIndexService,
    @IRetrievalService private readonly retrievalService: IRetrievalService,
    @IContextConstructionService private readonly contextService: IContextConstructionService,
    // ... other services
) {
    super();
    
    // Initialize tool executor
    this.toolExecutor = new ToolExecutor(
        this.fileService,
        this.workspaceService,
        this.modelsService,
        this.indexService,
        this.retrievalService,
        this.contextService,
        this.codeaiLogService
    );
    
    // Initialize reasoning orchestrator
    this.reasoningOrchestrator = new ReasoningOrchestrator(
        this.modelsService,
        this.toolExecutor,
        this.codeaiLogService
    );
}
```

### Step 3: Remove AutonomousOrchestrator

The `autonomousOrchestrator.ts` file is replaced by:
- `reasoningOrchestrator.ts` (orchestration logic)
- `toolExecutor.ts` (tool execution)

**Delete or deprecate**: `autonomousOrchestrator.ts`

---

## 🛠️ Tool Executor Details

### Key Tool: `call_coding_model`

This is the **most important** tool. It treats the coding model as an executor:

```typescript
private async toolCallCodingModel(
    task: string,
    context: string,
    mode: string,
    targetFile?: string
): Promise<IToolResult> {
    // Load coding model
    await this.modelsService.ensureMemoryBudget("coding");
    const codingModel = this.modelsService.getModelByRole("coding");
    
    // Build instruction
    let instruction = "";
    switch (mode) {
        case "generate":
            instruction = `Generate new code for: ${task}`;
            break;
        case "edit":
            instruction = `Edit existing code to: ${task}`;
            break;
        case "refactor":
            instruction = `Refactor code to: ${task}`;
            break;
    }
    
    // Build prompt
    const prompt = this.buildCodingModelPrompt(instruction, context, targetFile);
    
    // Call coding model (as a tool)
    const result = await codingModel.generate({
        prompt,
        role: "coding",
        maxTokens: 4096,
        temperature: 0.2
    });
    
    return {
        success: true,
        data: {
            generatedCode: result.text,
            tokensUsed: result.tokensUsed
        }
    };
}
```

**Critical**: The coding model has NO decision-making power. It just executes.

---

## 🧠 Reasoning Orchestrator Details

### Orchestration Loop

```typescript
async orchestrate(userRequest: string, callbacks?: IStreamCallbacks): Promise<IGenerateResult> {
    const thread = [{ role: "user", content: userRequest }];
    let iteration = 0;
    
    while (iteration < MAX_ITERATIONS) {
        iteration++;
        
        // 1. Call reasoning model
        const response = await this.callReasoningModel(thread);
        
        // 2. Parse JSON
        const action = this.parseResponse(response.text);
        
        // 3. Execute tool or return answer
        if (action.type === "tool_call") {
            const result = await this.toolExecutor.executeTool(
                action.tool,
                action.input
            );
            
            thread.push({
                role: "tool",
                tool_name: action.tool,
                content: JSON.stringify(result)
            });
            
            continue; // Loop again
        }
        
        if (action.type === "final_answer") {
            return { text: action.content, ... };
        }
    }
}
```

### System Prompt (Strict JSON Enforcement)

The reasoning model receives a **strict** system prompt:

```
You are an autonomous coding agent orchestrator.

ROLE: You are the brain. You control everything.

AVAILABLE TOOLS:
- list_files, read_file, search_code
- get_context (dynamic context retrieval)
- call_coding_model (CRITICAL - use this for ALL code generation)
- write_file, edit_file

CRITICAL RULES:
1. NEVER generate code yourself
2. ALWAYS use call_coding_model for code generation
3. Output ONLY JSON (no explanations)

RESPONSE FORMAT:
{"type": "tool_call", "tool": "...", "input": {...}}
{"type": "final_answer", "content": "..."}
```

---

## 🔄 Example Execution Flow

### User Request: "Add validation to login form"

```
[ITERATION 1]
Reasoning Model:
{
  "type": "tool_call",
  "tool": "search_code",
  "input": {"query": "login form", "max_results": 3}
}

Tool Result: [login.ts, auth.service.ts, form.component.ts]

[ITERATION 2]
Reasoning Model:
{
  "type": "tool_call",
  "tool": "read_file",
  "input": {"path": "login.ts"}
}

Tool Result: [File contents...]

[ITERATION 3]
Reasoning Model:
{
  "type": "tool_call",
  "tool": "get_context",
  "input": {"query": "form validation", "scope": "focused"}
}

Tool Result: [Validation patterns and examples...]

[ITERATION 4]
Reasoning Model:
{
  "type": "tool_call",
  "tool": "call_coding_model",
  "input": {
    "task": "Add email and password validation",
    "context": "login.ts contents + validation patterns",
    "mode": "edit",
    "target_file": "login.ts"
  }
}

Tool Result: [Generated validation code...]

[ITERATION 5]
Reasoning Model:
{
  "type": "final_answer",
  "content": "Added validation to login form with email format and password strength checks."
}
```

---

## 📊 Service Dependencies

### ToolExecutor requires:
- `IFileService` - File operations
- `IWorkspaceContextService` - Workspace access
- `ILocalModelsService` - Model access (for coding model)
- `ICodebaseIndexService` - File listing
- `IRetrievalService` - Code search
- `IContextConstructionService` - Dynamic context
- `ICodeAILogService` - Logging

### ReasoningOrchestrator requires:
- `ILocalModelsService` - Model access (for reasoning model)
- `ToolExecutor` - Tool execution
- `ICodeAILogService` - Logging

---

## ⚠️ Important Notes

### 1. Coding Model Isolation
The coding model is **completely isolated**. It:
- Has NO access to tools
- Has NO decision-making capability
- Is invoked ONLY via `call_coding_model` tool
- Receives task + context, returns code

### 2. Context Strategy
The reasoning model:
- Starts with minimal context
- Expands via `get_context`, `read_file`, `search_code`
- Decides dynamically what context is needed
- Never overloads the prompt

### 3. JSON Protocol
The reasoning model:
- MUST output only JSON
- No natural language during execution
- User sees only `final_answer`
- All tool calls are hidden

### 4. Error Handling
If JSON parsing fails:
- Give model 1-2 retries with error feedback
- After 3 failures, treat response as final answer
- Log all parsing errors

---

## 🧪 Testing

### Test 1: Simple Query
```
User: "What files are in the src directory?"

Expected:
1. Tool call: list_files
2. Final answer: "The src directory contains..."
```

### Test 2: Code Generation
```
User: "Create a new user service"

Expected:
1. Tool call: search_code (find similar services)
2. Tool call: get_context (service patterns)
3. Tool call: call_coding_model (generate service)
4. Tool call: write_file (save service)
5. Final answer: "Created user service at..."
```

### Test 3: Code Editing
```
User: "Add error handling to auth.ts"

Expected:
1. Tool call: read_file (auth.ts)
2. Tool call: get_context (error handling patterns)
3. Tool call: call_coding_model (edit with error handling)
4. Tool call: edit_file (apply changes)
5. Final answer: "Added error handling to auth.ts"
```

---

## 🚀 Migration Checklist

- [ ] Review `ARCHITECTURE.md`
- [ ] Understand `toolExecutor.ts` (especially `call_coding_model`)
- [ ] Understand `reasoningOrchestrator.ts` (orchestration loop)
- [ ] Update `cascadeOrchestrator.ts` constructor
- [ ] Replace `runChat` to use `reasoningOrchestrator.orchestrate`
- [ ] Remove/deprecate `autonomousOrchestrator.ts`
- [ ] Fix import errors in new files
- [ ] Register services in DI container
- [ ] Test with simple queries
- [ ] Test with code generation tasks
- [ ] Test with code editing tasks
- [ ] Verify coding model is never called directly
- [ ] Verify reasoning model controls flow

---

## 🎯 Success Criteria

✅ Reasoning model makes all decisions  
✅ Coding model is invoked only via `call_coding_model` tool  
✅ All responses are JSON (except final_answer)  
✅ Context is retrieved dynamically  
✅ User sees only final answers  
✅ System behaves like Cursor/Windsurf  

---

## 📞 Next Steps

1. **Fix imports**: Update service imports in new files
2. **Register services**: Add to DI container
3. **Compile**: Run `npm run compile`
4. **Test**: Try simple queries first
5. **Iterate**: Refine system prompt if needed

The architecture is now **correct**. The reasoning model is the brain, the coding model is a tool.
