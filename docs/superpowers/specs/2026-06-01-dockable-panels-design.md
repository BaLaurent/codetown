# Panneaux dockables (terminaux + chats) — Design

**Date :** 2026-06-01
**Statut :** Validé (en attente de relecture utilisateur)

## Problème

Aujourd'hui le chat et les terminaux flottent en `position: absolute` ancrés en bas
à droite (`bottom: 16`), empilés **par-dessus** le canvas de l'hôtel qui occupe
`100vw × 100vh`. Ils masquent la carte. Il n'existe aucun mode « dock ».

L'utilisateur veut un **mode docké** : la carte rétrécit *réellement* au-dessus
d'une vraie barre du bas qui contient les panneaux, sans aucun chevauchement.

## Exigences (validées)

1. **Toggle global** flottant ↔ docké (un seul bouton bascule tout).
2. **Docké = vrai rétrécissement** : le canvas se réduit pour occuper la zone
   au-dessus de la barre ; toute la carte reste visible, redessinée plus petite.
3. **Barre du bas** : terminaux *et* chats côte à côte, resizables, avec la
   logique d'éviction au débordement (comme les TTY aujourd'hui).
4. **Multi-chat** : le chat devient multi-instances (aujourd'hui mono-instance).
5. **Maximiser** un panneau = il prend toute la largeur de la barre, les autres
   sont masqués temporairement, la carte garde sa taille.
6. **Docké = panneaux étirés sur toute la barre** (façon VS Code / devtools),
   pas de zone vide. Le comportement docké **diverge** du flottant.

## Décision d'architecture : Approche A — `DockProvider` unifié

Un seul provider devient la **source de vérité de la mise en page** : il détient
la liste ordonnée des panneaux ouverts (TTY *et* chats), leurs largeurs, le mode
et le panneau maximisé. On généralise l'algorithme de layout existant en un seul
moteur qui traite une liste hétérogène. `TtyHost`/`ChatHost` se réduisent à des
couches « données » (sessions tmux, threads de chat) ; le dock gère le
positionnement, le mode et le maximize.

Approches écartées :
- **B (deux layouts parallèles + contexte de mode)** : duplique l'algorithme de
  layout à deux endroits (même règle, doit changer ensemble → viole DRY) et rend
  l'éviction sur l'ensemble combiné bancale.
- **C (dock seul, sans multi-chat ni maximize)** : ne couvre pas les exigences.

## Principe technique central : pas de remount au toggle

Les panneaux restent en `position: absolute` ancrés au bas du **viewport** dans
les **deux** modes. « Docker » = rétrécir le conteneur du canvas pour que son bas
s'arrête au-dessus de la zone des panneaux. Les panneaux ne sont jamais
reparentés → jamais démontés → les terminaux conservent leur état tmux / scroll /
WebSocket (régression connue : `tty-scroll-needs-tmux-mouse-on`,
`xterm-lazy-open-hidden-panel`).

La seule vraie différence entre flottant et docké côté DOM est la **hauteur du
conteneur du canvas**.

## Carte des modules

| Module | Rôle | Changement |
|---|---|---|
| `dock-layout.ts` | Algo de placement unique | **Généralise** `tty-layout.ts` (rename) : `computeDockLayout(panels, widths, viewportWidth, mode, maximizedKey)` où `panels` est une liste hétérogène ordonnée (`{kind:'tty'\|'chat', id}`). Supprime le cas spécial `CHAT_WIDTH`. Gère les deux politiques (flottant/docké) + le maximize. |
| `DockHost.tsx` | **Nouveau** — source de vérité du layout | `DockProvider` + `useDock()`. Détient : `order` (clés `kind:id`), `widths`, `mode` (`floating\|docked`), `maximizedKey`. Expose : `placements`, `mode`, `toggleMode`, `dockHeight` (dérivé), `openPanel/closePanel/setWidth/maximize/restore`. |
| `TtyHost.tsx` | Données TTY (sessions, spawn, rename, appels serveur) | Délègue ouverture / largeur / visibilité au dock ; rend les `TtyPanel` à partir des `placements`. |
| `ChatHost.tsx` | Mapper de chats | Devient mince : pour chaque chat ouvert (ordre du dock), rend un `<ChatPanelContainer>`. |
| `ChatPanelContainer.tsx` | **Nouveau** | Détient le cycle de vie d'**UN** chat (effets actuellement dans `ChatHost` : transcript, capabilities, complétion `@`, RAF poll), instancié une fois par chat ouvert. Débloque le multi-chat. |
| `AgentChatPanel.tsx` | Rendu d'un chat | Accepte les props de placement (`rightOffset/width/maxWidth/active`) + poignée de resize + bouton maximize, comme `TtyPanel`. |
| `TtyPanel.tsx` | Rendu d'un terminal | Ajoute le bouton maximize/restore dans la barre de titre. |
| `App.tsx` | Orchestration | Imbrique `DockProvider` ; enveloppe `TownView` dans un conteneur dont la hauteur soustrait `dockHeight` ; ajoute le bouton toggle global. |
| `HabboRoom.tsx` / `TownView.tsx` | Canvas | Se dimensionnent sur **leur conteneur** (ResizeObserver) au lieu de `window`. |

Imbrication des providers :
`AgentStreamProvider > DockProvider > ChatProvider > TtyProvider`.
Les panneaux sont rendus **hors** du conteneur du canvas (siblings, absolus au
viewport) → ils tombent dans la bande du bas libérée. Le conteneur du canvas est
en `position: relative` mais ne contient pas les panneaux.

## Le « vrai » rétrécissement de la carte

Aujourd'hui : `canvas.width = window.innerWidth` (HabboRoom `1334-1339`,
TownView `:50`), redimensionné sur l'évènement `window.resize`.

