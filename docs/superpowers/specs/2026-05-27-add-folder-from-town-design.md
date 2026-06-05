# CodeTown Town — Add Folder From Town Design

**Date:** 2026-05-27
**Status:** Approved (co-shaped via brainstorming; see Decisions Locked)
**Branch:** `feature/add-folder-from-town` (to be created from `main`)

## Goal

Let the user **raise a building for a folder that has no activity yet**, directly
from the town view, so a brand-new project can be opened and worked in from the
hotel without first running an agent in it.

Today buildings appear *only* reactively: a building is created lazily when a hook
reports file activity for a project (`ProjectRegistry.getOrCreate` on the first
event). A folder where no agent has ever worked is invisible — the town's empty
state literally says *"run Claude/Cursor in a repo to raise a building."* This
blocks the natural flow "I want to start fresh work in project X from the hotel":
the spawn form (`SpawnPanel`) only opens *inside* an existing building, so its
working directory is implicit and there is no way to designate a new one.

## Decisions Locked

Chosen interactively with the user; the rest follows from them.

1. **What "add a folder" does:** *raise a persistent empty building*. Adding a
   folder creates a building that stays in the town even with zero activity. The
   user enters it whenever they want and spawns agents from inside via the
   existing flow. (Not "add → immediately spawn", not "bookmarks list".)
2. **Folder designation:** *server-served directory browser*. A mini file
   explorer, fed by a server endpoint, starting at the home directory; the user
   clicks down into the tree and confirms a folder. (A web page cannot read the
   filesystem, so the listing endpoint is mandatory regardless.)
3. **Removal in v1:** *yes — add **and** remove*. A pinned building can be removed
   from the town.
4. **Removal with live agents:** *confirmation modal "kill them? yes/no"*. Not a
   silent refusal and not a silent kill — the user decides.
5. **Dotfiles:** *hidden in the browser*. We are picking a project directory, so
   hidden directories are noise; they are filtered out.
6. **Ownership of the project list:** *server-authoritative*. The server owns the
   pinned-project list, persists it to the existing `~/.codetown/state.json`, and
   restores it at boot. (Not client `localStorage`.)

## Approach

**Server-authoritative (chosen).** The server owns pinned projects, persists them
in `~/.codetown/state.json` (the file already exists for agent state), and restores
them at boot via `registry.getOrCreate`. The directory browser is a server
endpoint. Single source of truth: `graph`, `hot-folders`, and `spawn` already
resolve everything off `projectId`/`projectRoot` held by the registry, so a pinned
building is a first-class project the moment it is created.

**Rejected — client-only list (`localStorage`).** Pinned buildings would be
per-browser, would not survive across clients, and the directory-listing endpoint
would still be required (browsers cannot read the FS) — so it splits the source of
truth for zero gain.

## Architecture Overview

```
TownView "+" ──► FolderBrowser (modal) ──GET /api/fs/list?path=──► server (list subdirs)
                       │
                       └─ "Add here" ──POST /api/projects {path}──► server
                                                                     │ deriveProjectFromDir
                                                                     │ registry.getOrCreate + pinned=true
                                                                     │ persist pinnedProjects → state.json
                                                                     ▼
                                              useProjects poll /api/projects ──► new building drawn

TownView ✕ (on pinned building hover)
   agentCount===0 ──DELETE /api/projects/:id──────────────► unpin + registry.remove
   agentCount>0   ──confirm modal "kill? y/n"──► yes ──DELETE /api/projects/:id?kill=true──►
                                                          killAgent() each agent in project, then remove
```

## Server

### `project-identity.ts` — `deriveProjectFromDir(absDir)`

New sibling of `deriveProjectFromPath`. The existing function takes a **file** path
and resolves the git root of its *parent* (`path.dirname`); the user picks a
**directory**, so it needs its own entry point. Both share `gitRootOf` and
`NON_PROJECT_ROOTS` — the git-root resolution knowledge is not duplicated.

```ts
export function deriveProjectFromDir(absDir: string): ProjectFields | undefined {
  if (!path.isAbsolute(absDir)) return undefined;
  if (NON_PROJECT_ROOTS.some(r => absDir === r || absDir.startsWith(r + path.sep))) return undefined;
  const root = gitRootOf(absDir);   // git toplevel, or absDir itself when not a repo
  return { projectId: root, projectRoot: root, projectName: path.basename(root) };
}
```

