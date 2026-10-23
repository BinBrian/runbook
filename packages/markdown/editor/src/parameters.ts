import { GFM, parser } from '@lezer/markdown';

export type TextSelection = { from: number; to: number };
export const parameterNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const parameterMarker = /^<!--\s*runbook:parameters\s+([\s\S]*?)\s*-->$/;
const semanticMarker = /^<!--\s*\/?runbook:(?:document|parameters|step|command)\b/;

function syntax(source: string) { return parser.configure(GFM).parse(source); }
function topBlocks(source: string) {
  const entries: Array<TextSelection & { name: string; text: string }> = [];
  for (let node = syntax(source).topNode.firstChild; node; node = node.nextSibling) entries.push({ from: node.from, to: node.to, name: node.name, text: source.slice(node.from, node.to) });
  return entries;
}
function definitions(source: string) {
  const markers = topBlocks(source).filter((block) => block.name === 'CommentBlock' && /^<!--\s*runbook:parameters\b/.test(block.text.trim()));
  if (markers.length > 1) throw new Error('变量定义标记重复，请先修复文档。');
  const marker = markers[0];
  if (!marker) return { marker: undefined, values: {} as Record<string, string> };
  const match = marker.text.trim().match(parameterMarker);
  if (!match) throw new Error('变量定义标记不完整，请先修复文档。');
  let decoded: unknown;
  try { decoded = JSON.parse(match[1]!); } catch { throw new Error('变量默认值不是有效的 JSON，请先修复文档。'); }
  if (!decoded || Array.isArray(decoded) || typeof decoded !== 'object') throw new Error('变量定义必须是名称到默认文本的对象。');
  for (const [name, value] of Object.entries(decoded)) {
    if (!parameterNamePattern.test(name) || typeof value !== 'string') throw new Error('变量名称或默认值格式不正确，请先修复文档。');
  }
  return { marker, values: decoded as Record<string, string> };
}

/** Only editor assistance: native parsing and resolving remain authoritative. */
export function parameterDefaults(source: string): Record<string, string> { return definitions(source).values; }

export function validateVariableSelection(source: string, selection: TextSelection): string {
  const { from, to } = selection;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > source.length || from >= to) throw new Error('请先选中要转为变量的文本。');
  const splitsCharacter = (at: number) => at > 0 && at < source.length && ((/[\uD800-\uDBFF]/.test(source[at - 1]!) && /[\uDC00-\uDFFF]/.test(source[at]!)) || (source[at - 1] === '\r' && source[at] === '\n'));
  if (splitsCharacter(from) || splitsCharacter(to)) throw new Error('选区切开了字符或换行，请重新选择完整文本。');
  const selected = source.slice(from, to);
  if (!selected.trim()) throw new Error('不能把空白选区转换为变量。');
  const intersects = (range: TextSelection) => range.from < to && range.to > from;
  if (topBlocks(source).some((block) => block.name === 'CommentBlock' && semanticMarker.test(block.text.trim()) && intersects(block))) throw new Error('选区包含 Runbook 标记，请只选择正文或指令中的文本。');
  for (const match of source.matchAll(/\{\{rb:[^{}]*\}\}/g)) {
    if (intersects({ from: match.index!, to: match.index! + match[0].length })) throw new Error('选区与已有变量占位符重叠，请通过参数面板修改它。');
  }
  let intersectsSyntax = false;
  syntax(source).iterate({ enter(node) {
    if (['CodeMark', 'CodeInfo', 'HeaderMark', 'QuoteMark', 'ListMark'].includes(node.name) && intersects(node)) intersectsSyntax = true;
  } });
  if (intersectsSyntax) throw new Error('请不要选择 Markdown 围栏或结构符号，只选择需要替换的正文。');
  return selected;
}

function writeDefinitions(source: string, values: Record<string, string>): string {
  const { marker } = definitions(source);
  // Unicode escapes keep arbitrary selected text inside the one HTML comment.
  const json = JSON.stringify(values).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const line = `<!-- runbook:parameters ${json} -->`;
  if (marker) return source.slice(0, marker.from) + line + source.slice(marker.to);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const header = topBlocks(source).find((block) => block.name === 'CommentBlock' && /^<!--\s*runbook:document\b/.test(block.text.trim()));
  if (header) return source.slice(0, header.to) + newline + newline + line + source.slice(header.to);
  return `<!-- runbook:document version="1" -->${newline}${newline}${line}${newline}${newline}${source}`;
}

export function setParameterDefault(source: string, name: string, value: string): string {
  if (!parameterNamePattern.test(name)) throw new Error('变量名以字母或下划线开头，仅包含字母、数字、下划线，最长 64 个字符。');
  const values = { ...definitions(source).values, [name]: value };
  return writeDefinitions(source, values);
}

export function convertSelectionToVariable(source: string, selection: TextSelection, name: string, defaultValue?: string): string {
  const selected = validateVariableSelection(source, selection);
  if (!parameterNamePattern.test(name)) throw new Error('变量名以字母或下划线开头，仅包含字母、数字、下划线，最长 64 个字符。');
  const values = { ...definitions(source).values };
  if (!Object.hasOwn(values, name)) Object.defineProperty(values, name, { value: defaultValue ?? selected, enumerable: true, configurable: true, writable: true });
  const replaced = source.slice(0, selection.from) + `{{rb:${name}}}` + source.slice(selection.to);
  return writeDefinitions(replaced, values);
}
