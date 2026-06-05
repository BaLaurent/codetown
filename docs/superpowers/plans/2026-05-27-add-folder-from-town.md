# Add Folder From Town — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user raise a persistent, empty building for any folder from the town view, enter it, spawn agents in it, and remove it (killing live agents on confirmation).

**Architecture:** Server-authoritative. A folder is pinned via `POST /api/projects`, which derives its identity (`deriveProjectFromDir`), creates a registry workspace, marks it `pinned`, and persists it to `~/.codetown/state.json` (restored at boot). A server endpoint (`GET /api/fs/list`) feeds a pixel-art `FolderBrowser` modal. The town gets a "+" affordance and a ✕ badge on pinned buildings; removal with live agents opens a kill-confirm modal. The client picks up new/removed buildings via the existing `useProjects` poll.

**Tech Stack:** Node + Express + WebSocket (server, TS, ESM with `.js` import specifiers), React + Canvas (client, TS), Vitest both sides.

**Spec:** `docs/superpowers/specs/2026-05-27-add-folder-from-town-design.md`

**Branch:** stay on `main` (per user). Commit steps target the current branch.

---

## File Structure

**Server**
- `server/src/project-identity.ts` (modify) — add `deriveProjectFromDir`.
- `server/src/fs-browse.ts` (create) — `listSubdirectories` (pure, testable).
- `server/src/fs-browse.test.ts` (create).
- `server/src/project-registry.ts` (modify) — `pinned` flag, `setPinned`, `remove`, `listPinned`, `isPinned` in `list()`.
- `server/src/project-registry.test.ts` (create or extend).
- `server/src/project-identity.test.ts` (create or extend).
- `server/src/types.ts` (modify) — `ProjectInfo.isPinned`.
- `server/src/index.ts` (modify) — extract `killAgent`; add `/api/fs/list`, `POST`/`DELETE /api/projects`; persist `pinnedProjects`.

**Client**
- `client/src/types.ts` (modify) — `ProjectInfo.isPinned`.
- `client/src/layout/town-hit-test.ts` (create) — `hitTownAt`, `closeBadgeRect`, `removeAction` (pure).
- `client/src/layout/town-hit-test.test.ts` (create).
- `client/src/components/FolderBrowser.tsx` (create) — directory browser modal.
- `client/src/components/TownView.tsx` (modify) — "+", ✕, kill-confirm modal, POST/DELETE wiring.

**Testing note (matches the repo):** `index.ts` does not export `app` and there is no supertest/testing-library setup. Tests cover **pure units** (`deriveProjectFromDir`, `listSubdirectories`, registry methods, `hitTownAt`/`removeAction`). The thin endpoints, the `FolderBrowser` component, and canvas drawing are verified by `tsc` + `vite build` + the manual smoke step (Task 11) — the same way the P2 town was verified. Do **not** introduce a new test framework for this feature.

---

## Phase 1 — Server data layer (pure, testable)

### Task 1: `deriveProjectFromDir`

**Files:**
- Modify: `server/src/project-identity.ts`
- Test: `server/src/project-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/project-identity.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { deriveProjectFromDir } from './project-identity.js';

describe('deriveProjectFromDir', () => {
  it('resolves a git repo to its toplevel', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-git-')));
    execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
    const sub = path.join(tmp, 'src');
    fs.mkdirSync(sub);
    const f = deriveProjectFromDir(sub);
    expect(f).toEqual({ projectId: tmp, projectRoot: tmp, projectName: path.basename(tmp) });
  });

  it('falls back to the directory itself when not a git repo', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-plain-')));
    const f = deriveProjectFromDir(tmp);
    expect(f).toEqual({ projectId: tmp, projectRoot: tmp, projectName: path.basename(tmp) });
  });

  it('rejects a non-project root (~/.claude)', () => {
    expect(deriveProjectFromDir(path.join(os.homedir(), '.claude'))).toBeUndefined();
  });

  it('rejects a relative path', () => {
    expect(deriveProjectFromDir('relative/dir')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/project-identity.test.ts`
