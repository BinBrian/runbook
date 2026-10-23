import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { writeClipboardHtml, writeClipboardText } from '@runbook/desktop-api';
import type { Action, ArtifactKind, FileData, ImportPreview, Parameter, Workspace, WorkLoad } from './types';
import { retargetWorkDrafts } from './drafts';
import { variableClipboardData } from './variable-clipboard';

export type SaveStatus = 'idle' | 'saving' | 'error';
let workspace: Workspace = { templates: [], instances: [] };
let queue: Promise<void> = Promise.resolve();
let pending = 0;
let status: SaveStatus = 'idle';
let failure: unknown = null;
const listeners = new Set<(next: Workspace) => void>();
const statusListeners = new Set<(next: SaveStatus) => void>();
const flushers = new Set<() => Promise<void>>();
const closeSavers = new Set<() => void | Promise<void>>();
function native() { if (!isTauri()) throw new Error('请从 Windows 桌面程序打开 Runbook。'); }
function publish(next: Workspace) { workspace = next; listeners.forEach(listener => listener(next)); return next; }
function updateStatus() { status = pending ? 'saving' : failure ? 'error' : 'idle'; statusListeners.forEach(listener => listener(status)); }
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  pending += 1; updateStatus();
  const next = queue.then(async () => { native(); return task(); }).then(value => { failure = null; return value; }, error => { failure = error; throw error; })
    .finally(() => { pending -= 1; updateStatus(); });
  queue = next.then(() => undefined, () => undefined);
  return next;
}
export const api = {
  load: () => enqueue(async () => { const loaded = await invoke<WorkLoad>('checklist_load_work'); retargetWorkDrafts(loaded.convertedTemplates); return publish(loaded.workspace); }),
  apply: (action: Action) => {
    const submitted = structuredClone(action);
    return enqueue(async () => publish(await invoke<Workspace>('checklist_apply', { action: submitted })));
  },
  getWorkspace: () => workspace,
  getStatus: () => status,
  subscribe: (listener: (next: Workspace) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  onStatus: (listener: (next: SaveStatus) => void) => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
  registerFlush: (handler: () => Promise<void>) => { flushers.add(handler); return () => { flushers.delete(handler); }; },
  registerCloseSave: (handler: () => void | Promise<void>) => { closeSavers.add(handler); return () => { closeSavers.delete(handler); }; },
  async flush() {
    for (const flush of [...flushers]) await flush();
    let tail: Promise<void>; do { tail = queue; await tail; } while (tail !== queue);
  },
  async copy(text: string) { native(); await api.flush(); await writeClipboardText(text); },
  async copyVariableReference(parameter: Pick<Parameter, 'id' | 'name'>) {
    native(); const reference = { id: parameter.id, name: parameter.name };
    await api.flush();
    const data = variableClipboardData(reference);
    await writeClipboardHtml(data.html, data.text);
  },
  pickImport: () => enqueue(() => invoke<FileData | null>('checklist_pick_import')),
  previewImport: (name: string, bytes: number[]) => enqueue(() => invoke<ImportPreview>('checklist_preview_import', { name, bytes })),
  commitImport: (token: string, asCopy: boolean) => enqueue(async () => publish(await invoke<Workspace>('checklist_commit_import', { token, asCopy }))),
  exportData: (kind: ArtifactKind, id: string) => enqueue(() => invoke<FileData>('checklist_export_data', { kind, id })),
  saveExport: (name: string, bytes: number[]) => enqueue(() => invoke<boolean>('checklist_save_export', { name, bytes })),
  attachImage: (instanceId: string, stepId: string, name: string, mediaType: string, bytes: number[]) =>
    enqueue(async () => publish(await invoke<Workspace>('checklist_attach_image', { instanceId, stepId, name, mediaType, bytes }))),
  async readImage(instanceId: string, path: string) { native(); return invoke<string>('checklist_read_image', { instanceId, path }); },
};
export interface CloseFailure { message: string; retry: () => Promise<void>; discard: () => Promise<void> }
export async function installCloseGuard(onFailure: (failure: CloseFailure) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  let closing = false;
  const discard = async () => { if (closing) return; closing = true; try { await getCurrentWindow().destroy(); } finally { closing = false; } };
  const close = async () => {
    if (closing) return; closing = true;
    try { await api.flush(); for (const save of [...closeSavers]) await save(); await getCurrentWindow().destroy(); }
    catch (error) { closing = false; onFailure({ message: `本地保存失败：${String(error)}`, retry: close, discard }); }
  };
  return getCurrentWindow().onCloseRequested(async event => { event.preventDefault(); await close(); });
}
