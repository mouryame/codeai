# Autonomous Agent Implementation - Cascade Style

## Overview

CodeAI now features a **true closed-loop autonomous agent** that operates exactly like Cascade/Windsurf/Cursor agents.

## Key Differences from Previous Implementation

### ❌ OLD (Broken Behavior)
- Agent **exposed tools** to user ("I can use analyze_code...")
- Agent **explained** what tools it would use
- Agent **did NOT actually call tools**
- Agent behaved like a **chatbot**
- User saw tool execution details

### ✅ NEW (Cascade-Style Behavior)
- Agent **NEVER mentions tools** to user
- Agent **automatically calls tools** internally
- Agent operates in **closed loop** until task completion
- User **only sees final answer**
- Tools are completely **hidden from user**

## Architecture

```
User: "Fix the auth bug"
    ↓
AutonomousOrchestrator.runAgenticTask()
    ↓
┌─────────────────────────────────────────────────┐
│  CLOSED LOOP (Hidden from User)                 │
│                                                  │
│  Iteration 1:                                   │
│    Model → {"type": "tool_call", ...}           │
│    Execute tool → Get result                    │
│    Add to thread                                │
│                                                  │
│  Iteration 2:                                   │
│    Model → {"type": "tool_call", ...}           │
│    Execute tool → Get result                    │
│    Add to thread                                │
│                                                  │
│  Iteration N:                                   │
│    Model → {"type": "final_answer", ...}        │
│    Break loop                                   │
└─────────────────────────────────────────────────┘
    ↓
User sees: "Fixed the auth bug by changing..."
```

## Structured Response Protocol

The model MUST respond with JSON only:

### Tool Call
```json
{
  "type": "tool_call",
  "tool": "read_file",
  "input": {
    "path": "src/auth.ts"
  }
}
```

### Final Answer
```json
{
  "type": "final_answer",
  "content": "I fixed the authentication bug by..."
}
```

**NO free-form text during execution loop.**

## System Prompt Design

The system prompt enforces:

1. **JSON-only responses** - No natural language during tool loop
2. **Mandatory tool usage** - MUST use tools for codebase questions
3. **No tool exposure** - NEVER say "I will use X tool"
4. **Aggressive retrieval** - Better to over-retrieve than under-retrieve
5. **Structured thinking** - Internal reasoning, not exposed to user

### Critical Rules in Prompt

```
You MUST respond ONLY with valid JSON
You MUST use tools to gather information about the codebase
You MUST NOT guess or make assumptions about code
You MUST NOT describe or explain tools to the user
You MUST NOT say things like "I will use X tool"
```

## Available Tools (7 Total)

1. **list_files** - List files matching pattern
2. **read_file** - Read complete file contents
3. **search_code** - Semantic code search
4. **analyze_code** - Extract code structure
5. **write_file** - Create/overwrite file
6. **edit_file** - Targeted search-replace edit
7. **get_open_files** - List open editor files

All tools return structured JSON results.

## Execution Flow

### Example: Bug Fix Request

```
User: "Fix the authentication timeout bug"

[HIDDEN FROM USER - Internal Loop]

Iteration 1:
  Model output: {"type": "tool_call", "tool": "search_code", "input": {"query": "authentication timeout"}}
  Tool result: {"success": true, "data": "{\"count\": 3, \"results\": [...]}"}
  
Iteration 2:
  Model output: {"type": "tool_call", "tool": "read_file", "input": {"path": "src/auth/authService.ts"}}
  Tool result: {"success": true, "data": "{\"path\": \"...\", \"content\": \"...\"}"}
  
Iteration 3:
  Model output: {"type": "tool_call", "tool": "edit_file", "input": {"path": "...", "old_string": "...", "new_string": "..."}}
  Tool result: {"success": true, "data": "{\"path\": \"...\", \"changed\": true}"}
  
Iteration 4:
  Model output: {"type": "final_answer", "content": "Fixed the authentication timeout bug by..."}

[END LOOP]

User sees: "Fixed the authentication timeout bug by..."
```

### Example: Code Explanation Request

```
User: "How does the payment system work?"

[HIDDEN FROM USER - Internal Loop]

Iteration 1:
  Model output: {"type": "tool_call", "tool": "search_code", "input": {"query": "payment system"}}
  Tool result: {"success": true, "data": "..."}
  
Iteration 2:
  Model output: {"type": "tool_call", "tool": "read_file", "input": {"path": "src/payment/paymentService.ts"}}
  Tool result: {"success": true, "data": "..."}
  
Iteration 3:
  Model output: {"type": "tool_call", "tool": "analyze_code", "input": {"path": "src/payment/paymentService.ts"}}
  Tool result: {"success": true, "data": "..."}
  
Iteration 4:
  Model output: {"type": "final_answer", "content": "The payment system works by..."}

[END LOOP]

User sees: "The payment system works by..."
```

## Implementation Details

### AutonomousOrchestrator Class

```typescript
class AutonomousOrchestrator implements IAgenticOrchestrator {
  async runAgenticTask(userRequest: string, callbacks?: IStreamCallbacks): Promise<IGenerateResult> {
    const thread: IThreadMessage[] = [{ role: 'user', content: userRequest }];
    
    while (iteration < maxIterations) {
      // Call model with thread history
      const response = await this.callModel(thread);
      
      // Parse structured response
      const agentResponse = this.parseResponse(response.text);
      
      if (agentResponse.type === 'tool_call') {
        // Execute tool
        const toolResult = await this.executeTool(agentResponse.tool, agentResponse.input);
        
        // Add to thread
        thread.push({
          role: 'tool',
          tool_name: agentResponse.tool,
          content: JSON.stringify(toolResult)
        });
        
        continue; // Loop again
      }
      
      if (agentResponse.type === 'final_answer') {
        return { text: agentResponse.content, ... };
      }
    }
  }
}
```

### Thread Management

The thread maintains conversation history:

```typescript
[
  { role: 'user', content: 'Fix the bug' },
  { role: 'tool', tool_name: 'search_code', content: '{"success": true, ...}' },
  { role: 'tool', tool_name: 'read_file', content: '{"success": true, ...}' },
  { role: 'tool', tool_name: 'edit_file', content: '{"success": true, ...}' }
]
```

Each iteration, the full thread is sent to the model so it has complete context.

### Response Parsing

```typescript
private parseResponse(text: string): IAgentResponse | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  
  const parsed = JSON.parse(jsonMatch[0]);
  
  if (parsed.type === 'tool_call' && parsed.tool && parsed.input) {
    return parsed as IToolCall;
  }
  
  if (parsed.type === 'final_answer' && parsed.content) {
    return parsed as IFinalAnswer;
  }
  
  return null;
}
```

### Tool Execution with Retry

```typescript
private async executeToolWithRetry(toolName: string, input: any): Promise<IToolResult> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await this.executeTool(toolName, input);
      if (result.success) return result;
    } catch (err) {
      // Log and retry
    }
  }
  
  return { success: false, error: 'Tool failed after retries' };
}
```

## Integration Points

### CascadeOrchestrator

```typescript
async runChat(prompt: string, callbacks?: IStreamCallbacks): Promise<IGenerateResult> {
  this.setPhase("understanding");
  
  // Route to autonomous orchestrator
  const result = await this.autonomousOrchestrator.runAgenticTask(prompt, callbacks);
  
  this.setPhase("completed");
  return result;
}
```

### Service Registration

```typescript
registerSingleton(
  IAgenticOrchestrator,
  AutonomousOrchestrator,
  InstantiationType.Delayed
);
```

## User Experience

### What User Sees

```
User: "Fix the authentication bug"

[Brief pause while agent works]
