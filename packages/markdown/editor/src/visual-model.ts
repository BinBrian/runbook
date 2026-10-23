import { getSchema, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { GFM, parser } from '@lezer/markdown';
import { parameterDefaults, parameterNamePattern, setParameterDefault } from './parameters';
import { RunbookVariable, visualNodeExtensions } from './visual-schema';

type SourceFragment = {
  key: string; raw: string; before: string; previousKey: string | null; signature?: string;
  open?: string; close?: string; tail?: string;
};
type MetadataFragment = { key: string; raw: string; before: string; previousKey: string | null; nextKey: string | null };
type VisualMeta = {
  original: string; signature?: string; newline: string; tail: string;
  parameters: Record<string, string>; originalParameters: Record<string, string>;
  metadata: MetadataFragment[];
};
type Block = { from: number; to: number; name: string; text: string; unsupported: boolean };

const FORMAT = '<!-- runbook:document version="1" -->';
const STEP_END = '<!-- /runbook:step -->';
const ordinaryTypes = new Set(['Paragraph', 'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6', 'SetextHeading1', 'SetextHeading2', 'BulletList', 'OrderedList', 'Blockquote', 'HorizontalRule']);
const unsupportedInline = new Set(['Image', 'HTMLTag', 'HTMLBlock', 'CommentBlock', 'Table', 'TaskMarker', 'LinkReference', 'LinkReferenceDefinition']);
const richExtensions = [StarterKit.configure({ document: false, codeBlock: false, trailingNode: false }), ...visualNodeExtensions];
const schema = getSchema(richExtensions);
const markdown = new MarkdownManager({ extensions: [StarterKit, RunbookVariable] });

function topBlocks(source: string): Block[] {
  const result: Block[] = [];
  for (let node = parser.configure(GFM).parse(source).topNode.firstChild; node; node = node.nextSibling) {
    let unsupported = false;
    const descendants = [node];
    while (descendants.length) {
      const current = descendants.pop()!;
      if (unsupportedInline.has(current.name) || (current.name === 'FencedCode' && current.from !== node.from)) unsupported = true;
      for (let child = current.firstChild; child; child = child.nextSibling) descendants.push(child);
    }
    // Lezer includes the CR half of a closing CRLF in several block ranges.
    // Keep that complete line ending in the inter-block gap, never in one node.
    const to = source[node.to - 1] === '\r' && source[node.to] === '\n' ? node.to - 1 : node.to;
    result.push({ from: node.from, to, name: node.name, text: source.slice(node.from, to), unsupported });
  }
  return result;
}

function semantic(node: JSONContent): unknown {
  const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([key]) => key !== 'visualSource' && key !== 'visualMeta'));
  return { type: node.type, ...(Object.keys(attrs).length ? { attrs } : {}), ...(node.text !== undefined ? { text: node.text } : {}), ...(node.marks?.length ? { marks: node.marks } : {}), ...(node.content?.length ? { content: node.content.map(semantic) } : {}) };
}
function signature(node: JSONContent): string { return JSON.stringify(semantic(node)); }
function documentSignature(doc: JSONContent): string { return JSON.stringify([semantic(doc), getVisualParameters(doc)]); }
function preserved(node: JSONContent): SourceFragment | undefined { return node.attrs?.visualSource ?? undefined; }
function canonical(doc: JSONContent): JSONContent {
  const normalized = schema.nodeFromJSON(doc);
  normalized.check();
  return normalized.toJSON();
}
function stamp(node: JSONContent): void {
  node.content?.forEach(stamp);
  const source = preserved(node);
  if (source) source.signature = signature(node);
}

