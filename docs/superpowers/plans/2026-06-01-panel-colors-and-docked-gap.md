# Couleurs de panneaux dockables + dock collé — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre d'attribuer manuellement une couleur (cadre + barre de titre + poignée) à chaque terminal et chaque chat docké, et coller les panneaux entre eux en mode docké (gap = 0).

**Architecture:** La couleur est une métadonnée de session persistée en `localStorage`, calquée sur `utils/tty-titles.ts`, clé = `panelKey` (`tty:<id>` / `chat:<name>`). Les hosts (`TtyHost`/`ChatHost`/`ChatPanelContainer`) lisent la couleur et la passent en props aux panneaux, comme ils le font déjà pour le titre. Un composant partagé `PanelColorPicker` (pastille + popover) édite la couleur dans la barre de titre des deux panneaux. Le moteur `dock-layout.ts` met l'espacement docké à 0 (flottant inchangé).

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react, xterm (terminaux), localStorage.

**Spec :** `docs/superpowers/specs/2026-06-01-panel-colors-and-docked-gap-design.md`

---

## Structure de fichiers

| Fichier | Rôle | Action |
|---|---|---|
| `client/src/utils/panel-colors.ts` | Persistance couleur par `panelKey` (localStorage) | Créer |
| `client/src/utils/panel-colors.test.ts` | Tests persistance | Créer |
| `client/src/utils/readable-text-color.ts` | Helper pur luminance → `#000`/`#fff` | Créer |
| `client/src/utils/readable-text-color.test.ts` | Tests helper | Créer |
| `client/src/components/PanelColorPicker.tsx` | Pastille + popover de palette (partagé) | Créer |
| `client/src/components/PanelColorPicker.test.tsx` | Tests interaction | Créer |
| `client/src/components/TtyPanel.tsx` | Applique la couleur (cadre/titre/handle) + picker | Modifier |
| `client/src/components/TtyHost.tsx` | Lit/écrit la couleur, props vers TtyPanel | Modifier |
| `client/src/components/AgentChatPanel.tsx` | Applique la couleur + picker | Modifier |
| `client/src/components/ChatPanelContainer.tsx` | Lit/écrit la couleur, props vers AgentChatPanel | Modifier |
| `client/src/components/dock-layout.ts` | Espacement docké = 0 | Modifier |
| `client/src/components/dock-layout.test.ts` | MAJ attentes docké (gap 0) | Modifier |

**Dépendances entre tâches :** T1, T2, T6 sont indépendantes (parallélisables). T3 dépend de T1+T2. T4 dépend de T1+T3. T5 dépend de T1+T3.

---

## Task 1: Persistance des couleurs (`panel-colors.ts`)

**Files:**
- Create: `client/src/utils/panel-colors.ts`
- Test: `client/src/utils/panel-colors.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// client/src/utils/panel-colors.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getPanelColor, setPanelColor, clearPanelColor } from './panel-colors';

describe('panel-colors', () => {
  beforeEach(() => localStorage.clear());

  it('returns null when no color is stored', () => {
    expect(getPanelColor('tty:abc')).toBeNull();
  });

  it('persists and reads a color by key', () => {
    setPanelColor('tty:abc', '#C83030');
    expect(getPanelColor('tty:abc')).toBe('#C83030');
  });

  it('keeps colors independent per key', () => {
    setPanelColor('tty:a', '#C83030');
    setPanelColor('chat:bob', '#3070C8');
    expect(getPanelColor('tty:a')).toBe('#C83030');
    expect(getPanelColor('chat:bob')).toBe('#3070C8');
  });

  it('clearPanelColor removes the entry (back to null)', () => {
    setPanelColor('tty:a', '#C83030');
    clearPanelColor('tty:a');
    expect(getPanelColor('tty:a')).toBeNull();
  });

  it('survives via localStorage (new read sees the persisted value)', () => {
    setPanelColor('tty:a', '#2E9E4F');
    expect(JSON.parse(localStorage.getItem('codetown-panel-colors')!)['tty:a']).toBe('#2E9E4F');
  });

  it('returns null on corrupted JSON instead of throwing', () => {
    localStorage.setItem('codetown-panel-colors', '{not json');
    expect(getPanelColor('tty:a')).toBeNull();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd client && npx vitest run src/utils/panel-colors.test.ts`
