// Chat panel for a hotel-spawned agent: shows the transcript (user/assistant/
// system/tool/thinking lines streamed over WS) and lets the user send new turns.
// Same pixel-art palette as the interaction modal.
//
// Rendering by role:
//   - assistant  → markdown via react-markdown + remark-gfm (GFM tables, code fences, etc.)
//   - user       → plain text bubble, pre-wrap preserved
//   - system     → centered italic notice
//   - tool       → <ToolCall> compact 🔧 chip + <details> with full input and
//                  the paired tool_result (looked up by toolUseId)
//   - thinking   → <ThinkingBubble> 💭 collapsed by default, markdown inside
//   - tool_result → NOT rendered standalone (consumed by its tool above);
//                  orphan results fall back to a discreet system line
import { useState, useRef, useEffect, useMemo, useCallback, type CSSProperties, type ClipboardEvent } from 'react';
import type { ChatMessage, SlashCommand, ModelOption } from '../types';
import { MarkdownBody } from './MarkdownBody';
import { CompletionInput } from './chat-completion';
import { PERMISSION_MODE_OPTIONS } from './permission-modes';
import { buildModelOptions } from './model-options';
import { EFFORT_OPTIONS, EFFORT_TOOLTIP } from './effort-options-ui';
import { MIN_WIDTH } from './dock-layout';
import { PanelColorPicker, PaletteRow } from './PanelColorPicker';
import { readableTextColor } from '../utils/readable-text-color';

const C = { ink: '#3A2E12', border: '#4A3B1A', gold: '#FFE040', cream: '#FFF8E6' };

const titleBar: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '8px 12px', background: C.gold, borderBottom: `4px solid ${C.border}`, fontWeight: 700,
};

const iconBtn: CSSProperties = {
  cursor: 'pointer', fontWeight: 700, background: 'transparent', border: 'none',
  color: 'inherit', fontFamily: 'monospace', fontSize: 14, padding: '0 4px',
};

// Menu contextuel (clic droit) — même UX/look que celui du terminal (TtyPanel).
const menuStyle: CSSProperties = {
  position: 'fixed', zIndex: 30, minWidth: 160,
  backgroundColor: 'rgba(17, 24, 39, 0.98)', borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  overflow: 'hidden', fontSize: 13, fontFamily: 'sans-serif', fontWeight: 400,
};

const menuLabel: CSSProperties = {
  padding: '8px 14px 2px', color: '#e5e7eb', opacity: 0.55, fontSize: 11,
};

const subBar: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  padding: '4px 10px', fontSize: 11, background: '#F1E7CC', borderBottom: `2px solid ${C.border}`,
};

const modeSelect: CSSProperties = {
  fontFamily: 'monospace', fontSize: 11, color: C.ink, background: '#fff',
  border: `2px solid ${C.border}`, padding: '2px 4px', flex: 1, minWidth: 0,
};

const transcript: CSSProperties = { flex: 1, overflowY: 'auto', padding: 10, fontSize: 13, lineHeight: 1.4 };

const inputRow: CSSProperties = {
  display: 'flex', gap: 6, padding: 8, borderTop: `4px solid ${C.border}`,
};

const sendBtn: CSSProperties = {
  fontFamily: 'monospace', fontWeight: 700, fontSize: 13, padding: '6px 12px',
  color: C.ink, background: C.gold, border: `3px solid ${C.border}`,
  boxShadow: '2px 2px 0 rgba(0,0,0,0.3)', cursor: 'pointer',
};

const attachBtn: CSSProperties = {
  fontFamily: 'monospace', fontWeight: 700, fontSize: 14, padding: '6px 8px',
  color: C.ink, background: C.cream, border: `3px solid ${C.border}`,
  boxShadow: '2px 2px 0 rgba(0,0,0,0.3)', cursor: 'pointer',
};

const attachStatus: CSSProperties = {
  padding: '0 10px 6px', fontSize: 11, fontStyle: 'italic', color: C.ink, opacity: 0.7,
};

const bubbleBase: CSSProperties = { marginBottom: 6, maxWidth: '92%', wordBreak: 'break-word' };

const userBubble: CSSProperties = {
  ...bubbleBase, alignSelf: 'flex-end',
  background: '#FFF0B8', border: `2px solid ${C.border}`,
  padding: '5px 8px', maxWidth: '85%', whiteSpace: 'pre-wrap',
};

