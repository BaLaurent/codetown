// client/src/components/dock-layout.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeDockLayout, panelKey, redistributeWidth, computeDockHeight,
  DEFAULT_WIDTH, GAP, MARGIN,
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
    expect(placements.map(p => p.id)).toEqual(['old', 'new']);
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
    expect(placements[0].maxWidth).toBeGreaterThan(600);
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
    const wide4 = computeDockLayout(
      [tty('a'), tty('b'), tty('c'), tty('d')], {}, 800, 'docked', null,
    );
    expect(wide4.placements).toHaveLength(3);
    expect(wide4.placements.map(p => p.id)).toEqual(['b', 'c', 'd']);
  });

  it('maxWidth : le panneau gauche peut absorber la marge du voisin droit ; le plus à droite est figé', () => {
    const { placements } = computeDockLayout([tty('a'), tty('b')], {}, WIDE, 'docked', null);
    expect(placements[0].maxWidth).toBeGreaterThan(placements[0].effectiveWidth);
    expect(placements[1].maxWidth).toBe(placements[1].effectiveWidth); // rightmost: figé (pas de voisin droite)
  });
});

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

  it('clé absente → renvoie le même objet (bail-out)', () => {
    const w = { 'tty:a': 400 };
    expect(redistributeWidth(['tty:a'], w, 'tty:zzz', 600)).toBe(w);
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
