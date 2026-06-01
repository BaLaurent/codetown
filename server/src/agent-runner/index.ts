// Runs Claude agents in-process via the Agent SDK so the user can spawn and chat
// with them from the hotel. Each session is keyed by an agentId that is forced as
// the SDK sessionId, so the agent's own hooks report under the same id and it
// appears as a normal hotel character (no separate event bridge needed).
//
// Tool use is supervised through the hotel via canUseTool: the chosen
// permissionMode decides when the SDK calls it (only 'default' opens the human
// modal; 'bypassPermissions' skips checks, 'auto' lets a model classifier decide,
// 'plan' runs no tools).
import { query, type Query, type CanUseTool, type PermissionMode, type PermissionResult, type EffortLevel, type ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
import { SessionInput } from './session-input.js';
import { fetchCapabilities, getCachedCapabilities } from './capabilities.js';
import type { AgentCapabilities, InteractionOutcome } from '../types.js';

// A tool call awaiting the user's allow/deny, surfaced to the hotel modal.
export interface PermissionRequest {
  toolUseID: string;
  toolName: string;
  toolInput?: string;   // compact preview (command, path, pattern…)
  title?: string;       // SDK-rendered prompt sentence, when present
  description?: string; // SDK-rendered subtitle, when present
  plan?: string;        // ExitPlanMode only: full plan markdown to render
}

export interface RunnerCallbacks {
  onChat: (agentId: string, role: 'user' | 'assistant', content: string) => void;
  /** A tool_use block: `input` is the compact preview (chip), `fullInput` is the
   *  JSON-stringified raw input for the expanded view, `toolUseId` couples this
   *  call with its later tool_result. */
  onToolUse: (agentId: string, name: string, input: string | undefined, toolUseId: string, fullInput: string) => void;
  /** A tool_result block returned to the agent on the next user turn. The hotel
   *  pairs it with the matching tool message by toolUseId for the expanded view. */
  onToolResult: (agentId: string, toolUseId: string, content: string, isError: boolean) => void;
  /** A thinking block (extended reasoning). Rendered as a collapsible 💭 bubble. */
  onThinking: (agentId: string, content: string) => void;
  /** SDK emitted a `result` message — the current turn is fully consumed and the
   *  SDK is now parked on its input stream waiting for the next user turn. Used
   *  by the hotel to flip `isThinking` back off (the bash hooks miss this edge
   *  for SDK in-process agents). */
  onTurnEnd: (agentId: string) => void;
  onPermission: (agentId: string, req: PermissionRequest) => Promise<InteractionOutcome>;
  onError: (agentId: string, message: string) => void;
  onEnd: (agentId: string) => void;
}

interface Session {
  query: Query;
  input: SessionInput;
  projectId?: string;
  mode: PermissionMode;  // current permission mode (kept in sync via setMode)
}

const sessions = new Map<string, Session>();

export function isRunning(agentId: string): boolean {
  return sessions.has(agentId);
}

// Compact, human-readable preview of a tool call's input for the transcript:
// the command for Bash, the path for file tools, the pattern for search, else
// a truncated JSON of the input object.
function previewToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.prompt;
  const text = typeof pick === 'string' ? pick : JSON.stringify(o);
  return text.length > 100 ? text.slice(0, 99) + '…' : text;
}

// Full JSON of the input for the expanded view. Pretty-printed so the panel can
// drop it into a <pre> without further work; falls back to String() if input is
// already a primitive (rare — tool_use inputs are always objects in practice).
function stringifyToolInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'object') {
    try { return JSON.stringify(input, null, 2); } catch { return String(input); }
  }
  return String(input);
}

