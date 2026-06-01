// File activity event from Claude Code hooks
export interface FileActivityEvent {
  type: 'read-start' | 'read-end' | 'write-start' | 'write-end' | 'search-start' | 'search-end';
  filePath: string;  // For search: this is the search pattern (glob or regex)
  agentId?: string;  // Which agent triggered this activity
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

/** The full set of questions an agent is asking the user (from AskUserQuestion). */
export interface AgentQuestion {
  questions: AgentQuestionItem[];
}

/** A pending interaction a blocking hook is waiting on, tracked per agent. */
export interface PendingRequest {
  requestId: string;
  kind: 'question' | 'permission';
  toolName?: string;     // permission only
  toolInput?: string;    // permission only
  title?: string;        // permission only: SDK-rendered prompt sentence
  description?: string;  // permission only: SDK-rendered subtitle
  plan?: string;         // permission only: full plan markdown (ExitPlanMode)
}

/** A chat line for a hotel-spawned agent. One ChatMessage per content block
 *  the SDK yields (text → assistant, tool_use → tool, thinking → thinking,
 *  tool_result → tool_result). The panel pairs tool + tool_result by toolUseId
 *  at render time to show the call's input and its output together. */
export interface ChatMessage {
  agentId: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'tool_result';
  content: string;       // assistant markdown / thinking text / tool_result text / user-system notice
  timestamp: number;
  /** role 'tool' only: the call the agent issued. `input` is a short preview
   *  for the compact chip; `fullInput` is the JSON-stringified raw input for
   *  the expanded view; `toolUseId` couples this call with its `tool_result`. */
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
  value: string;
  displayName: string;
  description: string;
}

/** A subagent type the session can run as (from supportedAgents). */
export interface SubagentOption {
  name: string;
  description: string;
}

/** Terminal-like capabilities a session exposes, surfaced to the hotel UI. */
export interface AgentCapabilities {
  commands: SlashCommand[];
  models: ModelOption[];
  agents: SubagentOption[];
}

export interface AgentThinkingState {
  agentId: string;
  projectId?: string;  // Which building/project this agent belongs to
  isThinking: boolean;
  lastActivity: number;
  displayName: string;
  currentCommand?: string;  // Current tool/command being executed
  toolInput?: string;  // Abbreviated tool input (file path, command, pattern)
  currentFile?: string;  // Project-relative path of the agent's current file (read/write).
                         // Authoritative source for the agent's floor, movement target,
                         // and bubble file line. Sticky across non-file commands.
  waitingForInput?: boolean;  // True when agent is waiting for user input
  question?: AgentQuestion;  // Real question the agent is asking (from AskUserQuestion)
  spawned?: boolean;  // Launched from the hotel (chattable via the panel)
  running?: boolean;  // Spawned agents only: SDK session still live (false → chat session ended)
  agentType?: string;  // Agent type (Plan, Explore, Bash, etc.)
  model?: string;  // Model name (e.g., "claude-3.5-sonnet")
  permissionMode?: string;  // Spawned agents: current permission mode
  effort?: string;          // Spawned agents: current thinking effort (default/low/medium/high/xhigh/max/off)
  lastDuration?: number;  // Last operation duration in ms
  status?: AgentStatus;  // Completion status (completed/aborted/error)
  statusTimestamp?: number;  // When status was set
}

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
  activeOperation?: 'read' | 'write' | 'search';
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

// Hot folders from git activity API
export interface FolderScore {
  folder: string;
  score: number;
  recentFiles: string[];
}
