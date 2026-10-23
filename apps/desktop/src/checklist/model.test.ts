import { describe, expect, it } from 'vitest';
import recordedFixture from '../../../../docs/examples/patch-maintenance/runbook.json';
import { advancedCount, blockEmptyDocument, canEditParameter, cloneGroup, cloneStep, convertStepToGroup, defaultValues, displayedStep, emptyDocument, exampleDocument, globalParameters, groupAsBlock, groupForStep, groupSteps, insertBlock, latestResult, localParameters, missingParameters, parameterTargetStep, referencedParameterIds, removeGroup, renderStep, renderText, stepResults, visibleParameters } from './model';
import type { ChecklistDocument, Instance, ResultEntry, TextParts } from './types';

const recorded = () => structuredClone(recordedFixture) as Instance;

describe('structured command text', () => {
  it('only substitutes explicit references, preserving literal shell, JSON and template braces', () => {
    const literal = 'ForEach-Object { $_.Name }; {"version":"{{version}}"}; ${env:PATH}; {{version}}';
    const parts: TextParts = [literal, '\nrelease=', { parameterId: 'version' }, '; copy=', { parameterId: 'version' }];
    expect(renderText(parts, { version: '0.1.1' })).toBe(`${literal}\nrelease=0.1.1; copy=0.1.1`);
    expect(renderText(['echo missing=', { parameterId: 'missing' }], {})).toBe('echo missing=');
  });

  it('checks references in titles, descriptions and all command cards but not literal lookalikes', () => {
    const document: ChecklistDocument = {
      parameters: ['title', 'description', 'command', 'literal', 'optional'].map(id => ({ id, name: id, description: '', defaultValue: '' })),
      steps: [{ id: 'step', title: [{ parameterId: 'title' }], description: [{ parameterId: 'description' }], commands: [
        { id: 'first', text: ['{{literal}}; {"literal":true}'] },
        { id: 'second', text: [{ parameterId: 'command' }, { parameterId: 'title' }] },
      ] }],
    };
    expect([...referencedParameterIds(document)]).toEqual(['title', 'description', 'command']);
    expect(missingParameters(document, { title: 'Target', description: ' \n ', command: '' }).map(p => p.id)).toEqual(['description', 'command']);
    expect(missingParameters(document, { title: 'Target', description: 'Check', command: 'echo OK' })).toEqual([]);
  });

  it('creates independent documents and prefilled draft values without replacing template defaults', () => {
    const first = exampleDocument(), second = exampleDocument();
    const values = defaultValues(first.parameters);
    expect(values).toMatchObject({ environment: '演示环境', version: '0.1.0', packagePath: '' });
    expect(missingParameters(first, values).map(p => p.id)).toEqual(['packagePath']);
    values.version = '0.1.1';
    values.packagePath = 'C:\\demo\\patch.zip';
    first.steps[0].title.push(' changed only in this instance');
    expect(second.steps[0].title).not.toContain(' changed only in this instance');
    expect(defaultValues(second.parameters).version).toBe('0.1.0');
    expect(missingParameters(first, values)).toEqual([]);
  });

  it('captures command text and parameter values independently of later editing', () => {
    const document = exampleDocument();
    const values = { ...defaultValues(document.parameters), packagePath: 'C:\\demo\\old.zip' };
    const snapshot = renderStep(document.steps[1], values);
    values.packagePath = 'C:\\demo\\new.zip';
    document.steps[1].commands[0].text = ['changed'];
    expect(snapshot.commands[0].text).toBe("Get-Item -LiteralPath 'C:\\demo\\old.zip'");
    expect(snapshot.parameterValues.packagePath).toBe('C:\\demo\\old.zip');
  });
});

