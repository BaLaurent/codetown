import { createContext, useCallback, useContext, useEffect, useState, useMemo, type ReactNode } from 'react';
import { TtyPanel } from './TtyPanel';
import { getTtyTitle, setTtyTitle, clearTtyTitle } from '../utils/tty-titles';
import { DEFAULT_WIDTH } from './dock-layout';
import { useDock } from './DockHost';

const API_URL = 'http://localhost:5174/api';

interface TtySessionClient {
  ttyId: string;
  title: string;
  cwd: string;
}

interface TtyControl {
  // Liste d'intention (ordre d'ouverture, le plus récent en dernier). Le sous-ensemble
  // réellement affiché est dérivé du budget de largeur (via le dock).
  openTtyIds: string[];
  ttySessions: TtySessionClient[];
  spawnTty: (projectId?: string) => Promise<void>;
  openTty: (ttyId: string) => void;
  hideTty: (ttyId: string) => void;
  closeTty: (ttyId: string) => void;
  renameTty: (ttyId: string, newTitle: string) => void;
}

const TtyContext = createContext<TtyControl | null>(null);

export function useTty(): TtyControl {
  const ctx = useContext(TtyContext);
  if (!ctx) throw new Error('useTty must be used within a TtyProvider');
  return ctx;
}

export function TtyProvider({ children }: { children: ReactNode }) {
  const [ttySessions, setTtySessions] = useState<TtySessionClient[]>([]);
  const dock = useDock();
  // Callbacks stables (useCallback dans DockHost) : on les destructure pour les utiliser
  // comme deps fines, sinon `[dock]` change à chaque état du dock (drag, resize) et
  // re-render inutilement HabboRoom + AgentRosterPanel via le contexte.
  const { openPanel, closePanel, openKeysByKind } = dock;

  // IDs des terminaux ouverts dans le dock — dérivé de l'ordre du dock.
  const openTtyIds = useMemo(() => openKeysByKind('tty'), [openKeysByKind]);

  // Réhydrater les sessions survivantes au mount (ex: reload de page),
  // en appliquant les titres personnalisés stockés en localStorage.
  useEffect(() => {
    fetch(`${API_URL}/tty`)
      .then(r => r.ok ? r.json() : [])
      .then((sessions: TtySessionClient[]) =>
        setTtySessions(sessions.map(s => ({ ...s, title: getTtyTitle(s.ttyId, s.title) })))
      )
      .catch(() => { /* serveur indisponible */ });
  }, []);

  const spawnTty = useCallback(async (projectId?: string) => {
    const r = await fetch(`${API_URL}/tty/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    if (!r.ok) return;
    const info: TtySessionClient = await r.json();
    setTtySessions(prev => [...prev, { ...info, title: getTtyTitle(info.ttyId, info.title) }]);
    openPanel('tty', info.ttyId);
  }, [openPanel]);

  // Idempotent : ajoute en fin (= le plus récent, prioritaire à l'affichage) si absent,
  // no-op si déjà présent. Surtout PAS un toggle — le retrait passe par hideTty.
  const openTty = useCallback((ttyId: string) => {
    openPanel('tty', ttyId);
  }, [openPanel]);

  // Masque le panel sans tuer la session — le buffer 64KB côté serveur
  // assure le replay de l'historique à la prochaine ouverture.
  const hideTty = useCallback((ttyId: string) => {
    closePanel('tty', ttyId);
  }, [closePanel]);

  const closeTty = useCallback((ttyId: string) => {
    fetch(`${API_URL}/tty/${ttyId}`, { method: 'DELETE' }).catch(() => { /* ignore */ });
    clearTtyTitle(ttyId);
    setTtySessions(prev => prev.filter(s => s.ttyId !== ttyId));
    closePanel('tty', ttyId);
  }, [closePanel]);

  const renameTty = useCallback((ttyId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setTtyTitle(ttyId, trimmed);
    setTtySessions(prev => prev.map(s => s.ttyId === ttyId ? { ...s, title: trimmed } : s));
  }, []);

  const control = useMemo<TtyControl>(
    () => ({ openTtyIds, ttySessions, spawnTty, openTty, hideTty, closeTty, renameTty }),
    [openTtyIds, ttySessions, spawnTty, openTty, hideTty, closeTty, renameTty],
  );

  return (
    <TtyContext.Provider value={control}>
      {children}
      {/* Tous les panneaux restent montés ; seuls les visibles le sont vraiment
          (visibility:hidden pour les autres, pas display:none — ce dernier met les
          dimensions à zéro). Garder le xterm + la WS vivants préserve l'état du
          terminal (mode souris de tmux, alt-screen…) au switch comme à l'éviction,
          ce que le replay brut de 64 KB ne peut pas reconstruire. TtyPanel n'ouvre
          xterm qu'à la PREMIÈRE activation (lazy-open) : ouvrir sur un conteneur caché
          empêche xterm d'initialiser son renderer (mesure de glyphe à 0 sous Firefox)
          → crash sur .dimensions. */}
      {ttySessions.map(session => {
        const key = `tty:${session.ttyId}`;
        const placement = dock.placementFor(key);
        return (
          <TtyPanel
            key={session.ttyId}
            ttyId={session.ttyId}
            title={session.title}
            cwd={session.cwd}
            rightOffset={placement?.rightOffset ?? 16}
            width={placement?.effectiveWidth ?? DEFAULT_WIDTH}
            maxWidth={placement?.maxWidth ?? DEFAULT_WIDTH}
            active={placement !== undefined}
            isMaximized={dock.maximizedKey === key}
            onResizeWidth={w => dock.setWidth(key, w)}
            onClose={() => closeTty(session.ttyId)}
            onMinimize={() => hideTty(session.ttyId)}
            onToggleMaximize={() => (dock.maximizedKey === key ? dock.restore() : dock.maximize(key))}
            onRename={newTitle => renameTty(session.ttyId, newTitle)}
          />
        );
      })}
    </TtyContext.Provider>
  );
}
