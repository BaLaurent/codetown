import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { WebSocketManager } from './websocket.js';
import { WebSocketServer, WebSocket } from 'ws';
import { ttyManager } from './tty-manager.js';
import os from 'os';
import { ProjectRegistry } from './project-registry.js';
import { deriveProjectFromPath, deriveProjectFromDir } from './project-identity.js';
import { listSubdirectories } from './fs-browse.js';
import { getHotFolders, clearCache as clearGitCache } from './git-activity.js';
import { randomUUID } from 'node:crypto';
import { FileActivityEvent, ThinkingEvent, AgentThinkingState, InteractionOutcome, ChatMessage } from './types.js';
import { appendChatMessage, getTranscript, clearTranscripts } from './transcript-store.js';
import { attachmentDir, reserveAttachmentPath } from './attachments.js';
import { fileFromActivityEvent } from './agent-file.js';
import { registerRequest, awaitDecision, resolveRequest, resolveAgentRequests } from './pending-requests.js';
import { shouldFlagWaitingForPermission, clearPendingInteraction } from './pending-interaction.js';
import { spawnAgent, sendMessage as runnerSendMessage, stopAgent, getAgentCapabilities, getProjectCapabilities, setMode as runnerSetMode, setModel as runnerSetModel, setMaxThinkingTokens as runnerSetMaxThinkingTokens, isRunning, shouldExitPlanMode, type PermissionRequest } from './agent-runner/index.js';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { resolveEffortOptions, effortToMaxThinkingTokens, isEffortValue } from './effort-options.js';

const PORT = 5174; // Fixed port - never change

// PROJECT_ROOT: Use env var, command line arg, or detect from cwd
// If running from server/ subdirectory, go up to find the actual project root
function detectProjectRoot(): string {
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  if (process.argv[2]) return process.argv[2];

  const cwd = process.cwd();
  // If we're in a 'server' subdirectory of a workspace, go up one level
  if (cwd.endsWith('/server') || cwd.endsWith('\\server')) {
    return path.dirname(cwd);
  }
  return cwd;
}

// Fallback project identity for events arriving without project fields (old hooks).
const FALLBACK_PROJECT_ID = detectProjectRoot();

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wsManager = new WebSocketManager(server);

// TTY WebSocket — noServer mode, same pattern as wsManager
const ttyWss = new WebSocketServer({ noServer: true });

// Single upgrade handler routes /ws → wsManager, /ws/tty/* → ttyWss.
// Both WS servers use noServer:true so neither calls abortHandshake on the other's paths.
server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  const path = url.split('?')[0];
  if (path === '/ws') {
    wsManager.handleUpgrade(req, socket, head);
    return;
  }
  if (!path.startsWith('/ws/tty/')) return;
  ttyWss.handleUpgrade(req, socket, head, (ws) => {
    const ttyId = path.slice('/ws/tty/'.length);
    const session = ttyManager.get(ttyId);
    if (!session) {
      ws.close(4004, 'TTY not found');
      return;
    }
    // Replay buffered output so the client doesn't miss the initial shell prompt
    if (session.outputBuffer) ws.send(session.outputBuffer);
    const dataDisposable = session.pty.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    session.pty.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        ws.close();
      }
    });
    ws.on('message', (raw: Buffer) => {
      let msg: unknown;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { type?: string; data?: string; cols?: number; rows?: number };
      if (m.type === 'input' && typeof m.data === 'string') session.pty.write(m.data);
      else if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number' && Number.isInteger(m.cols) && m.cols > 0 && m.cols < 1000 && Number.isInteger(m.rows) && m.rows > 0 && m.rows < 500) session.pty.resize(m.cols, m.rows);
    });
    ws.on('close', () => dataDisposable.dispose());
  });
});

// One workspace per project (building). Discovered lazily from incoming events.
const registry = new ProjectRegistry();
registry.onGraphChange((projectId, graphData) => {
  wsManager.broadcast('graph', graphData, projectId);
});

// Resolve project identity from a thinking request body (no file path available).
// Trusts the hook's projectId when present; otherwise undefined so the caller can
// inherit the agent's already-known building rather than clobbering it.
function projectFieldsOf(body: { projectId?: string; projectRoot?: string; projectName?: string }) {
  if (!body.projectId && !body.projectRoot) return undefined;
  const projectRoot = body.projectRoot || (body.projectId as string);
  const projectId = body.projectId || projectRoot;
  const projectName = body.projectName || path.basename(projectRoot);
  return { projectId, projectRoot, projectName };
}

// Resolve project identity for an ACTIVITY event. Prefers the hook's projectId,
// but when the hook is old/foreign (no projectId), derives the building from the
// absolute file path via git — so a project running stale hooks still gets its
// own building instead of falling into the server's own root.
function activityProjectFields(event: FileActivityEvent) {
  const fromBody = projectFieldsOf(event);
  if (fromBody) return fromBody;
  const derived = deriveProjectFromPath(event.filePath, event.type.startsWith('search'));
  if (derived) return derived;
  return { projectId: FALLBACK_PROJECT_ID, projectRoot: FALLBACK_PROJECT_ID, projectName: path.basename(FALLBACK_PROJECT_ID) };
}

// Track thinking state per agent
const agentStates = new Map<string, AgentThinkingState>();
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_AGENTS = 30; // HARD LIMIT - town-wide across all projects (~10 projects x 3 agents)
const AGENT_CREATION_COOLDOWN_MS = 500; // Minimum time between new agent registrations
let lastAgentCreationTime = 0;

// Permission prompt detection - if PreToolUse received but no PostToolUse after this time,
// agent is likely waiting for user permission. Use a high threshold (60s) to avoid false
// positives from slow-running tools (npm test, builds, long bash commands, etc.)
// For immediate detection, AskUserQuestion is handled separately.
const WAITING_FOR_INPUT_THRESHOLD_MS = 60000;

// Debug/observability tracking
const SERVER_START_TIME = Date.now();
const recentActivityBuffer: Array<{ type: string; filePath: string; agentId?: string; timestamp: number }> = [];
const MAX_ACTIVITY_BUFFER = 50;

