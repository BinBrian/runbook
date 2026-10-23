import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { Braces, Plus, X } from 'lucide-react';
import type { Parameter, TextParts } from './types';
import { isVariableEditingSurface, useVariableEditing, type VariableTarget } from './VariableEditing';
import { quickVariableName, readVariableRange, slashMenuPosition, variableQueryOptions, VARIABLE_QUERY_TRIGGER, type SlashPosition, type VariableQueryOption, type VariableQueryRange, type VariableQueryScope } from './slash-menu';
import { clipboardParameter, readVariableClipboard } from './variable-clipboard';
import './selection-tools.css';
import './slash-menu.css';

type SelectionMode = 'use' | 'create' | null;
interface SelectionGeometry { tools: { left: number; top: number; width: number }; popover: { left: number; top: number; width: number; maxHeight: number } }
function selectionGeometry(node: HTMLDivElement, range: Range, tools: HTMLElement | null, popover: HTMLElement | null): SelectionGeometry | null {
  const first = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
  if (!first) return null;
  const bounds = { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
  for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
    if (style.overflowX !== 'visible') { bounds.left = Math.max(bounds.left, rect.left + ancestor.clientLeft); bounds.right = Math.min(bounds.right, rect.left + ancestor.clientLeft + ancestor.clientWidth); }
    if (style.overflowY !== 'visible') { bounds.top = Math.max(bounds.top, rect.top + ancestor.clientTop); bounds.bottom = Math.min(bounds.bottom, rect.top + ancestor.clientTop + ancestor.clientHeight); }
  }
  const field = node.getBoundingClientRect(), visible = { left: Math.max(bounds.left, field.left + node.clientLeft), right: Math.min(bounds.right, field.left + node.clientLeft + node.clientWidth), top: Math.max(bounds.top, field.top + node.clientTop), bottom: Math.min(bounds.bottom, field.top + node.clientTop + node.clientHeight) };
  if (first.right <= visible.left || first.left >= visible.right || first.bottom <= visible.top || first.top >= visible.bottom || bounds.right - bounds.left < 40 || bounds.bottom - bounds.top < 40) return null;
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
  const width = Math.min(100, bounds.right - bounds.left - 12), height = tools?.getBoundingClientRect().height || 70;
  const gutter = field.left - width - 8 >= bounds.left + 4;
  const left = clamp(gutter ? field.left - width - 8 : field.left + 4, bounds.left + 4, bounds.right - width - 4);
  const above = first.top - height - 8;
  const top = clamp(gutter ? first.top - 4 : above >= Math.max(field.top + 4, bounds.top + 4) ? above : first.bottom + 6, bounds.top + 4, bounds.bottom - height - 4);
  const popWidth = Math.min(340, bounds.right - bounds.left - 12), maxHeight = bounds.bottom - bounds.top - 12;
  const popHeight = Math.min(popover?.scrollHeight || 380, maxHeight);
  const popLeft = clamp(left + width + 8 + popWidth <= bounds.right ? left + width + 8 : field.left + 4, bounds.left + 4, bounds.right - popWidth - 4);
  const below = first.bottom + 8;
  const popTop = clamp(below + popHeight <= bounds.bottom ? below : first.top - popHeight - 8, bounds.top + 4, bounds.bottom - popHeight - 4);
  return { tools: { left: Math.round(left), top: Math.round(top), width }, popover: { left: Math.round(popLeft), top: Math.round(popTop), width: popWidth, maxHeight } };
}

