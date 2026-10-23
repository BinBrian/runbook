import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';

export type InsertKind = 'paragraph' | 'heading' | 'bulletList' | 'orderedList' | 'blockquote' | 'horizontalRule' | 'step' | 'command' | 'checkpoint' | 'code';
export type InsertTarget = { from: number; node: ProseMirrorNode };

/** Insert beside a direct document/step child, never inside a list or code text. */
export function insertionTarget(doc: ProseMirrorNode, position: number): InsertTarget | null {
  const pos = Math.max(0, Math.min(position, doc.content.size));
  const resolved = doc.resolve(pos);
  if (['doc', 'runbookStep'].includes(resolved.parent.type.name) && resolved.nodeAfter?.isBlock) {
    return { from: pos, node: resolved.nodeAfter };
  }
  for (let depth = resolved.depth; depth > 0; depth--) {
    if (['doc', 'runbookStep'].includes(resolved.node(depth - 1).type.name)) {
      return { from: resolved.before(depth), node: resolved.node(depth) };
    }
  }
  return resolved.nodeBefore?.isBlock ? { from: pos - resolved.nodeBefore.nodeSize, node: resolved.nodeBefore } : null;
}

export function insertionHint(target: InsertTarget) {
  if (target.node.type.name === 'paragraph' && target.node.content.size === 0) return '将当前空行变成';
  const label: Record<string, string> = { runbookStep: '步骤', runbookCommand: '指令', runbookCode: '代码', bulletList: '列表', orderedList: '列表', blockquote: '引用', heading: '标题', rawMarkdown: '内容块' };
  return `在当前${label[target.node.type.name] ?? '段落'}后插入`;
}

export function insertElement(state: EditorState, target: InsertTarget, kind: InsertKind) {
  if (state.doc.nodeAt(target.from) !== target.node) throw new Error('插入位置已变化，请重新点击需要插入的行。');
  const { schema } = state;
  const make = (type: string, attrs: Record<string, unknown> | null = null, content?: ProseMirrorNode | ProseMirrorNode[]) => schema.nodes[type]!.create(attrs, content);
  const p = (text = '') => make('paragraph', null, text ? schema.text(text) : undefined);
  const heading = (text = '') => make('heading', { level: 2 }, text ? schema.text(text) : undefined);
  const code = (command: boolean) => make(command ? 'runbookCommand' : 'runbookCode', { ...(command ? { commandId: crypto.randomUUID() } : {}), language: command ? 'powershell' : 'text', text: '' });
  const resolved = state.doc.resolve(target.from);
  let step: { from: number; node: ProseMirrorNode } | null = null;
  for (let depth = resolved.depth; depth > 0; depth--) {
    if (resolved.node(depth).type.name === 'runbookStep') step = { from: resolved.before(depth), node: resolved.node(depth) };
  }
  const newStep = kind === 'step' || kind === 'checkpoint' || (kind === 'command' && !step);
  const replaceEmpty = target.node.type.name === 'paragraph' && target.node.content.size === 0 && !(newStep && step);
  const from = newStep && step ? step.from + step.node.nodeSize : replaceEmpty ? target.from : target.from + target.node.nodeSize;
  const to = replaceEmpty ? from + target.node.nodeSize : from;
  let nodes: ProseMirrorNode[], focusFrom: number, focusTo: number | undefined, atom = false;
  if (newStep) {
    const title = heading(kind === 'checkpoint' ? '检查点' : '新步骤');
    const body = kind === 'command' ? code(true) : p(kind === 'checkpoint' ? '请填写检查标准。' : '');
    nodes = [make('runbookStep', { stepId: crypto.randomUUID() }, [title, body])];
    atom = kind === 'command';
    focusFrom = atom ? from + 1 + title.nodeSize : from + 2;
    if (!atom) focusTo = focusFrom + title.content.size;
  } else {
    switch (kind) {
      case 'command': case 'code': nodes = [code(kind === 'command')]; focusFrom = from; atom = true; break;
      case 'heading': nodes = [heading()]; focusFrom = from + 1; break;
      case 'bulletList': case 'orderedList': nodes = [make(kind, null, make('listItem', null, p()))]; focusFrom = from + 3; break;
      case 'blockquote': nodes = [make('blockquote', null, p())]; focusFrom = from + 2; break;
      case 'horizontalRule': nodes = [make('horizontalRule'), p()]; focusFrom = from + 2; break;
      default: nodes = [p()]; focusFrom = from + 1;
    }
  }
  const transaction = state.tr.replaceWith(from, to, nodes);
  return transaction.setSelection(atom ? NodeSelection.create(transaction.doc, focusFrom) : TextSelection.create(transaction.doc, focusFrom, focusTo)).scrollIntoView();
}
