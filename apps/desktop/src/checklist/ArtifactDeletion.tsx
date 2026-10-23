import { useEffect, useRef, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { api } from './api';
import { assertArtifactDraftsSaved } from './ui-hooks';
import type { ArtifactKind } from './types';
import type { RunOperation } from './Timeline';

export interface DeletionTarget { kind: ArtifactKind; id: string; name: string }
const labels = { template: '模板', instance: '工作', block: '收藏' };

/** Called after the normal save barrier so confirmation names the saved object. */
export function deletionTarget(kind: ArtifactKind, id: string): DeletionTarget {
  assertArtifactDraftsSaved(kind, id);
  const workspace = api.getWorkspace();
  const item = (kind === 'template' ? workspace.templates : kind === 'instance' ? workspace.instances : workspace.blocks ?? []).find(item => item.id === id);
  if (!item) throw new Error(`找不到${labels[kind]}，请返回列表重新打开。`);
  return { kind, id, name: item.name };
}

export function ArtifactDeletionDialog({ target, run, busy, error, onClose, onDeleted, notify }: {
  target: DeletionTarget; run: RunOperation; busy: boolean; error: string;
  onClose: () => void; onDeleted: () => void; notify: (text: string) => void;
}) {
  const panel = useRef<HTMLElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const label = labels[target.kind];
  const verb = target.kind === 'block' ? '移除' : '删除';
  useEffect(() => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restore = active?.closest('details')?.querySelector<HTMLElement>('summary') ?? active;
    return () => { if (restore?.isConnected) restore.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    if (busy && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
    else if (!busy && (document.activeElement === node || !node.contains(document.activeElement))) cancel.current?.focus({ preventScroll: true });
  }, [busy]);
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); return; }
    if (event.key !== 'Tab') return;
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) { event.preventDefault(); panel.current?.focus({ preventScroll: true }); return; }
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  async function remove() {
    await run(async () => {
      assertArtifactDraftsSaved(target.kind, target.id);
      await api.apply({ type: target.kind === 'template' ? 'delete_template' : target.kind === 'instance' ? 'delete_instance' : 'delete_block', id: target.id });
      onDeleted(); onClose(); notify(`${label}已${verb}`);
    });
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={panel} className="modal" tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${verb}${label}`} onKeyDown={keys}>
      <header><div><span className="eyebrow">RUNBOOK</span><h2>{verb}{label}</h2></div><button className="icon-button" title="取消" aria-label="关闭删除确认" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <div className="modal-body"><p className="modal-description">{verb}“{target.name}”？</p><p className="modal-description">{target.kind === 'instance' ? '将删除这份工作的流程、参数、执行记录、评论和图片，删除后无法在本机恢复。其他工作记录保持不变。' : '仅移除此收藏，工作中已插入的副本仍然保留。'}</p>{error && <p className="field-error">{error}</p>}</div>
      <footer><button ref={cancel} className="button" disabled={busy} onClick={onClose}>取消</button><button className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? '正在保存…' : `确认${verb}${label}`}</button></footer>
    </section>
  </div>;
}
