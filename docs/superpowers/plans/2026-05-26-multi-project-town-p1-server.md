# Multi-Project Town — Phase 1 (Server + Hooks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CodeTown server discover and track multiple projects (one "building" each), with hooks carrying project identity and auto-starting the server.

**Architecture:** A single aggregating server keyed by `projectId` (git root). A new `ProjectRegistry` maps `projectId → ProjectWorkspace`, each owning its own `ActivityStore` + git cache (both already project-parameterized). Hooks compute `projectId` from `cwd` and tag every event; they also auto-start the server via a `flock`-guarded helper. WebSocket messages and HTTP endpoints become project-aware. Agent state persists centrally in `~/.codetown/state.json`.

**Tech Stack:** Node + TypeScript (ESM), Express, `ws`, Vitest. Bash hooks with `jq`/`curl`/`flock`.

**Spec:** `docs/superpowers/specs/2026-05-26-multi-project-town-design.md`

---

## File Structure

- **Modify** `server/src/types.ts` — add `projectId`/`projectRoot`/`projectName` to events; `projectId` to `AgentThinkingState`; new `ProjectInfo` type.
- **Create** `server/src/project-registry.ts` — `ProjectRegistry` class + `ProjectWorkspace`.
- **Create** `server/src/project-registry.test.ts` — registry tests.
- **Modify** `server/src/index.ts` — replace single `PROJECT_ROOT`/`activityStore` with the registry; project-aware endpoints; central state; tag broadcasts.
- **Modify** `server/src/index.test.ts` — adapt/extend for project routing.
- **Modify** `server/src/websocket.ts` — allow a `projectId` field on broadcast messages.
- **Create** `hooks/lib/project-id.sh` — shared project-identity resolver (sourced by both hooks).
- **Create** `hooks/lib/ensure-server.sh` — `flock`-guarded auto-start helper.
- **Modify** `hooks/file-activity-hook.sh` and `hooks/thinking-hook.sh` — source the helpers, add project fields, ensure server.
- **Modify** `client/src/types.ts` — mirror the new event/state fields (client keeps its own copy).

---

### Task 1: Event & state types carry project identity

**Files:**
- Modify: `server/src/types.ts`
- Modify: `client/src/types.ts`

- [ ] **Step 1: Add project fields to server types**

In `server/src/types.ts`, add to `FileActivityEvent` (after `source`):

```typescript
  projectId?: string;     // Building identity (git root or cwd)
  projectRoot?: string;   // Absolute root path for relativization
  projectName?: string;   // basename of projectRoot, shown as building sign
```

Add the same three optional fields to `ThinkingEvent` (after `source`).

Add `projectId` to `AgentThinkingState` (after `source`):

```typescript
  projectId?: string;  // Which building/project this agent belongs to
```

Add a new exported type:

```typescript
/** A project the server is currently tracking (one building in the town) */
export interface ProjectInfo {
  projectId: string;
  projectName: string;
  projectRoot: string;
  lastActivity: number;
  agentCount: number;
}
```

- [ ] **Step 2: Mirror the fields in the client copy**

In `client/src/types.ts`, apply the identical additions (`FileActivityEvent`, `AgentThinkingState`, and the `ProjectInfo` type). Match the exact field names.

- [ ] **Step 3: Verify both projects typecheck**

Run: `cd server && npx tsc --noEmit` then `cd client && npx tsc --noEmit`
Expected: no errors (fields are optional, nothing consumes them yet).

- [ ] **Step 4: Commit**

```bash
git add server/src/types.ts client/src/types.ts
git commit -m "feat(types): add project identity to events and agent state"
```

---

### Task 2: ProjectRegistry — lazy per-project workspaces

