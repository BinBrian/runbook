import { describe, expect, it } from 'vitest';
import { renderText } from './model';
import { deleteParameters, promoteParameter } from './variable-mutations';
import type { ChecklistDocument } from './types';

function document(): ChecklistDocument {
  return {
    groups: [{ id: 'group', name: '当前组' }, { id: 'other-group', name: '其他组' }],
    parameters: [
      { id: 'global', name: '环境', description: '', defaultValue: 'default-global' },
      { id: 'local', ownerId: 'group', name: '目标', description: '组参数', defaultValue: 'default-local' },
      { id: 'step-local', ownerId: 'first', name: '版本', description: '', defaultValue: 'default-step' },
      { id: 'other', ownerId: 'other-group', name: '目标', description: '', defaultValue: 'other-default' },
      { id: 'unused', ownerId: 'group', name: '未使用', description: '', defaultValue: '' },
    ],
    steps: [
      { id: 'first', groupId: 'group', title: ['目标 ', { parameterId: 'local' }],
        description: [{ parameterId: 'global' }, ' / ', { parameterId: 'local' }], commands: [
          { id: 'command', text: ['run ', { parameterId: 'local' }, ' ', { parameterId: 'step-local' }, ' / ', { parameterId: 'global' }] },
          { id: 'literal', text: ['{{目标}} should stay literal'] },
        ] },
      { id: 'second', groupId: 'group', title: ['重复 ', { parameterId: 'local' }], description: [], commands: [] },
      { id: 'other-step', groupId: 'other-group', title: [{ parameterId: 'other' }], description: [], commands: [] },
    ],
  };
}
const editable = () => new Set(document().parameters.map(parameter => parameter.id));

describe('promoting local variables', () => {
  it.each(['local', 'step-local'])('preserves %s identity, metadata and every reference while removing only its owner', id => {
    const source = document(), before = structuredClone(source);
    const next = promoteParameter(source, id, editable());
    expect(source).toEqual(before);
    expect(next.parameters.find(parameter => parameter.id === id)).toEqual(Object.fromEntries(Object.entries(before.parameters.find(parameter => parameter.id === id)!).filter(([key]) => key !== 'ownerId')));
    expect(next.steps).toEqual(before.steps);
    expect(next.groups).toEqual(before.groups);
    expect(next.parameters.find(parameter => parameter.id === 'other')).toEqual(before.parameters.find(parameter => parameter.id === 'other'));
    next.steps[0].title.push('independent');
    expect(source).toEqual(before);
  });

  it('rejects an exact trimmed global name collision without merging same-name identities', () => {
    const source = document();
    source.parameters[0].name = ' 目标 ';
    const before = structuredClone(source);
    expect(() => promoteParameter(source, 'local', editable())).toThrow('请先重命名此局部变量');
    expect(source).toEqual(before);
  });

  it('rejects stale, frozen and already-global selections', () => {
    const source = document(), before = structuredClone(source);
    expect(() => promoteParameter(source, 'missing', editable())).toThrow('已不存在');
    expect(() => promoteParameter(source, 'local', new Set(['global']))).toThrow('已锁定');
    expect(() => promoteParameter(source, 'global', editable())).toThrow('已经是全局');
    expect(source).toEqual(before);
  });
});

describe('deleting variables with effective text', () => {
  it('atomically deletes across scopes, resolves every field by ID and preserves the exact effective whitespace', () => {
    const source = document(), before = structuredClone(source);
    const values = { global: 'sandbox-a', local: '目标 A\n第二行', 'step-local': ' 0 ', other: 'other-applied' };
    const next = deleteParameters(source, new Set(['global', 'local', 'step-local', 'unused']), values, editable());
    expect(source).toEqual(before);
    expect(next.parameters.map(parameter => parameter.id)).toEqual(['other']);
    expect(next.steps[0].title).toEqual(['目标 目标 A\n第二行']);
    expect(next.steps[0].description).toEqual(['sandbox-a / 目标 A\n第二行']);
    expect(next.steps[0].commands[0].text).toEqual(['run 目标 A\n第二行  0  / sandbox-a']);
    expect(next.steps[0].commands[1]).toEqual(source.steps[0].commands[1]);
    expect(next.steps[1].title).toEqual(['重复 目标 A\n第二行']);
    expect(next.steps[2]).toEqual(source.steps[2]);
    expect(next.groups).toEqual(source.groups);
    expect(next.steps[0].commands[0].text).not.toContain('default-local');
    next.steps[2].title.push('independent');
    expect(source).toEqual(before);
  });

  it('retains unselected references and merges only adjacent plain text', () => {
    const source = document();
    const values = { global: 'sandbox-b', local: 'actual', 'step-local': 'v2' };
    const next = deleteParameters(source, new Set(['local']), values, editable());
    expect(next.steps[0].commands[0].text).toEqual(['run actual ', { parameterId: 'step-local' }, ' / ', { parameterId: 'global' }]);
    for (const [index, step] of source.steps.entries()) {
      expect(renderText(next.steps[index].title, values)).toBe(renderText(step.title, values));
      expect(renderText(next.steps[index].description, values)).toBe(renderText(step.description, values));
      for (const [commandIndex, command] of step.commands.entries()) expect(renderText(next.steps[index].commands[commandIndex].text, values)).toBe(renderText(command.text, values));
    }
  });

  it.each(['', ' \n\t '])('preserves an explicitly empty or whitespace effective value (%s) when removing its references', value => {
    const source = document(), before = structuredClone(source);
    const next = deleteParameters(source, new Set(['unused', 'local']), { local: value }, editable());
    expect(next.steps[0].title).toEqual([`目标 ${value}`]);
    expect(next.steps[0].description).toEqual([{ parameterId: 'global' }, ` / ${value}`]);
    expect(next.parameters.some(parameter => ['local', 'unused'].includes(parameter.id))).toBe(false);
    expect(source).toEqual(before);
  });

  it('rejects missing effective entries instead of silently substituting a default or empty text', () => {
    const source = document(), before = structuredClone(source);
    expect(() => deleteParameters(source, new Set(['unused', 'local']), {}, editable())).toThrow('无法读取');
    expect(source).toEqual(before);
  });

  it('keeps an empty text part when a field contains only a removed empty variable', () => {
    const next = deleteParameters(document(), new Set(['other']), { other: '' }, editable());
    expect(next.steps[2].title).toEqual(['']);
  });

  it('deletes an unused empty variable without demanding a value or altering content', () => {
    const source = document();
    const next = deleteParameters(source, new Set(['unused']), {}, editable());
    expect(next.parameters).toEqual(source.parameters.filter(parameter => parameter.id !== 'unused'));
    expect(next.steps).toEqual(source.steps);
  });

  it('rejects an entire batch if a selection is stale or locked', () => {
    const source = document(), before = structuredClone(source);
    expect(() => deleteParameters(source, new Set(['unused', 'local']), { local: 'actual' }, new Set(['unused']))).toThrow('已锁定');
    expect(() => deleteParameters(source, new Set(['unused', 'missing']), {}, editable())).toThrow('已不存在');
    expect(() => deleteParameters(source, new Set(), {}, editable())).toThrow('请先选择');
    expect(source).toEqual(before);
  });
});
