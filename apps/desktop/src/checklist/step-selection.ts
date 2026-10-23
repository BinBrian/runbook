import type { ChecklistDocument, Instance } from './types';
import { uid } from './model';

export function selectableStepIds(instance: Instance, document = instance.document): Set<string> {
  const current = document.steps.findIndex(step => step.id === instance.currentStepId);
  return new Set(document.steps.filter((step, index) => !step.groupId && (instance.status === 'draft' || instance.status === 'in_progress' && current >= 0 && index > current)).map(step => step.id));
}
export function selectionReason(document: ChecklistDocument, selected: Set<string>, eligible: Set<string>): string {
  if (selected.size < 2) return '请选择至少两个步骤';
  const indexes = document.steps.flatMap((step, index) => selected.has(step.id) ? [index] : []);
  if (indexes.length !== selected.size || [...selected].some(id => !eligible.has(id))) return '仅能合并未分组、尚未执行的可编辑步骤';
  if (indexes[indexes.length - 1] - indexes[0] + 1 !== indexes.length) return '请选择连续步骤，合并不会自动调整顺序';
  return '';
}
export function selectSteps(document: ChecklistDocument, selected: Set<string>, eligible: Set<string>, id: string, anchor?: string, range = false): Set<string> {
  if (!eligible.has(id)) throw new Error('此步骤不能参与合组');
  const next = new Set(selected);
  if (range && anchor) {
    const first = document.steps.findIndex(step => step.id === anchor), last = document.steps.findIndex(step => step.id === id);
    if (first < 0 || last < 0) throw new Error('原选择范围已改变，请重新选择');
    const steps = document.steps.slice(Math.min(first, last), Math.max(first, last) + 1);
    if (steps.some(step => !eligible.has(step.id))) throw new Error('范围包含已分组或不可编辑步骤，请选择同级连续步骤');
    steps.forEach(step => next.add(step.id));
  } else if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
export function mergeSteps(document: ChecklistDocument, selected: Set<string>, eligible: Set<string>, groupId: string = uid()): ChecklistDocument {
  const reason = selectionReason(document, selected, eligible); if (reason) throw new Error(reason);
  if (document.steps.some(step => step.id === groupId) || document.groups?.some(group => group.id === groupId)) throw new Error('步骤组身份已存在');
  return { ...structuredClone(document), groups: [...structuredClone(document.groups ?? []), { id: groupId, name: '', description: '' }], steps: document.steps.map(step => selected.has(step.id) ? { ...structuredClone(step), groupId } : structuredClone(step)) };
}