**Files:**
- Create: `server/src/project-registry.ts`
- Test: `server/src/project-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/project-registry.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { ProjectRegistry } from './project-registry.js';

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetown-proj-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  return dir;
}

describe('ProjectRegistry', () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true }));
    dirs.length = 0;
  });

  it('creates a workspace on first access and reuses it', () => {
    const root = makeProjectDir(); dirs.push(root);
    const reg = new ProjectRegistry();
    const w1 = reg.getOrCreate('id-1', root, 'proj');
    const w2 = reg.getOrCreate('id-1', root, 'proj');
    expect(w1).toBe(w2);
    expect(reg.list().map(p => p.projectId)).toEqual(['id-1']);
    reg.dispose();
  });

  it('isolates stores between projects', () => {
    const rootA = makeProjectDir(); dirs.push(rootA);
    const rootB = makeProjectDir(); dirs.push(rootB);
    const reg = new ProjectRegistry();
    const a = reg.getOrCreate('A', rootA, 'a');
    const b = reg.getOrCreate('B', rootB, 'b');
    expect(a.store).not.toBe(b.store);
    expect(a.store.getProjectRoot()).toBe(rootA);
    expect(b.store.getProjectRoot()).toBe(rootB);
    reg.dispose();
  });

  it('relativizes an absolute path against the right project', () => {
    const root = makeProjectDir(); dirs.push(root);
    const reg = new ProjectRegistry();
    reg.getOrCreate('id-1', root, 'proj');
    expect(reg.toRelativePath('id-1', path.join(root, 'a.txt'))).toBe('a.txt');
    expect(reg.toRelativePath('id-1', root)).toBe('.');
    reg.dispose();
  });

  it('reports list() with lastActivity and agentCount', () => {
    const root = makeProjectDir(); dirs.push(root);
    const reg = new ProjectRegistry();
    const w = reg.getOrCreate('id-1', root, 'proj');
    w.lastActivity = 1234;
    const info = reg.list();
    expect(info[0]).toMatchObject({ projectId: 'id-1', projectName: 'proj', projectRoot: root, lastActivity: 1234 });
    reg.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/project-registry.test.ts`
Expected: FAIL — cannot find module `./project-registry.js`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/project-registry.ts`:

```typescript
import path from 'path';
import { ActivityStore } from './activity-store.js';
import { ProjectInfo } from './types.js';

export interface ProjectWorkspace {
  projectId: string;
  projectName: string;
  projectRoot: string;
  store: ActivityStore;
  lastActivity: number;
  agentCount: number;
}

/**
 * Tracks every project the server has seen (one building per project).
 * Workspaces are created lazily on first event and reused thereafter.
 */
export class ProjectRegistry {
  private workspaces = new Map<string, ProjectWorkspace>();
  private graphChangeCallback: ((projectId: string, data: ReturnType<ActivityStore['getGraphData']>) => void) | null = null;

  onGraphChange(cb: (projectId: string, data: ReturnType<ActivityStore['getGraphData']>) => void): void {
    this.graphChangeCallback = cb;
  }

  getOrCreate(projectId: string, projectRoot: string, projectName: string): ProjectWorkspace {
    let w = this.workspaces.get(projectId);
    if (w) return w;
    const store = new ActivityStore(projectRoot);
    store.onGraphChange((data) => this.graphChangeCallback?.(projectId, data));
    w = { projectId, projectName, projectRoot, store, lastActivity: Date.now(), agentCount: 0 };
    this.workspaces.set(projectId, w);
    return w;
  }

  get(projectId: string): ProjectWorkspace | undefined {
    return this.workspaces.get(projectId);
  }

  toRelativePath(projectId: string, absolutePath: string): string {
    const w = this.workspaces.get(projectId);
    if (!w) return absolutePath;
    if (absolutePath === w.projectRoot) return '.';
    const prefix = w.projectRoot + '/';
    if (absolutePath.startsWith(prefix)) return absolutePath.slice(prefix.length) || '.';
    return absolutePath;
  }

  list(): ProjectInfo[] {
    return Array.from(this.workspaces.values()).map(w => ({
      projectId: w.projectId,
      projectName: w.projectName,
      projectRoot: w.projectRoot,
      lastActivity: w.lastActivity,
      agentCount: w.agentCount,
    }));
  }

