// client/src/components/dock-layout.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeDockLayout, panelKey,
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