function createVariableToken(parameterId: string, name: string, interactive: boolean) {
  const token = document.createElement('span');
  token.contentEditable = 'false'; token.dataset.parameterId = parameterId; token.className = 'variable-token'; token.textContent = name;
  if (interactive) { token.tabIndex = 0; token.setAttribute('role', 'button'); token.setAttribute('aria-label', `定位变量 ${name}`); token.title = '点击定位到右侧变量'; }
  return token;
}
function renderFragments(element: HTMLElement, parts: TextParts, parameters: Parameter[], interactive: boolean) {
  element.replaceChildren(...parts.map(part => {
    if (typeof part === 'string') return document.createTextNode(part);
    return createVariableToken(part.parameterId, parameters.find(parameter => parameter.id === part.parameterId)?.name ?? '变量', interactive);
  }));
}
function emptyBrowserContent(element: Node): boolean {
  const nodes = [...element.childNodes].filter(node => node.nodeType !== Node.TEXT_NODE || node.textContent !== '');
  if (!nodes.length) return true;
  if (nodes.length !== 1 || !(nodes[0] instanceof HTMLElement)) return false;
  return nodes[0].tagName === 'BR' || (['DIV', 'P'].includes(nodes[0].tagName) && emptyBrowserContent(nodes[0]));
}
function readParts(element: HTMLElement): TextParts {
  // WebView inserts one BR (sometimes in a DIV/P) when a field is cleared.
  // Actual Enter/Paste newlines are TextNodes and must remain byte-for-byte.
  if (emptyBrowserContent(element)) return [''];
  const parts: TextParts = [];
  const append = (text: string) => { if (!text) return; const last = parts.at(-1); if (typeof last === 'string') parts[parts.length - 1] = last + text; else parts.push(text); };
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) { append(node.textContent ?? ''); return; }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.parameterId) { parts.push({ parameterId: node.dataset.parameterId }); return; }
    if (node.tagName === 'BR') { append('\n'); return; }
    if ((node.tagName === 'DIV' || node.tagName === 'P') && parts.length && !(typeof parts.at(-1) === 'string' && (parts.at(-1) as string).endsWith('\n'))) append('\n');
    node.childNodes.forEach(walk);
  }
  element.childNodes.forEach(walk);
  return parts.length ? parts : [''];
}
function sameContent(left: TextParts, right: TextParts): boolean {
  const comparable = (parts: TextParts) => {
    const result: TextParts = [];
    for (const part of parts) {
      if (typeof part === 'string') { if (!part) continue; const previous = result.at(-1); if (typeof previous === 'string') result[result.length - 1] = previous + part; else result.push(part); }
      else result.push(part);
    }
    return JSON.stringify(result);
  };
  return comparable(left) === comparable(right);
}
function removeEmptyPlaceholder(element: HTMLDivElement, range: Range) {
  if (!emptyBrowserContent(element)) return;
  element.replaceChildren(); range.setStart(element, 0); range.collapse(true);
}
function containedRange(element: HTMLDivElement | null, range: Range | null): range is Range {
  return Boolean(element?.isConnected && element.isContentEditable && range && range.startContainer.isConnected && range.endContainer.isConnected && element.contains(range.startContainer) && element.contains(range.endContainer));
}
function validRange(element: HTMLDivElement | null, range: Range | null): range is Range {
  if (!containedRange(element, range)) return false;
  const tokenAt = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('[data-parameter-id]');
  if (tokenAt(range.startContainer) || tokenAt(range.endContainer)) return false;
  return range.collapsed || ![...element!.querySelectorAll('[data-parameter-id]')].some(token => range.intersectsNode(token));
}

export function PartsView({ parts, parameters, values, className = '', onVariableClick }: { parts: TextParts; parameters: Parameter[]; values?: Record<string, string>; className?: string; onVariableClick?: (parameterId: string, trigger: HTMLElement) => void }) {
  const press = useRef<{ x: number; y: number; id: string } | null>(null);
  return <span className={`parts-view ${className}`}>{parts.map((part, index) => {
    if (typeof part === 'string') return <span key={index}>{part}</span>;
    const parameter = parameters.find(parameter => parameter.id === part.parameterId), interactive = Boolean(parameter && onVariableClick);
    const missing = values !== undefined && !values[part.parameterId]?.trim();
    return <span key={index} className="variable-token" data-parameter-id={part.parameterId} data-variable-missing={missing || undefined} role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined} aria-label={interactive ? `定位变量 ${parameter!.name}` : undefined} aria-description={missing ? '未填写' : undefined} title={missing ? '未填写' : interactive ? '点击定位到右侧变量' : parameter?.name}
      onPointerDown={interactive ? event => { press.current = { x: event.clientX, y: event.clientY, id: part.parameterId }; } : undefined}
      onClick={interactive ? event => { event.stopPropagation(); const start = press.current; press.current = null; if (event.detail && (!start || start.id !== part.parameterId || Math.hypot(start.x - event.clientX, start.y - event.clientY) > 5)) return; onVariableClick!(part.parameterId, event.currentTarget); } : undefined}
      onDoubleClick={interactive ? event => event.stopPropagation() : undefined}
      onKeyDown={interactive ? event => { if (['Enter', ' '].includes(event.key) && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onVariableClick!(part.parameterId, event.currentTarget); } } : undefined}
    >{values && !missing ? values[part.parameterId] : parameter?.name ?? '变量'}</span>;
  })}</span>;
}

