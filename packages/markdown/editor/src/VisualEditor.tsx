import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import { Extension, type Editor, type JSONContent, type NodeViewProps } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import { cloneVisualNode, getVisualParameters, parseVisualDocument, serializeVisualDocument, setVisualParameter } from './visual-model';
import { RawMarkdown, RunbookCode, RunbookCommand, RunbookStep, RunbookVariable, VisualDocument, VisualPreservation } from './visual-schema';
import { parameterNamePattern } from './parameters';
import { ContextInsert } from './ContextInsert';
import './visual-editor.css';

export interface VisualEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  reveal?: { from: number };
  revealStepId?: string;
  onError?: (error: Error | string) => void;
  onCopy?: (text: string, commandId?: string) => void | Promise<void>;
  copyLabel?: string;
  onOpenSource?: () => void;
  onEditVariable?: (name: string) => void;
  onPendingDialogChange?: (draft: Record<string, unknown> | null) => void;
  renderRaw?: (source: string) => ReactNode;
}

type VariableRequest = { text: string; apply: (name: string, defaultValue: string) => void };
interface VisualActions {
  readOnly: boolean;
  copyLabel: string;
  copy: (text: string, commandId?: string) => void;
  error: (error: unknown) => void;
  source: () => void;
  variable: (name: string) => void;
  createVariable: (request: VariableRequest) => void;
  renderRaw?: (source: string) => ReactNode;
}
const Actions = createContext<VisualActions | null>(null);
function useActions() {
  const actions = useContext(Actions);
  if (!actions) throw new Error('缺少文档编辑上下文。');
  return actions;
}
const uuid = () => crypto.randomUUID();
const clipboardMime = 'application/x-runbook-visual+json';
const textNode = (text: string): JSONContent => ({ type: 'text', text });
const paragraph = (text = ''): JSONContent => ({ type: 'paragraph', content: text ? [textNode(text)] : [] });
const preserveFocus = (event: React.MouseEvent) => event.preventDefault();

function stepAt(editor: Editor, position = editor.state.selection.from) {
  const resolved = editor.state.doc.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth--) {
    if (resolved.node(depth).type.name === 'runbookStep') return { node: resolved.node(depth), pos: resolved.before(depth), depth };
  }
  return null;
}

function addParameter(transaction: Transaction, editor: Editor, name: string, value: string) {
  const json = setVisualParameter(editor.getJSON(), name, value);
  return transaction.setDocAttribute('visualMeta', json.attrs?.visualMeta ?? null);
}

function moveStep(editor: Editor, pos: number, direction: -1 | 1) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const resolved = editor.state.doc.resolve(pos);
  if (resolved.parent.type.name !== 'doc') return;
  const index = resolved.index();
  const sibling = direction < 0 ? resolved.parent.maybeChild(index - 1) : resolved.parent.maybeChild(index + 1);
  if (!sibling) return;
  const destination = direction < 0 ? pos - sibling.nodeSize : pos + sibling.nodeSize;
  const transaction = editor.state.tr.delete(pos, pos + node.nodeSize).insert(destination, node);
  editor.view.dispatch(transaction.scrollIntoView());
  editor.view.focus();
}

function StepView({ node, editor, getPos, deleteNode }: NodeViewProps) {
  const actions = useActions();
  const [, refresh] = useState(0);
  useEffect(() => { const update = () => refresh(value => value + 1); editor.on('transaction', update); return () => { editor.off('transaction', update); }; }, [editor]);
  const position = getPos();
  const index = typeof position === 'number' ? editor.state.doc.resolve(position).index() : 0;
  const canMove = typeof position === 'number' && editor.state.doc.resolve(position).parent.type.name === 'doc';
  const stepIndex = typeof position === 'number'
    ? editor.state.doc.content.content.filter((child, childIndex) => childIndex <= index && child.type.name === 'runbookStep').length
    : 1;
  return <NodeViewWrapper className="visual-step" data-step-id={node.attrs.stepId}>
    <div className="visual-step-heading" contentEditable={false}>
      <span className="visual-drag-handle" data-drag-handle title="拖动调整步骤顺序" aria-hidden="true">⠿</span>
      <span className="visual-step-number">步骤 {String(stepIndex).padStart(2, '0')}</span>
      <span className="visual-step-hint">独立执行 · 可记录结果</span>
      {!actions.readOnly && <div className="visual-node-actions">
        <button type="button" aria-label="上移步骤" title="上移步骤" disabled={!canMove || index === 0} onMouseDown={preserveFocus} onClick={() => typeof position === 'number' && moveStep(editor, position, -1)}>↑</button>
        <button type="button" aria-label="下移步骤" title="下移步骤" disabled={!canMove || index >= editor.state.doc.childCount - 1} onMouseDown={preserveFocus} onClick={() => typeof position === 'number' && moveStep(editor, position, 1)}>↓</button>
        <button type="button" aria-label="复制步骤" title="复制步骤" onMouseDown={preserveFocus} onClick={() => {
          if (typeof position === 'number') editor.chain().focus().insertContentAt(position + node.nodeSize, cloneVisualNode(node.toJSON())).run();
        }}>复制</button>
        <button type="button" aria-label="删除步骤" title="删除步骤（可撤销）" onMouseDown={preserveFocus} onClick={deleteNode}>移除</button>
      </div>}
    </div>
    <NodeViewContent className="visual-step-content" />
  </NodeViewWrapper>;
}

