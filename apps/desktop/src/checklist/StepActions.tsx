import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ArrowDown, ArrowUp, Bookmark, Copy, Layers, MoreHorizontal, Plus, Save, Terminal, Trash2, X } from 'lucide-react';
import type { BlockDefinition } from './types';

type StructureKind = 'step' | 'group';
type StructureItem = { key: string; name: string; icon: typeof Plus; handler?: () => void; reason?: string; picker?: boolean; destructive?: boolean };
interface StructureBase { object?: StructureKind; disabled?: boolean; disabledReason?: string }
export interface StepActionsProps extends StructureBase {
  onAdd?: () => void;
  onAddChild?: () => void;
  onAddCommand?: () => void;
  onInsert?: (block: BlockDefinition) => void;
  blocks?: BlockDefinition[];
  addDisabledReason?: string;
  addChildDisabledReason?: string;
  insertDisabledReason?: string;
}
export interface StepMoreActionsProps extends StructureBase {
  onFavorite?: () => void;
  readOnly?: boolean;
  onDuplicate?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onConvert?: () => void;
  onSaveBlock?: () => void;
  onRemove?: () => void;
  duplicateDisabledReason?: string;
  moveUpDisabledReason?: string;
  moveDownDisabledReason?: string;
  convertDisabledReason?: string;
  saveDisabledReason?: string;
  removeDisabledReason?: string;
}