export interface TextFieldProps {
  value: TextParts;
  parameters: Parameter[];
  onChange: (parts: TextParts) => void;
  onCreate: (parameter: Parameter) => void;
  placeholder: string;
  label: string;
  singleLine?: boolean;
  command?: boolean;
  ownerId?: string;
  groupId?: string;
  allowGlobal?: boolean;
  autoFocus?: boolean;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  readOnly?: boolean;
}

/** The saved range belongs to this field only; it is never replaced with an
 * arbitrary caret when a variable panel receives focus. */
export function TextField(props: TextFieldProps) {
  const { value, parameters, placeholder, singleLine = false, command = false, label, ownerId, groupId, allowGlobal = true, autoFocus = false, readOnly = false } = props;
  const element = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const selection = useRef<Range | null>(null);
  const dragging = useRef(false);
  const tokenPress = useRef<{ x: number; y: number; token: HTMLElement } | null>(null);
  const current = useRef(props); current.current = props;
  const bridge = useVariableEditing();
  const bridgeRef = useRef(bridge); bridgeRef.current = bridge;
  const key = useId();
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<SelectionMode>(null);
  const [geometry, setGeometry] = useState<SelectionGeometry | null>(null);
  const toolsElement = useRef<HTMLDivElement>(null);
  const popoverElement = useRef<HTMLDivElement>(null);
  const updatePosition = useRef<() => void>(() => {});
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  const [scope, setScope] = useState(groupId ?? ownerId ?? '');
  const [error, setError] = useState('');
  const [pasteError, setPasteError] = useState('');
  const initialized = useRef(false);
  const lastPropValue = useRef<string | undefined>(undefined);
  const reusableParameters = parameters.filter(parameter => !parameter.ownerId ? allowGlobal : parameter.ownerId === ownerId || parameter.ownerId === groupId);
  const slash = useRef<(VariableQueryRange & { scope: VariableQueryScope }) | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashPosition, setSlashPosition] = useState<SlashPosition | null>(null);
  const slashElement = useRef<HTMLDivElement>(null);
  const updateSlashPosition = useRef<() => void>(() => {});
  const composing = useRef(false);
  const compositionHasTrigger = useRef(false);
  const [slashComposing, setSlashComposing] = useState(false);
  const slashMenuId = `${key}-slash-menu`;
  const slashOptions = slashQuery === null ? [] : variableQueryOptions(parameters, slashQuery, { ownerId, groupId, allowGlobal });
  const activeSlash = slashOptions[Math.min(slashIndex, slashOptions.length - 1)];
  const slashVisible = slashQuery !== null && Boolean(slashPosition) && !slashComposing && !readOnly;
  const slashOptionId = (option: VariableQueryOption) => `${key}-slash-option-${option.kind === 'existing' ? `existing-${option.parameter.id}` : 'create'}`;
  const activeSlashId = activeSlash ? slashOptionId(activeSlash) : undefined;

  function closeSlash() { slash.current = null; setSlashQuery(null); setSlashPosition(null); setSlashIndex(0); }
  function invalidate() { selection.current = null; setSelected(''); setMode(null); setGeometry(null); closeSlash(); bridgeRef.current?.clearTarget(key); }
  function emit() { if (element.current) current.current.onChange(readParts(element.current)); }
  function insert(parameter: Parameter, create = false): boolean {
    const node = element.current, range = selection.current, latest = current.current;
    const definition = create ? parameter : latest.parameters.find(item => item.id === parameter.id);
    const visible = definition && (!definition.ownerId ? latest.allowGlobal !== false : definition.ownerId === latest.ownerId || definition.ownerId === latest.groupId);
    if (latest.readOnly || !definition || !visible || !validRange(node, range)) { if (!validRange(node, range)) invalidate(); return false; }
    if (create && !definition.ownerId && latest.allowGlobal === false) return false;
    closeSlash();
    removeEmptyPlaceholder(node!, range);
    range.deleteContents();
    const token = createVariableToken(definition.id, definition.name, Boolean(bridgeRef.current && latest.ownerId));
    range.insertNode(token);
    const after = document.createRange(); after.setStartAfter(token); after.collapse(true); selection.current = after.cloneRange();
    if (create) latest.onCreate(definition);
    emit(); setMode(null); setSelected(''); setGeometry(null);
    const activeSelection = window.getSelection(); activeSelection?.removeAllRanges(); activeSelection?.addRange(after);
    node?.focus({ preventScroll: true });
    if (latest.ownerId) bridgeRef.current?.setTarget(target);
    return true;
  }
  const insertRef = useRef(insert); insertRef.current = insert;
  const target = useMemo<VariableTarget>(() => ({ key, stepId: ownerId ?? '', label,
    insert: parameter => insertRef.current(parameter),
    isAvailable: () => !current.current.readOnly && Boolean(current.current.ownerId) && validRange(element.current, selection.current),
  }), [key, ownerId, label]);

  function sameCaret(left: Range, right: Range) { return left.collapsed && right.collapsed && left.compareBoundaryPoints(Range.START_TO_START, right) === 0; }
  function updateSlash(allowStart = false) {
    const node = element.current, active = window.getSelection();
    if (!node || current.current.readOnly || document.activeElement !== node || !active?.rangeCount) { closeSlash(); return; }
    const caret = active.getRangeAt(0), next = validRange(node, caret) && caret.collapsed ? readVariableRange(node, caret) : null;
    if (!next || (!slash.current && !allowStart)) { closeSlash(); return; }
    if (slash.current && next.range.compareBoundaryPoints(Range.START_TO_START, slash.current.range) !== 0 && !allowStart) { closeSlash(); return; }
    if (slash.current?.query !== next.query) setSlashIndex(0);
    const latest = current.current;
    slash.current = { ...next, scope: { ownerId: latest.ownerId, groupId: latest.groupId, allowGlobal: latest.allowGlobal !== false } }; setSlashQuery(next.query); setSelected(''); setMode(null); setGeometry(null);
    updateSlashPosition.current();
  }
  function acceptSlash(option: VariableQueryOption): boolean {
    const session = slash.current, node = element.current, active = window.getSelection(), latest = current.current;
    if (!session || !node || latest.readOnly || composing.current || document.activeElement !== node || !active?.rangeCount || !validRange(node, session.range) || session.range.toString() !== `${VARIABLE_QUERY_TRIGGER}${session.query}` || !sameCaret(active.getRangeAt(0), session.caret) || session.scope.ownerId !== latest.ownerId || session.scope.groupId !== latest.groupId || session.scope.allowGlobal !== (latest.allowGlobal !== false)) { closeSlash(); return false; }
    const fresh = readVariableRange(node, active.getRangeAt(0));
    if (!fresh || fresh.query !== session.query || fresh.range.compareBoundaryPoints(Range.START_TO_START, session.range) !== 0) { closeSlash(); return false; }
    const currentOption = variableQueryOptions(latest.parameters, session.query, latest).find(candidate => candidate.kind === option.kind && (candidate.kind === 'existing' && option.kind === 'existing' ? candidate.parameter.id === option.parameter.id : candidate.kind === 'create' && option.kind === 'create' && candidate.name === option.name && candidate.ownerId === option.ownerId));
    if (!currentOption) { closeSlash(); return false; }
    selection.current = session.range.cloneRange();
    if (currentOption.kind === 'existing') return insert(currentOption.parameter);
    return insert({ id: crypto.randomUUID(), name: currentOption.name, description: '', defaultValue: '', ...(currentOption.ownerId ? { ownerId: currentOption.ownerId } : {}) }, true);
  }

  function rememberSelection() {
    const node = element.current;
    // A delayed selectionchange may still describe this field after navigation.
    // Only its actual focus can establish a new target; panels use the saved one.
    if (!node || document.activeElement !== node) return;
    const activeSelection = window.getSelection();
    if (!activeSelection?.rangeCount) return;
    const range = activeSelection.getRangeAt(0);
    // Selection changes inside the side panel must not replace the saved range.
    if (!node.contains(range.startContainer) || !node.contains(range.endContainer)) { invalidate(); return; }
    if (!validRange(node, range) || current.current.readOnly) { invalidate(); return; }
    if (slash.current && !composing.current && (!range.collapsed || !sameCaret(range, slash.current.caret))) closeSlash();
    if (mode) setMode(null);
    selection.current = range.cloneRange();
    setSelected(range.collapsed || dragging.current ? '' : range.toString());
    if (range.collapsed) { setMode(null); setGeometry(null); }
    updatePosition.current();
    if (current.current.ownerId) bridgeRef.current?.setTarget(target);
  }
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    // A panel changes focus and context, but unchanged TextParts must retain
    // their actual DOM nodes so the saved native Range stays attached.
    const nextPropValue = JSON.stringify(value);
    if (!initialized.current || lastPropValue.current !== nextPropValue) {
      if (!initialized.current || !sameContent(readParts(node), value)) { renderFragments(node, value, parameters, Boolean(bridgeRef.current && current.current.ownerId)); invalidate(); }
      initialized.current = true; lastPropValue.current = nextPropValue;
    }
    for (const token of node.querySelectorAll<HTMLElement>('[data-parameter-id]')) {
      const name = parameters.find(parameter => parameter.id === token.dataset.parameterId)?.name ?? '变量';
      if (token.textContent !== name) token.textContent = name;
      if (token.getAttribute('role') === 'button') token.setAttribute('aria-label', `定位变量 ${name}`);
    }
  }, [value, parameters]);
  useEffect(() => {
    invalidate();
    return () => { selection.current = null; bridgeRef.current?.clearTarget(key); };
  }, [ownerId, groupId, allowGlobal, readOnly, key]);
  useEffect(() => {
    function externalFocus(event: globalThis.FocusEvent) {
      if (slash.current && !(event.target instanceof Node && (element.current?.contains(event.target) || slashElement.current?.contains(event.target)))) closeSlash();
      if (bridgeRef.current?.target?.key !== key || isVariableEditingSurface(event.target) || (event.target instanceof Node && wrapper.current?.contains(event.target))) return;
      invalidate();
    }
    function pointerReleased() { if (!dragging.current) return; dragging.current = false; rememberSelection(); }
    document.addEventListener('selectionchange', rememberSelection);
    document.addEventListener('focusin', externalFocus);
    document.addEventListener('pointerup', pointerReleased);
    return () => { document.removeEventListener('selectionchange', rememberSelection); document.removeEventListener('focusin', externalFocus); document.removeEventListener('pointerup', pointerReleased); };
  });
  useEffect(() => { if (autoFocus && !readOnly) { element.current?.focus({ preventScroll: true }); rememberSelection(); } }, [autoFocus, readOnly]);

  useLayoutEffect(() => {
    if (slashQuery === null || readOnly || slashComposing) { setSlashPosition(null); updateSlashPosition.current = () => {}; return; }
    let frame: number | undefined;
    function reposition() {
      frame = undefined;
      const node = element.current, session = slash.current;
      const next = node && session && validRange(node, session.range) ? slashMenuPosition(node, session.caret, slashElement.current) : null;
      setSlashPosition(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }
    function schedule() { if (frame === undefined) frame = requestAnimationFrame(reposition); }
    updateSlashPosition.current = schedule; reposition();
    document.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    if (element.current) observer.observe(element.current);
    const workspace = element.current?.closest('.workspace-scroll'); if (workspace) observer.observe(workspace);
    if (slashElement.current) observer.observe(slashElement.current);
    return () => { updateSlashPosition.current = () => {}; if (frame !== undefined) cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
  // The first pass establishes visibility before the portal exists. Re-run
  // after its mount to measure the real height and observe future size changes.
  }, [slashQuery, slashOptions.length, readOnly, slashComposing, slashVisible]);
  useEffect(() => {
    if (slashQuery === null) return;
    function outside(event: PointerEvent) { if (!(event.target instanceof Node) || wrapper.current?.contains(event.target) || slashElement.current?.contains(event.target)) return; closeSlash(); }
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [slashQuery]);
  useLayoutEffect(() => {
    const menu = slashElement.current;
    if (!menu || !activeSlashId) return;
    const option = [...menu.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.id === activeSlashId);
    const list = menu.querySelector<HTMLElement>('.slash-menu-options');
    if (!option || !list) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [activeSlashId, slashVisible]);

  useLayoutEffect(() => {
    if (!selected || readOnly) { setGeometry(null); updatePosition.current = () => {}; return; }
    let frame: number | undefined;
    function reposition() {
      frame = undefined;
      const node = element.current, range = selection.current;
      if (!validRange(node, range) || range.collapsed) { setGeometry(null); return; }
      const next = selectionGeometry(node!, range, toolsElement.current, popoverElement.current);
      setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      if (!next) setMode(null);
    }
    function schedule() { if (frame === undefined) frame = requestAnimationFrame(reposition); }
    updatePosition.current = schedule;
    reposition();
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    if (element.current) observer.observe(element.current);
    const workspace = element.current?.closest('.workspace-scroll'); if (workspace) observer.observe(workspace);
    if (popoverElement.current) observer.observe(popoverElement.current);
    return () => { updatePosition.current = () => {}; if (frame !== undefined) cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
  }, [selected, mode, readOnly]);

  function restoreSelection(collapse = false) {
    const range = selection.current;
    if (!validRange(element.current, range)) return;
    const restored = range.cloneRange(); if (collapse) restored.collapse(false);
    selection.current = restored.cloneRange();
    const active = window.getSelection(); active?.removeAllRanges(); active?.addRange(restored);
    element.current?.focus({ preventScroll: true });
  }
  function closePopover() { setMode(null); setError(''); restoreSelection(); }
  function choose(next: Exclude<SelectionMode, null>) {
    if (!selected || !validRange(element.current, selection.current) || selection.current.collapsed) { invalidate(); return; }
    setError('');
    if (next === 'create') { setName(''); setDescription(''); setDefaultValue(selected); setScope(groupId ?? ownerId ?? ''); }
    setMode(next);
  }
  useLayoutEffect(() => {
    if (!mode || !geometry) return;
    const first = popoverElement.current?.querySelector<HTMLElement>(mode === 'create' ? 'input' : '.token-choice, .selection-start-create');
    first?.focus({ preventScroll: true });
  }, [mode, Boolean(geometry)]);
  useEffect(() => {
    if (!selected && !mode) return;
    function outside(event: PointerEvent) {
      const node = event.target;
      if (!(node instanceof Node) || wrapper.current?.contains(node) || toolsElement.current?.contains(node) || popoverElement.current?.contains(node)) return;
      if (isVariableEditingSurface(node)) { setMode(null); setSelected(''); setGeometry(null); }
      else invalidate();
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      const source = event.target;
      if (!(source instanceof Node) || (!wrapper.current?.contains(source) && !toolsElement.current?.contains(source) && !popoverElement.current?.contains(source))) return;
      event.preventDefault(); event.stopPropagation();
      if (mode) closePopover();
      else { setSelected(''); setGeometry(null); restoreSelection(true); }
    }
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [selected, mode]);

  function convert(parameter: Parameter, create = false) { if (!insert(parameter, create)) setError('请重新选择本字段中不含变量标签的文字或光标位置。'); }
  function clickedToken(target: EventTarget | null) {
    const token = target instanceof Element ? target.closest<HTMLElement>('.variable-token[data-parameter-id]') : null;
    return token && element.current?.contains(token) ? token : null;
  }
  function locateToken(token: HTMLElement) {
    const latest = current.current, parameter = latest.parameters.find(item => item.id === token.dataset.parameterId);
    if (!latest.ownerId || !parameter || !bridgeRef.current || (!parameter.ownerId ? latest.allowGlobal === false : parameter.ownerId !== latest.ownerId && parameter.ownerId !== latest.groupId)) return;
    invalidate(); bridgeRef.current.locateVariable({ parameterId: parameter.id, stepId: latest.ownerId, trigger: token });
  }
  return <div ref={wrapper} className={`parts-field ${command ? 'is-command' : ''} ${singleLine ? 'is-title' : ''}`}>
    <div ref={element} contentEditable={!readOnly} suppressContentEditableWarning role="textbox" aria-label={label} aria-multiline={!singleLine} aria-readonly={readOnly} aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={slashVisible} aria-controls={slashVisible ? slashMenuId : undefined} aria-activedescendant={slashVisible ? activeSlashId : undefined} className="parts-edit" data-placeholder={placeholder} data-parts-empty={value.every(part => typeof part === 'string' && part === '')}
      onFocus={rememberSelection} onInput={event => {
        setPasteError('');
        emit();
        const input = event.nativeEvent as InputEvent;
        if (composing.current || input.isComposing) { if (input.data?.includes(VARIABLE_QUERY_TRIGGER[0])) compositionHasTrigger.current = true; }
        else if (['insertText', 'insertCompositionText', 'insertFromComposition', 'deleteContentBackward', 'deleteContentForward'].includes(input.inputType)) updateSlash(input.inputType === 'insertText' && Boolean(input.data?.includes(VARIABLE_QUERY_TRIGGER[0])));
        else closeSlash();
        rememberSelection();
      }} onPointerDown={event => { const token = clickedToken(event.target); tokenPress.current = token ? { x: event.clientX, y: event.clientY, token } : null; dragging.current = true; closeSlash(); setMode(null); setSelected(''); setGeometry(null); }} onMouseUp={() => { dragging.current = false; rememberSelection(); }} onKeyUp={rememberSelection}
      onClick={event => { const token = clickedToken(event.target), press = tokenPress.current; tokenPress.current = null; if (token && (!event.detail || press?.token === token && Math.hypot(press.x - event.clientX, press.y - event.clientY) <= 5)) { event.stopPropagation(); locateToken(token); } }}
      onDoubleClick={event => { if (clickedToken(event.target)) event.stopPropagation(); }}
      onCompositionStart={() => { composing.current = true; compositionHasTrigger.current = false; setSlashComposing(true); }}
      onCompositionEnd={() => { composing.current = false; setSlashComposing(false); updateSlash(compositionHasTrigger.current); compositionHasTrigger.current = false; rememberSelection(); }}
      onBlur={event => { const next = event.relatedTarget; if (isVariableEditingSurface(next) || (next instanceof Node && wrapper.current?.contains(next))) return; invalidate(); props.onBlur?.(event); }}
      onKeyDown={event => {
        const token = clickedToken(event.target);
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current || readOnly) return;
        if (token && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); locateToken(token); return; }
        if (slash.current) {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSlash(); return; }
          if (slashVisible && slashOptions.length && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); setSlashIndex(previous => event.key === 'Home' ? 0 : event.key === 'End' ? slashOptions.length - 1 : (Math.min(previous, slashOptions.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + slashOptions.length) % slashOptions.length); return; }
          if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) && slashVisible && activeSlash && !event.ctrlKey && !event.metaKey) { event.preventDefault(); event.stopPropagation(); acceptSlash(activeSlash); return; }
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', 'Tab'].includes(event.key)) closeSlash();
        }
        if (event.key !== 'Enter') return;
        if (event.ctrlKey || event.metaKey) { event.preventDefault(); return; }
        event.preventDefault(); if (singleLine) return;
        const activeSelection = window.getSelection(); if (!activeSelection?.rangeCount) return;
        const range = activeSelection.getRangeAt(0); if (!containedRange(element.current, range)) return;
        removeEmptyPlaceholder(element.current!, range);
        range.deleteContents(); const newline = document.createTextNode('\n'); range.insertNode(newline); range.setStartAfter(newline); range.collapse(true); activeSelection.removeAllRanges(); activeSelection.addRange(range); emit(); rememberSelection();
      }}
      onPaste={event => {
        if (readOnly) return; closeSlash(); event.preventDefault(); setPasteError('');
        const reference = readVariableClipboard(event.clipboardData.getData('text/html'));
        const activeSelection = window.getSelection();
        if (reference.kind !== 'none') {
          if (reference.kind === 'invalid') { setPasteError('变量引用格式无效，未粘贴。'); return; }
          const latest = current.current;
          const parameter = clipboardParameter(reference.parameterId, latest.parameters, latest.ownerId, latest.groupId, latest.allowGlobal !== false);
          if (!parameter) { setPasteError('此变量不存在或不属于当前步骤范围，未粘贴。'); return; }
          const range = activeSelection?.rangeCount ? activeSelection.getRangeAt(0) : null;
          if (!validRange(element.current, range)) { setPasteError('请在当前字段放置光标或选择不含变量标签的文字，再粘贴。'); return; }
          selection.current = range.cloneRange();
          if (!insert(parameter)) setPasteError('当前字段不可粘贴此变量引用。');
          return;
        }
        const text = event.clipboardData.getData('text/plain'); if (!activeSelection?.rangeCount) return;
        const range = activeSelection.getRangeAt(0); if (!containedRange(element.current, range)) return;
        removeEmptyPlaceholder(element.current!, range);
        range.deleteContents(); const node = document.createTextNode(singleLine ? text.replace(/\r?\n/g, ' ') : text); range.insertNode(node); range.setStartAfter(node); range.collapse(true); activeSelection.removeAllRanges(); activeSelection.addRange(range); emit(); rememberSelection();
      }} />
    {pasteError && <p className="field-error" role="status" data-variable-paste-error>{pasteError}</p>}
    {slashVisible && slashPosition && createPortal(<div ref={slashElement} id={slashMenuId} className="slash-variable-menu" data-slash-menu data-slash-query={slashQuery} role="listbox" aria-label="变量建议" style={{ position: 'fixed', ...slashPosition }}>
      <div className="slash-menu-heading"><Braces size={14} /><strong>{slashQuery ? `筛选：${slashQuery}` : '选择已有变量'}</strong><small>按名称筛选</small></div>
      <div className="slash-menu-options">{slashOptions.length ? slashOptions.map((option, index) => {
        const parameter = option.kind === 'existing' ? option.parameter : option;
        return <button key={slashOptionId(option)} type="button" id={slashOptionId(option)} data-parameter-id={option.kind === 'existing' ? option.parameter.id : undefined} data-create-variable={option.kind === 'create' ? option.name : undefined} role="option" aria-selected={activeSlashId === slashOptionId(option)} tabIndex={-1} className={`slash-variable-option${option.kind === 'create' ? ' slash-create-option' : ''}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSlashIndex(index)} onClick={() => acceptSlash(option)}><span>{option.kind === 'create' && <Plus size={14} />}<strong>{option.kind === 'create' ? `创建「${option.name}」` : option.parameter.name}</strong><small>{!parameter.ownerId ? '全局' : parameter.ownerId === ownerId ? '本步骤' : '步骤组'}</small></span>{option.kind === 'existing' && option.parameter.description && <span className="slash-option-description">{option.parameter.description}</span>}</button>;
      }) : <p className="slash-no-results" role="status">{slashQuery && !quickVariableName(slashQuery) ? '变量名称需为单行、1024 字节以内，且不含括号。' : slashQuery ? '当前范围不可创建变量。' : '输入名称即可创建变量。'}</p>}</div>
      <div className="slash-menu-hint">↑↓ 选择 · Enter / Tab 确认 · Esc 关闭</div>
    </div>, document.body)}
    {!readOnly && selected && geometry && !mode && createPortal(<div ref={toolsElement} className="selection-tools" data-selection-tools role="toolbar" aria-label="选区变量操作" style={{ position: 'fixed', ...geometry.tools }}>
      <button type="button" aria-label="使用变量" onMouseDown={event => event.preventDefault()} onClick={() => choose('use')}><Braces size={14} />使用变量</button>
      <button type="button" aria-label="新增变量" onMouseDown={event => event.preventDefault()} onClick={() => choose('create')}><Plus size={14} />新增变量</button>
    </div>, document.body)}
    {!readOnly && selected && geometry && mode && createPortal(<div ref={popoverElement} className="variable-popover selection-variable-popover" data-variable-popover role="dialog" aria-label={mode === 'use' ? '使用变量' : '新增变量'} style={{ position: 'fixed', ...geometry.popover }}>
      <div className="popover-heading"><strong>{mode === 'use' ? '使用变量' : '新增变量'}</strong><button type="button" className="icon-button" aria-label="取消" onClick={closePopover} title="取消"><X size={15} /></button></div>
      {mode === 'use' ? <>{reusableParameters.length ? <div className="reuse-variables"><span className="field-caption">仅本字段可见的全局、组和步骤变量</span>{reusableParameters.map(parameter => <button type="button" key={parameter.id} data-parameter-id={parameter.id} className="token-choice" onMouseDown={event => event.preventDefault()} onClick={() => convert(parameter)}><Braces size={13} />{parameter.name}<small>{!parameter.ownerId ? '全局' : parameter.ownerId === ownerId ? '本步骤' : '步骤组'}</small></button>)}</div> : <><p className="hint">当前范围暂无可使用的变量。</p><button type="button" className="button small selection-start-create" onClick={() => choose('create')}><Plus size={14} />新增变量</button></>}{error && <p className="field-error">{error}</p>}</> : <>
        <label className="field-label">新变量名称<input aria-label="新变量名称" value={name} onChange={event => setName(event.target.value)} placeholder="例如：目标版本" /></label>
        <label className="field-label">作用范围<select aria-label="变量作用范围" value={scope} onChange={event => setScope(event.target.value)}>{ownerId && <option value={ownerId}>局部 · 本步骤</option>}{groupId && <option value={groupId}>局部 · 本步骤组</option>}{allowGlobal && <option value="">全局 · 整个流程</option>}</select></label>
        <label className="field-label">说明<input aria-label="说明" value={description} onChange={event => setDescription(event.target.value)} placeholder="可选" /></label>
        <label className="field-label">默认值<textarea aria-label="默认值" rows={2} value={defaultValue} onChange={event => setDefaultValue(event.target.value)} /></label>
        {error && <p className="field-error">{error}</p>}
        <button type="button" className="button primary" onClick={() => { if (!name.trim()) { setError('请填写变量名称。'); return; } convert({ id: crypto.randomUUID(), name: name.trim(), description, defaultValue, ...(scope ? { ownerId: scope } : {}) }, true); }}>创建并替换选区</button>
      </>}
    </div>, document.body)}
  </div>;
}
