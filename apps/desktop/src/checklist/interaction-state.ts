import type { ChecklistDocument, TextParts } from './types';
import { parameterLabel } from './variable-search';

export interface PendingValue { id: string; label: string; applied: string; next: string }

export function pendingValues(document: ChecklistDocument, parts: TextParts[], applied: Record<string, string>, draft: Record<string, string>): PendingValue[] {
  const ids = new Set(parts.flat().flatMap(part => typeof part === 'string' ? [] : [part.parameterId]));
  return document.parameters.filter(parameter => ids.has(parameter.id)).flatMap(parameter => {
    const current = applied[parameter.id] ?? parameter.defaultValue;
    const next = draft[parameter.id] ?? current;
    return next === current ? [] : [{ id: parameter.id, label: parameterLabel(document, parameter, applied), applied: current, next }];
  });
}

export function pendingStepValues(document: ChecklistDocument, stepId: string, applied: Record<string, string>, draft: Record<string, string>) {
  const step = document.steps.find(item => item.id === stepId);
  return step ? pendingValues(document, [step.title, step.description, ...step.commands.map(command => command.text)], applied, draft) : [];
}

export function referenceCount(document: ChecklistDocument, ids: Set<string>): number {
  return document.steps.reduce((count, step) => count + [step.title, step.description, ...step.commands.map(command => command.text)].flat().filter(part => typeof part !== 'string' && ids.has(part.parameterId)).length, 0);
}
