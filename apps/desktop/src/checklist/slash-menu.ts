import type { Parameter } from './types';

export const VARIABLE_QUERY_TRIGGER = '{{';
export interface VariableQueryMatch { start: number; query: string }

/** UTF-16 offsets deliberately match native DOM Range text offsets. Detection
 * here is lexical; the editor separately requires an actual typing event. */
export function parseVariablePrefix(prefix: string): VariableQueryMatch | null {
  const start = prefix.lastIndexOf(VARIABLE_QUERY_TRIGGER);
  if (start < 0 || prefix[start - 1] === '{') return null;
  const query = prefix.slice(start + VARIABLE_QUERY_TRIGGER.length);
  return /[\s/\\'"`()\[\]{}\uFFFC]/u.test(query) ? null : { start, query };
}

/** Only names are searched; descriptions are presentation, never identity. */
export function filterSlashParameters(parameters: Parameter[], query: string): Parameter[] {
  const search = query.toLocaleLowerCase();
  return parameters.filter(parameter => parameter.name.toLocaleLowerCase().includes(search));
}

export interface VariableQueryScope { ownerId?: string; groupId?: string; allowGlobal?: boolean }
export type VariableQueryOption = { kind: 'existing'; parameter: Parameter } | { kind: 'create'; name: string; ownerId?: string };

/** A quick-created definition must be valid before the editor inserts its ID. */
export function quickVariableName(query: string): string | null {
  const name = query.trim();
  if (!name || /[\0\r\n{}()\[\]]/u.test(query) || new TextEncoder().encode(name).length > 1024) return null;
  return name;
}

export function variableQueryOptions(parameters: Parameter[], query: string, scope: VariableQueryScope): VariableQueryOption[] {
  const visible = parameters.filter(parameter => !parameter.ownerId ? scope.allowGlobal !== false : parameter.ownerId === scope.ownerId || parameter.ownerId === scope.groupId);
  const options: VariableQueryOption[] = filterSlashParameters(visible, query).map(parameter => ({ kind: 'existing', parameter }));
  const name = quickVariableName(query);
  if (!name || visible.some(parameter => parameter.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return options;
  // Work records default to the whole flow; favorites remain self-contained.
  const ownerId = scope.allowGlobal === false ? scope.groupId ?? scope.ownerId : undefined;
  if (scope.allowGlobal === false && !ownerId) return options;
  options.push({ kind: 'create', name, ...(ownerId ? { ownerId } : {}) });
  return options;
}

export interface VariableQueryRange { range: Range; caret: Range; query: string }
function editablePrefix(element: HTMLDivElement, caret: Range) {
  let text = '';
  const segments: { node: Text; start: number; length: number }[] = [];
  function walk(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node.textContent ?? '').slice(0, node === caret.startContainer ? caret.startOffset : undefined);
      segments.push({ node: node as Text, start: text.length, length: value.length });
      text += value;
      return node === caret.startContainer;
    }
    if (!(node instanceof HTMLElement)) return false;
    if (node.dataset.parameterId) { text += '\uFFFC'; return false; }
    // Native Range.toString() omits BR and block boundaries. Match the
    // editor's supported DOM newline semantics without rewriting its nodes.
    if (node !== element && ['DIV', 'P'].includes(node.tagName) && text && !text.endsWith('\n')) text += '\n';
    if (node === caret.startContainer) {
      for (const child of [...node.childNodes].slice(0, caret.startOffset)) walk(child);
      return true;
    }
    if (node.tagName === 'BR') { text += '\n'; return false; }
    for (const child of node.childNodes) if (walk(child)) return true;
    return false;
  }
  walk(element);
  return { text, segments };
}
export function readVariableRange(element: HTMLDivElement, caret: Range): VariableQueryRange | null {
  if (!element.isConnected || !element.isContentEditable || !caret.collapsed || !element.contains(caret.startContainer)) return null;
  const prefix = editablePrefix(element, caret);
  const match = parseVariablePrefix(prefix.text);
  if (!match) return null;
  for (const segment of prefix.segments) {
    if (match.start < segment.start || match.start >= segment.start + segment.length) continue;
    const range = document.createRange(); range.setStart(segment.node, match.start - segment.start); range.setEnd(caret.startContainer, caret.startOffset);
    const atToken = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('[data-parameter-id]');
    if (atToken(range.startContainer) || atToken(range.endContainer) || [...element.querySelectorAll('[data-parameter-id]')].some(token => range.intersectsNode(token))) return null;
    return { range, caret: caret.cloneRange(), query: match.query };
  }
  return null;
}

export interface SlashPosition { left: number; top: number; width: number; maxHeight: number }
/** The caret and the popup share only the editor's visible workspace. */
export function slashMenuPosition(element: HTMLDivElement, caret: Range, menu: HTMLElement | null): SlashPosition | null {
  const rects = [...caret.getClientRects()];
  let caretRect = rects.find(rect => rect.height > 0) ?? caret.getBoundingClientRect();
  if (!caretRect.height && caret.startContainer.nodeType === Node.TEXT_NODE && caret.startOffset > 0) {
    const preceding = caret.cloneRange(); preceding.setStart(caret.startContainer, caret.startOffset - 1); caretRect = preceding.getBoundingClientRect();
  }
  if (!caretRect.height) return null;
  const bounds = { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
    if (style.overflowX !== 'visible') { bounds.left = Math.max(bounds.left, rect.left + ancestor.clientLeft); bounds.right = Math.min(bounds.right, rect.left + ancestor.clientLeft + ancestor.clientWidth); }
    if (style.overflowY !== 'visible') { bounds.top = Math.max(bounds.top, rect.top + ancestor.clientTop); bounds.bottom = Math.min(bounds.bottom, rect.top + ancestor.clientTop + ancestor.clientHeight); }
  }
  const field = element.getBoundingClientRect(), visible = { left: Math.max(bounds.left, field.left + element.clientLeft), right: Math.min(bounds.right, field.left + element.clientLeft + element.clientWidth), top: Math.max(bounds.top, field.top + element.clientTop), bottom: Math.min(bounds.bottom, field.top + element.clientTop + element.clientHeight) };
  if (caretRect.right < visible.left || caretRect.left > visible.right || caretRect.bottom <= visible.top || caretRect.top >= visible.bottom || bounds.right - bounds.left < 80 || bounds.bottom - bounds.top < 60) return null;
  const width = Math.min(320, bounds.right - bounds.left - 12), maxHeight = Math.min(300, bounds.bottom - bounds.top - 12), height = Math.min(menu?.scrollHeight || 220, maxHeight);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
  const below = caretRect.bottom + 6;
  return { left: Math.round(clamp(caretRect.left, bounds.left + 4, bounds.right - width - 4)), top: Math.round(clamp(below + height <= bounds.bottom ? below : caretRect.top - height - 6, bounds.top + 4, bounds.bottom - height - 4)), width, maxHeight };
}
