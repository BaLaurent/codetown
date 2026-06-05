# PRD: Cursor Changelog-Based Improvements

**Date**: January 14, 2026
**Status**: Completed
**Priority**: High

## Overview

Implement improvements to CodeTown based on Cursor IDE changelog updates and hook capabilities. Focus on Cursor-specific features that expose richer agent state data.

## Background

Cursor hooks provide data we're not currently using:

| Hook | Data Available | Current Usage |
|------|----------------|---------------|
| All hooks | `model`, `generation_id` | Not captured |
| `afterShellExecution` | `command`, `output`, `duration` | Basic only |
| `afterMCPExecution` | `tool_name`, `tool_input`, `result_json`, `duration` | Not captured |
| `afterAgentThought` | `text`, `duration_ms` | Not captured |
| `stop` | `status` (completed/aborted/error), `loop_count` | Not captured |

## Goals

1. **Show agent completion status** - Visual indicator when agent finishes
2. **Display model name** - Show which model is being used
3. **Track operation duration** - Show timing for operations
4. **Capture MCP tool usage** - Track MCP server tool calls

---

## Feature 1: Agent Completion Status

### Problem
No visual indication when a Cursor agent completes, aborts, or errors.

### Solution
Add status indicator that appears briefly when agent stops.

### Implementation

**1.1 New Hook Script** (`hooks/cursor-stop-hook.sh`)
- Capture `stop` event with `status` field
- POST to new `/api/agent-status` endpoint

**1.2 Server Changes**
- Add `status?: 'completed' | 'aborted' | 'error'` to `AgentThinkingState`
- Add `statusTimestamp?: number` for auto-clearing
- New endpoint or extend `/api/thinking`

**1.3 Client Changes**
- Show status badge on agent: ✅ (completed), ❌ (error), ⚠️ (aborted)
- Badge fades after 5 seconds
- Different color per status

### Acceptance Criteria
- [ ] Status badge appears when agent stops
- [ ] Correct icon for each status type
- [ ] Badge fades after timeout

---

## Feature 2: Model Display

### Problem
Can't tell which model a Cursor agent is using.

### Solution
Show model name in agent display.

### Implementation

**2.1 Hook Changes** (`hooks/thinking-hook.sh`)
- Extract `model` field from Cursor hook input
- Include in thinking event payload

**2.2 Server Changes**
- Add `model?: string` to `AgentThinkingState`
- Store on first event, persist for agent lifetime

**2.3 Client Changes**
- Show abbreviated model name below agent name
- Format: "claude-3.5-sonnet" → "3.5-sonnet"
- Smaller font, gray color

### Acceptance Criteria
- [ ] Model shown below agent name for Cursor agents
- [ ] Properly abbreviated for readability
- [ ] Only shown when model data available

---

## Feature 3: Operation Duration

### Problem
No visibility into how long operations take.

### Solution
Show duration in command bubble or as visual indicator.

### Implementation

**3.1 Hook Changes**
- Capture `duration` from `afterShellExecution`
- Capture `duration` from `afterMCPExecution`
- Include in activity/thinking events

**3.2 Server Changes**
- Add `lastDuration?: number` to `AgentThinkingState`
- Track duration in milliseconds

**3.3 Client Changes**
- Show duration in bubble: "Bash (2.3s)"
- Color code: green (<1s), yellow (1-5s), red (>5s)

### Acceptance Criteria
- [ ] Duration shown in command bubble
- [ ] Color indicates duration category
- [ ] Only shown when duration data available

---

## Feature 4: MCP Tool Tracking

### Problem
MCP tool usage not tracked separately from other tools.

### Solution
Capture and display MCP tool calls with server name.

### Implementation

**4.1 New Hook Script** (`hooks/cursor-mcp-hook.sh`)
- Handle `afterMCPExecution` events
- Extract `tool_name`, server info, `duration`

**4.2 Server Changes**
- Recognize MCP tools in activity events
- Track MCP server name if available

**4.3 Client Changes**
- Show MCP tools with server prefix: "mcp:github/create-pr"
- Different bubble style for MCP vs native tools

### Acceptance Criteria
- [ ] MCP tools shown with server context
- [ ] Visual distinction from native tools
- [ ] Duration tracked for MCP calls

---

## Implementation Order

1. **Feature 2: Model Display** - Simple, immediate value
2. **Feature 1: Agent Completion Status** - High visibility improvement
3. **Feature 3: Operation Duration** - Nice to have
4. **Feature 4: MCP Tool Tracking** - If time permits

## Testing Plan

### Unit Tests
- Server: Accept new fields from Cursor hooks
- Client: Render new visual elements

### Integration Tests
- Cursor hook → Server → Client data flow
- Fallback when fields missing (Claude Code compatibility)

### Manual Tests
- Run Cursor with CodeTown
- Verify model name appears
- Complete/abort agent and verify status
- Run shell commands and verify duration

---

## Compatibility Notes

- All changes must remain backward compatible with Claude Code
- Missing fields = no visual change (graceful degradation)
- Cursor uses `conversation_id`, Claude uses `session_id` - both supported
