import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CloseFailure } from './api';

/** Only a real write failure needs a decision; unapplied inputs are local drafts. */
export function CloseFailureDialog({ failure, onCancel }: { failure: CloseFailure; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { cancel.current?.focus(); }, []);
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onCancel(); }
    if (event.key !== 'Tab') return;
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
  }
  async function close(discard: boolean) {
    if (busy) return; setBusy(true); setError('');
    try { await (discard ? failure.discard() : failure.retry()); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section className="modal" ref={panel} role="alertdialog" aria-modal="true" aria-label="关闭前保存失败" onKeyDown={keys}><header><h2>有内容尚未保存</h2></header><div className="modal-body"><p>{failure.message}</p><p className="modal-description">可以重试保存，或仍然关闭。仍然关闭会放弃未能保存的更改，已保存的流程和记录保留。</p>{error && <p className="field-error">{error}</p>}</div><footer><button ref={cancel} className="button" disabled={busy} onClick={onCancel}>返回编辑</button><button className="button danger" disabled={busy} onClick={() => void close(true)}>仍然关闭</button><button className="button primary" disabled={busy} onClick={() => void close(false)}>重试并关闭</button></footer></section></div>;
}
