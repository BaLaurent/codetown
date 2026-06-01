# Panneaux dockables (terminaux + chats) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un mode « docké » global qui rétrécit réellement le canvas au-dessus d'une barre du bas contenant terminaux et chats (multi-instances), avec resize, éviction au débordement et maximize.

**Architecture :** Un `DockProvider` devient la source de vérité du layout (ordre des panneaux, largeurs, mode, maximize). Un moteur pur unique `computeDockLayout` remplace `computeTtyLayout` et gère deux politiques (flottant = actuel, docké = étiré pleine barre + resize split-pane). Les panneaux restent `position:absolute` au viewport dans les deux modes — « docker » ne fait que rétrécir le conteneur du canvas, donc aucun panneau n'est jamais démonté (les terminaux gardent tmux/scroll/WebSocket).

**Tech Stack :** React + TypeScript, Vitest, canvas 2D, xterm.js. Contexte de référence : `docs/superpowers/specs/2026-06-01-dockable-panels-design.md`.

---

## Structure des fichiers

**Créés :**
- `client/src/components/dock-layout.ts` — moteur pur (remplace `tty-layout.ts`).
- `client/src/components/dock-layout.test.ts` — tests du moteur (porte la parité TTY).
- `client/src/components/DockHost.tsx` — `DockProvider` + `useDock()` (état + dérivations).
- `client/src/components/DockHost.test.ts` — tests des helpers purs du dock (split-pane, dockHeight).
- `client/src/components/ChatPanelContainer.tsx` — cycle de vie d'UN chat (effets ex-`ChatHost`).

**Modifiés :**
- `client/src/components/TtyHost.tsx` — délègue ouverture/largeur/visibilité au dock.
- `client/src/components/ChatHost.tsx` — devient un mapper (un `ChatPanelContainer` par chat ouvert).
- `client/src/components/AgentChatPanel.tsx` — props de placement + poignée de resize + bouton maximize.
- `client/src/components/TtyPanel.tsx` — bouton maximize/restore.
- `client/src/components/HabboRoom.tsx` — canvas dimensionné sur son conteneur.
- `client/src/components/TownView.tsx` — canvas dimensionné sur son conteneur.
- `client/src/App.tsx` — `DockProvider`, conteneur de hauteur dockée, bouton toggle.

**Supprimés (Task 7) :**
- `client/src/components/tty-layout.ts` et `client/src/components/tty-layout.test.ts` (comportement repris par `dock-layout`).

**Commandes :** tests depuis `client/` → `npm test`. Un seul fichier : `npm test -- dock-layout` (vitest filtre par nom).

---

## Phase 1 — Moteur de layout pur

### Task 1 : `dock-layout.ts` — types, constantes, politique FLOTTANT (parité TTY)

**Files:**
- Create: `client/src/components/dock-layout.ts`
- Test: `client/src/components/dock-layout.test.ts`

- [ ] **Step 1 : Écrire les tests de parité flottant (échouent)**

```ts
// client/src/components/dock-layout.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeDockLayout, panelKey,
  DEFAULT_WIDTH, GAP, MARGIN, MIN_WIDTH,
  type DockPanel,
} from './dock-layout';

const WIDE = 1920;
const tty = (id: string): DockPanel => ({ kind: 'tty', id });

describe('computeDockLayout — politique flottant (parité TTY)', () => {
  it('place un panneau unique à right:16', () => {
    const { placements } = computeDockLayout([tty('a')], {}, WIDE, 'floating', null);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({
      key: 'tty:a', kind: 'tty', id: 'a', rightOffset: MARGIN, effectiveWidth: DEFAULT_WIDTH,
    });
  });

  it('empile : le plus récent (dernier) à droite, le plus ancien à sa gauche', () => {
    const { placements } = computeDockLayout([tty('old'), tty('new')], {}, WIDE, 'floating', null);
    expect(placements.map(p => p.id)).toEqual(['old', 'new']); // ordre d'affichage gauche→droite
    expect(placements.find(p => p.id === 'new')!.rightOffset).toBe(MARGIN);
    expect(placements.find(p => p.id === 'old')!.rightOffset).toBe(MARGIN + DEFAULT_WIDTH + GAP);
  });

  it('évince le plus ancien (FIFO) quand le budget est dépassé, garde ≥1', () => {
    const { placements } = computeDockLayout([tty('old'), tty('new')], {}, 800, 'floating', null);
    expect(placements).toHaveLength(1);
    expect(placements[0].id).toBe('new');
  });

  it('auto-restaure quand le viewport s\'agrandit', () => {
    const narrow = computeDockLayout([tty('old'), tty('new')], {}, 800, 'floating', null);
    const wide = computeDockLayout([tty('old'), tty('new')], {}, WIDE, 'floating', null);
    expect(narrow.placements).toHaveLength(1);
    expect(wide.placements).toHaveLength(2);
  });

  it('un panneau élargi (largeur custom, clé) peut absorber l\'espace libre via maxWidth', () => {
    const { placements } = computeDockLayout([tty('a')], { 'tty:a': 600 }, WIDE, 'floating', null);
    expect(placements[0].effectiveWidth).toBe(600);
    expect(placements[0].maxWidth).toBeGreaterThan(600); // peut grandir jusqu'au budget
  });

  it('liste vide → aucun placement', () => {
    const { placements } = computeDockLayout([], {}, WIDE, 'floating', null);
    expect(placements).toHaveLength(0);
  });

  it('panneaux hétérogènes : un chat est un panneau comme un autre', () => {
    const panels: DockPanel[] = [tty('a'), { kind: 'chat', id: 'agent1' }];
    const { placements } = computeDockLayout(panels, {}, WIDE, 'floating', null);
    expect(placements.map(p => p.key)).toEqual(['tty:a', 'chat:agent1']);
    expect(panelKey(panels[1])).toBe('chat:agent1');
  });
});
```

- [ ] **Step 2 : Lancer → échec**

Run: `cd client && npm test -- dock-layout`
Expected: FAIL (`dock-layout` introuvable).

- [ ] **Step 3 : Implémenter `dock-layout.ts` (constantes, types, politique flottant)**

