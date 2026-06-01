// Couleurs par panneau dockable, clé = panelKey ("tty:<id>" / "chat:<name>") :
//  - fond  (couleur d'accent du cadre/barre/poignée) → store "codemap-panel-colors"
//  - texte (couleur du texte de la barre de titre)    → store "codemap-panel-text-colors"
// Calqué sur tty-titles.ts : persiste en localStorage, survit au reload, nettoyé à la
// fermeture de session. Défaut = null → look par défaut (texte = inverse du fond).

const BG_KEY = 'codemap-panel-colors';
const TEXT_KEY = 'codemap-panel-text-colors';

function load(storageKey: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persist(storageKey: string, colors: Record<string, string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(colors));
  } catch {
    // localStorage indisponible : la couleur ne survivra pas, pas de crash.
  }
}

function get(storageKey: string, key: string): string | null {
  return load(storageKey)[key] ?? null;
}

function set(storageKey: string, key: string, color: string): void {
  const colors = load(storageKey);
  colors[key] = color;
  persist(storageKey, colors);
}

function clear(storageKey: string, key: string): void {
  const colors = load(storageKey);
  delete colors[key];
  persist(storageKey, colors);
}

/** Couleur de fond (accent) du panneau, ou null (look par défaut). */
export function getPanelColor(key: string): string | null {
  return get(BG_KEY, key);
}

/** Persiste la couleur de fond d'un panneau. */
export function setPanelColor(key: string, color: string): void {
  set(BG_KEY, key, color);
}

/** Retire la couleur de fond (retour au défaut) — appelé aussi à la fermeture. */
export function clearPanelColor(key: string): void {
  clear(BG_KEY, key);
}

/** Couleur de texte de la barre de titre, ou null (défaut = inverse du fond). */
export function getPanelTextColor(key: string): string | null {
  return get(TEXT_KEY, key);
}

/** Persiste la couleur de texte d'un panneau. */
export function setPanelTextColor(key: string, color: string): void {
  set(TEXT_KEY, key, color);
}

/** Retire la couleur de texte (retour à l'inverse du fond) — aussi à la fermeture. */
export function clearPanelTextColor(key: string): void {
  clear(TEXT_KEY, key);
}
