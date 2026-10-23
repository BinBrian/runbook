import { describe, expect, it } from 'vitest';
import { createDraftStore, DRAFT_STORAGE_KEY, retargetWorkDrafts, sameDraft } from './drafts';

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
describe('local explicit drafts', () => {
  it('restores exact input and identities after restart without applying it to business data', () => {
    const local = storage(), first = createDraftStore(local);
    const inputs = [
      ['variable-definition:template:a', { value: { kind: 'add', id: 'new-id', ownerId: 'group-id', ownerLabel: '转区', name: '目标区服', description: '输入保留\n下一行', defaultValue: '9001002' }, label: '变量定义', target: { kind: 'template', id: 'a', stepId: 'step-id' } }],
      ['parameters:run', { value: { environment: 'preview', empty: '' }, label: '实例参数', target: { kind: 'instance', id: 'run' } }],
      ['comment:run:step', { value: ' \n尚未提交的评论\n ', label: '步骤评论', target: { kind: 'instance', id: 'run', stepId: 'step' } }],
      ['dialog:["failed","run","step",null]', { value: '检查失败', label: '记录失败', target: { kind: 'instance', id: 'run', stepId: 'step', dialog: 'failed' } }],
    ] as const;
    for (const [key, entry] of inputs) first.update(key, entry);
    first.flush();
    expect([...createDraftStore(local).entries]).toEqual(inputs);
    expect(createDraftStore(storage()).entries.size).toBe(0);
  });
  it('removes cancelled/submitted input durably and does not share mutable caller values', () => {
    const local = storage(), store = createDraftStore(local), value = { env: 'release' };
    store.update('parameters:run', { value, label: '参数' }); value.env = 'sandboxa';
    expect(store.entries.get('parameters:run')?.value).toEqual({ env: 'release' });
    store.update('parameters:run');
    expect(createDraftStore(local).entries.size).toBe(0);
  });
  it('retains input on storage failure, reports it, and retries the same content', () => {
    const local = storage(); let fail = true;
    const store = createDraftStore({ getItem: local.getItem, setItem: (key, text) => { if (fail) throw new Error('disk full'); local.setItem(key, text); } });
    store.update('comment:run:step', { value: 'exact draft', label: '评论' });
    expect(store.getError()).toContain('disk full');
    expect(() => store.flush()).toThrow('disk full');
    expect(store.entries.get('comment:run:step')?.value).toBe('exact draft');
    fail = false; store.flush();
    expect(store.getError()).toBe('');
    expect(createDraftStore(local).entries.get('comment:run:step')?.value).toBe('exact draft');
  });
  it('does not overwrite unreadable or malformed restored data', () => {
    for (const raw of ['broken json', '{"version":2,"entries":[]}', JSON.stringify({ version: 1, entries: [['parameters:run', { label: '参数', value: { env: 123 } }]] })]) {
      const local = storage(); local.values.set(DRAFT_STORAGE_KEY, raw);
      const store = createDraftStore(local);
      expect(store.getError()).toContain('恢复失败');
      expect(() => store.flush()).toThrow();
      expect(local.getItem(DRAFT_STORAGE_KEY)).toBe(raw);
    }
  });
  it('ignores object property order when deciding whether input changed', () => {
    expect(sameDraft({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
    expect(sameDraft({ a: '1' }, { a: '2' })).toBe(false);
    expect(sameDraft(['a', 'b'], ['b', 'a'])).toBe(false);
  });
  it('retargets former template forms and dialog inputs to their exact new work identity', () => {
    const local = storage(), store = createDraftStore(local);
    const form = { kind: 'edit', id: 'env', ownerId: 'group', ownerLabel: '玩家转区', name: '环境', description: '', defaultValue: '未保存的默认值' };
    store.update('variable-definition:template:old', { value: form, label: '变量定义', target: { kind: 'template', id: 'old', stepId: 'step' } });
    store.update('dialog:["createInstance","old",null,null]', { value: '本次维护名称', label: '创建实例', target: { kind: 'template', id: 'old', dialog: 'createInstance' } });
    retargetWorkDrafts({ old: 'converted' }, store);
    expect(store.entries.get('variable-definition:instance:converted')).toEqual({ value: form, label: '变量定义', target: { kind: 'instance', id: 'converted', stepId: 'step' } });
    expect(store.entries.get('dialog:["repeatWork","converted",null,null]')?.value).toEqual({ text: '本次维护名称', carryValues: true });
    const saved = local.getItem(DRAFT_STORAGE_KEY);
    retargetWorkDrafts({ old: 'converted' }, store);
    expect(local.getItem(DRAFT_STORAGE_KEY)).toBe(saved);
    expect([...createDraftStore(local).entries]).toEqual([...store.entries]);
  });
  it('preserves both old naming drafts if the retired actions map to the same new action', () => {
    const store = createDraftStore(storage());
    for (const [type, value] of [['copyInstance', '复制名称'], ['saveTemplate', '另存名称']]) store.update('dialog:' + JSON.stringify([type, 'source', null, null]), { value, label: type, target: { kind: 'instance', id: 'source', dialog: type } });
    retargetWorkDrafts({}, store);
    expect(store.entries.size).toBe(2);
    expect([...store.entries.values()].map(entry => (entry.value as { text: string }).text)).toEqual(['复制名称', '另存名称']);
  });
  it('restores favorite destination and name and retargets former group-saving drafts', () => {
    const local = storage(), store = createDraftStore(local);
    store.update('favorite:["work","step",null]', { value: { name: '未保存的收藏', replaceId: 'existing' }, label: '收藏步骤', target: { kind: 'instance', id: 'work', stepId: 'step', dialog: 'favorite' } });
    store.update('dialog:["saveBlock","work",null,"group"]', { value: '未保存组名称', label: '保存步骤块', target: { kind: 'instance', id: 'work', groupId: 'group', dialog: 'saveBlock' } });
    retargetWorkDrafts({}, store);
    expect(store.entries.get('favorite:["work",null,"group"]')?.value).toEqual({ name: '未保存组名称', replaceId: '' });
    expect([...createDraftStore(local).entries]).toEqual([...store.entries]);
  });
});