```ts
// client/src/components/dock-layout.ts
// Moteur de placement unique des panneaux dockables (terminaux + chats).
// Remplace tty-layout.ts. La visibilité est une DÉRIVATION PURE du budget :
// rien n'est retiré de l'ordre, on calcule le sous-ensemble le plus récent qui tient.
export const DEFAULT_WIDTH = 420;
export const MIN_WIDTH = 240;
export const GAP = 16;
export const MARGIN = 16;
// Hauteur d'un panneau (doit rester synchro avec le CSS height:'min(52vh,520px)').
export const PANEL_HEIGHT_VH = 0.52;
export const PANEL_HEIGHT_MAX = 520;

export type PanelKind = 'tty' | 'chat';
export type LayoutMode = 'floating' | 'docked';
export interface DockPanel { kind: PanelKind; id: string; }

export function panelKey(p: DockPanel): string { return `${p.kind}:${p.id}`; }

export interface DockPlacement {
  key: string;
  kind: PanelKind;
  id: string;
  rightOffset: number;     // distance au bord droit du viewport
  effectiveWidth: number;  // largeur réellement rendue
  maxWidth: number;        // plafond du drag pour ce panneau
}

export interface DockLayout {
  placements: DockPlacement[]; // visibles uniquement, gauche→droite
  budget: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// panels : ordre d'ouverture, le plus récent EN DERNIER (prioritaire à l'affichage).
export function computeDockLayout(
  panels: DockPanel[],
  widths: Record<string, number>,
  viewportWidth: number,
  mode: LayoutMode,
  maximizedKey: string | null,
): DockLayout {
  const budget = Math.max(MIN_WIDTH, viewportWidth - MARGIN - MARGIN);

  // Maximize : un seul panneau pleine largeur, les autres non placés (→ cachés).
  const maxed = maximizedKey ? panels.find(p => panelKey(p) === maximizedKey) : undefined;
  if (maxed) {
    return {
      budget,
      placements: [{
        key: panelKey(maxed), kind: maxed.kind, id: maxed.id,
        rightOffset: MARGIN, effectiveWidth: budget, maxWidth: budget,
      }],
    };
  }

  if (mode === 'docked') return layoutDocked(panels, widths, budget);
  return layoutFloating(panels, widths, budget);
}

// Largeurs fixes, ancrées à droite, le plus récent collé au bord droit, éviction FIFO.
function layoutFloating(panels: DockPanel[], widths: Record<string, number>, budget: number): DockLayout {
  const placed: Omit<DockPlacement, 'maxWidth'>[] = [];
  let cursor = MARGIN;
  let consumed = 0;
  for (let i = panels.length - 1; i >= 0; i--) {
    const p = panels[i];
    const key = panelKey(p);
    const w = clamp(widths[key] ?? DEFAULT_WIDTH, MIN_WIDTH, budget);
    const gapBefore = placed.length === 0 ? 0 : GAP;
    const next = consumed + gapBefore + w;
    if (next > budget && placed.length > 0) break; // garde ≥1
    cursor += gapBefore;
    placed.push({ key, kind: p.kind, id: p.id, rightOffset: cursor, effectiveWidth: w });
    cursor += w;
    consumed = next;
  }
  const freeSpace = budget - consumed;
  const withMax = placed.map(p => ({ ...p, maxWidth: p.effectiveWidth + freeSpace }));
  withMax.reverse(); // gauche→droite
  return { placements: withMax, budget };
}

// Stub remplacé en Task 2.
function layoutDocked(panels: DockPanel[], widths: Record<string, number>, budget: number): DockLayout {
  return layoutFloating(panels, widths, budget);
}
```

- [ ] **Step 4 : Lancer → succès**

Run: `cd client && npm test -- dock-layout`
Expected: PASS (7 tests).

- [ ] **Step 5 : Commit**

```bash
git add client/src/components/dock-layout.ts client/src/components/dock-layout.test.ts
git commit -m "feat(dock): moteur de layout pur — politique flottant + parité TTY"
```

---

### Task 2 : Politique DOCKÉ (étirement pleine barre + éviction au MIN_WIDTH)

**Files:**
- Modify: `client/src/components/dock-layout.ts` (remplacer le stub `layoutDocked`)
- Test: `client/src/components/dock-layout.test.ts` (ajouter un bloc)

- [ ] **Step 1 : Ajouter les tests docké (échouent)**

```ts
// Ajouter dans dock-layout.test.ts
describe('computeDockLayout — politique docké (étirée)', () => {
  it('un seul panneau remplit toute la barre (pas de zone vide)', () => {
    const { placements, budget } = computeDockLayout([tty('a')], {}, WIDE, 'docked', null);
    expect(placements[0].effectiveWidth).toBe(budget);
    expect(placements[0].rightOffset).toBe(MARGIN);
  });

  it('deux panneaux par défaut se partagent la barre à parts égales', () => {
    const { placements, budget } = computeDockLayout([tty('a'), tty('b')], {}, WIDE, 'docked', null);
    const each = (budget - GAP) / 2;
    expect(placements.map(p => p.effectiveWidth)).toEqual([each, each]);
    // somme + gap == budget (remplit toute la barre)
    expect(placements[0].effectiveWidth + GAP + placements[1].effectiveWidth).toBe(budget);
  });

  it('largeurs custom : réparties proportionnellement, somme == budget', () => {
    const { placements, budget } = computeDockLayout(
      [tty('a'), tty('b')], { 'tty:a': 300, 'tty:b': 900 }, WIDE, 'docked', null,
    );
    const total = placements.reduce((s, p) => s + p.effectiveWidth, 0) + GAP * (placements.length - 1);
    expect(total).toBe(budget);
    expect(placements.find(p => p.id === 'b')!.effectiveWidth)
      .toBeGreaterThan(placements.find(p => p.id === 'a')!.effectiveWidth);
  });

  it('évince le plus ancien quand même MIN_WIDTH chacun ne tient plus', () => {
    // budget≈768 ; 2*MIN_WIDTH(240)+GAP = 496 OK ; 3*240+2*16 = 752 OK ; 4*240+3*16=1008 > 768
    const wide4 = computeDockLayout(
      [tty('a'), tty('b'), tty('c'), tty('d')], {}, 800, 'docked', null,
    );
    expect(wide4.placements).toHaveLength(3);
    expect(wide4.placements.map(p => p.id)).toEqual(['b', 'c', 'd']); // 'a' (plus ancien) évincé
  });
});
```