Expected: FAIL — `Failed to resolve import "./panel-colors"`.

- [ ] **Step 3: Implémenter le module**

```ts
// client/src/utils/panel-colors.ts
// Couleur d'accent par panneau dockable, clé = panelKey ("tty:<id>" / "chat:<name>").
// Calqué sur tty-titles.ts : persiste en localStorage, survit au reload, nettoyé à la
// fermeture de session. Défaut = null → le panneau garde son look par défaut.

const STORAGE_KEY = 'codetown-panel-colors';

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persist(colors: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // localStorage indisponible : la couleur ne survivra pas, pas de crash.
  }
}

/** Couleur d'accent du panneau, ou null (look par défaut). */
export function getPanelColor(key: string): string | null {
  return load()[key] ?? null;
}

/** Persiste la couleur d'accent d'un panneau. */
export function setPanelColor(key: string, color: string): void {
  const colors = load();
  colors[key] = color;
  persist(colors);
}

/** Retire la couleur (retour au défaut) — appelé aussi à la fermeture de session. */
export function clearPanelColor(key: string): void {
  const colors = load();
  delete colors[key];
  persist(colors);
}
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

Run: `cd client && npx vitest run src/utils/panel-colors.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/panel-colors.ts client/src/utils/panel-colors.test.ts
git commit -m "feat(dock): store per-panel accent color in localStorage"
```

---

## Task 2: Couleur de texte lisible (`readable-text-color.ts`)

**Files:**
- Create: `client/src/utils/readable-text-color.ts`
- Test: `client/src/utils/readable-text-color.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// client/src/utils/readable-text-color.test.ts
import { describe, it, expect } from 'vitest';
import { readableTextColor } from './readable-text-color';