describe('result history presentation', () => {
  it('preserves failed history and renders advanced steps from their submitted snapshots', () => {
    const instance = recorded();
    const packageStep = instance.document.steps[1];
    const history = stepResults(instance, packageStep.id);
    expect(history.map(entry => entry.outcome)).toEqual(['failed', 'completed']);
    expect(history[0].snapshot.commands[0].text).toContain('patch-0.1.1.zip');
    expect(history[1].snapshot.commands[0].text).toContain('patch-0.1.1-repacked.zip');
    instance.parameterValues.packagePath = 'C:\\later\\unrelated.zip';
    instance.parameterValues.environment = 'Future environment';
    expect(displayedStep(instance, packageStep)).toEqual(history[1].snapshot);
    expect(displayedStep(instance, instance.document.steps[0]).title).toBe('核对 演示环境 A 的维护目标');
    expect(latestResult(instance, packageStep.id)).toBe(history[1]);
    expect(advancedCount(instance)).toBe(5);
  });

  it('renders the current failed step using applied parameters while leaving the failure snapshot unchanged', () => {
    const instance = recorded();
    const step = instance.document.steps[1];
    instance.entries = instance.entries.filter(entry => entry.type !== 'result' || ['r1', 'r2-failed'].includes(entry.id));
    instance.status = 'in_progress';
    instance.currentStepId = step.id;
    instance.finishedAt = null;
    instance.archivedAt = null;
    instance.parameterValues.packagePath = 'C:\\demo\\retry.zip';
    const failure = latestResult(instance, step.id) as ResultEntry;
    expect(displayedStep(instance, step).commands[0].text).toBe("Get-Item -LiteralPath 'C:\\demo\\retry.zip'");
    expect(failure.snapshot.commands[0].text).toContain('patch-0.1.1.zip');
    expect(advancedCount(instance)).toBe(1);
  });

  it('uses stable submitted array order for equal timestamps and ignores comments/images when choosing the latest result', () => {
    const instance = recorded();
    for (const entry of instance.entries) entry.at = '2026-10-20T01:00:00Z';
    const step = instance.document.steps[1];
    expect(stepResults(instance, step.id).map(entry => entry.id)).toEqual(['r2-failed', 'r2-completed']);
    expect(latestResult(instance, step.id)?.id).toBe('r2-completed');
    expect(stepResults(instance, 'not-a-step')).toEqual([]);
  });
});

// Duplicate display names are intentional: a reference is always an exact ID,
// never a lookup by name or an implicit override from the closest scope.
function scopedDocument(): ChecklistDocument {
  return {
    groups: [{ id: 'player-a', name: '玩家 A', description: '核对本玩家身份。\n六个子步骤依次记录。' }, { id: 'player-b', name: '玩家 B' }],
    parameters: [
      { id: 'global-env', name: '环境', description: '正式维护环境', defaultValue: 'release' },
      { id: 'a-env', ownerId: 'player-a', name: '环境', description: 'A 独立环境', defaultValue: 'sandboxa' },
      { id: 'a-player', ownerId: 'player-a', name: '玩家 ID', description: '', defaultValue: '9002001' },
      { id: 'a-note', ownerId: 'a-stop', name: '备注', description: '', defaultValue: '维护' },
      { id: 'b-env', ownerId: 'player-b', name: '环境', description: 'B 独立环境', defaultValue: 'sandboxb' },
      { id: 'b-player', ownerId: 'player-b', name: '玩家 ID', description: '', defaultValue: '9002002' },
      { id: 'tail-note', ownerId: 'tail', name: '备注', description: '', defaultValue: '' },
    ],
    steps: [
      { id: 'before', title: ['维护 ', { parameterId: 'global-env' }], description: [''], commands: [] },
      { id: 'a-stop', groupId: 'player-a', title: ['停止 ', { parameterId: 'a-env' }], description: [{ parameterId: 'a-note' }], commands: [{ id: 'a-c-stop', text: ['stopserver ', { parameterId: 'a-env' }, ' all'] }] },
      { id: 'a-publish', groupId: 'player-a', title: ['发布'], description: ['通知 ', { parameterId: 'a-player' }, '，主环境 ', { parameterId: 'global-env' }], commands: [{ id: 'a-c-publish', text: ['publishgame ', { parameterId: 'a-env' }] }] },
      { id: 'b-stop', groupId: 'player-b', title: ['停止 ', { parameterId: 'b-env' }], description: ['玩家 ', { parameterId: 'b-player' }], commands: [{ id: 'b-c-stop', text: ['stopserver ', { parameterId: 'b-env' }, ' all'] }] },
      { id: 'tail', title: ['结束'], description: [{ parameterId: 'tail-note' }], commands: [] },
    ],
  };
}