- [ ] **Step 2 : Lancer → échec**

Run: `cd client && npm test -- dock-layout`
Expected: FAIL (l'étirement n'est pas implémenté — le stub renvoie du flottant).

- [ ] **Step 3 : Implémenter `layoutDocked`**

```ts
// Remplacer la fonction stub layoutDocked dans dock-layout.ts
// Docké : le sous-ensemble visible (au plus N tenant à MIN_WIDTH) se RÉPARTIT sur
// toute la barre, proportionnellement aux largeurs stockées. maxWidth (split-pane)
// = largeur actuelle + ce que le voisin de droite peut céder jusqu'à MIN_WIDTH.
function layoutDocked(panels: DockPanel[], widths: Record<string, number>, budget: number): DockLayout {
  // 1) Sous-ensemble visible : du plus récent au plus ancien tant qu'ils tiennent à MIN_WIDTH.
  const visible: DockPanel[] = [];
  for (let i = panels.length - 1; i >= 0; i--) {
    const n = visible.length + 1;
    const needed = n * MIN_WIDTH + (n - 1) * GAP;
    if (needed > budget && visible.length > 0) break;
    visible.unshift(panels[i]); // garde l'ordre gauche→droite
  }
  if (visible.length === 0) return { placements: [], budget };

  // 2) Répartition proportionnelle aux largeurs stockées (défaut = DEFAULT_WIDTH).
  const n = visible.length;
  const available = budget - GAP * (n - 1);
  const stored = visible.map(p => widths[panelKey(p)] ?? DEFAULT_WIDTH);
  const sum = stored.reduce((s, w) => s + w, 0);
  const raw = stored.map(w => Math.max(MIN_WIDTH, Math.round((w / sum) * available)));
  // Corrige l'arrondi pour que la somme == available (ajuste le plus large).
  const drift = available - raw.reduce((s, w) => s + w, 0);
  if (drift !== 0) {
    const idx = raw.indexOf(Math.max(...raw));
    raw[idx] = Math.max(MIN_WIDTH, raw[idx] + drift);
  }

  // 3) Place de gauche à droite ; rightOffset mesuré depuis le bord droit.
  const totalRowWidth = raw.reduce((s, w) => s + w, 0) + GAP * (n - 1); // == budget
  const placements: DockPlacement[] = [];
  let leftCursor = 0;
  for (let i = 0; i < n; i++) {
    const w = raw[i];
    const rightOffset = MARGIN + (totalRowWidth - (leftCursor + w));
    // split-pane : peut prendre ce que le voisin de DROITE peut céder.
    const rightNeighbor = i < n - 1 ? raw[i + 1] : 0;
    const maxWidth = w + Math.max(0, rightNeighbor - MIN_WIDTH);
    placements.push({
      key: panelKey(visible[i]), kind: visible[i].kind, id: visible[i].id,
      rightOffset, effectiveWidth: w, maxWidth,
    });
    leftCursor += w + GAP;
  }
  return { placements, budget };
}
```

- [ ] **Step 4 : Lancer → succès (parité flottant intacte)**

Run: `cd client && npm test -- dock-layout`
Expected: PASS (tous les blocs).

- [ ] **Step 5 : Commit**

```bash
git add client/src/components/dock-layout.ts client/src/components/dock-layout.test.ts
git commit -m "feat(dock): politique docké — étirement pleine barre + éviction au MIN_WIDTH"
```

---

### Task 3 : Maximize (déjà câblé dans le moteur — verrouiller par tests)

**Files:**
- Test: `client/src/components/dock-layout.test.ts` (ajouter un bloc)

> Le branchement `maximizedKey` a été écrit en Task 1. Cette tâche le **verrouille** par des tests (TDD a posteriori sur une branche déjà présente, acceptable car on ajoute la couverture qui manquait au design « maximize partagé »).

- [ ] **Step 1 : Ajouter les tests maximize**

```ts
// Ajouter dans dock-layout.test.ts
describe('computeDockLayout — maximize', () => {
  it('un seul placement pleine largeur quand une clé est maximisée', () => {
    const { placements, budget } = computeDockLayout(
      [tty('a'), tty('b'), tty('c')], {}, WIDE, 'docked', 'tty:b',
    );
    expect(placements).toHaveLength(1);
    expect(placements[0].key).toBe('tty:b');
    expect(placements[0].effectiveWidth).toBe(budget);
    expect(placements[0].rightOffset).toBe(MARGIN);
  });

  it('maximize fonctionne aussi en flottant', () => {
    const { placements, budget } = computeDockLayout(
      [tty('a'), tty('b')], {}, WIDE, 'floating', 'tty:a',
    );
    expect(placements).toHaveLength(1);
    expect(placements[0].key).toBe('tty:a');
    expect(placements[0].effectiveWidth).toBe(budget);
  });

  it('maximizedKey inconnue → ignorée (layout normal)', () => {
    const { placements } = computeDockLayout(
      [tty('a'), tty('b')], {}, WIDE, 'floating', 'tty:zzz',
    );
    expect(placements).toHaveLength(2);
  });
});
```

- [ ] **Step 2 : Lancer → succès immédiat**

Run: `cd client && npm test -- dock-layout`
Expected: PASS (le branchement existe déjà).

- [ ] **Step 3 : Commit**

```bash
git add client/src/components/dock-layout.test.ts
git commit -m "test(dock): verrouille le comportement maximize du moteur"
```

---

## Phase 2 — Provider du dock

### Task 4 : `DockHost.tsx` — état, actions, dérivations + resize split-pane

**Files:**
- Create: `client/src/components/DockHost.tsx`
- Create: `client/src/components/DockHost.test.ts`

- [ ] **Step 1 : Tester les helpers purs (split-pane + dockHeight) — échec**