// Agent state persistence — central, not per-project (agents carry their projectId)
const STATE_DIR = path.join(os.homedir(), '.codemap');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

function saveAgentState(): void {
  try {
    const state = {
      savedAt: Date.now(),
      agents: Array.from(agentStates.values()),
      pinnedProjects: registry.listPinned(),
    };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save agent state:', err);
  }
}

function loadAgentState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const now = Date.now();

      // Only restore agents that haven't timed out
      for (const agent of data.agents || []) {
        if (now - agent.lastActivity < AGENT_TIMEOUT_MS) {
          agentStates.set(agent.agentId, agent);
        }
      }

      for (const p of data.pinnedProjects || []) {
        if (p && typeof p.projectRoot === 'string' && fs.existsSync(p.projectRoot)) {
          registry.getOrCreate(p.projectId, p.projectRoot, p.projectName);
          registry.setPinned(p.projectId, true);
        }
      }

      console.log(`[${new Date().toISOString()}] Restored ${agentStates.size} agents from state file`);
    }
  } catch (err) {
    console.error('Failed to load agent state:', err);
  }
}

// Save state every 30 seconds
setInterval(saveAgentState, 30000);

// Validate agent ID format - must be a valid UUID (session_id format)
function isValidAgentId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

// Find the next available number for a source (fills gaps from removed agents)
function getNextAgentNumber(source: 'claude' | 'cursor' | 'unknown'): number {
  const usedNumbers = new Set<number>();
  for (const state of agentStates.values()) {
    if (state.source === source) {
      const match = state.displayName.match(/(\d+)$/);
      if (match) {
        usedNumbers.add(parseInt(match[1], 10));
      }
    }
  }
  // Find the lowest available number starting from 1
  let num = 1;
  while (usedNumbers.has(num)) {
    num++;
  }
  return num;
}

// Safe agent registration with multiple protections
function registerAgent(
  agentId: string,
  timestamp: number,
  eventSource: string,  // Where this event came from (activity/thinking)
  agentSource: 'claude' | 'cursor' | 'unknown' = 'unknown'  // Which tool (Claude/Cursor)
): AgentThinkingState | null {
  // PROTECTION 1: Validate agent ID format
  if (!isValidAgentId(agentId)) {
    console.log(`[${new Date().toISOString()}] REJECTED invalid agent ID: ${agentId} (${eventSource})`);
    return null;
  }

  // Check if agent already exists
  let state = agentStates.get(agentId);
  if (state) {
    return state; // Already registered, return existing
  }

  // PROTECTION 2: Hard limit on total agents
  if (agentStates.size >= MAX_AGENTS) {
    console.log(`[${new Date().toISOString()}] REJECTED new agent - at max capacity (${MAX_AGENTS}): ${agentId}`);
    return null;
  }

  // PROTECTION 3: Rate limiting - prevent rapid agent creation
  const now = Date.now();
  if (now - lastAgentCreationTime < AGENT_CREATION_COOLDOWN_MS) {
    console.log(`[${new Date().toISOString()}] REJECTED new agent - rate limited: ${agentId}`);
    return null;
  }

  // All checks passed - create the agent with source-specific name
  lastAgentCreationTime = now;
  const agentNumber = getNextAgentNumber(agentSource);

  // Name based on source: "Claude Code 1", "Cursor 1", etc.
  const sourceName = agentSource === 'claude' ? 'Claude Code' :
                     agentSource === 'cursor' ? 'Cursor' : 'Agent';
  const displayName = `${sourceName} ${agentNumber}`;

  state = {
    agentId,
    source: agentSource,
    isThinking: false,
    lastActivity: timestamp,
    displayName,
    currentCommand: undefined
  };
  agentStates.set(agentId, state);
  console.log(`[${new Date().toISOString()}] New agent registered: ${displayName} (${agentId.slice(0, 8)}) [${eventSource}]`);
  return state;
}

// Cleanup stale agents periodically
setInterval(() => {
  const now = Date.now();
  let removedAny = false;
  for (const [agentId, state] of agentStates) {
    if (now - state.lastActivity > AGENT_TIMEOUT_MS) {
      console.log(`[${new Date().toISOString()}] Removing stale agent: ${state.displayName} (${agentId})`);
      agentStates.delete(agentId);
      removedAny = true;
    }
  }
  // Broadcast updated state if any agents were removed
  if (removedAny) {
    refreshAgentCounts();
    wsManager.broadcast('thinking', getAgentStatesArray());
  }
}, 60000); // Check every minute

// Periodic sync broadcast - ensures client stays in sync even if events are missed
// Also detects agents waiting for permission (stuck in PreToolUse state)
setInterval(() => {
  if (agentStates.size > 0) {
    const now = Date.now();

    // Check for agents stuck waiting for permission
    for (const state of agentStates.values()) {
      if (shouldFlagWaitingForPermission(state, now, WAITING_FOR_INPUT_THRESHOLD_MS)) {
        state.waitingForInput = true;
        console.log(`[${new Date().toISOString()}] Agent ${state.displayName} appears to be waiting for permission (${now - state.pendingToolStart!}ms)`);
      }
    }

    wsManager.broadcast('thinking', getAgentStatesArray());
  }
}, 2000); // Sync every 2 seconds

// Spawned agents carry a derived `running` flag (is the SDK session still live?)
// computed here at the serialization boundary, so it is never written to the
// persisted state file. The client uses it as the authoritative "session ended"
// signal instead of guessing from the transcript.
function getAgentStatesArray(): AgentThinkingState[] {
  return Array.from(agentStates.values()).map(s =>
    s.spawned ? { ...s, running: isRunning(s.agentId) } : s
  );
}

// Recompute per-building agent counts from current agent states.
function refreshAgentCounts(): void {
  for (const info of registry.list()) {
    const w = registry.get(info.projectId);
    if (w) w.agentCount = 0;
  }
  for (const s of agentStates.values()) {
    if (s.projectId) {
      const w = registry.get(s.projectId);
      if (w) w.agentCount++;
    }
  }
}

