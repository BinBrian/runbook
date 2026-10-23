import type { Parameter } from './types';

export interface VariableClipboardData { html: string; text: string }
export type VariableClipboardReference = { kind: 'none' } | { kind: 'invalid' } | { kind: 'reference'; parameterId: string };
const marker = 'data-runbook-variable-ref';
const reservedIds = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
function validId(id: string) { return /^[A-Za-z0-9_-]{1,128}$/.test(id) && !reservedIds.test(id); }
function escapeHtml(text: string) { return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }

/** The plain fallback is for reading in other apps; it is never a binding syntax. */
export function variableClipboardData(parameter: Pick<Parameter, 'id' | 'name'>): VariableClipboardData {
  if (!validId(parameter.id) || !parameter.name.trim() || parameter.name.includes('\0') || new TextEncoder().encode(parameter.name).length > 1024) throw new Error('变量定义无效，请先保存后再复制。');
  return { html: `<span ${marker}="1" data-parameter-id="${parameter.id}">${escapeHtml(parameter.name)}</span>`, text: `{{${parameter.name}}}` };
}

/** Recognize our single reference only. External HTML is never inserted. */
export function readVariableClipboard(html: string): VariableClipboardReference {
  if (!/<[^>]*\bdata-runbook-variable-ref\b/i.test(html)) return { kind: 'none' };
  if (html.length > 65536 || html.includes('\0')) return { kind: 'invalid' };
  let fragment = html.trim();
  const boundaries = [...fragment.matchAll(/<!--\s*(StartFragment|EndFragment)\s*-->/gi)];
  if (boundaries.length) {
    if (boundaries.length !== 2 || boundaries[0][1].toLowerCase() !== 'startfragment' || boundaries[1][1].toLowerCase() !== 'endfragment') return { kind: 'invalid' };
    fragment = fragment.slice(boundaries[0].index! + boundaries[0][0].length, boundaries[1].index).trim();
  } else {
    const wrapped = /^(?:<!doctype\s+html>\s*)?<html(?:\s[^<>]*)?>\s*(?:<head>[\s\S]*?<\/head>\s*)?<body(?:\s[^<>]*)?>([\s\S]*)<\/body>\s*<\/html>$/i.exec(fragment);
    if (wrapped) fragment = wrapped[1].trim();
    fragment = fragment.replace(/^<meta\s+charset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)\s*\/?>(?:\s*)/i, '');
  }
  const span = /^<span((?:\s+[A-Za-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*>[^<>]*<\/span>$/i.exec(fragment);
  if (!span) return { kind: 'invalid' };
  const attributes = new Map<string, string>();
  for (const attribute of span[1].matchAll(/([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = attribute[1].toLowerCase();
    if (attributes.has(key)) return { kind: 'invalid' };
    attributes.set(key, attribute[2] ?? attribute[3]);
  }
  const parameterId = attributes.get('data-parameter-id');
  return attributes.size === 2 && attributes.get(marker) === '1' && parameterId && validId(parameterId)
    ? { kind: 'reference', parameterId } : { kind: 'invalid' };
}

export function clipboardParameter(parameterId: string, parameters: Parameter[], ownerId?: string, groupId?: string, allowGlobal = true): Parameter | undefined {
  const parameter = parameters.find(item => item.id === parameterId);
  return parameter && (!parameter.ownerId ? allowGlobal : parameter.ownerId === ownerId || parameter.ownerId === groupId) ? parameter : undefined;
}
