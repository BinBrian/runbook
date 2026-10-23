import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { writeHtml, writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { Action, Document, Request, ResolvedDocument, Workspace } from '@runbook/contracts';

export type SaveStatus = 'idle' | 'saving' | 'error';
let workspace: Workspace = { templates: [], runs: [] };
// This barrier tracks settlement, while mutate() returns each operation's own
// rejecting promise. A rejected command must not poison later navigation.
let queue: Promise<void> = Promise.resolve();
let status: SaveStatus = 'idle';
let pending = 0;
let lastFailure: Error | null = null;
const listeners = new Set<(value: Workspace) => void>();
const statusListeners = new Set<(value: SaveStatus) => void>();
const flushers = new Set<() => Promise<void>>();
const closeBlockers = new Set<() => void | Promise<void>>();

function publish(next: Workspace) { workspace = next; listeners.forEach(fn => fn(next)); }
function setStatus(value: SaveStatus) { status = value; statusListeners.forEach(fn => fn(value)); }
function revision(action: Action): number | null {
  if (action.type === 'create_template' || action.type === 'create_run' || action.type === 'import_bundle') return null;
  const id = 'run_id' in action ? action.run_id : action.id;
  if (action.type === 'save_template' || action.type === 'archive_template') return workspace.templates.find(t => t.id === id)?.revision ?? null;
  return workspace.runs.find(r => r.id === id)?.revision ?? null;
}
function native() {
  if (!isTauri()) throw new Error('请使用 Windows 桌面应用打开 Runbook。浏览器页面不提供本地数据库访问。');
}

/** Shared clipboard boundary used by the checklist and legacy desktop clients. */
export async function writeClipboardText(text: string) { native(); await writeText(text); }
export async function writeClipboardHtml(html: string, altText: string) { native(); await writeHtml(html, altText); }

export const api = {
  async load(): Promise<Workspace> { native(); const next = await invoke<Workspace>('load_workspace'); publish(next); return next; },
  mutate(action: Action): Promise<Workspace> {
    const operation_id = crypto.randomUUID();
    const submittedAction = structuredClone(action);
    pending += 1; setStatus('saving');
    const task = queue.then(async () => {
      try {
        native();
        const request: Request = { operation_id, expected_revision: revision(submittedAction), action: submittedAction };
        const next = await invoke<Workspace>('perform', { request });
        lastFailure = null; publish(next); return next;
      } catch (reason) {
        lastFailure = reason instanceof Error ? reason : new Error(String(reason)); throw lastFailure;
      }
    }).finally(() => { pending -= 1; setStatus(pending ? 'saving' : lastFailure ? 'error' : 'idle'); });
    queue = task.then(() => undefined, () => undefined);
    return task;
  },
  async parse(markdown: string) { native(); return invoke<Document>('parse_markdown', { markdown }); },
  async resolve(markdown: string, parameters: Record<string, string> = {}) { native(); return invoke<ResolvedDocument>('resolve_document', { markdown, parameters }); },
  async plainMarkdown(markdown: string, parameters?: Record<string, string>) { native(); return invoke<string>('plain_markdown', { markdown, parameters }); },
  async report(runId: string) { native(); return invoke<string>('export_report', { runId }); },
  async previewImport(json: string) { native(); return invoke<{ templates: number; runs: number }>('preview_import', { json }); },
  async copy(text: string) { native(); await writeText(text); },
  async importFile() { native(); return invoke<{name: string; content: string} | null>('pick_import'); },
  async exportFile(name: string, content: string) { native(); return invoke<boolean>('save_export', { name, content }); },
  async backup() { native(); return invoke<string>('export_backup'); },
  async flush() {
    // Editors own dirty buffers. Their flushers retain and reject unsaved input
    // on a failed save, and retry it on the next flush. Ordinary action errors
    // (for example, an empty failure reason) have no dirty buffer to protect.
    for (const flush of [...flushers]) await flush();
    let tail: Promise<void>;
    do { tail = queue; await tail; } while (tail !== queue);
  },
  registerFlush(handler: () => Promise<void>) { flushers.add(handler); return () => { flushers.delete(handler); }; },
  registerCloseBlocker(handler: () => void | Promise<void>) { closeBlockers.add(handler); return () => { closeBlockers.delete(handler); }; },
  subscribe(listener: (value: Workspace) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  onStatus(listener: (value: SaveStatus) => void) { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
  getStatus() { return status; },
};

/** A close request must acknowledge all in-memory editor buffers before destroying the WebView. */
export async function installCloseGuard(onFailure: (message: string) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  let closing = false;
  return getCurrentWindow().onCloseRequested(async event => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await api.flush();
      // Explicit-submit dialogs retain their inputs until saved or cancelled.
      // These checks belong only to window closing: a dialog's Save action must
      // still be able to flush ordinary editor buffers without blocking itself.
      for (const block of [...closeBlockers]) await block();
      await getCurrentWindow().destroy();
    }
    catch (reason) { closing = false; onFailure(`保存尚未完成，窗口已保留：${String(reason)}`); }
  });
}
