import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { insertionTarget, insertElement, type InsertKind } from './context-insert';
import { parseVisualDocument, serializeVisualDocument } from './visual-model';
import { visualNodeExtensions } from './visual-schema';

const schema = getSchema([StarterKit.configure({ document: false, codeBlock: false, trailingNode: false }), ...visualNodeExtensions]);
const initial = (source: string) => EditorState.create({ schema, doc: schema.nodeFromJSON(parseVisualDocument(source)) });
const stepId = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';
const source = `<!-- runbook:document version="1" -->\n\n<!-- runbook:step id="${stepId}" -->\n\n## 保留步骤\n\n原有说明。\n\n<!-- runbook:command id="${commandId}" -->\n\n\`\`\`sh\n  echo exact  \n\`\`\`\n\n<!-- /runbook:step -->\n\n后续内容。`;
const find = (state: EditorState, type: string) => { let position = -1; state.doc.descendants((node, pos) => { if (position < 0 && node.type.name === type) position = pos; }); return position; };

describe('contextual block insertion', () => {
  it('inserts after the entire paragraph and never overwrites a text selection', () => {
    let state = initial('当前段落中的原始文字。\n\n下一段原样保留。');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3, 7)));
    const target = insertionTarget(state.doc, state.selection.from)!;
    const next = state.apply(insertElement(state, target, 'heading'));
    expect(next.doc.childCount).toBe(3);
    expect(next.doc.child(0)).toBe(state.doc.child(0));
    expect(next.doc.child(1).type.name).toBe('heading');
    expect(next.doc.child(2)).toBe(state.doc.child(1));
    expect(next.selection.$from.parent.type.name).toBe('heading');
  });

  it('replaces an empty line without adding a spare blank paragraph', () => {
    const state = initial('');
    const next = state.apply(insertElement(state, insertionTarget(state.doc, 1)!, 'step'));
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.firstChild!.type.name).toBe('runbookStep');
    expect(next.doc.firstChild!.attrs.stepId).toMatch(/^[\da-f-]{36}$/);
    expect(next.selection.$from.parent.textContent).toBe('新步骤');
  });

  it('keeps new commands in their current step and leaves exact existing command text intact', () => {
    const state = initial(source), title = find(state, 'heading');
    const next = state.apply(insertElement(state, insertionTarget(state.doc, title + 2)!, 'command'));
    const step = next.doc.firstChild!;
    expect(step.attrs.stepId).toBe(stepId);
    expect(step.child(1).type.name).toBe('runbookCommand');
    expect(step.child(1).attrs.commandId).not.toBe(commandId);
    expect(step.lastChild!.attrs.text).toBe('  echo exact  ');
    expect(next.doc.childCount).toBe(state.doc.childCount);
    expect(serializeVisualDocument(next.doc.toJSON())).toContain('  echo exact  ');
  });

  it('puts a checkpoint after the whole current step instead of nesting it or splitting its content', () => {
    const state = initial(source), title = find(state, 'heading');
    const next = state.apply(insertElement(state, insertionTarget(state.doc, title + 2)!, 'checkpoint'));
    expect(next.doc.childCount).toBe(3);
    expect(next.doc.child(0)).toBe(state.doc.child(0));
    expect(next.doc.child(1).firstChild!.textContent).toBe('检查点');
    expect(next.doc.child(1).attrs.stepId).not.toBe(stepId);
    expect(next.doc.child(2)).toBe(state.doc.child(1));
    expect(() => serializeVisualDocument(next.doc.toJSON())).not.toThrow();
  });

  it('inserts beside a complete list and wraps an outside command in a new step', () => {
    const state = initial('- 第一项\n- 第二项\n\n末尾。');
    const target = insertionTarget(state.doc, 4)!;
    expect(target.node.type.name).toBe('bulletList');
    const next = state.apply(insertElement(state, target, 'command'));
    expect(next.doc.child(0)).toBe(state.doc.child(0));
    expect(next.doc.child(1).type.name).toBe('runbookStep');
    expect(next.doc.child(1).lastChild!.type.name).toBe('runbookCommand');
    expect(next.doc.child(2)).toBe(state.doc.child(1));
  });

  it('resolves atom selections to the command card rather than its enclosing step', () => {
    const state = initial(source), command = find(state, 'runbookCommand');
    const target = insertionTarget(state.doc, command)!;
    expect(target.node.type.name).toBe('runbookCommand');
    const next = state.apply(insertElement(state, target, 'paragraph'));
    expect(next.doc.firstChild!.lastChild!.type.name).toBe('paragraph');
    expect(next.doc.firstChild!.attrs.stepId).toBe(stepId);
  });

  it('rejects a stale menu target after another edit instead of writing at an unrelated position', () => {
    const state = initial('保留原文。'), target = insertionTarget(state.doc, 2)!;
    const changed = state.apply(state.tr.insertText('新增', 1));
    expect(() => insertElement(changed, target, 'code')).toThrow('插入位置已变化');
    expect(changed.doc.textContent).toBe('新增保留原文。');
  });

  it.each<InsertKind>(['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule', 'step', 'command', 'checkpoint', 'code'])('creates serializable %s content and a valid focus position', kind => {
    const state = initial('保留。');
    const next = state.apply(insertElement(state, insertionTarget(state.doc, 2)!, kind));
    expect(next.doc.firstChild).toBe(state.doc.firstChild);
    expect(() => next.doc.check()).not.toThrow();
    expect(() => serializeVisualDocument(next.doc.toJSON())).not.toThrow();
    expect(next.selection.from).toBeGreaterThan(state.doc.firstChild!.nodeSize - 1);
  });
});