// Receive activity events from hook script
app.post('/api/activity', (req, res) => {
  const event: FileActivityEvent = req.body;
  console.log(`[${new Date().toISOString()}] ${event.type.toUpperCase()}: ${event.filePath}${event.agentId ? ` (${event.agentId.slice(0, 8)})` : ''}`);

  const { projectId, projectRoot, projectName } = activityProjectFields(event);
  const ws = registry.getOrCreate(projectId, projectRoot, projectName);
  ws.lastActivity = Date.now();

  // Track in debug buffer
  recentActivityBuffer.push({
    type: event.type,
    filePath: registry.toRelativePath(projectId, event.filePath),
    agentId: event.agentId,
    timestamp: Date.now()
  });
  if (recentActivityBuffer.length > MAX_ACTIVITY_BUFFER) {
    recentActivityBuffer.shift();
  }

  // Register or get existing agent using safe registration
  if (event.agentId) {
    const now = Date.now();
    const state = registerAgent(event.agentId, now, 'activity', event.source || 'unknown');
    if (state) {
      // Always update last activity timestamp to keep agent alive
      // Use server time (Date.now()), not hook timestamp which can be stale
      state.lastActivity = now;
      state.projectId = projectId;

      // Update current command and thinking state based on activity type
      if (event.type.endsWith('-start')) {
        state.currentCommand = event.type.startsWith('read') ? 'Read' :
                               event.type.startsWith('write') ? 'Write' : 'Grep';
        state.isThinking = true;
      } else if (event.type.endsWith('-end')) {
        // Keep command visible but mark as not actively thinking
        state.isThinking = false;
      }

      // Record the agent's current file (relative). Search events are not files;
      // they leave currentFile sticky so the agent stays at its last real file.
      const relFile = fileFromActivityEvent(
        event.type,
        registry.toRelativePath(projectId, event.filePath)
      );
      if (relFile) state.currentFile = relFile;

      refreshAgentCounts();
      // Always broadcast agent state on activity to keep client in sync
      wsManager.broadcast('thinking', getAgentStatesArray());
    }
  }

  const graphData = ws.store.addActivity(event);

  // Broadcast to all connected clients with relative path for client matching
  const clientEvent = {
    ...event,
    filePath: registry.toRelativePath(projectId, event.filePath)
  };
  wsManager.broadcast('activity', clientEvent, projectId);
  wsManager.broadcast('graph', graphData, projectId);

  res.status(200).json({ success: true });
});

// Receive thinking events
app.post('/api/thinking', (req, res) => {
  const event: ThinkingEvent = req.body;
  const { agentId, type, toolName, toolInput, question, agentType, model, duration, status } = event;
  const now = Date.now();

  // Register or get existing agent using safe registration
  const state = registerAgent(agentId, now, 'thinking', event.source || 'unknown');
  if (!state) {
    // Agent registration was rejected - still return success to not block hooks
    res.status(200).json({ success: true, rejected: true });
    return;
  }

  // Tag the agent's building from the hook when it provides one. When it does
  // not (old/foreign hook), keep whatever building activity events established —
  // never clobber a known projectId with the server's fallback root.
  const tf = projectFieldsOf(event);
  if (tf) {
    state.projectId = tf.projectId;
    registry.getOrCreate(tf.projectId, tf.projectRoot, tf.projectName).lastActivity = now;
  }

  // Handle agent-stop events (from Cursor stop hook)
  if (type === 'agent-stop') {
    if (status) {
      state.status = status;
      state.statusTimestamp = now;
      state.isThinking = false;
      console.log(`[${new Date().toISOString()}] AGENT-STOP: ${state.displayName} status=${status}`);
    }
    wsManager.broadcast('thinking', getAgentStatesArray());
    res.status(200).json({ success: true });
    return;
  }

  state.isThinking = type === 'thinking-start';
  // Use server time (Date.now()), not hook timestamp which can be stale
  state.lastActivity = now;

  // Update current command on BOTH events:
  // - thinking-end (PreToolUse): tool is STARTING - set command so we show it during execution
  // - thinking-start (PostToolUse): tool has COMPLETED - update to show what just finished
  if (toolName) {
    state.currentCommand = toolName;
  }

  // Update tool input for display in bubble
  if (toolInput) {
    state.toolInput = toolInput;
  } else if (type === 'thinking-start') {
    // Clear tool input when tool completes
    state.toolInput = undefined;
  }

  // Update the agent's pending question (from AskUserQuestion). Set when the
  // tool starts, cleared when it completes — same lifecycle as waitingForInput.
  if (question) {
    state.question = question;
  } else if (type === 'thinking-start') {
    state.question = undefined;
  }

  // Update agent type if provided (persists for agent lifetime)
  if (agentType) {
    state.agentType = agentType;
    // Update display name to include agent type: "Claude Code Plan 1" instead of "Claude Code 1"
    const sourceName = state.source === 'claude' ? 'Claude Code' :
                       state.source === 'cursor' ? 'Cursor' : 'Agent';
    const typeLabel = agentType.charAt(0).toUpperCase() + agentType.slice(1);
    const num = state.displayName.match(/\d+$/)?.[0] || '1';
    state.displayName = `${sourceName} ${typeLabel} ${num}`;
  }

  // Update model if provided (Cursor provides this, persists for agent lifetime)
  if (model && !state.model) {
    state.model = model;
    console.log(`[${new Date().toISOString()}] Agent ${state.displayName} using model: ${model}`);
  }

  // Update duration if provided (from afterShellExecution, afterMCPExecution)
  if (duration !== undefined && duration !== null) {
    state.lastDuration = duration;
  }

  // Clear status after activity resumes (agent is working again)
  if (state.status && type === 'thinking-end') {
    state.status = undefined;
    state.statusTimestamp = undefined;
  }

  // Track pending tool execution for permission prompt detection
  if (type === 'thinking-end') {
    // PreToolUse - tool is starting, track when it started
    state.pendingToolStart = now;
    // Immediately set waitingForInput for AskUserQuestion (user must answer)
    if (toolName === 'AskUserQuestion') {
      state.waitingForInput = true;
      console.log(`[${new Date().toISOString()}] Agent ${state.displayName} waiting for user input (AskUserQuestion)`);
    }
  } else if (type === 'thinking-start') {
    // PostToolUse - tool completed, clear pending state
    state.pendingToolStart = undefined;
    state.waitingForInput = false;
  }

  const durationStr = duration ? ` (${duration}ms)` : '';
  console.log(`[${new Date().toISOString()}] ${type.toUpperCase()}: ${state.displayName} ${toolName ? `(${toolName})` : ''}${toolInput ? ` [${toolInput}]` : ''}${durationStr}`);

  // Broadcast all agent states to connected clients
  refreshAgentCounts();
  wsManager.broadcast('thinking', getAgentStatesArray());

  res.status(200).json({ success: true });
});

