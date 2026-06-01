// client/src/utils/readable-text-color.test.ts
import { describe, it, expect } from 'vitest';
import { readableTextColor } from './readable-text-color';

describe('readableTextColor', () => {
  it('returns black text on a light background', () => {
    expect(readableTextColor('#FFE040')).toBe('#000'); // jaune clair
    expect(readableTextColor('#FFFFFF')).toBe('#000');
  });

  it('returns white text on a dark background', () => {
    expect(readableTextColor('#3070C8')).toBe('#fff'); // bleu
    expect(readableTextColor('#000000')).toBe('#fff');
  });

  it('accepts 3-digit hex', () => {
    expect(readableTextColor('#000')).toBe('#fff');
    expect(readableTextColor('#fff')).toBe('#000');
  });

  it('falls back to white on malformed input', () => {
    expect(readableTextColor('not-a-color')).toBe('#fff');
  });
});
