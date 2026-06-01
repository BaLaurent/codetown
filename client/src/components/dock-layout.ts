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

// Resize docké : la poignée est sur le bord GAUCHE de chaque panneau. Tirer le
// séparateur (bord gauche de `key`) ajuste `key` ET son voisin de GAUCHE en conservant
// la somme de la paire — split-pane BIDIRECTIONNEL (grandit ou rétrécit). Le panneau le
// plus à gauche n'a pas de voisin gauche → no-op (sa poignée touche la marge). Pure → testable.
export function redistributeWidth(
  visibleKeysLeftToRight: string[],
  widths: Record<string, number>,
  key: string,
  desiredWidth: number,
): Record<string, number> {
  const i = visibleKeysLeftToRight.indexOf(key);
  if (i <= 0) return widths; // absent, ou le plus à gauche : aucun voisin gauche à qui prendre/donner
  const leftKey = visibleKeysLeftToRight[i - 1];
  const cur = widths[key] ?? 0;
  const leftCur = widths[leftKey] ?? 0;
  const total = cur + leftCur;
  const next = Math.max(MIN_WIDTH, Math.min(desiredWidth, total - MIN_WIDTH)); // les deux ≥ MIN_WIDTH
  return { ...widths, [key]: next, [leftKey]: total - next };
}

// Resize docké : on redistribue dans l'espace EFFECTIF (les largeurs rendues, qui
// somment déjà à `available`), PAS dans l'espace stocké — sinon le drag déborde et le
// voisin n'atteint jamais MIN_WIDTH. On persiste les largeurs effectives comme nouvelles
// largeurs stockées (sum == available → facteur de scaling 1 → drag 1:1, convergent).
export function resizeDockedWidths(
  order: DockPanel[],
  widths: Record<string, number>,
  viewportWidth: number,
  maximizedKey: string | null,
  key: string,
  desiredWidth: number,
): Record<string, number> {
  const { placements } = computeDockLayout(order, widths, viewportWidth, 'docked', maximizedKey);
  const visibleKeys = placements.map(p => p.key);
  const effWidths: Record<string, number> = {};
  for (const p of placements) effWidths[p.key] = p.effectiveWidth;
  const redistributed = redistributeWidth(visibleKeys, effWidths, key, desiredWidth);
  return { ...widths, ...redistributed };
}

// Hauteur réservée en bas pour le dock (synchro avec le CSS du panneau).
export function computeDockHeight(mode: LayoutMode, openCount: number, viewportHeight: number): number {
  if (mode !== 'docked' || openCount === 0) return 0;
  const panelPx = Math.min(Math.round(PANEL_HEIGHT_VH * viewportHeight), PANEL_HEIGHT_MAX);
  return panelPx + 32; // 16 (marge bas) + 16 (espace au-dessus)
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

// Docké : le sous-ensemble visible (au plus N tenant à MIN_WIDTH) se RÉPARTIT sur
// toute la barre, proportionnellement aux largeurs stockées. maxWidth (split-pane)
// = largeur actuelle + ce que le voisin de GAUCHE peut céder jusqu'à MIN_WIDTH
// (la poignée est sur le bord gauche du panneau).
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
  // L'arrondi peut laisser un écart de ±quelques px : on le reporte sur le plus large.
  // drift ne peut PAS faire passer un panneau sous MIN_WIDTH : l'éviction garantit
  // available >= n*MIN_WIDTH, donc le plus large absorbe toujours le drift sans clamp.
  const drift = available - raw.reduce((s, w) => s + w, 0);
  if (drift !== 0) {
    const idx = raw.indexOf(Math.max(...raw));
    raw[idx] += drift;
  }

  // 3) Place de gauche à droite ; rightOffset mesuré depuis le bord droit.
  const totalRowWidth = raw.reduce((s, w) => s + w, 0) + GAP * (n - 1); // == budget
  const placements: DockPlacement[] = [];
  let leftCursor = 0;
  for (let i = 0; i < n; i++) {
    const w = raw[i];
    const rightOffset = MARGIN + (totalRowWidth - (leftCursor + w));
    // split-pane : la poignée est sur le bord GAUCHE, donc un panneau grandit en prenant
    // ce que son voisin de GAUCHE peut céder (jusqu'à MIN_WIDTH). Le plus à gauche
    // (leftNeighbor=0) est figé — sa poignée touche la marge du viewport.
    const leftNeighbor = i > 0 ? raw[i - 1] : 0;
    const maxWidth = w + Math.max(0, leftNeighbor - MIN_WIDTH);
    placements.push({
      key: panelKey(visible[i]), kind: visible[i].kind, id: visible[i].id,
      rightOffset, effectiveWidth: w, maxWidth,
    });
    leftCursor += w + GAP;
  }
  return { placements, budget };
}
