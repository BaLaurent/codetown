/**
 * Shared TypeScript Types
 *
 * These types are used across the server for:
 * - Activity events from hooks (file read/write)
 * - Thinking events from hooks (agent state)
 * - Graph data for visualization (file tree)
 *
 * The client has its own copy of these types.
 */

/** Agent source - which tool the agent is from */
export type AgentSource = 'claude' | 'cursor' | 'unknown';

/**
 * File activity event from file-activity-hook.sh
 * Tracks when an agent reads or writes a file
 */
export interface FileActivityEvent {
  type: 'read-start' | 'read-end' | 'write-start' | 'write-end' | 'search-start' | 'search-end';
  filePath: string;  // For search: this is the search pattern (glob or regex)
  agentId?: string;  // Which agent triggered this activity
  source?: AgentSource;  // Which tool (claude/cursor)
  projectId?: string;     // Building identity (git root or cwd)
  projectRoot?: string;   // Absolute root path for relativization
  projectName?: string;   // basename of projectRoot, shown as building sign
  timestamp: number;
}

/** Agent status from stop events */
export type AgentStatus = 'completed' | 'aborted' | 'error';

/** One selectable option of an AskUserQuestion question. */
export interface AgentQuestionOption {
  label: string;
  description?: string;
}

/** One question within an AskUserQuestion call. */
export interface AgentQuestionItem {
  question: string;       // The question text
  header?: string;        // Short category label
  multiSelect?: boolean;  // Whether several options may be chosen
  options: AgentQuestionOption[];
}

/**
 * The full set of questions an agent is asking the user (from AskUserQuestion).
 * Captured by the hook from tool_input.questions so the hotel can show the real
 * question in the bubble and offer the choices in an interactive modal.
 */
export interface AgentQuestion {
  questions: AgentQuestionItem[];
}

export interface ThinkingEvent {
  type: 'thinking-start' | 'thinking-end' | 'agent-stop';
  agentId: string;
  source?: AgentSource;  // Which tool (claude/cursor)
  projectId?: string;     // Building identity (git root or cwd)
  projectRoot?: string;   // Absolute root path for relativization
  projectName?: string;   // basename of projectRoot, shown as building sign
  timestamp: number;
  toolName?: string;  // Current tool being used (e.g., "Read", "Edit", "Bash")
  toolInput?: string;  // Abbreviated tool input (file path, command, pattern)
  question?: AgentQuestion;  // Full question text + options (from AskUserQuestion tool_input)
  agentType?: string;  // Agent type from SessionStart (e.g., "Plan", "Explore", "Bash")
  model?: string;  // Model name (e.g., "claude-3.5-sonnet") - Cursor provides this
  duration?: number;  // Operation duration in ms - from afterShellExecution/afterMCPExecution
  status?: AgentStatus;  // Agent completion status - from stop hook
  loopCount?: number;  // Number of agent loops - from stop hook
}

export interface AgentThinkingState {
  agentId: string;
  source: AgentSource;  // Which tool this agent is from
  projectId?: string;  // Which building/project this agent belongs to
  isThinking: boolean;
  lastActivity: number;
  displayName: string;
  currentCommand?: string;  // Current tool/command being executed
  toolInput?: string;  // Abbreviated tool input (file path, command, pattern)
  currentFile?: string;  // Project-relative path of the agent's current file (read/write).
                         // Single source of truth for the agent's location: the client
                         // derives its floor, movement target, and bubble file line from it.
                         // Sticky across non-file commands (e.g. Bash) so the agent stays put.
  waitingForInput?: boolean;  // True when agent is waiting for user input
  question?: AgentQuestion;  // Real question the agent is asking (from AskUserQuestion)
  spawned?: boolean;  // True for agents launched from the hotel (chattable via the panel)
  running?: boolean;  // Spawned agents only, derived (never persisted): SDK session still live
  pendingToolStart?: number;  // Timestamp when tool started (for detecting stuck permission prompts)
  agentType?: string;  // Agent type (e.g., "Plan", "Explore", "Bash") - shown in display name
  model?: string;  // Model name (e.g., "claude-3.5-sonnet") - shown below agent name
  permissionMode?: string;  // Spawned agents: current permission mode (default/bypassPermissions/…)
  effort?: string;          // Spawned agents: current thinking effort (default/low/medium/high/xhigh/max/off)
  lastDuration?: number;  // Last operation duration in ms
  status?: AgentStatus;  // Completion status (completed/aborted/error)
  statusTimestamp?: number;  // When status was set (for auto-clearing)
}

