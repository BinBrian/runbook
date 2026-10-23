import { describe, expect, it } from 'vitest';
import { getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { cloneVisualNode, getVisualParameters, parseVisualDocument, serializeVisualDocument, setVisualParameter, validateVisualDocumentStructure } from './visual-model';
import { visualNodeExtensions } from './visual-schema';

const stepId = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';
const head = '<!-- runbook:document version="1" -->';
const source = `${head}\n\n<!-- runbook:parameters {"HOST":"staging","PATH":"C:/更新"} -->\n\n# 维护说明\n\n连接 **{{rb:HOST}}**，核对 [文档](https://example.com "标题")。\n\n<!-- runbook:step id="${stepId}" -->\n\n## 备份\n\n执行前确认磁盘空间。\n\n<!-- runbook:command id="${commandId}" -->\n\n\`\`\`\`powershell\n  echo "{{rb:HOST}} 中文🙂"  \n\n\`\`\`\`\n\n- 检查结果\n- 记录异常\n\n<!-- /runbook:step -->\n\n| 字段 | 值 |\n| --- | --- |\n| 未知结构 | 保留 |\n`;
const schema = getSchema([StarterKit.configure({ document: false, codeBlock: false, trailingNode: false }), ...visualNodeExtensions]);
function all(doc: JSONContent, type: string): JSONContent[] { return [...(doc.type === type ? [doc] : []), ...(doc.content?.flatMap((node) => all(node, type)) ?? [])]; }
function editText(doc: JSONContent, from: string, to: string): void {
  const node = all(doc, 'text').find((entry) => entry.text === from);
  expect(node, `missing text ${from}`).toBeTruthy(); node!.text = to;
}
function pmRoundTrip(doc: JSONContent): JSONContent { return schema.nodeFromJSON(doc).toJSON(); }

describe('visual Markdown projection', () => {
  it.each(['', ' ', '\r\n\r\n', '# 标题\n正文\n', source, source.replace(/\n/g, '\r\n')])('preserves untouched input including schema default attributes: %s', (markdown) => {
    expect(serializeVisualDocument(pmRoundTrip(parseVisualDocument(markdown)))).toBe(markdown);
  });

  it('exposes steps, exact commands, variables and unsupported blocks', () => {
    const doc = parseVisualDocument(source);
    expect(all(doc, 'runbookStep')[0]!.attrs!.stepId).toBe(stepId);
    expect(all(doc, 'runbookCommand')[0]!.attrs).toMatchObject({ commandId, language: 'powershell', text: '  echo "{{rb:HOST}} 中文🙂"  \n' });
    expect(all(doc, 'runbookVariable')).toHaveLength(1);
    expect(all(doc, 'rawMarkdown')[0]!.attrs!.raw).toContain('| 未知结构 | 保留 |');
    expect(getVisualParameters(doc)).toEqual({ HOST: 'staging', PATH: 'C:/更新' });
  });

  it.each(['\n', '\r\n'])('edits one paragraph without changing command, metadata, unknown blocks or identities (%j)', (eol) => {
    const original = source.replace(/\n/g, eol), doc = parseVisualDocument(original);
    editText(doc, '执行前确认磁盘空间。', '执行前确认备份目录。');
    expect(serializeVisualDocument(pmRoundTrip(doc))).toBe(original.replace('执行前确认磁盘空间。', '执行前确认备份目录。'));
  });

  it('preserves unmarked code and marker-looking literals when another paragraph changes', () => {
    const input = '说明\r\n\r\n~~~text\r\n<!-- runbook:step id="not-a-step" -->\r\n  raw  \r\n\r\n~~~\r\n';
    const doc = parseVisualDocument(input);
    expect(all(doc, 'runbookCode')[0]!.attrs!.text).toBe('<!-- runbook:step id="not-a-step" -->\r\n  raw  \r\n');
    editText(doc, '说明', '新的说明');
    expect(serializeVisualDocument(doc)).toBe(input.replace('说明', '新的说明'));
  });

  it('adds variable definitions and inline tokens without losing existing command data', () => {
    let doc = parseVisualDocument(source);
    const paragraph = all(doc, 'paragraph').find((node) => node.content?.some((child) => child.text === '执行前确认磁盘空间。'))!;
    paragraph.content = [{ type: 'text', text: '检查 ' }, { type: 'runbookVariable', attrs: { name: 'DISK' } }];
    doc = setVisualParameter(doc, 'DISK', '<C:> & "磁盘"');
    const result = serializeVisualDocument(doc), reparsed = parseVisualDocument(result);
    expect(result).toContain('检查 {{rb:DISK}}');
    expect(getVisualParameters(reparsed).DISK).toBe('<C:> & "磁盘"');
    expect(all(reparsed, 'runbookCommand')[0]!.attrs!.text).toBe(all(doc, 'runbookCommand')[0]!.attrs!.text);
  });

  it('renders variable tokens inside inline code using native replacement semantics', () => {
    const input = `${head}\n\n<!-- runbook:parameters {"HOST":"staging"} -->\n\n使用 \`{{rb:HOST}}\` 检查。`;
    const doc = parseVisualDocument(input);
    expect(all(doc, 'runbookVariable')[0]!.marks).toEqual([{ type: 'code' }]);
    editText(doc, ' 检查。', ' 连接。');
    expect(serializeVisualDocument(doc)).toContain('使用 `{{rb:HOST}}` 连接。');
  });

  it('new commands preserve user text and pick a safe fence delimiter', () => {
    const doc = parseVisualDocument(source), command = all(doc, 'runbookCommand')[0]!;
    command.attrs!.text = '  echo ``` 中文\r\n\r\n';
    const result = parseVisualDocument(serializeVisualDocument(doc));
    expect(all(result, 'runbookCommand')[0]!.attrs).toMatchObject({ commandId, text: '  echo ``` 中文\r\n\r\n' });
  });

  it('copies a step with fresh identities and discards original marker strings', () => {
    const doc = parseVisualDocument(source), original = all(doc, 'runbookStep')[0]!, copy = cloneVisualNode(original);
    expect(copy.attrs!.stepId).not.toBe(stepId);
    expect(all(copy, 'runbookCommand')[0]!.attrs!.commandId).not.toBe(commandId);
    expect(copy.attrs!.visualSource).toBeUndefined();
    doc.content!.push(copy);
    const result = serializeVisualDocument(doc), reparsed = parseVisualDocument(result);
    expect(all(reparsed, 'runbookStep')).toHaveLength(2);
    expect(all(reparsed, 'runbookCommand').map((node) => node.attrs!.text)).toEqual(Array(2).fill('  echo "{{rb:HOST}} 中文🙂"  \n'));
  });

  it('preserves block boundaries when the original first paragraph moves to the end', () => {
    const doc = parseVisualDocument('第一段\n\n第二段');
    doc.content!.push(doc.content!.shift()!);
    const reparsed = parseVisualDocument(serializeVisualDocument(doc));
    expect(all(reparsed, 'paragraph').map((node) => node.content![0]!.text)).toEqual(['第二段', '第一段']);
  });

  it('keeps header and first block separate when the metadata anchor is deleted', () => {
    const doc = parseVisualDocument(`${head}\n\n第一段\n\n第二段`);
    doc.content!.shift();
    doc.content!.unshift({ type: 'paragraph', content: [{ type: 'text', text: '新增段落' }] });
    const result = serializeVisualDocument(doc);
    expect(result).toContain(`${head}\n\n新增段落`);
    expect(all(parseVisualDocument(result), 'paragraph')).toHaveLength(2);
  });

  it('emits metadata once when Enter inherits the first paragraph preservation attributes', () => {
    const doc = parseVisualDocument(`${head}\n\n第一段第二段`), first = doc.content![0]!;
    const second = structuredClone(first);
    first.content = [{ type: 'text', text: '第一段' }];
    second.content = [{ type: 'text', text: '第二段' }];
    doc.content!.push(second);
    const result = serializeVisualDocument(doc);
    expect(result.match(/runbook:document/g)).toHaveLength(1);
    expect(all(parseVisualDocument(result), 'paragraph')).toHaveLength(2);
  });

  it('inserts a new step before the original metadata anchor without merging markers', () => {
    const doc = parseVisualDocument(source);
    doc.content!.unshift(cloneVisualNode(all(doc, 'runbookStep')[0]!));
    const result = serializeVisualDocument(doc), parsed = parseVisualDocument(result);
    expect(all(parsed, 'runbookStep')).toHaveLength(2);
    expect(getVisualParameters(parsed).HOST).toBe('staging');
    expect(all(parsed, 'runbookCommand')[1]!.attrs!.text).toBe('  echo "{{rb:HOST}} 中文🙂"  \n');
  });

  it('supports new documents with step and command nodes', () => {
    const doc: JSONContent = { type: 'doc', content: [{ type: 'runbookStep', attrs: { stepId }, content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '新步骤' }] }, { type: 'runbookCommand', attrs: { commandId, text: '  echo ok  ', language: 'powershell' } }] }] };
    const result = serializeVisualDocument(doc);
    expect(result.startsWith(head)).toBe(true);
    expect(all(parseVisualDocument(result), 'runbookCommand')[0]!.attrs!.text).toBe('  echo ok  ');
  });

  it('rejects invalid nested moves before reusing an otherwise unchanged step', () => {
    const doc = parseVisualDocument(source), step = all(doc, 'runbookStep')[0]!;
    step.content!.push(cloneVisualNode(step));
    expect(() => serializeVisualDocument(doc)).toThrow('步骤只能放在文档顶层');
  });

  const wrappers: Array<[string, (node: JSONContent) => JSONContent]> = [
    ['blockquote', (node) => ({ type: 'blockquote', content: [node] })],
    ['list', (node) => ({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }, node] }] })],
  ];
  const customBlocks: Array<[string, () => JSONContent]> = [
    ['step', () => all(parseVisualDocument(source), 'runbookStep')[0]!],
    ['command', () => all(parseVisualDocument(source), 'runbookCommand')[0]!],
    ['code', () => ({ type: 'runbookCode', attrs: { language: 'sh', text: '  keep\r\n' } })],
    ['raw', () => ({ type: 'rawMarkdown', attrs: { raw: '| keep |\n| --- |' } })],
  ];
  it.each(wrappers.flatMap(([wrapperName, wrap]) => customBlocks.map(([nodeName, makeNode]) => ({ title: `${wrapperName}/${nodeName}`, wrap, makeNode }))))('rejects $title without letting MarkdownManager discard it', ({ wrap, makeNode }) => {
    const doc = parseVisualDocument(source), node = makeNode();
    doc.content = [wrap(node)];
    const before = structuredClone(doc);
    expect(() => validateVisualDocumentStructure(doc)).toThrow();
    expect(() => serializeVisualDocument(doc)).toThrow();
    expect(doc).toEqual(before);
  });

  it('allows inline variables inside ordinary quotes and lists', () => {
    const variable = { type: 'runbookVariable', attrs: { name: 'HOST' } };
    const doc = setVisualParameter({ type: 'doc', content: [
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '核对 ' }, variable] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '连接 ' }, variable] }] }] },
    ] }, 'HOST', 'staging');
    expect(() => validateVisualDocumentStructure(doc)).not.toThrow();
    const result = serializeVisualDocument(doc), reparsed = parseVisualDocument(result);
    expect(all(reparsed, 'runbookVariable')).toHaveLength(2);
    expect(getVisualParameters(reparsed).HOST).toBe('staging');
  });

  it.each([`${head}\n\n<!-- runbook:step id="${stepId}" -->\n\n说明`, `${head}\n\n<!-- runbook:command id="${commandId}" -->\n\n\`\`\`sh\nx\n\`\`\``, '<!-- runbook:document version="999" -->'])('rejects invalid source without repairing or dropping it: %s', (input) => {
    expect(() => parseVisualDocument(input)).toThrow();
  });
});