describe('readableTextColor', () => {
  it('returns black text on a light background', () => {
    expect(readableTextColor('#FFE040')).toBe('#000'); // jaune clair
    expect(readableTextColor('#FFFFFF')).toBe('#000');
  });

  it('returns white text on a dark background', () => {
    expect(readableTextColor('#3070C8')).toBe('#fff'); // bleu
    expect(readableTextColor('#000000')).toBe('#fff');
  });

  it('accepts 3-digit hex', () => {
    expect(readableTextColor('#000')).toBe('#fff');
    expect(readableTextColor('#fff')).toBe('#000');
  });

  it('falls back to white on malformed input', () => {
    expect(readableTextColor('not-a-color')).toBe('#fff');
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd client && npx vitest run src/utils/readable-text-color.test.ts`
Expected: FAIL — `Failed to resolve import "./readable-text-color"`.

- [ ] **Step 3: Implémenter le module**

```ts
// client/src/utils/readable-text-color.ts
// Choisit noir ou blanc pour rester lisible sur une couleur de fond donnée.
// Formule YIQ (perception de luminance) : seuil 128.

function parseHex(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** '#000' si le fond est clair, '#fff' s'il est sombre (défaut '#fff' si invalide). */
export function readableTextColor(bg: string): '#000' | '#fff' {
  const rgb = parseHex(bg);
  if (!rgb) return '#fff';
  const [r, g, b] = rgb;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#000' : '#fff';
}
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

Run: `cd client && npx vitest run src/utils/readable-text-color.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/readable-text-color.ts client/src/utils/readable-text-color.test.ts
git commit -m "feat(dock): add readableTextColor luminance helper"
```

---

## Task 3: Composant `PanelColorPicker`

**Files:**
- Create: `client/src/components/PanelColorPicker.tsx`
- Test: `client/src/components/PanelColorPicker.test.tsx`

Dépend de : T1 n'est pas requis ici (le picker est contrôlé : il reçoit `color`/`onChange`), mais la palette est définie ici.

- [ ] **Step 1: Écrire le test qui échoue**

```tsx
// client/src/components/PanelColorPicker.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PanelColorPicker, PANEL_PALETTE } from './PanelColorPicker';

afterEach(cleanup);

describe('PanelColorPicker', () => {
  it('opens the popover on click and shows every palette swatch', () => {
    render(<PanelColorPicker color={null} onChange={() => {}} />);
    fireEvent.click(screen.getByTitle('Couleur du panneau'));
    // une pastille par couleur + le bouton "défaut"
    expect(screen.getAllByRole('button', { name: /couleur/i }).length)
      .toBeGreaterThanOrEqual(PANEL_PALETTE.length);
  });

  it('calls onChange with the picked color', () => {
    const onChange = vi.fn();
    render(<PanelColorPicker color={null} onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Couleur du panneau'));
    fireEvent.click(screen.getByTitle(PANEL_PALETTE[0]));
    expect(onChange).toHaveBeenCalledWith(PANEL_PALETTE[0]);
  });

  it('calls onChange(null) when picking "défaut"', () => {
    const onChange = vi.fn();
    render(<PanelColorPicker color={'#C83030'} onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Couleur du panneau'));
    fireEvent.click(screen.getByTitle('Couleur par défaut'));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd client && npx vitest run src/components/PanelColorPicker.test.tsx`
Expected: FAIL — `Failed to resolve import "./PanelColorPicker"`.

- [ ] **Step 3: Implémenter le composant**

```tsx
// client/src/components/PanelColorPicker.tsx
// Pastille dans la barre de titre d'un panneau dockable : ouvre un petit popover
// de couleurs. Contrôlé (color/onChange) — la persistance vit dans les hosts.
import { useEffect, useRef, useState, type CSSProperties } from 'react';

// Palette curatée pour des cadres lisibles (distincte des couleurs "shirt" d'agent).
export const PANEL_PALETTE = [
  '#C83030', // rouge
  '#3070C8', // bleu
  '#2E9E4F', // vert
  '#E0A020', // ambre
  '#8A4FCF', // violet
  '#D84F8C', // rose
  '#20A8B0', // teal
  '#6B7280', // gris
];

const dot: CSSProperties = {
  width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(0,0,0,0.4)',
  cursor: 'pointer', padding: 0,
};

const triggerBtn: CSSProperties = {
  ...dot, background: 'transparent', borderStyle: 'dashed',
};

const popover: CSSProperties = {
  position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 40,
  display: 'flex', flexWrap: 'wrap', gap: 6, width: 132, padding: 8,
  background: 'rgba(17, 24, 39, 0.98)', borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
};

const resetBtn: CSSProperties = {
  ...dot, background: 'transparent', borderStyle: 'dashed', color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
};

export function PanelColorPicker({ color, onChange }: {
  color: string | null;
  onChange: (color: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Ferme au clic extérieur / Échap, même UX que le menu contextuel des panneaux.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (c: string | null) => { onChange(c); setOpen(false); };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        title="Couleur du panneau"
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        style={{ ...triggerBtn, background: color ?? 'transparent' }}
      />
      {open && (
        <div style={popover} onClick={e => e.stopPropagation()}>
          {PANEL_PALETTE.map(c => (
            <button
              key={c}
              type="button"
              title={c}
              aria-label={`Couleur ${c}`}
              onClick={() => pick(c)}
              style={{ ...dot, background: c }}
            />
          ))}
          <button
            type="button"
            title="Couleur par défaut"
            aria-label="Couleur par défaut"
            onClick={() => pick(null)}
            style={resetBtn}
          >✕</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

Run: `cd client && npx vitest run src/components/PanelColorPicker.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/PanelColorPicker.tsx client/src/components/PanelColorPicker.test.tsx
git commit -m "feat(dock): add shared PanelColorPicker (swatch + popover)"
```

---

## Task 4: Câbler la couleur dans le terminal (`TtyPanel` + `TtyHost`)

**Files:**
- Modify: `client/src/components/TtyPanel.tsx`
- Modify: `client/src/components/TtyHost.tsx`

### 4a — TtyPanel : props + application de la couleur

- [ ] **Step 1: Ajouter les imports**

Dans `client/src/components/TtyPanel.tsx`, sous la ligne `import { MIN_WIDTH } from './dock-layout';` (ligne 7), ajouter :

```ts
import { PanelColorPicker } from './PanelColorPicker';
import { readableTextColor } from '../utils/readable-text-color';
```

- [ ] **Step 2: Ajouter les props à l'interface**

Dans `interface TtyPanelProps` (vers ligne 39-53), ajouter après `onRename: (newTitle: string) => void;` :

```ts
  color: string | null;
  onColorChange: (color: string | null) => void;
```

- [ ] **Step 3: Destructurer les nouvelles props**

Dans la signature `export function TtyPanel({ ... })` (ligne 55), ajouter `color, onColorChange` à la liste destructurée.

- [ ] **Step 4: Calculer les styles dérivés de la couleur**

Juste avant le `return (` final (vers ligne 236, après `const short = cwdShort(cwd);`), ajouter :

```ts
  // Look par défaut (#333 / #1a1a1a) tant qu'aucune couleur n'est choisie.
  const borderColor = color ?? '#333';
  const titleBg = color ?? '#1a1a1a';
  const titleFg = color ? readableTextColor(color) : '#f0f0f0';
```

- [ ] **Step 5: Appliquer la couleur au cadre**

Dans le `style` du `<div>` racine (ligne 242), remplacer :

```ts
      border: '4px solid #333', boxShadow: '8px 8px 0 rgba(0,0,0,0.35)',
```

par :

```ts
      border: `4px solid ${borderColor}`, boxShadow: '8px 8px 0 rgba(0,0,0,0.35)',
```

- [ ] **Step 6: Teinter la poignée**

Dans le `<div onMouseDown={onResizeMouseDown}>` (lignes 250-256), remplacer le bloc `style={{ ... }}` par :

```tsx
        style={{
          position: 'absolute', left: -4, top: 0, bottom: 0, width: 8,
          cursor: 'ew-resize', zIndex: 2,
          background: color ?? 'transparent',
        }}
```

- [ ] **Step 7: Appliquer la couleur à la barre de titre + insérer le picker**

Le `titleBarStyle` est une constante module figée. Le remplacer par un style inline mergé. Remplacer la ligne d'ouverture de la barre de titre (ligne 258-261) :

```tsx
      <div
        style={titleBarStyle}
        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      >
```

par :

```tsx
      <div
        style={{ ...titleBarStyle, background: titleBg, color: titleFg }}
        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      >
```

Puis, dans le groupe de boutons (le `<div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>`, lignes 289-293), ajouter le picker AVANT le bouton maximiser :

```tsx
        <div style={{ display: 'flex', gap: 2, flexShrink: 0, alignItems: 'center' }}>
          <PanelColorPicker color={color} onChange={onColorChange} />
          <button style={iconBtn} onClick={onToggleMaximize} title={isMaximized ? 'Restaurer' : 'Maximiser'}>{isMaximized ? '🗗' : '🗖'}</button>
          <button style={iconBtn} onClick={onMinimize} title="Réduire">─</button>
          <button style={iconBtn} onClick={onClose} title="Fermer le terminal">✕</button>
        </div>
```

### 4b — TtyHost : lire/écrire la couleur

- [ ] **Step 8: Importer le store de couleurs**

Dans `client/src/components/TtyHost.tsx`, sous l'import de `tty-titles` (ligne 3), ajouter :

```ts
import { getPanelColor, setPanelColor, clearPanelColor } from '../utils/panel-colors';
```

- [ ] **Step 9: Forcer un re-render au changement de couleur**

La couleur est lue au render via `getPanelColor`; un changement doit déclencher un re-render. Ajouter un compteur de version. Sous `const [ttySessions, setTtySessions] = useState<TtySessionClient[]>([]);` (ligne 36), ajouter :

```ts
  const [, bumpColor] = useState(0);
```

- [ ] **Step 10: Nettoyer la couleur à la fermeture de session**

Dans `closeTty` (lignes 81-86), après `clearTtyTitle(ttyId);`, ajouter :

```ts
    clearPanelColor(`tty:${ttyId}`);
```

- [ ] **Step 11: Passer color + onColorChange au panneau**

Dans le `<TtyPanel ... />` (lignes 115-130), ajouter après `onRename={...}` :

```tsx
            color={getPanelColor(key)}
            onColorChange={c => {
              if (c === null) clearPanelColor(key); else setPanelColor(key, c);
              bumpColor(v => v + 1);
            }}
```

- [ ] **Step 12: Vérifier la compilation et la suite de tests**

Run: `cd client && npx tsc --noEmit && npx vitest run`
Expected: PASS — pas d'erreur de type, suite existante verte.

- [ ] **Step 13: Commit**

```bash
git add client/src/components/TtyPanel.tsx client/src/components/TtyHost.tsx
git commit -m "feat(dock): colorize terminal frame/title/handle via PanelColorPicker"
```

---

## Task 5: Câbler la couleur dans le chat (`AgentChatPanel` + `ChatPanelContainer` + `ChatHost`)

**Files:**
- Modify: `client/src/components/AgentChatPanel.tsx`
- Modify: `client/src/components/ChatPanelContainer.tsx`
- Modify: `client/src/components/ChatHost.tsx`

### 5a — AgentChatPanel : props + application de la couleur

- [ ] **Step 1: Ajouter les imports**

Dans `client/src/components/AgentChatPanel.tsx`, après les imports existants en tête de fichier, ajouter :

```ts
import { PanelColorPicker } from './PanelColorPicker';
import { readableTextColor } from '../utils/readable-text-color';
```

- [ ] **Step 2: Ajouter les props à la signature**

Dans la signature `export function AgentChatPanel({ ... }: { ... })` (lignes 219-245), ajouter `color, onColorChange` à la destructuration et au type :

```ts
  color: string | null;
  onColorChange: (color: string | null) => void;
```

- [ ] **Step 3: Appliquer la couleur au cadre dans panelStyle**

Dans `panelStyle` (lignes 288-296), remplacer :

```ts
    border: `4px solid ${C.border}`, boxShadow: '8px 8px 0 rgba(0,0,0,0.35)',
```

par :

```ts
    border: `4px solid ${color ?? C.border}`, boxShadow: '8px 8px 0 rgba(0,0,0,0.35)',
```

- [ ] **Step 4: Teinter la poignée**

Dans le handle de resize (lignes 414-420), remplacer le bloc `style={{ ... }}` par :

```tsx
        style={{
          position: 'absolute', left: -4, top: 0, bottom: 0, width: 8,
          cursor: 'ew-resize', zIndex: 2,
          background: color ?? 'transparent',
        }}
```

- [ ] **Step 5: Appliquer la couleur à la barre de titre + insérer le picker**

Remplacer le bloc de la barre de titre (lignes 421-428) :

```tsx
      <div style={titleBar}>
        <span>💬 {agentName}</span>
        <span>
          <button style={iconBtn} onClick={onToggleMaximize} title={isMaximized ? 'Restaurer' : 'Maximiser'}>{isMaximized ? '🗗' : '🗖'}</button>
          <button style={iconBtn} onClick={onStop} title="Arrêter l'agent">⏹</button>
          <button style={iconBtn} onClick={onClose} title="Fermer">✕</button>
        </span>
      </div>
```

par :

```tsx
      <div style={color ? { ...titleBar, background: color, color: readableTextColor(color) } : titleBar}>
        <span>💬 {agentName}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <PanelColorPicker color={color} onChange={onColorChange} />
          <button style={iconBtn} onClick={onToggleMaximize} title={isMaximized ? 'Restaurer' : 'Maximiser'}>{isMaximized ? '🗗' : '🗖'}</button>
          <button style={iconBtn} onClick={onStop} title="Arrêter l'agent">⏹</button>
          <button style={iconBtn} onClick={onClose} title="Fermer">✕</button>
        </span>
      </div>
```

- [ ] **Step 6: Mettre à jour les tests existants d'AgentChatPanel (props requises)**

Dans `client/src/components/AgentChatPanel.test.tsx`, ajouter aux `baseProps` (vers ligne 22) :

```ts
  color: null,
  onColorChange: () => {},
```

(les props sont requises ; sans ça `tsc` casse les tests existants).

### 5b — ChatPanelContainer : threader la couleur

- [ ] **Step 7: Importer le store de couleurs**

Dans `client/src/components/ChatPanelContainer.tsx`, après l'import de `agent-names` (ligne 12), ajouter :

```ts
import { getPanelColor, setPanelColor, clearPanelColor } from '../utils/panel-colors';
```

- [ ] **Step 8: Lire la couleur et la passer au panneau**

`ChatPanelContainer` se re-render déjà via `chatTick` (RAF poll). On lit la couleur au render et on bump `chatTick` au changement pour refléter immédiatement. Dans le `return <AgentChatPanel ... />` (lignes 176-202), ajouter après `onToggleMaximize={onToggleMaximize}` :

```tsx
      color={getPanelColor(`chat:${agentId}`)}
      onColorChange={c => {
        if (c === null) clearPanelColor(`chat:${agentId}`); else setPanelColor(`chat:${agentId}`, c);
        setChatTick(t => t + 1);
      }}
```

### 5c — ChatHost : nettoyer à la fermeture

- [ ] **Step 9: Nettoyer la couleur quand le chat est fermé**

Dans `client/src/components/ChatHost.tsx`, importer le store (après l'import de `useDock`, ligne 11) :

```ts
import { clearPanelColor } from '../utils/panel-colors';
```

Puis dans `closeChat` (ligne 34), remplacer :

```ts
  const closeChat = useCallback((agentId: string) => closePanel('chat', agentId), [closePanel]);
```

par :

```ts
  const closeChat = useCallback((agentId: string) => {
    clearPanelColor(`chat:${agentId}`);
    closePanel('chat', agentId);
  }, [closePanel]);
```

- [ ] **Step 10: Vérifier la compilation et la suite de tests**

Run: `cd client && npx tsc --noEmit && npx vitest run`
Expected: PASS — types OK, suite verte (y compris AgentChatPanel.test.tsx mis à jour).

- [ ] **Step 11: Commit**

```bash
git add client/src/components/AgentChatPanel.tsx client/src/components/AgentChatPanel.test.tsx client/src/components/ChatPanelContainer.tsx client/src/components/ChatHost.tsx
git commit -m "feat(dock): colorize chat frame/title/handle via PanelColorPicker"
```

---

## Task 6: Dock collé en mode docké (gap = 0)

**Files:**
- Modify: `client/src/components/dock-layout.ts`
- Modify: `client/src/components/dock-layout.test.ts`

Le mode flottant garde `GAP`. Seul `layoutDocked` passe à 0.

- [ ] **Step 1: Mettre à jour les tests docké (échec attendu d'abord)**

Dans `client/src/components/dock-layout.test.ts`, bloc `describe('computeDockLayout — politique docké (étirée)')` :

Remplacer le test « deux panneaux se partagent à parts égales » (vers lignes 67-72) :

```ts
  it('deux panneaux se partagent la barre à parts égales', () => {
    const { placements, budget } = computeDockLayout([tty('a'), tty('b')], {}, WIDE, 'docked', null);
    const each = (budget - GAP) / 2;
    expect(placements.map(p => p.effectiveWidth)).toEqual([each, each]);
    expect(placements[0].effectiveWidth + GAP + placements[1].effectiveWidth).toBe(budget);
  });
```

par (gap 0 → les panneaux remplissent tout le budget, jointifs) :

```ts
  it('deux panneaux se partagent la barre à parts égales (collés, gap 0)', () => {
    const { placements, budget } = computeDockLayout([tty('a'), tty('b')], {}, WIDE, 'docked', null);
    const each = budget / 2;
    expect(placements.map(p => p.effectiveWidth)).toEqual([each, each]);
    expect(placements[0].effectiveWidth + placements[1].effectiveWidth).toBe(budget);
    // jointifs : le bord gauche de b == le bord droit de a (aucun espace entre les deux).
    const rightEdgeOfB = MARGIN; // b est le plus à droite
    expect(placements[1].rightOffset).toBe(rightEdgeOfB);
    expect(placements[0].rightOffset).toBe(MARGIN + each);
  });
```

Remplacer le test de répartition proportionnelle (vers lignes 74-82) — remplacer la ligne du `total` :

```ts
    const total = placements.reduce((s, p) => s + p.effectiveWidth, 0) + GAP * (placements.length - 1);
```

par :

```ts
    const total = placements.reduce((s, p) => s + p.effectiveWidth, 0);
```

Vérifier le test d'éviction « 4 panneaux étroits » (vers lignes 84-93) : avec gap 0, le budget requis par N panneaux est `N * MIN_WIDTH` (sans `(N-1)*GAP`). Si le test attend un nombre précis de panneaux visibles, recalculer avec la nouvelle borne. Pour `budget = 800 - 2*MARGIN = 768` et `MIN_WIDTH = 240` : `768 / 240 = 3.2` → 3 panneaux visibles (au lieu de 2 avec l'ancien gap). Ajuster l'attente du test en conséquence (ex. `expect(wide4.placements.length).toBe(3)`).

- [ ] **Step 2: Lancer les tests docké pour vérifier l'échec**

Run: `cd client && npx vitest run src/components/dock-layout.test.ts`
Expected: FAIL — les tests docké échouent (le code utilise encore `GAP`).

- [ ] **Step 3: Mettre l'espacement docké à 0 dans `layoutDocked`**

Dans `client/src/components/dock-layout.ts`, fonction `layoutDocked` (lignes 140-185), appliquer un espacement local nul. En tête de fonction, sous le commentaire, ajouter :

```ts
  const gap = 0; // docké : panneaux collés, la poignée vit sur la couture (cf. spec).
```

Puis remplacer les 4 usages de `GAP` par `gap` dans cette fonction uniquement :

- ligne ~145 : `const needed = n * MIN_WIDTH + (n - 1) * gap;`
- ligne ~153 : `const available = budget - gap * (n - 1);`
- ligne ~167 : `const totalRowWidth = raw.reduce((s, w) => s + w, 0) + gap * (n - 1); // == budget`
- ligne ~182 : `leftCursor += w + gap;`

Ne PAS toucher `layoutFloating` (il garde `GAP`).

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `cd client && npx vitest run src/components/dock-layout.test.ts`
Expected: PASS — docké (gap 0) et flottant (GAP inchangé) verts.

- [ ] **Step 5: Lancer toute la suite + types**

Run: `cd client && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/dock-layout.ts client/src/components/dock-layout.test.ts
git commit -m "feat(dock): glue docked panels together (gap=0), floating unchanged"
```

---

## Vérification finale (manuelle)

- [ ] Lancer `npm run dev`, ouvrir `http://localhost:5173/hotel`.
- [ ] Ouvrir 2-3 terminaux, passer en mode docké → vérifier qu'ils sont **collés** (pas d'espace), la poignée visible sur la couture, resize toujours fonctionnel.
- [ ] Cliquer la pastille d'un terminal → choisir une couleur → cadre + barre de titre + poignée teintés, texte lisible. Choisir « défaut » (✕) → retour au look sombre.
- [ ] Idem sur un chat.
- [ ] Recharger la page → les couleurs persistent (sessions survivantes). Fermer un panneau puis le rouvrir → couleur réinitialisée (nettoyée à la fermeture).
- [ ] Vérifier le mode **flottant** : l'espacement `GAP` est conservé.

---

## Notes de revue (self-review)

- **Couverture spec :** module persistance (T1), helper contraste (T2), picker partagé (T3), application tty (T4) + chat (T5), gap docké 0 (T6). Tous les éléments du spec sont couverts.
- **Cohérence des types :** `color: string | null` et `onColorChange: (color: string | null) => void` identiques dans TtyPanel et AgentChatPanel ; clés `tty:${ttyId}` / `chat:${agentId}` cohérentes avec `panelKey` du dock.
- **Point de vigilance (poignée à la couture) :** la poignée passe à `zIndex: 2` (au lieu de 1) pour rester au-dessus du contenu du voisin collé. Si un clic à la couture s'avère capté par le mauvais panneau lors de la vérif manuelle, escalader (ajustement fin de position/zIndex hors périmètre de ce plan).