```ts
// client/src/components/DockHost.test.ts
import { describe, it, expect } from 'vitest';
import { redistributeWidth, computeDockHeight } from './DockHost';
import { GAP, MARGIN } from './dock-layout';

describe('redistributeWidth (resize split-pane, docké)', () => {
  const visible = ['tty:a', 'tty:b']; // gauche→droite

  it('agrandir A vole la place à son voisin de droite B', () => {
    const next = redistributeWidth(visible, { 'tty:a': 400, 'tty:b': 400 }, 'tty:a', 500);
    expect(next['tty:a']).toBe(500);
    expect(next['tty:b']).toBe(300);
  });

  it('ne fait pas passer le voisin sous MIN_WIDTH', () => {
    const next = redistributeWidth(visible, { 'tty:a': 400, 'tty:b': 300 }, 'tty:a', 900);
    expect(next['tty:b']).toBe(240);          // MIN_WIDTH
    expect(next['tty:a']).toBe(400 + (300 - 240)); // n'a pris que ce que B pouvait céder
  });

  it('le panneau le plus à droite ne peut pas grandir (pas de voisin droite)', () => {
    const next = redistributeWidth(visible, { 'tty:a': 400, 'tty:b': 400 }, 'tty:b', 600);
    expect(next['tty:b']).toBe(400);
    expect(next['tty:a']).toBe(400);
  });
});

describe('computeDockHeight', () => {
  it('0 en flottant', () => {
    expect(computeDockHeight('floating', 2, 1000)).toBe(0);
  });
  it('0 si aucun panneau ouvert', () => {
    expect(computeDockHeight('docked', 0, 1000)).toBe(0);
  });
  it('hauteur panneau + marges en docké avec des panneaux (plafond 520)', () => {
    expect(computeDockHeight('docked', 1, 2000)).toBe(520 + 32); // 0.52*2000=1040 → plafonné 520
    expect(computeDockHeight('docked', 1, 800)).toBe(Math.round(0.52 * 800) + 32);
  });
});
```

- [ ] **Step 2 : Lancer → échec**

Run: `cd client && npm test -- DockHost`
Expected: FAIL (`DockHost` introuvable).

- [ ] **Step 3 : Implémenter `DockHost.tsx`**

```tsx
// client/src/components/DockHost.tsx
// Source de vérité du layout des panneaux dockables. Détient l'ORDRE d'ouverture
// (toutes kinds confondues), les largeurs, le mode et la clé maximisée. Calcule les
// placements via computeDockLayout. Les hosts (TtyHost/ChatHost) restent propriétaires
// de LEURS données (sessions, threads) et lisent placementFor() pour rendre.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  computeDockLayout, panelKey, MIN_WIDTH, PANEL_HEIGHT_VH, PANEL_HEIGHT_MAX,
  type DockPanel, type DockPlacement, type LayoutMode, type PanelKind,
} from './dock-layout';

const MODE_KEY = 'codemap:dock-mode';

// Resize docké : le panneau `key` grandit jusqu'à desired, en prenant UNIQUEMENT
// ce que son voisin de droite peut céder jusqu'à MIN_WIDTH. Pure → testable.
export function redistributeWidth(
  visibleKeysLeftToRight: string[],
  widths: Record<string, number>,
  key: string,
  desiredWidth: number,
): Record<string, number> {
  const i = visibleKeysLeftToRight.indexOf(key);
  if (i < 0 || i === visibleKeysLeftToRight.length - 1) return widths; // pas de voisin droite
  const rightKey = visibleKeysLeftToRight[i + 1];
  const cur = widths[key] ?? 0;
  const rightCur = widths[rightKey] ?? 0;
  const grow = Math.max(0, Math.min(desiredWidth - cur, rightCur - MIN_WIDTH));
  return { ...widths, [key]: cur + grow, [rightKey]: rightCur - grow };
}

// Hauteur réservée en bas pour le dock (synchro avec le CSS du panneau).
export function computeDockHeight(mode: LayoutMode, openCount: number, viewportHeight: number): number {
  if (mode !== 'docked' || openCount === 0) return 0;
  const panelPx = Math.min(Math.round(PANEL_HEIGHT_VH * viewportHeight), PANEL_HEIGHT_MAX);
  return panelPx + 32; // 16 (marge bas) + 16 (espace au-dessus)
}

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
  }, []);

  const maximize = useCallback((key: string) => setMaximizedKey(key), []);
  const restore = useCallback(() => setMaximizedKey(null), []);

  // En docké : resize split-pane (vole au voisin). En flottant : largeur absolue.
  const setWidth = useCallback((key: string, width: number) => {
    setWidths(prev => {
      if (mode !== 'docked') return { ...prev, [key]: width };
      const visibleKeys = computeDockLayout(order, prev, vw, 'docked', maximizedKey)
        .placements.map(p => p.key);
      return redistributeWidth(visibleKeys, prev, key, width);
    });
  }, [mode, order, vw, maximizedKey]);

  const { placements } = computeDockLayout(order, widths, vw, mode, maximizedKey);
  const placementByKey = useMemo(
    () => new Map(placements.map(p => [p.key, p])),
    [placements],
  );

  const dockHeight = computeDockHeight(mode, order.length, vh);

  const control = useMemo<DockControl>(() => ({
    mode, toggleMode, dockHeight, maximizedKey,
    placementFor: (key) => placementByKey.get(key),
    openKeysByKind: (kind) => order.filter(p => p.kind === kind).map(p => p.id),
    openPanel, closePanel, setWidth, maximize, restore,
  }), [mode, toggleMode, dockHeight, maximizedKey, placementByKey, order, openPanel, closePanel, setWidth, maximize, restore]);

  return <DockContext.Provider value={control}>{children}</DockContext.Provider>;
}
```

> Note : `useCallback`/`useState`/etc. — corriger la casse de l'import (`useCallback`), c'est juste `react`. Garder l'ordre des hooks stable.

- [ ] **Step 4 : Lancer → succès**

Run: `cd client && npm test -- DockHost`
Expected: PASS.

- [ ] **Step 5 : Vérifier que tout le reste compile/teste**

Run: `cd client && npm test`
Expected: PASS (aucun consommateur de `DockHost` encore — les tests existants sont intacts).

- [ ] **Step 6 : Commit**

```bash
git add client/src/components/DockHost.tsx client/src/components/DockHost.test.ts
git commit -m "feat(dock): DockProvider — ordre/largeurs/mode/maximize + resize split-pane"
```

