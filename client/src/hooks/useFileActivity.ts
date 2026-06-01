import { useEffect, useRef, useCallback, MutableRefObject } from 'react';
import { GraphData, FileActivityEvent, AgentThinkingState, PendingRequest, ChatMessage } from '../types';

const WS_URL = 'ws://localhost:5174/ws';
const API_URL = 'http://localhost:5174/api';
const MAX_ACTIVITY_HISTORY = 50;

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

// Decide whether a WS message applies to the building we're watching.
// `thinking` is the global agent list (filtered client-side by project elsewhere),
// so it always applies. Other messages apply when unfiltered or projectId matches.
export function shouldApplyMessage(
  message: { type: string; projectId?: string },
  watchedProjectId: string | undefined
): boolean {
  // Agent-keyed global messages always apply (no project scoping).
  if (message.type === 'thinking' || message.type === 'permission-request' ||
      message.type === 'permission-resolved' || message.type === 'chat' ||
      message.type === 'agent-killed') return true;
  if (!watchedProjectId) return true;
  return message.projectId === watchedProjectId;
}

// Enriched activity entry with display info for the feed
export interface ActivityFeedEntry {
  id: number;
  type: 'read' | 'write';
  filePath: string;
  fileName: string;
  agentName: string;
  timestamp: number;
}