// Flatten a tool_result `content` (string | array of blocks) to a single string
// for the transcript. The SDK occasionally returns an array — e.g. for image
// results or multi-part outputs — so we walk it and keep the text parts.
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      // Non-text parts (image blocks, etc.) are kept as a hint, not the bytes.
      if (part && typeof part === 'object' && 'type' in part) return `[${(part as { type: string }).type}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// The one tool that presents a plan and asks to leave plan mode. Its input is
// `{ plan: <markdown> }`; approving it must transition the session out of plan
// mode (the SDK leaves that to the host — see requestPermission in index.ts).
const EXIT_PLAN_MODE = 'ExitPlanMode';

// Full, untruncated plan markdown carried by an ExitPlanMode call, for the hotel
// modal to render. Unlike previewToolInput (compact, 100-char cap) this keeps the
// whole plan — a truncated JSON blob is exactly the bug this fixes.
export function planFromToolInput(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName !== EXIT_PLAN_MODE) return undefined;
  return typeof input.plan === 'string' ? input.plan : undefined;
}

// True when an approved decision should drop the session out of plan mode, i.e.
// the user approved the proposed plan and wants the agent to start executing.
export function shouldExitPlanMode(toolName: string, outcome: InteractionOutcome): boolean {
  return toolName === EXIT_PLAN_MODE && outcome.outcome === 'allow';
}

// Translate the hotel user's decision into the SDK's allow/deny shape. Allow
// echoes the original input unchanged; deny/timeout become a denial with a reason.
export function outcomeToPermissionResult(outcome: InteractionOutcome, input: Record<string, unknown>): PermissionResult {
  if (outcome.outcome === 'allow') return { behavior: 'allow', updatedInput: input };
  const reason = outcome.outcome === 'deny' ? (outcome.reason ?? 'Refusé via CodeMap') : 'Aucune réponse';
  return { behavior: 'deny', message: reason };
}

// Pure dispatcher: take one SDK message, route every relevant content block to
// the right callback. Extracted from the spawnAgent pump so it can be tested
// without spinning up a real SDK session.
//
// Block coverage:
//   assistant.text       → onChat   (markdown rendered client-side)
//   assistant.tool_use   → onToolUse (compact chip + dropdown w/ full input)
//   assistant.thinking   → onThinking (collapsible 💭 bubble)
//   user.tool_result     → onToolResult (paired with its tool_use by id)
// The user turn is where the SDK loops tool outputs back in; we only forward
// tool_result blocks, never the original user text (already emitted by us via
// sendMessage → broadcastChat as a 'user' line). 'result' signals turn end — we
// forward it via onTurnEnd so the hotel can flip its "typing…" indicator off
// (bash Pre/PostToolUse hooks don't fire after the last assistant text block).
export function dispatchSdkMessage(message: unknown, agentId: string, cb: RunnerCallbacks): void {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  const m = message as { type: string };
  if (m.type === 'assistant') {
    const blocks = (message as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string; thinking?: string }> } })
      .message?.content ?? [];
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = block.text?.trim();
        if (text) cb.onChat(agentId, 'assistant', text);
      } else if (block.type === 'tool_use' && block.name && block.id) {
        cb.onToolUse(agentId, block.name, previewToolInput(block.input), block.id, stringifyToolInput(block.input));
      } else if (block.type === 'thinking') {
        const text = block.thinking?.trim();
        if (text) cb.onThinking(agentId, text);
      }
    }
  } else if (m.type === 'user') {
    const blocks = (message as { message?: { content?: unknown } }).message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          cb.onToolResult(agentId, block.tool_use_id, flattenToolResultContent(block.content), Boolean(block.is_error));
        }
      }
    }
  } else if (m.type === 'result') {
    cb.onTurnEnd(agentId);
  }
}

export function spawnAgent(
  opts: {
    agentId: string; cwd: string; projectId?: string;
    /** First user turn. Omit to spawn an idle session that parks on its input
     *  stream until `sendMessage()` delivers the user's first chat turn. */
    initialPrompt?: string;
    permissionMode?: PermissionMode; model?: string; agent?: string;
    /** Per-spawn effort level (SDK `effort`), guides thinking depth. Omit to
     *  let the SDK pick its default (adaptive on Opus 4.6+). The SDK has no
     *  runtime setter for this, so it can only be set at spawn time. */
    effort?: EffortLevel;
    /** Per-spawn thinking config (SDK `thinking`). Used to explicitly disable
     *  thinking (`{ type: 'disabled' }`) — for adaptive/enabled, prefer the
     *  default behaviour or the `effort` knob. */
    thinking?: ThinkingConfig;
  },
  cb: RunnerCallbacks,
): void {
  const { agentId, cwd, projectId, initialPrompt, permissionMode = 'default', model, agent, effort, thinking } = opts;
  const input = new SessionInput();
  // No prompt → don't push anything; the SDK stream parks on its first yield
  // until sendMessage() unblocks it with the user's first chat turn.
  if (initialPrompt) input.push(initialPrompt, agentId);

  // Route every permission check the SDK raises to the hotel modal and translate
  // the user's decision back into the SDK's allow/deny shape.
  const canUseTool: CanUseTool = async (toolName, toolInput, ctx) => {
    // Belt-and-suspenders: if the session is in bypass, never prompt — allow
    // outright (the SDK shouldn't even call us here, but mode switches at
    // runtime can be timing-sensitive).
    if (sessions.get(agentId)?.mode === 'bypassPermissions') return { behavior: 'allow', updatedInput: toolInput };
    const outcome = await cb.onPermission(agentId, {
      toolUseID: ctx.toolUseID,
      toolName,
      toolInput: previewToolInput(toolInput),
      title: ctx.title,
      description: ctx.description,
      plan: planFromToolInput(toolName, toolInput),
    });
    return outcomeToPermissionResult(outcome, toolInput);
  };

  const q = query({
    prompt: input.stream(),
    options: {
      cwd,
      sessionId: agentId,
      permissionMode,
      canUseTool,
      // Optional spawn-form picks; omitted falls back to the CLI defaults.
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      // Reasoning depth knobs (see SDK docs/effort and docs/adaptive-thinking).
      // `effort` modulates the adaptive thinking budget; `thinking` is only set
      // when the user explicitly wants to disable extended thinking entirely.
      ...(effort ? { effort } : {}),
      ...(thinking ? { thinking } : {}),
      // Opt into bypass capability up front so switching to bypassPermissions
      // mid-session actually skips checks (the active mode still governs: in
      // 'default' tools are still prompted via canUseTool).
      allowDangerouslySkipPermissions: true,
      // Surface skills as runnable slash commands (omitted ≠ "skills off", but
      // not guaranteed either) and load filesystem settings so custom project/
      // user commands appear in supportedCommands().
      skills: 'all',
      settingSources: ['user', 'project', 'local'],
    },
  });
  sessions.set(agentId, { query: q, input, projectId, mode: permissionMode });

  // Output pump: forward assistant turns to the hotel chat for this session's
  // life. Iterate content blocks IN ORDER so a tool call lands between the text
  // that precedes and follows it (not lumped after everything).
  (async () => {
    for await (const message of q) dispatchSdkMessage(message, agentId, cb);
    sessions.delete(agentId);
    cb.onEnd(agentId);
  })().catch((err: unknown) => {
    sessions.delete(agentId);
    cb.onError(agentId, err instanceof Error ? err.message : String(err));
  });
}

// Terminal-like capabilities (slash commands/skills, models, subagents) of a
// live session, for the chat autocompletion and spawn-form selectors. Returns
// undefined if the agent has no running session.
export async function getAgentCapabilities(agentId: string): Promise<AgentCapabilities | undefined> {
  const session = sessions.get(agentId);
  if (!session) return undefined;
  return fetchCapabilities(session.query, session.projectId ?? agentId);
}

// Cached capabilities for a project (populated once any of its agents has run),
// or undefined on a cold start with no live session yet.
export function getProjectCapabilities(projectId: string): AgentCapabilities | undefined {
  return getCachedCapabilities(projectId);
}

// Push a new user turn into a live session. Returns false if there's no session.
export function sendMessage(agentId: string, content: string): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  session.input.push(content, agentId);
  return true;
}

// Switch the permission mode of a live session (e.g. default → bypassPermissions).
export async function setMode(agentId: string, mode: PermissionMode): Promise<boolean> {
  const session = sessions.get(agentId);
  if (!session) return false;
  session.mode = mode;  // canUseTool reads this to short-circuit bypass
  await session.query.setPermissionMode?.(mode);
  return true;
}

// Switch the model of a live session. Empty / 'default' resets to the CLI default.
export async function setModel(agentId: string, model?: string): Promise<boolean> {
  const session = sessions.get(agentId);
  if (!session) return false;
  const target = model && model !== 'default' ? model : undefined;
  await session.query.setModel?.(target);
  return true;
}

// Tune the live session's thinking budget. The SDK has no `setEffort`, only
// the deprecated `setMaxThinkingTokens(n|null)`: that's the only runtime knob,
// so we use it and accept its quirks (on Opus 4.6+ it is on/off only — see
// effortToMaxThinkingTokens for the mapping rationale).
//
// `tokens === null` clears the limit (back to the model's default behaviour);
// `tokens === 0` disables extended thinking outright; positive N is the budget
// for models that read it as such. Returns false if there's no live session
// or the SDK build doesn't expose the setter.
export async function setMaxThinkingTokens(agentId: string, tokens: number | null): Promise<boolean> {
  const session = sessions.get(agentId);
  if (!session) return false;
  if (!session.query.setMaxThinkingTokens) return false;
  await session.query.setMaxThinkingTokens(tokens);
  return true;
}

// Interrupt and close a session.
export async function stopAgent(agentId: string): Promise<boolean> {
  const session = sessions.get(agentId);
  if (!session) return false;
  try {
    await session.query.interrupt?.();
  } catch { /* already stopping */ }
  session.input.close();
  sessions.delete(agentId);
  return true;
}