---

## Phase 3 — Rétrécissement réel du canvas

### Task 5 : Dimensionner `HabboRoom` et `TownView` sur leur conteneur

**Files:**
- Modify: `client/src/components/HabboRoom.tsx:1334-1339` et `:1575`
- Modify: `client/src/components/TownView.tsx:50` et `:164`

> Cœur technique : non couvert par l'unitaire → **vérification navigateur** en Step final.

- [ ] **Step 1 : `HabboRoom` — root en 100% et mesure du conteneur**

Dans `HabboRoom.tsx`, remplacer le root (`:1575`) :

```tsx
// AVANT : <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', ... }}>
<div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', backgroundColor: '#C8E8F8' }}>
```

Remplacer le `resize` (`:1334-1339`) pour mesurer le parent au lieu de `window`, via `ResizeObserver` :

```tsx
const resize = () => {
  const parent = canvas.parentElement;
  canvas.width = parent ? parent.clientWidth : window.innerWidth;
  canvas.height = parent ? parent.clientHeight : window.innerHeight;
};
resize();
const ro = new ResizeObserver(resize);
if (canvas.parentElement) ro.observe(canvas.parentElement);
window.addEventListener('resize', resize);
```

Et dans le cleanup de ce `useEffect`, ajouter `ro.disconnect();` à côté du `window.removeEventListener('resize', resize)` existant.

> Les clics/zoom de HabboRoom utilisent déjà `getBoundingClientRect()` (`:1352`, `:1429`) → restent corrects même décalés.

- [ ] **Step 2 : `TownView` — mesure du conteneur**

Dans `TownView.tsx`, remplacer `:50` :

```tsx
// AVANT : const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
const resize = () => {
  const parent = canvas.parentElement;
  canvas.width = parent ? parent.clientWidth : window.innerWidth;
  canvas.height = parent ? parent.clientHeight : window.innerHeight;
};
resize();
const ro = new ResizeObserver(resize);
if (canvas.parentElement) ro.observe(canvas.parentElement);
window.addEventListener('resize', resize);
```

Ajouter `ro.disconnect();` dans le cleanup (à côté du `window.removeEventListener('resize', resize)` ligne `:141`).

Mettre le canvas en remplissage du conteneur (`:164`) :

```tsx
<canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
```

> `TownView` hit-test utilise `e.clientX/clientY` bruts (`:114`, `:120`, `:124`). Le conteneur du canvas étant ancré en haut-gauche (0,0), ces coordonnées restent valides (le dock est en bas). Aucun changement requis ici.

- [ ] **Step 3 : Compiler + tests existants**

Run: `cd client && npm test && npm run build`
Expected: PASS / build OK (comportement visuel inchangé tant que le conteneur reste plein écran — vérifié en Task 6).

- [ ] **Step 4 : Commit**

```bash
git add client/src/components/HabboRoom.tsx client/src/components/TownView.tsx
git commit -m "refactor(canvas): dimensionner sur le conteneur (ResizeObserver) au lieu de window"
```

---

### Task 6 : Imbriquer `DockProvider`, conteneur de hauteur dockée, bouton toggle

**Files:**
- Modify: `client/src/App.tsx:94-101` (imbrication), `:124-150` (conteneur + nav)

- [ ] **Step 1 : Importer et imbriquer `DockProvider` (le plus externe des trois)**

Dans `App.tsx`, ajouter l'import :

```tsx
import { DockProvider, useDock } from './components/DockHost';
```

Modifier `HotelView` (`:94-101`) :

```tsx
<AgentStreamProvider projectId={selectedProject ?? undefined}>
  <DockProvider>
    <ChatProvider>
      <TtyProvider>
        <HotelViewInner selectedProject={selectedProject} onSelectProject={setSelectedProject} />
      </TtyProvider>
    </ChatProvider>
  </DockProvider>
</AgentStreamProvider>
```

- [ ] **Step 2 : Conteneur de canvas à hauteur dockée + bouton toggle dans `HotelViewInner`**

Dans `HotelViewInner`, lire le dock et envelopper `TownView` :

```tsx
const { openChat } = useChat();
const { mode, toggleMode, dockHeight } = useDock();
// ...
return (
  <>
    <div style={{
      width: '100vw',
      height: mode === 'docked' ? `calc(100vh - ${dockHeight}px)` : '100vh',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <TownView selected={selectedProject} onSelect={onSelectProject} focusRequest={focusRequest} actionRequest={actionRequest} />
    </div>
    <AgentRosterPanel onSelectAgent={handleSelectAgent} onOpenChat={openChat} onRespond={handleRespond} />
    <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 20, display: 'flex', gap: 8 }}>
      <Link to="/" style={navLinkStyle}>Tree</Link>
      <Link to="/hotel" style={navLinkStyle}>Hotel</Link>
      {selectedProject && (
        <button onClick={() => onSelectProject(null)} style={{ ...navLinkStyle, cursor: 'pointer' }} title="Back to the town overview">← Town</button>
      )}
      <button
        onClick={toggleMode}
        style={{ ...navLinkStyle, cursor: 'pointer' }}
        title={mode === 'docked' ? 'Repasser les panneaux en flottant' : 'Docker les panneaux en bas'}
      >⬓ {mode === 'docked' ? 'Float' : 'Dock'}</button>
      <MuteButton />
    </div>
  </>
);
```

> Les panneaux (rendus par TtyProvider/ChatProvider, hors de ce conteneur) restent absolus au viewport → ils tombent dans la bande libérée.

- [ ] **Step 3 : Compiler + tests**

Run: `cd client && npm test && npm run build`
Expected: PASS / build OK.

- [ ] **Step 4 : VÉRIFICATION NAVIGATEUR (manuelle)**

Lancer `npm run dev` (racine). Sur `http://localhost:5173/hotel` :
1. Spawn un terminal (bouton bas-gauche). Cliquer `⬓ Dock`.
   - **Attendu :** la carte se redessine plus petite, le terminal occupe une vraie barre en bas, **zéro chevauchement**. Recharger : le mode docké persiste.
