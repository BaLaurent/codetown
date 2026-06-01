// client/src/utils/readable-text-color.test.ts
import { describe, it, expect } from 'vitest';
import { readableTextColor, inverseColor, defaultTextColor } from './readable-text-color';

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

describe('inverseColor', () => {
  it('returns the RGB negative', () => {
    expect(inverseColor('#000000')).toBe('#ffffff');
    expect(inverseColor('#ffffff')).toBe('#000000');
    expect(inverseColor('#C83030')).toBe('#37cfcf'); // rouge → cyan
  });

  it('accepts 3-digit hex', () => {
    expect(inverseColor('#000')).toBe('#ffffff');
  });

  it('falls back to white on malformed input', () => {
    expect(inverseColor('nope')).toBe('#ffffff');
  });
});

describe('defaultTextColor', () => {
  it('uses the literal inverse for vivid colors (distinguishable)', () => {
    expect(defaultTextColor('#C83030')).toBe('#37cfcf'); // rouge → cyan
    expect(defaultTextColor('#3070C8')).toBe('#cf8f37'); // bleu → orange
  });

  it('falls back to black/white for mid-grey (inverse ≈ background)', () => {
    expect(defaultTextColor('#808080')).toBe('#000'); // inverse #7f7f7f illisible
  });

  it('falls back to white on malformed input', () => {
    expect(defaultTextColor('xyz')).toBe('#fff');
  });
});
