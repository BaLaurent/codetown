import { describe, it, expect, beforeEach } from 'vitest';
import {
  getVolume, setVolume,
  getNotificationSound, setNotificationSound,
} from './sounds';

describe('sounds store', () => {
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
      get length() {
        return Object.keys(storage).length;
      },
    } as Storage;
  });

  describe('volume', () => {
    it('persists the set value and reads it back', () => {
      setVolume(0.42);
      expect(getVolume()).toBeCloseTo(0.42);
      expect(storage['codemap-audio-volume']).toBe('0.42');
    });

    it('clamps values above 1 down to 1', () => {
      setVolume(5);
      expect(getVolume()).toBe(1);
    });

    it('clamps negative values up to 0', () => {
      setVolume(-3);
      expect(getVolume()).toBe(0);
    });
  });

  describe('notification sound', () => {
    it('persists a custom data URL', () => {
      const dataUrl = 'data:audio/wav;base64,AAAA';
      setNotificationSound(dataUrl);
      expect(getNotificationSound()).toBe(dataUrl);
      expect(storage['codemap-notification-sound']).toBe(dataUrl);
    });

    it("falls back to 'default' for an empty value", () => {
      setNotificationSound('');
      expect(getNotificationSound()).toBe('default');
      expect(storage['codemap-notification-sound']).toBe('default');
    });
  });
});