function scopedInstance(document = scopedDocument()): Instance {
  return { formatVersion: 2, kind: 'instance', id: 'scoped-run', name: '参数作用域', sourceTemplateId: null,
    createdAt: '2026-10-20T01:00:00Z', startedAt: '2026-10-20T01:00:00Z', updatedAt: '2026-10-20T01:00:00Z',
    status: 'in_progress', currentStepId: 'a-stop', finishedAt: null, terminationReason: null, archivedAt: null,
    document, parameterValues: defaultValues(document.parameters), entries: [] };
}

describe('explicit global and local parameter scopes', () => {
  it('shows globals, own group and own step parameters without leaking same-named parameters from siblings', () => {
    const document = scopedDocument();
    expect(globalParameters(document).map(p => p.id)).toEqual(['global-env']);
    expect(localParameters(document, 'player-a').map(p => p.id)).toEqual(['a-env', 'a-player']);
    expect(localParameters(document, 'a-stop').map(p => p.id)).toEqual(['a-note']);
    expect(visibleParameters(document, 'a-stop').map(p => p.id)).toEqual(['global-env', 'a-env', 'a-player', 'a-note']);
    expect(visibleParameters(document, 'a-publish').map(p => p.id)).toEqual(['global-env', 'a-env', 'a-player']);
    expect(visibleParameters(document, 'b-stop').map(p => p.id)).toEqual(['global-env', 'b-env', 'b-player']);
    expect(visibleParameters(document, 'tail').map(p => p.id)).toEqual(['global-env', 'tail-note']);
    expect(groupForStep(document, 'a-stop')?.id).toBe('player-a');
    expect(groupForStep(document, 'tail')).toBeUndefined();
    expect(groupSteps(document, 'player-a').map(s => s.id)).toEqual(['a-stop', 'a-publish']);
  });

  it('renders same-named values by ID and reports every missing local independently', () => {
    const document = scopedDocument(), values = defaultValues(document.parameters);
    expect(renderStep(document.steps[1], values).commands[0].text).toBe('stopserver sandboxa all');
    expect(renderStep(document.steps[3], values).commands[0].text).toBe('stopserver sandboxb all');
    expect(renderStep(document.steps[0], values).title).toBe('维护 release');
    values['a-env'] = ''; values['b-env'] = ' '; values['tail-note'] = 'done';
    expect(missingParameters(document, values).map(p => p.id)).toEqual(['a-env', 'b-env']);
    values['a-env'] = 'sandboxc';
    expect(renderStep(document.steps[1], values).commands[0].text).toBe('stopserver sandboxc all');
    expect(renderStep(document.steps[0], values).title).toBe('维护 release');
  });

  it('treats a v1 flat document as all-global and does not require groups', () => {
    const legacy = exampleDocument();
    expect(globalParameters(legacy)).toEqual(legacy.parameters);
    expect(visibleParameters(legacy, legacy.steps[0].id)).toEqual(legacy.parameters);
    expect(groupForStep(legacy, legacy.steps[0].id)).toBeUndefined();
    expect(groupSteps(legacy, 'absent')).toEqual([]);
  });

  it('locates missing parameters at their step, the first group member or the first referencing global step', () => {
    const document = scopedDocument();
    expect(parameterTargetStep(document, 'a-env')).toBe('a-stop');
    expect(parameterTargetStep(document, 'a-note')).toBe('a-stop');
    expect(parameterTargetStep(document, 'b-player')).toBe('b-stop');
    expect(parameterTargetStep(document, 'global-env')).toBe('before');
    expect(parameterTargetStep(document, 'tail-note')).toBe('tail');
    expect(parameterTargetStep(document, 'unknown')).toBeUndefined();
  });

  it('locks a passed step local immediately and group locals only after its last step advances', () => {
    const run = scopedInstance(), parameter = (id: string) => run.document.parameters.find(p => p.id === id)!;
    const completed = (stepId: string): ResultEntry => ({ id: `result-${stepId}`, type: 'result', stepId, at: run.updatedAt,
      outcome: 'completed', reason: null, snapshot: renderStep(run.document.steps.find(s => s.id === stepId)!, run.parameterValues) });
    run.entries = [completed('before'), completed('a-stop')];
    run.currentStepId = 'a-publish';
    expect(canEditParameter(run, parameter('global-env'))).toBe(true);
    expect(canEditParameter(run, parameter('a-note'))).toBe(false);
    expect(canEditParameter(run, parameter('a-env'))).toBe(true);
    expect(canEditParameter(run, parameter('b-env'))).toBe(true);
    run.entries.push(completed('a-publish')); run.currentStepId = 'b-stop';
    expect(canEditParameter(run, parameter('a-env'))).toBe(false);
    expect(canEditParameter(run, parameter('b-env'))).toBe(true);
    run.status = 'completed'; run.currentStepId = null;
    expect(canEditParameter(run, parameter('global-env'))).toBe(false);
    expect(canEditParameter(run, parameter('b-env'))).toBe(false);
  });
});

