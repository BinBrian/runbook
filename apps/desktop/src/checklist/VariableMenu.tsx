import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export interface VariableMenuItem { label: string; disabled?: boolean; reason?: string; danger?: boolean; action: (trigger: HTMLButtonElement) => void }
export function VariableMenu({ label, title, scope, items, add = false, disabled = false }: { label: string; title?: string; scope?: string; items: VariableMenuItem[]; add?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  function close(focus = true) { setOpen(false); if (focus) trigger.current?.focus({ preventScroll: true }); }
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    function reposition() {
      if (!trigger.current || !menu.current) return;
      const a = trigger.current.getBoundingClientRect(), m = menu.current.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(a.right - m.width, innerWidth - m.width - 8)), top: Math.max(8, Math.min(a.bottom + 5, innerHeight - m.height - 8)) });
    }
    reposition();
    menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    function outside(event: PointerEvent) { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false); }
    function scroll(event: Event) { if (event.target instanceof Node && trigger.current && event.target.contains(trigger.current)) reposition(); }
    function gesture(event: Event) { const area = trigger.current?.closest('.variable-panel'); if (event.target instanceof Node && area?.contains(event.target)) close(false); }
    function resize() { close(false); }
    const frame = requestAnimationFrame(reposition);
    window.document.addEventListener('pointerdown', outside, true); window.document.addEventListener('scroll', scroll, true); window.document.addEventListener('wheel', gesture, { capture: true, passive: true }); window.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(frame); window.document.removeEventListener('pointerdown', outside, true); window.document.removeEventListener('scroll', scroll, true); window.document.removeEventListener('wheel', gesture, true); window.removeEventListener('resize', resize); };
  }, [open]);
  function keys(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const choices = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])], at = choices.indexOf(window.document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    choices[next]?.focus();
  }
  return <><button ref={trigger} className="icon-button variable-menu-trigger" type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => setOpen(!open)}>{add ? '+' : <MoreHorizontal size={15} />}</button>{open && createPortal(<div ref={menu} className="step-action-menu variable-action-menu" data-variable-panel role="menu" aria-label={label} style={position} onKeyDown={keys}>{title && <div className="variable-menu-heading" role="presentation"><strong>{title}</strong>{scope && <small>{scope}</small>}</div>}{items.map(item => <button role="menuitem" aria-label={item.label} aria-description={item.reason} key={item.label} disabled={item.disabled} title={item.reason} className={item.danger ? 'destructive-menuitem' : undefined} onClick={() => { const node = trigger.current; close(); if (node) item.action(node); }}><span><strong>{item.label}</strong>{item.disabled && item.reason && <small>{item.reason}</small>}</span></button>)}</div>, window.document.body)}</>;
}