Expected: FAIL — `deriveProjectFromDir is not a function`.

- [ ] **Step 3: Add the implementation**

Append to `server/src/project-identity.ts` (reuses `gitRootOf` + `NON_PROJECT_ROOTS` already in the file):

```ts
// Derive a building from an absolute *directory* the user picked in the town.
// Sibling of deriveProjectFromPath (which takes a file path); both share
// gitRootOf, so a sub-dir of a repo resolves to the repo root, and a non-git
// folder becomes its own project.
export function deriveProjectFromDir(absDir: string): ProjectFields | undefined {
  if (!path.isAbsolute(absDir)) return undefined;
  if (NON_PROJECT_ROOTS.some(r => absDir === r || absDir.startsWith(r + path.sep))) return undefined;
  const root = gitRootOf(absDir);
  return { projectId: root, projectRoot: root, projectName: path.basename(root) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/project-identity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/project-identity.ts server/src/project-identity.test.ts
git commit -m "feat(server): deriveProjectFromDir for town folder picking"
```

---

### Task 2: `listSubdirectories` (fs-browse module)

**Files:**
- Create: `server/src/fs-browse.ts`
- Test: `server/src/fs-browse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/fs-browse.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listSubdirectories } from './fs-browse.js';

let root: string;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fs-')));
  fs.mkdirSync(path.join(root, 'alpha'));
  fs.mkdirSync(path.join(root, 'beta'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('listSubdirectories', () => {
  it('returns sub-directories only, sorted, excluding dotfiles and files', () => {
    const r = listSubdirectories(root);
    expect(r.entries.map(e => e.name)).toEqual(['alpha', 'beta']);
    expect(r.entries[0].path).toBe(path.join(root, 'alpha'));
    expect(r.path).toBe(root);
  });

  it('exposes the parent directory', () => {
    const r = listSubdirectories(root);
    expect(r.parent).toBe(path.dirname(root));
  });

  it('defaults to the home directory for an empty path', () => {
    const r = listSubdirectories('');
    expect(r.path).toBe(os.homedir());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/fs-browse.test.ts`
Expected: FAIL — cannot find module `./fs-browse.js`.

- [ ] **Step 3: Create the module**

```ts
// server/src/fs-browse.ts
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface DirEntry { name: string; path: string; }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[]; }

// Lists the immediate sub-directories of `dir` for the folder browser. Hidden
// (dotfile) directories are omitted; unreadable / dangling symlink entries are
// skipped. An empty/blank dir defaults to the user's home directory.
export function listSubdirectories(dir: string): DirListing {
  const abs = dir && path.isAbsolute(dir) ? dir : os.homedir();
  const dirents = fs.readdirSync(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(abs, d.name)).isDirectory(); } catch { continue; }
    }
    if (isDir) entries.push({ name: d.name, path: path.join(abs, d.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, entries };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/fs-browse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/fs-browse.ts server/src/fs-browse.test.ts
git commit -m "feat(server): listSubdirectories for the folder browser"
```

---

### Task 3: Registry pinning + `ProjectInfo.isPinned`

**Files:**
- Modify: `server/src/types.ts:172-178`
- Modify: `server/src/project-registry.ts`
- Test: `server/src/project-registry.test.ts`

- [ ] **Step 1: Add `isPinned` to the shared type**

In `server/src/types.ts`, add the field to `ProjectInfo`:

