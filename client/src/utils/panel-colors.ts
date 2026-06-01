// Couleur d'accent par panneau dockable, clé = panelKey ("tty:<id>" / "chat:<name>").
// Calqué sur tty-titles.ts : persiste en localStorage, survit au reload, nettoyé à la
// fermeture de session. Défaut = null → le panneau garde son look par défaut.

const STORAGE_KEY = 'codemap-panel-colors';

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persist(colors: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // localStorage indisponible : la couleur ne survivra pas, pas de crash.
  }
}

/** Couleur d'accent du panneau, ou null (look par défaut). */
export function getPanelColor(key: string): string | null {
  return load()[key] ?? null;
}

/** Persiste la couleur d'accent d'un panneau. */
export function setPanelColor(key: string, color: string): void {
  const colors = load();
  colors[key] = color;
  persist(colors);
}

/** Retire la couleur (retour au défaut) — appelé aussi à la fermeture de session. */
export function clearPanelColor(key: string): void {
  const colors = load();
  delete colors[key];
  persist(colors);
}
