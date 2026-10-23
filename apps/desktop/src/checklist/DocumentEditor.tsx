import { useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import type { BlockDefinition, ChecklistDocument, Parameter, Step } from './types';
import { cloneGroup, cloneStep, convertStepToGroup, groupSteps, insertBlock, removeGroup, uid, visibleParameters } from './model';
import { StepActions, StepMoreActions } from './StepActions';
import { InlineParts, InlinePlain } from './InlineEditable';
import { CommandCard } from './CommandCard';

export type EditDocument = (update: (document: ChecklistDocument) => ChecklistDocument) => void;
export function newStep(groupId?: string): Step { return { id: uid(), title: [''], description: [''], commands: [], ...(groupId ? { groupId } : {}) }; }
export function removeStepFromDocument(document: ChecklistDocument, stepId: string): ChecklistDocument {
  const steps = document.steps.filter(step => step.id !== stepId);
  const groups = (document.groups ?? []).filter(group => steps.some(step => step.groupId === group.id));
  const owners = new Set([...steps.map(step => step.id), ...groups.map(group => group.id)]);
  return { ...document, steps, groups, parameters: document.parameters.filter(parameter => !parameter.ownerId || owners.has(parameter.ownerId)) };
}
export function StepEditor({ step, document, edit, allowGlobal = true, busy = false, onCopyCommand, commandActivation, onCommandActivated }: {
  step: Step; document: ChecklistDocument; edit: EditDocument; allowGlobal?: boolean; busy?: boolean;
  onCopyCommand: (stepId: string, commandId: string) => void; commandActivation?: { commandId: string; version: number } | null; onCommandActivated?: (commandId: string) => void;
}) {
  const change = (update: (value: Step) => Step) => edit(doc => ({ ...doc, steps: doc.steps.map(item => item.id === step.id ? update(item) : item) }));
  const fields = { parameters: visibleParameters(document, step.id), ownerId: step.id, groupId: step.groupId, allowGlobal, onCreate: (parameter: Parameter) => edit(doc => ({ ...doc, parameters: [...doc.parameters, parameter] })) };
  function moveCommand(commandId: string, direction: -1 | 1) {
    change(value => {
      const index = value.commands.findIndex(command => command.id === commandId), target = index + direction;
      if (index < 0 || target < 0 || target >= value.commands.length) return value;
      const commands = [...value.commands]; [commands[index], commands[target]] = [commands[target], commands[index]];
      return { ...value, commands };
    });
  }
  return <div className="step-content definition-step-content">
    <InlineParts {...fields} className="step-description" label="操作说明" value={step.description} onChange={description => change(value => ({ ...value, description }))} placeholder="添加描述" />
    <div className="command-list">{step.commands.map((command, index) => <CommandCard {...fields} key={command.id} commandId={command.id} index={index} busy={busy} value={command.text} onChange={text => change(value => ({ ...value, commands: value.commands.map(item => item.id === command.id ? { ...item, text } : item) }))} placeholder="填写供复制的命令" onCopy={() => onCopyCommand(step.id, command.id)} onMoveUp={index > 0 ? () => moveCommand(command.id, -1) : undefined} onMoveDown={index < step.commands.length - 1 ? () => moveCommand(command.id, 1) : undefined} onRemove={() => change(value => ({ ...value, commands: value.commands.filter(item => item.id !== command.id) }))} activationKey={commandActivation?.commandId === command.id ? commandActivation.version : undefined} onActivated={() => onCommandActivated?.(command.id)} />)}</div>
  </div>;
}
export function TemplateSteps({ document, edit, blocks = [], onSaveBlock, allowGlobal = true, blockDefinition = false, busy = false, onCopyCommand }: { document: ChecklistDocument; edit: EditDocument; blocks?: BlockDefinition[]; onSaveBlock?: (groupId: string) => void; allowGlobal?: boolean; blockDefinition?: boolean; busy?: boolean; onCopyCommand: (stepId: string, commandId: string) => void }) {
  const [commandActivation, setCommandActivation] = useState<{ commandId: string; version: number } | null>(null);
  const commandVersion = useRef(0);
  const [titleActivation, setTitleActivation] = useState<{ stepId: string; version: number } | null>(null);
  const titleVersion = useRef(0);
  function addCommand(stepId: string) {
    const commandId = uid();
    edit(doc => ({ ...doc, steps: doc.steps.map(step => step.id === stepId ? { ...step, commands: [...step.commands, { id: commandId, text: [''] }] } : step) }));
    setCommandActivation({ commandId, version: ++commandVersion.current });
  }
  function addAfterStep(stepId: string) {
    const source = document.steps.find(step => step.id === stepId); if (!source) return;
    const added = newStep(source.groupId);
    edit(doc => { const index = doc.steps.findIndex(step => step.id === stepId); if (index < 0) return doc; return { ...doc, steps: [...doc.steps.slice(0, index + 1), added, ...doc.steps.slice(index + 1)] }; });
    setTitleActivation({ stepId: added.id, version: ++titleVersion.current });
  }
  function addAfterGroup(groupId: string, inside: boolean) {
    if (!document.steps.some(step => step.groupId === groupId)) return;
    const added = newStep(inside ? groupId : undefined);
    edit(doc => { const last = doc.steps.map(step => step.groupId).lastIndexOf(groupId); if (last < 0) return doc; return { ...doc, steps: [...doc.steps.slice(0, last + 1), added, ...doc.steps.slice(last + 1)] }; });
    setTitleActivation({ stepId: added.id, version: ++titleVersion.current });
  }
  function moveStep(stepId: string, direction: number) { edit(doc => { const steps = [...doc.steps], index = steps.findIndex(step => step.id === stepId), target = index + direction; if (index < 0 || !steps[target] || steps[target].groupId !== steps[index].groupId) return doc; [steps[index], steps[target]] = [steps[target], steps[index]]; return { ...doc, steps }; }); }
  function moveGroup(groupId: string, direction: number) { edit(doc => { const members = groupSteps(doc, groupId); const first = doc.steps.findIndex(step => step.groupId === groupId); const rest = doc.steps.filter(step => step.groupId !== groupId); let at = first; if (direction < 0) { const previous = doc.steps[first - 1]; if (!previous) return doc; at = previous.groupId ? doc.steps.findIndex(step => step.groupId === previous.groupId) : first - 1; } else { const next = rest[first]; if (!next) return doc; at = first + (next.groupId ? groupSteps(doc, next.groupId).length : 1); } return { ...doc, steps: [...rest.slice(0, at), ...members, ...rest.slice(at)] }; }); }
  function renderStep(step: Step, index: number) {
    const fields = { parameters: visibleParameters(document, step.id), ownerId: step.id, groupId: step.groupId, allowGlobal, onCreate: (parameter: Parameter) => edit(doc => ({ ...doc, parameters: [...doc.parameters, parameter] })) };
    const canRemove = document.steps.length > 1 && (!blockDefinition || groupSteps(document, step.groupId!).length > 1);
    const canMoveUp = index > 0 && document.steps[index - 1].groupId === step.groupId, canMoveDown = index < document.steps.length - 1 && document.steps[index + 1].groupId === step.groupId;
    return <section className="step-card editing" data-step-id={step.id} key={step.id}>
      <StepActions blocks={blocks} disabled={busy} onAdd={() => addAfterStep(step.id)} onAddCommand={() => addCommand(step.id)} onInsert={blockDefinition ? undefined : block => edit(doc => insertBlock(doc, block, doc.steps.findIndex(item => item.id === step.id)))} insertDisabledReason={blockDefinition ? '步骤块定义只能包含一个步骤组' : undefined} />
      <div className="step-card-heading definition-step-heading"><span className="step-sequence-number" aria-label={'步骤 ' + (index + 1)}>{index + 1}</span><div className="step-heading-text"><InlineParts {...fields} label="步骤标题" value={step.title} onChange={title => edit(doc => ({ ...doc, steps: doc.steps.map(item => item.id === step.id ? { ...item, title } : item) }))} placeholder="未命名步骤" singleLine activationKey={titleActivation?.stepId === step.id ? titleActivation.version : undefined} onActivated={() => setTitleActivation(previous => previous?.stepId === step.id ? null : previous)} /></div>
        <StepMoreActions disabled={busy} onDuplicate={() => edit(doc => cloneStep(doc, step.id))} onMoveUp={canMoveUp ? () => moveStep(step.id, -1) : undefined} onMoveDown={canMoveDown ? () => moveStep(step.id, 1) : undefined} onConvert={step.groupId ? undefined : () => edit(doc => convertStepToGroup(doc, step.id))} onRemove={canRemove ? () => edit(doc => removeStepFromDocument(doc, step.id)) : undefined} removeDisabledReason={!canRemove ? '流程至少保留一个步骤' : undefined} />
      </div>
      <StepEditor step={step} document={document} edit={edit} allowGlobal={allowGlobal} busy={busy} onCopyCommand={onCopyCommand} commandActivation={commandActivation} onCommandActivated={commandId => setCommandActivation(previous => previous?.commandId === commandId ? null : previous)} />
    </section>;
  }
  return <div className="template-steps">{document.steps.map((step, index) => {
    if (!step.groupId) return renderStep(step, index);
    if (index && document.steps[index - 1].groupId === step.groupId) return null;
    const group = document.groups?.find(item => item.id === step.groupId); if (!group) return renderStep(step, index);
    const members = groupSteps(document, group.id), last = index + members.length - 1;
    const uniqueReason = blockDefinition ? '步骤块定义必须保留唯一组' : undefined;
    const canRemove = !blockDefinition && document.steps.length > members.length;
    return <section className="step-group editing-group" data-group-id={group.id} key={group.id}>
      <StepActions object="group" blocks={blocks} disabled={busy} onAddChild={() => addAfterGroup(group.id, true)} onAdd={blockDefinition ? undefined : () => addAfterGroup(group.id, false)} addDisabledReason={uniqueReason} onInsert={blockDefinition ? undefined : block => edit(doc => insertBlock(doc, block, doc.steps.map(item => item.groupId).lastIndexOf(group.id)))} insertDisabledReason={uniqueReason} />
      <div className="execution-group-heading definition-group-heading"><Layers size={18} /><InlinePlain className="execution-group-name" label="步骤组名称" value={group.name} onChange={name => edit(doc => ({ ...doc, groups: (doc.groups ?? []).map(item => item.id === group.id ? { ...item, name } : item) }))} placeholder="未命名步骤组" singleLine /><span>{members.length} 个步骤</span>
        <StepMoreActions object="group" disabled={busy} onDuplicate={blockDefinition ? undefined : () => edit(doc => cloneGroup(doc, group.id))} duplicateDisabledReason={uniqueReason} onMoveUp={!blockDefinition && index > 0 ? () => moveGroup(group.id, -1) : undefined} onMoveDown={!blockDefinition && last < document.steps.length - 1 ? () => moveGroup(group.id, 1) : undefined} moveUpDisabledReason={uniqueReason} moveDownDisabledReason={uniqueReason} onSaveBlock={onSaveBlock ? () => onSaveBlock(group.id) : undefined} onRemove={canRemove ? () => edit(doc => removeGroup(doc, group.id)) : undefined} removeDisabledReason={uniqueReason ?? (!canRemove ? '流程至少保留一个步骤' : undefined)} />
      </div>
      <div className="definition-group-body"><div className="definition-group-description"><InlinePlain className="execution-group-description" label="步骤组描述" value={group.description ?? ''} onChange={description => edit(doc => ({ ...doc, groups: (doc.groups ?? []).map(item => item.id === group.id ? { ...item, description } : item) }))} placeholder="添加描述" /></div>{members.map((member, offset) => renderStep(member, index + offset))}</div>
    </section>;
  })}</div>;
}