```ts
export interface ProjectInfo {
  projectId: string;
  projectName: string;
  projectRoot: string;
  lastActivity: number;
  agentCount: number;
  isPinned: boolean;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// server/src/project-registry.test.ts
import { describe, it, expect } from 'vitest';
import { ProjectRegistry } from './project-registry.js';

describe('ProjectRegistry pinning', () => {
  it('defaults workspaces to not pinned', () => {
    const r = new ProjectRegistry();
    r.getOrCreate('/p', '/p', 'p');
    expect(r.list()[0].isPinned).toBe(false);
    expect(r.listPinned()).toEqual([]);
  });

  it('setPinned flips the flag and listPinned reflects it', () => {
    const r = new ProjectRegistry();
    r.getOrCreate('/p', '/p', 'p');
    r.setPinned('/p', true);
    expect(r.list()[0].isPinned).toBe(true);
    expect(r.listPinned()).toEqual([{ projectId: '/p', projectRoot: '/p', projectName: 'p' }]);
  });

  it('getOrCreate on an existing project keeps it pinned (idempotent)', () => {
    const r = new ProjectRegistry();
    r.getOrCreate('/p', '/p', 'p');
    r.setPinned('/p', true);
    r.getOrCreate('/p', '/p', 'p'); // e.g. activity arrives later
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0].isPinned).toBe(true);
  });

  it('remove drops the workspace', () => {
    const r = new ProjectRegistry();
    r.getOrCreate('/p', '/p', 'p');
    r.remove('/p');
    expect(r.get('/p')).toBeUndefined();
    expect(r.list()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run src/project-registry.test.ts`
Expected: FAIL — `setPinned`/`listPinned`/`remove` not functions; `isPinned` undefined.

- [ ] **Step 4: Implement registry changes**

In `server/src/project-registry.ts`:

Add `pinned` to the interface:

```ts
export interface ProjectWorkspace {
  projectId: string;
  projectName: string;
  projectRoot: string;
  store: ActivityStore;
  lastActivity: number;
  agentCount: number;
  pinned: boolean;
}
```

In `getOrCreate`, initialize `pinned: false` (existing workspaces are returned untouched, so a prior pin survives — that is the idempotency guarantee):

```ts
    w = { projectId, projectName, projectRoot, store, lastActivity: Date.now(), agentCount: 0, pinned: false };
```

Add `isPinned` to the `list()` mapping:

```ts
  list(): ProjectInfo[] {
    return Array.from(this.workspaces.values()).map(w => ({
      projectId: w.projectId,
      projectName: w.projectName,
      projectRoot: w.projectRoot,
      lastActivity: w.lastActivity,
      agentCount: w.agentCount,
      isPinned: w.pinned,
    }));
  }
```

Add the three new methods (after `list()`):

```ts
  setPinned(projectId: string, value: boolean): void {
    const w = this.workspaces.get(projectId);
    if (w) w.pinned = value;
  }

  // The persisted shape for pinned projects (re-created via getOrCreate at boot).
  listPinned(): Array<{ projectId: string; projectRoot: string; projectName: string }> {
    return Array.from(this.workspaces.values())
      .filter(w => w.pinned)
      .map(w => ({ projectId: w.projectId, projectRoot: w.projectRoot, projectName: w.projectName }));
  }

  remove(projectId: string): void {
    const w = this.workspaces.get(projectId);
    if (!w) return;
    w.store.stopWatching();
    this.workspaces.delete(projectId);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run src/project-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/types.ts server/src/project-registry.ts server/src/project-registry.test.ts
git commit -m "feat(server): registry pin/unpin/remove + ProjectInfo.isPinned"
```

---

## Phase 2 — Server endpoints & persistence

### Task 4: Extract `killAgent` helper

**Files:**
- Modify: `server/src/index.ts:670-684`

This is a behavior-preserving refactor (no new test; verified by existing suite + `tsc`). The kill logic is now used by two callers (the stop route and building deletion in Task 5), so it becomes one helper.

- [ ] **Step 1: Add the helper near the other agent helpers**

Add above the `/api/agent/:agentId/stop` route:

```ts
// Kill an agent: end its SDK session (if any) AND clear its hotel character so
// it doesn't linger. Safe for external agents (no session) — the character is
// still removed and the death animation plays. Used by the stop route and by
// building removal.
async function killAgent(agentId: string): Promise<boolean> {
  const ok = await stopAgent(agentId);
  if (agentStates.delete(agentId)) {
    refreshAgentCounts();
    saveAgentState();
    wsManager.broadcast('thinking', getAgentStatesArray());
    wsManager.broadcast('agent-killed', { agentId });
  }
  return ok;
}
```

