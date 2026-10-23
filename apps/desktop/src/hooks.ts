import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@runbook/desktop-api';

const unsavedInputs = new Map<string, unknown>();
export function getUnsavedInputs() { return Array.from(unsavedInputs.values()); }

/** Explicit-submit dialogs do not autosave business actions. Keep their text in
 * the rescue export and block window destruction until saved or cancelled. */
export function useDialogDraft(open: boolean, dirty: boolean, label: string, value: unknown) {
  const identity = useRef(crypto.randomUUID());
  const state = useRef({ open, dirty, label });
  state.current = { open, dirty, label };
  useEffect(() => api.registerCloseBlocker(() => {
    if (state.current.open && state.current.dirty) throw new Error(`${state.current.label}还有未提交的输入，请先保存或明确取消。`);
  }), []);
  useEffect(() => {
    if (open && dirty) unsavedInputs.set(identity.current, { dialog: label, value });
    else unsavedInputs.delete(identity.current);
    return () => { unsavedInputs.delete(identity.current); };
  }, [open, dirty, label, value]);
}

/** Keep a dirty value until the native transaction confirms it. Window closing
 * invokes these same handlers through the API's flush registry. */
export function useAutosave<T>(initial: T, save: (value: T) => Promise<unknown>, onError: (error: unknown) => void) {
  const [value, setValue] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const current = useRef(initial);
  const inputId = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const savedGeneration = useRef(0);
  const saveRef = useRef(save);
  const errorRef = useRef(onError);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  saveRef.current = save;
  errorRef.current = onError;
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    if (savedGeneration.current === generation.current) return;
    const promise = (async () => {
      while (savedGeneration.current !== generation.current) {
        const version = generation.current;
        await saveRef.current(current.current);
        savedGeneration.current = version;
      }
      setDirty(false);
      unsavedInputs.delete(inputId.current);
    })();
    inFlight.current = promise;
    try { await promise; } finally { inFlight.current = undefined; }
  }, []);
  const update = useCallback((next: T) => {
    current.current = next;
    generation.current += 1;
    setValue(next);
    setDirty(true);
    unsavedInputs.set(inputId.current, next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(errorRef.current); }, 500);
  }, [flush]);
  useEffect(() => {
    const unregister = api.registerFlush(flush);
    return () => { clearTimeout(timer.current); unregister(); };
  }, [flush]);
  return { value, update, dirty, flush, current };
}

export function useDocument(markdown: string, onError: (error: unknown) => void) {
  const [document, setDocument] = useState<Awaited<ReturnType<typeof api.parse>> | null>(null);
  const [parsedSource, setParsedSource] = useState('');
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      void api.parse(markdown).then((result) => { if (!cancelled) { setDocument(result); setParsedSource(markdown); } }).catch((error: unknown) => { if (!cancelled) errorRef.current(error); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [markdown]);
  return { document, current: parsedSource === markdown };
}

export function useResolvedDocument(markdown: string, parameters: Record<string, string>, onError: (error: unknown) => void, enabled = true) {
  const [resolved, setResolved] = useState<Awaited<ReturnType<typeof api.resolve>> | null>(null);
  const [parsedKey, setParsedKey] = useState('');
  const parametersKey = JSON.stringify(Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)));
  const sourceKey = JSON.stringify([markdown, parametersKey]);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timeout = setTimeout(() => {
      void api.resolve(markdown, Object.fromEntries(JSON.parse(parametersKey) as Array<[string, string]>)).then((result) => {
        if (!cancelled) { setResolved(result); setParsedKey(sourceKey); }
      }).catch((error: unknown) => { if (!cancelled) errorRef.current(error); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [markdown, parametersKey, sourceKey, enabled]);
  return { resolved, current: parsedKey === sourceKey };
}
