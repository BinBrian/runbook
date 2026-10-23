import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, Request, Run, Template, Workspace } from '@runbook/contracts';

const nativeMocks = vi.hoisted(() => ({
  invoke: vi.fn(), isTauri: vi.fn(), writeText: vi.fn(), destroy: vi.fn(), onCloseRequested: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeMocks.invoke, isTauri: nativeMocks.isTauri }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: nativeMocks.writeText }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ destroy: nativeMocks.destroy, onCloseRequested: nativeMocks.onCloseRequested }) }));

function template(revision = 3): Template {
  return { id: 'template', name: 'Template', description: '', draft_markdown: '', applied_markdown: '', revision, applied_revision: 1, source_hash: '', created_at: '', updated_at: '', archived: false };
}
function run(revision = 7): Run {
  return { id: 'run', name: 'Run', context: '', source_template_id: 'template', initial_template_snapshot: { template_id: 'template', name: 'Template', revision: 1, markdown: '', parameters: {} }, parameters: {}, draft_parameters: {}, draft_markdown: '', applied_markdown: '', revision, applied_revision: 1, created_at: '', updated_at: '', closed_at: null, summary_note: '', selected_step_id: null, steps: [], summary: { pending: 0, active: 0, completed: 0, failed: 0, skipped: 0, removed: 0, conclusion: 'no_steps' } };
}
function workspace(runRevision = 7, templateRevision = 3): Workspace { return { templates: [template(templateRevision)], runs: [run(runRevision)] }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup() {
  const module = await import('./index');
  nativeMocks.invoke.mockResolvedValueOnce(workspace());
  await module.api.load();
  nativeMocks.invoke.mockClear();
  return module;
}
function received(index: number): Request { return nativeMocks.invoke.mock.calls[index][1].request as Request; }

beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); nativeMocks.isTauri.mockReturnValue(true); });