Non-git folders work because `gitRootOf` falls back to the directory itself. A
sub-directory of a repo resolves to the repo root — consistent with auto-detection.

### `GET /api/fs/list?path=<abs>`

Returns the immediate **sub-directories** of `path`, for the browser to descend.

- `path` defaults to `os.homedir()`; a relative or non-existent path → 400.
- Reads entries with `withFileTypes`, keeps directories only, **drops dotfiles**
  (names starting with `.`), drops entries that error on `stat` (permission).
- Response: `{ path, parent, entries: [{ name, path }] }` where `parent` is
  `path.dirname(path)` or `null` at filesystem root. Entries sorted by name.

This endpoint exposes directory names under the user's home tree. CodeTown is a
localhost-only dev tool (hardcoded `localhost:5174`); this is acceptable, matching
the existing posture of the server.

### `POST /api/projects { path }`

Pins a folder as a building.

1. Validate `path` is an absolute string, exists, and is a directory → else 400.
2. `deriveProjectFromDir(path)` → `undefined` (non-project root) → 400.
3. `registry.getOrCreate(projectId, projectRoot, projectName)` then set
   `pinned = true` on the workspace. **Idempotent:** if the project already exists
   (auto-detected from prior activity), this only flips `pinned` — never a
   duplicate.
4. Persist the pinned list to `state.json`; broadcast nothing special (the
   client's `useProjects` poll picks it up). Respond `200` with the `ProjectInfo`.

### `DELETE /api/projects/:id[?kill=true]`

Removes a pinned building.

- If the project has live agents (`agentCount > 0`) and `kill` is not `true` →
  **409** with `{ agents: [...] }`. This is a server-side guard so the API is not a
  footgun even if a client misbehaves; the normal client never hits it because it
  decides from `agentCount` first.
- If `kill=true`: call `killAgent(agentId)` for **every** agent whose
  `projectId === id`, then proceed.
- Unpin and `registry.remove(id)` (dispose its store watcher, delete from map).
  Persist. Respond `200`.
- A removed project that later receives activity reappears as a normal
  auto-detected building — expected, not a bug.

### `killAgent(agentId)` — extracted helper

The kill logic currently lives inline in `POST /api/agent/:agentId/stop`
(`stopAgent` + `agentStates.delete` + `refreshAgentCounts` + `saveAgentState` +
broadcast `thinking` + broadcast `agent-killed`). It is now used in two places
(the stop route and building deletion) — same knowledge, so it is extracted to a
single `killAgent(agentId): Promise<boolean>` helper that both call. Behavior is
unchanged for the existing stop route.

`killAgent` for an **external** agent (no SDK session): `stopAgent` returns false,
but the hotel character is still cleared and the death animation plays. The server
does not control the remote terminal process; if that external agent touches a
file again its character reappears. This is consistent and surprise-free.

### Types — `ProjectInfo.isPinned`

Add `isPinned: boolean` to `ProjectInfo` (server `types.ts`, mirrored in client
`types.ts`). `ProjectRegistry.list()` maps it from the workspace's `pinned` flag.
The client needs it to show the ✕ on pinned buildings only.

### Registry & persistence

- `ProjectWorkspace` gains `pinned: boolean` (default `false`).
- `ProjectRegistry` gains `setPinned(projectId, value)`, `remove(projectId)`
  (calls `store.stopWatching()` then deletes), and includes `isPinned` in `list()`.
- `state.json` gains `pinnedProjects: [{ projectId, projectRoot, projectName }]`.
  Because `state.json` is a **single file**, there is **one** writer:
  `saveAgentState` is extended to serialize the combined object
  `{ savedAt, agents, pinnedProjects }` (sourced from the registry's pinned
  workspaces) — never two functions each overwriting the file. The existing 30s
  interval and the explicit save calls (pin/remove) reuse this one writer.
- At boot, `loadAgentState` is extended to also restore `pinnedProjects`:
  for each, `registry.getOrCreate(projectId, projectRoot, projectName)` +
  `setPinned(true)`. Restore is best-effort — a pinned folder that no longer
  exists on disk is skipped (logged), not fatal.

## Client

### `FolderBrowser.tsx` (new)

Pixel-art modal reusing the `SpawnPanel` palette.

- On open and on navigation, fetches `GET /api/fs/list?path=`; shows the current
  `path`, a "⬆ parent" row (disabled at root), and the sub-directory rows.
- Clicking a row descends into it. An **"Ajouter ici"** button pins the currently
  shown directory (`POST /api/projects`), then closes.
- `Escape` closes (matches `SpawnPanel`). Errors (400/permission) shown inline.

### `TownView.tsx`

- A **"+"** affordance in a corner of the town canvas opens `FolderBrowser`.
  `useProjects` already polls `/api/projects`, so the new building appears on the
  next poll — no extra client state.
- On hovering a **pinned** building (`isPinned`), a small **✕** appears
  (separate hit-test region from the building body). Clicking it:
  - `agentCount === 0` → `DELETE /api/projects/:id`.
  - `agentCount > 0` → show a **confirm modal** ("`N` agents tournent ici — les
    tuer ?", Oui / Non), styled like `InteractionModal`. *Oui* →
    `DELETE /api/projects/:id?kill=true`. *Non* → cancel.
- Building body click (drill-in) and ✕ click must not conflict: the ✕ hit-test is
  checked first and consumes the click.

### Placement sketch

```
┌──────────────────────────────────────────────┐
│                                          [ + ] │  ← opens FolderBrowser
│   ┌────┐      ┌────┐                           │
│   │ 🏢 │      │ 🏢✕│  ← ✕ on hover (pinned only)│
│   │auto│      │pin │                           │
│   └────┘      └────┘                           │
│════════════════ street ════════════════════════│
└──────────────────────────────────────────────┘
```

## Data Flow

1. **Add:** "+" → `FolderBrowser` lists dirs via `/api/fs/list` → "Ajouter ici" →
   `POST /api/projects {path}` → registry pins + persists → `useProjects` poll →
   building drawn.
2. **Remove (no agents):** ✕ → `DELETE /api/projects/:id` → registry removes +
   persists → poll → building gone.
3. **Remove (live agents):** ✕ → confirm modal → Oui → `DELETE …?kill=true` →
   each agent killed (`killAgent`) → registry removes + persists → poll → gone.
4. **Restart:** boot → restore `pinnedProjects` → `getOrCreate` + `setPinned` →
   pinned buildings present before any activity.

## Error Handling

| Case | Behavior |
|---|---|
| `path` missing / relative / not a directory | `POST` & `/api/fs/list` → 400, inline message |
| `path` is a `NON_PROJECT_ROOT` (e.g. `~/.claude`) | `POST` → 400 (`deriveProjectFromDir` → undefined) |
| Pin an already-tracked project | Idempotent: flip `pinned=true`, no duplicate |
| `DELETE` with live agents, no `kill` | 409 `{ agents }` (server guard; client pre-empts via modal) |
| Kill an external agent (no SDK session) | Character cleared + death animation; no remote process killed |
| Restore a pinned folder that was deleted on disk | Skipped at boot, logged, non-fatal |
| Permission error reading a directory | Entry skipped in `/api/fs/list` |

## Testing

**Server**
- `deriveProjectFromDir`: git repo → repo root; sub-dir of repo → repo root;
  non-git dir → dir itself; `NON_PROJECT_ROOTS` → undefined; relative → undefined.
- `POST /api/projects`: pins + appears in `list()` with `isPinned`; idempotent on
  an existing project (no duplicate, flag flips); validation 400s.
- `DELETE /api/projects/:id`: removes when no agents; 409 when agents and no
  `kill`; with `kill=true` calls `killAgent` for each project agent then removes.
- `killAgent` extraction: existing stop route behavior unchanged (regression).
- Persistence round-trip: pin → serialize → reload → building restored.
- `GET /api/fs/list`: returns sub-directories only, drops dotfiles, exposes
  `parent`, defaults to home, 400 on bad path.

**Client**
- `FolderBrowser`: renders entries, descends on click, "Ajouter ici" POSTs the
  current path, parent navigation, Escape closes.
- `TownView` hit-test: ✕ shown for pinned only; ✕ click vs body click resolution;
  modal shown when `agentCount > 0`, direct delete when `0`.

## Out of Scope (YAGNI)

- Renaming a building / custom display names.
- Reordering / manual layout of buildings in the town.
- A text-path input or native file dialog (browser-only directory picker chosen).
- Removing **auto-detected** (non-pinned) buildings — they reflect live reality and
  reappear on activity; only pinned buildings get the ✕.
- Showing hidden (dotfile) directories in the browser.