describe('self-contained reusable step blocks', () => {
  it('copies one contiguous group with fresh local identities while preserving explicit global references', () => {
    const document = scopedDocument(), original = structuredClone(document);
    const copy = cloneGroup(document, 'player-a');
    expect(document).toEqual(original);
    expect(copy.steps).toHaveLength(document.steps.length + 2);
    const copiedSteps = copy.steps.slice(3, 5), copiedGroup = copy.groups!.find(g => g.id === copiedSteps[0].groupId)!;
    expect(copy.steps.map(s => s.id).slice(0, 3)).toEqual(['before', 'a-stop', 'a-publish']);
    expect(copy.steps.slice(5).map(s => s.id)).toEqual(['b-stop', 'tail']);
    expect(copiedGroup.id).not.toBe('player-a');
    expect(copiedGroup.description).toBe(document.groups![0].description);
    copiedGroup.description = '副本独立说明';
    expect(document.groups![0].description).toBe('核对本玩家身份。\n六个子步骤依次记录。');
    expect(copiedSteps.every(s => s.groupId === copiedGroup.id)).toBe(true);
    const oldIds = new Set(document.steps.flatMap(s => [s.id, ...s.commands.map(c => c.id)]).concat(document.parameters.map(p => p.id), document.groups!.map(g => g.id)));
    expect(copiedSteps.flatMap(s => [s.id, ...s.commands.map(c => c.id)]).every(id => !oldIds.has(id))).toBe(true);
    const copiedParameters = copy.parameters.filter(p => p.ownerId === copiedGroup.id || copiedSteps.some(s => s.id === p.ownerId));
    expect(copiedParameters).toHaveLength(3);
    expect(copiedParameters.every(p => !oldIds.has(p.id))).toBe(true);
    const copiedRefs = [...referencedParameterIds({ parameters: copy.parameters, steps: copiedSteps })];
    expect(copiedRefs).toContain('global-env');
    expect(copiedRefs).not.toEqual(expect.arrayContaining(['a-env', 'a-player', 'a-note']));
    for (const local of ['a-env', 'a-player', 'a-note']) expect(copiedRefs).not.toContain(local);
    expect(renderStep(copiedSteps[0], defaultValues(copy.parameters)).commands[0].text).toBe('stopserver sandboxa all');
    copiedSteps[0].title.push(' changed');
    expect(document.steps[1].title).not.toContain(' changed');
  });

  it('captures referenced globals as local block defaults without importing unrelated parameters or instance values', () => {
    const document = scopedDocument(), original = structuredClone(document);
    const block = groupAsBlock(document, 'player-a', '玩家转区', 'block-transfer');
    expect(document).toEqual(original);
    expect(block).toMatchObject({ formatVersion: 2, kind: 'block', id: 'block-transfer', name: '玩家转区' });
    expect(block.document.groups).toHaveLength(1);
    const group = block.document.groups![0];
    expect(group.description).toBe(document.groups![0].description);
    expect(block.document.steps).toHaveLength(2);
    expect(block.document.steps.every(s => s.groupId === group.id)).toBe(true);
    expect(block.document.parameters).toHaveLength(4);
    expect(block.document.parameters.every(p => p.ownerId === group.id || block.document.steps.some(s => s.id === p.ownerId))).toBe(true);
    expect(block.document.parameters.map(p => p.defaultValue).sort()).toEqual(['sandboxa', '9002001', '维护', 'release'].sort());
    expect(block.document.parameters.some(p => ['b-env', 'b-player', 'tail-note', 'global-env'].includes(p.id))).toBe(false);
    const refs = referencedParameterIds(block.document);
    expect([...refs].every(id => block.document.parameters.some(p => p.id === id))).toBe(true);
    expect(JSON.stringify(block)).not.toContain('parameterValues');
  });

  it('inserts a block twice as independent groups and keeps it detached from later definition edits', () => {
    const block = groupAsBlock(scopedDocument(), 'player-a', '更新重启', 'block-restart');
    const first = insertBlock({ parameters: [], steps: [] }, block);
    const both = insertBlock(first, block);
    expect(both.groups).toHaveLength(2);
    expect(both.steps).toHaveLength(4);
    const [left, right] = both.groups!;
    expect(left.id).not.toBe(right.id);
    expect(left.sourceBlockId).toBe(block.id);
    expect(right.sourceBlockId).toBe(block.id);
    expect(left.description).toBe('核对本玩家身份。\n六个子步骤依次记录。');
    expect(right.description).toBe(left.description);
    left.description = '仅修改第一次使用';
    expect(right.description).toBe(block.document.groups![0].description);
    const leftIds = new Set(visibleParameters(both, both.steps[0].id).map(p => p.id));
    const rightIds = new Set(visibleParameters(both, both.steps[2].id).map(p => p.id));
    expect([...leftIds].some(id => rightIds.has(id))).toBe(false);
    const values = defaultValues(both.parameters);
    const rightEnvironment = localParameters(both, right.id).find(p => p.defaultValue === 'sandboxa')!;
    values[rightEnvironment.id] = 'sandboxd';
    expect(renderStep(both.steps[0], values).commands[0].text).toBe('stopserver sandboxa all');
    expect(renderStep(both.steps[2], values).commands[0].text).toBe('stopserver sandboxd all');
    block.document.steps[0].commands[0].text = ['edited library later'];
    expect(renderStep(both.steps[0], values).commands[0].text).toBe('stopserver sandboxa all');
  });

  it('removes only the selected group, its member steps and their owned definitions', () => {
    const document = scopedDocument(), result = removeGroup(document, 'player-a');
    expect(result.groups!.map(g => g.id)).toEqual(['player-b']);
    expect(result.steps.map(s => s.id)).toEqual(['before', 'b-stop', 'tail']);
    expect(result.parameters.map(p => p.id)).toEqual(['global-env', 'b-env', 'b-player', 'tail-note']);
    expect(document.steps).toHaveLength(5);
    expect(document.parameters).toHaveLength(7);
  });

  it('inserts after an entire existing group even when the requested position is in its middle', () => {
    const document = scopedDocument(), block = groupAsBlock(document, 'player-b', '另一个玩家');
    const result = insertBlock(document, block, 1);
    expect(result.steps.slice(0, 3).map(s => s.id)).toEqual(['before', 'a-stop', 'a-publish']);
    expect(result.steps[3].groupId).not.toBe('player-a');
    expect(result.steps.slice(4).map(s => s.id)).toEqual(['b-stop', 'tail']);
  });
});

