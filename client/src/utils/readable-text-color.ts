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
