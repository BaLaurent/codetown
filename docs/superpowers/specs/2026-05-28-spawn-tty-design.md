# Spawn TTY — Design Spec
*2026-05-28*

## Context

L'hôtel permet déjà de spawner des agents Claude et de leur parler via un panneau chat. Il manque un accès shell rapide sans sortir de l'interface : ouvrir un terminal dans le répertoire du projet actif, directement depuis l'hôtel. Ce spec couvre l'ajout d'un bouton "Spawn TTY" et du panneau terminal associé.

---

## Décisions de design

| Question | Choix |
|---|---|
| Liste des TTYs | Section "Terminaux" dans le Roster existant (`AgentRosterPanel`) |
| Renderer | xterm.js (vrai émulateur PTY, ANSI, vim/htop compatibles) |
| Coexistence chat + TTY | Deux panneaux côte à côte (chat à droite du canvas, TTY encore à droite du chat) |
| Shell | `$SHELL` env var, fallback `/bin/bash` |
| Répertoire | CWD = répertoire du projet actif (même logique que spawn agent) |
| Dialogue au spawn | Aucun — spawn direct, pas de formulaire |
| TTYs multiples | Listés dans le roster, un seul panneau visible à la fois |
| Fermeture | ✕ tue le PTY immédiatement (pas de grace period) |

---

## Architecture & flux de données

```
Bouton "💻 Spawn TTY"
        │
        ▼
POST /api/tty/spawn  →  tty-manager.ts  →  node-pty.spawn($SHELL, { cwd })
        │                                          │
        │  { ttyId }                               │ PTY fd ouvert
        ▼                                          ▼
Client ouvre WS /ws/tty/:id  ←──────  ttyManager stream pty.onData
        │                                          │
xterm.js.write(data)          pty.write ← ws.onmessage({ type:'input' })
                               pty.resize ← ws.onmessage({ type:'resize', cols, rows })

Fermeture :
DELETE /api/tty/:id  →  ttyManager.kill(ttyId)  →  pty.kill()
```

---

## Backend — `server/`

### Nouvelle dépendance
`node-pty` — native addon, nécessite `npm rebuild` après install.

### Nouveau fichier : `server/src/tty-manager.ts`

```typescript
interface TtySession {
  ttyId: string;       // UUID
  pty: IPty;           // node-pty instance
  shell: string;       // e.g. /bin/zsh
  cwd: string;         // répertoire du projet
  title: string;       // "TTY 1", "TTY 2"…
  createdAt: number;
}

// API interne
ttyManager.spawn(cwd: string): TtySession
ttyManager.get(ttyId: string): TtySession | undefined
ttyManager.kill(ttyId: string): void
ttyManager.list(): TtySession[]
```

Compteur auto-incrémenté pour les titres ("TTY 1", "TTY 2"…).

### Modifications : `server/src/index.ts`

Trois routes HTTP :
```
POST   /api/tty/spawn    Body: { cwd: string }  → { ttyId, shell, cwd, title }
DELETE /api/tty/:id      → 204
GET    /api/tty          → TtySession[] (sans le champ pty)
```

Un upgrade WebSocket :
```
GET /ws/tty/:id  (Upgrade: websocket)
  → pty.onData(data) → ws.send(data)
  → ws.on('message', { type:'input', data }) → pty.write(data)
  → ws.on('message', { type:'resize', cols, rows }) → pty.resize(cols, rows)
  → pty.onExit → ws.send(JSON.stringify({ type:'exit', code })) → ws.close()
```

Le serveur gère déjà `/ws` pour les événements agents. Le nouvel endpoint `/ws/tty/:id` est routé séparément via le gestionnaire `upgrade` du serveur HTTP — les deux chemins coexistent sans conflit.

---

## Frontend — `client/`

### Nouvelles dépendances
`xterm`, `xterm-addon-fit`, `xterm-addon-web-links`

### Nouveau fichier : `client/src/components/TtyHost.tsx`

Calqué sur `ChatHost`. Vit dans `HotelView` (toujours monté, survit à la navigation).

State géré :
- `ttySessionsRef : Map<ttyId, TtySessionClient>` — liste des TTYs connus
- `openTtyId : string | null` — quel TTY est visible dans le panneau