Changement :
- Le root de `HabboRoom` passe de `100vw/100vh` à `100%/100%` de son conteneur.
- `HabboRoom` et `TownView` mesurent leur conteneur via `ResizeObserver`
  (`clientWidth/clientHeight`) au lieu de `window.innerWidth/innerHeight`.
- Dans `HotelViewInner` :

  ```
  <div style={{ width:'100vw',
                height: docked ? `calc(100vh - ${dockHeight}px)` : '100vh',
                position:'relative', overflow:'hidden' }}>
    <TownView .../>
  </div>
  ```

`dockHeight` (dérivé par le dock) = `0` si aucun panneau ouvert **ou** mode
flottant, sinon `min(0.52*innerHeight, 520) + 32` (hauteur panneau + marges).
Quand il change, le `ResizeObserver` redimensionne le canvas et la scène se
redessine plus petite. Zéro chevauchement.

Les boutons de spawn (bottom-left, dans le root de HabboRoom) s'ancrent alors au
bas du conteneur rétréci → ils restent juste au-dessus de la barre.

## Moteur `computeDockLayout` — deux politiques

`panels` : liste ordonnée (ordre d'ouverture, le plus récent en dernier =
prioritaire à l'affichage), chaque entrée `{ kind, id }`. Clé de placement =
`` `${kind}:${id}` ``.

### Politique flottant (= comportement actuel, préservé à l'identique)
Largeurs fixes (stockées, défaut 420), ancrées à droite, empilage droite→gauche,
le plus récent collé au bord droit. Éviction du plus ancien quand le cumul
dépasse le budget. Le drag d'un panneau l'élargit en absorbant l'espace libre
restant, sans pousser ses voisins (plafond = sa largeur + espace libre).

### Politique docké (nouvelle, étirée)
Plus d'espace libre : le sous-ensemble visible (déterminé par l'éviction au
MIN_WIDTH) se **répartit sur toute la largeur** de la barre. Le resize redistribue
entre le panneau tiré et son voisin (split-pane) : agrandir l'un rétrécit l'autre,
total constant = largeur de barre. L'éviction du plus ancien se déclenche quand
même MIN_WIDTH chacun ne tient plus.

### Maximize (commun aux deux modes)
`maximizedKey` posé → un seul placement, pleine largeur du budget ; tous les
autres `active:false` → `visibility:hidden`, état préservé (réutilise le mécanisme
d'éviction existant). Bouton maximize/restore dans la barre de titre de chaque
panneau.

## Multi-chat — cycle de vie

`ChatHost` aujourd'hui est mono-instance : `chatAgentId` + `chatCommands/files/
models/tick` tous liés au chat unique, plus une boucle RAF unique (lignes
104-119) qui ne tourne que pendant qu'un chat est ouvert.

Refactor :
- `ChatHost` devient un mapper : pour chaque chat de l'ordre du dock, rend
  `<ChatPanelContainer key={agentId} agentId={agentId} placement={...} />`.
- `ChatPanelContainer` encapsule, **par chat**, les effets actuellement dans
  `ChatHost` (fetch transcript / capabilities / graph `@`, écoute du rename, poll
  RAF) et rend `AgentChatPanel`.

### Lifecycle des chats évincés (décision)
- Les chats évincés (poussés hors budget par le débordement) **restent montés en
  `visibility:hidden`**, comme les TTY — pas de démontage. Évite de re-fetcher
  transcript / capabilities / graph à chaque flap de débordement (resize fenêtre).
- Le **RAF poll par chat est gaté sur `active`** : un chat caché ne fait pas
  tourner de boucle de rendu (sinon N boucles pour N chats cachés). Idem N fetch
  graph à l'ouverture pour des chats du même projet → à dédupliquer / gater.

## Toggle global & persistance

- Bouton dans le cluster nav existant (`App.tsx 128-148`), à côté de
  `← Town` / `Mute`. Libellé `⬓ Dock` / `⬓ Float`.
- Mode persisté en `localStorage` (même pattern que `tty-titles`), pour ne pas
  devoir le réactiver à chaque reload.

## Tests & vérification

### Unitaires — `dock-layout.test.ts`
- **Parité TTY (garde-fou)** : les tests `tty-layout` existants doivent passer à
  l'identique avec des entrées **TTY-seules** → placements identiques sur le
  nouveau moteur.
- Liste hétérogène : éviction mixte tty + chat.
- Politique docké : répartition pleine largeur, resize split-pane (somme
  constante), éviction au MIN_WIDTH.
- Maximize → un seul placement, autres `active:false`.
- `dockHeight` dérivé (0 si flottant ou rien d'ouvert).

### Anti-régression
- Basculer le mode ne change pas l'identité / le montage des panneaux (garde-fou
  état terminal).

### Vérification navigateur (manuelle, dans le plan)
Le cœur de la feature — canvas mesurant son conteneur via `ResizeObserver` — est
du RAF/canvas/DOM, **non couvert par les tests unitaires**. Étape explicite :
toggle dock → la carte se redessine plus petite, zéro chevauchement, clic/zoom
toujours bien mappés via `getBoundingClientRect`.

## Discipline de migration (rename `computeTtyLayout`)

Comportement TTY durement acquis qui repose sur le moteur : open idempotent,
hide-sans-kill, clamp de largeur, ordre d'éviction. Avant le rename :
- Grep de **tous** les consommateurs de `computeTtyLayout` / `CHAT_WIDTH`.
- Gate explicite : tests TTY existants verts avec entrées TTY-seules produisant
  des placements identiques.
