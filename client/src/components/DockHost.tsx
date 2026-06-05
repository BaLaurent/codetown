// client/src/components/DockHost.tsx
// Source de vérité du layout des panneaux dockables. Détient l'ORDRE d'ouverture
// (toutes kinds confondues), les largeurs, le mode et la clé maximisée. Calcule les
// placements via computeDockLayout. Les hosts (TtyHost/ChatHost) restent propriétaires
// de LEURS données (sessions, threads) et lisent placementFor() pour rendre.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  computeDockLayout, resizeDockedWidths, computeDockHeight,
  type DockPanel, type DockPlacement, type LayoutMode, type PanelKind,
} from './dock-layout';

const MODE_KEY = 'codetown:dock-mode';

interface DockControl {
  mode: LayoutMode;
  toggleMode: () => void;
  dockHeight: number;
  maximizedKey: string | null;
  placementFor: (key: string) => DockPlacement | undefined;
  openKeysByKind: (kind: PanelKind) => string[];
  openPanel: (kind: PanelKind, id: string) => void;
  closePanel: (kind: PanelKind, id: string) => void;
  setWidth: (key: string, width: number) => void;
  maximize: (key: string) => void;
  restore: () => void;
}

const DockContext = createContext<DockControl | null>(null);

export function useDock(): DockControl {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error('useDock must be used within a DockProvider');
  return ctx;
}

export function DockProvider({ children }: { children: ReactNode }) {
  const [order, setOrder] = useState<DockPanel[]>([]);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [maximizedKey, setMaximizedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<LayoutMode>(
    () => (localStorage.getItem(MODE_KEY) === 'docked' ? 'docked' : 'floating'),
  );
  const [vw, setVw] = useState(() => window.innerWidth);
  const [vh, setVh] = useState(() => window.innerHeight);

  useEffect(() => {
    const onResize = () => { setVw(window.innerWidth); setVh(window.innerHeight); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleMode = useCallback(() => {
    setMode(prev => {
      const next = prev === 'docked' ? 'floating' : 'docked';
      localStorage.setItem(MODE_KEY, next);
      return next;
    });
  }, []);

  // Ajout idempotent en fin (= le plus récent). Surtout pas un toggle.
  const openPanel = useCallback((kind: PanelKind, id: string) => {
    setOrder(prev => prev.some(p => p.kind === kind && p.id === id) ? prev : [...prev, { kind, id }]);
  }, []);

  const closePanel = useCallback((kind: PanelKind, id: string) => {
    const key = `${kind}:${id}`;
    setOrder(prev => prev.filter(p => !(p.kind === kind && p.id === id)));
    setMaximizedKey(prev => (prev === key ? null : prev));
    setWidths(prev => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const maximize = useCallback((key: string) => setMaximizedKey(key), []);
  const restore = useCallback(() => setMaximizedKey(null), []);

  // En docké : resize split-pane (vole au voisin). En flottant : largeur absolue.
  const setWidth = useCallback((key: string, width: number) => {
    setWidths(prev => {
      if (mode !== 'docked') return { ...prev, [key]: width };
      return resizeDockedWidths(order, prev, vw, maximizedKey, key, width);
    });
  }, [mode, order, vw, maximizedKey]);

  const { placements } = useMemo(
    () => computeDockLayout(order, widths, vw, mode, maximizedKey),
    [order, widths, vw, mode, maximizedKey],
  );
  const placementByKey = useMemo(
    () => new Map(placements.map(p => [p.key, p])),
    [placements],
  );

  const dockHeight = computeDockHeight(mode, order.length, vh);

  const openKeysByKind = useCallback(
    (kind: PanelKind) => order.filter(p => p.kind === kind).map(p => p.id),
    [order],
  );

  const control = useMemo<DockControl>(() => ({
    mode, toggleMode, dockHeight, maximizedKey,
    placementFor: (key) => placementByKey.get(key),
    openKeysByKind,
    openPanel, closePanel, setWidth, maximize, restore,
  }), [mode, toggleMode, dockHeight, maximizedKey, placementByKey, openKeysByKind, openPanel, closePanel, setWidth, maximize, restore]);

  return <DockContext.Provider value={control}>{children}</DockContext.Provider>;
}