describe('native mutation queue and dirty buffer flushing', () => {
  it('resolves parameters and exports plain text in the native boundary without rewriting source', async () => {
    const { api } = await setup();
    const markdown = 'echo {{rb:HOST}}';
    const parameters = { HOST: 'prod-a' };
    nativeMocks.invoke.mockResolvedValueOnce({ markdown: 'echo prod-a', document: { parameters: [], steps: [], diagnostics: [], source_hash: '' }, parameters });
    await api.resolve(markdown, parameters);
    expect(nativeMocks.invoke).toHaveBeenLastCalledWith('resolve_document', { markdown, parameters });
    nativeMocks.invoke.mockResolvedValueOnce('echo prod-a');
    await api.plainMarkdown(markdown, parameters);
    expect(nativeMocks.invoke).toHaveBeenLastCalledWith('plain_markdown', { markdown, parameters });
    expect(api.getStatus()).toBe('idle');
  });

  it('freezes nested instance parameter values while queued and uses a shared object revision', async () => {
    const { api } = await setup();
    const firstNative = deferred<Workspace>();
    nativeMocks.invoke.mockReturnValueOnce(firstNative.promise).mockResolvedValueOnce(workspace(9));
    const first = api.mutate({ type: 'save_attempt', run_id: 'run', step_id: 'step', attempt_id: 'attempt', output_text: 'saved result', note: '' });
    const values = { HOST: 'prod-a', NOTE: '中文\r\nsecond line' };
    const second = api.mutate({ type: 'save_run_draft', id: 'run', markdown: 'echo {{rb:HOST}}', parameters: values });
    values.HOST = 'edited after enqueue';
    await vi.waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledTimes(1));
    firstNative.resolve(workspace(8)); await first; await second;
    expect(received(1).expected_revision).toBe(8);
    expect(received(1).action).toEqual({ type: 'save_run_draft', id: 'run', markdown: 'echo {{rb:HOST}}', parameters: { HOST: 'prod-a', NOTE: '中文\r\nsecond line' } });
  });

  it('retries an unsaved source and parameter buffer together before allowing navigation', async () => {
    const { api } = await setup();
    let pending: { markdown: string; parameters: Record<string, string> } | null = { markdown: 'echo {{rb:HOST}}', parameters: { HOST: 'prod-b' } };
    api.registerFlush(async () => { if (!pending) return; await api.mutate({ type: 'save_run_draft', id: 'run', ...pending }); pending = null; });
    nativeMocks.invoke.mockRejectedValueOnce('disk unavailable').mockResolvedValueOnce(workspace(8));
    await expect(api.flush()).rejects.toThrow('disk unavailable');
    expect(pending?.parameters.HOST).toBe('prod-b');
    await expect(api.flush()).resolves.toBeUndefined();
    expect(pending).toBeNull();
    expect(received(1).action).toEqual({ type: 'save_run_draft', id: 'run', markdown: 'echo {{rb:HOST}}', parameters: { HOST: 'prod-b' } });
  });

  it('a validation error rejects its action but cannot permanently block navigation', async () => {
    const { api } = await setup();
    nativeMocks.invoke.mockRejectedValueOnce('失败或跳过必须填写说明');
    await expect(api.mutate({ type: 'finish_attempt', run_id: 'run', step_id: 'step', attempt_id: 'attempt', outcome: 'failed', output_text: '', note: '' })).rejects.toThrow('必须填写说明');
    expect(api.getStatus()).toBe('error');
    await expect(api.flush()).resolves.toBeUndefined();
    await expect(api.flush()).resolves.toBeUndefined();
  });

  it('serializes mutations and computes the shared run revision at execution time', async () => {
    const { api } = await setup();
    const firstNative = deferred<Workspace>();
    nativeMocks.invoke.mockReturnValueOnce(firstNative.promise).mockResolvedValueOnce(workspace(9));
    const first = api.mutate({ type: 'save_run_draft', id: 'run', markdown: 'new draft' });
    const second = api.mutate({ type: 'save_attempt', run_id: 'run', step_id: 'step', attempt_id: 'attempt', output_text: 'output', note: '' });
    await vi.waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledTimes(1));
    expect(received(0).expected_revision).toBe(7);
    firstNative.resolve(workspace(8));
    await first; await second;
    expect(received(1).expected_revision).toBe(8);
    expect(received(0).operation_id).not.toBe(received(1).operation_id);
    expect(api.getStatus()).toBe('idle');
  });

  it('a failed operation leaves the revision unchanged and permits a later retry', async () => {
    const { api } = await setup();
    nativeMocks.invoke.mockRejectedValueOnce('disk full').mockResolvedValueOnce(workspace(8));
    const action: Action = { type: 'save_run_draft', id: 'run', markdown: 'retained draft' };
    await expect(api.mutate(action)).rejects.toThrow('disk full');
    await expect(api.mutate(action)).resolves.toEqual(workspace(8));
    expect(received(0).expected_revision).toBe(7);
    expect(received(1).expected_revision).toBe(7);
    await expect(api.flush()).resolves.toBeUndefined();
  });

  it('uses template revisions for template writes and no revision for new objects', async () => {
    const { api } = await setup();
    nativeMocks.invoke.mockResolvedValue(workspace());
    await api.mutate({ type: 'save_template', id: 'template', name: 'Template', description: '', markdown: '' });
    await api.mutate({ type: 'create_run', id: 'new-run', template_id: 'template', from_run_id: null, name: 'New', context: '' });
    await api.mutate({ type: 'create_run', id: 'another-run', template_id: null, from_run_id: 'run', name: 'Again', context: '' });
    expect(received(0).expected_revision).toBe(3);
    expect(received(1).expected_revision).toBeNull();
    expect(received(2).expected_revision).toBeNull();
  });

  it('keeps dirty input on save failure, rejects flush, and retries before navigation', async () => {
    const { api } = await setup();
    let dirty: string | null = 'the only copy of this output';
    const unregister = api.registerFlush(async () => {
      if (dirty === null) return;
      await api.mutate({ type: 'save_run_draft', id: 'run', markdown: dirty });
      dirty = null;
    });
    nativeMocks.invoke.mockRejectedValueOnce('database busy').mockResolvedValueOnce(workspace(8));
    await expect(api.flush()).rejects.toThrow('database busy');
    expect(dirty).toBe('the only copy of this output');
    await expect(api.flush()).resolves.toBeUndefined();
    expect(dirty).toBeNull();
    expect(received(1).action).toEqual({ type: 'save_run_draft', id: 'run', markdown: 'the only copy of this output' });
    unregister();
  });

  it('waits for mutations queued while an earlier flush is in progress', async () => {
    const { api } = await setup();
    const firstNative = deferred<Workspace>(); const secondNative = deferred<Workspace>();
    nativeMocks.invoke.mockReturnValueOnce(firstNative.promise).mockReturnValueOnce(secondNative.promise);
    const first = api.mutate({ type: 'save_run_draft', id: 'run', markdown: 'first' });
    let flushed = false; const flush = api.flush().then(() => { flushed = true; });
    const second = api.mutate({ type: 'save_run_draft', id: 'run', markdown: 'second' });
    firstNative.resolve(workspace(8)); await first;
    await vi.waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledTimes(2));
    expect(flushed).toBe(false);
    secondNative.resolve(workspace(9)); await second; await flush;
    expect(flushed).toBe(true);
  });

  it('snapshots queued action data so later caller edits cannot change the submitted payload', async () => {
    const { api } = await setup();
    nativeMocks.invoke.mockResolvedValue(workspace(8));
    const action: Action = { type: 'save_run_draft', id: 'run', markdown: 'submitted' };
    const pending = api.mutate(action); action.markdown = 'edited later';
    await pending;
    expect(received(0).action).toEqual({ type: 'save_run_draft', id: 'run', markdown: 'submitted' });
  });

  it('retains the window after a dirty save failure and closes once a retry succeeds', async () => {
    const { api, installCloseGuard } = await setup();
    let close!: (event: { preventDefault(): void }) => Promise<void>;
    nativeMocks.onCloseRequested.mockImplementationOnce((handler: typeof close) => { close = handler; return Promise.resolve(() => undefined); });
    nativeMocks.destroy.mockResolvedValue(undefined);
    const save = vi.fn().mockRejectedValueOnce(new Error('unsaved')).mockResolvedValueOnce(undefined);
    api.registerFlush(save); const onFailure = vi.fn(); await installCloseGuard(onFailure);
    const event = { preventDefault: vi.fn() };
    await close(event);
    expect(nativeMocks.destroy).not.toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('unsaved'));
    await close(event);
    expect(nativeMocks.destroy).toHaveBeenCalledOnce(); expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });

  it('checks dialog blockers only on close, after autosave, and permits closing after cancellation', async () => {
    const { api, installCloseGuard } = await setup();
    let close!: (event: { preventDefault(): void }) => Promise<void>;
    nativeMocks.onCloseRequested.mockImplementationOnce((handler: typeof close) => { close = handler; return Promise.resolve(() => undefined); });
    nativeMocks.destroy.mockResolvedValue(undefined);
    const order: string[] = [];
    api.registerFlush(async () => { order.push('autosave'); });
    const blocker = vi.fn(() => { order.push('dialog'); throw new Error('追加说明尚未提交，请保存或取消'); });
    const unregister = api.registerCloseBlocker(blocker);
    await expect(api.flush()).resolves.toBeUndefined();
    expect(blocker).not.toHaveBeenCalled();
    order.length = 0;
    const onFailure = vi.fn(); await installCloseGuard(onFailure);
    const event = { preventDefault: vi.fn() };
    await close(event);
    expect(order).toEqual(['autosave', 'dialog']);
    expect(nativeMocks.destroy).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('追加说明尚未提交'));
    unregister();
    await close(event);
    expect(nativeMocks.destroy).toHaveBeenCalledOnce();
  });

  it('awaits asynchronous close blockers before destroying the window', async () => {
    const { api, installCloseGuard } = await setup();
    let close!: (event: { preventDefault(): void }) => Promise<void>;
    nativeMocks.onCloseRequested.mockImplementationOnce((handler: typeof close) => { close = handler; return Promise.resolve(() => undefined); });
    nativeMocks.destroy.mockResolvedValue(undefined);
    const gate = deferred<void>(); const blocker = vi.fn(() => gate.promise);
    api.registerCloseBlocker(blocker); await installCloseGuard(vi.fn());
    const closing = close({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(blocker).toHaveBeenCalledOnce());
    expect(nativeMocks.destroy).not.toHaveBeenCalled();
    gate.resolve(undefined); await closing;
    expect(nativeMocks.destroy).toHaveBeenCalledOnce();
  });
});