Expose via context : `openTty(id)`, `closeTty(id)`, `spawnTty(cwd)`, `useOpenTtyId()`, `useTtySessions()`.

Au mount : `GET /api/tty` pour réhydrater les sessions survivantes d'un reload.

### Nouveau fichier : `client/src/components/TtyPanel.tsx`

Structure identique à `AgentChatPanel` :

```
┌─────────────────────────────────────┐
│ 💻 TTY 1  /codetown           [✕]    │  ← barre titre
├─────────────────────────────────────┤
│                                     │
│   xterm.js Terminal (FitAddon)      │  ← corps (flex:1)
│                                     │
│                                     │
└─────────────────────────────────────┘
  (xterm.js capture le clavier nativement, pas d'input séparé)
```

Lifecycle dans `useEffect` :
1. `new Terminal()` + `FitAddon` + `WebLinksAddon`
2. `terminal.open(containerRef.current)`
3. `fitAddon.fit()`
4. Ouvrir `new WebSocket('/ws/tty/:id')`
5. `ws.onmessage → terminal.write(data)`
6. `terminal.onData → ws.send(JSON.stringify({ type:'input', data }))`
7. `ResizeObserver` → `fitAddon.fit()` → `ws.send({ type:'resize', cols, rows })`
8. Cleanup : `ws.close()`, `terminal.dispose()`

### Modifications : `client/src/components/AgentRosterPanel.tsx`

Ajouter une section "Terminaux" sous la section agents existante, même style visuel :
- Dot vert si PTY vivant, gris sinon
- Nom + cwd court
- Bouton 💻 pour ouvrir dans le panneau

### Modifications : `HotelView` (composant parent de `ChatHost`)

- Ajouter `<TtyHost>` au niveau de `HotelView`
- Gérer `openTtyId` via context
- Rendre `<TtyPanel>` à droite de `<AgentChatPanel>` quand les deux sont ouverts
- Layout flex-row : `[canvas flex:1] [ChatPanel? 320px] [TtyPanel? 320px]`
- Quand un seul panneau est ouvert, il prend sa largeur normale sans impact sur le canvas

### Nouveau bouton dans `HabboRoom.tsx`

À côté du bouton "🪄 Spawn agent" (bottom-left) :
```tsx
<button onClick={() => spawnTty(activeCwd)}>
  💻 Spawn TTY
</button>
```

`activeCwd` est le répertoire du bâtiment actif — déjà disponible dans HabboRoom (même valeur que celle passée à `spawnAgentFromHotel`). Appelle `spawnTty(cwd)` du `TtyHost` context, puis `openTty(ttyId)`. Pas de panel intermédiaire.

### TTYs multiples — switching

Quand plusieurs TTYs sont listés dans le roster, un seul panneau est visible. Les instances xterm.js des TTYs non-actifs sont montées mais cachées (`display:none`) pour conserver leur état et leur connexion WS sans redraw. Basculer vers un autre TTY = changer `openTtyId`, le panneau visible change instantanément.

---

## Layout (côte à côte)

```
┌────────────────────┬──────────────┬──────────────┐
│                    │  💬 Claude 1 │  💻 TTY 1    │
│   🏨 Hotel canvas  │              │              │
│      (flex: 1)     │  chat panel  │  xterm.js    │
│                    │  (320px)     │  (320px)     │
│  [🪄 Agent][💻 TTY]│              │              │
└────────────────────┴──────────────┴──────────────┘
```

Quand un seul panneau est ouvert, le canvas reprend l'espace.

---

## Vérification

1. `npm install node-pty xterm xterm-addon-fit xterm-addon-web-links` dans les bons workspaces
2. `npm run dev` — les deux serveurs démarrent
3. Cliquer "💻 Spawn TTY" → panneau terminal s'ouvre à droite
4. Taper `ls` → output s'affiche dans xterm.js
5. Taper `vim README.md` → vim s'ouvre correctement (mode raw PTY)
6. ✕ sur le panneau TTY → PTY tué, `GET /api/tty` retourne liste vide
7. Spawner un agent + ouvrir son chat → les deux panneaux coexistent côte à côte
8. Ouvrir deux TTYs → les deux apparaissent dans le roster, basculer de l'un à l'autre
9. `npm test` dans `server/` et `client/` → tous les tests passent