function variables(node: JSONContent): JSONContent {
  if (!node.content) return node;
  return { ...node, content: node.content.flatMap((child) => {
    if (child.type !== 'text' || !child.text) return [variables(child)];
    const result: JSONContent[] = [];
    let cursor = 0;
    for (const match of child.text.matchAll(/\{\{rb:([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g)) {
      if (match.index! > cursor) result.push({ ...child, text: child.text.slice(cursor, match.index) });
      result.push({ type: 'runbookVariable', attrs: { name: match[1] }, ...(child.marks ? { marks: child.marks } : {}) });
      cursor = match.index! + match[0].length;
    }
    if (cursor < child.text.length) result.push({ ...child, text: child.text.slice(cursor) });
    return result;
  }) };
}

function variableText(node: JSONContent): JSONContent {
  // MarkdownManager's custom atom renderer does not apply text marks. Return
  // ordinary text first so bold, inline code and links keep their semantics.
  if (node.type === 'runbookVariable') return { type: 'text', text: `{{rb:${node.attrs?.name ?? ''}}}`, ...(node.marks ? { marks: node.marks } : {}) };
  return node.content ? { ...node, content: node.content.map(variableText) } : node;
}

function fence(source: string): { language: string; text: string } {
  const openingEnd = source.indexOf('\n') + 1;
  if (!openingEnd) throw new Error('代码围栏尚未闭合，请在源码中修复。');
  const opening = source.slice(0, openingEnd).trim();
  const match = opening.match(/^(`{3,}|~{3,})([^]*)$/);
  if (!match) throw new Error('无法识别代码围栏，请在源码中修复。');
  const withoutFinalEol = source.replace(/\r?\n$/, '');
  const closingStart = withoutFinalEol.lastIndexOf('\n') + 1;
  const closing = withoutFinalEol.slice(closingStart).trim();
  if (closingStart < openingEnd || !new RegExp(`^${match[1]![0]}{${match[1]!.length},}$`).test(closing)) throw new Error('代码围栏尚未闭合，请在源码中修复。');
  return { language: match[2]!.trim().split(/\s+/)[0] ?? '', text: source.slice(openingEnd, closingStart).replace(/\r?\n$/, '') };
}

function attach(node: JSONContent, raw: string, before: string, extra: Partial<SourceFragment> = {}): JSONContent {
  return { ...node, attrs: { ...node.attrs, visualSource: { key: crypto.randomUUID(), raw, before, previousKey: null, ...extra } satisfies SourceFragment } };
}

/** A conservative editing projection. Native diagnostics remain the authority. */
export function parseVisualDocument(source: string): JSONContent {
  const defaults = parameterDefaults(source);
  const metadata: MetadataFragment[] = [];
  let seenHeader = false;
  const ids = new Set<string>();
  const registerId = (value: string, kind: string) => {
    const key = `${kind}:${value.toLowerCase()}`;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || ids.has(key)) throw new Error('步骤或指令身份无效或重复，请在源码中修复。');
    ids.add(key);
  };
  function parsePart(part: string, insideStep: boolean): { content: JSONContent[]; tail: string } {
    const blocks = topBlocks(part), content: JSONContent[] = [];
    let cursor = 0, previousKey: string | null = null;
    const pendingMetadata: MetadataFragment[] = [];
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!, text = block.text.trim();
      const before = part.slice(cursor, block.from);
      let node: JSONContent;
      let end = block.to;
      if (block.name === 'CommentBlock' && /^<!--\s*\/?runbook:/.test(text)) {
        if (text === FORMAT || /^<!-- runbook:parameters [^]* -->$/.test(text)) {
          if (insideStep || (text === FORMAT && seenHeader)) throw new Error('格式或参数定义标记位置无效，请在源码中修复。');
          if (text === FORMAT) seenHeader = true;
          const entry: MetadataFragment = { key: crypto.randomUUID(), raw: block.text, before, previousKey, nextKey: null };
          metadata.push(entry); pendingMetadata.push(entry); cursor = end; previousKey = entry.key; continue;
        }
        const step = text.match(/^<!-- runbook:step id="([^"]+)" -->$/);
        const command = text.match(/^<!-- runbook:command id="([^"]+)" -->$/);
        if (step) {
          if (insideStep) throw new Error('步骤不能嵌套，请在源码中修复。');
          registerId(step[1]!, 'step');
          let closeIndex = index + 1;
          while (closeIndex < blocks.length && !(blocks[closeIndex]!.name === 'CommentBlock' && blocks[closeIndex]!.text.trim() === STEP_END)) closeIndex++;
          const close = blocks[closeIndex];
          if (!close) throw new Error('步骤尚未闭合，请在源码中修复。');
          const inner = parsePart(part.slice(block.to, close.from), true);
          if (!inner.content.length) throw new Error('步骤没有正文，请在源码中修复。');
          end = close.to;
          node = attach({ type: 'runbookStep', attrs: { stepId: step[1] }, content: inner.content }, part.slice(block.from, end), before, { open: block.text, close: close.text, tail: inner.tail });
          index = closeIndex;
        } else if (command) {
          if (!insideStep) throw new Error('指令必须在步骤内部，请在源码中修复。');
          registerId(command[1]!, 'command');
          const next = blocks[index + 1];
          if (!next || next.name !== 'FencedCode' || part.slice(block.to, next.from).trim()) throw new Error('指令后缺少代码围栏，请在源码中修复。');
          const code = fence(next.text);
          if (!code.text.trim()) throw new Error('指令正文不能为空，请在源码中修复。');
          end = next.to;
          node = attach({ type: 'runbookCommand', attrs: { commandId: command[1], ...code } }, part.slice(block.from, end), before);
          index++;
        } else throw new Error('存在不支持或无效的 Runbook 标记，请在源码中修复。');
      } else if (block.name === 'FencedCode') {
        // Unmarked code is equally exact, but never acquires command semantics.
        try { node = attach({ type: 'runbookCode', attrs: fence(block.text) }, block.text, before); }
        catch { node = attach({ type: 'rawMarkdown', attrs: { raw: block.text } }, block.text, before); }
      } else if (ordinaryTypes.has(block.name) && !block.unsupported) {
        const parsed = variables(markdown.parse(block.text));
        if (parsed.content?.length === 1) node = attach(parsed.content[0]!, block.text, before);
        else node = attach({ type: 'rawMarkdown', attrs: { raw: block.text } }, block.text, before);
      } else node = attach({ type: 'rawMarkdown', attrs: { raw: block.text } }, block.text, before);
      preserved(node)!.previousKey = previousKey;
      for (const entry of pendingMetadata.splice(0)) entry.nextKey = preserved(node)!.key;
      content.push(node);
      previousKey = preserved(node)!.key;
      cursor = end;
    }
    return { content, tail: part.slice(cursor) };
  }
  const parsed = parsePart(source, false);
  if (ids.size && !seenHeader) throw new Error('交互文档缺少格式标记，请在源码中修复。');
  const meta: VisualMeta = { original: source, newline: source.includes('\r\n') ? '\r\n' : '\n', tail: parsed.tail, parameters: defaults, originalParameters: { ...defaults }, metadata };
  const doc = canonical({ type: 'doc', attrs: { visualMeta: meta }, content: parsed.content.length ? parsed.content : [attach({ type: 'paragraph' }, '', '')] });
  stamp(doc);
  (doc.attrs!.visualMeta as VisualMeta).signature = documentSignature(doc);
  return doc;
}

function separator(before: string, after: string, newline: string): string {
  if (!before || !after) return '';
  const left = (before.match(/(?:\r\n|\n|\r)+$/)?.[0].match(/\r\n|\n|\r/g) ?? []).length;
  const right = (after.match(/^(?:\r\n|\n|\r)+/)?.[0].match(/\r\n|\n|\r/g) ?? []).length;
  return newline.repeat(Math.max(0, 2 - left - right));
}
function codeMarkdown(node: JSONContent, newline: string): string {
  const text = String(node.attrs?.text ?? ''), language = String(node.attrs?.language ?? '');
  if (/\s|`|~/.test(language)) throw new Error('代码语言不能包含空白或围栏字符。');
  const delimiter = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
  return `${delimiter}${language}${newline}${text}${newline}${delimiter}`;
}

/** Validate before committing an editor transaction or entering a rich-text
 * serializer. MarkdownManager cannot represent Runbook block nodes inside an
 * ordinary quote/list and would otherwise silently omit their content. */
export function validateVisualDocumentStructure(doc: JSONContent): void {
  const visit = (node: JSONContent, parent: string | undefined) => {
    if (node.type === 'runbookStep' && parent !== 'doc') throw new Error('步骤只能放在文档顶层，不能嵌套或放入列表、引用。');
    if (node.type === 'runbookCommand' && parent !== 'runbookStep') throw new Error('指令必须直接放在步骤内，不能放入列表或引用。');
    if ((node.type === 'runbookCode' || node.type === 'rawMarkdown') && parent !== 'doc' && parent !== 'runbookStep') throw new Error('代码和保留内容只能放在文档或步骤中，不能放入列表或引用。');
    node.content?.forEach((child) => visit(child, node.type));
  };
  visit(doc, undefined);
}

export function serializeVisualDocument(input: JSONContent): string {
  const doc = canonical(input), meta = doc.attrs?.visualMeta as VisualMeta | null;
  validateVisualDocumentStructure(doc);
  if (meta?.signature === documentSignature(doc)) return meta.original;
  const newline = meta?.newline ?? '\n';
  const hasStep = (node: JSONContent): boolean => node.type === 'runbookStep' || !!node.content?.some(hasStep);
  const metadata = meta?.metadata ?? [];
  const availableKeys = new Set((doc.content ?? []).map((node) => preserved(node)?.key));
  const preamble = metadata.filter((entry) => entry.nextKey && !availableKeys.has(entry.nextKey));

  function render(node: JSONContent, insideStep: boolean): string {
    const original = preserved(node);
    if (node.type === 'runbookStep' && insideStep) throw new Error('步骤不能嵌套。');
    if (node.type === 'runbookCommand' && !insideStep) throw new Error('指令必须放在步骤内。');
    if (original?.signature === signature(node)) return original.raw;
    if (node.type === 'rawMarkdown') return String(node.attrs?.raw ?? '');
    if (node.type === 'runbookCommand') {
      if (!node.attrs?.commandId) throw new Error('新指令缺少身份。');
      return `<!-- runbook:command id="${node.attrs.commandId}" -->${newline}${newline}${codeMarkdown(node, newline)}`;
    }
    if (node.type === 'runbookCode') return codeMarkdown(node, newline);
    if (node.type === 'runbookStep') {
      if (!node.attrs?.stepId) throw new Error('新步骤缺少身份。');
      const open = original?.open?.trim() === `<!-- runbook:step id="${node.attrs.stepId}" -->` ? original.open : `<!-- runbook:step id="${node.attrs.stepId}" -->`;
      const close = original?.close ?? STEP_END;
      const body = renderList(node.content ?? [], true), tail = original?.tail ?? '';
      return open + separator(open, body, newline) + body + tail + separator(body + tail, close, newline) + close;
    }
    return markdown.serialize({ type: 'doc', content: [variableText(node)] }).replace(/\r?\n/g, newline);
  }
  function renderList(nodes: JSONContent[], insideStep: boolean): string {
    let result = '', previousKey: string | null = null;
    const emittedMetadata = new Set<string>();
    const append = (value: string, original?: Pick<SourceFragment, 'key' | 'previousKey' | 'before'>) => {
      const before = original?.before ?? '';
      const gap = original && original.previousKey === previousKey ? '' : separator(result, before + value, newline);
      result += gap + before + value;
      previousKey = original?.key ?? '#new';
    };
    const appendMetadata = (entry: MetadataFragment) => {
      // ProseMirror intentionally inherits attrs when splitting a paragraph.
      // Its two halves may share a projection key; metadata still occurs once.
      if (emittedMetadata.has(entry.key)) return;
      append(entry.raw, entry); emittedMetadata.add(entry.key);
    };
    if (!insideStep) for (const entry of preamble) appendMetadata(entry);
    for (const node of nodes) {
      if (!insideStep) for (const entry of metadata.filter((item) => item.nextKey === preserved(node)?.key)) appendMetadata(entry);
      const original = preserved(node), value = render(node, insideStep);
      append(value, original);
    }
    if (!insideStep) for (const entry of metadata.filter((item) => item.nextKey === null)) appendMetadata(entry);
    return result;
  }
  let result = renderList(doc.content ?? [], false);
  result += meta?.tail ?? '';
  if (doc.content?.some(hasStep) && !metadata.some((item) => item.raw.trim() === FORMAT)) result = FORMAT + newline + newline + result;
  const parameters = getVisualParameters(doc);
  for (const [name, value] of Object.entries(parameters)) if (meta?.originalParameters[name] !== value) result = setParameterDefault(result, name, value);
  return result;
}

export function getVisualParameters(doc: JSONContent): Record<string, string> { return { ...(doc.attrs?.visualMeta?.parameters ?? {}) }; }

export function setVisualParameter(doc: JSONContent, name: string, defaultValue: string): JSONContent {
  if (!parameterNamePattern.test(name)) throw new Error('变量名以字母或下划线开头，仅包含字母、数字、下划线，最长 64 个字符。');
  const clone = structuredClone(doc);
  clone.attrs ??= {};
  clone.attrs.visualMeta ??= { original: '', newline: '\n', tail: '', parameters: {}, originalParameters: {}, metadata: [] } satisfies VisualMeta;
  Object.defineProperty(clone.attrs.visualMeta.parameters, name, { value: defaultValue, enumerable: true, configurable: true, writable: true });
  return clone;
}

/** Copying content creates new identities; moving content must keep the original node. */
export function cloneVisualNode(node: JSONContent): JSONContent {
  const copy = structuredClone(node);
  const reset = (entry: JSONContent) => {
    if (entry.attrs) { delete entry.attrs.visualSource; delete entry.attrs.visualMeta; }
    if (entry.type === 'runbookStep') entry.attrs = { ...entry.attrs, stepId: crypto.randomUUID() };
    if (entry.type === 'runbookCommand') entry.attrs = { ...entry.attrs, commandId: crypto.randomUUID() };
    entry.content?.forEach(reset);
  };
  reset(copy);
  return copy;
}