// Get all agent thinking states
app.get('/api/thinking', (_req, res) => {
  res.json(getAgentStatesArray());
});

// --- Interactive answers / permissions (Phase B) ---------------------------
// A blocking hook registers a pending interaction here, then long-polls
// /pending-permission for the user's decision made in the hotel.

// Hook registers a request. Fast-defer (204) when nobody is watching the hotel,
// so terminals never freeze waiting on an answer no one can give.
app.post('/api/agent/:agentId/permission-request', (req, res) => {
  const { agentId } = req.params;
  if (!isValidAgentId(agentId)) {
    res.status(400).json({ error: 'invalid agentId' });
    return;
  }
  if (wsManager.getClientCount() === 0) {
    res.status(204).end();   // no client → hook defers to the terminal's native prompt
    return;
  }
  const requestId: string | undefined = req.body?.requestId;
  if (!requestId) {
    res.status(400).json({ error: 'requestId required' });
    return;
  }
  const kind: 'question' | 'permission' = req.body?.kind === 'permission' ? 'permission' : 'question';
  const toolName: string | undefined = req.body?.toolName;
  const toolInput: string | undefined = req.body?.toolInput;
  registerRequest(agentId, requestId);
  // Mark the agent as awaiting input so its bubble flags it immediately.
  const state = agentStates.get(agentId);
  if (state) {
    state.waitingForInput = true;
    wsManager.broadcast('thinking', getAgentStatesArray());
  }
  wsManager.broadcast('permission-request', { agentId, requestId, kind, toolName, toolInput });
  res.status(200).json({ registered: true });
});

// Hook long-polls for the decision (held open up to maxWaitMs, then 'timeout').
app.get('/api/agent/:agentId/pending-permission', async (req, res) => {
  const { agentId } = req.params;
  const requestId = String(req.query.requestId ?? '');
  // Cap under Claude Code's ~600s hook timeout; the hook asks for 5 min.
  const maxWaitMs = Math.min(Number(req.query.maxWaitMs) || 30000, 590000);
  const outcome = await awaitDecision(agentId, requestId, maxWaitMs);
  res.status(200).json(outcome);
});

// Hotel sends the user's decision (answer / allow / deny), releasing the hook.
app.post('/api/agent/:agentId/permission', (req, res) => {
  const { agentId } = req.params;
  const requestId: string | undefined = req.body?.requestId;
  const outcome: InteractionOutcome | undefined = req.body?.outcome;
  if (!requestId || !outcome) {
    res.status(400).json({ error: 'requestId and outcome required' });
    return;
  }
  const resolved = resolveRequest(agentId, requestId, outcome);
  if (resolved) {
    // Lift the pending-interaction flags now that the user has decided. Clearing
    // pendingToolStart is essential: an answered AskUserQuestion is denied, so no
    // PostToolUse fires — leaving it set lets the periodic detector re-raise the
    // already-answered question seconds later.
    const state = agentStates.get(agentId);
    if (state) {
      clearPendingInteraction(state);
      wsManager.broadcast('thinking', getAgentStatesArray());
    }
    wsManager.broadcast('permission-resolved', { agentId, requestId });
  }
  res.status(200).json({ resolved });
});

// --- Hotel-spawned agents (Phase C) ----------------------------------------
// Spawn a Claude agent in-process and chat with it from the hotel. Its own hooks
// report under the forced sessionId, so it shows up as a normal hotel character.
// Single chat-line emitter: every shape (assistant text, tool_use, thinking,
// tool_result) goes through here so the transcript store and the WS broadcast
// stay in lockstep. `extra` carries the role-specific top-level fields
// (toolUseId/isError on tool_result) while `tool` carries tool_use details.
function broadcastChat(
  agentId: string,
  role: ChatMessage['role'],
  content: string,
  tool?: ChatMessage['tool'],
  extra?: { toolUseId?: string; isError?: boolean },
): void {
  const msg: ChatMessage = {
    agentId, role, content, timestamp: Date.now(),
    ...(tool ? { tool } : {}),
    ...(extra?.toolUseId ? { toolUseId: extra.toolUseId } : {}),
    ...(extra?.isError ? { isError: true } : {}),
  };
  appendChatMessage(msg);
  wsManager.broadcast('chat', msg);
}

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
// Up to 10 min for a human to decide in the hotel (the 30s default in
// pending-requests suits a terminal hook with a queued answer, not a person).
const PERMISSION_WAIT_MS = 600000;

// Bridge the SDK's canUseTool callback to the existing hotel interaction flow:
// register the request, flag the agent as waiting, broadcast it, then await the
// user's decision (or deny on timeout / when no client is watching).
async function requestPermission(agentId: string, req: PermissionRequest): Promise<InteractionOutcome> {
  if (wsManager.getClientCount() === 0) return { outcome: 'deny', reason: 'Aucun client hôtel pour décider' };
  registerRequest(agentId, req.toolUseID);
  const state = agentStates.get(agentId);
  if (state) { state.waitingForInput = true; wsManager.broadcast('thinking', getAgentStatesArray()); }
  wsManager.broadcast('permission-request', {
    agentId, requestId: req.toolUseID, kind: 'permission',
    toolName: req.toolName, toolInput: req.toolInput, title: req.title, description: req.description, plan: req.plan,
  });
  const outcome = await awaitDecision(agentId, req.toolUseID, PERMISSION_WAIT_MS);
  // Approving ExitPlanMode leaves plan mode. The CLI already drops the live
  // session to a prompting mode on approval (verified: subsequent writes still
  // hit canUseTool), but it never tells us — so without this the chat header
  // would keep showing "plan" while the agent executes. Pin 'default' on the SDK
  // session AND mirror it into the hotel state so the two agree. (The set runs
  // concurrently with the pending canUseTool — measured at ~0.1s, no deadlock.)
  if (shouldExitPlanMode(req.toolName, outcome)) {
    await runnerSetMode(agentId, 'default');
    if (state) state.permissionMode = 'default';
  }
  if (state) { clearPendingInteraction(state); wsManager.broadcast('thinking', getAgentStatesArray()); }
  // On timeout the POST /permission handler never ran, so close any open modal.
  if (outcome.outcome === 'timeout') wsManager.broadcast('permission-resolved', { agentId, requestId: req.toolUseID });
  return outcome;
}

