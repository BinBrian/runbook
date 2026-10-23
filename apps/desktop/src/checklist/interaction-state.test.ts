import { describe, expect, it } from 'vitest';
import { pendingStepValues, pendingValues, referenceCount } from './interaction-state';
import type { ChecklistDocument } from './types';

const document: ChecklistDocument = {
  groups: [{ id: 'a', name: '玩家一' }, { id: 'b', name: '玩家二' }],
  parameters: [
    { id: 'global', name: '环境', defaultValue: 'preview', description: '' },
    { id: 'a-id', ownerId: 'a', name: '角色', defaultValue: '11', description: '' },
    { id: 'b-id', ownerId: 'b', name: '角色', defaultValue: '22', description: '' },
  ],
  steps: [{ id: 'first', groupId: 'a', title: ['转区 ', { parameterId: 'a-id' }], description: [{ parameterId: 'global' }], commands: [{ id: 'command', text: ['transfer ', { parameterId: 'a-id' }, ' ', { parameterId: 'global' }, ' ', { parameterId: 'a-id' }] }] }],
};

describe('applied and pending parameter context', () => {
  it('uses identity, deduplicates a command notice, and ignores same-name or unused changes', () => {
    const result = pendingValues(document, [document.steps[0].commands[0].text], {}, { 'a-id': '33', 'b-id': '44' });
    expect(result).toEqual([{ id: 'a-id', label: '玩家一.角色', applied: '11', next: '33' }]);
  });
  it('includes title and description references when recording, with default fallback and empty draft preserved', () => {
    expect(pendingStepValues(document, 'first', { global: 'release' }, { global: '', 'b-id': '99' }).map(item => [item.id, item.applied, item.next])).toEqual([['global', 'release', '']]);
    expect(pendingStepValues(document, 'missing', {}, { global: '' })).toEqual([]);
  });
  it('counts occurrences rather than just distinct variables or matching steps', () => {
    expect(referenceCount(document, new Set(['a-id']))).toBe(3);
    expect(referenceCount(document, new Set(['global', 'a-id']))).toBe(5);
    expect(referenceCount(document, new Set(['b-id']))).toBe(0);
  });
});
