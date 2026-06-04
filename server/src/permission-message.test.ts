import { describe, it, expect } from 'vitest';
import { buildPermissionRequestMessage } from './permission-message.js';

describe('buildPermissionRequestMessage', () => {
  it('carries the ExitPlanMode plan when present (the bash-hook regression)', () => {
    const msg = buildPermissionRequestMessage({
      agentId: 'a1', requestId: 'r1', kind: 'permission',
      toolName: 'ExitPlanMode', toolInput: '{"plan":"…"}', plan: '# Mon plan\n- étape 1',
    });
    expect(msg.plan).toBe('# Mon plan\n- étape 1');
  });

  it('omits optional fields that are undefined or empty', () => {
    const msg = buildPermissionRequestMessage({
      agentId: 'a1', requestId: 'r1', kind: 'permission', toolName: 'Bash', toolInput: 'ls',
    });
    expect(msg).toEqual({ agentId: 'a1', requestId: 'r1', kind: 'permission', toolName: 'Bash', toolInput: 'ls' });
    expect('plan' in msg).toBe(false);
    expect('title' in msg).toBe(false);
    expect('description' in msg).toBe(false);
  });

  it('keeps the SDK-path fields (title/description/plan) together', () => {
    const msg = buildPermissionRequestMessage({
      agentId: 'a1', requestId: 'r1', kind: 'permission',
      toolName: 'ExitPlanMode', title: 'Voici mon plan', description: 'sous-titre', plan: '# P',
    });
    expect(msg).toMatchObject({ title: 'Voici mon plan', description: 'sous-titre', plan: '# P' });
  });

  it('always keeps the required identity fields', () => {
    const msg = buildPermissionRequestMessage({ agentId: 'a1', requestId: 'r1', kind: 'question' });
    expect(msg).toEqual({ agentId: 'a1', requestId: 'r1', kind: 'question' });
  });
});