app.post('/api/agent/spawn', (req, res) => {
  const { projectId, cwd, initialPrompt, permissionMode, model, agent, effort } = req.body ?? {};
  // initialPrompt is optional: empty/missing → spawn an idle session that waits
  // for its first chat turn. Reject only non-string values to catch obvious bugs.
  if (initialPrompt !== undefined && typeof initialPrompt !== 'string') {
    res.status(400).json({ error: 'initialPrompt must be a string' });
    return;
  }
  const firstTurn = typeof initialPrompt === 'string' && initialPrompt.length > 0 ? initialPrompt : undefined;
  const mode: PermissionMode = PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'default';
  const agentId = randomUUID();
  // Resolve the working directory: an explicit cwd wins; otherwise spawn inside
  // the open building. projectId is the project root in our identity scheme, but
  // prefer the registry's authoritative projectRoot when the workspace is known.
  const ws = typeof projectId === 'string' ? registry.get(projectId) : undefined;
  const workdir = (typeof cwd === 'string' && cwd)
    ? cwd
    : ws?.projectRoot ?? (typeof projectId === 'string' && projectId ? projectId : FALLBACK_PROJECT_ID);
  // Pre-register so the character appears right away; hooks then animate it.
  const state = registerAgent(agentId, Date.now(), 'thinking', 'claude');
  if (!state) {
    res.status(429).json({ error: 'could not register agent (rate limit or capacity)' });
    return;
  }
  if (typeof projectId === 'string') state.projectId = projectId;
  state.spawned = true;  // chattable from the roster
  state.permissionMode = mode;  // shown in the chat header
  if (typeof model === 'string' && model) state.model = model;
  // Remember the spawn-form effort so the chat panel's selector reflects it
  // straight away; the runtime POST /effort updates this later.
  if (isEffortValue(effort)) state.effort = effort;
  // Spawn with a first turn → the agent is busy immediately (same reason as
  // POST /message). Idle spawn (no firstTurn) stays isThinking=false.
  if (firstTurn) state.isThinking = true;
  refreshAgentCounts();
  wsManager.broadcast('thinking', getAgentStatesArray());

  if (firstTurn) broadcastChat(agentId, 'user', firstTurn);
  const effortOpts = resolveEffortOptions(effort);
  spawnAgent(
    {
      agentId, cwd: workdir, projectId: typeof projectId === 'string' ? projectId : undefined,
      initialPrompt: firstTurn, permissionMode: mode,
      model: typeof model === 'string' && model ? model : undefined,
      agent: typeof agent === 'string' && agent ? agent : undefined,
      ...effortOpts,
    },
    {
      onChat: (id, role, content) => broadcastChat(id, role, content),
      onToolUse: (id, name, input, toolUseId, fullInput) =>
        broadcastChat(id, 'tool', '', { name, input, toolUseId, fullInput }),
      onToolResult: (id, toolUseId, content, isError) =>
        broadcastChat(id, 'tool_result', content, undefined, { toolUseId, isError }),
      onThinking: (id, content) => broadcastChat(id, 'thinking', content),
      // SDK `result` message → turn is fully consumed. Flip isThinking off here
      // (the bash Pre/PostToolUse hooks miss the trailing edge for SDK in-process
      // agents — they fire AROUND tool calls, not at end-of-turn).
      onTurnEnd: (id) => {
        const s = agentStates.get(id);
        if (s && s.isThinking) {
          s.isThinking = false;
          wsManager.broadcast('thinking', getAgentStatesArray());
        }
      },
      onPermission: (id, request) => requestPermission(id, request),
      onError: (id, message) => {
        console.error(`[${new Date().toISOString()}] agent ${id} SDK session crashed: ${message}`);
        broadcastChat(id, 'system', "⚠️ La session a planté côté SDK et s'est arrêtée. Spawn un nouvel agent pour continuer.");
        wsManager.broadcast('thinking', getAgentStatesArray());
      },
      // onEnd/onError both fire after the runner deleted the session, so isRunning
      // now reports false: re-broadcast state so the chat input disables at once
      // (instead of lagging until the next thinking broadcast).
      onEnd: (id) => {
        broadcastChat(id, 'system', '— session terminée —');
        wsManager.broadcast('thinking', getAgentStatesArray());
      },
    },
  );
  console.log(`[${new Date().toISOString()}] SPAWNED agent ${state.displayName} (${agentId}) in ${workdir}`);
  res.status(200).json({ agentId });
});

// Terminal-like capabilities of a live session: slash commands + skills (for the
// chat "/" popover), available models and subagents. 404 when no session.
app.get('/api/agent/:agentId/capabilities', async (req, res) => {
  const { agentId } = req.params;
  try {
    const caps = await getAgentCapabilities(agentId);
    if (!caps) {
      res.status(404).json({ error: 'no live session for agent' });
      return;
    }
    res.json(caps);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// User-uploaded attachments from the hotel chat. Files land in
// /tmp/codemap-attachments/<agentId>/ and the client mentions the absolute
// path in the next message so the agent reads them via its normal file tools.
// Cap: 10 files per request, 25 MB each — big enough for screenshots/CSVs,
// small enough that we can keep them in memory before writing.
const attachUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 10, fileSize: 25 * 1024 * 1024 },
});

// Translate multer's stream errors (wrong field name, file too big, too many
// files) into the same JSON 400 shape the rest of the route returns, instead
// of Express's default HTML stack trace page.
const attachMiddleware: express.RequestHandler = (req, res, next) => {
  attachUpload.array('files', 10)(req, res, (err: unknown) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    next();
  });
};

