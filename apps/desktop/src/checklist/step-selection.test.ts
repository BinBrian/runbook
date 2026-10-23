import { describe, expect, it } from 'vitest';
import { mergeSteps, selectableStepIds, selectSteps, selectionReason } from './step-selection';
import { insertBlock } from './model';
import type { BlockDefinition, ChecklistDocument, Instance } from './types';
const doc = (): ChecklistDocument => ({ groups: [{ id: 'g', name: '原组' }], parameters: [{ id: 'p', ownerId: 'b', name: '环境', description: '', defaultValue: 'sandboxa' }], steps: ['a','b','c','d','e'].map(id => ({ id, title: [id], description: [], commands: [], ...(id === 'd' ? {groupId: 'g'} : {}) })) });
const work = (document = doc(), status = 'draft', currentStepId?: string) => ({ document, status, currentStepId } as Instance);
describe('multi step grouping without changing execution identity', () => {
  it('merges only contiguous same-level steps preserving owners, identity and order', () => {
    const before = doc(), selected = new Set(['b','c']), next = mergeSteps(before, selected, selectableStepIds(work(before)), 'new-group');
    expect(next.steps.map(s => s.id)).toEqual(before.steps.map(s => s.id));
    expect(next.parameters).toEqual(before.parameters);
    expect(next.steps.slice(1,3).map(s => s.groupId)).toEqual(['new-group','new-group']);
    expect(next.groups?.at(-1)).toEqual({id:'new-group',name:'',description:''});
    expect(before.steps[1].groupId).toBeUndefined();
    next.parameters[0].defaultValue = 'changed'; expect(before.parameters[0].defaultValue).toBe('sandboxa');
  });
  it('range selection includes every step and rejects a group or frozen boundary', () => {
    const d = doc(), eligible = selectableStepIds(work(d));
    expect([...selectSteps(d,new Set(['a']),eligible,'c','a',true)]).toEqual(['a','b','c']);
    expect(() => selectSteps(d,new Set(['a']),eligible,'e','a',true)).toThrow('范围');
    const running = selectableStepIds(work(d,'in_progress','b'));
    expect([...running]).toEqual(['c','e']);
    expect(selectableStepIds(work(d,'completed')).size).toBe(0);
    expect(() => mergeSteps(d,new Set(['b','c']),running)).toThrow('可编辑');
  });
  it('does not silently reorder disjoint selections or operate on stale IDs', () => {
    const d = doc(), eligible = selectableStepIds(work(d));
    expect(selectionReason(d,new Set(['a','c']),eligible)).toContain('连续');
    expect(() => mergeSteps(d,new Set(['a','gone']),eligible)).toThrow('可编辑');
    expect([...selectSteps(d,new Set(['b']),eligible,'b')]).toEqual([]);
  });
});
describe('favorite insertion', () => {
  const favorite = (): BlockDefinition => ({formatVersion:2,kind:'block',id:'favorite',name:'停服',createdAt:'',updatedAt:'',favorite:{kind:'step',sourceWorkId:'source',sourceWorkName:'来源',sourceStepIds:['old']},document:{groups:[{id:'wrapper',name:'停服'}],parameters:[{id:'env',ownerId:'s',name:'环境',description:'',defaultValue:'sandboxa'}],steps:[{id:'s',groupId:'wrapper',title:['停服'],description:[],commands:[{id:'cmd',text:['stop ',{parameterId:'env'}]}]}]}});
  it('unwraps a single step, remaps references and never merges same-name variables', () => {
    const d=doc(), f=favorite(), next=insertBlock(d,f,0), step=next.steps[1], parameter=next.parameters[1];
    expect(step.groupId).toBeUndefined();expect(next.groups).toEqual(d.groups);
    expect(step.id).not.toBe('s');expect(parameter.ownerId).toBe(step.id);expect(parameter.id).not.toBe('env');
    expect(step.commands[0].text[1]).toEqual({parameterId:parameter.id});expect(next.parameters).toHaveLength(2);
    next.steps[1].title=['different'];expect(f.document.steps[0].title).toEqual(['停服']);
  });
  it('inserts single favorites inside groups but complete group favorites after the parent', () => {
    const d=doc(), f=favorite(), single=insertBlock(d,f,3);
    expect(single.steps[4].groupId).toBe('g');expect(single.parameters[1].ownerId).toBe(single.steps[4].id);
    f.favorite!.kind='group';f.favorite!.sourceGroupId='old-group';
    const grouped=insertBlock(single,f,3);expect(grouped.steps[4].id).toBe(single.steps[4].id);
    expect(grouped.steps[5].groupId).not.toBe('g');expect(grouped.groups).toHaveLength(2);
    f.name='收藏列表名称';f.document.groups![0].name='原组标题';
    expect(insertBlock(d,f,0).groups?.at(-1)?.name).toBe('原组标题');
  });
});
