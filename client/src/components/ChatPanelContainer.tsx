// Per-chat lifecycle container. Owns the transcript-seed, capabilities, graph,
// rename listener, and RAF poll for ONE agent. Keyed by a constant agentId prop
// so effects never depend on a mutable "focused chat" variable. Placement props
// come from the dock and are forwarded to AgentChatPanel.
//
// RAF poll is gated on `active`: a hidden/evicted chat runs no render loop until
// it reappears, preventing unbounded background re-renders with N chats open.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentChatPanel } from './AgentChatPanel';
import { useAgentStream } from '../hooks/AgentStream';
import { mergeTranscript } from '../utils/chat-transcript';
import { getAgentName, AGENT_NAMES_CHANGED } from '../utils/agent-names';
import { getPanelColor, setPanelColor, clearPanelColor } from '../utils/panel-colors';
import type { AgentCapabilities, ChatMessage, GraphData, ModelOption, SlashCommand } from '../types';
import { DEFAULT_WIDTH, type DockPlacement } from './dock-layout';

const API_URL = 'http://localhost:5174/api';

export function ChatPanelContainer({ agentId, placement, active, isMaximized, onClose, onResizeWidth, onToggleMaximize }: {
  agentId: string;
  placement: DockPlacement | undefined;
  active: boolean;
  isMaximized: boolean;
  onClose: () => void;
  onResizeWidth: (w: number) => void;
  onToggleMaximize: () => void;
}) {
  const { chatHistoryRef, chatVersionRef, thinkingAgentsRef, thinkingVersionRef } = useAgentStream();

  const [chatCommands, setChatCommands] = useState<SlashCommand[]>([]);
  const [chatFiles, setChatFiles] = useState<string[]>([]);
  const [chatModels, setChatModels] = useState<ModelOption[]>([]);
  const [chatTick, setChatTick] = useState(0);

  // On mount / agentId change: seed transcript from server, load completion data.
  // Merge keeps any live lines that arrived after the server's last timestamp.
  useEffect(() => {
    const id = agentId;
    let cancelled = false;

    fetch(`${API_URL}/agent/${id}/transcript`)
      .then(r => (r.ok ? r.json() : []))
      .then((server: ChatMessage[]) => {
        if (cancelled || !Array.isArray(server) || server.length === 0) return;
        chatHistoryRef.current.set(id, mergeTranscript(server, chatHistoryRef.current.get(id) ?? []));
        chatVersionRef.current++;
      })
      .catch(() => { /* no transcript yet → rely on the live stream */ });

    fetch(`${API_URL}/agent/${id}/capabilities`)
      .then(r => (r.ok ? r.json() : null))
      .then((caps: AgentCapabilities | null) => {
        if (cancelled || !caps) return;
        setChatCommands(caps.commands);
        setChatModels(caps.models);
      })
      .catch(() => { /* no live session yet → no command completion */ });

    // File "@" completion for the agent's OWN project (may differ from the viewed building).
    const agentProject = thinkingAgentsRef.current.find(a => a.agentId === id)?.projectId;
    const q = agentProject ? `?projectId=${encodeURIComponent(agentProject)}` : '';
    fetch(`${API_URL}/graph${q}`)
      .then(r => r.json())
      .then((g: GraphData) => {
        if (cancelled) return;
        const rootId = g.nodes.find(n => n.depth === -1)?.id ?? '';
        const toRel = (nodeId: string) => (nodeId.startsWith(rootId) ? nodeId.slice(rootId.length).replace(/^[/\\]/, '') : nodeId);
        setChatFiles(g.nodes.filter(n => !n.isFolder && n.depth >= 0).map(n => toRel(n.id)));
      })
      .catch(() => { /* graph unavailable → no file completion */ });

    return () => { cancelled = true; };
  }, [agentId, chatHistoryRef, chatVersionRef, thinkingAgentsRef]);

  // Refresh the panel title when the user renames the agent.
  useEffect(() => {
    const onRename = () => setChatTick(t => t + 1);
    window.addEventListener(AGENT_NAMES_CHANGED, onRename);
    return () => window.removeEventListener(AGENT_NAMES_CHANGED, onRename);
  }, []);

  // RAF poll: gated on `active` so evicted/hidden chats run no render loop.
  // chatVersionRef is SHARED (all agents → same counter) so re-rendering a panel
  // that received no new lines is harmless (its history memo is stable).
  // When active flips on after being hidden, bump chatTick once so stale history
  // is re-read (useFileActivity replaces arrays, so the ref advance may have been
  // missed while the RAF was not running).
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (!prevActiveRef.current && active) {
      setChatTick(t => t + 1);
    }
    prevActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let lastChat = chatVersionRef.current;
    let lastThinking = thinkingVersionRef.current;
    const loop = () => {
      if (chatVersionRef.current !== lastChat || thinkingVersionRef.current !== lastThinking) {
        lastChat = chatVersionRef.current;
        lastThinking = thinkingVersionRef.current;
        setChatTick(t => t + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, chatVersionRef, thinkingVersionRef]);

  // API helpers — parameterized by constant agentId.
  const sendChat = useCallback((content: string) => {
    fetch(`${API_URL}/agent/${agentId}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).catch(console.error);
  }, [agentId]);

  const stopChat = useCallback(() => {
    fetch(`${API_URL}/agent/${agentId}/stop`, { method: 'POST' }).catch(console.error);
  }, [agentId]);

  const setModeForAgent = useCallback((mode: string) => {
    fetch(`${API_URL}/agent/${agentId}/mode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }).catch(console.error);
  }, [agentId]);

  const setModelForAgent = useCallback((model: string) => {
    fetch(`${API_URL}/agent/${agentId}/model`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }).catch(console.error);
  }, [agentId]);

  const setEffortForAgent = useCallback((effort: string) => {
    fetch(`${API_URL}/agent/${agentId}/effort`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort }),
    }).catch(console.error);
  }, [agentId]);

  const attachFiles = useCallback(async (files: File[]): Promise<string[]> => {
    if (files.length === 0) return [];
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const r = await fetch(`${API_URL}/agent/${agentId}/attach`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { paths?: string[] };
    return body.paths ?? [];
  }, [agentId]);

  const handleStop = useCallback(() => {
    stopChat();
    onClose();
  }, [stopChat, onClose]);

  // Recomputed on each tick so the panel reflects newly-arrived lines.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo<ChatMessage[]>(
    () => chatHistoryRef.current.get(agentId) ?? [],
    // chatHistoryRef is stable; chatTick is the invalidation signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId, chatTick, chatHistoryRef],
  );

  const agent = thinkingAgentsRef.current.find(a => a.agentId === agentId);
  // Authoritative when the agent is still tracked. Falls back to the transcript
  // signal (a terminal 'system' line) for post-kill replay.
  const dead = agent
    ? agent.running === false
    : history.length > 0 && history[history.length - 1].role === 'system';

  return (
    <AgentChatPanel
      agentName={getAgentName(agentId, agent?.displayName || 'Agent')}
      messages={history}
      dead={dead}
      isThinking={agent?.isThinking}
      commands={chatCommands}
      files={chatFiles}
      models={chatModels}
      model={agent?.model}
      mode={agent?.permissionMode}
      effort={agent?.effort}
      onModelChange={setModelForAgent}
      onModeChange={setModeForAgent}
      onEffortChange={setEffortForAgent}
      onSend={sendChat}
      onStop={handleStop}
      onClose={onClose}
      onAttach={attachFiles}
      rightOffset={placement?.rightOffset ?? 16}
      width={placement?.effectiveWidth ?? DEFAULT_WIDTH}
      maxWidth={placement?.maxWidth ?? DEFAULT_WIDTH}
      active={active}
      isMaximized={isMaximized}
      onResizeWidth={onResizeWidth}
      onToggleMaximize={onToggleMaximize}
      color={getPanelColor(`chat:${agentId}`)}
      onColorChange={c => {
        if (c === null) clearPanelColor(`chat:${agentId}`); else setPanelColor(`chat:${agentId}`, c);
        setChatTick(t => t + 1);
      }}
    />
  );
}
