import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, ChevronsLeft, Crosshair, ListTree, X } from 'lucide-react';
import { defaultValues, displayedStep, renderText } from './model';
import type { ChecklistDocument, Instance, ResultEntry, Snapshot } from './types';
import './step-navigation.css';

type NavigationStatus = 'completed' | 'current' | 'failed' | 'skipped' | 'pending' | 'unexecuted';
const labels: Record<NavigationStatus, string> = { completed: '已完成', current: '当前步骤', failed: '失败', skipped: '已跳过', pending: '待处理', unexecuted: '未执行' };
type Row = { id: string; index: number; groupId?: string; groupName?: string; groupDescription?: string; shown: Snapshot; status: NavigationStatus; current: boolean; reason?: string | null };

type JumpOptions = { behavior?: ScrollBehavior; settle?: boolean; groupId?: string };
const jumpTargetChanged = 'runbook-step-jump-target';

/** Capture before expansion changes; measure and scroll only the document. */
export function useStepJump(scrollRef: RefObject<HTMLDivElement | null>) {
  const cancel = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancel.current?.(), []);
  return useCallback((stepId?: string, parameterId?: string, options: JumpOptions = {}) => {
    cancel.current?.();
    const element = scrollRef.current;
    if (!element || !stepId) return;
    const root = element;
    const findTarget = () => [...root.querySelectorAll<HTMLElement>('.step-card[data-step-id]')].find(node => node.dataset.stepId === stepId);
    const anchor = options.settle ? findTarget() ?? [...root.querySelectorAll<HTMLElement>('.step-group[data-group-id]')].find(node => node.dataset.groupId === options.groupId) : undefined;
    const relativeTop = (node: HTMLElement) => node.getBoundingClientRect().top - root.getBoundingClientRect().top;
    let anchorTop = Math.max(14, anchor ? relativeTop(anchor) : root.clientHeight * .65);
    const overflowAnchor = root.style.overflowAnchor;
    if (options.settle) root.style.overflowAnchor = 'none';
    let frame: number, finished = false, released = false, frames = 0, stable = 0, previous: number[] | undefined;
    let restingTop = root.scrollTop;
    let scrolling = false, destination = 0;
    const clamp = (top: number) => Math.max(0, Math.min(top, root.scrollHeight - root.clientHeight));
    function finish() {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      if (scrolling) root.scrollTo({ top: root.scrollTop, behavior: 'instant' });
      if (options.settle) root.style.overflowAnchor = overflowAnchor;
      restingTop = root.scrollTop;
    }
    function stop() {
      if (released) return;
      released = true;
      finish();
      delete root.dataset.stepJumpTarget;
      root.dispatchEvent(new Event(jumpTargetChanged));
      root.removeEventListener('wheel', stop);
      root.removeEventListener('touchstart', stop);
      root.removeEventListener('pointerdown', pointer);
      root.removeEventListener('keydown', keys);
      root.removeEventListener('scroll', afterArrival);
      if (cancel.current === stop) cancel.current = undefined;
    }
    function pointer(event: PointerEvent) {
      // A result click starts the next jump; don't briefly select a later visible card first.
      if (!(event.target instanceof Element && event.target.closest('[data-step-result-actions]'))) stop();
    }
    function afterArrival() {
      if (finished && Math.abs(root.scrollTop - restingTop) > 1) stop();
    }
    function keys(event: globalThis.KeyboardEvent) {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Escape'].includes(event.key)) stop();
    }
    function locate() {
      if (finished) return;
      const target = findTarget();
      if (++frames > 180) { stop(); return; }
      if (target) {
        const reference = parameterId ? [...target.querySelectorAll<HTMLElement>('.variable-token[data-parameter-id], [data-frozen-reference]')].find(node => (node.dataset.frozenReference ?? node.dataset.parameterId) === parameterId) : undefined;
        const cardTop = relativeTop(target) + root.scrollTop - 14;
        const top = clamp(reference ? Math.max(cardTop, relativeTop(reference) + root.scrollTop - Math.min(100, root.clientHeight / 3)) : cardTop);
        const geometry = [top, root.scrollHeight, root.clientHeight, target.offsetHeight];
        const unchanged = previous?.every((value, index) => Math.abs(value - geometry[index]) < .5);
        previous = geometry;
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (scrolling) {
          if (options.settle && !unchanged) {
            // Late layout changes must not leave a native scroll aiming at an old coordinate.
            root.scrollTo({ top: root.scrollTop, behavior: 'instant' });
            scrolling = false; stable = 0;
            anchorTop = Math.max(14, relativeTop(anchor?.isConnected ? anchor : target));
          } else if (Math.abs(root.scrollTop - destination) < 1) { scrolling = false; finish(); return; }
        }
        if (!scrolling) {
          if (options.settle && !reduced) {
            const node = anchor?.isConnected ? anchor : target;
            const start = clamp(relativeTop(node) + root.scrollTop - anchorTop);
            if (Math.abs(root.scrollTop - start) > .5) root.scrollTo({ top: start, behavior: 'instant' });
            stable = unchanged ? stable + 1 : 0;
          }
          if (!options.settle || reduced || stable >= 2) {
            destination = top;
            const behavior = reduced ? 'instant' : options.behavior ?? 'smooth';
            root.scrollTo({ top: destination, behavior });
            if (behavior === 'instant') { finish(); return; }
            scrolling = true;
          }
        }
      }
      frame = requestAnimationFrame(locate);
    }
    cancel.current = stop;
    // Keep the requested identity through layout compensation and intermediate scroll frames.
    // After arrival it remains the reading target until the user browses elsewhere.
    root.dataset.stepJumpTarget = stepId;
    root.dispatchEvent(new Event(jumpTargetChanged));
    root.addEventListener('wheel', stop, { passive: true });
    root.addEventListener('touchstart', stop, { passive: true });
    root.addEventListener('pointerdown', pointer, { passive: true });
    root.addEventListener('keydown', keys);
    root.addEventListener('scroll', afterArrival, { passive: true });
    frame = requestAnimationFrame(locate);
  }, [scrollRef]);
}

