import type { ArtifactKind } from './types';

export const DRAFT_STORAGE_KEY = 'runbook.explicit-drafts.v1';
export interface DraftTarget {
  kind: ArtifactKind;
  id: string;
  stepId?: string;
  groupId?: string;
  dialog?: string;
}
export interface DraftEntry { value: unknown; label: string; target?: DraftTarget }
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const strings = (value: unknown) => record(value) && Object.values(value).every(item => typeof item === 'string');
function validEntry(key: string, entry: unknown): entry is DraftEntry {
  if (!record(entry) || typeof entry.label !== 'string') return false;
  const target = entry.target;
  if (target !== undefined && (!record(target) || !['template', 'block', 'instance'].includes(String(target.kind)) || typeof target.id !== 'string' || ['stepId', 'groupId', 'dialog'].some(field => target[field] !== undefined && typeof target[field] !== 'string'))) return false;
  if (key.startsWith('parameters:')) return strings(entry.value);
  if (key.startsWith('favorite:')) return record(entry.value) && typeof entry.value.name === 'string' && typeof entry.value.replaceId === 'string';
  if (key.startsWith('comment:') || key.startsWith('edit-comment:')) return typeof entry.value === 'string';
  if (key.startsWith('dialog:')) return typeof entry.value === 'string' || (record(entry.value) && typeof entry.value.text === 'string' && typeof entry.value.carryValues === 'boolean');
  const value = entry.value;
  return key.startsWith('variable-definition:') && record(value) && ['add', 'edit'].includes(String(value.kind)) && ['id', 'ownerLabel', 'name', 'description', 'defaultValue'].every(field => typeof value[field] === 'string') && (value.ownerId === undefined || typeof value.ownerId === 'string');
}
/** Object property order must not turn unchanged parameter values into a draft. */
export function sameDraft(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameDraft(value, right[index]));
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameDraft(left[key], right[key]));
}
export function createDraftStore(storage?: DraftStorage) {
  const entries = new Map<string, DraftEntry>();
  const listeners = new Set<() => void>();
  let error = '', changed = false, readError = '';
  try {
    const raw = storage?.getItem(DRAFT_STORAGE_KEY);
    if (raw) {
      const saved: unknown = JSON.parse(raw);
      if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.entries) || !saved.entries.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && validEntry(pair[0], pair[1]))) throw new Error('草稿格式无法读取');
      for (const [key, entry] of saved.entries) entries.set(key, entry);
    }
  } catch (reason) { readError = `本地草稿恢复失败：${String(reason)}`; error = readError; }
  function persist() {
    try {
      if (readError) throw new Error(readError);
      if (!storage) { if (!entries.size && !changed) return; throw new Error('本机草稿存储不可用'); }
      storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries: [...entries] }));
      error = ''; changed = false;
    } catch (reason) { error = `本地草稿未保存：${String(reason)}`; throw reason; }
  }
  function notify() { for (const listener of listeners) listener(); }
  function update(key: string, entry?: DraftEntry) {
    if (entry) entries.set(key, structuredClone(entry)); else entries.delete(key);
    changed = true;
    try { persist(); } catch { /* Keep the exact in-memory input and expose the failure. */ }
    notify();
  }
  function replace(next: [string, DraftEntry][]) { entries.clear(); for (const [key, entry] of next) entries.set(key, entry); changed = true; try { persist(); } catch { /* Exact in-memory drafts remain available. */ } notify(); }
  return { entries, update, replace, getError: () => error, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, flush: () => { try { persist(); } finally { notify(); } } };
}
function localDraftStorage(): DraftStorage | undefined { try { return window.localStorage; } catch { return undefined; } }
// WebView2's profile lives under the configured data directory, including isolated tests.
export const draftStore = createDraftStore(localDraftStorage());

/** Retain form input when former template content becomes an ordinary work. */
export function retargetWorkDrafts(mapping: Record<string, string>, store = draftStore) {
  let changed = false;
  const next = [...store.entries].map(([key, saved]): [string, DraftEntry] => {
    if (!saved.target) return [key, saved];
    const oldKey = key;
    const entry = structuredClone(saved), target = entry.target!;
    if (target.kind === 'template' && mapping[target.id]) {
      const old = target.id; target.kind = 'instance'; target.id = mapping[old];
      if (key === `variable-definition:template:${old}`) key = `variable-definition:instance:${target.id}`;
    }
    const actionMap: Record<string, string> = { newTemplate: 'newWork', newBlock: 'newWork', createInstance: 'repeatWork', copyInstance: 'repeatWork', saveTemplate: 'repeatWork' };
    if (target.dialog && actionMap[target.dialog]) { target.dialog = actionMap[target.dialog]; target.kind = 'instance'; }
    if (key.startsWith('dialog:') && typeof entry.value === 'string') entry.value = { text: entry.value, carryValues: true };
    if (target.dialog === 'saveBlock' && target.kind === 'instance' && target.groupId) {
      target.dialog = 'favorite'; entry.value = { name: record(entry.value) && typeof entry.value.text === 'string' ? entry.value.text : '', replaceId: '' };
      key = 'favorite:' + JSON.stringify([target.id, target.stepId, target.groupId]);
    }
    if (key.startsWith('dialog:') && target.dialog) key = 'dialog:' + JSON.stringify([target.dialog, target.id, target.stepId, target.groupId]);
    if (key !== oldKey || !sameDraft(entry, saved)) changed = true;
    return [key, entry];
  });
  // Keep both inputs in the unlikely event that two old forms map to one action.
  const seen = new Set<string>();
  const unique = next.map(([key, entry], index): [string, DraftEntry] => { const final = seen.has(key) ? `${key}:retained:${index}` : key; seen.add(final); return [final, entry]; });
  if (changed) store.replace(unique);
}