const assistantBubble: CSSProperties = {
  ...bubbleBase, alignSelf: 'flex-start',
  background: '#fff', border: `2px solid rgba(74,59,26,0.4)`,
  padding: '5px 8px', maxWidth: '85%',
};

const systemBubble: CSSProperties = {
  alignSelf: 'center', fontStyle: 'italic', opacity: 0.7,
  margin: '6px 0', fontSize: 12,
};

const toolWrap: CSSProperties = {
  ...bubbleBase, alignSelf: 'flex-start',
  border: `1px dashed ${C.border}`, background: '#EFE6CF',
  fontSize: 11, opacity: 0.95,
};

// <summary> reset so the disclosure caret appears as our own ▸ glyph and the
// row reads as a compact chip when collapsed (chip rendering + expand control
// share one element, avoiding a second header row).
const toolSummary: CSSProperties = {
  cursor: 'pointer', listStyle: 'none', padding: '2px 6px',
  display: 'flex', gap: 4, alignItems: 'baseline', overflow: 'hidden',
};

const toolName: CSSProperties = { fontWeight: 700, whiteSpace: 'nowrap' };

const toolPreview: CSSProperties = {
  flex: 1, minWidth: 0, whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.85,
};

const toolDetails: CSSProperties = {
  padding: '6px 8px', borderTop: `1px dashed ${C.border}`, background: '#F7F1DE',
};

const toolPre: CSSProperties = {
  margin: '4px 0 0', padding: '6px 8px',
  background: '#fff', border: `1px solid rgba(74,59,26,0.3)`,
  fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap',
  wordBreak: 'break-word', maxHeight: 240, overflow: 'auto',
};

const toolResultLabel: CSSProperties = { fontSize: 10, fontWeight: 700, opacity: 0.7, marginTop: 6 };

const thinkingWrap: CSSProperties = {
  ...bubbleBase, alignSelf: 'flex-start',
  border: `1px dashed rgba(74,59,26,0.4)`, background: '#EFEAD8',
  fontSize: 12, opacity: 0.9, fontStyle: 'italic',
};

const thinkingSummary: CSSProperties = {
  cursor: 'pointer', listStyle: 'none', padding: '3px 8px',
  display: 'flex', gap: 6, alignItems: 'baseline',
};

const thinkingDetails: CSSProperties = {
  padding: '6px 8px', borderTop: `1px dashed rgba(74,59,26,0.4)`,
  background: '#F5F1E1', fontStyle: 'normal',
};

const orphanResult: CSSProperties = { ...systemBubble, opacity: 0.5, fontSize: 11 };

// "typing…" placeholder shown at the tail of the transcript while the agent is
// thinking but hasn't emitted a block yet (or between blocks). NOT a ChatMessage:
// it's a transient React node so we don't pollute chatHistoryRef / the server
// transcript with markers that have no use after the turn ends.
const typingWrap: CSSProperties = {
  ...bubbleBase, alignSelf: 'flex-start',
  border: `1px dashed rgba(74,59,26,0.4)`, background: '#EFEAD8',
  padding: '4px 10px', fontSize: 12, fontStyle: 'italic', opacity: 0.85,
  display: 'inline-flex', alignItems: 'baseline', gap: 6,
};

const typingDot: CSSProperties = {
  display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
  background: C.ink, animation: 'hf-typing-pulse 1.1s ease-in-out infinite',
};

// Inline keyframes — the codebase has no CSS file and no styled-components.
// Rendered once inside the panel root so the rule is registered before any
// indicator mounts; React de-dupes identical <style> nodes across re-renders.
function TypingIndicator() {
  return (
    <div style={typingWrap} aria-live="polite" aria-label="L'agent réfléchit">
      <span>💭 typing</span>
      <span style={typingDot} />
      <span style={{ ...typingDot, animationDelay: '0.15s' }} />
      <span style={{ ...typingDot, animationDelay: '0.3s' }} />
    </div>
  );
}


