import { describe, it, expect } from 'vitest';
import { planFromToolInput, shouldExitPlanMode } from './index.js';

describe('planFromToolInput', () => {
  it('returns the full plan markdown for an ExitPlanMode call, untruncated', () => {
    const plan = '# Fix décodage\n\n## Context\n' + 'x'.repeat(500);
    expect(planFromToolInput('ExitPlanMode', { plan })).toBe(plan);
  });

  it('returns undefined for any other tool', () => {
    expect(planFromToolInput('Edit', { plan: 'nope' })).toBeUndefined();
  });

  it('returns undefined when the plan field is missing or not a string', () => {
    expect(planFromToolInput('ExitPlanMode', {})).toBeUndefined();
    expect(planFromToolInput('ExitPlanMode', { plan: 42 })).toBeUndefined();
  });
});

describe('shouldExitPlanMode', () => {
  it('is true only when an ExitPlanMode call is allowed', () => {
    expect(shouldExitPlanMode('ExitPlanMode', { outcome: 'allow' })).toBe(true);
  });

  it('is false when ExitPlanMode is denied or times out', () => {
    expect(shouldExitPlanMode('ExitPlanMode', { outcome: 'deny' })).toBe(false);
    expect(shouldExitPlanMode('ExitPlanMode', { outcome: 'timeout' })).toBe(false);
  });

  it('is false for an allowed non-plan tool', () => {
    expect(shouldExitPlanMode('Bash', { outcome: 'allow' })).toBe(false);
  });
});