- [ ] **Step 2: Replace the route body with a call to it**

```ts
app.post('/api/agent/:agentId/stop', async (req, res) => {
  res.status(200).json({ ok: await killAgent(req.params.agentId) });
});
```

- [ ] **Step 3: Verify nothing broke**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: PASS (existing suite green, no type errors).

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "refactor(server): extract killAgent helper from stop route"
```

---

### Task 5: Endpoints — `GET /api/fs/list`, `POST`/`DELETE /api/projects`

**Files:**
- Modify: `server/src/index.ts` (imports near top; routes near the existing `GET /api/projects` at line 687)

No HTTP-level test (no `app` export); logic is delegated to units tested in Tasks 1–4. Verified by `tsc` + the manual smoke (Task 11).

- [ ] **Step 1: Add imports**

At the top of `server/src/index.ts`, alongside the other local imports:

```ts
import { listSubdirectories } from './fs-browse.js';
import { deriveProjectFromDir } from './project-identity.js';
```

(`fs`, `path` are already imported in this file.)

- [ ] **Step 2: Add the directory-listing endpoint**

Add near `GET /api/projects`:

```ts
// Folder browser: list the sub-directories of a path so the town can pick a
// folder to raise as a building. Defaults to the home directory.
app.get('/api/fs/list', (req, res) => {
  const q = typeof req.query.path === 'string' ? req.query.path : '';
  if (q && (!path.isAbsolute(q) || !fs.existsSync(q) || !fs.statSync(q).isDirectory())) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  try {
    res.json(listSubdirectories(q));
  } catch {
    res.status(400).json({ error: 'cannot read directory' });
  }
});
```

- [ ] **Step 3: Add the pin endpoint**

```ts
// Pin a folder as a persistent building. Idempotent: pinning an already-tracked
// project only flips its flag.
app.post('/api/projects', (req, res) => {
  const dir = (req.body ?? {}).path;
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  const fields = deriveProjectFromDir(dir);
  if (!fields) {
    res.status(400).json({ error: 'not a project directory' });
    return;
  }
  registry.getOrCreate(fields.projectId, fields.projectRoot, fields.projectName);
  registry.setPinned(fields.projectId, true);
  saveAgentState();
  res.status(200).json(registry.list().find(p => p.projectId === fields.projectId));
});
```

- [ ] **Step 4: Add the remove endpoint**

```ts
// Remove a building. With live agents and no ?kill=true, refuse (409) so the API
// is not a footgun; the client pre-empts this by showing a kill-confirm modal.
app.delete('/api/projects/:id', async (req, res) => {
  const id = req.params.id;
  const agents = getAgentStatesArray().filter(a => a.projectId === id);
  if (agents.length > 0 && req.query.kill !== 'true') {
    res.status(409).json({ agents });
    return;
  }
  for (const a of agents) await killAgent(a.agentId);
  registry.remove(id);
  saveAgentState();
  res.status(200).json({ ok: true });
});
```

- [ ] **Step 5: Verify**

Run: `cd server && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): /api/fs/list and POST/DELETE /api/projects"
```

---

### Task 6: Persist `pinnedProjects` in `state.json`

**Files:**
- Modify: `server/src/index.ts:95-126` (`saveAgentState` and `loadAgentState`)

Single writer (one file): `saveAgentState` is extended to also serialize the pinned list; `loadAgentState` restores it. No separate writer — that would clobber `agents`.

- [ ] **Step 1: Extend the save**

In `saveAgentState`, add `pinnedProjects` to the serialized object:

```ts
    const state = {
      savedAt: Date.now(),
      agents: Array.from(agentStates.values()),
      pinnedProjects: registry.listPinned(),
    };
