import { createContext, useCallback, useContext, useEffect, useState, useMemo, type ReactNode } from 'react';
import { TtyPanel } from './TtyPanel';
import { useChat } from './ChatHost';
import { getTtyTitle, setTtyTitle, clearTtyTitle } from '../utils/tty-titles';
import { computeTtyLayout, DEFAULT_WIDTH } from './tty-layout';

const API_URL = 'http://localhost:5174/api';

interface TtySessionClient {
  ttyId: string;
  title: string;
  cwd: string;
}

interface TtyControl {
  // Liste d'intention (ordre d'ouverture, le plus récent en dernier). Le sous-ensemble
  // réellement affiché est dérivé du budget de largeur (voir computeTtyLayout).
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
  const [openTtyIds, setOpenTtyIds] = useState<string[]>([]);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [ttySessions, setTtySessions] = useState<TtySessionClient[]>([]);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const { chatAgentId } = useChat();

  // La visibilité dépend de la largeur de la fenêtre : on suit innerWidth pour
  // évincer (rétrécissement) ou auto-restaurer (agrandissement) les panneaux.
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
    setOpenTtyIds(prev => [...prev, info.ttyId]);
  }, []);

  // Idempotent : ajoute en fin (= le plus récent, prioritaire à l'affichage) si absent,
  // no-op si déjà présent. Surtout PAS un toggle — le retrait passe par hideTty.
  const openTty = useCallback((ttyId: string) => {
    setOpenTtyIds(prev => prev.includes(ttyId) ? prev : [...prev, ttyId]);
  }, []);

  // Masque le panel sans tuer la session — le buffer 64KB côté serveur
  // assure le replay de l'historique à la prochaine ouverture.
  const hideTty = useCallback((ttyId: string) => {
    setOpenTtyIds(prev => prev.filter(id => id !== ttyId));
  }, []);

  const closeTty = useCallback((ttyId: string) => {
    fetch(`${API_URL}/tty/${ttyId}`, { method: 'DELETE' }).catch(() => { /* ignore */ });
    clearTtyTitle(ttyId);
    setTtySessions(prev => prev.filter(s => s.ttyId !== ttyId));
    setOpenTtyIds(prev => prev.filter(id => id !== ttyId));
    setWidths(prev => {
      if (!(ttyId in prev)) return prev;
      const next = { ...prev };
      delete next[ttyId];
      return next;
    });
  }, []);

  const renameTty = useCallback((ttyId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setTtyTitle(ttyId, trimmed);
    setTtySessions(prev => prev.map(s => s.ttyId === ttyId ? { ...s, title: trimmed } : s));
  }, []);

  const setTtyWidth = useCallback((ttyId: string, width: number) => {
    setWidths(prev => ({ ...prev, [ttyId]: width }));
  }, []);

  const control = useMemo<TtyControl>(
    () => ({ openTtyIds, ttySessions, spawnTty, openTty, hideTty, closeTty, renameTty }),
    [openTtyIds, ttySessions, spawnTty, openTty, hideTty, closeTty, renameTty],
  );

  // Dérive les panneaux visibles + leurs positions. Le chat reste ancré à droite ;
  // les terminaux s'empilent à sa gauche, le plus récent collé au chat.
  const chatOpen = chatAgentId !== null;
  const { placements, budget } = computeTtyLayout(openTtyIds, widths, viewportWidth, chatOpen);
  const placementById = new Map(placements.map(p => [p.ttyId, p]));

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
        const placement = placementById.get(session.ttyId);
        return (
          <TtyPanel
            key={session.ttyId}
            ttyId={session.ttyId}
            title={session.title}
            cwd={session.cwd}
            rightOffset={placement?.rightOffset ?? 16}
            width={placement?.effectiveWidth ?? widths[session.ttyId] ?? DEFAULT_WIDTH}
            maxWidth={placement?.maxWidth ?? budget}
            active={placement !== undefined}
            onResizeWidth={w => setTtyWidth(session.ttyId, w)}
            onClose={() => closeTty(session.ttyId)}
            onMinimize={() => hideTty(session.ttyId)}
            onRename={newTitle => renameTty(session.ttyId, newTitle)}
          />
        );
      })}
    </TtyContext.Provider>
  );
}