// Ref-based hook that NEVER triggers React re-renders
// All data is stored in refs and read directly by the animation loop
export function useFileActivity(projectId?: string): {
  graphDataRef: MutableRefObject<GraphData>;
  recentActivityRef: MutableRefObject<FileActivityEvent | null>;
  thinkingAgentsRef: MutableRefObject<AgentThinkingState[]>;
  activityHistoryRef: MutableRefObject<ActivityFeedEntry[]>;
  activityVersionRef: MutableRefObject<number>;
  thinkingVersionRef: MutableRefObject<number>;
  layoutVersionRef: MutableRefObject<number>;
  pendingRequestsRef: MutableRefObject<Map<string, PendingRequest>>;
  chatHistoryRef: MutableRefObject<Map<string, ChatMessage[]>>;
  chatVersionRef: MutableRefObject<number>;
  killedAgentsRef: MutableRefObject<Set<string>>;
  connectionStatusRef: MutableRefObject<ConnectionStatus>;
  clearGraph: () => void;
} {
  const graphDataRef = useRef<GraphData>({ nodes: [], links: [] });
  const recentActivityRef = useRef<FileActivityEvent | null>(null);
  const thinkingAgentsRef = useRef<AgentThinkingState[]>([]);
  const activityHistoryRef = useRef<ActivityFeedEntry[]>([]);
  const activityIdCounterRef = useRef(0);
  // Version counters to detect changes without re-rendering
  const activityVersionRef = useRef(0);
  const thinkingVersionRef = useRef(0);
  const layoutVersionRef = useRef(0);
  // Agent → pending interaction (set by a blocking hook); used to render the
  // Allow/Deny modal and route the decision back. Read at answer time, so no
  // version counter needed.
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
  // Per-agent chat transcript for hotel-spawned agents; version bumps on new lines.
  const chatHistoryRef = useRef<Map<string, ChatMessage[]>>(new Map());
  const chatVersionRef = useRef(0);
  // Agents the server just killed; HabboRoom drains this to play the death
  // animation and remove the character immediately (no 30s grace wait).
  const killedAgentsRef = useRef<Set<string>>(new Set());
  // Connection status for UI indicator
  const connectionStatusRef = useRef<ConnectionStatus>('connecting');

  // The building currently being watched, held in a ref so the WS handler reads
  // the live value without `connect` depending on `projectId`. This keeps a
  // SINGLE socket alive across building switches (the provider that hosts this
  // hook never unmounts) — only the scoped graph re-fetches. Without it, every
  // navigation tore down and rebuilt the socket, dropping in-flight chat lines.
  const watchedProjectRef = useRef(projectId);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  // Ouverture du socket différée d'un tick : un mount StrictMode aussitôt démonté
  // annule ce timer avant d'avoir ouvert un socket qu'il faudrait abandonner
  // (« interrompue pendant le chargement de la page »).
  const connectTimerRef = useRef<number>();
  // Passe à true au premier open réussi. Avant ça, les erreurs WS sont attendues
  // (serveur en cours de démarrage) et gérées par le reconnect — on ne les logge pas.
  const hasConnectedRef = useRef(false);

  const connect = useCallback(() => {
    connectionStatusRef.current = 'connecting';

    // Fetch initial graph state (scoped to the watched building when set)
    const graphQuery = watchedProjectRef.current ? `?projectId=${encodeURIComponent(watchedProjectRef.current)}` : '';
    fetch(`${API_URL}/graph${graphQuery}`)
      .then(res => res.json())
      .then(data => {
        graphDataRef.current = data;
      })
      .catch(console.error);

    // Fetch initial thinking agents state
    fetch(`${API_URL}/thinking`)
      .then(res => res.json())
      .then((data: AgentThinkingState[]) => {
        thinkingAgentsRef.current = data;
        thinkingVersionRef.current++;
      })
      .catch(console.error);

    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        // Ignore messages for other buildings when scoped to one project.
        if (!shouldApplyMessage(message, watchedProjectRef.current)) return;
        if (message.type === 'graph') {
          graphDataRef.current = message.data;
        } else if (message.type === 'activity') {
          const event = message.data as FileActivityEvent;
          recentActivityRef.current = event;
          activityVersionRef.current++;

          // Only log end events to avoid duplicates (start+end for same action)
          if (event.type.endsWith('-end')) {
            // Find agent display name
            const agent = thinkingAgentsRef.current.find(a => a.agentId === event.agentId);
            const agentName = agent?.displayName || 'Unknown';

            // Extract filename from path
            const fileName = event.filePath.split('/').pop() || event.filePath;

            // Add to history
            const entry: ActivityFeedEntry = {
              id: activityIdCounterRef.current++,
              type: event.type.startsWith('read') ? 'read' : 'write',
              filePath: event.filePath,
              fileName,
              agentName,
              timestamp: event.timestamp || Date.now(),
            };

            activityHistoryRef.current = [
              entry,
              ...activityHistoryRef.current.slice(0, MAX_ACTIVITY_HISTORY - 1)
            ];
          }
        } else if (message.type === 'thinking') {
          thinkingAgentsRef.current = message.data as AgentThinkingState[];
          thinkingVersionRef.current++;
        } else if (message.type === 'layout-update') {
          // Git commit triggered a layout refresh
          console.log('Layout update received from server');
          layoutVersionRef.current++;
        } else if (message.type === 'permission-request') {
          const { agentId, requestId, kind, toolName, toolInput, title, description, plan } =
            message.data as { agentId: string } & PendingRequest;
          pendingRequestsRef.current.set(agentId, { requestId, kind, toolName, toolInput, title, description, plan });
          // Bump the chat counter so HabboRoom re-renders and can auto-open the
          // permission modal for the agent whose chat is focused.
          chatVersionRef.current++;
        } else if (message.type === 'permission-resolved') {
          const { agentId } = message.data as { agentId: string; requestId: string };
          pendingRequestsRef.current.delete(agentId);
        } else if (message.type === 'chat') {
          const msg = message.data as ChatMessage;
          const history = chatHistoryRef.current.get(msg.agentId) ?? [];
          chatHistoryRef.current.set(msg.agentId, [...history, msg]);
          chatVersionRef.current++;
        } else if (message.type === 'agent-killed') {
          const { agentId } = message.data as { agentId: string };
          killedAgentsRef.current.add(agentId);
        }
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };

    // Ouvre le socket un tick plus tard (cf. connectTimerRef) pour éviter qu'un
    // mount StrictMode aussitôt démonté ouvre un socket à abandonner.
    connectTimerRef.current = window.setTimeout(() => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        hasConnectedRef.current = true;
        console.log('WebSocket connected');
        connectionStatusRef.current = 'connected';
      };

      ws.onclose = () => {
        connectionStatusRef.current = 'disconnected';
        // Reconnect after 2 seconds
        reconnectTimeoutRef.current = window.setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        connectionStatusRef.current = 'disconnected';
        // Silencieux pendant la phase de connexion/démarrage serveur (erreur attendue,
        // gérée par le reconnect) ; on ne logge qu'une chute après connexion établie.
        if (hasConnectedRef.current) console.error('WebSocket error after connect');
      };

      ws.onmessage = handleMessage;
    }, 0);
  }, []);

  // Re-scope the graph when the watched building changes WITHOUT reconnecting the
  // socket: update the ref the handler reads, then re-fetch the scoped graph.
  useEffect(() => {
    watchedProjectRef.current = projectId;
    const graphQuery = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    fetch(`${API_URL}/graph${graphQuery}`)
      .then(res => res.json())
      .then(data => { graphDataRef.current = data; })
      .catch(console.error);
  }, [projectId]);

  useEffect(() => {
    connect();

    return () => {
      if (connectTimerRef.current) {
        clearTimeout(connectTimerRef.current);
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        // Detach onclose first: an intentional close must NOT schedule a
        // reconnect. Otherwise (e.g. StrictMode mount/unmount/remount) the closed
        // socket's onclose fires later and spawns a second live connection, so
        // every broadcast is received twice (visible as duplicated chat lines).
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  const clearGraph = useCallback(() => {
    fetch(`${API_URL}/clear`, { method: 'POST' })
      .catch(console.error);
  }, []);

  return {
    graphDataRef,
    recentActivityRef,
    thinkingAgentsRef,
    activityHistoryRef,
    activityVersionRef,
    thinkingVersionRef,
    layoutVersionRef,
    pendingRequestsRef,
    chatHistoryRef,
    chatVersionRef,
    killedAgentsRef,
    connectionStatusRef,
    clearGraph
  };
}
