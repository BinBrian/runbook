import { describe, expect, it } from 'vitest';
import { readTheme, saveTheme, THEME_STORAGE_KEY } from './theme';

describe('local appearance preference', () => {
  it('uses white for missing, invalid or unavailable preferences', () => {
    for (const value of [null, '', 'system', 'LIGHT', 'invalid']) {
      expect(readTheme({ getItem: () => value, setItem() {} })).toBe('light');
    }
    expect(readTheme()).toBe('light');
    expect(readTheme({ getItem() { throw new Error('denied'); }, setItem() {} })).toBe('light');
  });
  it('round trips both themes using only the display preference key', () => {
    const entries = new Map<string, string>([['runbook.document', 'untouched']]);
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
    saveTheme('dark', storage); expect(readTheme(storage)).toBe('dark');
    saveTheme('light', storage); expect(readTheme(storage)).toBe('light');
    expect([...entries]).toEqual([['runbook.document', 'untouched'], [THEME_STORAGE_KEY, 'light']]);
  });
  it('keeps display changes usable when storage is denied or full', () => {
    expect(() => saveTheme('dark', { getItem() { return null; }, setItem() { throw new Error('quota'); } })).not.toThrow();
    expect(() => saveTheme('dark')).not.toThrow();
  });
});
