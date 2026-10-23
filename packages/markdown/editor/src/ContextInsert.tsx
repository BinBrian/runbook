import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { insertionHint, insertionTarget, insertElement, type InsertKind, type InsertTarget } from './context-insert';

type Anchor = { target: InsertTarget; line: number };
type Position = { left: number; top: number; menuLeft: number; menuTop: number };
type Props = { editor: Editor; readOnly: boolean; scroller: RefObject<HTMLDivElement | null>; request?: { position: number; key: number }; onError: (error: unknown) => void };
const items: { kind: InsertKind; icon: string; label: string; detail: string }[] = [
  { kind: 'paragraph', icon: '¶', label: '正文', detail: '继续写说明' },
  { kind: 'heading', icon: 'H₂', label: '标题', detail: '组织文档内容' },
  { kind: 'step', icon: '▣', label: '步骤', detail: '新建独立操作步骤' },
  { kind: 'command', icon: '›_', label: '指令', detail: '可编辑、复制的命令' },
  { kind: 'checkpoint', icon: '✓', label: '人工检查点', detail: '确认检查标准与结果' },
  { kind: 'bulletList', icon: '•', label: '无序列表', detail: '逐项列出说明' },
  { kind: 'orderedList', icon: '1.', label: '有序列表', detail: '按顺序列出说明' },
  { kind: 'blockquote', icon: '“', label: '引用', detail: '强调补充说明' },
  { kind: 'code', icon: '</>', label: '代码', detail: '普通代码或原始文本' },
  { kind: 'horizontalRule', icon: '—', label: '分隔线', detail: '分隔文档内容' },
];

