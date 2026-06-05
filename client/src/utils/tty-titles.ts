// Custom display titles for TTY sessions, keyed by ttyId (UUID).
// Persists across reloads; lost when the session is killed (ttyId changes).
// No hot-path reads (unlike agent-names), so no in-memory cache needed.

const STORAGE_KEY = 'codetown-tty-titles';

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persist(titles: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(titles));
  } catch {
    // localStorage unavailable; falls back to server-assigned title.
  }
}

/** Custom title for a TTY, or `fallback` (server-assigned title). */
export function getTtyTitle(ttyId: string, fallback: string): string {
  return load()[ttyId] ?? fallback;
}

/** Persist a custom title for a TTY. */
export function setTtyTitle(ttyId: string, title: string): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  const titles = load();
  titles[ttyId] = trimmed;
  persist(titles);
}

/** Remove the custom title (called when the session is killed). */
export function clearTtyTitle(ttyId: string): void {
  const titles = load();
  delete titles[ttyId];
  persist(titles);
}
