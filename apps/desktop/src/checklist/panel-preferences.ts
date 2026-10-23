export const VARIABLE_PANEL_STORAGE_KEY = 'runbook.variable-panel.v1';
export const VARIABLE_PANEL_NARROW_QUERY = '(max-width: 1000px)';
export type PanelLayout = 'wide' | 'narrow';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface PanelPreferences { version: 1; wide?: boolean; narrow?: boolean }

function preferences(storage?: PreferenceStorage): PanelPreferences {
  try {
    const raw = (storage ?? window.localStorage).getItem(VARIABLE_PANEL_STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return { version: 1 };
    const item = value as Partial<PanelPreferences>;
    return { version: 1, ...(typeof item.wide === 'boolean' ? { wide: item.wide } : {}), ...(typeof item.narrow === 'boolean' ? { narrow: item.narrow } : {}) };
  } catch { return { version: 1 }; }
}

export function readPanelPreference(layout: PanelLayout, storage?: PreferenceStorage): boolean {
  return preferences(storage)[layout] ?? layout === 'wide';
}

/** Called only for an explicit user open/close, never for automatic locating. */
export function savePanelPreference(layout: PanelLayout, open: boolean, storage?: PreferenceStorage): void {
  try { (storage ?? window.localStorage).setItem(VARIABLE_PANEL_STORAGE_KEY, JSON.stringify({ ...preferences(storage), [layout]: open })); }
  catch { /* A denied display preference must not prevent editing. */ }
}
