import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, Workspace, WorkLoad } from './types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), isTauri: vi.fn(() => true), writeText: vi.fn(), destroy: vi.fn(), onCloseRequested: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ destroy: mocks.destroy, onCloseRequested: mocks.onCloseRequested }) }));
vi.mock('@runbook/desktop-api', () => ({ writeClipboardText: mocks.writeText }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const blank = (): Workspace => ({ templates: [], instances: [] });
const loaded = (workspace = blank()): WorkLoad => ({ workspace, convertedTemplates: {} });
type Module = typeof import('./api');
let subject: Module;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockImplementation(async command => command === 'checklist_load_work' ? loaded() : blank());
  mocks.writeText.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.onCloseRequested.mockResolvedValue(() => undefined);
  subject = await import('./api');
});

describe('native request serialization', () => {
  it('sends saved action snapshots in order and publishes only acknowledged workspaces', async () => {
    const gate = deferred<WorkLoad>();
    const next = { templates: [], instances: [{ id: 'saved-second' }] } as unknown as Workspace;
    mocks.invoke.mockImplementationOnce(() => gate.promise).mockResolvedValueOnce(next);
    const updates = vi.fn();
    subject.api.subscribe(updates);
    const first = subject.api.load();
    const action: Action = { type: 'apply_parameters', id: 'instance', values: { version: '0.1.1' } };
    const second = subject.api.apply(action);
    action.values.version = 'MUTATED AFTER SUBMIT';
    await tick();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(subject.api.getStatus()).toBe('saving');
    expect(updates).not.toHaveBeenCalled();
    gate.resolve(loaded());
    await Promise.all([first, second]);
    expect(mocks.invoke.mock.calls).toEqual([
      ['checklist_load_work'], ['checklist_apply', { action: { type: 'apply_parameters', id: 'instance', values: { version: '0.1.1' } } }],
    ]);
    expect(subject.api.getWorkspace()).toBe(next);
    expect(updates).toHaveBeenCalledTimes(2);
    expect(subject.api.getStatus()).toBe('idle');
  });

  it('rejects a failed request without poisoning subsequent requests or publishing phantom changes', async () => {
    const original = blank();
    await subject.api.load();
    const updates = vi.fn();
    subject.api.subscribe(updates);
    mocks.invoke.mockRejectedValueOnce(new Error('失败原因不能为空'));
    await expect(subject.api.apply({ type: 'record_result', id: 'instance', outcome: 'failed', reason: '' })).rejects.toThrow('失败原因不能为空');
    expect(subject.api.getWorkspace()).toEqual(original);
    expect(updates).not.toHaveBeenCalled();
    expect(subject.api.getStatus()).toBe('error');
    const next = { templates: [{ id: 'acknowledged' }], instances: [] } as unknown as Workspace;
    mocks.invoke.mockResolvedValueOnce(loaded(next));
    await subject.api.load();
    expect(subject.api.getWorkspace()).toBe(next);
    expect(subject.api.getStatus()).toBe('idle');
  });

  it('waits for requests appended while the flush barrier is draining', async () => {
    const first = deferred<Workspace>(), second = deferred<WorkLoad>();
    mocks.invoke.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const save = subject.api.apply({ type: 'archive_instance', id: 'instance', archived: true });
    let finished = false;
    const flushing = subject.api.flush().then(() => { finished = true; });
    await tick();
    const appended = subject.api.load();
    first.resolve(blank());
    await tick();
    expect(finished).toBe(false);
    second.resolve(loaded());
    await Promise.all([save, appended, flushing]);
    expect(finished).toBe(true);
  });

  it('rejects desktop mutations in a plain browser before invoking native commands', async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(subject.api.load()).rejects.toThrow('Windows 桌面程序');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('passes block actions and block archive operations through the same acknowledged queue', async () => {
    const action: Action = { type: 'create_block', id: 'restart', name: '更新重启服务', document: {
      groups: [{ id: 'restart-group', name: '更新重启服务' }],
      parameters: [{ id: 'local-env', ownerId: 'restart-group', name: '环境', description: '', defaultValue: 'sandboxa' }],
      steps: [{ id: 'stop', groupId: 'restart-group', title: ['停止'], description: [], commands: [{ id: 'stop-command', text: ['stopserver ', { parameterId: 'local-env' }, ' all'] }] }],
    } };
    const saved: Workspace = { templates: [], instances: [], blocks: [{ formatVersion: 2, kind: 'block',
      id: action.id, name: action.name, document: structuredClone(action.document), createdAt: '2026-10-20T01:00:00Z', updatedAt: '2026-10-20T01:00:00Z' }] };
    mocks.invoke.mockResolvedValueOnce(saved).mockResolvedValueOnce({ name: 'restart.runbook.json', bytes: [123, 125] })
      .mockResolvedValueOnce({ token: 'preview-block', kind: 'block', id: 'restart', name: action.name, duplicate: true });
    const applying = subject.api.apply(action);
    action.document.parameters[0].defaultValue = 'MUTATED AFTER SUBMIT';
    await applying;
    const file = await subject.api.exportData('block', 'restart');
    const preview = await subject.api.previewImport(file.name, file.bytes);
    expect(mocks.invoke.mock.calls[0][1].action.document.parameters[0].defaultValue).toBe('sandboxa');
    expect(mocks.invoke.mock.calls[1]).toEqual(['checklist_export_data', { kind: 'block', id: 'restart' }]);
    expect(mocks.invoke.mock.calls[2]).toEqual(['checklist_preview_import', { name: 'restart.runbook.json', bytes: [123, 125] }]);
    expect(preview.kind).toBe('block');
    expect(subject.api.getWorkspace()).toBe(saved);
  });
});

describe('dirty edit and close protection', () => {
  it('blocks copying when a dirty editor fails to flush, then copies only after a successful retry', async () => {
    const saved = deferred<void>();
    const flusher = vi.fn().mockRejectedValueOnce(new Error('disk is full')).mockImplementationOnce(() => saved.promise);
    const unregister = subject.api.registerFlush(flusher);
    await expect(subject.api.copy('echo recorded only')).rejects.toThrow('disk is full');
    expect(mocks.writeText).not.toHaveBeenCalled();
    const copying = subject.api.copy('echo recorded only');
    await tick();
    expect(mocks.writeText).not.toHaveBeenCalled();
    saved.resolve();
    await copying;
    expect(mocks.writeText).toHaveBeenCalledWith('echo recorded only');
    unregister();
    await subject.api.flush();
    expect(flusher).toHaveBeenCalledTimes(2);
  });

  it('keeps the window alive on a dirty-save error and retries the same edit on the next close request', async () => {
    const flusher = vi.fn().mockRejectedValueOnce(new Error('cannot persist edit')).mockResolvedValueOnce(undefined);
    subject.api.registerFlush(flusher);
    const onError = vi.fn();
    await subject.installCloseGuard(onError);
    const onClose = mocks.onCloseRequested.mock.calls[0][0] as (event: { preventDefault: () => void }) => Promise<void>;
    const event = { preventDefault: vi.fn() };
    await onClose(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('cannot persist edit'), retry: expect.any(Function), discard: expect.any(Function) }));
    await onClose(event);
    expect(flusher).toHaveBeenCalledTimes(2);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it('waits for local draft persistence and suppresses overlapping close attempts', async () => {
    const gate = deferred<void>();
    const blocker = vi.fn().mockRejectedValueOnce(new Error('本地草稿写入失败')).mockImplementationOnce(() => gate.promise);
    subject.api.registerCloseSave(blocker);
    const onError = vi.fn();
    await subject.installCloseGuard(onError);
    const onClose = mocks.onCloseRequested.mock.calls[0][0] as (event: { preventDefault: () => void }) => Promise<void>;
    const event = { preventDefault: vi.fn() };
    await onClose(event);
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('本地草稿写入失败') }));
    const closing = onClose(event);
    await tick();
    await onClose(event);
    expect(blocker).toHaveBeenCalledTimes(2);
    gate.resolve();
    await closing;
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it('lets the user explicitly close after a real save failure', async () => {
    subject.api.registerFlush(async () => { throw new Error('disk full'); });
    const onFailure = vi.fn();
    await subject.installCloseGuard(onFailure);
    await mocks.onCloseRequested.mock.calls[0][0]({ preventDefault: vi.fn() });
    expect(mocks.destroy).not.toHaveBeenCalled();
    await onFailure.mock.calls[0][0].discard();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