```

- [ ] **Step 2: Extend the load**

In `loadAgentState`, after the existing agents-restore loop, add:

```ts
      for (const p of data.pinnedProjects || []) {
        if (p && typeof p.projectRoot === 'string' && fs.existsSync(p.projectRoot)) {
          registry.getOrCreate(p.projectId, p.projectRoot, p.projectName);
          registry.setPinned(p.projectId, true);
        }
      }
```

(`registry` is module-level and defined before `loadAgentState` runs at boot. A pinned folder that no longer exists on disk is skipped.)

- [ ] **Step 3: Verify**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors.

- [ ] **Step 4: Manual round-trip check**

```bash
cd server && npm run dev &   # or rely on the auto-start
sleep 2
curl -s -X POST localhost:5174/api/projects -H 'Content-Type: application/json' -d "{\"path\":\"$PWD\"}" | jq .isPinned
grep -c pinnedProjects ~/.codetown/state.json
```
Expected: `true`, and `state.json` contains a `pinnedProjects` entry.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): persist pinned projects in state.json"
```

---

## Phase 3 — Client

### Task 7: Pure town hit-test + `isPinned` client type

**Files:**
- Modify: `client/src/types.ts:114-120`
- Create: `client/src/layout/town-hit-test.ts`
- Test: `client/src/layout/town-hit-test.test.ts`

- [ ] **Step 1: Mirror `isPinned` in the client type**

In `client/src/types.ts`, add to `ProjectInfo`:

```ts
export interface ProjectInfo {
  projectId: string;
  projectName: string;
  projectRoot: string;
  lastActivity: number;
  agentCount: number;
  isPinned: boolean;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// client/src/layout/town-hit-test.test.ts
import { describe, it, expect } from 'vitest';
import { layoutTown, BUILDING_SIZE } from './town-layout';
import { hitTownAt, removeAction } from './town-hit-test';
import { ProjectInfo } from '../types';

const p = (id: string, pinned: boolean, agents = 0): ProjectInfo =>
  ({ projectId: id, projectName: id, projectRoot: id, lastActivity: 0, agentCount: agents, isPinned: pinned });

describe('hitTownAt', () => {
  it('hits the building body at its top-left corner', () => {
    const placed = layoutTown([p('a', false)]);
    const b = placed[0];
    expect(hitTownAt(placed, b.x + 2, b.y + BUILDING_SIZE.h - 2)).toEqual({ building: b, region: 'body' });
  });

  it('hits the close badge (top-right) only on pinned buildings', () => {
    const placed = layoutTown([p('a', true)]);
    const b = placed[0];
    const hit = hitTownAt(placed, b.x + BUILDING_SIZE.w - 2, b.y + 2);
    expect(hit).toEqual({ building: b, region: 'close' });
  });

  it('treats the top-right of a non-pinned building as body, not close', () => {
    const placed = layoutTown([p('a', false)]);
    const b = placed[0];
    expect(hitTownAt(placed, b.x + BUILDING_SIZE.w - 2, b.y + 2)).toEqual({ building: b, region: 'body' });
  });

  it('returns null on empty space', () => {
    const placed = layoutTown([p('a', true)]);
    expect(hitTownAt(placed, 99999, 99999)).toBeNull();
  });
});

describe('removeAction', () => {
  it('asks for confirmation when agents are running', () => {
    expect(removeAction(layoutTown([p('a', true, 2)])[0])).toBe('confirm');
  });
  it('deletes directly when no agents', () => {
    expect(removeAction(layoutTown([p('a', true, 0)])[0])).toBe('delete');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd client && npx vitest run src/layout/town-hit-test.test.ts`
Expected: FAIL — cannot find module `./town-hit-test`.

- [ ] **Step 4: Create the module**