2. Cliquer une tuile/agent dans la carte rétrécie → le clic atterrit au bon endroit (mapping `getBoundingClientRect` OK). Zoom molette → centré correctement.
3. Repasser `⬓ Float` → la carte reprend tout l'écran, le terminal flotte par-dessus comme avant.

> À ce stade le dock ne réserve sa hauteur que si des panneaux sont **enregistrés** dans le dock — ce qui n'arrive qu'après Task 7/8. Donc avant Task 7, le toggle change le mode mais `dockHeight=0` (rien d'enregistré). La vérif visuelle complète se fait à nouveau en fin de Task 7.

- [ ] **Step 5 : Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(dock): DockProvider câblé + conteneur à hauteur dockée + toggle global persisté"
```

---

## Phase 4 — Migrer les panneaux sur le dock

### Task 7 : Migrer `TtyHost` sur le dock + supprimer `tty-layout`

**Files:**
- Modify: `client/src/components/TtyHost.tsx`
- Modify: `client/src/components/TtyPanel.tsx:7` (import MIN_WIDTH)
- Delete: `client/src/components/tty-layout.ts`, `client/src/components/tty-layout.test.ts`

- [ ] **Step 1 : Grep des consommateurs restants (garde-fou avant suppression)**

Run: `cd client && rg -n "tty-layout|computeTtyLayout|CHAT_WIDTH" src`
Expected : seulement `TtyHost.tsx`, `TtyPanel.tsx` (import `MIN_WIDTH`), et les fichiers `tty-layout*`. (Sinon, traiter chaque consommateur avant de continuer.)

- [ ] **Step 2 : `TtyPanel` — réimporter `MIN_WIDTH` depuis `dock-layout`**

Dans `TtyPanel.tsx:7` :

```tsx
import { MIN_WIDTH } from './dock-layout';
```

- [ ] **Step 3 : Réécrire `TtyHost` pour déléguer au dock**

Remplacer le corps de `TtyProvider` : retirer `openTtyIds`, `widths`, `viewportWidth`, `computeTtyLayout`, `useChat`. La visibilité/positionnement vient du dock. `TtyHost` garde la propriété des **sessions** et des appels serveur.

```tsx
// client/src/components/TtyHost.tsx — extraits clés
import { createContext, useCallback, useContext, useEffect, useState, useMemo, type ReactNode } from 'react';
import { TtyPanel } from './TtyPanel';
import { useDock } from './DockHost';
import { getTtyTitle, setTtyTitle, clearTtyTitle } from '../utils/tty-titles';
import { DEFAULT_WIDTH } from './dock-layout';

// ... TtySessionClient, TtyControl, useTty inchangés ...

export function TtyProvider({ children }: { children: ReactNode }) {
  const [ttySessions, setTtySessions] = useState<TtySessionClient[]>([]);
  const dock = useDock();

  // openTtyIds dérive du dock (pour l'API publique useTty()).
  const openTtyIds = dock.openKeysByKind('tty');

  // réhydratation des sessions au mount : inchangée.

  const spawnTty = useCallback(async (projectId?: string) => {
    const r = await fetch(`${API_URL}/tty/spawn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }) });
    if (!r.ok) return;
    const info: TtySessionClient = await r.json();
    setTtySessions(prev => [...prev, { ...info, title: getTtyTitle(info.ttyId, info.title) }]);
    dock.openPanel('tty', info.ttyId);
  }, [dock]);

  const openTty = useCallback((ttyId: string) => dock.openPanel('tty', ttyId), [dock]);
  const hideTty = useCallback((ttyId: string) => dock.closePanel('tty', ttyId), [dock]); // session conservée
  const closeTty = useCallback((ttyId: string) => {
    fetch(`${API_URL}/tty/${ttyId}`, { method: 'DELETE' }).catch(() => {});
    clearTtyTitle(ttyId);
    setTtySessions(prev => prev.filter(s => s.ttyId !== ttyId));
    dock.closePanel('tty', ttyId);
  }, [dock]);
  const renameTty = useCallback((ttyId: string, newTitle: string) => { /* inchangé */ }, []);

  const control = useMemo<TtyControl>(
    () => ({ openTtyIds, ttySessions, spawnTty, openTty, hideTty, closeTty, renameTty }),
    [openTtyIds, ttySessions, spawnTty, openTty, hideTty, closeTty, renameTty],
  );

  return (
    <TtyContext.Provider value={control}>
      {children}
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
```

> `isMaximized`/`onToggleMaximize` sont consommés en Task 9 (bouton). Les déclarer dès maintenant garde `TtyPanel` cohérent (props ajoutées au Step suivant).

- [ ] **Step 4 : Ajouter les props `isMaximized`/`onToggleMaximize` à `TtyPanel` (sans UI encore)**

Dans `TtyPanel.tsx`, ajouter à l'interface `TtyPanelProps` et à la signature :

```tsx
isMaximized: boolean;
onToggleMaximize: () => void;
```

(L'utilisation visuelle — le bouton — arrive en Task 9. Les déclarer maintenant évite une erreur de type.)

- [ ] **Step 5 : Supprimer `tty-layout`**

```bash
git rm client/src/components/tty-layout.ts client/src/components/tty-layout.test.ts
```

- [ ] **Step 6 : Tests + build**

Run: `cd client && npm test && npm run build`
Expected: PASS. La parité TTY est désormais garantie par `dock-layout.test.ts`.

- [ ] **Step 7 : VÉRIFICATION NAVIGATEUR**

`npm run dev` → `/hotel` :
1. Spawn 2-3 terminaux en flottant → empilage à droite **identique à avant** (non-régression).
2. `⬓ Dock` → ils s'étirent sur toute la barre, la carte rétrécit, zéro chevauchement.
3. Drag le bord gauche d'un terminal en docké → il grandit, le voisin de droite rétrécit (split-pane).
4. Drag en flottant → comportement absolu d'avant (absorbe l'espace libre).
5. Réduire un terminal (`─`) → masqué, session vivante ; le rouvrir conserve l'historique tmux.

- [ ] **Step 8 : Commit**

```bash
git add client/src/components/TtyHost.tsx client/src/components/TtyPanel.tsx
git commit -m "feat(dock): TtyHost piloté par le dock ; suppression de tty-layout (parité couverte)"
```

---

### Task 8 : Multi-chat — `ChatPanelContainer` + `ChatHost` mapper + placement du chat

**Files:**
- Create: `client/src/components/ChatPanelContainer.tsx`
- Modify: `client/src/components/ChatHost.tsx`
- Modify: `client/src/components/AgentChatPanel.tsx:24-30` (placement) + signature

- [ ] **Step 1 : `AgentChatPanel` accepte le placement + poignée de resize**

Dans `AgentChatPanel.tsx`, le `panel` style devient dynamique. Ajouter à la signature de props :

```tsx
rightOffset: number;
width: number;
maxWidth: number;
active: boolean;
isMaximized: boolean;
onResizeWidth: (width: number) => void;
onToggleMaximize: () => void;
```

Remplacer la constante `panel` (`:24-30`) par un style calculé dans le composant (le `position`/dimensions viennent du dock, comme `TtyPanel`) :

```tsx
const panelStyle: CSSProperties = {
  position: 'absolute', bottom: 16, right: rightOffset, zIndex: active ? 26 : 25,
  width, height: 'min(52vh, 520px)',
  display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
  background: C.cream, color: C.ink,
  border: `4px solid ${C.border}`, boxShadow: '8px 8px 0 rgba(0,0,0,0.35)',
  visibility: active ? 'visible' : 'hidden',
  pointerEvents: active ? 'auto' : 'none',
};
```

Reprendre le handler de resket de `TtyPanel` (poignée bord gauche, refs `maxWidthRef`/`onResizeWidthRef`, listeners globaux `mousemove`/`mouseup` en deps `[]`, clamp `[MIN_WIDTH, maxWidthRef.current]`). Importer `MIN_WIDTH` depuis `./dock-layout`. Rendre la poignée comme premier enfant du panel :

```tsx
<div onMouseDown={onResizeMouseDown} style={{ position: 'absolute', left: -4, top: 0, bottom: 0, width: 8, cursor: 'ew-resize', zIndex: 1 }} />
```

Remplacer `<div style={panel} onPaste={onPaste}>` par `<div style={panelStyle} onPaste={onPaste}>`.

- [ ] **Step 2 : `ChatPanelContainer` — cycle de vie d'UN chat**

Extraire de `ChatHost` toute la logique par-chat (transcript/capabilities/graph, écoute rename, RAF poll) dans un composant prenant `agentId` + le placement, **gaté sur `active`** pour le RAF poll. Squelette :

```tsx
// client/src/components/ChatPanelContainer.tsx
import { useEffect, useMemo, useState } from 'react';
import { AgentChatPanel } from './AgentChatPanel';
import { useAgentStream } from '../hooks/AgentStream';
import { mergeTranscript } from '../utils/chat-transcript';
import { getAgentName, AGENT_NAMES_CHANGED } from '../utils/agent-names';
import type { AgentCapabilities, ChatMessage, GraphData, ModelOption } from '../types';
import type { DockPlacement } from './dock-layout';

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
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [tick, setTick] = useState(0);

  // Effets transcript + capabilities + graph : repris de ChatHost mais clés sur agentId
  // (constante de ce composant, donc plus de dépendance à un chatAgentId mutable).
  useEffect(() => { /* fetch transcript → merge dans chatHistoryRef ; fetch caps ; fetch graph "@" */ }, [agentId, chatHistoryRef, chatVersionRef, thinkingAgentsRef]);

  // Rename listener : repris de ChatHost.
  useEffect(() => { const onRename = () => setTick(t => t + 1); window.addEventListener(AGENT_NAMES_CHANGED, onRename); return () => window.removeEventListener(AGENT_NAMES_CHANGED, onRename); }, []);

  // RAF poll : repris de ChatHost MAIS gaté sur `active` (un chat caché ne boucle pas).
  useEffect(() => {
    if (!active) return;
    let raf = 0; let lastChat = chatVersionRef.current; let lastThinking = thinkingVersionRef.current;
    const loop = () => {
      if (chatVersionRef.current !== lastChat || thinkingVersionRef.current !== lastThinking) {
        lastChat = chatVersionRef.current; lastThinking = thinkingVersionRef.current; setTick(t => t + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, chatVersionRef, thinkingVersionRef]);

  const history = useMemo<ChatMessage[]>(() => chatHistoryRef.current.get(agentId) ?? [], [agentId, tick, chatHistoryRef]);
  // sendChat/stopChat/setMode/setModel/setEffort/attachFiles : repris de ChatHost, paramétrés par agentId.
  // dead/agent/name : repris du bloc de rendu de ChatHost.

  return (
    <AgentChatPanel
      agentName={getAgentName(agentId, /* agent.displayName */ 'Agent')}
      messages={history}
      /* dead, isThinking, commands, files, models, model, mode, effort, on*… */
      rightOffset={placement?.rightOffset ?? 16}
      width={placement?.effectiveWidth ?? 420}
      maxWidth={placement?.maxWidth ?? 420}
      active={active}
      isMaximized={isMaximized}
      onResizeWidth={onResizeWidth}
      onToggleMaximize={onToggleMaximize}
      onClose={onClose}
    />
  );
}
```

> Note d'implémentation : déplacer **verbatim** les corps d'effets/handlers de `ChatHost.tsx:49-158` ici, en remplaçant `chatAgentId` par `agentId` (constante). Importer `SlashCommand` depuis `../types`.

- [ ] **Step 3 : `ChatHost` devient un mapper**

`ChatProvider` ne garde que l'API `useChat()` (open/close délèguent au dock) et rend un `ChatPanelContainer` par chat ouvert :

```tsx
import { useDock } from './DockHost';
// ...
export function ChatProvider({ children }: { children: ReactNode }) {
  const dock = useDock();
  const openChatIds = dock.openKeysByKind('chat');

  const openChat = useCallback((agentId: string) => dock.openPanel('chat', agentId), [dock]);
  const closeChat = useCallback((agentId: string) => dock.closePanel('chat', agentId), [dock]);
  // chatAgentId conservé pour compat API : le dernier chat ouvert.
  const chatAgentId = openChatIds.length ? openChatIds[openChatIds.length - 1] : null;

  const control = useMemo<ChatControl>(() => ({ chatAgentId, openChat, closeChat }), [chatAgentId, openChat, closeChat]);

  return (
    <ChatContext.Provider value={control}>
      {children}
      {openChatIds.map(agentId => {
        const key = `chat:${agentId}`;
        const placement = dock.placementFor(key);
        return (
          <ChatPanelContainer
            key={agentId}
            agentId={agentId}
            placement={placement}
            active={placement !== undefined}
            isMaximized={dock.maximizedKey === key}
            onClose={() => closeChat(agentId)}
            onResizeWidth={w => dock.setWidth(key, w)}
            onToggleMaximize={() => (dock.maximizedKey === key ? dock.restore() : dock.maximize(key))}
          />
        );
      })}
    </ChatContext.Provider>
  );
}
```

> **Changement d'API :** `closeChat` prend désormais un `agentId`. Mettre à jour les appelants de `closeChat()` sans argument (chercher `closeChat(` dans `src`). Le `onStop` interne du panel doit appeler `closeChat(agentId)`.

- [ ] **Step 4 : Mettre à jour les appelants de `closeChat`**

Run: `cd client && rg -n "closeChat\(" src`
Corriger chaque appel pour passer l'`agentId` concerné.

- [ ] **Step 5 : Tests + build**

Run: `cd client && npm test && npm run build`
Expected: PASS. (Le test existant `AgentChatPanel.test.tsx` peut nécessiter l'ajout des nouvelles props requises — leur donner des valeurs par défaut dans le test : `rightOffset={16} width={420} maxWidth={420} active isMaximized={false} onResizeWidth={()=>{}} onToggleMaximize={()=>{}}`.)

- [ ] **Step 6 : VÉRIFICATION NAVIGATEUR**

`npm run dev` → `/hotel` :
1. Ouvrir le chat de 2 agents différents (clic sprite / roster) → **deux** panneaux de chat côte à côte.
2. `⬓ Dock` → chats + terminaux mélangés s'étirent sur la barre, resize split-pane OK.
3. Rétrécir la fenêtre jusqu'au débordement → le plus ancien est évincé (caché), l'agrandir le restaure ; le transcript du chat restauré est intact (pas de re-fetch visible / pas de flicker).

- [ ] **Step 7 : Commit**

```bash
git add client/src/components/ChatPanelContainer.tsx client/src/components/ChatHost.tsx client/src/components/AgentChatPanel.tsx
git commit -m "feat(dock): multi-chat via ChatPanelContainer ; chat piloté par le dock"
```

---

### Task 9 : Bouton maximize/restore dans les barres de titre

**Files:**
- Modify: `client/src/components/TtyPanel.tsx:287-290` (boutons)
- Modify: `client/src/components/AgentChatPanel.tsx:367-373` (boutons)

- [ ] **Step 1 : Bouton dans `TtyPanel`**

Dans le groupe de boutons de la barre de titre (`:287-290`), avant `─` :

```tsx
<button style={iconBtn} onClick={onToggleMaximize} title={isMaximized ? 'Restaurer' : 'Maximiser'}>
  {isMaximized ? '🗗' : '🗖'}
</button>
<button style={iconBtn} onClick={onMinimize} title="Réduire">─</button>
<button style={iconBtn} onClick={onClose} title="Fermer le terminal">✕</button>
```

- [ ] **Step 2 : Bouton dans `AgentChatPanel`**

Dans la barre de titre (`:369-372`), avant `⏹` :

```tsx
<button style={iconBtn} onClick={onToggleMaximize} title={isMaximized ? 'Restaurer' : 'Maximiser'}>
  {isMaximized ? '🗗' : '🗖'}
</button>
<button style={iconBtn} onClick={onStop} title="Arrêter l'agent">⏹</button>
<button style={iconBtn} onClick={onClose} title="Fermer">✕</button>
```

- [ ] **Step 3 : Tests + build**

Run: `cd client && npm test && npm run build`
Expected: PASS.

- [ ] **Step 4 : VÉRIFICATION NAVIGATEUR**

1. Maximiser un terminal → il prend toute la barre, les autres panneaux disparaissent ; restaurer → tout revient (état terminal préservé).
2. Idem avec un chat. Maximize fonctionne en flottant comme en docké.

- [ ] **Step 5 : Commit**

```bash
git add client/src/components/TtyPanel.tsx client/src/components/AgentChatPanel.tsx
git commit -m "feat(dock): bouton maximize/restore sur terminaux et chats"
```

---

## Self-review (rempli)

**Couverture de la spec :**
- Toggle global → Task 6. ✅
- Vrai rétrécissement → Task 5 (sizing conteneur) + Task 6 (conteneur hauteur). ✅
- Barre terminaux+chats côte à côte/resize/éviction → Task 2 (docké) + Task 7/8 (hosts). ✅
- Multi-chat → Task 8. ✅
- Maximize → Task 1/3 (moteur) + Task 9 (UI). ✅
- Docké étiré pleine barre + resize split-pane → Task 2 + Task 4 (`redistributeWidth`). ✅
- Pas de remount au toggle → panneaux absolus dans les 2 modes (Task 5/6/7/8). ✅
- Chats évincés montés-cachés + RAF gaté sur `active` → Task 8 Step 2. ✅
- Vérif navigateur du rétrécissement → Task 6 Step 4, Task 7 Step 7. ✅
- Parité TTY + grep avant rename → Task 1 (tests portés) + Task 7 Step 1. ✅

**Cohérence des types :** `panelKey`, `DockPanel`, `DockPlacement`, `LayoutMode`, `PanelKind` définis en Task 1 et utilisés tels quels (Tasks 4/7/8). `useDock()` (Task 4) consommé identiquement (Tasks 6/7/8). Props `isMaximized`/`onToggleMaximize`/`onResizeWidth` cohérentes entre déclaration (Task 7/8) et usage (Task 9).

**Placeholders :** les corps d'effets de `ChatPanelContainer` (Task 8 Step 2) sont décrits comme « déplacer verbatim depuis `ChatHost.tsx:49-158` en remplaçant `chatAgentId` par `agentId` » — déplacement de code existant identifié par lignes, pas une invention.
