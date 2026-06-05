# Couleurs de panneaux dockables + dock collé

**Date :** 2026-06-01
**Statut :** Validé (en attente de relecture utilisateur)

## Problème / Objectif

Depuis l'arrivée des panneaux dockables multiples (terminaux + chats), tous les
panneaux ont un cadre identique : impossible de les distinguer au coup d'œil. Par
ailleurs, en mode docké, un espace vide (`GAP = 16px`) sépare chaque panneau et ne
sert qu'à loger la poignée de redimensionnement.

Deux changements :

1. **Couleur par panneau** — chaque terminal **et** chaque chat peut recevoir une
   couleur choisie manuellement, qui teinte son **cadre + barre de titre + poignée**.
2. **Dock collé** — en mode docké, l'espace inter-panneaux passe à 0 : les panneaux
   se touchent, leurs bordures colorées s'accolent, la poignée vit sur la couture. Le
   mode flottant est **inchangé** (`GAP = 16px`).

## Décisions (issues du brainstorming)

| Sujet | Décision |
|---|---|
| Attribution des couleurs | Choix **manuel** par l'utilisateur (pas d'auto) |
| Panneaux concernés | Terminaux **et** chats |
| Étendue de la couleur | Cadre + barre de titre + poignée |
| Espace dock | Collés (gap = 0) **en docké uniquement** ; flottant inchangé |

## Architecture

Respecte la règle existante : `DockHost` détient le layout, les **hosts**
(`TtyHost`/`ChatHost`) détiennent les données de leurs sessions. La couleur est une
métadonnée de session → portée par les hosts, comme le titre.

### Module 1 — `utils/panel-colors.ts` (persistance, partagé)

Calqué **exactement** sur `utils/tty-titles.ts`, mais clé = `panelKey`
(`tty:<id>` / `chat:<name>`) pour couvrir les deux kinds avec un seul module.

```ts
getPanelColor(key: string): string | null   // null = pas de couleur (look par défaut)
setPanelColor(key: string, color: string): void
clearPanelColor(key: string): void          // retour au défaut
```

- Persisté dans `localStorage` sous `codetown-panel-colors` (`Record<string, string>`).
- Survit au reload ; nettoyé à la fermeture de session (`clearPanelColor` appelé là où
  `clearTtyTitle` l'est déjà, et l'équivalent côté chat).
- Justification DRY : 2 consommateurs (tty + chat) du **même** savoir + frontière
  `localStorage` → extraction immédiate, conforme à la politique d'abstraction.

### Module 2 — `utils/readable-text-color.ts` (helper pur, partagé)

```ts
readableTextColor(bg: string): '#000' | '#fff'  // par luminance
```

Pur, testable. Garantit la lisibilité du texte de la barre de titre quelle que soit la
pastille choisie. Utilisé par les deux panneaux.

### Module 3 — `components/PanelColorPicker.tsx` (UI, partagé)

Une **pastille** dans la barre de titre (à côté de 🗖 ─ ✕) qui ouvre un petit popover :
~8 pastilles de couleur + une option « défaut » (réinitialise à `null`).

- Interface : `{ color: string | null; onChange: (color: string | null) => void }`.
- Palette curatée (constante locale `PANEL_PALETTE`), inspirée de l'esprit de
  `CHARACTER_PALETTES` (`drawing/agent.ts`) sans la dupliquer (couleurs « shirt » de
  cette palette ne sont pas exactement adaptées à un cadre — palette propre justifiée).
- Réutilisé par `TtyPanel` **et** `AgentChatPanel` (2 usages → composant justifié).
- Module profond : interface simple (`color`/`onChange`) cachant popover + palette.

### Intégration dans les panneaux

`TtyPanel` et `AgentChatPanel` reçoivent deux nouvelles props : `color: string | null`
et `onColorChange`. Quand `color !== null` :

- conteneur : `border: 4px solid {color}` ;
- barre de titre : `background: {color}`, `color: readableTextColor(color)` ;
- poignée de resize : teintée avec `{color}`.

Quand `color === null` : look actuel inchangé (terminal sombre `#333` / chat doré).

### Intégration dans les hosts

`TtyHost` / `ChatHost` lisent la couleur via `getPanelColor(panelKey)` au render (comme
ils lisent le titre) et passent `color` + un `onColorChange` qui appelle
`setPanelColor` / `clearPanelColor` puis force un re-render (état local minimal, même
mécanique que le rename).

### Module 4 — `components/dock-layout.ts` (gap docké = 0)

- `layoutDocked` utilise un espacement de **0** au lieu de `GAP` :
  - sous-ensemble visible : `needed = n * MIN_WIDTH` (plus de `(n-1)*GAP`) ;
  - `available = budget` (plus de soustraction du gap) ;
  - `totalRowWidth = somme(raw)` ; `leftCursor += w` (sans `+ GAP`).
- `layoutFloating` **inchangé** (continue d'utiliser `GAP`).
- `GAP` reste exporté et utilisé par le flottant ; on n'introduit pas de constante
  `DOCKED_GAP` (sa valeur est 0 → inline, pas une config à un seul usage).

## Flux de données

```
clic pastille (PanelColorPicker)
  → onColorChange(color)               [TtyPanel / AgentChatPanel]
  → setPanelColor(panelKey, color)     [TtyHost / ChatHost]
  → re-render host → getPanelColor()
  → prop color → styles cadre/titre/handle
```

## Tests

- `utils/panel-colors.test.ts` : get/set/clear, défaut `null`, persistance localStorage,
  robustesse JSON invalide (miroir de la couverture implicite de `tty-titles`).
- `utils/readable-text-color.test.ts` : noir sur clair, blanc sur sombre, cas limites.
- `components/dock-layout.test.ts` : **mise à jour** — en docké, `rightOffset` /
  `effectiveWidth` calculés avec gap 0 (panneaux jointifs, somme == budget) ; vérifier
  que le **flottant** garde le `GAP`.

## Hors périmètre (YAGNI)

- Attribution automatique de couleurs (explicitement écarté : choix manuel).
- Roue chromatique / couleur arbitraire (palette fixe suffit).
- Couleur sur les éléments internes du chat (bulles, boutons) — seulement cadre + titre
  + poignée.

## Points de vigilance

- **Clic sur la poignée à la couture** : panneaux dockés collés, même `zIndex: 26` ; la
  poignée (`left:-4, width:8`) chevauche le bord droit du voisin. L'ordre DOM départage
  les clics → vérifier que la poignée du panneau reste cliquable (au besoin, légère
  élévation de `zIndex` de la poignée ou ajustement de sa position à la couture).
- **Contraste** : `readableTextColor` couvre le texte du titre ; vérifier aussi les
  icônes des boutons (héritent de `color`).
