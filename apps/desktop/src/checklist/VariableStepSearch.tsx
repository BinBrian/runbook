import { Search, X } from 'lucide-react';

export function VariableStepSearch({ query, parameterId, count, total, onChange, onClear }: {
  query: string;
  parameterId?: string;
  count: number;
  total: number;
  onChange: (query: string) => void;
  onClear: () => void;
}) {
  const active = Boolean(query.trim() || parameterId);
  return <div className="variable-step-search" role="search" aria-label="变量引用步骤" data-step-search-parameter-id={parameterId}>
    <Search size={15} />
    <input type="search" aria-label="按变量搜索步骤" placeholder="搜索变量，查看引用步骤" value={query} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClear(); } }} />
    {query && <button className="icon-button" type="button" aria-label="清空步骤搜索" onMouseDown={event => event.preventDefault()} onClick={onClear}><X size={15} /></button>}
    <span role="status">{active ? `${count} / ${total} 步` : `${total} 步`}</span>
  </div>;
}