app.post('/api/agent/:agentId/attach', attachMiddleware, (req, res) => {
  const { agentId } = req.params;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: 'no files in upload (expected multipart field "files")' });
    return;
  }
  const dir = attachmentDir(agentId);
  const paths: string[] = [];
  try {
    for (const f of files) {
      // multer gives us latin1-encoded filenames; re-decode as UTF-8 so
      // accented names ("résumé.pdf") survive the round trip.
      const original = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const dest = reserveAttachmentPath(dir, original);
      fs.writeFileSync(dest, f.buffer);
      paths.push(dest);
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.json({ paths });
});

// Push a new user turn into a live spawned session.
app.post('/api/agent/:agentId/message', (req, res) => {
  const { agentId } = req.params;
  const content = req.body?.content;
  if (!content || typeof content !== 'string') {
    res.status(400).json({ error: 'content required' });
    return;
  }
  broadcastChat(agentId, 'user', content);
  const ok = runnerSendMessage(agentId, content);
  // Mark the agent as busy as soon as the user submits — bash hooks only fire
  // around tool calls, which is too late for the "typing…" indicator to show
  // during the gap before the first assistant block. Mirror at onTurnEnd.
  if (ok) {
    const s = agentStates.get(agentId);
    if (s && !s.isThinking) {
      s.isThinking = true;
      wsManager.broadcast('thinking', getAgentStatesArray());
    }
  }
  res.status(200).json({ ok });
});

// Return the full chat transcript for a hotel-spawned agent.
// Always 200 with an empty array when the agent is unknown or has been cleared,
// so the client can use this endpoint for post-mortem replay after a kill.
app.get('/api/agent/:agentId/transcript', (req, res) => {
  res.json(getTranscript(req.params.agentId));
});

// Switch a live session's permission mode (e.g. arm/disarm the hotel modal).
app.post('/api/agent/:agentId/mode', async (req, res) => {
  const { agentId } = req.params;
  const mode = req.body?.mode;
  if (!PERMISSION_MODES.includes(mode)) {
    res.status(400).json({ error: 'invalid mode' });
    return;
  }
  const ok = await runnerSetMode(agentId, mode);
  if (ok) {
    const state = agentStates.get(agentId);
    if (state) { state.permissionMode = mode; }
    // Switching to bypass means "trust it" — let any tool already awaiting a
    // decision through, instead of leaving it stuck until timeout.
    if (mode === 'bypassPermissions') {
      for (const requestId of resolveAgentRequests(agentId, { outcome: 'allow' })) {
        wsManager.broadcast('permission-resolved', { agentId, requestId });
      }
      if (state) clearPendingInteraction(state);
    }
    wsManager.broadcast('thinking', getAgentStatesArray());
  }
  res.status(200).json({ ok });
});

// Tune a live session's thinking effort. The SDK has no setEffort, so under the
// hood we map the user's effort label to a max-thinking-tokens budget and call
// the (deprecated-but-only) Query.setMaxThinkingTokens. On Opus 4.6+ the SDK
// treats it as on/off; on older models the budget gradient takes effect. The
// chat panel's tooltip mentions this so the user isn't misled.
app.post('/api/agent/:agentId/effort', async (req, res) => {
  const { agentId } = req.params;
  const effort = req.body?.effort;
  if (!isEffortValue(effort)) {
    res.status(400).json({ error: `effort must be one of default|low|medium|high|xhigh|max|off` });
    return;
  }
  const tokens = effortToMaxThinkingTokens(effort);
  // effortToMaxThinkingTokens returns undefined ONLY when the input isn't a
  // known effort — isEffortValue already rejected that case, so this is unreachable
  // in normal flow. Belt-and-suspenders: treat it as a no-op rather than crash.
  if (tokens === undefined) { res.status(200).json({ ok: false }); return; }
  const ok = await runnerSetMaxThinkingTokens(agentId, tokens);
  if (ok) {
    const state = agentStates.get(agentId);
    if (state) { state.effort = effort; wsManager.broadcast('thinking', getAgentStatesArray()); }
  }
  res.status(200).json({ ok });
});

// Switch a live session's model (empty string → CLI default).
app.post('/api/agent/:agentId/model', async (req, res) => {
  const { agentId } = req.params;
  const model = req.body?.model;
  if (typeof model !== 'string') {
    res.status(400).json({ error: 'model required (use "" for default)' });
    return;
  }
  const ok = await runnerSetModel(agentId, model);
  if (ok) {
    const state = agentStates.get(agentId);
    if (state) { state.model = model || undefined; wsManager.broadcast('thinking', getAgentStatesArray()); }
  }
  res.status(200).json({ ok });
});

// Kill an agent: end its SDK session (if any) AND clear its hotel character so
// it doesn't linger. Safe for external agents (no session) — the character is
// still removed and the death animation plays. Used by the stop route and by
// building removal.
async function killAgent(agentId: string): Promise<boolean> {
  const ok = await stopAgent(agentId);
  if (agentStates.delete(agentId)) {
    refreshAgentCounts();
    saveAgentState();
    wsManager.broadcast('thinking', getAgentStatesArray());
    wsManager.broadcast('agent-killed', { agentId });
  }
  return ok;
}

app.post('/api/agent/:agentId/stop', async (req, res) => {
  res.status(200).json({ ok: await killAgent(req.params.agentId) });
});

// List all known projects (buildings in the town)
app.get('/api/projects', (_req, res) => {
  res.json(registry.list());
});

// Folder browser: list the sub-directories of a path so the town can pick a
// folder to raise as a building. Defaults to the home directory.
app.get('/api/fs/list', (req, res) => {
  const q = typeof req.query.path === 'string' ? req.query.path : '';
  if (q && (!path.isAbsolute(q) || !fs.existsSync(q) || !fs.statSync(q).isDirectory())) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  try {
    res.json(listSubdirectories(q));
  } catch {
    res.status(400).json({ error: 'cannot read directory' });
  }
});

