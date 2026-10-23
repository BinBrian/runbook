import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { ArtifactKind } from './types';
import { draftStore, sameDraft, type DraftTarget } from './drafts';

const dirtyBuffers = new Set<string>();
const draftListeners = new Set<() => void>();
const draftsChanged = () => draftListeners.forEach(listener => listener());
export function useDraftStatus() {
  const snapshot = () => ({ buffered: dirtyBuffers.size > 0, explicit: explicitDrafts.size > 0, entries: [...explicitDrafts], error: draftStore.getError() });
  const [state, setState] = useState(snapshot);
  useEffect(() => { const listener = () => setState(snapshot()); draftListeners.add(listener); const remove = draftStore.subscribe(listener); return () => { draftListeners.delete(listener); remove(); }; }, []);
  return state;
}

export function useBufferedSave<T>(initial: T, save: (value: T) => Promise<unknown>, onError: (reason: unknown) => void) {
  const [value, setValue] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const current = useRef(initial);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const identity = useRef(crypto.randomUUID());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveRef = useRef(save); saveRef.current = save;
  const errorRef = useRef(onError); errorRef.current = onError;
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    if (version.current === savedVersion.current) return;
    const pending = (async () => {
      while (version.current !== savedVersion.current) {
        const submittedVersion = version.current;
        await saveRef.current(structuredClone(current.current));
        savedVersion.current = submittedVersion;
      }
      setDirty(false);
      dirtyBuffers.delete(identity.current); draftsChanged();
    })();
    inFlight.current = pending;
    try { await pending; } finally { inFlight.current = null; }
  }, []);
  const update = useCallback((next: T) => {
    current.current = next; version.current += 1; setValue(next); setDirty(true);
    dirtyBuffers.add(identity.current); draftsChanged();
    clearTimeout(timer.current); timer.current = setTimeout(() => void flush().catch(errorRef.current), 500);
  }, [flush]);
  useEffect(() => api.registerFlush(flush), [flush]);
  useEffect(() => () => { clearTimeout(timer.current); dirtyBuffers.delete(identity.current); draftsChanged(); }, []);
  return { value, current, dirty, update, flush };
}

const explicitDrafts = draftStore.entries;
export const hasExplicitDraft = (key: string) => explicitDrafts.has(key);
export const saveExplicitDrafts = () => draftStore.flush();
/** Deleting one object must not discard its explicit inputs or block on
 * unrelated work retained in another template or instance. */
export function assertArtifactDraftsSaved(kind: ArtifactKind, id: string) {
  const exact = new Set([`variable-definition:${kind}:${id}`, ...(kind === 'instance' ? [`parameters:${id}`] : [])]);
  const first = [...explicitDrafts].find(([key]) => exact.has(key) || (kind === 'instance' && (key.startsWith(`comment:${id}:`) || key.startsWith(`edit-comment:${id}:`))));
  if (first) throw new Error(`${first[1].label}还有未提交的输入，请返回提交或取消。`);
}
/** Retain explicit input across navigation; changing pages must not discard it. */
export function useExplicitDraft<T>(key: string, initial: T, label: string, target?: DraftTarget) {
  const [value, setValue] = useState<T>(() => (explicitDrafts.get(key)?.value as T | undefined) ?? initial);
  const initialRef = useRef(initial); initialRef.current = initial;
  useEffect(() => draftStore.subscribe(() => { const entry = explicitDrafts.get(key); setValue(entry ? entry.value as T : initialRef.current); }), [key]);
  const update = (next: T) => { setValue(next); draftStore.update(key, sameDraft(next, initial) ? undefined : { value: next, label, target }); };
  const reset = (next: T) => { draftStore.update(key); setValue(next); };
  return { value, update, reset, dirty: explicitDrafts.has(key) };
}
