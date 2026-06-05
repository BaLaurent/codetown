# 🏨 CodeTown

**Watch your AI coding agents come to life — and talk back to them.** See Claude Code and Cursor as pixel-art characters living in a hotel: walking between rooms, working at desks, reading and writing files in real-time. Then open a terminal, chat with an agent, answer its permission prompts, or spawn a new one — all from the same town.

![CodeTown Demo](docs/demo.gif)

> **CodeTown is a fork of [JamsusMaximus/codemap](https://github.com/JamsusMaximus/codemap)** that grew into its own project. It keeps the original's beautiful real-time hotel visualization and adds a full interactive layer on top: live terminals, two-way agent chat, an interactive permission/plan flow, a multi-project "town", and configurable sound. See [Origin & divergences](#-origin--divergences) for the full story.

---

## ⚡ One Command Setup

Paste this into Claude Code or Cursor in any project:

```bash
npx github:BaLaurent/codetown
```

That's it — the hotel opens automatically and your agent appears. ✨

---

## ✨ Features

### 🎬 Live visualization (from the original)

| Feature | Description |
|---------|-------------|
| 🎮 **Live agents** | Watch agents move between rooms as they work on your code |
| 🏢 **Smart layout** | Folders become rooms, files become desks, arranged by git activity |
| 👥 **Multi-agent** | Several agents working simultaneously, each with its own character |
| 💬 **Speech bubbles** | See which tool and file each agent is working on |
| 🦘 **Stuck detection** | Agents bounce when they're waiting for input — spot a blocked agent instantly |
| 🎨 **Themed rooms** | Components (blue), Server (green), Tests (peach), and more |
| 🔄 **Dynamic refresh** | The hotel reorganizes on each git commit |

### 🚀 Added by CodeTown

| Feature | Description |
|---------|-------------|
| 🏘️ **Multi-project town** | Each project becomes its own building. Add or remove folders and walk the whole town |
| 💻 **Built-in terminals** | Spawn real TTY terminals docked at the bottom of the screen — no context switch |
| 🗨️ **Two-way agent chat** | Talk to in-process SDK agents right from the hotel: read their transcript, reply, follow their thinking live |
| 🙋 **Interactive permissions & plans** | Answer an agent's `AskUserQuestion`, approve/deny a tool call, or review an `ExitPlanMode` plan (full markdown) from the UI — the answer is fed straight back to the agent |
| ✨ **Spawn agents from the town** | Launch a new agent and pick its model, permission mode, and subagent type before it starts |
| 🧰 **Dockable panels** | Dock terminals and chats at the bottom; the map shrinks to make room. Per-panel colors, collapse, mute |
| 🔊 **Configurable sound** | Separate read / write / notification channels, mutable from the settings modal |

### 🤖 Works with

- ✅ **Claude Code** — full support, automatic hook configuration
- ✅ **Cursor** — model name, completion badges, operation timing

---

## 🎯 What You'll See

- 💻 **Computer screens** light up when files are accessed
- 🟡 **Yellow glow** = reading a file
- 🟢 **Green glow** = writing code
- 💭 **Thinking indicator** when an agent is processing
- 🚶 **Walking animations** as agents move between rooms
- 🦘 **Bouncing** when an agent needs your input or permission
- ☕ **Coffee shop** where idle agents hang out

---

## 🛠 Alternative Setup

### Clone and run locally

```bash
git clone https://github.com/BaLaurent/codetown
cd codetown
npm install
npm run dev
```

Then open http://localhost:5173/hotel

### Setup hooks only (no server start)

```bash
npx github:BaLaurent/codetown setup
```

---

## 📖 How It Works

```
🤖 AI Agent      →  📡 Hooks      →  🖥 Server      →  🎨 Browser
(Claude/Cursor)     (capture)       (broadcast)       (render)
```

1. Your AI agent reads/writes files, runs commands, or asks for permission
2. Hook scripts capture these events (and pause on questions/permissions)
3. The server tracks activity, manages spawned agents, and broadcasts via WebSocket
4. The browser renders the pixel-art town in real-time — and sends your replies back

---

## 🔧 Technical Details

<details>
<summary>Server API (Port 5174)</summary>

**Visualization**
- `POST /api/activity` — file read/write events
- `POST /api/thinking` — agent thinking state
- `GET /api/graph` — file tree data
- `GET /api/hot-folders` — git-ranked folders

**Agents & interaction**
- `POST /api/agent/spawn` — spawn an in-process SDK agent (model / mode / subagent)
- `POST /api/agent/:id/message`, `GET /api/agent/:id/transcript` — two-way chat
- `POST /api/agent/:id/permission-request` + `GET /pending-permission` + `POST /permission` — interactive permission / question / plan flow
- `POST /api/agent/:id/{mode,effort,model,stop}` — live agent controls

**Town & terminals**
- `GET /POST /api/projects` — multi-project buildings
- `POST /api/tty/spawn`, `GET /api/tty` — dockable terminals

WebSocket at `/ws` for real-time updates.

</details>

<details>
<summary>Client Routes (Port 5173)</summary>

- `/hotel` — pixel-art hotel / town visualization
- `/` — force-directed graph view

</details>

<details>
<summary>Hook Scripts</summary>

- `file-activity-hook.sh` — captures file operations
- `thinking-hook.sh` — captures agent state, model, duration
- `permission-hook.sh` — pauses on permission requests, questions and plans, waits for your answer from the hotel
- `cursor-stop-hook.sh` — captures Cursor completion status
- `git-post-commit.sh` — triggers layout refresh

</details>

<details>
<summary>Troubleshooting</summary>

**Server not starting?**
```bash
lsof -i :5174  # Check if port in use
curl http://localhost:5174/api/health
```

**Hooks not firing?**
```bash
tail -f /tmp/codetown-hook.log
```

**No agents appearing?**
```bash
curl http://localhost:5174/api/thinking | jq
```

</details>

<details>
<summary>Development</summary>

```bash
npm install
npm run dev            # Start server + client
npm test --workspaces  # Run the full test suite (480+ tests)
```

</details>

---

## 🌱 Origin & Divergences

CodeTown started as a fork of **[JamsusMaximus/codemap](https://github.com/JamsusMaximus/codemap)** — all credit for the original pixel-art hotel concept, the live agent visualization, the git-based room layout and the themed-room rendering goes to that project. ❤️

It has since diverged enough to be its own thing. What the fork adds on top of the original:

- **From "watch" to "interact"** — the original is a read-only visualizer; CodeTown lets you spawn agents, chat with them, and answer their permission/plan/question prompts directly from the UI.
- **Multi-project town** — instead of one project, a whole town of buildings you can add to and walk through.
- **Built-in dockable terminals** — real TTYs docked under the map.
- **Interactive permission flow** — `AskUserQuestion`, tool approvals and `ExitPlanMode` plans surface in the hotel and feed answers back to the agent.
- **Configurable sound** — separate read/write/notification channels with mute.

Because the rename touches technical identifiers too (state dir, hook log paths, localStorage keys, package names), CodeTown is **not** drop-in compatible with an existing `codemap` install — re-run the setup for a clean install.

---

## 📄 License

MIT — built on top of [JamsusMaximus/codemap](https://github.com/JamsusMaximus/codemap), for the AI coding community.
