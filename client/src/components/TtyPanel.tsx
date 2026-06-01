import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { cwdShort } from '../utils/path-display';
import { MIN_WIDTH } from './tty-layout';

const WS_URL = 'ws://localhost:5174';

const titleBarStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '8px 12px', background: '#1a1a1a', borderBottom: '4px solid #333',
  fontWeight: 700, flexShrink: 0, userSelect: 'none',
};

const iconBtn: CSSProperties = {
  cursor: 'pointer', fontWeight: 700, background: 'transparent', border: 'none',
  color: 'inherit', fontSize: 14, padding: '0 4px',
};

const titleInput: CSSProperties = {
  background: 'transparent', border: 'none', outline: 'none',
  color: 'inherit', fontWeight: 700, fontSize: 'inherit',
  fontFamily: 'inherit', padding: 0, width: '8em',
};

const menuStyle: CSSProperties = {
  position: 'fixed', zIndex: 30, minWidth: 160,
  backgroundColor: 'rgba(17, 24, 39, 0.98)', borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  overflow: 'hidden', fontSize: 13, fontFamily: 'sans-serif', fontWeight: 400,
};

const menuItem: CSSProperties = {
  padding: '8px 14px', cursor: 'pointer', color: '#e5e7eb',
};

interface TtyPanelProps {
  ttyId: string;
  title: string;
  cwd: string;
  rightOffset: number;
  width: number;       // largeur contrôlée par le parent (état hissé pour empilement multi)
  maxWidth: number;    // budget de largeur dispo à gauche du chat (clamp du drag)
  active: boolean;
  onResizeWidth: (width: number) => void;
  onClose: () => void;
  onMinimize: () => void;
  onRename: (newTitle: string) => void;
}

