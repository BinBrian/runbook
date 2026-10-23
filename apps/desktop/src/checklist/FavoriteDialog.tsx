import { Bookmark, X } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { api } from './api';
import type { BlockDefinition } from './types';
import { uid } from './model';
import { useExplicitDraft } from './ui-hooks';
import type { RunOperation } from './Timeline';

export interface FavoriteRequest { type: 'favorite'; id: string; stepId?: string; groupId?: string; name: string }
export function FavoriteDialog({ request, favorites, run, busy, onClose, notify, error }: { request: FavoriteRequest; favorites: BlockDefinition[]; run: RunOperation; busy: boolean; onClose: () => void; notify: (text: string) => void; error: string }) {
  const panel = useRef<HTMLElement>(null);
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) cancel(); }
    if (event.key !== 'Tab') return;
    const fields = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? [])];
    if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0]?.focus(); }
  }
  const initial = { name: request.name, replaceId: '' };
  const draft = useExplicitDraft('favorite:' + JSON.stringify([request.id, request.stepId, request.groupId]), initial, '收藏步骤', { kind: 'instance', id: request.id, stepId: request.stepId, groupId: request.groupId, dialog: 'favorite' });
  function cancel() { draft.reset(initial); onClose(); }
  async function save() {
    if (!draft.value.name.trim()) return;
    await run(async () => {
      await api.apply({ type: 'capture_favorite', id: uid(), name: draft.value.name.trim(), sourceId: request.id, stepId: request.stepId ?? null, groupId: request.groupId ?? null, replaceId: draft.value.replaceId || null });
      draft.reset(initial); onClose(); notify(draft.value.replaceId ? '收藏已更新，已有副本保持独立' : '已收藏');
    });
  }
  return <div className="modal-backdrop"><section ref={panel} onKeyDown={keys} className="modal" role="dialog" aria-modal="true" aria-label="收藏步骤"><header><h2><Bookmark size={18} />{request.groupId ? '收藏整个步骤组' : '收藏这一步'}</h2><button className="icon-button" aria-label="取消收藏" onClick={cancel} disabled={busy}><X size={18} /></button></header><div className="modal-body"><label className="field-label">收藏名称<input autoFocus aria-label="收藏名称" value={draft.value.name} disabled={busy} onChange={event => draft.update({ ...draft.value, name: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save(); }} /></label>{favorites.length > 0 && <label className="field-label">保存到<select aria-label="保存到收藏" disabled={busy} value={draft.value.replaceId} onChange={event => draft.update({ ...draft.value, replaceId: event.target.value })}><option value="">另存一份收藏</option>{favorites.map(item => <option key={item.id} value={item.id}>更新已有收藏：{item.name}</option>)}</select></label>}<p className="modal-description">保存流程内容和变量默认值。执行记录、评论和图片留在原工作。</p>{error && <p className="field-error" role="alert">{error}</p>}</div><footer><button className="button" onClick={cancel} disabled={busy}>取消</button><button className="button primary" onClick={() => void save()} disabled={busy || !draft.value.name.trim()}>{draft.value.replaceId ? '更新收藏' : '保存收藏'}</button></footer></section></div>;
}