type Mode = 'closed' | 'menu' | 'blocks';
function positionMenu(anchor: DOMRect, height: number, width: number) {
  const gap = 8, margin = 10;
  const left = Math.max(margin, Math.min(anchor.right + gap, window.innerWidth - width - margin));
  const below = anchor.top;
  const top = Math.max(margin, Math.min(below + height <= window.innerHeight - margin ? below : anchor.bottom - height, window.innerHeight - height - margin));
  return { left, top };
}
function layoutSize(element: HTMLElement) { return `${element.scrollHeight}:${element.clientHeight}:${element.scrollWidth}:${element.clientWidth}`; }
type ScrollLayout = { size: string; top: number; left: number };
function layoutState(element: HTMLElement): ScrollLayout { return { size: layoutSize(element), top: element.scrollTop, left: element.scrollLeft }; }
function ancestorLayout(trigger: HTMLElement) {
  const layout = new Map<HTMLElement, ScrollLayout>();
  for (let node = trigger.parentElement; node; node = node.parentElement) layout.set(node, layoutState(node));
  return layout;
}
function scrollFromLayout(target: Node, layout: Map<HTMLElement, ScrollLayout>) {
  const element = target instanceof Document ? target.scrollingElement : target;
  if (!(element instanceof HTMLElement)) return false;
  const before = layout.get(element), after = layoutState(element);
  layout.set(element, after);
  // A queued scroll can arrive after the RAF already measured its new offset.
  return before !== undefined && (before.size !== after.size || (before.top === after.top && before.left === after.left));
}
function scrollGestureWithin(target: EventTarget | null, trigger: HTMLElement | null) {
  if (!(target instanceof Node) || !trigger) return false;
  for (let node = trigger.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`) && node.contains(target)) return true;
  }
  return false;
}

export function StepActions({ object = 'step', onAdd, onAddChild, onAddCommand, onInsert, blocks = [], disabled, disabledReason, addDisabledReason, addChildDisabledReason, insertDisabledReason }: StepActionsProps) {
  const group = object === 'group';
  const insertReason = insertDisabledReason ?? (!onInsert ? '此处不能插入收藏的步骤' : !blocks.length ? '还没有收藏的步骤' : undefined);
  const items: StructureItem[] = group ? [
    { key: 'child', name: '添加子步骤', icon: Plus, handler: onAddChild, reason: addChildDisabledReason ?? (!onAddChild ? '此组不能添加子步骤' : undefined) },
    { key: 'add', name: '组后新增步骤', icon: Plus, handler: onAdd, reason: addDisabledReason ?? (!onAdd ? '此处不能新增组外步骤' : undefined) },
    { key: 'insert', name: '组后插入收藏的步骤', icon: Layers, picker: true, handler: onInsert ? () => {} : undefined, reason: insertReason },
  ] : [
    { key: 'add', name: '新增后续步骤', icon: Plus, handler: onAdd, reason: addDisabledReason ?? (!onAdd ? '此处不能新增后续步骤' : undefined) },
    { key: 'command', name: '添加命令', icon: Terminal, handler: onAddCommand, reason: !onAddCommand ? '此步骤不能添加命令' : undefined },
    { key: 'insert', name: '插入收藏的步骤', icon: Layers, picker: true, handler: onInsert ? () => {} : undefined, reason: insertReason },
  ];
  return <StructureMenu variant="add" label={group ? '步骤组新增' : '步骤新增'} items={items} blocks={blocks} onInsert={onInsert} disabled={disabled} disabledReason={disabledReason} />;
}
export function StepMoreActions({ object = 'step', onDuplicate, onMoveUp, onMoveDown, onConvert, onSaveBlock, onRemove, onFavorite, readOnly, disabled, disabledReason, duplicateDisabledReason, moveUpDisabledReason, moveDownDisabledReason, convertDisabledReason, saveDisabledReason, removeDisabledReason }: StepMoreActionsProps) {
  const group = object === 'group';
  const items: StructureItem[] = [
    { key: 'duplicate', name: group ? '复制步骤组' : '复制当前步骤', icon: Copy, handler: onDuplicate, reason: duplicateDisabledReason ?? (!onDuplicate ? '此处不能复制' : undefined) },
    { key: 'up', name: group ? '上移步骤组' : '上移步骤', icon: ArrowUp, handler: onMoveUp, reason: moveUpDisabledReason ?? (!onMoveUp ? '已到当前可调整范围的开头' : undefined) },
    { key: 'down', name: group ? '下移步骤组' : '下移步骤', icon: ArrowDown, handler: onMoveDown, reason: moveDownDisabledReason ?? (!onMoveDown ? '已到当前可调整范围的结尾' : undefined) },
    group ? { key: 'save', name: '收藏整个步骤组', icon: Bookmark, handler: onFavorite ?? onSaveBlock, reason: saveDisabledReason ?? (!onSaveBlock && !onFavorite ? '此处不能收藏' : undefined) } :
      { key: 'convert', name: '转为步骤组', icon: Layers, handler: onConvert, reason: convertDisabledReason ?? (!onConvert ? '当前步骤不能转组或已经属于步骤组' : undefined) },
    { key: 'remove', name: group ? '删除步骤组及子步骤' : '删除当前步骤', icon: Trash2, handler: onRemove, destructive: true, reason: removeDisabledReason ?? (!onRemove ? group ? '当前组不能删除' : '当前步骤不能删除' : undefined) },
  ];
  const favorite = { key: 'favorite', name: group ? '收藏整个步骤组' : '收藏这一步', icon: Bookmark, handler: onFavorite };
  if (!group && onFavorite) items.splice(items.length - 1, 0, favorite);
  return <StructureMenu variant="more" label={group ? '更多步骤组操作' : '更多步骤操作'} items={readOnly ? [favorite] : items} disabled={disabled} disabledReason={disabledReason} />;
}

/** Structure menus share one focus, positioning and layout-scroll contract. */
function StructureMenu({ variant, label, items, blocks = [], onInsert, disabled = false, disabledReason }: { variant: 'add' | 'more'; label: string; items: StructureItem[]; blocks?: BlockDefinition[]; onInsert?: (block: BlockDefinition) => void; disabled?: boolean; disabledReason?: string }) {
  const [mode, setMode] = useState<Mode>('closed');
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ left: 10, top: 10 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), picker = useRef<HTMLElement>(null);
  const initialLast = useRef(false), layout = useRef(new Map<HTMLElement, ScrollLayout>());
  const identity = useId(), menuId = `${identity}-menu`, pickerId = `${identity}-picker`, pickerTitle = `${identity}-picker-title`;
  function close(restore = true) {
    flushSync(() => setMode('closed'));
    if (restore && trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus({ preventScroll: true });
  }
  function open(last = false) {
    if (disabled || !trigger.current) return;
    layout.current = ancestorLayout(trigger.current); initialLast.current = last;
    setPosition(positionMenu(trigger.current.getBoundingClientRect(), 180, Math.min(232, window.innerWidth - 20))); setMode('menu');
  }
  function activate(handler: () => void) { close(); handler(); }
  useLayoutEffect(() => {
    if (mode === 'menu' && menu.current && trigger.current) {
      function reposition() { if (menu.current && trigger.current) { const rect = menu.current.getBoundingClientRect(); setPosition(positionMenu(trigger.current.getBoundingClientRect(), rect.height, rect.width)); } }
      reposition();
      const choices = [...menu.current.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];
      (initialLast.current ? choices.at(-1) : choices[0])?.focus({ preventScroll: true });
      if (!choices.length) menu.current.focus({ preventScroll: true });
      const frame = requestAnimationFrame(() => { reposition(); if (trigger.current) layout.current = ancestorLayout(trigger.current); });
      return () => cancelAnimationFrame(frame);
    }
    if (mode === 'blocks') (picker.current?.querySelector<HTMLInputElement>('input') ?? picker.current?.querySelector<HTMLButtonElement>('[data-step-action-block-id]') ?? picker.current?.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true });
  }, [mode]);
  useEffect(() => {
    if (mode === 'closed') return;
    function outside(event: PointerEvent) { const target = event.target; if (target instanceof Node && !trigger.current?.contains(target) && !menu.current?.contains(target) && !picker.current?.contains(target)) close(); }
    function escape(event: globalThis.KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }
    function scroll(event: Event) {
      if (mode !== 'menu' || !trigger.current || !(event.target instanceof Node) || !event.target.contains(trigger.current)) return;
      if (scrollFromLayout(event.target, layout.current) && menu.current) { const rect = menu.current.getBoundingClientRect(); setPosition(positionMenu(trigger.current.getBoundingClientRect(), rect.height, rect.width)); return; }
      close();
    }
    function gesture(event: Event) { if (mode === 'menu' && scrollGestureWithin(event.target, trigger.current)) close(); }
    function resize() { close(); }
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true); document.addEventListener('scroll', scroll, true);
    document.addEventListener('wheel', gesture, { capture: true, passive: true }); document.addEventListener('touchmove', gesture, { capture: true, passive: true }); window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); document.removeEventListener('scroll', scroll, true); document.removeEventListener('wheel', gesture, true); document.removeEventListener('touchmove', gesture, true); window.removeEventListener('resize', resize); };
  }, [mode]);
  useEffect(() => { if (disabled) setMode('closed'); }, [disabled]);
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const choices = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    if (!choices.length) return;
    const current = choices.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    choices[index]?.focus({ preventScroll: true });
  }
  function pickerKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const choices = [...(picker.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])], first = choices[0], last = choices.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  const Icon = variant === 'add' ? Plus : MoreHorizontal;
  return <div className={`${variant === 'add' ? 'step-actions' : 'structure-more-actions'} ${mode !== 'closed' ? 'is-open' : ''}`} data-step-actions={variant === 'add' ? '' : undefined} data-step-more-actions={variant === 'more' ? '' : undefined}>
    <button ref={trigger} className={variant === 'add' ? 'insert-step' : 'icon-button'} type="button" title={disabledReason ?? label} aria-label={label} aria-haspopup="menu" aria-expanded={mode === 'menu'} aria-controls={mode === 'menu' ? menuId : undefined} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => mode === 'closed' ? open() : close()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(event.key === 'ArrowUp'); } }}><Icon size={16} /></button>
    {mode === 'menu' && createPortal(<div id={menuId} ref={menu} tabIndex={-1} className="step-action-menu structure-action-menu" role="menu" aria-label={label} onKeyDown={menuKeys} style={position}>{items.map(item => <button key={item.key} className={item.destructive ? 'destructive-menuitem' : undefined} type="button" role="menuitem" aria-label={item.name} aria-description={item.reason} disabled={Boolean(item.reason) || !item.handler} title={item.reason ?? item.name} onClick={() => { if (item.picker) { setQuery(''); flushSync(() => setMode('blocks')); } else if (item.handler) activate(item.handler); }}><item.icon size={16} /><span><strong>{item.name}</strong>{item.reason && <small>{item.reason}</small>}</span></button>)}</div>, document.body)}
    {mode === 'blocks' && createPortal(<div className="modal-backdrop step-action-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section ref={picker} id={pickerId} className="modal step-action-picker" role="dialog" aria-modal="true" aria-labelledby={pickerTitle} onKeyDown={pickerKeys}><header><div><span className="eyebrow">复用流程，独立编辑</span><h2 id={pickerTitle}>插入收藏的步骤</h2></div><button className="icon-button" type="button" title="取消" aria-label="取消" onClick={() => close()}><X size={18} /></button></header><div className="modal-body"><p className="modal-description">插入后拥有独立的局部参数和步骤，收藏的后续修改不会覆盖本副本。</p><label className="search-field"><input aria-label="搜索收藏" placeholder="搜索收藏…" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="block-picker">{blocks.filter(block => block.name.toLowerCase().includes(query.toLowerCase())).map(block => <button className="block-choice" type="button" data-step-action-block-id={block.id} key={block.id} onClick={() => activate(() => onInsert?.(block))}>{block.favorite?.kind === 'step' ? <Bookmark size={20} /> : <Layers size={20} />}<span><strong>{block.name}</strong><small>{block.document.steps.length} 步 · {block.document.parameters.length} 个局部变量</small></span><Plus size={17} /></button>)}</div></div><footer><button className="button" type="button" onClick={() => close()}>取消</button></footer></section></div>, document.body)}
  </div>;
}

export function CommandActions({ onMoveUp, onMoveDown, onRemove, disabled = false }: { onMoveUp?: () => void; onMoveDown?: () => void; onRemove: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 10, top: 10 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const initialLast = useRef(false);
  const layout = useRef(new Map<HTMLElement, ScrollLayout>());
  const id = `${useId()}-command-menu`;
  function close(restore = true) {
    flushSync(() => setOpen(false));
    if (restore && trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus({ preventScroll: true });
  }
  function show(last = false) { if (disabled || !trigger.current) return; layout.current = ancestorLayout(trigger.current); initialLast.current = last; setPosition(positionMenu(trigger.current.getBoundingClientRect(), 132, 204)); setOpen(true); }
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    function reposition() { if (menu.current && trigger.current) { const rect = menu.current.getBoundingClientRect(); setPosition(positionMenu(trigger.current.getBoundingClientRect(), rect.height, rect.width)); } }
    reposition();
    const items = [...menu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    (initialLast.current ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => { reposition(); if (trigger.current) layout.current = ancestorLayout(trigger.current); });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) { if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) close(); }
    function escape(event: globalThis.KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }
    function scroll(event: Event) {
      if (!trigger.current || !(event.target instanceof Node) || !event.target.contains(trigger.current)) return;
      if (scrollFromLayout(event.target, layout.current) && menu.current) { const rect = menu.current.getBoundingClientRect(); setPosition(positionMenu(trigger.current.getBoundingClientRect(), rect.height, rect.width)); return; }
      close();
    }
    function scrollGesture(event: Event) { if (scrollGestureWithin(event.target, trigger.current)) close(); }
    function resize() { close(); }
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true); document.addEventListener('scroll', scroll, true); document.addEventListener('wheel', scrollGesture, { capture: true, passive: true }); document.addEventListener('touchmove', scrollGesture, { capture: true, passive: true }); window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); document.removeEventListener('scroll', scroll, true); document.removeEventListener('wheel', scrollGesture, true); document.removeEventListener('touchmove', scrollGesture, true); window.removeEventListener('resize', resize); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index]?.focus({ preventScroll: true });
  }
  const items = [
    { name: '上移命令', icon: ArrowUp, handler: onMoveUp, reason: !onMoveUp ? '已经是本步骤的第一条命令' : undefined },
    { name: '下移命令', icon: ArrowDown, handler: onMoveDown, reason: !onMoveDown ? '已经是本步骤的最后一条命令' : undefined },
    { name: '删除命令', icon: Trash2, handler: onRemove, reason: undefined },
  ];
  return <div className="command-actions" data-command-actions>
    <button ref={trigger} type="button" className="icon-button" title="命令操作" aria-label="命令操作" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => open ? close() : show()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp'); } }}><MoreHorizontal size={17} /></button>
    {open && createPortal(<div ref={menu} id={id} className="step-action-menu command-action-menu" role="menu" aria-label="命令操作" style={position} onKeyDown={keys}>{items.map(item => <button key={item.name} type="button" role="menuitem" aria-label={item.name} disabled={!item.handler} title={item.reason ?? item.name} onClick={() => { close(); item.handler?.(); }}><item.icon size={15} /><span><strong>{item.name}</strong></span></button>)}</div>, document.body)}
  </div>;
}
