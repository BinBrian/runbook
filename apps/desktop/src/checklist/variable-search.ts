import { renderText } from './model';
import type { ChecklistDocument, Parameter, Step } from './types';

export function parameterLabel(document: ChecklistDocument, parameter: Parameter, values: Record<string, string>): string {
  const group = document.groups?.find(group => group.id === parameter.ownerId);
  const step = document.steps.find(step => step.id === parameter.ownerId);
  const parent = step?.groupId ? document.groups?.find(group => group.id === step.groupId) : undefined;
  const namespace = group ? [group.name.trim() || '未命名步骤组'] : step ? [
    ...(parent ? [parent.name.trim() || '未命名步骤组'] : []),
    renderText(step.title, values).trim() || '未命名步骤',
  ] : [];
  return [...namespace, parameter.name].join('.');
}

/** Search parameter definitions, then their actual references; never infer use from ownership. */
export function variableSteps(document: ChecklistDocument, query: string, values: Record<string, string>, parameterId?: string): Step[] {
  const search = query.trim().toLocaleLowerCase();
  if (!search && !parameterId) return document.steps;
  const ids = new Set(document.parameters.filter(parameter => parameterId
    ? parameter.id === parameterId
    : parameterLabel(document, parameter, values).toLocaleLowerCase().includes(search)
  ).map(parameter => parameter.id));
  return referencingSteps(document, ids);
}

export function referencingSteps(document: ChecklistDocument, ids: Set<string>): Step[] {
  return document.steps.filter(step => [step.title, step.description, ...step.commands.map(command => command.text)]
    .some(parts => parts.some(part => typeof part !== 'string' && ids.has(part.parameterId))));
}