  dispose(): void {
    for (const w of this.workspaces.values()) w.store.stopWatching();
    this.workspaces.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/project-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/project-registry.ts server/src/project-registry.test.ts
git commit -m "feat(server): add ProjectRegistry for per-project workspaces"
```

---

### Task 3: Hook helpers — project identity + auto-start

**Files:**
- Create: `hooks/lib/project-id.sh`
- Create: `hooks/lib/ensure-server.sh`

- [ ] **Step 1: Write the project-identity resolver**

Create `hooks/lib/project-id.sh`:

```bash
#!/bin/bash
# Resolves project identity from a hook's stdin JSON (already captured in $INPUT).
# Sets: PROJECT_ROOT, PROJECT_ID, PROJECT_NAME.
# Identity = git toplevel of cwd, falling back to cwd (or the file's dir).

resolve_project_identity() {
  local input="$1"
  local cwd file_path base_dir

  cwd=$(echo "$input" | /usr/bin/jq -r '.cwd // .workspace_roots[0] // empty' 2>/dev/null)

  if [ -z "$cwd" ]; then
    file_path=$(echo "$input" | /usr/bin/jq -r '.tool_input.file_path // .file_path // empty' 2>/dev/null)
    if [ -n "$file_path" ]; then
      base_dir=$(dirname "$file_path")
    fi
  fi

  base_dir="${cwd:-$base_dir}"
  base_dir="${base_dir:-$PWD}"

  PROJECT_ROOT=$(git -C "$base_dir" rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$PROJECT_ROOT" ]; then
    PROJECT_ROOT="$base_dir"
  fi
  PROJECT_ID="$PROJECT_ROOT"
  PROJECT_NAME=$(basename "$PROJECT_ROOT")
}
```

- [ ] **Step 2: Write the auto-start helper**

Create `hooks/lib/ensure-server.sh`:

```bash
#!/bin/bash
# Ensures the CodeTown server is running on :5174.
# If not, launches `npm run dev` detached, guarded by flock so only one
# hook wins the cold-start race. Best-effort: never blocks the agent.

ensure_codetown_server() {
  local codetown_root="$1"   # absolute path to the codetown repo (contains package.json)
  local health="http://localhost:5174/api/health"
  local lock="/tmp/codetown-server.lock"

  if /usr/bin/curl -s --connect-timeout 1 --max-time 1 "$health" >/dev/null 2>&1; then
    return 0
  fi

  (
    flock -n 9 || exit 0   # another hook is already starting it
    if /usr/bin/curl -s --connect-timeout 1 --max-time 1 "$health" >/dev/null 2>&1; then
      exit 0
    fi
    nohup npm --prefix "$codetown_root" run dev >/tmp/codetown-server.log 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.5
      /usr/bin/curl -s --connect-timeout 1 --max-time 1 "$health" >/dev/null 2>&1 && break
    done
  ) 9>"$lock"
}
```

- [ ] **Step 3: Make helpers executable and sanity-check syntax**

Run:
```bash
chmod +x hooks/lib/project-id.sh hooks/lib/ensure-server.sh
bash -n hooks/lib/project-id.sh && bash -n hooks/lib/ensure-server.sh && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Manually verify identity resolution against this repo**

Run:
```bash
INPUT='{"cwd":"'"$PWD"'/server","session_id":"x"}'
source hooks/lib/project-id.sh; resolve_project_identity "$INPUT"
echo "$PROJECT_ID | $PROJECT_NAME"
```
Expected: `<repo root> | codetown` (git toplevel of the `server/` subdir is the repo root).

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/project-id.sh hooks/lib/ensure-server.sh
git commit -m "feat(hooks): add project-identity and server auto-start helpers"
```

---

### Task 4: Hooks send project fields and ensure the server

**Files:**
- Modify: `hooks/file-activity-hook.sh`
- Modify: `hooks/thinking-hook.sh`

- [ ] **Step 1: Wire helpers into `file-activity-hook.sh`**

After `INPUT=$(cat)` and the `AGENT_ID` guard, insert (use the script's own dir to locate libs and the codetown root):

```bash
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODETOWN_ROOT="$(dirname "$HOOK_DIR")"
source "$HOOK_DIR/lib/project-id.sh"
source "$HOOK_DIR/lib/ensure-server.sh"
resolve_project_identity "$INPUT"
ensure_codetown_server "$CODETOWN_ROOT"
```

Then add the project fields to BOTH JSON payloads (the `/api/activity` POST and the `/api/thinking` POST) by appending before the closing `}`:

```bash
,"projectId":"$PROJECT_ID","projectRoot":"$PROJECT_ROOT","projectName":"$PROJECT_NAME"
```

For the activity POST, the body becomes:
```bash
-d "{\"type\":\"$EVENT_TYPE\",\"filePath\":\"$FILE_PATH\",\"agentId\":\"$AGENT_ID\",\"source\":\"$SOURCE\",\"timestamp\":$(date +%s000),\"projectId\":\"$PROJECT_ID\",\"projectRoot\":\"$PROJECT_ROOT\",\"projectName\":\"$PROJECT_NAME\"}" \
```

Apply the same `projectId`/`projectRoot`/`projectName` trailer to the thinking POST in this file.

- [ ] **Step 2: Wire helpers into `thinking-hook.sh`**

Insert the identical helper block (after the `AGENT_ID` guard). In the payload builder, after the base-fields line, add:

```bash
JSON_PAYLOAD="$JSON_PAYLOAD,\"projectId\":\"$PROJECT_ID\",\"projectRoot\":\"$PROJECT_ROOT\",\"projectName\":\"$PROJECT_NAME\""
```

Also add the same trailer to the search-activity POST near the end of the file (the `/api/activity` call for Grep/Glob).

- [ ] **Step 3: Syntax check both hooks**

Run: `bash -n hooks/file-activity-hook.sh && bash -n hooks/thinking-hook.sh && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add hooks/file-activity-hook.sh hooks/thinking-hook.sh
git commit -m "feat(hooks): tag events with project identity and auto-start server"
```

---

### Task 5: Route activity/thinking through the registry

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Replace single-project wiring with the registry**

In `server/src/index.ts`, remove the single `activityStore` and `toRelativePath` (lines ~29-53) and replace with:

```typescript
import { ProjectRegistry } from './project-registry.js';

const registry = new ProjectRegistry();
registry.onGraphChange((projectId, graphData) => {
  wsManager.broadcast('graph', graphData, projectId);
});

// Fallback identity for events that arrive without project fields (old hooks).
const FALLBACK_PROJECT_ID = detectProjectRoot();
function projectFieldsOf(body: { projectId?: string; projectRoot?: string; projectName?: string }) {
  const projectRoot = body.projectRoot || FALLBACK_PROJECT_ID;
  const projectId = body.projectId || projectRoot;
  const projectName = body.projectName || path.basename(projectRoot);
  return { projectId, projectRoot, projectName };
}
```

Keep `detectProjectRoot()` (it now only provides the fallback). Delete the old module-level `PROJECT_ROOT`, `toRelativePath`, and `activityStore` declarations and the `activityStore.onGraphChange` block.

- [ ] **Step 2: Update `POST /api/activity` to use the registry**

Replace the body of `app.post('/api/activity', ...)` graph/relativize logic with:

```typescript
  const { projectId, projectRoot, projectName } = projectFieldsOf(event);
  const ws = registry.getOrCreate(projectId, projectRoot, projectName);
  ws.lastActivity = Date.now();

  if (event.agentId) {
    const now = Date.now();
    const state = registerAgent(event.agentId, now, 'activity', event.source || 'unknown');
    if (state) {
      state.lastActivity = now;
      state.projectId = projectId;
      if (event.type.endsWith('-start')) {
        state.currentCommand = event.type.startsWith('read') ? 'Read' :
                               event.type.startsWith('write') ? 'Write' : 'Grep';
        state.isThinking = true;
      } else if (event.type.endsWith('-end')) {
        state.isThinking = false;
      }
      wsManager.broadcast('thinking', getAgentStatesArray());
    }
  }

  const graphData = ws.store.addActivity(event);
  const clientEvent = { ...event, filePath: registry.toRelativePath(projectId, event.filePath) };
  wsManager.broadcast('activity', clientEvent, projectId);
  wsManager.broadcast('graph', graphData, projectId);
  res.status(200).json({ success: true });
```

- [ ] **Step 3: Update `POST /api/thinking` to tag the agent's project**

In `app.post('/api/thinking', ...)`, after `const state = registerAgent(...)` succeeds, add:

```typescript
  const { projectId } = projectFieldsOf(event);
  state.projectId = projectId;
  registry.getOrCreate(projectId, event.projectRoot || FALLBACK_PROJECT_ID, event.projectName || path.basename(event.projectRoot || FALLBACK_PROJECT_ID)).lastActivity = Date.now();
```

(`ThinkingEvent` now carries `projectId`/`projectRoot`/`projectName` from Task 1.)

- [ ] **Step 4: Update agentCount bookkeeping**

In `getAgentStatesArray()` leave as-is; in the periodic cleanup and registration, after any change to `agentStates`, recompute counts. Add a helper and call it wherever agents are added/removed:

```typescript
function refreshAgentCounts(): void {
  for (const info of registry.list()) {
    const w = registry.get(info.projectId);
    if (w) w.agentCount = 0;
  }
  for (const s of agentStates.values()) {
    if (s.projectId) {
      const w = registry.get(s.projectId);
      if (w) w.agentCount++;
    }
  }
}
```

Call `refreshAgentCounts()` at the end of both POST handlers and in the stale-agent cleanup interval.

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: errors only where `/api/graph`, `/api/hot-folders`, `/api/health`, `/api/debug`, `/api/clear`, `/api/git-commit` still reference the removed `activityStore`/`PROJECT_ROOT`. (Fixed in Task 6.) If other errors appear, resolve them.

- [ ] **Step 6: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): route activity and thinking through ProjectRegistry"
```

---

### Task 6: Project-aware endpoints + projectId on broadcasts

**Files:**
- Modify: `server/src/websocket.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Allow `projectId` on broadcast**

In `server/src/websocket.ts`, change the `broadcast` signature to accept an optional `projectId` and include it in the message:

```typescript
  broadcast(type: string, data: GraphData | FileActivityEvent | AgentThinkingState[] | LayoutUpdateData | ProjectInfo[], projectId?: string): void {
    const message = JSON.stringify(projectId === undefined ? { type, data } : { type, data, projectId });
```

Add `ProjectInfo` to the import from `./types.js`.

- [ ] **Step 2: Add `GET /api/projects`**

In `server/src/index.ts`, add:

```typescript
app.get('/api/projects', (_req, res) => {
  res.json(registry.list());
});
```

- [ ] **Step 3: Make `GET /api/graph` and `GET /api/hot-folders` project-aware**

Replace the `/api/graph` handler:

```typescript
app.get('/api/graph', (req, res) => {
  const projectId = (req.query.projectId as string) || registry.list()[0]?.projectId;
  const w = projectId ? registry.get(projectId) : undefined;
  res.json(w ? w.store.getGraphData() : { nodes: [], links: [] });
});
```

In `/api/hot-folders`, resolve the workspace first and use its root/store:

```typescript
  const projectId = (req.query.projectId as string) || registry.list()[0]?.projectId;
  const w = projectId ? registry.get(projectId) : undefined;
  if (!w) { res.json([]); return; }
  const hotFolders = await getHotFolders(w.projectRoot, limit);
  const recentlyActive = w.store.getRecentlyActiveFiles(10 * 60 * 1000);
```

(Keep the existing merge/sort logic below, unchanged.)

- [ ] **Step 4: Fix the remaining `activityStore`/`PROJECT_ROOT` references**

- `/api/health`: replace `projectRoot: PROJECT_ROOT` with `projects: registry.list().length`.
- `/api/debug`: replace `projectRoot: PROJECT_ROOT` with `projects: registry.list()`.
- `/api/clear`: clear every workspace store and broadcast per project:

```typescript
app.post('/api/clear', (_req, res) => {
  for (const info of registry.list()) {
    const w = registry.get(info.projectId)!;
    w.store.clear();
    wsManager.broadcast('graph', w.store.getGraphData(), info.projectId);
  }
  res.json({ success: true });
});
```

- `/api/git-commit`: accept an optional `projectId` in the body, resolve the workspace, `clearGitCache(w.projectRoot)`, recompute `getHotFolders(w.projectRoot, 50)`, and broadcast `layout-update` with that `projectId`.

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/websocket.ts server/src/index.ts
git commit -m "feat(server): project-aware endpoints and projectId-tagged broadcasts"
```

---

### Task 7: Central agent-state persistence

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Move state file to a central location**

Replace the `STATE_FILE` definition:

```typescript
const STATE_DIR = path.join(os.homedir(), '.codetown');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
```

Add `import os from 'os';` at the top. In `saveAgentState()`, ensure the dir exists before writing:

```typescript
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
```

Agents already carry `projectId` (Task 5), so the persisted array is project-tagged automatically. On `loadAgentState()`, restored agents keep their `projectId`; their workspace will be (re)created lazily when their next event arrives.

- [ ] **Step 2: Verify the repo no longer writes `.codetown-state.json`**

Run: `cd server && npx tsc --noEmit && echo OK`
Expected: `OK`. (The old per-repo `.codetown-state.json` path is gone.)

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): persist agent state centrally in ~/.codetown/state.json"
```

---

### Task 8: Integration test — two projects stay isolated

**Files:**
- Modify: `server/src/index.test.ts` (or add `server/src/multi-project.test.ts` if `index.test.ts` does not export the app)

- [ ] **Step 1: Inspect how the server is tested**

Run: `cd server && rg -n "supertest|createServer|app\b|listen|fetch\(" src/index.test.ts | head -30`
Expected: shows whether the test imports the Express `app` or hits a running server. If the app is not exported, export it from `index.ts` (`export { app };`) guarded so `server.listen` still runs.

- [ ] **Step 2: Write the failing isolation test**

Add `server/src/multi-project.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ProjectRegistry } from './project-registry.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('multi-project isolation', () => {
  it('keeps two projects file trees separate', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'codetown-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'codetown-b-'));
    fs.writeFileSync(path.join(a, 'only-a.ts'), '');
    fs.writeFileSync(path.join(b, 'only-b.ts'), '');
    const reg = new ProjectRegistry();
    const wa = reg.getOrCreate(a, a, path.basename(a));
    const wb = reg.getOrCreate(b, b, path.basename(b));
    const namesA = wa.store.getGraphData().nodes.map(n => n.name);
    const namesB = wb.store.getGraphData().nodes.map(n => n.name);
    expect(namesA).toContain('only-a.ts');
    expect(namesA).not.toContain('only-b.ts');
    expect(namesB).toContain('only-b.ts');
    reg.dispose();
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd server && npx vitest run src/multi-project.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npm test`
Expected: all tests pass (adapt any that referenced the removed `PROJECT_ROOT`/`toRelativePath`/single `activityStore`; update them to use the registry).

- [ ] **Step 5: Commit**

```bash
git add server/src
git commit -m "test(server): multi-project isolation + suite adapted to registry"
```

---

### Task 9: Manual end-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Cold-start via a hook**

With the server NOT running, in a second git repo run a Claude/Cursor action that triggers a Read. Confirm:
```bash
curl -s http://localhost:5174/api/health | jq
curl -s http://localhost:5174/api/projects | jq
```
Expected: health OK; `/api/projects` lists at least the project you acted in.

- [ ] **Step 2: Two projects appear as two entries**

Trigger activity in a second repo. `curl -s http://localhost:5174/api/projects | jq 'length'` → `2`.

- [ ] **Step 3: Confirm no per-repo state file is written**

Run: `ls .codetown-state.json 2>/dev/null && echo "LEAK" || echo "clean"; ls ~/.codetown/state.json`
Expected: `clean`, and the central file exists.

---

## Self-Review

- **Spec coverage:** §2 hooks → Tasks 3–4. §3 server (ProjectRegistry, per-project relativize, projectId on agents, project-aware endpoints, central state) → Tasks 2, 5, 6, 7. WebSocket projectId → Task 6. §6 backward-compat (old events) → `projectFieldsOf` fallback in Task 5. §7 testing → Tasks 2, 8. Client rendering (§4) is **out of scope for P1** (P2). Setup §5 change (server no longer auto-started by setup.js) is deferred to P2 since auto-start by hook (Task 3–4) already covers the runtime path; setup.js still works.
- **Placeholders:** none — every code step shows full content.
- **Type consistency:** `projectId`/`projectRoot`/`projectName` used identically across types, hooks payloads, `projectFieldsOf`, registry, and broadcasts. `ProjectInfo` shape matches `registry.list()`.

## Notes for P2 (next plan)

P2 will: demultiplex the WebSocket feed by `projectId` into `Map<projectId, BuildingState>`; add `useTownNavigation`; render building facades + town↔building drill-in; reuse `buildFloorsByDepth` per building; update `bin/setup.js` messaging (no server co-launch). Written as its own plan once P1 is verified.
