import { FilePenLine, X } from 'lucide-react';
import type { DraftEntry } from './drafts';
import type { Workspace } from './types';

export function DraftMenu({ entries, workspace, busy, onOpen, onDiscard }: {
  entries: [string, DraftEntry][]; workspace: Workspace; busy: boolean;
  onOpen: (key: string, entry: DraftEntry) => void; onDiscard: (key: string) => void;
}) {
  if (!entries.length) return null;
  return <details className="draft-menu more-menu"><summary className="button small" aria-label={`本地草稿 ${entries.length}`}><FilePenLine size={14} />草稿 {entries.length}</summary><div>
    {entries.map(([key, entry]) => {
      const target = entry.target;
      const item = target && (target.kind === 'template' ? workspace.templates : target.kind === 'block' ? workspace.blocks ?? [] : workspace.instances).find(item => item.id === target.id);
      const step = item?.document.steps.find(step => step.id === target?.stepId);
      const title = step?.title.filter(part => typeof part === 'string').join('');
      return <section key={key} className="draft-menu-row"><button disabled={busy || !target} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onOpen(key, entry); }}><strong>{item?.name || entry.label}</strong><small>{[item && entry.label, title].filter(Boolean).join(' · ')}</small></button><button className="icon-button" disabled={busy} title="丢弃此草稿" aria-label={`丢弃草稿 ${item?.name || entry.label} ${entry.label}`} onClick={() => onDiscard(key)}><X size={14} /></button></section>;
    })}
  </div></details>;
}
