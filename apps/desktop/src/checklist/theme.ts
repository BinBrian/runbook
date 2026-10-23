export type Theme = 'light' | 'dark';
export const THEME_STORAGE_KEY = 'runbook.appearance';
type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readTheme(storage?: ThemeStorage): Theme {
  try { return storage?.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

export function saveTheme(theme: Theme, storage?: ThemeStorage): void {
  // A denied or full preference store must never prevent working locally.
  try { storage?.setItem(THEME_STORAGE_KEY, theme); } catch { /* Session preference still applies. */ }
}

function preferenceStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** Called before React mounts, so a saved dark preference has no light first frame. */
export function initializeTheme(): void { applyTheme(readTheme(preferenceStorage())); }
export function currentTheme(): Theme { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
export function changeTheme(theme: Theme): void { applyTheme(theme); saveTheme(theme, preferenceStorage()); }
