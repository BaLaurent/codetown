// Calcule, à partir de l'« intention » d'ouverture des terminaux, lesquels tiennent
// à l'écran et où les placer. La visibilité est une DÉRIVATION PURE du budget de
// largeur : rien n'est jamais retiré de openTtyIds, on calcule juste le sous-ensemble
// le plus récent qui tient. Éviction (fenêtre rétrécie / panneau élargi) et
// auto-restauration (fenêtre agrandie) émergent gratuitement de ce calcul.

export const DEFAULT_WIDTH = 420;
export const MIN_WIDTH = 240;
export const GAP = 16;
export const CHAT_WIDTH = 420;
export const MARGIN = 16;

export interface TtyPlacement {
  ttyId: string;
  rightOffset: number;   // distance au bord droit de la fenêtre
  effectiveWidth: number; // largeur réellement rendue (clampée au budget)
  // Plafond du drag POUR CE panneau = sa largeur actuelle + l'espace encore libre.
  // Empêche un panneau de déborder le budget en s'élargissant — il s'arrête quand il
  // a mangé tout le vide, sans pousser ses voisins (ni lui-même) hors écran.
  maxWidth: number;
}

export interface TtyLayout {
  placements: TtyPlacement[]; // uniquement les terminaux visibles
  budget: number;             // largeur totale dispo à gauche du chat
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

// openTtyIds : ordre d'ouverture, le plus récent EN DERNIER (prioritaire à l'affichage).
// Le plus récent se colle près du chat (à droite), les plus anciens s'empilent à gauche.
export function computeTtyLayout(
  openTtyIds: string[],
  widths: Record<string, number>,
  viewportWidth: number,
  chatOpen: boolean,
): TtyLayout {
  const chatReserve = chatOpen ? CHAT_WIDTH + GAP : 0;
  const budget = Math.max(MIN_WIDTH, viewportWidth - MARGIN - chatReserve - MARGIN);

  const placements: Omit<TtyPlacement, 'maxWidth'>[] = [];
  let cursor = MARGIN + chatReserve; // rightOffset du prochain panneau (le plus récent)
  let consumed = 0;

  // Du plus récent au plus ancien : on inclut tant que le cumul des largeurs+gaps tient.
  for (let i = openTtyIds.length - 1; i >= 0; i--) {
    const ttyId = openTtyIds[i];
    const effectiveWidth = clamp(widths[ttyId] ?? DEFAULT_WIDTH, MIN_WIDTH, budget);
    const gapBefore = placements.length === 0 ? 0 : GAP;
    const next = consumed + gapBefore + effectiveWidth;

    // Toujours garder au moins 1 visible (le plus récent), même si l'écran est minuscule.
    if (next > budget && placements.length > 0) break;

    cursor += gapBefore;
    placements.push({ ttyId, rightOffset: cursor, effectiveWidth });
    cursor += effectiveWidth;
    consumed = next;
  }

  // Espace encore libre une fois tous les panneaux visibles placés : un panneau peut
  // l'absorber entièrement en s'élargissant, mais pas au-delà (sinon il déborderait).
  const freeSpace = budget - consumed;
  const withMax: TtyPlacement[] = placements.map(p => ({
    ...p,
    maxWidth: p.effectiveWidth + freeSpace,
  }));

  // placements est ordonné du plus récent (droite) au plus ancien (gauche) ;
  // on renvoie de gauche à droite pour un ordre d'affichage naturel.
  withMax.reverse();
  return { placements: withMax, budget };
}