export function TtyPanel({ ttyId, title, cwd, rightOffset, width, maxWidth, active, onResizeWidth, onClose, onMinimize, onRename }: TtyPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const openRafRef = useRef<number>();
  const openedRef = useRef(false);

  // ── Rename ──────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);

  // Sync local edit buffer when parent renames from outside (e.g., on mount)
  useEffect(() => { setEditValue(title); }, [title]);

  // ── Menu contextuel (clic droit), même UX que le roster d'agents ─────────────
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const startRename = useCallback(() => {
    setEditing(true);
    setEditValue(title);
    setMenu(null);
  }, [title]);

  const commitRename = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) onRename(trimmed);
    else setEditValue(title);
  }, [editValue, title, onRename]);

  const handleRenameKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') { setEditing(false); setEditValue(title); }
  }, [commitRename, title]);

  // ── Width resize (left-edge drag) ────────────────────────────────────────────
  // La largeur est contrôlée par le parent ; le drag la remonte via onResizeWidth.
  // maxWidth et onResizeWidth changent à chaque rendu : on les lit via des refs pour
  // garder un seul jeu de listeners globaux (deps []) sans les figer.
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

  // ── xterm (ouverture paresseuse) ─────────────────────────────────────────────
  // fit() lit RenderService.dimensions ; tant que le terminal n'est pas ouvert ou que
  // le conteneur n'a pas de taille, le renderer n'existe pas → on s'abstient (le try
  // couvre le timing renderer-après-open de xterm 5.3).
  const safeFit = useCallback(() => {
    const el = containerRef.current;
    if (!fitAddonRef.current || !el || el.clientWidth === 0 || el.clientHeight === 0) return;
    try { fitAddonRef.current.fit(); } catch { /* renderer pas encore prêt */ }
  }, []);

  // Ouvre xterm + la WS UNE SEULE FOIS, à la première fois que le panneau est visible.
  // Ouvrir sur un conteneur caché (visibility:hidden) empêche xterm d'initialiser son
  // renderer (mesure de glyphe à 0, surtout sous Firefox) → crash sur .dimensions.
  const initTerminal = useCallback(() => {
    if (openedRef.current || !containerRef.current) return;
    openedRef.current = true;

    // open() lui-même est planifié dans un rAF annulable : un mount StrictMode jeté
    // l'annule au cleanup avant exécution, donc pas de setTimeout Viewport orphelin.
    openRafRef.current = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'monospace',
        theme: { background: '#0d0d0d', foreground: '#f0f0f0', cursor: '#f0f0f0' },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(container);
      termRef.current = term;
      fitAddonRef.current = fitAddon;
      // Premier fit dans un tick SÉPARÉ d'open() : le RenderService de xterm 5.3 n'est
      // pas garanti initialisé dès le retour d'open().
      requestAnimationFrame(safeFit);

      const ws = new WebSocket(`${WS_URL}/ws/tty/${ttyId}`);
      wsRef.current = ws;
      ws.onopen = () => {
        const { cols, rows } = term;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'exit') term.write('\r\n[Process exited]\r\n');
          } catch {
            term.write(e.data);
          }
        }
      };
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });

      const ro = new ResizeObserver(() => {
        safeFit();
        if (ws.readyState === WebSocket.OPEN) {
          const { cols, rows } = term;
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });
      ro.observe(container);
      roRef.current = ro;
    });
  }, [ttyId, safeFit]);

  // Teardown au UNMOUNT uniquement (session fermée) — surtout PAS sur active→false,
  // pour garder le terminal + la WS vivants au switch (mode souris tmux, alt-screen).
  // En StrictMode, ce cleanup annule l'openRaf du mount jeté avant qu'il ne s'exécute.
  useEffect(() => () => {
    if (openRafRef.current) cancelAnimationFrame(openRafRef.current);
    roRef.current?.disconnect();
    wsRef.current?.close();
    termRef.current?.dispose();
    termRef.current = null;
    fitAddonRef.current = null;
    wsRef.current = null;
    roRef.current = null;
    openedRef.current = false;
  }, []);

  // À l'activation : ouvre paresseusement au premier affichage, puis re-fit défensif
  // (la fenêtre a pu changer pendant qu'on était caché) + focus pour router les frappes.
  useEffect(() => {
    if (!active) return;
    initTerminal();
    const id = requestAnimationFrame(() => {
      safeFit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, initTerminal, safeFit]);

  const short = cwdShort(cwd);

  return (
    <div style={{
      position: 'absolute', bottom: 16, right: rightOffset, zIndex: active ? 26 : 25,
      width, height: 'min(52vh, 520px)',
      display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
      background: '#0d0d0d', color: '#f0f0f0',
      border: '4px solid #333', boxShadow: '8px 8px 0 rgba(0,0,0,0.35)',
      overflow: 'visible',
      // Caché mais TOUJOURS monté : visibility (≠ display:none) garde des dimensions
      // réelles pour fitAddon.fit(), et conserve le xterm + la WS vivants au switch.
      visibility: active ? 'visible' : 'hidden',
      pointerEvents: active ? 'auto' : 'none',
    }}>
      {/* Poignée de redimensionnement — bord gauche */}
      <div
        onMouseDown={onResizeMouseDown}
        style={{
          position: 'absolute', left: -4, top: 0, bottom: 0, width: 8,
          cursor: 'ew-resize', zIndex: 1,
        }}
      />

      <div
        style={titleBarStyle}
        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <span>💻</span>
          {editing ? (
            <input
              autoFocus
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleRenameKey}
              style={titleInput}
            />
          ) : (
            <span
              onDoubleClick={startRename}
              title="Double-clic ou clic droit pour renommer"
              style={{ cursor: 'text' }}
            >
              {title}
            </span>
          )}
        </span>
        <span style={{
          fontSize: 11, color: '#888', flex: 1, marginLeft: 8,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {short}
        </span>
        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          <button style={iconBtn} onClick={onMinimize} title="Réduire">─</button>
          <button style={iconBtn} onClick={onClose} title="Fermer le terminal">✕</button>
        </div>
      </div>

      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', padding: 4 }} />

      {menu && (
        <div style={{ ...menuStyle, left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
          <div
            style={menuItem}
            onMouseDown={e => e.preventDefault()}
            onClick={startRename}
          >Renommer</div>
        </div>
      )}
    </div>
  );
}