describe('step-side block actions', () => {
  it('keeps newly created and copied untitled content empty through JSON roundtrips without storing UI placeholders', () => {
    const empty = emptyDocument(), block = blockEmptyDocument();
    expect(empty.steps[0]).toMatchObject({ title: [''], description: [''], commands: [] });
    expect(block.groups![0].name).toBe('');
    expect(block.steps[0]).toMatchObject({ title: [''], description: [''], commands: [] });
    expect(blockEmptyDocument('用户输入的名称').groups![0].name).toBe('用户输入的名称');
    const grouped = convertStepToGroup(empty, empty.steps[0].id);
    const copied = cloneGroup(grouped, grouped.groups![0].id);
    expect(copied.groups!.map(group => group.name)).toEqual(['', '']);
    expect(copied.steps.every(step => renderText(step.title, {}) === '' && renderText(step.description, {}) === '')).toBe(true);
    for (const document of [empty, block, grouped, copied]) {
      expect(JSON.parse(JSON.stringify(document))).toEqual(document);
      expect(JSON.stringify(document)).not.toMatch(/新步骤|步骤标题|未命名|副本/);
    }
  });

  it('copies a step next to its source with fresh step, command and local parameter identities and exact reference remapping', () => {
    const document = scopedDocument(), source = document.steps[1];
    document.parameters.push({ id: 'a-unused', ownerId: source.id, name: '未引用', description: '仍保留定义', defaultValue: 'original' });
    source.title = ['local=', { parameterId: 'a-note' }, '; group=', { parameterId: 'a-env' }];
    source.description = [{ parameterId: 'a-note' }, ' literal a-note; ', { parameterId: 'global-env' }, { parameterId: 'a-note' }];
    source.commands.push({ id: 'a-second', text: [{ parameterId: 'a-note' }, '; ', { parameterId: 'a-note' }, '; ', { parameterId: 'global-env' }] });
    const original = structuredClone(document), next = cloneStep(document, source.id), copied = next.steps[2];
    expect(document).toEqual(original);
    expect(next.steps.slice(0, 2)).toEqual(document.steps.slice(0, 2));
    expect(next.steps.slice(3)).toEqual(document.steps.slice(2));
    expect(copied.groupId).toBe('player-a');
    expect(copied.id).not.toBe(source.id);
    const oldIds = new Set([...document.steps.flatMap(step => [step.id, ...step.commands.map(command => command.id)]), ...document.parameters.map(parameter => parameter.id), ...document.groups!.map(group => group.id)]);
    expect([copied.id, ...copied.commands.map(command => command.id)].every(id => !oldIds.has(id))).toBe(true);
    expect(new Set(copied.commands.map(command => command.id)).size).toBe(source.commands.length);
    const locals = localParameters(next, copied.id), note = locals.find(parameter => parameter.name === '备注')!;
    expect(locals).toHaveLength(2);
    expect(locals.every(parameter => !oldIds.has(parameter.id))).toBe(true);
    expect(locals.find(parameter => parameter.name === '未引用')).toMatchObject({ defaultValue: 'original', description: '仍保留定义' });
    expect(copied.title).toEqual(['local=', { parameterId: note.id }, '; group=', { parameterId: 'a-env' }]);
    expect(copied.description).toEqual([{ parameterId: note.id }, ' literal a-note; ', { parameterId: 'global-env' }, { parameterId: note.id }]);
    expect(copied.commands[1].text).toEqual([{ parameterId: note.id }, '; ', { parameterId: note.id }, '; ', { parameterId: 'global-env' }]);
    expect(renderStep(copied, defaultValues(next.parameters))).toMatchObject({ title: 'local=维护; group=sandboxa', description: '维护 literal a-note; release维护' });
    expect(visibleParameters(next, copied.id).map(parameter => parameter.id)).toEqual(['global-env', 'a-env', 'a-player', ...locals.map(parameter => parameter.id)]);
    const values = { ...defaultValues(next.parameters), [note.id]: '副本备注', 'a-env': 'sandboxd' };
    expect(renderStep(copied, values).description).toBe('副本备注 literal a-note; release副本备注');
    expect(renderStep(next.steps[1], values).description).toBe('维护 literal a-note; release维护');
    expect(renderStep(copied, values).commands[0].text).toBe('stopserver sandboxd all');
    expect(renderStep(next.steps[1], values).commands[0].text).toBe('stopserver sandboxd all');
  });

  it('keeps copied and source fields independent even inside the returned document', () => {
    const document = scopedDocument(), next = cloneStep(document, 'a-stop'), copied = next.steps[2];
    const copiedNote = localParameters(next, copied.id)[0];
    copied.title[1] = { parameterId: 'changed-only-in-copy' };
    copied.description.push(' changed');
    copied.commands[0].text[1] = { parameterId: 'another-copy-only-ref' };
    copiedNote.defaultValue = 'new default';
    next.groups![0].description = 'new group description';
    next.steps[0].title.push(' returned document only');
    expect(next.steps[1]).toEqual(document.steps[1]);
    expect(localParameters(next, 'a-stop')).toEqual(localParameters(document, 'a-stop'));
    expect(document.groups![0].description).toBe('核对本玩家身份。\n六个子步骤依次记录。');
    expect(document.steps[0].title).not.toContain(' returned document only');
    expect(copiedNote.id).not.toBe('a-note');
  });

  it('copies an ungrouped final step without introducing a group or inheriting instance records', () => {
    const run = scopedInstance(), original = structuredClone(run), copiedDocument = cloneStep(run.document, 'tail');
    const copied = copiedDocument.steps.at(-1)!;
    expect(copied.groupId).toBeUndefined();
    expect(copiedDocument.groups).toEqual(run.document.groups);
    expect(copiedDocument.steps.at(-2)?.id).toBe('tail');
    expect(localParameters(copiedDocument, copied.id)[0]).toMatchObject({ name: '备注', defaultValue: '' });
    expect(run).toEqual(original);
    expect(copiedDocument).not.toHaveProperty('entries');
    expect(() => cloneStep(run.document, 'missing')).toThrow('找不到步骤');
  });

  it('wraps an ungrouped step without changing its identity, commands, variable owners or content', () => {
    const document = scopedDocument(), original = structuredClone(document);
    document.steps[0].description = ['说明仍属于子步骤'];
    const next = convertStepToGroup(document, 'before'), group = next.groups!.at(-1)!;
    expect(group.name).toBe('维护 release');
    expect(group.id).not.toBe('before');
    expect(next.steps[0]).toEqual({ ...document.steps[0], groupId: group.id });
    expect(next.steps.slice(1)).toEqual(document.steps.slice(1));
    expect(next.parameters).toEqual(document.parameters);
    const ownLocal = convertStepToGroup(document, 'tail');
    expect(localParameters(ownLocal, 'tail')).toEqual(localParameters(document, 'tail'));
    expect(ownLocal.steps.at(-1)?.description).toEqual([{ parameterId: 'tail-note' }]);
    next.steps[0].description.push('副本修改');
    next.parameters[0].defaultValue = 'preview';
    expect(document.parameters).toEqual(original.parameters);
    expect(document.steps[0].groupId).toBeUndefined();
    expect(document.steps[0].description).toEqual(['说明仍属于子步骤']);
  });

  it('does not nest an existing group or invent a group name when the selected step renders empty', () => {
    const document = scopedDocument(), unchanged = convertStepToGroup(document, 'a-stop');
    expect(unchanged).toEqual(document);
    expect(unchanged).not.toBe(document);
    unchanged.steps[1].description.push('independent');
    expect(document.steps[1].description).not.toContain('independent');
    document.steps[4].title = ['  ', { parameterId: 'tail-note' }];
    expect(convertStepToGroup(document, 'tail').groups!.at(-1)?.name).toBe('');
    expect(() => convertStepToGroup(document, 'missing')).toThrow('找不到步骤');
  });

  it('uses a safe group name for oversized literal titles and parameter defaults without altering the original content', () => {
    const document = scopedDocument();
    document.steps[0].title = ['x'.repeat(1025)];
    document.parameters.find(parameter => parameter.id === 'tail-note')!.defaultValue = '😀'.repeat(257);
    document.steps[4].title = [{ parameterId: 'tail-note' }];
    const original = structuredClone(document);
    for (const stepId of ['before', 'tail']) {
      const next = convertStepToGroup(document, stepId);
      expect(next.groups!.at(-1)?.name).toBe('');
      expect(next.steps.find(step => step.id === stepId)?.title).toEqual(document.steps.find(step => step.id === stepId)?.title);
      expect(next.parameters).toEqual(document.parameters);
    }
    expect(document).toEqual(original);
  });

  it('measures the native name limit in UTF-8 bytes and falls back rather than cutting emoji or accepting NUL', () => {
    const document = scopedDocument(), title = '😀'.repeat(256);
    document.steps[0].title = [title];
    expect(new TextEncoder().encode(title).length).toBe(1024);
    expect(convertStepToGroup(document, 'before').groups!.at(-1)?.name).toBe(title);
    document.steps[0].title = [title + 'x'];
    expect(convertStepToGroup(document, 'before').groups!.at(-1)?.name).toBe('');
    document.steps[0].title = ['name\0invalid'];
    expect(convertStepToGroup(document, 'before').groups!.at(-1)?.name).toBe('');
    expect(document.steps[0].title).toEqual(['name\0invalid']);
  });

  it('inserts reusable blocks at contiguous group boundaries and preserves start and default end positions', () => {
    const document = scopedDocument(), original = structuredClone(document), block = groupAsBlock(document, 'player-b', '插入组');
    for (const afterIndex of [1, 2]) {
      const next = insertBlock(document, block, afterIndex), inserted = next.groups!.at(-1)!;
      expect(next.steps.slice(0, 3)).toEqual(document.steps.slice(0, 3));
      expect(next.steps[3].groupId).toBe(inserted.id);
      expect(next.steps.slice(4)).toEqual(document.steps.slice(3));
      expect(groupSteps(next, 'player-a').map(step => step.id)).toEqual(['a-stop', 'a-publish']);
      expect(groupSteps(next, inserted.id)).toHaveLength(1);
    }
    const atStart = insertBlock(document, block, -1);
    expect(atStart.steps.slice(1)).toEqual(document.steps);
    const atEnd = insertBlock(document, block);
    expect(atEnd.steps.slice(0, document.steps.length)).toEqual(document.steps);
    expect(atEnd.steps.at(-1)?.groupId).toBe(atEnd.groups!.at(-1)?.id);
    const intoEmpty = insertBlock({ parameters: [], steps: [] }, block);
    expect(intoEmpty.steps).toHaveLength(1);
    expect(intoEmpty.steps[0].groupId).toBe(intoEmpty.groups![0].id);
    expect(document).toEqual(original);
  });
});