```ts
// client/src/layout/town-hit-test.ts
import { PlacedBuilding, BUILDING_SIZE } from './town-layout';

export type TownHit = { building: PlacedBuilding; region: 'body' | 'close' } | null;

// Size (px) of the ✕ badge anchored at a pinned building's top-right corner.
const CLOSE = 16;

export function closeBadgeRect(b: PlacedBuilding): { x: number; y: number; w: number; h: number } {
  return { x: b.x + BUILDING_SIZE.w - CLOSE, y: b.y, w: CLOSE, h: CLOSE };
}

// Resolve what a click at (mx,my) hits. The close badge (pinned only) is tested
// first so it wins over the building body it overlaps.
export function hitTownAt(placed: PlacedBuilding[], mx: number, my: number): TownHit {
  for (const b of placed) {
    if (!b.isPinned) continue;
    const r = closeBadgeRect(b);
    if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return { building: b, region: 'close' };
  }
  for (const b of placed) {
    if (mx >= b.x && mx <= b.x + BUILDING_SIZE.w && my >= b.y && my <= b.y + BUILDING_SIZE.h) {
      return { building: b, region: 'body' };
    }
  }
  return null;
}

// Whether removing a building needs a kill confirmation (live agents) or can
// delete straight away.
export function removeAction(b: PlacedBuilding): 'confirm' | 'delete' {
  return b.agentCount > 0 ? 'confirm' : 'delete';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd client && npx vitest run src/layout/town-hit-test.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/types.ts client/src/layout/town-hit-test.ts client/src/layout/town-hit-test.test.ts
git commit -m "feat(client): pure town hit-test (close badge) + isPinned type"
```

---

### Task 8: `FolderBrowser` modal component

**Files:**
- Create: `client/src/components/FolderBrowser.tsx`

Verified by `tsc` + `vite build` + manual smoke (no testing-library in this repo).

- [ ] **Step 1: Create the component**

```tsx
// client/src/components/FolderBrowser.tsx
// Pixel-art directory browser: descends the filesystem via /api/fs/list and pins
// the chosen folder as a building (POST /api/projects). Palette matches SpawnPanel.
import { useEffect, useState, type CSSProperties } from 'react';

const API_URL = 'http://localhost:5174/api';
const C = { ink: '#3A2E12', border: '#4A3B1A', gold: '#FFE040', cream: '#FFF8E6' };

const wrap: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, width: 380, maxHeight: '70vh', boxSizing: 'border-box',
  background: C.cream, border: `4px solid ${C.border}`, boxShadow: '6px 6px 0 rgba(0,0,0,0.35)', padding: 10,
};
const row: CSSProperties = {
  fontFamily: 'monospace', fontSize: 13, color: C.ink, background: '#fff',
  border: `2px solid ${C.border}`, padding: '5px 8px', cursor: 'pointer', textAlign: 'left',
};
const goldBtn: CSSProperties = {
  fontFamily: 'monospace', fontWeight: 700, fontSize: 13, padding: '6px 12px', color: C.ink,
  background: C.gold, border: `3px solid ${C.border}`, boxShadow: '2px 2px 0 rgba(0,0,0,0.3)', cursor: 'pointer',
};

interface Listing { path: string; parent: string | null; entries: { name: string; path: string }[]; }

export function FolderBrowser({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState('');

  const load = (path?: string) => {
    const url = path ? `${API_URL}/fs/list?path=${encodeURIComponent(path)}` : `${API_URL}/fs/list`;
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: Listing) => { setListing(d); setError(''); })
      .catch(() => setError('Dossier illisible'));
  };

  useEffect(() => { load(); }, []);

  const addHere = () => {
    if (!listing) return;
    fetch(`${API_URL}/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: listing.path }),
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(() => { onAdded(); onClose(); })
      .catch(() => setError('Impossible d’ajouter ce dossier'));
  };

  return (
    <div style={wrap} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700 }}>📁 Ajouter un dossier</span>
        <button style={{ ...goldBtn, background: 'transparent', boxShadow: 'none', border: 'none' }} onClick={onClose} title="Fermer">✕</button>
      </div>

      <div style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.7, wordBreak: 'break-all' }}>{listing?.path ?? '…'}</div>
      {error && <div style={{ color: '#B00020', fontSize: 12 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' }}>
        {listing?.parent && <button style={row} onClick={() => load(listing.parent!)}>⬆ ..</button>}
        {listing?.entries.map(e => (
          <button key={e.path} style={row} onClick={() => load(e.path)}>📁 {e.name}</button>
        ))}
        {listing && listing.entries.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.6, padding: 4 }}>(aucun sous-dossier)</div>
        )}
      </div>

      <button style={goldBtn} onClick={addHere} disabled={!listing}>Ajouter ici</button>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/FolderBrowser.tsx
