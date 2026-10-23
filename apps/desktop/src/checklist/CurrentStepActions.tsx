import { useLayoutEffect, useState, type RefObject } from 'react';
import { ArrowRight, Check } from 'lucide-react';

interface Props {
  scrollRef: RefObject<HTMLDivElement | null>;
  stepId?: string | null;
  viewingId?: string;
  index: number;
  title: string;
  layoutKey: string;
  last: boolean;
  busy: boolean;
  onReturn: () => void;
  onComplete: () => void;
  onFailed: () => void;
  onSkip: () => void;
}

/** A separate flex row leaves every line of the scrollable content reachable. */
export function CurrentStepActions({ scrollRef, stepId, viewingId, index, title, layoutKey, last, busy, onReturn, onComplete, onFailed, onSkip }: Props) {
  const [mode, setMode] = useState<'hidden' | 'return' | 'actions'>('hidden');
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root || !stepId) { setMode('hidden'); return; }
    let frame = 0;
    function measure() {
      frame = 0;
      const card = [...root!.querySelectorAll<HTMLElement>('[data-step-id]')].find(node => node.dataset.stepId === stepId);
      const rect = card?.getBoundingClientRect(), bounds = root!.getBoundingClientRect();
      const actions = card?.querySelector<HTMLElement>('[data-step-result-actions]')?.getBoundingClientRect();
      const visible = actions && actions.top >= bounds.top && actions.bottom <= bounds.bottom;
      const elsewhere = viewingId !== stepId || !rect || rect.bottom <= bounds.top || rect.top >= bounds.bottom;
      setMode(elsewhere ? 'return' : visible ? 'hidden' : 'actions');
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    if (root.firstElementChild) observer.observe(root.firstElementChild);
    root.addEventListener('scroll', schedule, { passive: true });
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); root.removeEventListener('scroll', schedule); };
  }, [scrollRef, stepId, viewingId, layoutKey]);
  if (!stepId || mode === 'hidden') return null;
  return <div className="current-step-actions" role="region" aria-label="当前步骤快捷操作">
    <div className="current-step-actions-title"><small>当前步骤 · {index + 1}</small><strong title={title}>{title || '未命名步骤'}</strong></div>
    {mode === 'return' ? <button className="button" onClick={onReturn}>返回当前步骤<ArrowRight size={14} /></button> : <div className="current-step-actions-buttons">
      <button className="button primary" aria-label={last ? '快捷完成并结束' : '快捷完成并下一步'} disabled={busy} onMouseDown={event => event.preventDefault()} onClick={onComplete}><Check size={14} />{last ? '完成并结束' : '完成并下一步'}</button>
      <button className="button" aria-label="快捷记录失败" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={onFailed}>记录失败</button>
      <button className="text-button" aria-label="快捷跳过" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={onSkip}>跳过</button>
    </div>}
  </div>;
}