// Pin a folder as a persistent building. Idempotent: pinning an already-tracked
// project only flips its flag.
app.post('/api/projects', (req, res) => {
  const dir = (req.body ?? {}).path;
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  const fields = deriveProjectFromDir(dir);
  if (!fields) {
    res.status(400).json({ error: 'not a project directory' });
    return;
  }
  registry.getOrCreate(fields.projectId, fields.projectRoot, fields.projectName);
  registry.setPinned(fields.projectId, true);
  saveAgentState();
  res.status(200).json(registry.list().find(p => p.projectId === fields.projectId));
});

// Remove a building. With live agents and no ?kill=true, refuse (409) so the API
// is not a footgun; the client pre-empts this by showing a kill-confirm modal.
app.delete('/api/projects/:id', async (req, res) => {
  const id = req.params.id;
  const agents = getAgentStatesArray().filter(a => a.projectId === id);
  if (agents.length > 0 && req.query.kill !== 'true') {
    res.status(409).json({ agents });
    return;
  }
  for (const a of agents) await killAgent(a.agentId);
  registry.remove(id);
  saveAgentState();
  res.status(200).json({ ok: true });
});

// Cached capabilities for a project's spawn-form selectors (models, subagents,
// commands). Empty on a cold start with no live agent yet; the client then
// falls back to its defaults.
app.get('/api/projects/:projectId/capabilities', (req, res) => {
  const caps = getProjectCapabilities(req.params.projectId);
  res.json(caps ?? { commands: [], models: [], agents: [] });
});

// Get current graph state for a project (defaults to the first known project)
app.get('/api/graph', (req, res) => {
  const projectId = (req.query.projectId as string) || registry.list()[0]?.projectId;
  const w = projectId ? registry.get(projectId) : undefined;
  res.json(w ? w.store.getGraphData() : { nodes: [], links: [] });
});

// File preview endpoint: returns the content of a file inside a project's root,
// classified by kind so the client can pick the right renderer (Monaco, image,
// markdown). Hard-refuses paths that escape the project root after symlink
// resolution; refuses oversize files and binaries without ever loading them
// into memory beyond a small sniff buffer.
const PREVIEW_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const PREVIEW_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PREVIEW_BINARY_SNIFF_BYTES = 8 * 1024;
const PREVIEW_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
const PREVIEW_LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift', '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.php': 'php',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.sql': 'sql', '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'plaintext', '.ini': 'ini',
  '.xml': 'xml', '.md': 'markdown', '.markdown': 'markdown',
  '.dockerfile': 'dockerfile', '.lua': 'lua', '.r': 'r', '.gd': 'plaintext',
};

function previewLanguageOf(ext: string): string {
  return PREVIEW_LANGUAGE_BY_EXT[ext.toLowerCase()] || 'plaintext';
}

app.get('/api/file/read', (req, res) => {
  const projectId = (req.query.projectId as string) || registry.list()[0]?.projectId;
  const filePath = req.query.filePath as string | undefined;
  if (!projectId || typeof filePath !== 'string' || filePath.length === 0) {
    res.status(400).json({ error: 'projectId and filePath required' });
    return;
  }
  const w = registry.get(projectId);
  if (!w) {
    res.status(404).json({ error: 'project not found' });
    return;
  }

  // Resolve both ends to real paths so symlinks can't smuggle the target out
  // of the project. A relative filePath is resolved against the project root;
  // an absolute one is still subject to the containment check below.
  let projectRootReal: string;
  let absoluteReal: string;
  try {
    projectRootReal = fs.realpathSync(w.projectRoot);
    const requested = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRootReal, filePath);
    absoluteReal = fs.realpathSync(requested);
  } catch {
    res.status(404).json({ error: 'file not found' });
    return;
  }

  const containmentPrefix = projectRootReal.endsWith(path.sep) ? projectRootReal : projectRootReal + path.sep;
  if (absoluteReal !== projectRootReal && !absoluteReal.startsWith(containmentPrefix)) {
    res.status(403).json({ error: 'path escapes project root' });
    return;
  }

  const stat = fs.statSync(absoluteReal);
  if (stat.isDirectory()) {
    res.status(400).json({ error: 'path is a directory' });
    return;
  }
  if (!stat.isFile()) {
    res.status(400).json({ error: 'not a regular file' });
    return;
  }

  const ext = path.extname(absoluteReal).toLowerCase();
  const name = path.basename(absoluteReal);
  const size = stat.size;
  const imageMime = PREVIEW_IMAGE_MIME[ext];

  if (imageMime) {
    if (size > PREVIEW_MAX_IMAGE_BYTES) {
      res.json({ kind: 'unsupported', reason: 'too_large', name, ext, size });
      return;
    }
    // SVG is text-ish but we still serve it as base64 so the client can render
    // it with a single <img> path regardless of payload shape.
    const buf = fs.readFileSync(absoluteReal);
    res.json({ kind: 'image', mimeType: imageMime, content: buf.toString('base64'), name, ext, size });
    return;
  }

  if (size > PREVIEW_MAX_TEXT_BYTES) {
    res.json({ kind: 'unsupported', reason: 'too_large', name, ext, size });
    return;
  }

  // Sniff for null bytes to detect binaries. We avoid loading the whole file
  // for this check on large files (already capped at 2 MB above, but cheap).
  const fd = fs.openSync(absoluteReal, 'r');
  let isBinary = false;
  try {
    const sniff = Buffer.alloc(Math.min(PREVIEW_BINARY_SNIFF_BYTES, size));
    if (sniff.length > 0) {
      fs.readSync(fd, sniff, 0, sniff.length, 0);
      for (let i = 0; i < sniff.length; i++) {
        if (sniff[i] === 0) { isBinary = true; break; }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (isBinary) {
    res.json({ kind: 'unsupported', reason: 'binary', name, ext, size });
    return;
  }

  const content = fs.readFileSync(absoluteReal, 'utf-8');
  const kind = (ext === '.md' || ext === '.markdown') ? 'markdown' : 'text';
  res.json({ kind, content, language: previewLanguageOf(ext), name, ext, size });
});

// Get hot folders based on git history + live activity
app.get('/api/hot-folders', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  try {
    const projectId = (req.query.projectId as string) || registry.list()[0]?.projectId;
    const w = projectId ? registry.get(projectId) : undefined;
    if (!w) { res.json([]); return; }

    // Get git-based hot folders
    const hotFolders = await getHotFolders(w.projectRoot, limit);

    // Get recently active files from live activity (last 10 minutes)
    const recentlyActive = w.store.getRecentlyActiveFiles(10 * 60 * 1000);

    // Merge live activity into hot folders - prioritize recent files
    for (const folder of hotFolders) {
      const liveFiles = recentlyActive.get(folder.folder);
      if (liveFiles && liveFiles.length > 0) {
        // Prepend live files, remove duplicates, keep max 8
        const merged = [...liveFiles];
        for (const file of folder.recentFiles) {
          if (!merged.includes(file)) {
            merged.push(file);
          }
        }
        folder.recentFiles = merged.slice(0, 8);
      }
    }

    // Also add any folders with live activity that aren't in git history
    for (const [folderPath, files] of recentlyActive) {
      if (!hotFolders.find(f => f.folder === folderPath)) {
        hotFolders.push({
          folder: folderPath,
          score: files.length * 10, // Give live folders a decent score
          recentFiles: files.slice(0, 8)
        });
      }
    }

    // Re-sort by score (git activity + boost for live activity)
    hotFolders.sort((a, b) => b.score - a.score);

    res.json(hotFolders.slice(0, limit));
  } catch (error) {
    console.error('Error getting hot folders:', error);
    res.status(500).json({ error: 'Failed to get hot folders' });
  }
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    clients: wsManager.getClientCount(),
    projects: registry.list().length
  });
});

