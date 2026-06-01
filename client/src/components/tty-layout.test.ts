import { describe, it, expect } from 'vitest';
import { computeTtyLayout, DEFAULT_WIDTH, GAP, CHAT_WIDTH, MARGIN } from './tty-layout';

const WIDE = 1920; // un seul panneau (et même deux) tient largement

describe('computeTtyLayout', () => {
  it('place un panneau unique à right:16 quand le chat est fermé', () => {
    const { placements } = computeTtyLayout(['a'], {}, WIDE, false);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ ttyId: 'a', rightOffset: MARGIN, effectiveWidth: DEFAULT_WIDTH });
  });

  it('décale le panneau unique à right:452 quand le chat est ouvert (parité avec l\'actuel)', () => {
    const { placements } = computeTtyLayout(['a'], {}, WIDE, true);
    expect(placements[0].rightOffset).toBe(MARGIN + CHAT_WIDTH + GAP); // 16 + 420 + 16 = 452
  });

  it('empile deux panneaux : le plus récent à droite, le plus ancien à sa gauche', () => {
    const { placements } = computeTtyLayout(['old', 'new'], {}, WIDE, false);
    expect(placements.map(p => p.ttyId)).toEqual(['old', 'new']); // ordre d'affichage gauche→droite
    const recent = placements.find(p => p.ttyId === 'new')!;
    const older = placements.find(p => p.ttyId === 'old')!;
    expect(recent.rightOffset).toBe(MARGIN);                                  // 16 (collé au bord droit)
    expect(older.rightOffset).toBe(MARGIN + DEFAULT_WIDTH + GAP);             // 16 + 420 + 16 = 452
  });

  it('empile trois panneaux côte à côte quand la largeur le permet (borne haute)', () => {
    // viewport=1600 → budget=1568 ; 420+16+420+16+420 = 1292 ≤ 1568
    const { placements } = computeTtyLayout(['a', 'b', 'c'], {}, 1600, false);
    expect(placements.map(p => p.ttyId)).toEqual(['a', 'b', 'c']); // gauche→droite, le plus récent à droite
    expect(placements.map(p => p.rightOffset)).toEqual([
      MARGIN + 2 * (DEFAULT_WIDTH + GAP), // a (plus ancien, à gauche) = 888
      MARGIN + (DEFAULT_WIDTH + GAP),     // b (milieu)               = 452
      MARGIN,                              // c (plus récent, à droite) = 16
    ]);
  });

  it('évince le plus ancien (FIFO) quand le budget est dépassé, en gardant ≥1 visible', () => {
    // viewport=800 → budget=768 ; deux panneaux de 420 (+gap) = 856 > 768
    const { placements } = computeTtyLayout(['old', 'new'], {}, 800, false);
    expect(placements).toHaveLength(1);
    expect(placements[0].ttyId).toBe('new'); // le plus récent survit
  });

  it('garde toujours au moins le plus récent même sur un écran minuscule', () => {
    const { placements } = computeTtyLayout(['old', 'new'], {}, 300, false);
    expect(placements).toHaveLength(1);
    expect(placements[0].ttyId).toBe('new');
  });

  it('auto-restaure : agrandir le viewport ramène un panneau précédemment évincé', () => {
    const narrow = computeTtyLayout(['old', 'new'], {}, 800, false);
    expect(narrow.placements).toHaveLength(1);
    const wide = computeTtyLayout(['old', 'new'], {}, WIDE, false);
    expect(wide.placements).toHaveLength(2);
  });

  it('un panneau élargi (largeur custom) peut évincer son voisin', () => {
    // viewport=900 → budget=868 ; un panneau à 700 + gap + 420 = 1136 > 868
    const { placements } = computeTtyLayout(['old', 'new'], { new: 700 }, 900, false);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ ttyId: 'new', effectiveWidth: 700 });
  });

  it('clampe une largeur stockée surdimensionnée au budget (robuste au shrink)', () => {
    // largeur stockée 5000 mais budget bien plus petit → effectiveWidth = budget
    const vw = 900;
    const { placements, budget } = computeTtyLayout(['a'], { a: 5000 }, vw, false);
    expect(budget).toBe(vw - MARGIN - MARGIN); // 868
    expect(placements[0].effectiveWidth).toBe(budget);
    expect(placements[0].maxWidth).toBe(budget); // seul panneau → peut prendre tout le budget
  });

  it('plafonne le drag de chaque panneau à sa largeur + l\'espace libre (anti auto-éviction)', () => {
    // 2 panneaux de 420, viewport 1600 → budget 1568, consommé 856, libre 712.
    // Chaque panneau peut grandir jusqu'à 420 + 712 = 1132, jamais au-delà : il ne peut
    // donc pas se pousser (ni pousser son voisin) hors écran en s'élargissant.
    const { placements } = computeTtyLayout(['a', 'b'], {}, 1600, false);
    expect(placements).toHaveLength(2);
    placements.forEach(p => expect(p.maxWidth).toBe(420 + 712));
    // Vérifie qu'un panneau à son maxWidth + le voisin tient pile dans le budget.
    expect(1132 + GAP + DEFAULT_WIDTH).toBe(1568);
  });

  it('renvoie une liste vide si aucun terminal ouvert', () => {
    const { placements } = computeTtyLayout([], {}, WIDE, false);
    expect(placements).toHaveLength(0);
  });
});