function StatusIcon({ status }: { status: NavigationStatus }) {
  return status === 'completed' ? <Check size={12} /> : status === 'failed' ? <X size={12} /> : status === 'skipped' ? <ArrowRight size={12} /> : null;
}

export default function StepNavigator({ document: content, instance, scrollRef, onLocate, onViewingChange }: {
  document: ChecklistDocument; instance?: Instance; scrollRef: RefObject<HTMLDivElement | null>; onLocate: (stepId: string) => void; onViewingChange?: (stepId: string | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [viewing, setViewing] = useState<string | undefined>(instance?.currentStepId ?? content.steps[0]?.id);
  const [jumpVersion, setJumpVersion] = useState(0);
  const [preview, setPreview] = useState<{ id: string; left: number; top: number } | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const listRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const rows = useMemo<Row[]>(() => {
    const results = new Map<string, ResultEntry>();
    for (const entry of instance?.entries ?? []) if (entry.type === 'result') results.set(entry.stepId, entry);
    const values = instance ? instance.parameterValues : defaultValues(content.parameters);
    const readableValues = Object.fromEntries(content.parameters.map(parameter => [parameter.id, values[parameter.id] || `〈${parameter.name}〉`]));
    return content.steps.map((step, index) => {
      const result = results.get(step.id), current = instance?.status === 'in_progress' && instance.currentStepId === step.id;
      const frozen = result && result.outcome !== 'failed';
      const shown = frozen && instance ? displayedStep({ ...instance, document: content }, step) : {
        title: renderText(step.title, readableValues), description: renderText(step.description, readableValues),
        commands: step.commands.map(command => ({ id: command.id, text: renderText(command.text, readableValues) })), parameterValues: values,
      };
      const status: NavigationStatus = result?.outcome ?? (current ? 'current' : instance?.status === 'terminated' ? 'unexecuted' : 'pending');
      const group = content.groups?.find(group => group.id === step.groupId);
      return { id: step.id, index, groupId: step.groupId, groupName: group?.name, groupDescription: group?.description, shown, status, current, reason: result?.reason };
    });
  }, [content, instance]);
  const done = rows.filter(row => row.status === 'completed' || row.status === 'skipped').length;
  const previewRow = rows.find(row => row.id === preview?.id);
  const current = rows.find(row => row.current);
  useEffect(() => { onViewingChange?.(viewing); }, [viewing, onViewingChange]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const requested = root.dataset.stepJumpTarget;
      if (requested && rows.some(row => row.id === requested)) { setViewing(requested); return; }
      const edge = root.getBoundingClientRect().top + 32;
      let first: string | undefined, last: string | undefined, selected: string | undefined;
      for (const node of root.querySelectorAll<HTMLElement>('.step-card[data-step-id], .step-group[data-group-id]')) {
        const id = node.dataset.stepId ?? (!node.querySelector('.step-card') ? rows.find(row => row.groupId === node.dataset.groupId)?.id : undefined);
        if (!id) continue;
        first ??= id;
        last = id;
        if (node.getBoundingClientRect().top <= edge) selected = id;
      }
      if (root.scrollTop > 0 && root.scrollHeight > root.clientHeight + 2 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2) selected = last;
      setViewing(selected ?? first);
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(update); };
    const targetChanged = () => {
      const requested = root.dataset.stepJumpTarget;
      if (requested) { setViewing(requested); setJumpVersion(version => version + 1); }
      else schedule();
    };
    const mutation = new MutationObserver(schedule), resize = new ResizeObserver(schedule);
    mutation.observe(root, { subtree: true, childList: true });
    resize.observe(root);
    if (root.firstElementChild) resize.observe(root.firstElementChild);
    root.addEventListener('scroll', schedule, { passive: true });
    root.addEventListener(jumpTargetChanged, targetChanged);
    window.addEventListener('resize', schedule);
    schedule();
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); mutation.disconnect(); resize.disconnect(); root.removeEventListener('scroll', schedule); root.removeEventListener(jumpTargetChanged, targetChanged); window.removeEventListener('resize', schedule); };
  }, [rows, scrollRef]);

  useEffect(() => {
    const list = listRef.current;
    const row = list && [...list.querySelectorAll<HTMLElement>('[data-nav-step-id]')].find(node => node.dataset.navStepId === viewing);
    if (!list || !row) return;
    const bounds = list.getBoundingClientRect(), target = row.getBoundingClientRect();
    const offset = target.top < bounds.top ? target.top - bounds.top - 8 : target.bottom > bounds.bottom ? target.bottom - bounds.bottom + 8 : 0;
    if (!offset) return;
    const destination = Math.max(0, Math.min(list.scrollTop + offset, list.scrollHeight - list.clientHeight));
    const stop = () => { list.scrollTo({ top: list.scrollTop, behavior: 'instant' }); };
    list.scrollTo({ top: destination, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    list.addEventListener('wheel', stop, { passive: true });
    list.addEventListener('touchstart', stop, { passive: true });
    list.addEventListener('pointerdown', stop, { passive: true });
    list.addEventListener('keydown', stop);
    return () => {
      stop();
      list.removeEventListener('wheel', stop); list.removeEventListener('touchstart', stop);
      list.removeEventListener('pointerdown', stop); list.removeEventListener('keydown', stop);
    };
  }, [viewing, expanded, jumpVersion]);

  useEffect(() => {
    if (!preview) return;
    const dismiss = () => setPreview(null);
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } };
    window.addEventListener('keydown', escape);
    window.addEventListener('resize', dismiss);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('resize', dismiss); };
  }, [preview]);

  useLayoutEffect(() => {
    if (!preview || !previewRef.current) return;
    const bounds = previewRef.current.getBoundingClientRect();
    setPosition({ left: Math.max(12, Math.min(window.innerWidth - bounds.width - 12, preview.left + 12)), top: Math.max(12, Math.min(preview.top - 16, window.innerHeight - bounds.height - 12)) });
  }, [preview, previewRow]);

  function showPreview(row: Row, button: HTMLButtonElement) {
    const bounds = button.getBoundingClientRect();
    setPreview({ id: row.id, left: bounds.right, top: bounds.top });
  }
  function locate(id: string) { setPreview(null); setViewing(id); onLocate(id); }
  function scrollPreview() {
    if (!preview || !listRef.current) return;
    const button = [...listRef.current.querySelectorAll<HTMLButtonElement>('[data-nav-step-id]')].find(node => node.dataset.navStepId === preview.id);
    const row = rows.find(item => item.id === preview.id);
    if (!button || !row) { setPreview(null); return; }
    const list = listRef.current.getBoundingClientRect(), target = button.getBoundingClientRect();
    if (target.bottom <= list.top || target.top >= list.bottom) setPreview(null);
    else showPreview(row, button);
  }
  function keys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : undefined;
    if (target === undefined) return;
    event.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>('[data-nav-step-id]')[target]?.focus({ preventScroll: true });
    const list = listRef.current, button = list?.querySelectorAll<HTMLButtonElement>('[data-nav-step-id]')[target];
    if (list && button) { const bounds = list.getBoundingClientRect(), item = button.getBoundingClientRect(); if (item.top < bounds.top) list.scrollTop += item.top - bounds.top; else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom; }
  }

  return <aside className={`step-navigation ${expanded ? 'expanded' : 'compact'}`} data-step-navigation aria-label="步骤导航">
    <header className="step-nav-header"><button className="icon-button" aria-label={expanded ? '收起步骤目录' : '展开步骤目录'} aria-expanded={expanded} onClick={() => { setPreview(null); setExpanded(!expanded); }}>{expanded ? <ChevronsLeft size={17} /> : <ListTree size={18} />}</button>{expanded && <strong>步骤目录</strong>}</header>
    <div className="step-nav-progress" data-nav-progress aria-label={instance ? `${done} / ${rows.length} 步已推进` : `共 ${rows.length} 个步骤`}><strong>{instance ? `${done} / ${rows.length}` : rows.length}</strong><span>{instance ? '已推进' : '个步骤'}</span></div>
    {current && <button className="step-nav-return" aria-label="返回当前步骤" title="返回当前步骤" onClick={() => locate(current.id)}><Crosshair size={16} />{expanded && <span>返回当前步骤</span>}</button>}
    <div className="step-nav-list" ref={listRef} onScroll={scrollPreview} onMouseLeave={() => setPreview(null)}>
      {rows.map((row, index) => <div className={`step-nav-entry ${index > 0 && row.groupId !== rows[index - 1].groupId ? 'section-start' : ''}`} key={row.id}>
        {expanded && row.groupId && row.groupId !== rows[index - 1]?.groupId && <div className="step-nav-group" title={row.groupName || "未命名步骤组"}>{row.groupName || "未命名步骤组"}</div>}
        <button data-nav-step-id={row.id} data-nav-status={row.status} data-current={row.current} data-viewing={viewing === row.id} aria-current={viewing === row.id ? 'location' : undefined} aria-label={`步骤 ${row.index + 1}：${row.shown.title || '未命名步骤'} · ${labels[row.status]}${row.current && row.status !== 'current' ? ' · 当前步骤' : ''}`} aria-describedby={preview?.id === row.id ? previewId : undefined} className="step-nav-row" onMouseEnter={event => showPreview(row, event.currentTarget)} onFocus={event => showPreview(row, event.currentTarget)} onBlur={() => setPreview(null)} onClick={() => locate(row.id)} onKeyDown={event => keys(event, index)}>
          <span className="step-nav-indicator" data-nav-indicator><StatusIcon status={row.status} /></span>{expanded && <><span className="step-nav-number">{String(row.index + 1).padStart(2, '0')}</span><span className="step-nav-title">{row.shown.title || '未命名步骤'}</span>{row.current && <span className="step-nav-current-dot" aria-hidden="true" />}</>}
        </button>
      </div>)}
    </div>
    {preview && previewRow && createPortal(<div className="step-nav-preview" id={previewId} ref={previewRef} role="tooltip" data-preview-step-id={previewRow.id} style={position}>
      <div className="step-nav-preview-meta"><span>步骤 {String(previewRow.index + 1).padStart(2, '0')}{previewRow.groupName ? ` · ${previewRow.groupName}` : ''}</span><b data-status={previewRow.status}>{labels[previewRow.status]}{previewRow.current && previewRow.status !== 'current' ? ' · 当前' : ''}</b></div>
      <strong>{previewRow.shown.title || '未命名步骤'}</strong>{previewRow.groupDescription && <p className="step-nav-group-description"><b>步骤块说明</b>{previewRow.groupDescription}</p>}{previewRow.shown.description && <p>{previewRow.shown.description}</p>}
      {previewRow.shown.commands.length ? <div className="step-nav-preview-commands">{previewRow.shown.commands.slice(0, 3).map(command => <pre key={command.id}>{command.text}</pre>)}{previewRow.shown.commands.length > 3 && <small>另有 {previewRow.shown.commands.length - 3} 条命令</small>}</div> : <div className="step-nav-preview-manual">人工检查点</div>}
      {previewRow.reason && <p className="step-nav-preview-reason">{previewRow.status === 'failed' ? '失败原因' : '跳过原因'}：{previewRow.reason}</p>}
    </div>, window.document.body)}
  </aside>;
}
