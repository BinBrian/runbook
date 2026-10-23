import { useRef } from 'react';
import { Copy } from 'lucide-react';
import { InlineParts, type InlinePartsProps } from './InlineEditable';
import { CommandActions } from './StepActions';
import type { PendingValue } from './interaction-state';

export interface CommandCardProps extends Omit<InlinePartsProps, 'label' | 'command' | 'className'> {
  commandId: string;
  index: number;
  busy?: boolean;
  onCopy: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
  pendingValues?: PendingValue[];
  onInspectPending?: (id: string) => void;
}

/** Definitions display variable names; instances supply applied or frozen
 * values. All contexts retain the same editor, command identity and controls. */
export function CommandCard({ commandId, index, busy = false, onCopy, onMoveUp, onMoveDown, onRemove, readOnly = false, onActivated, pendingValues = [], onInspectPending, ...fields }: CommandCardProps) {
  const card = useRef<HTMLDivElement>(null);
  function activated() {
    const node = card.current, root = node?.closest<HTMLElement>('.workspace-scroll');
    if (node && root) {
      const bounds = root.getBoundingClientRect(), rect = node.getBoundingClientRect();
      if (rect.top < bounds.top + 14 || rect.bottom > bounds.bottom - 14) root.scrollTo({ top: Math.max(0, root.scrollTop + rect.top - bounds.top - 14), behavior: 'instant' });
    }
    onActivated?.();
  }
  return <div ref={card} className="command-card inline-command-card" data-command-id={commandId}>
    <div className="command-card-actions" data-command-header>
      <button className="button small" type="button" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={onCopy}><Copy size={13} />复制命令</button>
      {!readOnly && onRemove && <CommandActions disabled={busy} onMoveUp={onMoveUp} onMoveDown={onMoveDown} onRemove={onRemove} />}
    </div>
    {pendingValues.length > 0 && <div className="command-pending-values" role="status"><strong>参数修改尚未应用 · 复制仍使用当前生效值</strong>{pendingValues.map(item => <div className="command-pending-value" key={item.id}><span>{item.label}</span><span>当前生效：<code>{item.applied || '空'}</code> → 待应用：<code>{item.next || '空'}</code></span><button className="text-button" type="button" aria-label={`查看并应用 ${item.label}`} onClick={() => onInspectPending?.(item.id)}>查看并应用</button></div>)}</div>}
    <InlineParts {...fields} className="inline-command" command label={`命令 ${index + 1}`} readOnly={readOnly} onActivated={activated} />
  </div>;
}
