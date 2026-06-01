// Dérivation de couleur de TEXTE à partir d'une couleur de fond :
//  - readableTextColor : noir/blanc par luminance (YIQ, seuil 128) — repli lisible.
//  - inverseColor      : négatif RVB (255−canal).
//  - defaultTextColor  : inverse « corrigé lisible » (inverse si contraste suffisant,
//                        sinon noir/blanc).

// Distance RVB minimale entre un fond et son inverse en-dessous de laquelle l'inverse
// est jugé inutilisable. N'arrive QUE pour les gris moyens (chaque canal ≈ 128 →
// inverse ≈ identique) ; toutes les teintes saturées/complémentaires restent bien
// au-dessus. La distance (≠ contraste de luminance WCAG) garde les inverses vifs
// lisibles par leur teinte, là où WCAG les recalerait à tort en noir/blanc.
const MIN_INVERSE_DISTANCE = 100;

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

function toHex(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** '#000' si le fond est clair, '#fff' s'il est sombre (défaut '#fff' si invalide). */
export function readableTextColor(bg: string): '#000' | '#fff' {
  const rgb = parseHex(bg);
  if (!rgb) return '#fff';
  const [r, g, b] = rgb;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#000' : '#fff';
}

/** Négatif RVB de la couleur (255−canal). '#ffffff' si l'entrée est invalide. */
export function inverseColor(bg: string): string {
  const rgb = parseHex(bg);
  if (!rgb) return '#ffffff';
  return `#${toHex(255 - rgb[0])}${toHex(255 - rgb[1])}${toHex(255 - rgb[2])}`;
}

/**
 * Couleur de texte par défaut pour un fond donné : l'inverse RVB s'il est assez
 * éloigné du fond (distance ≥ MIN_INVERSE_DISTANCE), sinon noir/blanc lisible
 * (cas des gris moyens où l'inverse ≈ le fond). '#fff' si invalide.
 */
export function defaultTextColor(bg: string): string {
  const rgb = parseHex(bg);
  if (!rgb) return '#fff';
  const inv = inverseColor(bg);
  const invRgb = parseHex(inv)!;
  return distance(rgb, invRgb) >= MIN_INVERSE_DISTANCE ? inv : readableTextColor(bg);
}
