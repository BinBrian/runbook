import { latestResult, renderText } from './model';
import { parameterLabel } from './variable-search';
import type { ChecklistDocument, Instance, Parameter, ResultEntry } from './types';

export interface VariableBranch { id: string; kind: 'group' | 'step'; name: string; parameters: Parameter[]; children: VariableBranch[] }
export function variableBranches(document: ChecklistDocument, values: Record<string, string>): VariableBranch[] {
  const branch = (id: string, kind: 'group' | 'step', name: string): VariableBranch => ({ id, kind, name, parameters: document.parameters.filter(p => p.ownerId === id), children: [] });
  const roots: VariableBranch[] = [], groups = new Map<string, VariableBranch>();
  for (const step of document.steps) {
    if (step.groupId && !groups.has(step.groupId)) {
      const group = document.groups?.find(g => g.id === step.groupId);
      if (group) { const node = branch(group.id, 'group', group.name.trim() || '未命名步骤组'); groups.set(group.id, node); roots.push(node); }
    }
    const node = branch(step.id, 'step', renderText(step.title, values).trim() || '未命名步骤');
    if (node.parameters.length) { const parent = step.groupId && groups.get(step.groupId); if (parent) parent.children.push(node); else roots.push(node); }
  }
  return roots.filter(node => node.parameters.length || node.children.length);
}

/** Stable identity takes precedence over names, descriptions and displayed values. */
export function matchingVariableIds(document: ChecklistDocument, query: string, values: Record<string, string>, parameterId?: string): Set<string> {
  const search = query.trim().toLocaleLowerCase();
  return new Set(document.parameters.filter(p => parameterId ? p.id === parameterId : !search || [parameterLabel(document, p, values), p.description, values[p.id] ?? ''].some(s => s.toLocaleLowerCase().includes(search))).map(p => p.id));
}

/** Unrelated scopes must not borrow a browsed step's old values or its edit lock. */
export function variableHistory(instance: Instance | undefined, parameter: Parameter, viewedStepId?: string): ResultEntry | undefined {
  if (!instance) return;
  const finished = (id?: string) => { const r = id ? latestResult(instance, id) : undefined; return r && r.outcome !== 'failed' ? r : undefined; };
  const viewed = instance.document.steps.find(step => step.id === viewedStepId);
  if (!parameter.ownerId) return finished(viewedStepId);
  const ownedStep = instance.document.steps.find(step => step.id === parameter.ownerId);
  if (ownedStep) return finished(ownedStep.id);
  if (viewed?.groupId === parameter.ownerId) return finished(viewedStepId);
  const members = instance.document.steps.filter(step => step.groupId === parameter.ownerId);
  if (members.length && members.every(step => finished(step.id))) return finished(members.at(-1)?.id);
}