/**
 * A pending interaction a blocking hook registered and is waiting on: the agent
 * paused on an AskUserQuestion (or, later, a permission prompt) and the hotel
 * can answer it. Broadcast to clients so they know which agent is answerable.
 */
export interface PendingRequestInfo {
  agentId: string;
  requestId: string;
  kind: 'question' | 'permission';
  toolName?: string;     // permission only: the tool awaiting approval
  toolInput?: string;    // permission only: abbreviated input (command, file…)
  title?: string;        // permission only: SDK-rendered prompt sentence
  description?: string;  // permission only: SDK-rendered subtitle
  plan?: string;         // permission only: full plan markdown (ExitPlanMode)
}

/** Tells clients to dismiss a resolved interaction (multi-client consistency). */
export interface PermissionResolvedInfo {
  agentId: string;
  requestId: string;
}

/** Tells clients an agent was explicitly killed, so they can play its death
 *  animation and remove its character immediately (not after the grace period). */
export interface AgentKilledInfo {
  agentId: string;
}

// (effort lives on AgentThinkingState — see types declared earlier in this file)

/** A chat line for a hotel-spawned agent. One ChatMessage per content block
 *  the SDK yields (text → assistant, tool_use → tool, thinking → thinking,
 *  tool_result → tool_result). The client pairs tool + tool_result by toolUseId
 *  at render time to show the call's input and its output together. */
export interface ChatMessage {
  agentId: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'tool_result';
  content: string;       // assistant markdown / thinking text / tool_result text / user-system notice
  timestamp: number;
  /** role 'tool' only: the call the agent issued. `input` is a short preview
   *  (≤100 chars) for the compact chip; `fullInput` is the JSON-stringified
   *  raw input for the expanded view; `toolUseId` couples this call with its
   *  matching `tool_result` message. */
  tool?: { name: string; input?: string; fullInput?: string; toolUseId?: string };
  /** role 'tool_result' only: the toolUseId of the call this result answers. */
  toolUseId?: string;
  /** role 'tool_result' only: SDK error flag on the tool_result block. */
  isError?: boolean;
}

/** A slash command or skill the live SDK session can run (from supportedCommands). */
export interface SlashCommand {
  name: string;          // command/skill name, no leading slash
  description: string;
  argumentHint: string;  // e.g. "<file>"
  aliases?: string[];
}

/** A model the session can switch to (from supportedModels). */
export interface ModelOption {
  value: string;        // model id used in API calls
  displayName: string;
  description: string;
}

/** A subagent type the session can run as (from supportedAgents). */
export interface SubagentOption {
  name: string;
  description: string;
}

/** The terminal-like capabilities a session exposes, surfaced to the hotel UI. */
export interface AgentCapabilities {
  commands: SlashCommand[];
  models: ModelOption[];
  agents: SubagentOption[];
}

/** The decision the hotel sends back, returned to the blocking hook's long-poll. */
export type InteractionOutcome =
  | { outcome: 'answer'; text: string }   // AskUserQuestion answer (free-text injected to the agent)
  | { outcome: 'allow' }                  // permission granted
  | { outcome: 'deny'; reason?: string }  // permission denied
  | { outcome: 'timeout' };               // nobody answered → hook defers to native flow

/** A project the server is currently tracking (one building in the town) */
export interface ProjectInfo {
  projectId: string;
  projectName: string;
  projectRoot: string;
  lastActivity: number;
  agentCount: number;
  isPinned: boolean;
}

export interface GraphNode {
  id: string;
  name: string;
  isFolder: boolean;
  depth: number;
  lastActivity?: {
    type: 'read' | 'write' | 'search';
    timestamp: number;
  };
  activeOperation?: 'read' | 'write' | 'search';  // Currently active operation
  activityCount: {
    reads: number;
    writes: number;
    searches: number;
  };
}

export interface GraphLink {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** Layout update data - sent when git commit triggers a layout refresh */
export interface LayoutUpdateData {
  hotFolders: Array<{
    folder: string;
    score: number;
    recentFiles: string[];
  }>;
  timestamp: number;
}
