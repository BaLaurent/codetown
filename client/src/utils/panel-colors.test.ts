import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPanelColor, setPanelColor, clearPanelColor,
  getPanelTextColor, setPanelTextColor, clearPanelTextColor,
} from './panel-colors';

describe('panel-colors', () => {
  let storage: Record<string, string> = {};

  beforeEach(() => {
    storage = {};
    // Node.js v25 ships a broken `localStorage` global that shadows jsdom's;
    // mock it so the store under test has a working localStorage.
    global.localStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        storage = {};
      },
      key: (index: number) => Object.keys(storage)[index] ?? null,
      length: Object.keys(storage).length,
    } as any;
  });

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

  it('stores text colour independently from background colour', () => {
    setPanelColor('tty:a', '#C83030');
    setPanelTextColor('tty:a', '#FFFFFF');
    expect(getPanelColor('tty:a')).toBe('#C83030');
    expect(getPanelTextColor('tty:a')).toBe('#FFFFFF');
    // distinct localStorage buckets
    expect(localStorage.getItem('codetown-panel-text-colors')).toContain('#FFFFFF');
    expect(localStorage.getItem('codetown-panel-colors')).not.toContain('#FFFFFF');
  });

  it('clearPanelTextColor removes only the text colour', () => {
    setPanelColor('tty:a', '#C83030');
    setPanelTextColor('tty:a', '#FFFFFF');
    clearPanelTextColor('tty:a');
    expect(getPanelTextColor('tty:a')).toBeNull();
    expect(getPanelColor('tty:a')).toBe('#C83030'); // fond intact
  });
});