function ToolCall({ msg, result }: { msg: ChatMessage; result?: ChatMessage }) {
  const tool = msg.tool;
  if (!tool) return null;
  const preview = tool.input ?? '';
  const full = tool.fullInput ?? tool.input ?? '';
  const hasMore = full && full !== preview;
  // Auto-expand failed tool calls — they're the ones the user actually needs to
  // see at a glance; successes stay compact.
  const defaultOpen = Boolean(result?.isError);
  return (
    <details style={toolWrap} open={defaultOpen}>
      <summary style={toolSummary}>
        <span>{result?.isError ? '⚠️' : '🔧'}</span>
        <span style={toolName}>{tool.name}</span>
        {preview && <span style={toolPreview}>· {preview}</span>}
        <span style={{ opacity: 0.5, marginLeft: 'auto' }}>▸</span>
      </summary>
      <div style={toolDetails}>
        {hasMore && (
          <>
            <div style={{ ...toolResultLabel, marginTop: 0 }}>INPUT</div>
            <pre style={toolPre}>{full}</pre>
          </>
        )}
        {result && (
          <>
            <div style={toolResultLabel}>{result.isError ? 'ERROR' : 'RESULT'}</div>
            <pre style={{ ...toolPre, background: result.isError ? '#FFE9E0' : '#fff' }}>{result.content || '(empty)'}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function ThinkingBubble({ content }: { content: string }) {
  return (
    <details style={thinkingWrap}>
      <summary style={thinkingSummary}>
        <span>💭</span>
        <span>Réflexion ({content.length} car.)</span>
        <span style={{ opacity: 0.5, marginLeft: 'auto' }}>▸</span>
      </summary>
      <div style={thinkingDetails}>
        <MarkdownBody source={content} />
      </div>
    </details>
  );
}

export function AgentChatPanel({ agentName, messages, dead, isThinking, commands, files, models, model, mode, effort, onModelChange, onModeChange, onEffortChange, onSend, onStop, onClose, onAttach, rightOffset, width, maxWidth, active, isMaximized, onResizeWidth, onToggleMaximize, color, onColorChange }: {
  agentName: string;
  messages: ChatMessage[];
  dead?: boolean;  // session ended/crashed → input is disabled
  isThinking?: boolean;  // agent currently producing a turn → render "typing…" tail
  commands: SlashCommand[];  // "/" completion (commands + skills) for the live session
  files: string[];           // "@" completion (project-relative paths)
  models: ModelOption[];     // selectable models for the live session
  model?: string;            // current model value ('' / undefined → CLI default)
  mode?: string;             // current permission mode
  effort?: string;           // current thinking effort (default/low/medium/high/xhigh/max/off)
  onModelChange: (model: string) => void;  // switch the live session's model
  onModeChange: (mode: string) => void;     // switch the live session's permission mode
  onEffortChange: (effort: string) => void; // switch the live session's thinking effort
  onSend: (content: string) => void;
  onStop: () => void;
  onClose: () => void;
  // Upload files to the agent's attachment folder. Returns the absolute paths
  // the server wrote them to (the panel mentions those in the draft).
  onAttach: (files: File[]) => Promise<string[]>;
  // Placement props from the dock (position, size, visibility)
  rightOffset: number;
  width: number;
  maxWidth: number;
  active: boolean;
  isMaximized: boolean;
  onResizeWidth: (width: number) => void;
  onToggleMaximize: () => void;
  // Couleur personnalisée du panel (null = thème or par défaut)
  color: string | null;
  onColorChange: (color: string | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const [attachStatusText, setAttachStatusText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Menu contextuel (clic droit) sur la barre de titre — couleur du panel ─────
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  // ── Width resize (left-edge drag) ────────────────────────────────────────────
  // Mirrors TtyPanel exactly: refs for maxWidth/onResizeWidth to keep one global
  // listener pair (deps []) without freezing the callbacks.
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(width);
  const maxWidthRef = useRef(maxWidth);
  maxWidthRef.current = maxWidth;
  const onResizeWidthRef = useRef(onResizeWidth);
  onResizeWidthRef.current = onResizeWidth;

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = width;
  }, [width]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = resizeStartX.current - e.clientX; // drag left → wider
      const next = Math.max(MIN_WIDTH, Math.min(maxWidthRef.current, resizeStartWidth.current + delta));
      onResizeWidthRef.current(next);
    };
    const onUp = () => { isResizing.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Dynamic panel style — position/size/visibility come from dock placement props.
  const panelStyle: CSSProperties = {
    position: 'absolute', bottom: 16, right: rightOffset, zIndex: active ? 26 : 25,
    width, height: 'min(52vh, 520px)',
    display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
    background: C.cream, color: C.ink,
    border: `4px solid ${color ?? C.border}`, boxShadow: '8px 8px 0 rgba(0,0,0,0.35)',
    visibility: active ? 'visible' : 'hidden',
    pointerEvents: active ? 'auto' : 'none',
  };

  // Local mirrors so a pick reflects immediately, then resyncs if the
  // server-confirmed value (prop) changes.
  const [localMode, setLocalMode] = useState(mode ?? 'default');
  useEffect(() => { setLocalMode(mode ?? 'default'); }, [mode]);
  const changeMode = (m: string) => { setLocalMode(m); onModeChange(m); };

  // The agent reports model 'default' when on the default, so use that as the
  // reset value (server maps it back to "no model" → CLI default).
  const [localModel, setLocalModel] = useState(model || 'default');
  useEffect(() => { setLocalModel(model || 'default'); }, [model]);
  const changeModel = (m: string) => { setLocalModel(m); onModelChange(m); };
  const modelOptions = buildModelOptions(models, localModel);

  // Effort mirror, same optimistic-update pattern as mode/model.
  const [localEffort, setLocalEffort] = useState(effort ?? 'default');
  useEffect(() => { setLocalEffort(effort ?? 'default'); }, [effort]);
  const changeEffort = (e: string) => { setLocalEffort(e); onEffortChange(e); };

  // Build lookups in a single pass so the render loop stays O(n):
  //  - resultsByToolUseId: each ToolCall finds its paired output in O(1).
  //  - toolUseIdsSeen: each tool_result detects in O(1) whether it has a tool
  //    parent (else it's orphan and needs the fallback notice).
  const { resultsByToolUseId, toolUseIdsSeen } = useMemo(() => {
    const results = new Map<string, ChatMessage>();
    const seen = new Set<string>();
    for (const m of messages) {
      if (m.role === 'tool' && m.tool?.toolUseId) seen.add(m.tool.toolUseId);
      if (m.role === 'tool_result' && m.toolUseId) results.set(m.toolUseId, m);
    }
    return { resultsByToolUseId: results, toolUseIdsSeen: seen };
  }, [messages]);

  // Auto-scroll also reacts to `isThinking` flipping on: the "typing…" bubble
  // is appended to the transcript and would otherwise stay below the fold if
  // the user is parked mid-scroll when the agent starts a new turn.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, isThinking]);

  const send = () => {
    if (dead) return;
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  // Upload one or more files, then append "@<absPath>" mentions to the draft so
  // the user can keep typing context around them. Trailing space lets you start
  // the sentence immediately ("@/tmp/.../foo.txt explique-moi…").
  const uploadFiles = async (picked: File[]) => {
    if (dead || picked.length === 0) return;
    setAttachStatusText(`⏳ envoi de ${picked.length} fichier${picked.length > 1 ? 's' : ''}…`);
    try {
      const paths = await onAttach(picked);
      if (paths.length === 0) { setAttachStatusText('⚠ aucun fichier renvoyé par le serveur'); return; }
      const mentions = paths.map(p => `@${p}`).join(' ') + ' ';
      setDraft(d => (d ? `${d.replace(/\s*$/, '')} ${mentions}` : mentions));
      setAttachStatusText(`📎 ${paths.length} fichier${paths.length > 1 ? 's' : ''} joint${paths.length > 1 ? 's' : ''}`);
    } catch (err) {
      setAttachStatusText(`⚠ upload échoué: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Auto-fade the status (success or error) so the panel doesn't grow a
      // permanent line. Errors still visible long enough to read.
      window.setTimeout(() => setAttachStatusText(null), 4000);
    }
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list) return;
    void uploadFiles(Array.from(list));
    // Reset so the same file can be re-picked later if needed.
    e.target.value = '';
  };

  // Paste anywhere on the panel: if the clipboard carries files (screenshot,
  // copied file), intercept and upload them; otherwise let the normal paste
  // (text into the input) happen.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const list = e.clipboardData?.files;
    if (!list || list.length === 0) return;
    e.preventDefault();
    void uploadFiles(Array.from(list));
  };

  const renderMessage = (m: ChatMessage, i: number) => {
    switch (m.role) {
      case 'user':
        return <div key={i} style={userBubble}>{m.content}</div>;
      case 'system':
        return <div key={i} style={systemBubble}>{m.content}</div>;
      case 'assistant':
        return <div key={i} style={assistantBubble}><MarkdownBody source={m.content} /></div>;
      case 'tool':
        return <ToolCall key={i} msg={m} result={m.tool?.toolUseId ? resultsByToolUseId.get(m.tool.toolUseId) : undefined} />;
      case 'thinking':
        return <ThinkingBubble key={i} content={m.content} />;
      case 'tool_result':
        // Hidden when paired (consumed by its ToolCall above). Orphan results
        // (tool message missing, e.g. transcript cap evicted it) get a tiny
        // notice so they don't simply vanish.
        if (m.toolUseId && toolUseIdsSeen.has(m.toolUseId)) return null;
        return <div key={i} style={orphanResult}>↳ résultat orphelin · {m.content.slice(0, 80)}{m.content.length > 80 ? '…' : ''}</div>;
      default:
        return null;
    }
  };

  return (
    <div style={panelStyle} onPaste={onPaste}>
      {/* Keyframes for the "typing…" dots. Inline because the project has no
          CSS file. Multiple AgentChatPanels may be mounted simultaneously;
          identical keyframe rules are harmless (browsers deduplicate them). */}
      <style>{`@keyframes hf-typing-pulse { 0%, 80%, 100% { opacity: 0.25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }`}</style>
      {/* Resize handle — left edge drag, mirrors TtyPanel */}
      <div
        onMouseDown={onResizeMouseDown}
        style={{
          position: 'absolute', left: -4, top: 0, bottom: 0, width: 8,
          cursor: 'ew-resize', zIndex: 2,
          background: color ?? 'transparent',
        }}
      />
      <div
        style={color ? { ...titleBar, background: color, color: readableTextColor(color) } : titleBar}
        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <span>💬 {agentName}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <PanelColorPicker color={color} onChange={onColorChange} />
          <button style={iconBtn} onClick={onToggleMaximize} title={isMaximized ? 'Restaurer' : 'Maximiser'}>{isMaximized ? '🗗' : '🗖'}</button>
          <button style={iconBtn} onClick={onStop} title="Arrêter l'agent">⏹</button>
          <button style={iconBtn} onClick={onClose} title="Fermer">✕</button>
        </span>
      </div>

      {menu && (
        <div style={{ ...menuStyle, left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
          <div style={menuLabel}>Couleur</div>
          <div style={{ padding: '0 14px 10px' }} onMouseDown={e => e.preventDefault()}>
            <PaletteRow color={color} onPick={c => { onColorChange(c); setMenu(null); }} />
          </div>
        </div>
      )}

      <div style={subBar}>
        <select
          style={modeSelect}
          value={localModel}
          disabled={dead}
          onChange={e => changeModel(e.target.value)}
          title="Modèle (à chaud)"
        >
          {modelOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          style={modeSelect}
          value={localMode}
          disabled={dead}
          onChange={e => changeMode(e.target.value)}
          title="Mode de permission (à chaud)"
        >
          {PERMISSION_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          style={modeSelect}
          value={localEffort}
          disabled={dead}
          onChange={e => changeEffort(e.target.value)}
          title={EFFORT_TOOLTIP}
        >
          {EFFORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <div style={transcript} ref={scrollRef}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {messages.length === 0 && !isThinking && (
            <div style={{ opacity: 0.6, fontStyle: 'italic' }}>L'agent démarre…</div>
          )}
          {messages.map((m, i) => renderMessage(m, i))}
          {isThinking && !dead && <TypingIndicator />}
        </div>
      </div>

      {attachStatusText && <div style={attachStatus}>{attachStatusText}</div>}

      <div style={inputRow}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={onPickFiles}
        />
        <button
          style={{ ...attachBtn, opacity: dead ? 0.5 : 1, cursor: dead ? 'not-allowed' : 'pointer' }}
          disabled={dead}
          onClick={() => fileInputRef.current?.click()}
          title="Joindre des fichiers (ou Ctrl+V un screenshot)"
        >📎</button>
        <CompletionInput
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          commands={commands}
          files={files}
          disabled={dead}
          placeholder={dead ? 'Session terminée — spawn un nouvel agent' : "Écris à l'agent… (/ commandes, @ fichiers)"}
        />
        <button
          style={{ ...sendBtn, opacity: dead ? 0.5 : 1, cursor: dead ? 'not-allowed' : 'pointer' }}
          disabled={dead}
          onClick={send}
        >➤</button>
      </div>
    </div>
  );
}