function commandParts(text: string, onVariable: (name: string) => void) {
  return text.split(/(\{\{rb:[A-Za-z_][A-Za-z0-9_]{0,63}\}\})/g).map((part, index) => {
    const match = /^\{\{rb:([A-Za-z_][A-Za-z0-9_]{0,63})\}\}$/.exec(part);
    return match ? <button type="button" className="visual-variable-chip" key={index} onClick={() => onVariable(match[1]!)} title={`修改变量 ${match[1]}`}><span aria-hidden="true">◇</span>{match[1]}</button> : part;
  });
}

const normalizeTextarea = (text: string) => text.replace(/\r\n?|\n/g, '\n');
function rawOffset(text: string, offset: number) {
  let raw = 0;
  let normalized = 0;
  while (raw < text.length && normalized < offset) {
    raw += text[raw] === '\r' && text[raw + 1] === '\n' ? 2 : 1;
    normalized++;
  }
  return raw;
}

/** A textarea normalizes CRLF. Preserve untouched raw ranges when committing an edit. */
function editCommandText(raw: string, next: string) {
  const old = normalizeTextarea(raw);
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const newline = raw.includes('\r\n') ? '\r\n' : raw.includes('\r') && !raw.includes('\n') ? '\r' : '\n';
  return raw.slice(0, rawOffset(raw, prefix)) + next.slice(prefix, next.length - suffix).replace(/\n/g, newline) + raw.slice(rawOffset(raw, old.length - suffix));
}

