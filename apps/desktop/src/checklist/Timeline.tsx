import { useEffect, useRef, useState } from 'react';
import { ChevronRight, ImagePlus, MessageSquare, Pencil, Trash2, X } from 'lucide-react';
import { api } from './api';
import { formatTime, outcomeLabels, uid, visibleParameters } from './model';
import type { CommentEntry, ImageEntry, Instance, Parameter, ResultEntry } from './types';
import { useExplicitDraft } from './ui-hooks';
import './image-preview.css';

export type RunOperation = (operation: () => Promise<unknown>) => Promise<boolean>;
function ResultSnapshot({ entry, copy, parameters, current = false }: { entry: ResultEntry; copy: (text: string) => void; parameters: Parameter[]; current?: boolean }) {
  return <details className="snapshot-details" data-current-failure-snapshot={current || undefined}><summary>{current ? '失败时的内容与参数' : '当时的内容与参数'}</summary><strong>{entry.snapshot.title}</strong><p>{entry.snapshot.description}</p>{entry.snapshot.commands.map(command => <div className="snapshot-command" key={command.id}><pre>{command.text}</pre><button className="text-button" onClick={() => copy(command.text)}>复制当时命令</button></div>)}<dl>{Object.entries(entry.snapshot.parameterValues).filter(([key]) => parameters.some(parameter => parameter.id === key)).map(([key, value]) => <div key={key}><dt>{parameters.find(parameter => parameter.id === key)?.name ?? '变量'}</dt><dd>{value || '（空）'}</dd></div>)}</dl></details>;
}
function ResultRecord({ entry, copy, parameters }: { entry: ResultEntry; copy: (text: string) => void; parameters: Parameter[] }) {
  return <details className={`result-record old ${entry.outcome}`}><summary className="result-record-heading"><span className={`result-dot ${entry.outcome}`} /><strong>{outcomeLabels[entry.outcome]}</strong><time>{formatTime(entry.at)}</time></summary><div className="result-record-body">{entry.reason && <p className="reason-text">{entry.reason}</p>}<ResultSnapshot entry={entry} copy={copy} parameters={parameters} /></div></details>;
}
function CommentRecord({ entry, instanceId, run, busy }: { entry: CommentEntry; instanceId: string; run: RunOperation; busy: boolean }) {
  const draft = useExplicitDraft(`edit-comment:${instanceId}:${entry.id}`, entry.text, '评论编辑', { kind: 'instance', id: instanceId, stepId: entry.stepId });
  const [editing, setEditing] = useState(draft.dirty);
  const text = draft.value;
  const setText = draft.update;
  return <div className="comment-record"><div className="entry-heading"><MessageSquare size={13} /><span>评论</span><time>{formatTime(entry.at)}{entry.editedAt ? ' · 已编辑' : ''}</time><button className="icon-button" title="编辑评论" disabled={busy} onClick={() => { draft.reset(entry.text); setEditing(true); }}><Pencil size={13} /></button><button className="icon-button" title="删除评论" disabled={busy} onClick={() => void run(async () => { await api.apply({ type: 'delete_entry', id: instanceId, entryId: entry.id }); draft.reset(entry.text); })}><Trash2 size={13} /></button></div>{editing ? <div className="comment-edit"><textarea aria-label="编辑评论" disabled={busy} value={text} onChange={event => setText(event.target.value)} /><div className="inline-actions"><button className="button small primary" disabled={busy || !text.trim()} onClick={() => void run(async () => { await api.apply({ type: 'edit_comment', id: instanceId, entryId: entry.id, text }); draft.reset(text); setEditing(false); })}>保存评论</button><button className="button small" disabled={busy} onClick={() => { draft.reset(entry.text); setEditing(false); }}>取消</button></div></div> : <p>{entry.text}</p>}</div>;
}
function ImageRecord({ entry, instanceId, run, busy }: { entry: ImageEntry; instanceId: string; run: RunOperation; busy: boolean }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState('');
  const [expanded, setExpanded] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { let active = true; void api.readImage(instanceId, entry.path).then(value => { if (active) setSrc(value); }).catch(error => { if (active) setFailed(String(error)); }); return () => { active = false; }; }, [instanceId, entry.path]);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement;
    closeButton.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [expanded]);
  return <div className="image-record"><div className="entry-heading"><ImagePlus size={13} /><span>图片</span><time>{formatTime(entry.at)}</time><button className="icon-button" title="删除图片" disabled={busy} onClick={() => void run(() => api.apply({ type: 'delete_entry', id: instanceId, entryId: entry.id }))}><Trash2 size={13} /></button></div>{src ? <button className="image-preview" onClick={() => setExpanded(true)} title="查看完整图片"><img src={src} alt={entry.caption || '步骤附件'} /></button> : <p className="hint">{failed || '图片加载中…'}</p>}{entry.caption && <p>{entry.caption}</p>}{expanded && <div className="image-lightbox" onClick={() => setExpanded(false)} role="dialog" aria-modal="true" aria-label="图片预览" onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); } else if (event.key === 'Tab') { event.preventDefault(); closeButton.current?.focus(); } }}><button ref={closeButton} className="lightbox-close image-preview-close" type="button" aria-label="关闭图片" title="关闭图片" onClick={() => setExpanded(false)}><X size={23} aria-hidden="true" /></button><img src={src} alt={entry.caption || '步骤附件'} /></div>}</div>;
}
export function Timeline({ instance, stepId, run, copy, busy }: { instance: Instance; stepId: string; run: RunOperation; copy: (text: string) => void; busy: boolean }) {
  const allEntries = instance.entries.filter(entry => entry.stepId === stepId);
  const latest = allEntries.filter(entry => entry.type === 'result').at(-1);
  const entries = allEntries.filter(entry => entry.id !== latest?.id);
  const comment = useExplicitDraft(`comment:${instance.id}:${stepId}`, '', '步骤评论', { kind: 'instance', id: instance.id, stepId });
  const input = useRef<HTMLInputElement>(null);
  async function attach(file: File) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片。');
    if (file.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MiB。');
    await api.attachImage(instance.id, stepId, file.name || 'clipboard.png', file.type, Array.from(new Uint8Array(await file.arrayBuffer())));
  }
  return <div className="timeline" onPaste={event => { const file = [...event.clipboardData.files].find(value => value.type.startsWith('image/')); if (file) { event.preventDefault(); void run(() => attach(file)); } }}>
    {entries.length > 0 && <div className="timeline-title">步骤记录<span>{entries.length}</span></div>}
    <div className="entry-list">{entries.map(entry => entry.type === 'result' ? <ResultRecord key={entry.id} entry={entry} copy={copy} parameters={visibleParameters(instance.document, stepId)} /> : entry.type === 'comment' ? <CommentRecord key={entry.id} entry={entry} instanceId={instance.id} run={run} busy={busy} /> : <ImageRecord key={entry.id} entry={entry} instanceId={instance.id} run={run} busy={busy} />)}</div>
    {latest?.outcome === 'failed' && <ResultSnapshot entry={latest} copy={copy} parameters={visibleParameters(instance.document, stepId)} current />}
    <details className="comment-details"><summary><ChevronRight size={14} />补充记录{comment.dirty && <small>有未提交评论</small>}</summary><div className="comment-composer"><textarea aria-label="添加评论" disabled={busy} placeholder="补充评论、粘贴外部输出，或直接粘贴图片…" value={comment.value} onChange={event => comment.update(event.target.value)} rows={2} /><div className="composer-actions"><input ref={input} disabled={busy} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { const file = event.target.files?.[0]; if (file) void run(() => attach(file)); event.target.value = ''; }} /><button className="text-button" disabled={busy} onClick={() => input.current?.click()}><ImagePlus size={15} />添加图片</button>{comment.dirty && <button className="text-button" disabled={busy} onClick={() => comment.reset('')}>清空</button>}<button className="button small" disabled={busy || !comment.value.trim()} onClick={() => void run(async () => { await api.apply({ type: 'add_comment', id: instance.id, stepId, entryId: uid(), text: comment.value }); comment.reset(''); })}><MessageSquare size={13} />添加评论</button></div></div></details>
  </div>;
}