// Debug endpoint - comprehensive system state for troubleshooting
app.get('/api/debug', (_req, res) => {
  const now = Date.now();
  res.json({
    server: {
      uptime: Math.floor((now - SERVER_START_TIME) / 1000),
      uptimeFormatted: `${Math.floor((now - SERVER_START_TIME) / 60000)}m ${Math.floor(((now - SERVER_START_TIME) % 60000) / 1000)}s`,
      projects: registry.list(),
      wsClients: wsManager.getClientCount(),
    },
    agents: Array.from(agentStates.values()).map(agent => ({
      ...agent,
      agentId: agent.agentId.slice(0, 8) + '...', // Truncate for readability
      lastActivityAgo: `${Math.floor((now - agent.lastActivity) / 1000)}s ago`,
      willTimeoutIn: `${Math.floor((AGENT_TIMEOUT_MS - (now - agent.lastActivity)) / 1000)}s`,
    })),
    agentCount: agentStates.size,
    maxAgents: MAX_AGENTS,
    recentActivity: recentActivityBuffer.slice(-20).map(a => ({
      ...a,
      agentId: a.agentId ? a.agentId.slice(0, 8) + '...' : undefined,
      ago: `${Math.floor((now - a.timestamp) / 1000)}s ago`,
    })),
    config: {
      agentTimeoutMs: AGENT_TIMEOUT_MS,
      agentCreationCooldownMs: AGENT_CREATION_COOLDOWN_MS,
    }
  });
});

// Clear graph for every known project (building)
app.post('/api/clear', (_req, res) => {
  for (const info of registry.list()) {
    const w = registry.get(info.projectId)!;
    w.store.clear();
    wsManager.broadcast('graph', w.store.getGraphData(), info.projectId);
  }
  res.json({ success: true });
});

// Manually clear all tracked agents (e.g. to remove leftover/test agents).
// Non-destructive: real agents re-register on their next activity via hooks.
// Persists immediately so a restart within the 30s save window doesn't restore
// the agents we just cleared.
app.post('/api/agents/clear', (_req, res) => {
  const cleared = agentStates.size;
  agentStates.clear();
  clearTranscripts();
  refreshAgentCounts();
  saveAgentState();
  wsManager.broadcast('thinking', getAgentStatesArray());
  console.log(`[${new Date().toISOString()}] Cleared ${cleared} agents (manual /api/agents/clear)`);
  res.json({ success: true, cleared });
});

// Handle git commit notification - refresh layout for the committing project
app.post('/api/git-commit', async (req, res) => {
  console.log(`[${new Date().toISOString()}] Git commit detected - refreshing layout`);

  const projectId = (req.body?.projectId as string) || registry.list()[0]?.projectId;
  const w = projectId ? registry.get(projectId) : undefined;
  if (!w) { res.json({ success: true, foldersUpdated: 0 }); return; }

  // Clear the git activity cache to force fresh data
  clearGitCache(w.projectRoot);

  // Fetch updated hot folders
  try {
    const hotFolders = await getHotFolders(w.projectRoot, 50);

    // Broadcast layout update to clients, tagged with the project
    wsManager.broadcast('layout-update', { hotFolders, timestamp: Date.now() }, w.projectId);

    res.json({ success: true, foldersUpdated: hotFolders.length });
  } catch (error) {
    console.error('Failed to refresh layout after git commit:', error);
    res.status(500).json({ error: 'Failed to refresh layout' });
  }
});

// ── TTY routes ──────────────────────────────────────────────────────────────

app.post('/api/tty/spawn', (req, res) => {
  const { projectId } = req.body ?? {};
  const ws = typeof projectId === 'string' ? registry.get(projectId) : undefined;
  const cwd = ws?.projectRoot ?? FALLBACK_PROJECT_ID;
  const { ttyId, shell, cwd: sessionCwd, title, createdAt } = ttyManager.spawn(cwd);
  res.json({ ttyId, shell, cwd: sessionCwd, title, createdAt });
});

app.delete('/api/tty/:id', (req, res) => {
  ttyManager.kill(req.params.id);
  res.status(204).end();
});

app.get('/api/tty', (_req, res) => {
  res.json(ttyManager.list());
});

// Load persisted state before starting server
loadAgentState();

server.listen(PORT, () => {
  console.log(`
  CodeMap Server
  ==============
  HTTP:      http://localhost:${PORT}
  WebSocket: ws://localhost:${PORT}/ws
  Mode:      multi-project (buildings discovered from hooks)
  Agents:    ${agentStates.size} restored
  `);
});