git commit -m "feat(client): FolderBrowser modal (directory picker)"
```

---

### Task 9: Wire `TownView` — "+", ✕, kill-confirm, POST/DELETE

**Files:**
- Modify: `client/src/components/TownView.tsx`

- [ ] **Step 1: Add imports and state**

At the top of the file:

```tsx
import { useEffect, useRef, useState } from 'react';
import { hitTownAt, closeBadgeRect, removeAction } from '../layout/town-hit-test';
import { FolderBrowser } from './FolderBrowser';
```

Inside the component (after `hoverRef`):

```tsx
  const API_URL = 'http://localhost:5174/api';
  const [browsing, setBrowsing] = useState(false);
  const [confirmKill, setConfirmKill] = useState<{ projectId: string; name: string; agents: number } | null>(null);

  const deleteProject = (projectId: string, kill: boolean) => {
    fetch(`${API_URL}/projects/${encodeURIComponent(projectId)}${kill ? '?kill=true' : ''}`, { method: 'DELETE' })
      .catch(() => {});
  };
```

- [ ] **Step 2: Replace the click/hover hit logic**

Replace the existing `hit`/`onMove`/`onClick` block (lines ~63-76) with:

```tsx
    const onMove = (e: MouseEvent) => {
      const h = hitTownAt(placedRef.current, e.clientX, e.clientY);
      hoverRef.current = h ? h.building.projectId : null;
      canvas.style.cursor = h ? 'pointer' : 'default';
    };
    const onClick = (e: MouseEvent) => {
      // "+" button (top-right corner) opens the folder browser.
      if (e.clientX >= canvas.width - 44 && e.clientX <= canvas.width - 12 && e.clientY >= 12 && e.clientY <= 44) {
        setBrowsing(true);
        return;
      }
      const h = hitTownAt(placedRef.current, e.clientX, e.clientY);
      if (!h) return;
      if (h.region === 'close') {
        if (removeAction(h.building) === 'confirm') {
          setConfirmKill({ projectId: h.building.projectId, name: h.building.projectName, agents: h.building.agentCount });
        } else {
          deleteProject(h.building.projectId, false);
        }
        return;
      }
      onSelect(h.building.projectId);
    };
```

- [ ] **Step 3: Draw the "+" and the ✕ badges in the render loop**

After the building-drawing `for` loop (after line ~51), before the empty-state block, add:

```tsx
      // Close (✕) badge on pinned buildings.
      for (const b of placedRef.current) {
        if (!b.isPinned) continue;
        const r = closeBadgeRect(b);
        ctx.fillStyle = '#B00020';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('✕', r.x + r.w / 2, r.y + r.h - 4);
        ctx.textAlign = 'left';
      }
      // "+" button to add a folder (top-right corner).
      ctx.fillStyle = '#FFE040';
      ctx.fillRect(canvas.width - 44, 12, 32, 32);
      ctx.fillStyle = '#3A2E12';
      ctx.font = 'bold 24px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('+', canvas.width - 28, 37);
      ctx.textAlign = 'left';
```

Update the empty-state hint (line ~56) to mention the "+":

```tsx
        ctx.fillText('Aucun projet — lance Claude/Cursor dans un repo, ou clique « + » pour ajouter un dossier.', canvas.width / 2, canvas.height / 2);
