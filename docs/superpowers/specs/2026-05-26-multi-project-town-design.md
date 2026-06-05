# CodeTown Town — Multi-Project Support Design

**Date:** 2026-05-26
**Status:** Approved-by-goal (co-shaped via interactive decisions; see Decisions Locked)
**Branch:** `feature/multi-project-town`

## Goal

Add multi-project support where **each project is its own building**, forming a tiny
"town" of projects in a single view. Today CodeTown is single-project end-to-end:
the server boots with a fixed `PROJECT_ROOT`, hooks send absolute paths with no
project identity, and the client renders one building (the hotel) with all global
state (`floorsRef`, `filePositionsRef`, `layoutRef`, floor-nav, camera) assuming a
single building.

## Decisions Locked

These were chosen interactively with the user; the rest follows from them.

1. **Server lifecycle:** *auto-started on first hook event*. The server is
   independent of any project and is bootstrapped by the first hook that finds
   port 5174 down.
2. **Project identity:** *git root with cwd fallback*. `projectId =
   git -C "$cwd" rev-parse --show-toplevel`, falling back to `cwd` for non-git
   projects. `projectName = basename(projectId)`. One repo = one building.
3. **Town UX:** *town overview + drill-in*. A zoomed-out town view shows every
   project as a building facade; clicking a building enters it and reuses the
   existing interior (floors/rooms/agents) rendering. A "← Town" control exits.
4. **State persistence (recommendation, locked):** a single **central** state
   file (`~/.codetown/state.json`), agents tagged with `projectId` — replacing the
   per-project `.codetown-state.json` written into each user repo today.
5. **Delivery (recommendation, locked):** **two phases** — P1 server-side
   multi-project (data layer, shippable on its own), then P2 client-side
   multi-building (the town). P1 keeps a single-building client working against a
   selected project.

## Architecture Overview

Single aggregating server. Ports are hardcoded (5173/5174) and the town must fit
in one view, so one server / one feed is the only viable model. The server no
longer holds a single `PROJECT_ROOT`; it **discovers projects** from incoming
hook events, each tagged with a `projectId`.

```
Agent (project A) ─┐
Agent (project B) ─┼─► hooks (compute projectId = git root) ─► single server :5174
Agent (project C) ─┘                                            │ ProjectRegistry
                                                                │  A → {root,name,store,git}
                                                                │  B → {...}
                                                                ▼
                                       WebSocket (messages tagged projectId)
                                                                ▼
                            client: Map<projectId, BuildingState> → town view
```

## Component Design

### Hooks (`hooks/*.sh`)

- Both hooks compute project identity:
  - `cwd` from JSON (Claude `.cwd`; Cursor `.workspace_roots[0]`), fallback to the
    directory of `tool_input.file_path`.
  - `projectId = git -C "$cwd" rev-parse --show-toplevel` (fallback `cwd`).
  - `projectName = basename(projectId)`.
- Every POST payload to `/api/activity` and `/api/thinking` gains `projectId`,
  `projectRoot`, `projectName`. The hook stays "dumb": it sends the **absolute**
  file path; the server relativizes per project.
- **Auto-start:** before emitting, the hook checks whether `:5174` answers; if
  not, it launches the server detached (`nohup`), guarded by a `flock` lockfile
  (single concurrent launcher at cold start), then briefly polls `/api/health`.
  Extracted into a shared helper (`hooks/lib/ensure-server.sh`) used by both hooks.

### Server (`server/src/`)

- **`ProjectRegistry`** (new module): `Map<projectId, ProjectWorkspace>`. Each
  `ProjectWorkspace` owns its own `ActivityStore`, git cache, `root`, `name`, and
  `lastActivity`. Replaces the single `activityStore` + `PROJECT_ROOT`.
