import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export function VariableDeleteDialog({ items, referenceCount, emptyReferenceCount, pendingCount, error, onCancel, onConfirm }: {
  items: { id: string; name: string; scope: string }[];
  referenceCount: number;
  emptyReferenceCount: number;
  pendingCount: number;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div className="modal-backdrop variable-delete-backdrop" data-variable-panel onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label="删除变量" onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      if (event.key === 'Tab') {
        const choices = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const first = choices[0], last = choices.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><h2>删除 {items.length} 个变量</h2><button className="icon-button" type="button" aria-label="关闭删除确认" onClick={onCancel}><X size={18} /></button></header>
      <div className="modal-body">
        <p>{referenceCount ? `${referenceCount} 处引用将替换为当前生效文本。` : '所选变量没有正文引用。'}</p>
        {emptyReferenceCount > 0 && <p className="variable-delete-warning">其中 {emptyReferenceCount} 处引用没有生效值，将移除。</p>}
        {pendingCount > 0 && <p className="variable-delete-warning">其中 {pendingCount} 个变量有未应用修改，删除时一并放弃。</p>}
        <ul className="variable-delete-list">{items.map(item => <li key={item.id}><strong>{item.name}</strong><span>{item.scope}</span></li>)}</ul>
        {error && <p className="variable-form-error" role="alert">{error}</p>}
      </div>
      <footer><button ref={cancel} type="button" className="button" onClick={onCancel}>取消</button><button type="button" className="button danger" disabled={!items.length} onClick={onConfirm}>确认删除</button></footer>
    </section>
  </div>, document.body);
}
