import fixture from '../../../../docs/examples/patch-maintenance/template.runbook.json';
import restartFixture from '../../../../docs/examples/blocks/restart-services.runbook.json';
import transferFixture from '../../../../docs/examples/blocks/transfer-player.runbook.json';
import type { BlockDefinition, ChecklistDocument, Instance, Parameter, ResultEntry, Snapshot, Step, TextParts } from './types';

export const uid = () => crypto.randomUUID();
export const emptyDocument = (): ChecklistDocument => ({ parameters: [], steps: [{ id: uid(), title: [''], description: [''], commands: [] }] });
export const exampleDocument = (): ChecklistDocument => structuredClone(fixture.document);
export const exampleBlocks = (): BlockDefinition[] => structuredClone([restartFixture, transferFixture]) as BlockDefinition[];
export const defaultValues = (parameters: Parameter[]): Record<string, string> => Object.fromEntries(parameters.map(p => [p.id, p.defaultValue]));
export function renderText(parts: TextParts, values: Record<string, string>): string {
  return parts.map(part => typeof part === 'string' ? part : values[part.parameterId] ?? '').join('');
}
export function renderStep(step: Step, values: Record<string, string>): Snapshot {
  return { title: renderText(step.title, values), description: renderText(step.description, values),
    commands: step.commands.map(c => ({ id: c.id, text: renderText(c.text, values) })), parameterValues: { ...values } };
}
export function referencedParameterIds(document: ChecklistDocument): Set<string> {
  const ids = new Set<string>();
  for (const step of document.steps) for (const parts of [step.title, step.description, ...step.commands.map(c => c.text)]) {
    for (const part of parts) if (typeof part !== 'string') ids.add(part.parameterId);
  }
  return ids;
}
export function missingParameters(document: ChecklistDocument, values: Record<string, string>): Parameter[] {
  const referenced = referencedParameterIds(document);
  return document.parameters.filter(p => referenced.has(p.id) && !values[p.id]?.trim());
}
export const stepResults = (instance: Instance, stepId: string): ResultEntry[] => instance.entries.filter((e): e is ResultEntry => e.stepId === stepId && e.type === 'result');
export const latestResult = (instance: Instance, stepId: string): ResultEntry | undefined => stepResults(instance, stepId).at(-1);
export const advancedCount = (instance: Instance): number => instance.document.steps.filter(s => {
  const result = latestResult(instance, s.id); return result?.outcome === 'completed' || result?.outcome === 'skipped';
}).length;
export function displayedStep(instance: Instance, step: Step): Snapshot {
  const result = latestResult(instance, step.id);
  return result && result.outcome !== 'failed' ? result.snapshot : renderStep(step, instance.parameterValues);
}
export const outcomeLabels = { completed: '已完成', failed: '失败', skipped: '已跳过' } as const;
export const statusLabels = { draft: '待开始', in_progress: '进行中', completed: '已完成', terminated: '已终止' } as const;
export function formatTime(value: string | null): string {
  if (!value) return '尚未开始';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export const globalParameters = (document: ChecklistDocument): Parameter[] => document.parameters.filter(parameter => !parameter.ownerId);
export const localParameters = (document: ChecklistDocument, ownerId: string): Parameter[] => document.parameters.filter(parameter => parameter.ownerId === ownerId);
export const groupForStep = (document: ChecklistDocument, stepId: string) => (document.groups ?? []).find(group => group.id === document.steps.find(step => step.id === stepId)?.groupId);
export const groupSteps = (document: ChecklistDocument, groupId: string): Step[] => document.steps.filter(step => step.groupId === groupId);
export function visibleParameters(document: ChecklistDocument, stepId: string): Parameter[] {
  const step = document.steps.find(value => value.id === stepId);
  return document.parameters.filter(parameter => !parameter.ownerId || parameter.ownerId === stepId || Boolean(step?.groupId && parameter.ownerId === step.groupId));
}
export function parameterTargetStep(document: ChecklistDocument, parameterId: string): string | undefined {
  const parameter = document.parameters.find(value => value.id === parameterId);
  if (!parameter) return undefined;
  const ownedStep = document.steps.find(step => step.id === parameter.ownerId || step.groupId === parameter.ownerId);
  if (ownedStep) return ownedStep.id;
  return document.steps.find(step => [step.title, step.description, ...step.commands.map(command => command.text)].some(parts => parts.some(part => typeof part !== 'string' && part.parameterId === parameterId)))?.id;
}
export function canEditParameter(instance: Instance, parameter: Parameter): boolean {
  if (instance.status === 'draft') return true;
  if (instance.status !== 'in_progress') return false;
  if (!parameter.ownerId) return true;
  const cursor = instance.document.steps.findIndex(step => step.id === instance.currentStepId);
  return instance.document.steps.some((step, index) => index >= cursor && (step.id === parameter.ownerId || step.groupId === parameter.ownerId));
}
export function canEditParameterDefinition(instance: Instance, parameter: Parameter): boolean {
  if (!canEditParameter(instance, parameter)) return false;
  return !instance.document.steps.some(step => {
    const result = latestResult(instance, step.id);
    return result && result.outcome !== 'failed' && referencedParameterIds({ parameters: instance.document.parameters, steps: [step] }).has(parameter.id);
  });
}
export function blockEmptyDocument(name = ''): ChecklistDocument {
  const groupId = uid();
  return { parameters: [], groups: [{ id: groupId, name }], steps: [{ id: uid(), title: [''], description: [''], commands: [], groupId }] };
}

/** Remap identities explicitly; names never participate in variable binding. */
function copyGroup(document: ChecklistDocument, groupId: string, captureGlobals: boolean, name?: string) {
  const sourceGroup = document.groups?.find(group => group.id === groupId);
  if (!sourceGroup) throw new Error('找不到步骤组。');
  const sourceSteps = groupSteps(document, groupId);
  if (!sourceSteps.length) throw new Error('步骤组不能为空。');
  const nextGroupId = uid();
  const stepsById = new Map(sourceSteps.map(step => [step.id, uid()]));
  const referenced = referencedParameterIds({ parameters: document.parameters, steps: sourceSteps });
  const sourceParameters = document.parameters.filter(parameter => parameter.ownerId === groupId || Boolean(parameter.ownerId && stepsById.has(parameter.ownerId)) || (captureGlobals && referenced.has(parameter.id)));
  const parameterIds = new Map(sourceParameters.map(parameter => [parameter.id, uid()]));
  const remap = (parts: TextParts): TextParts => parts.map(part => typeof part === 'string' ? part : { parameterId: parameterIds.get(part.parameterId) ?? part.parameterId });
  return {
    group: { ...structuredClone(sourceGroup), id: nextGroupId, name: name ?? sourceGroup.name },
    parameters: sourceParameters.map(parameter => ({ ...structuredClone(parameter), id: parameterIds.get(parameter.id)!, ownerId: parameter.ownerId && stepsById.has(parameter.ownerId) ? stepsById.get(parameter.ownerId)! : nextGroupId })),
    steps: sourceSteps.map(step => ({ ...structuredClone(step), id: stepsById.get(step.id)!, groupId: nextGroupId,
      title: remap(step.title), description: remap(step.description), commands: step.commands.map(command => ({ id: uid(), text: remap(command.text) })) })),
  };
}
export function cloneGroup(document: ChecklistDocument, groupId: string): ChecklistDocument {
  const sourceName = document.groups?.find(group => group.id === groupId)?.name ?? '';
  const copied = copyGroup(document, groupId, false, sourceName.trim() ? `${sourceName} · 副本` : '');
  const last = document.steps.map(step => step.groupId).lastIndexOf(groupId);
  return { ...structuredClone(document), parameters: [...structuredClone(document.parameters), ...copied.parameters], groups: [...structuredClone(document.groups ?? []), copied.group],
    steps: [...structuredClone(document.steps.slice(0, last + 1)), ...copied.steps, ...structuredClone(document.steps.slice(last + 1))] };
}
export function cloneStep(document: ChecklistDocument, stepId: string): ChecklistDocument {
  const index = document.steps.findIndex(step => step.id === stepId);
  if (index < 0) throw new Error('找不到步骤。');
  const next = structuredClone(document), source = document.steps[index], nextStepId = uid();
  const parameters = localParameters(document, stepId);
  const parameterIds = new Map(parameters.map(parameter => [parameter.id, uid()]));
  const remap = (parts: TextParts): TextParts => parts.map(part => typeof part === 'string' ? part : { parameterId: parameterIds.get(part.parameterId) ?? part.parameterId });
  const copied: Step = { ...structuredClone(source), id: nextStepId,
    title: remap(source.title), description: remap(source.description), commands: source.commands.map(command => ({ id: uid(), text: remap(command.text) })) };
  next.parameters.push(...parameters.map(parameter => ({ ...structuredClone(parameter), id: parameterIds.get(parameter.id)!, ownerId: nextStepId })));
  next.steps.splice(index + 1, 0, copied);
  return next;
}
export function convertStepToGroup(document: ChecklistDocument, stepId: string): ChecklistDocument {
  const index = document.steps.findIndex(step => step.id === stepId);
  if (index < 0) throw new Error('找不到步骤。');
  const next = structuredClone(document);
  if (next.steps[index].groupId) return next;
  const title = renderText(next.steps[index].title, defaultValues(next.parameters)).trim();
  const name = !title.includes('\0') && new TextEncoder().encode(title).length <= 1024 ? title : '';
  const group = { id: uid(), name };
  next.groups = [...(next.groups ?? []), group];
  next.steps[index].groupId = group.id;
  return next;
}
export function insertBlock(document: ChecklistDocument, block: BlockDefinition, afterIndex = document.steps.length - 1): ChecklistDocument {
  if (block.document.groups?.length !== 1) throw new Error('步骤块必须包含一个完整步骤组。');
  const sourceId = block.document.groups[0].id;
  const copied = copyGroup(block.document, sourceId, true, block.favorite ? undefined : block.name);
  copied.group.sourceBlockId = block.id;
  let index = Math.max(-1, Math.min(afterIndex, document.steps.length - 1));
  const parentGroup = document.steps[index]?.groupId;
  if (block.favorite?.kind === 'step') {
    if (copied.steps.length !== 1 || copied.parameters.some(parameter => parameter.ownerId !== copied.steps[0].id)) throw new Error('单步收藏内容或变量范围无效。');
    const step: Step = copied.steps[0];
    if (parentGroup) step.groupId = parentGroup; else delete step.groupId;
    return { ...structuredClone(document), parameters: [...structuredClone(document.parameters), ...copied.parameters], steps: [...structuredClone(document.steps.slice(0, index + 1)), step, ...structuredClone(document.steps.slice(index + 1))] };
  }
  if (parentGroup) index = document.steps.map(step => step.groupId).lastIndexOf(parentGroup);
  return { ...structuredClone(document), parameters: [...structuredClone(document.parameters), ...copied.parameters], groups: [...structuredClone(document.groups ?? []), copied.group],
    steps: [...structuredClone(document.steps.slice(0, index + 1)), ...copied.steps, ...structuredClone(document.steps.slice(index + 1))] };
}
export function groupAsBlock(document: ChecklistDocument, groupId: string, name: string, id: string = uid()): BlockDefinition {
  const copied = copyGroup(document, groupId, true, name);
  delete copied.group.sourceBlockId;
  const at = new Date().toISOString();
  return { formatVersion: 2, kind: 'block', id, name, document: { groups: [copied.group], parameters: copied.parameters, steps: copied.steps }, createdAt: at, updatedAt: at };
}
export function removeGroup(document: ChecklistDocument, groupId: string): ChecklistDocument {
  const owners = new Set([groupId, ...groupSteps(document, groupId).map(step => step.id)]);
  const steps = document.steps.filter(step => step.groupId !== groupId);
  return { ...structuredClone(document), parameters: structuredClone(document.parameters.filter(parameter => !parameter.ownerId || !owners.has(parameter.ownerId))),
    groups: structuredClone((document.groups ?? []).filter(group => group.id !== groupId)), steps: steps.length ? structuredClone(steps) : emptyDocument().steps };
}
export function removeStep(document: ChecklistDocument, stepId: string): ChecklistDocument {
  const removed = document.steps.find(step => step.id === stepId);
  let next = { ...structuredClone(document), parameters: structuredClone(document.parameters.filter(parameter => parameter.ownerId !== stepId)), steps: structuredClone(document.steps.filter(step => step.id !== stepId)) };
  if (removed?.groupId && !next.steps.some(step => step.groupId === removed.groupId)) next = removeGroup(next, removed.groupId);
  if (!next.steps.length) next.steps = emptyDocument().steps;
  return next;
}
