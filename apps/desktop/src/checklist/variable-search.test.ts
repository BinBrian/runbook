import { describe, expect, it } from 'vitest';
import { parameterLabel, variableSteps } from './variable-search';
import type { ChecklistDocument } from './types';

const document: ChecklistDocument = {
  groups: [{ id: 'a', name: '玩家转区' }, { id: 'b', name: '更新外服' }],
  parameters: [
    { id: 'global', name: '环境', description: '', defaultValue: '' },
    { id: 'local-a', ownerId: 'a', name: '环境', description: '', defaultValue: '' },
    { id: 'local-b', ownerId: 'b', name: '环境', description: '', defaultValue: '' },
    { id: 'step-var', ownerId: 'title', name: 'ID', description: '', defaultValue: '' },
    { id: 'unused', name: '未引用变量', description: '', defaultValue: '' },
  ],
  steps: [
    { id: 'intro', groupId: 'a', title: ['环境说明'], description: ['这里只是文字'], commands: [] },
    { id: 'title', groupId: 'a', title: ['核对 ', { parameterId: 'local-a' }], description: [{ parameterId: 'global' }, { parameterId: 'step-var' }], commands: [] },
    { id: 'command', groupId: 'a', title: ['转区'], description: [''], commands: [{ id: 'c', text: [{ parameterId: 'local-a' }, { parameterId: 'global' }, { parameterId: 'local-a' }] }] },
    { id: 'b-step', groupId: 'b', title: ['外服'], description: [{ parameterId: 'local-b' }], commands: [] },
  ],
};
const ids = (query: string, id?: string) => variableSteps(document, query, {}, id).map(step => step.id);

describe('variable reference step search', () => {
  it('clears to the original complete order without copying or changing steps', () => {
    expect(variableSteps(document, '   ', {})).toBe(document.steps);
  });
  it('finds all actual title/description/command references once, skipping unused group members', () => {
    expect(ids('', 'local-a')).toEqual(['title', 'command']);
    expect(ids('', 'global')).toEqual(['title', 'command']);
    expect(ids('', 'step-var')).toEqual(['title']);
  });
  it('uses selected stable identity even if another global or group variable has the same name', () => {
    expect(ids('环境', 'local-b')).toEqual(['b-step']);
    expect(ids('玩家转区.环境', 'missing')).toEqual([]);
  });
  it('accepts names and namespaces, trimming and ignoring case for typed searches', () => {
    expect(ids(' 环境 ')).toEqual(['title', 'command', 'b-step']);
    expect(ids('玩家转区.环境')).toEqual(['title', 'command']);
    expect(ids('id')).toEqual(['title']);
  });
  it('does not treat literal wording, ownership or unused definitions as references', () => {
    expect(ids('未引用变量')).toEqual([]);
    expect(ids('环境说明')).toEqual([]);
    expect(ids('NO_MATCH')).toEqual([]);
  });
  it('builds display namespaces with empty-name fallbacks without mutating definitions', () => {
    const copy = structuredClone(document);
    copy.groups![0].name = '';
    copy.steps[1].title = [''];
    expect(parameterLabel(copy, copy.parameters[3], {})).toBe('未命名步骤组.未命名步骤.ID');
    expect(copy.parameters[3].name).toBe('ID');
    expect(parameterLabel(document, document.parameters[0], {})).toBe('环境');
  });
});