function CommandView({ node, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  const actions = useActions();
  const isCommand = node.type.name === 'runbookCommand';
  const raw = String(node.attrs.text ?? '');
  const [editing, setEditing] = useState(!raw && !actions.readOnly);
  const [selection, setSelection] = useState({ from: 0, to: 0 });
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing && !actions.readOnly) textarea.current?.focus(); }, [editing, actions.readOnly]);
  const requestVariable = () => {
    const from = rawOffset(raw, selection.from);
    const to = rawOffset(raw, selection.to);
    if (from === to || !raw.slice(from, to).trim()) return actions.error('请先在指令中选中要设为变量的文本。');
    for (const match of raw.matchAll(/\{\{rb:[^{}]*\}\}/g)) {
      if (match.index! < to && match.index! + match[0].length > from) return actions.error('选区包含已有变量，请点击变量标签修改。');
    }
    actions.createVariable({ text: raw.slice(from, to), apply: (name, defaultValue) => {
      const pos = getPos();
      if (typeof pos !== 'number') throw new Error('指令位置已变化，请重新选择。');
      const current = editor.state.doc.nodeAt(pos);
      if (!current || current.attrs.text !== raw) throw new Error('指令内容已变化，请重新选择。');
      const transaction = editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, text: raw.slice(0, from) + `{{rb:${name}}}` + raw.slice(to) });
      editor.view.dispatch(addParameter(transaction, editor, name, defaultValue));
      setEditing(false);
      setSelection({ from: 0, to: 0 });
    } });
  };
  return <NodeViewWrapper className={`visual-command-card ${isCommand ? '' : 'visual-code-card'}`} contentEditable={false} data-command-id={isCommand ? node.attrs.commandId : undefined}>
    <div className="visual-command-heading">
      <span className="visual-command-icon" aria-hidden="true">{isCommand ? '›_' : '</>'}</span>
      <strong>{isCommand ? '指令' : '代码'}</strong>
      {!actions.readOnly && editing ? <input aria-label={isCommand ? '指令语言' : '代码语言'} className="visual-language-input" value={node.attrs.language ?? ''} placeholder="语言" maxLength={40} onChange={event => updateAttributes({ language: event.target.value.replace(/[\s`~]/g, '') })} /> : <span className="visual-language">{node.attrs.language || '纯文本'}</span>}
      <div className="visual-node-actions">
        {!actions.readOnly && editing && <button type="button" onMouseDown={preserveFocus} onClick={requestVariable} disabled={selection.from === selection.to}>设为变量</button>}
        {!actions.readOnly && <button type="button" onClick={() => setEditing(!editing)}>{editing ? '完成编辑' : isCommand ? '编辑指令' : '编辑代码'}</button>}
        <button type="button" onClick={() => actions.copy(raw, isCommand ? node.attrs.commandId : undefined)}>{actions.copyLabel}</button>
        {!actions.readOnly && <button type="button" aria-label={isCommand ? '删除指令' : '删除代码'} title="移除（可撤销）" onClick={deleteNode}>×</button>}
      </div>
    </div>
    {editing && !actions.readOnly ? <div className="visual-command-edit">
      <textarea ref={textarea} aria-label={isCommand ? '指令内容' : '代码内容'} spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={Math.min(14, Math.max(3, normalizeTextarea(raw).split('\n').length))} value={raw}
        onChange={event => updateAttributes({ text: editCommandText(raw, event.target.value) })}
        onSelect={event => setSelection({ from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd })}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setEditing(false); }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? editor.commands.redo() : editor.commands.undo(); }
          if (event.key === 'Tab') {
            event.preventDefault();
            const element = event.currentTarget;
            const from = element.selectionStart;
            const to = element.selectionEnd;
            const next = element.value.slice(0, from) + '\t' + element.value.slice(to);
            updateAttributes({ text: editCommandText(raw, next) });
            requestAnimationFrame(() => element.setSelectionRange(from + 1, from + 1));
          }
        }} />
      <p>按原样保存空格与换行 · 选中文本可设为变量</p>
    </div> : <pre className="visual-command-preview" onDoubleClick={() => !actions.readOnly && setEditing(true)}>{raw ? commandParts(raw, actions.variable) : <span className="visual-empty-command">点击“编辑指令”填写内容</span>}</pre>}
  </NodeViewWrapper>;
}

function VariableView({ node }: NodeViewProps) {
  const actions = useActions();
  return <NodeViewWrapper as="span" className="visual-variable-wrapper" contentEditable={false}><button type="button" className="visual-variable-chip" onClick={() => actions.variable(String(node.attrs.name))} title={`修改变量 ${node.attrs.name}`}><span aria-hidden="true">◇</span>{node.attrs.name}</button></NodeViewWrapper>;
}

function RawView({ node }: NodeViewProps) {
  const actions = useActions();
  return <NodeViewWrapper className="visual-preserved-block" contentEditable={false}>
    <div className="visual-preserved-heading"><span>保留内容</span><button type="button" onClick={actions.source}>在源码中编辑</button></div>
    <div className="visual-preserved-preview">{actions.renderRaw ? actions.renderRaw(String(node.attrs.raw ?? '')) : <p>这部分内容按原文保留，可在源码中查看和编辑。</p>}</div>
  </NodeViewWrapper>;
}

function clonePastedSlice(slice: Slice) {
  const clone = (node: ProseMirrorNode): ProseMirrorNode => {
    if (node.isText) return node;
    const attrs: Record<string, unknown> = { ...node.attrs, visualSource: null };
    if (node.type.name === 'runbookStep') attrs.stepId = uuid();
    if (node.type.name === 'runbookCommand') attrs.commandId = uuid();
    const children: ProseMirrorNode[] = [];
    node.forEach(child => children.push(clone(child)));
    return node.type.create(attrs, Fragment.from(children), node.marks);
  };
  const children: ProseMirrorNode[] = [];
  slice.content.forEach(node => children.push(clone(node)));
  return new Slice(Fragment.from(children), slice.openStart, slice.openEnd);
}

function safePastedHtml(html: string) {
  // Template contents stay inert while resource-bearing elements and attributes are removed.
  const template = document.createElement('template');
  template.innerHTML = html;
  const allowed = new Set(['P', 'BR', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'OL', 'UL', 'LI', 'BLOCKQUOTE', 'STRONG', 'B', 'EM', 'I', 'S', 'DEL', 'U', 'CODE', 'PRE', 'HR', 'A', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH']);
  const discard = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'LINK', 'META', 'BASE', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'CANVAS', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT']);
  for (const element of Array.from(template.content.querySelectorAll('*')).reverse()) {
    if (!allowed.has(element.tagName)) {
      if (discard.has(element.tagName)) element.remove();
      else element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'start' && element.tagName === 'OL' && /^\d+$/.test(attribute.value)) continue;
      if (attribute.name === 'href' && element.tagName === 'A' && /^(https?:|mailto:|#)/i.test(attribute.value)) continue;
      element.removeAttribute(attribute.name);
    }
  }
  return template.innerHTML;
}

function selectedPlainText(editor: Editor, allowVariables = false) {
  const { from, to, $from, $to } = editor.state.selection;
  if (from === to) throw new Error('请先选中需要转换的文字。');
  if (!$from.sameParent($to) || !$from.parent.isTextblock) throw new Error('请在同一个段落中选择文本。');
  const step = stepAt(editor);
  if ($from.depth !== (step ? step.depth + 1 : 1)) throw new Error('请在正文段落中转换；列表或引用可在源码中调整。');
  let includesSpecialNode = false;
  editor.state.doc.nodesBetween(from, to, node => { if (node.isAtom && !node.isText && node.type.name !== 'hardBreak' && !(allowVariables && node.type.name === 'runbookVariable')) includesSpecialNode = true; });
  if (includesSpecialNode) throw new Error('选区包含变量或其他内容块，请只选择普通文本。');
  const text = editor.state.doc.textBetween(from, to, '\n', node => node.type.name === 'hardBreak' ? '\n' : node.type.name === 'runbookVariable' ? `{{rb:${node.attrs.name}}}` : '');
  if (!text.trim()) throw new Error('请选择包含文字的内容。');
  return { from, to, text };
}

export function VisualEditor(props: VisualEditorProps) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const lastEmitted = useRef(props.value);
  const initial = useMemo(() => {
    try { return { content: parseVisualDocument(props.value), error: '' }; }
    catch (error) { return { content: { type: 'doc', content: [paragraph()] }, error: error instanceof Error ? error.message : String(error) }; }
    // Initial content is replaced only for external changes, never the parent's echo of an edit.
  }, []);
  const [failure, setFailure] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [request, setRequest] = useState<VariableRequest | null>(null);
  const [variableName, setVariableName] = useState('');
  const [variableValue, setVariableValue] = useState('');
  const [variableError, setVariableError] = useState('');
  const [insertRequest, setInsertRequest] = useState<{ position: number; key: number }>();
  const moveDrop = useRef(false);
  const [, refresh] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const variableDialog = useRef<HTMLFormElement>(null);
  const report = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    setNotice(text);
    propsRef.current.onError?.(error instanceof Error ? error : new Error(text));
  };
  const clipboardCopy = (view: Editor['view'], event: ClipboardEvent, cut: boolean) => {
    if ((event.target as HTMLElement | null)?.closest('input, textarea')) return false;
    if (!event.clipboardData || view.state.selection.empty) return false;
    const slice = view.state.selection.content();
    let semantic = false;
    const referenced = new Set<string>();
    slice.content.descendants(node => {
      if (['runbookStep', 'runbookCommand', 'runbookCode', 'runbookVariable', 'rawMarkdown'].includes(node.type.name)) semantic = true;
      if (node.type.name === 'runbookVariable') referenced.add(String(node.attrs.name));
      if (['runbookCommand', 'runbookCode', 'rawMarkdown'].includes(node.type.name)) for (const match of String(node.attrs.text ?? node.attrs.raw ?? '').matchAll(/\{\{rb:([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g)) referenced.add(match[1]!);
    });
    if (!semantic) return false;
    const defaults = getVisualParameters(view.state.doc.toJSON());
    const parameters = Object.fromEntries([...referenced].filter(name => Object.hasOwn(defaults, name)).map(name => [name, defaults[name]]));
    const clean = clonePastedSlice(slice);
    event.clipboardData.setData(clipboardMime, JSON.stringify({ version: 1, slice: clean.toJSON(), parameters }));
    event.clipboardData.setData('text/plain', slice.content.textBetween(0, slice.content.size, '\n', node => node.type.name === 'runbookVariable' ? `{{rb:${node.attrs.name}}}` : String(node.attrs.text ?? node.attrs.raw ?? '')));
    event.preventDefault();
    if (cut && !propsRef.current.readOnly) view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    return true;
  };
  const paste = (view: Editor['view'], event: ClipboardEvent) => {
    if ((event.target as HTMLElement | null)?.closest('input, textarea')) return false;
    const transfer = event.clipboardData;
    if (!transfer || propsRef.current.readOnly) return false;
    const encoded = transfer.getData(clipboardMime);
    const text = transfer.getData('text/plain');
    const isMarkdown = !transfer.getData('text/html') && /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|`{3}|~{3}|<!--\s*runbook:)|\*\*[^*]+\*\*|\{\{rb:/.test(text);
    if (!encoded && !isMarkdown) return false;
    try {
      let slice: Slice;
      let incoming: Record<string, string>;
      if (encoded) {
        const payload = JSON.parse(encoded) as { version?: number; slice?: unknown; parameters?: unknown };
        if (payload.version !== 1 || !payload.parameters || typeof payload.parameters !== 'object' || Array.isArray(payload.parameters)) throw new Error('剪贴板文档格式无效。');
        incoming = payload.parameters as Record<string, string>;
        slice = clonePastedSlice(Slice.fromJSON(view.state.schema, payload.slice));
      } else {
        const parsed = parseVisualDocument(text);
        incoming = getVisualParameters(parsed);
        const content = cloneVisualNode(parsed).content ?? [];
        slice = new Slice(Fragment.from(content.map(node => view.state.schema.nodeFromJSON(node))), 0, 0);
      }
      let next = view.state.doc.toJSON();
      const current = getVisualParameters(next);
      for (const [name, value] of Object.entries(incoming)) {
        if (!parameterNamePattern.test(name) || typeof value !== 'string') throw new Error('剪贴板中的变量定义无效。');
        if (Object.hasOwn(current, name) && current[name] !== value) throw new Error(`变量 ${name} 的默认值与当前文档不同。请先统一变量值，或将该文档单独导入。`);
        if (!Object.hasOwn(current, name)) next = setVisualParameter(next, name, value);
      }
      const referenced = new Set<string>();
      slice.content.descendants(node => {
        if (node.type.name === 'runbookVariable') referenced.add(String(node.attrs.name));
        if (['runbookCommand', 'runbookCode', 'rawMarkdown'].includes(node.type.name)) for (const match of String(node.attrs.text ?? node.attrs.raw ?? '').matchAll(/\{\{rb:([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g)) referenced.add(match[1]!);
      });
      const merged = getVisualParameters(next);
      for (const name of referenced) if (!Object.hasOwn(merged, name)) throw new Error(`请先为变量 ${name} 设置默认值，再粘贴引用。`);
      let hasStep = false;
      let hasCommand = false;
      slice.content.forEach(node => { if (node.type.name === 'runbookStep') hasStep = true; if (node.type.name === 'runbookCommand') hasCommand = true; });
      let insideStep = false;
      for (let depth = view.state.selection.$from.depth; depth > 0; depth--) if (view.state.selection.$from.node(depth).type.name === 'runbookStep') insideStep = true;
      if (hasStep && slice.openStart === 0 && insideStep) throw new Error('请在步骤外粘贴整组步骤，或先复制需要的正文。');
      if (hasCommand && !hasStep && !insideStep) slice = new Slice(Fragment.from(view.state.schema.nodes.runbookStep!.create({ stepId: uuid() }, slice.content)), 0, 0);
      const transaction = view.state.tr.replaceSelection(slice).setDocAttribute('visualMeta', next.attrs?.visualMeta ?? null);
      serializeVisualDocument(transaction.doc.toJSON());
      view.dispatch(transaction.scrollIntoView());
    } catch (error) { report(error); }
    event.preventDefault();
    return true;
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ document: false, codeBlock: false, trailingNode: false, link: { openOnClick: false, autolink: false }, dropcursor: { color: '#23866b', width: 2 } }),
      Extension.create({ name: 'visualSerializationGuard', addProseMirrorPlugins: () => [new Plugin({ filterTransaction: transaction => {
        if (!transaction.docChanged) return true;
        try { serializeVisualDocument(transaction.doc.toJSON()); return true; }
        catch (error) { queueMicrotask(() => report(error)); return false; }
      } })] }),
      VisualDocument, VisualPreservation,
      RunbookStep.extend({ draggable: true, addNodeView() { return ReactNodeViewRenderer(StepView); } }),
      RunbookCommand.extend({ addNodeView() { return ReactNodeViewRenderer(CommandView); } }),
      RunbookCode.extend({ addNodeView() { return ReactNodeViewRenderer(CommandView); } }),
      RunbookVariable.extend({ addNodeView() { return ReactNodeViewRenderer(VariableView); } }),
      RawMarkdown.extend({ addNodeView() { return ReactNodeViewRenderer(RawView); } }),
    ],
    content: initial.content,
    editable: !props.readOnly && !initial.error,
    immediatelyRender: true,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: 'visual-document', 'aria-label': '文档内容', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
      transformPastedHTML: safePastedHtml,
      transformPasted: (slice, view) => view.dragging && moveDrop.current ? slice : clonePastedSlice(slice),
      handleDOMEvents: {
        copy: (view, event) => clipboardCopy(view, event as ClipboardEvent, false),
        cut: (view, event) => clipboardCopy(view, event as ClipboardEvent, true),
        paste: (view, event) => { moveDrop.current = false; return paste(view, event as ClipboardEvent); },
        drop: (_view, event) => { moveDrop.current = !(event as DragEvent).ctrlKey; return false; },
        click: (_view, event) => {
          if ((event.target as HTMLElement)?.closest('a')) { event.preventDefault(); return true; }
          return false;
        },
      },
      handleDrop: (view, event, slice) => {
        const point = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!point) return false;
        let hasStep = false;
        let hasCommand = false;
        slice.content.descendants(node => { if (node.type.name === 'runbookStep') hasStep = true; if (node.type.name === 'runbookCommand') hasCommand = true; });
        const resolved = view.state.doc.resolve(point.pos);
        let inStep = false;
        for (let depth = resolved.depth; depth > 0; depth--) if (resolved.node(depth).type.name === 'runbookStep') inStep = true;
        if (hasStep && inStep) { report('请把步骤拖到其他步骤之间。'); return true; }
        if (hasCommand && !hasStep && !inStep) { report('请把指令拖到步骤内部。'); return true; }
        return false;
      },
      handleKeyDown: (view, event) => {
        if (event.key === '/' && !event.ctrlKey && !event.metaKey && view.state.selection.empty && view.state.selection.$from.parent.type.name === 'paragraph' && !view.state.selection.$from.parent.textContent) {
          setInsertRequest(current => ({ position: view.state.selection.from, key: (current?.key ?? 0) + 1 }));
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: updated }) => {
      try {
        const source = serializeVisualDocument(updated.getJSON());
        if (source === lastEmitted.current) return;
        lastEmitted.current = source;
        propsRef.current.onChange(source);
        setNotice('');
      } catch (error) { report(error); }
    },
    onSelectionUpdate: () => refresh(value => value + 1),
  });

  useEffect(() => {
    if (!editor || props.value === lastEmitted.current) return;
    try {
      const content = parseVisualDocument(props.value);
      const doc = editor.schema.nodeFromJSON(content);
      const anchor = Math.min(editor.state.selection.anchor, doc.content.size);
      const focus = Math.min(editor.state.selection.head, doc.content.size);
      // A source replacement starts a fresh history, so undo cannot restore another document.
      editor.view.updateState(EditorState.create({ schema: editor.schema, doc, plugins: editor.state.plugins, selection: TextSelection.between(doc.resolve(anchor), doc.resolve(focus)) }));
      lastEmitted.current = props.value;
      setFailure('');
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
  }, [editor, props.value]);
  useEffect(() => { editor?.setEditable(!props.readOnly && !failure); }, [editor, props.readOnly, failure]);
  useEffect(() => {
    if (!props.revealStepId || !scroll.current) return;
    const target = Array.from(scroll.current.querySelectorAll<HTMLElement>('[data-step-id]')).find(element => element.dataset.stepId === props.revealStepId);
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [props.revealStepId, props.reveal]);
  useEffect(() => {
    propsRef.current.onPendingDialogChange?.(request ? { kind: 'visual-variable', name: variableName, value: variableValue, selectedText: request.text } : null);
  }, [request, variableName, variableValue]);
  useEffect(() => () => propsRef.current.onPendingDialogChange?.(null), []);

  const guarded = (action: () => void) => { try { action(); } catch (error) { report(error); } };
  const openVariable = (next: VariableRequest) => { setVariableName(''); setVariableValue(next.text); setVariableError(''); setRequest(next); };
  const closeVariable = () => { setRequest(null); setVariableError(''); editor?.commands.focus(); };
  const convertVariable = () => guarded(() => {
    if (!editor) return;
    const { from, to, text } = selectedPlainText(editor);
    openVariable({ text, apply: (name, defaultValue) => {
      const current = editor.state.doc.textBetween(from, to, '\n', node => node.type.name === 'hardBreak' ? '\n' : '');
      if (current !== text) throw new Error('选区内容已变化，请重新选择。');
      const node = editor.schema.nodes.runbookVariable!.create({ name });
      const transaction = editor.state.tr.replaceWith(from, to, node);
      editor.view.dispatch(addParameter(transaction, editor, name, defaultValue).scrollIntoView());
    } });
  });
  const convertCommand = () => guarded(() => {
    if (!editor) return;
    const { from, to, text } = selectedPlainText(editor, true);
    const command: JSONContent = { type: 'runbookCommand', attrs: { commandId: uuid(), language: 'powershell', text } };
    const content = stepAt(editor) ? command : { type: 'runbookStep', attrs: { stepId: uuid() }, content: [command] };
    editor.chain().focus().insertContentAt({ from, to }, content).run();
  });
  const convertStep = () => guarded(() => {
    if (!editor) return;
    if (stepAt(editor)) throw new Error('所选内容已在步骤内，可以直接编辑或新增下一步。');
    const { from, to } = selectedPlainText(editor, true);
    const { $from, $to } = editor.state.selection;
    const content = $from.parent.cut($from.parentOffset, $to.parentOffset).toJSON();
    editor.chain().focus().insertContentAt({ from, to }, { type: 'runbookStep', attrs: { stepId: uuid() }, content: [content] }).run();
  });
  const actions: VisualActions = {
    readOnly: !!props.readOnly,
    copyLabel: props.copyLabel ?? '复制',
    copy: (text, id) => { try { Promise.resolve(propsRef.current.onCopy?.(text, id)).catch(report); } catch (error) { report(error); } },
    error: report,
    source: () => propsRef.current.onOpenSource?.(),
    variable: name => propsRef.current.onEditVariable?.(name),
    createVariable: openVariable,
    renderRaw: props.renderRaw,
  };
  const hasSelection = !!editor && !editor.state.selection.empty;
  const parameters = editor ? getVisualParameters(editor.getJSON()) : {};
  const existingVariable = Object.hasOwn(parameters, variableName.trim());

  if (failure) return <div className="visual-editor-fallback"><strong>这份文档需要先在源码中调整</strong><p>{failure}</p><button type="button" onClick={props.onOpenSource}>打开源码</button></div>;
  return <Actions.Provider value={actions}><div className={`visual-editor ${props.readOnly ? 'is-readonly' : ''}`}>
    {!props.readOnly && <div className="visual-toolbar" role="toolbar" aria-label="文档格式与插入">
      <div className="visual-toolbar-group">
        <select aria-label="文字样式" value={editor?.isActive('heading', { level: 1 }) ? 'h1' : editor?.isActive('heading', { level: 2 }) ? 'h2' : editor?.isActive('heading', { level: 3 }) ? 'h3' : 'p'} onChange={event => {
          if (event.target.value === 'p') editor?.chain().focus().setParagraph().run();
          else editor?.chain().focus().setHeading({ level: Number(event.target.value.slice(1)) as 1 | 2 | 3 }).run();
        }}><option value="p">正文</option><option value="h1">标题 1</option><option value="h2">标题 2</option><option value="h3">标题 3</option></select>
        <button type="button" aria-label="加粗" title="加粗 Ctrl+B" className={editor?.isActive('bold') ? 'is-active' : ''} onMouseDown={preserveFocus} onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
        <button type="button" aria-label="斜体" title="斜体 Ctrl+I" className={editor?.isActive('italic') ? 'is-active' : ''} onMouseDown={preserveFocus} onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" aria-label="无序列表" title="无序列表" className={editor?.isActive('bulletList') ? 'is-active' : ''} onMouseDown={preserveFocus} onClick={() => editor?.chain().focus().toggleBulletList().run()}>• 列表</button>
        <button type="button" aria-label="有序列表" title="有序列表" className={editor?.isActive('orderedList') ? 'is-active' : ''} onMouseDown={preserveFocus} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1. 列表</button>
        <button type="button" aria-label="引用" title="引用" className={editor?.isActive('blockquote') ? 'is-active' : ''} onMouseDown={preserveFocus} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>“</button>
      </div>
      <div className="visual-toolbar-group visual-selection-tools">
        <button type="button" disabled={!hasSelection} onMouseDown={preserveFocus} onClick={convertStep}>设为步骤</button>
        <button type="button" disabled={!hasSelection} onMouseDown={preserveFocus} onClick={convertCommand}>转为指令</button>
        <button type="button" disabled={!hasSelection} onMouseDown={preserveFocus} onClick={convertVariable}>设为变量</button>
      </div>
      <div className="visual-toolbar-group visual-history-tools">
        <button type="button" aria-label="撤销" title="撤销 Ctrl+Z" disabled={!editor?.can().undo()} onMouseDown={preserveFocus} onClick={() => editor?.chain().focus().undo().run()}>↶</button>
        <button type="button" aria-label="重做" title="重做 Ctrl+Shift+Z" disabled={!editor?.can().redo()} onMouseDown={preserveFocus} onClick={() => editor?.chain().focus().redo().run()}>↷</button>
      </div>
    </div>}
    {notice && <div className="visual-notice" role="status"><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
    <div className="visual-scroll" ref={scroll}>
      <div className="visual-page-caption"><span>操作文档</span><span>{props.readOnly ? '只读' : '点击行左侧 ＋ 插入元素 · 空行也可输入 /'}</span></div>
      <EditorContent editor={editor} />
      {!props.readOnly && <button type="button" className="visual-append" onClick={() => editor && guarded(() => {
        const position = editor.state.doc.content.size;
        const transaction = editor.state.tr.insert(position, editor.schema.nodes.paragraph!.create());
        editor.view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, position + 1)).scrollIntoView());
        editor.view.focus();
      })}>＋ 继续写文档</button>}
    </div>
    {editor && <ContextInsert editor={editor} readOnly={!!props.readOnly || !!request} scroller={scroll} request={insertRequest} onError={report}/>}
    {request && <div className="visual-dialog-backdrop" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); closeVariable(); }
      if (event.key === 'Tab') {
        const fields = Array.from(variableDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
        const first = fields[0], last = fields.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <form ref={variableDialog} className="visual-variable-dialog" role="dialog" aria-modal="true" aria-label="设为变量" onSubmit={event => {
        event.preventDefault();
        const name = variableName.trim();
        if (!parameterNamePattern.test(name)) return setVariableError('名称以字母或下划线开头，仅使用字母、数字和下划线，最多 64 个字符。');
        try { request.apply(name, existingVariable ? parameters[name]! : variableValue); closeVariable(); }
        catch (error) { setVariableError(error instanceof Error ? error.message : String(error)); }
      }}>
        <div className="visual-variable-dialog-heading"><div><h2>设为变量</h2><p>把这处固定内容替换为可复用的参数。</p></div><button type="button" aria-label="关闭变量对话框" onClick={closeVariable}>×</button></div>
        <label>变量名称<input autoFocus aria-label="变量名称" value={variableName} placeholder="例如 HOST、VERSION" maxLength={64} onChange={event => setVariableName(event.target.value)} /></label>
        <label>默认值<textarea aria-label="默认值" value={existingVariable ? parameters[variableName.trim()] : variableValue} disabled={existingVariable} rows={3} onChange={event => setVariableValue(event.target.value)} /></label>
        {existingVariable && <p className="visual-variable-help">将引用已有变量，保持它的默认值。</p>}
        {variableError && <p className="visual-variable-error" role="alert">{variableError}</p>}
        <div className="visual-variable-dialog-footer"><button type="button" onClick={closeVariable}>取消</button><button type="submit">{existingVariable ? '引用变量' : '创建变量'}</button></div>
      </form>
    </div>}
  </div></Actions.Provider>;
}