- `toRelativePath` becomes **per-project** (uses the workspace's `projectRoot`).
- `AgentThinkingState` gains a `projectId` field (an agent belongs to a building).
- **Endpoints become project-aware:**
  - New `GET /api/projects` → list of buildings with metadata + activity summary.
  - `GET /api/graph` and `GET /api/hot-folders` accept `?projectId=`.
  - WebSocket messages (`activity`, `graph`, `thinking`, `layout-update`) carry
    `projectId`.
- **State persistence:** single central `~/.codetown/state.json`, agents tagged
  with `projectId`. Removes pollution of user repos.
- Project lifecycle: a workspace persists while known; the registry tracks
  `lastActivity` so the client can dim idle buildings.

### Client (`client/src/`)

- **Data model:** `useFileActivity` demultiplexes by `projectId` into
  `Map<projectId, BuildingState>`. Each `BuildingState` holds what is global today
  (`graphData`, `floors`, `filePositions`, floor-nav state, building's agents).
- **Two-level navigation** (`useTownNavigation`, composing the existing
  `useFloorNavigation` per building):
  - **Town view:** each project rendered as a building facade on a street. Height
    ∝ floor count, lit windows ∝ active agents, sign = project name. Deterministic
    layout (sorted by activity then name, wrapping into rows — mirrors room layout).
  - **Building view:** click enters a building → existing interior rendering reused
    verbatim (`buildFloorsByDepth`), fed by the selected `BuildingState`. "← Town"
    exits.
- **Refactor:** the current `HabboRoom` is split so the building **interior**
  becomes a render unit parameterized by `BuildingState` (no global refs), and a
  new `TownView` orchestrates town ↔ building. `filePositions`/`agentFloors`
  lookups are scoped to the current building.

### Setup (`bin/setup.js`)

- No longer starts the server (auto-start by hook). Still writes per-project hooks
  (`.claude/settings.local.json`, `.cursor/hooks.json`) and the git hook. Optional
  `serve` command retained to start/keep the server warm manually.

## Backward Compatibility & Edge Cases

- **Single project:** the town shows one building; optionally auto-enter it to
  reproduce today's experience.
- **Idle project:** the building persists while the server knows it, dimming when
  no recent activity (consistent with the agent grace period).
- **Floor collisions:** resolved natively — floor depths are now scoped per
  building, eliminating the global collision risk.
- **Pre-existing setups:** projects configured before this feature still work; the
  hook derives identity at runtime from `cwd`/file path, so no re-setup required
  for identity (auto-start helper does require updated hooks).

## Testing

- **Server:** `ProjectRegistry` (projectId routing, per-project relativization,
  store isolation), project-aware endpoints, simulated auto-start/lock behavior.
- **Client:** demultiplexing by projectId, town layout determinism, town↔building
  switching, per-building scoping of positions/floors.
- Existing suites preserved and adapted to the per-project scoping.

## Phasing

- **P1 — Server multi-project (data layer):** hooks carry identity + auto-start;
  `ProjectRegistry`; per-project stores/relativization; project-aware
  endpoints/WebSocket; central state. Single-building client still works against a
  selected project. Shippable independently.
- **P2 — Client multi-building (the town):** demultiplexed `BuildingState`;
  `TownView` + two-level navigation; building-facade rendering; interior reuse.

## Implementation Refinements (discovered during build)

1. **Hooks are installed GLOBALLY** in `~/.claude/settings.json`, not per-project.
   Per-project setup let different projects point at different CodeTown installs
   (e.g. an npx-cached copy with old scripts), so events arrived without
   `projectId` and all agents fell into the server's own building. Global hooks
   give one canonical hook-script source: every project Claude Code runs in
   automatically becomes a building, with no per-project setup and no drift.
   `bin/setup.js` merges additively into the global config (preserving other
   hooks/permissions) and backs it up first. (Cursor hooks remain per-project —
   no global Cursor hook mechanism; the backstop below covers them.)

2. **Server-side identity backstop.** When an activity event arrives without
   `projectId` (old/foreign hook), the server derives the building from the
   event's absolute file path via `git rev-parse --show-toplevel` (cached per
   directory). Thinking events without `projectId` never clobber an agent's
   already-known building. This makes the town correct regardless of which hook
   version a project runs.

## Out of Scope (YAGNI)

- Per-building independent camera control (one town camera + one interior camera).
- Cross-building agent travel animations.
- Subscribing to a subset of projects (all projects multiplexed over one feed).
- Renaming/customizing building identity beyond the git-root default.
