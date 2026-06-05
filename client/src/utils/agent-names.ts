// Custom display names for agents, keyed by agentId (the session UUID).
//
// Names persist across page reloads but NOT across agent restarts: a fresh
// Claude/Cursor session gets a new UUID, so its custom name is lost. This is
// accepted for v1.
//
// Reads go through an in-memory cache because the canvas calls getAgentName on
// every drawn agent at ~30fps — touching localStorage on that hot path would be
// wasteful. Writes update the cache, persist to localStorage, and broadcast a
// DOM event so the roster panel can re-render. Mirrors the cache+localStorage
// pattern in sounds.ts.

const STORAGE_KEY = 'codetown-agent-names';
export const AGENT_NAMES_CHANGED = 'codetown-agent-names-changed';

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let names: Record<string, string> = load();

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // localStorage unavailable; the in-memory cache still serves this session.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AGENT_NAMES_CHANGED));
  }
}

/** Custom name for an agent, or `fallback` (its server-assigned name). */
export function getAgentName(agentId: string, fallback: string): string {
  return names[agentId] ?? fallback;
}

/** True when the user has assigned a custom name to this agent. */
export function hasCustomName(agentId: string): boolean {
  return agentId in names;
}

/** Set a custom name. An empty/whitespace name clears it instead. */
export function setAgentName(agentId: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    clearAgentName(agentId);
    return;
  }
  names[agentId] = trimmed;
  persist();
}

/** Remove a custom name, restoring the agent's default display name. */
export function clearAgentName(agentId: string): void {
  if (!(agentId in names)) return;
  delete names[agentId];
  persist();
}
