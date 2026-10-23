import { expect, it } from 'vitest';
import { matchingVariableIds, variableBranches, variableHistory } from './variable-tree';
import { referencingSteps } from './variable-search';
import type { ChecklistDocument, Instance, ResultEntry } from './types';
const document: ChecklistDocument = { groups: [{ id: 'g', name: '玩家转区' }], parameters: [
  { id: 'global', name: '环境', description: '', defaultValue: 'release' },
  { id: 'group', ownerId: 'g', name: '环境', description: '局部目标', defaultValue: 'sandboxa' },
  { id: 'step', ownerId: 'a', name: '账号', description: '', defaultValue: '123' },
  { id: 'single', ownerId: 'c', name: '版本', description: '', defaultValue: 'v1' },
], steps: ['a','b','c'].map(id => ({id,...(id === 'c' ? {} : {groupId:'g'}),title:[id],description:id==='a'?[{parameterId:'group'}]:[],commands:[]})) };
const result = (stepId: string, value: string): ResultEntry => ({id:'r-'+stepId,stepId,type:'result',outcome:'completed',reason:null,at:'',snapshot:{title:stepId,description:'',commands:[],parameterValues:{global:value,group:value,step:value}}});
it('puts each owner in the right tree once, preserving same-name identities', () => {
  const tree = variableBranches(document, {});
  expect(tree.map(n=>n.id)).toEqual(['g','c']);expect(tree[0].parameters.map(p=>p.id)).toEqual(['group']);
  expect(tree[0].children.map(n=>n.id)).toEqual(['a']);expect(tree[0].children[0].parameters[0].id).toBe('step');
  expect(tree.flatMap(n=>n.parameters).some(p=>p.id==='global')).toBe(false);
  expect(document.steps.map(s=>s.id)).toEqual(['a','b','c']);
});
it('searches namespaces, descriptions and displayed values, resolving actual references by ID', () => {
  const ids = matchingVariableIds(document, '玩家转区.环境', {});expect([...ids]).toEqual(['group']);
  expect(referencingSteps(document, ids).map(s=>s.id)).toEqual(['a']);
  expect([...matchingVariableIds(document,'局部目标',{})]).toEqual(['group']);
  expect([...matchingVariableIds(document,'preview',{global:'preview'})]).toEqual(['global']);
  expect([...matchingVariableIds(document,'环境',{},'group')]).toEqual(['group']);
});
it('uses the viewed historical snapshot for shared values and the owner step snapshot for locals', () => {
  const instance: Instance = {formatVersion:2,kind:'instance',id:'work',name:'工作',sourceTemplateId:null,createdAt:'',updatedAt:'',startedAt:null,finishedAt:null,terminationReason:null,archivedAt:null,document,entries:[result('a','old')],parameterValues:{global:'new',group:'new'},status:'in_progress',currentStepId:'b'};
  expect(variableHistory(instance,document.parameters[0],'a')?.snapshot.parameterValues.global).toBe('old');
  expect(variableHistory(instance,document.parameters[0],'b')).toBeUndefined();
  expect(variableHistory(instance,document.parameters[2],'c')?.snapshot.parameterValues.step).toBe('old');
  expect(variableHistory(instance,document.parameters[3],'a')).toBeUndefined();
  expect(variableHistory(instance,document.parameters[1],'c')).toBeUndefined();
  instance.entries.push(result('b','latest'));
  expect(variableHistory(instance,document.parameters[1],'c')?.snapshot.parameterValues.group).toBe('latest');
});
