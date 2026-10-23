import { describe, expect, it } from 'vitest';
import { readPanelPreference, savePanelPreference, VARIABLE_PANEL_STORAGE_KEY } from './panel-preferences';

describe('variable panel layout preferences', () => {
  it('defaults narrow windows to closed and wide windows to open even for unusable storage', () => {
    for (const value of [null, '', 'broken', '{}', '{"version":2,"narrow":true}', '{"version":1,"wide":"false","narrow":"true"}']) {
      const storage = { getItem: () => value, setItem() {} };
      expect(readPanelPreference('narrow', storage)).toBe(false);
      expect(readPanelPreference('wide', storage)).toBe(true);
    }
    const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(readPanelPreference('narrow', denied)).toBe(false);
    expect(() => savePanelPreference('narrow', true, denied)).not.toThrow();
  });

  it('keeps deliberate open/close choices independent across layouts and preserves unrelated local data', () => {
    const entries = new Map([['runbook.explicit-drafts', 'untouched']]);
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
    savePanelPreference('narrow', true, storage);
    savePanelPreference('wide', false, storage);
    expect(readPanelPreference('narrow', storage)).toBe(true);
    expect(readPanelPreference('wide', storage)).toBe(false);
    savePanelPreference('narrow', false, storage);
    expect(readPanelPreference('narrow', storage)).toBe(false);
    expect(readPanelPreference('wide', storage)).toBe(false);
    expect(entries.get('runbook.explicit-drafts')).toBe('untouched');
    expect([...entries.keys()]).toEqual(['runbook.explicit-drafts', VARIABLE_PANEL_STORAGE_KEY]);
  });
});
