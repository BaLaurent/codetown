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
  // Plafond OPTIMISTE du drag (largeur actuelle + espace libre). En flottant, deux
  // panneaux peuvent annoncer le même espace libre : c'est une borne haute, pas une
  // exclusion mutuelle — le premier qui s'élargit consomme le vide.
  maxWidth: number;
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
