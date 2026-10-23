import type { ChecklistDocument, Parameter } from './types';
import { parameterLabel } from './variable-search';

export function MissingParameters({ document, parameters, values, onSelect }: {
  document: ChecklistDocument;
  parameters: Parameter[];
  values: Record<string, string>;
  onSelect: (parameterId: string) => void;
}) {
  if (!parameters.length) return null;
  return <ul className="missing-parameter-tags" aria-label="待填写变量">
    {parameters.map(parameter => {
      const label = parameterLabel(document, parameter, values);
      return <li key={parameter.id}><button type="button" className="missing-parameter-tag" data-parameter-target={parameter.id} data-parameter-kind={parameter.ownerId ? 'local' : 'global'} title={`${label}：未填写`} onClick={() => onSelect(parameter.id)}>{label}</button></li>;
    })}
  </ul>;
}
