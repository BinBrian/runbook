import { Extension, Node, mergeAttributes } from '@tiptap/core';

// These attributes belong to the editing projection, never to HTML or storage.
const hidden = (value: unknown = null) => ({ default: value, rendered: false });

export const VisualDocument = Node.create({
  name: 'doc', topNode: true, content: 'block+',
  addAttributes: () => ({ visualMeta: hidden() }),
});

export const RunbookStep = Node.create({
  name: 'runbookStep', group: 'block', content: 'block+', defining: true, isolating: true,
  addAttributes: () => ({ stepId: hidden() }),
  parseHTML: () => [],
  renderHTML: ({ HTMLAttributes }) => ['section', mergeAttributes(HTMLAttributes, { 'data-runbook-step': '' }), 0],
});

export const RunbookCommand = Node.create({
  name: 'runbookCommand', group: 'block', atom: true, defining: true, isolating: true,
  addAttributes: () => ({ commandId: hidden(), language: hidden('powershell'), text: hidden('') }),
  parseHTML: () => [],
  renderHTML: ({ node, HTMLAttributes }) => ['pre', mergeAttributes(HTMLAttributes, { 'data-runbook-command': '' }), ['code', {}, node.attrs.text]],
});

export const RunbookCode = Node.create({
  name: 'runbookCode', group: 'block', atom: true, defining: true, isolating: true,
  addAttributes: () => ({ language: hidden(''), text: hidden('') }),
  parseHTML: () => [],
  renderHTML: ({ node, HTMLAttributes }) => ['pre', mergeAttributes(HTMLAttributes, { 'data-runbook-code': '' }), ['code', {}, node.attrs.text]],
});

export const RunbookVariable = Node.create({
  name: 'runbookVariable', group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes: () => ({ name: hidden('') }),
  parseHTML: () => [],
  renderHTML: ({ node, HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { 'data-runbook-variable': '' }), node.attrs.name],
  renderText: ({ node }) => `{{rb:${node.attrs.name}}}`,
  renderMarkdown: (node) => `{{rb:${node.attrs?.name ?? ''}}}`,
});

export const RawMarkdown = Node.create({
  name: 'rawMarkdown', group: 'block', atom: true, defining: true, isolating: true,
  addAttributes: () => ({ raw: hidden('') }),
  parseHTML: () => [],
  renderHTML: ({ node, HTMLAttributes }) => ['pre', mergeAttributes(HTMLAttributes, { 'data-raw-markdown': '' }), node.attrs.raw],
});

export const VisualPreservation = Extension.create({
  name: 'visualPreservation',
  addGlobalAttributes: () => [{
    types: ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'horizontalRule', 'runbookStep', 'runbookCommand', 'runbookCode', 'rawMarkdown'],
    attributes: { visualSource: hidden() },
  }],
});

export const visualNodeExtensions = [VisualDocument, RunbookStep, RunbookCommand, RunbookCode, RunbookVariable, RawMarkdown, VisualPreservation];