export function ContextInsert({ editor, readOnly, scroller, request, onError }: Props) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const handledRequest = useRef<number | undefined>(undefined);
  const openRef = useRef(open);
  openRef.current = open;
  const domFor = (target: InsertTarget) => editor.view.nodeDOM(target.from) as HTMLElement | null;
  const fromSelection = (): Anchor | null => {
    const target = insertionTarget(editor.state.doc, editor.state.selection.from);
    if (!target) return null;
    const dom = domFor(target);
    if (!dom?.getBoundingClientRect) return null;
    const caret = editor.view.coordsAtPos(editor.state.selection.from);
    return { target, line: Math.max(0, Math.min(caret.top + (caret.bottom - caret.top) / 2 - dom.getBoundingClientRect().top, dom.offsetHeight)) };
  };
  const fromElement = (element: HTMLElement, y: number): Anchor | null => {
    let result: Anchor | null = null;
    editor.state.doc.descendants((node, from, parent) => {
      if (!node.isBlock || !parent || !['doc', 'runbookStep'].includes(parent.type.name)) return;
      const dom = editor.view.nodeDOM(from) as HTMLElement | null;
      if (dom?.contains(element)) result = { target: { from, node }, line: Math.max(12, y - dom.getBoundingClientRect().top) };
    });
    return result;
  };
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) editor.view.focus(); };

  useEffect(() => {
    if (readOnly) { setAnchor(null); setOpen(false); return; }
    let frame = 0;
    const click = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        setAnchor(fromElement(target, event.clientY) ?? fromSelection());
      });
    };
    const selection = () => { if (!openRef.current) setAnchor(fromSelection()); };
    const transaction = ({ transaction: change }: { transaction: Transaction }) => {
      if (!change.docChanged) return;
      setOpen(false);
      const focused = document.activeElement as HTMLElement | null;
      setAnchor(focused && editor.view.dom.contains(focused) && focused.matches('input,textarea')
        ? fromElement(focused, focused.getBoundingClientRect().top + 15) : fromSelection());
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (button.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
      if (!editor.view.dom.contains(target)) setAnchor(null);
    };
    const shortcut = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'Enter' && !(event.target as HTMLElement).closest('input,textarea')) {
        event.preventDefault(); setAnchor(fromSelection()); setOpen(true);
      }
    };
    editor.view.dom.addEventListener('click', click, true);
    editor.view.dom.addEventListener('keydown', shortcut, true);
    document.addEventListener('pointerdown', outside, true);
    editor.on('selectionUpdate', selection);
    editor.on('transaction', transaction);
    return () => {
      cancelAnimationFrame(frame);
      editor.view.dom.removeEventListener('click', click, true);
      editor.view.dom.removeEventListener('keydown', shortcut, true);
      document.removeEventListener('pointerdown', outside, true);
      editor.off('selectionUpdate', selection);
      editor.off('transaction', transaction);
    };
  }, [editor, readOnly]);

  useEffect(() => {
    if (!request || request.key === handledRequest.current) return;
    handledRequest.current = request.key;
    if (readOnly) return;
    const target = insertionTarget(editor.state.doc, request.position);
    const selected = fromSelection();
    if (target && selected) { setAnchor({ ...selected, target }); setOpen(true); }
  }, [request, editor, readOnly]);

  useLayoutEffect(() => {
    const viewport = scroller.current;
    if (!anchor || readOnly || !viewport) { setPosition(null); return; }
    let frame = 0;
    const update = () => {
      if (editor.isDestroyed || editor.state.doc.nodeAt(anchor.target.from) !== anchor.target.node) { setPosition(null); setOpen(false); return; }
      const dom = domFor(anchor.target);
      if (!dom?.isConnected) { setPosition(null); setOpen(false); return; }
      const rect = dom.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
      const center = rect.top + Math.min(anchor.line, rect.height - 1);
      if (center < bounds.top + 12 || center > bounds.bottom - 12 || bounds.width < 60) { setPosition(null); setOpen(false); return; }
      const left = Math.max(bounds.left + 4, rect.left - 30), top = center - 12;
      const width = menu.current?.offsetWidth ?? 292, height = menu.current?.offsetHeight ?? 420;
      const menuLeft = Math.max(12, Math.min(left + 30, window.innerWidth - width - 12));
      const below = top + 29;
      const menuTop = below + height <= window.innerHeight - 12 ? below : Math.max(12, Math.min(top - height - 5, window.innerHeight - height - 12));
      setPosition({ left, top, menuLeft, menuTop });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    update();
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    const observed = domFor(anchor.target);
    if (observed) observer.observe(observed);
    if (menu.current) observer.observe(menu.current);
    return () => { cancelAnimationFrame(frame); viewport.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); observer.disconnect(); };
  }, [anchor, open, readOnly, editor, scroller]);

  useEffect(() => {
    if (open && position) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [open, !!position]);

  if (readOnly || !anchor || !position) return null;
  const inStep = editor.state.doc.resolve(anchor.target.from).parent.type.name === 'runbookStep';
  const choose = (kind: InsertKind) => {
    try {
      const change = insertElement(editor.state, anchor.target, kind);
      setOpen(false);
      editor.view.dispatch(change);
      editor.view.focus();
    } catch (error) { setOpen(false); onError(error); }
  };
  return createPortal(<>
    <button ref={button} type="button" className={`visual-line-plus${open ? ' is-open' : ''}`} style={{ left: position.left, top: position.top }} aria-label="在当前行插入元素" title="插入元素 · Alt+Enter" aria-haspopup="menu" aria-expanded={open} onMouseDown={event => event.preventDefault()} onClick={() => setOpen(!open)}>＋</button>
    {open && <div ref={menu} className="visual-context-menu" style={{ left: position.menuLeft, top: position.menuTop }} role="menu" aria-label="插入元素" onKeyDown={event => {
      const options = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      const index = options.indexOf(document.activeElement as HTMLElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
      }
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); }
    }}>
      <div className="visual-context-caption"><strong>{insertionHint(anchor.target)}</strong><span>Esc 取消</span></div>
      {items.map(item => <button key={item.kind} type="button" role="menuitem" aria-label={item.label} onClick={() => choose(item.kind)}><span className="visual-context-icon" aria-hidden="true">{item.icon}</span><span><strong>{item.label}</strong><small>{inStep && (item.kind === 'step' || item.kind === 'checkpoint') ? '在当前步骤之后新增' : item.kind === 'command' ? inStep ? '加入当前步骤' : '新建步骤并添加指令' : item.detail}</small></span></button>)}
      {request && anchor.target.node.type.name === 'paragraph' && !anchor.target.node.content.size && <button type="button" role="menuitem" aria-label="输入斜杠" onClick={() => { close(); editor.chain().focus().insertContent('/').run(); }}><span className="visual-context-icon">/</span><span><strong>输入 /</strong><small>插入普通字符</small></span></button>}
    </div>}
  </>, document.body);
}