```

- [ ] **Step 4: Render the modals**

Change the final `return <canvas …/>` (line ~96) to also render the browser and the kill-confirm overlay:

```tsx
  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.4)', zIndex: 50,
  };

  return (
    <>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      {browsing && (
        <div style={overlay} onClick={e => { if (e.target === e.currentTarget) setBrowsing(false); }}>
          <FolderBrowser onAdded={() => {}} onClose={() => setBrowsing(false)} />
        </div>
      )}
      {confirmKill && (
        <div style={overlay}>
          <div style={{ background: '#FFF8E6', border: '4px solid #4A3B1A', boxShadow: '6px 6px 0 rgba(0,0,0,0.35)', padding: 16, fontFamily: 'monospace', color: '#3A2E12', width: 340 }}>
            <div style={{ marginBottom: 12 }}>
              {confirmKill.agents} agent(s) tournent dans « {confirmKill.name} ». Les tuer et retirer le bâtiment ?
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={{ fontFamily: 'monospace', padding: '6px 12px', border: '3px solid #4A3B1A', background: '#fff', cursor: 'pointer' }} onClick={() => setConfirmKill(null)}>Non</button>
              <button style={{ fontFamily: 'monospace', fontWeight: 700, padding: '6px 12px', border: '3px solid #4A3B1A', background: '#B00020', color: '#fff', cursor: 'pointer' }}
                onClick={() => { deleteProject(confirmKill.projectId, true); setConfirmKill(null); }}>Oui, tuer</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
```

Note: the `if (selected) return <HabboRoom …/>` early-return stays above this, unchanged.

- [ ] **Step 5: Verify compile + build**

Run: `cd client && npx tsc --noEmit && npx vitest run && npm run build`
Expected: no type errors, all client tests pass, production build clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/TownView.tsx
git commit -m "feat(client): add/remove buildings from the town (+ button, ✕ badge, kill-confirm)"
```

---

## Phase 4 — Verification

### Task 10: Full suites + type checks

- [ ] **Step 1: Server**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: all server tests pass.

- [ ] **Step 2: Client**

Run: `cd client && npx tsc --noEmit && npm test && npm run build`
Expected: all client tests pass, build clean.

- [ ] **Step 3: Commit (if any incidental fixes were needed)**

```bash
git add -A
git commit -m "test: verify add-folder-from-town suites green"
```

---

### Task 11: Manual smoke (browser)

The town canvas and modals are not pixel-tested; verify them live.

- [ ] **Step 1: Start both**

Run: `npm run dev` (from repo root) and open `http://localhost:5173/hotel`.

- [ ] **Step 2: Add a folder**

Click the **+** (top-right). Browse to a folder with no agent activity. Click **Ajouter ici**. Within ~3s (the `useProjects` poll) a new building appears in the town.

- [ ] **Step 3: Enter + spawn**

Click the new building → it opens the interior (`HabboRoom`). Spawn an agent from inside (existing flow). Go back to the town (← Town).

- [ ] **Step 4: Remove (no agents)**

Hover a pinned building with no live agent → ✕ appears top-right. Click it → building disappears within ~3s.

- [ ] **Step 5: Remove (live agents)**

With a spawned agent still running in a pinned building, click its ✕ → the kill-confirm modal appears. Click **Oui, tuer** → the agent's character plays the death animation and the building is removed.

- [ ] **Step 6: Restart persistence**

Add a folder, then restart the server. Reload `/hotel` → the pinned building is still present before any activity.

---

## Self-Review (completed during authoring)

- **Spec coverage:** every spec section maps to a task — `deriveProjectFromDir` (T1), `/api/fs/list` (T2/T5), pin/unpin/remove + `isPinned` (T3/T5), `killAgent` extraction (T4), persistence single-writer (T6), client hit-test/`removeAction` (T7), `FolderBrowser` (T8), "+"/✕/kill-confirm wiring (T9), tests + smoke (T10/T11).
- **Type consistency:** `ProjectInfo.isPinned` (server T3 + client T7); `hitTownAt`/`closeBadgeRect`/`removeAction` names consistent T7↔T9; `killAgent` signature consistent T4↔T5; `listPinned()` shape consistent T3↔T6.
- **No placeholders:** every code step shows complete code; commands have expected output.
