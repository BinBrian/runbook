import { referencedParameterIds } from './model';
import type { ChecklistDocument, Parameter, TextParts } from './types';

function editableParameter(document: ChecklistDocument, id: string, editableIds: ReadonlySet<string>): Parameter {
  const parameter = document.parameters.find(value => value.id === id);
  if (!parameter) throw new Error('变量已不存在，请刷新后重试。');
  if (!editableIds.has(id)) throw new Error(`“${parameter.name}”已锁定，不能更改定义。`);
  return parameter;
}

/** Scope changes keep the identity used by text references and applied/draft values. */
export function promoteParameter(document: ChecklistDocument, id: string, editableIds: ReadonlySet<string>): ChecklistDocument {
  const parameter = editableParameter(document, id, editableIds);
  if (!parameter.ownerId) throw new Error(`“${parameter.name}”已经是全局变量。`);
  if (document.parameters.some(value => value.id !== id && !value.ownerId && value.name.trim() === parameter.name.trim())) {
    throw new Error(`已存在同名全局变量“${parameter.name.trim()}”，请先重命名此局部变量。`);
  }
  const next = structuredClone(document);
  delete next.parameters.find(value => value.id === id)!.ownerId;
  return next;
}

/** Validate the whole selection before freezing references to their effective text. */
export function deleteParameters(
  document: ChecklistDocument,
  ids: ReadonlySet<string>,
  effectiveValues: Record<string, string>,
  editableIds: ReadonlySet<string>,
): ChecklistDocument {
  if (!ids.size) throw new Error('请先选择要删除的变量。');
  const referenced = referencedParameterIds(document);
  for (const id of ids) {
    const parameter = editableParameter(document, id, editableIds);
    if (referenced.has(id) && !Object.hasOwn(effectiveValues, id)) {
      throw new Error(`无法读取“${parameter.name}”的生效值，请刷新后重试。`);
    }
  }
  const replace = (parts: TextParts): TextParts => {
    if (!parts.some(part => typeof part !== 'string' && ids.has(part.parameterId))) return parts;
    return parts.reduce<TextParts>((result, part) => {
      const next = typeof part !== 'string' && ids.has(part.parameterId) ? effectiveValues[part.parameterId] : part;
      if (typeof next === 'string' && typeof result.at(-1) === 'string') result[result.length - 1] = `${result.at(-1)}${next}`;
      else result.push(next);
      return result;
    }, []);
  };
  const next = structuredClone(document);
  next.parameters = next.parameters.filter(parameter => !ids.has(parameter.id));
  next.steps = next.steps.map(step => ({
    ...step, title: replace(step.title), description: replace(step.description),
    commands: step.commands.map(command => ({ ...command, text: replace(command.text) })),
  }));
  return next;
}
