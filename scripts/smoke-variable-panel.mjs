// node scripts/check-desktop.mjs scripts/smoke-variable-panel.mjs
// Only the harness-owned database is used. Commands are edited as inert text;
// this driver never executes them or touches the system clipboard.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && path.isAbsolute(directory));
assert.equal(path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''), path.resolve(directory));
const actualDirectory = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actualDirectory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actualDirectory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actualDirectory}`));
assert.ok(process.env.RUNBOOK_CDP_URL);
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const checks = [], pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action });
const workspace = () => native('checklist_load');
const templateId = 'qa-variable-panel-template', runId = 'qa-variable-panel-run';
const template = async () => (await workspace()).templates.find(item => item.id === templateId);
const run = async () => (await workspace()).instances.find(item => item.id === runId);
const step = id => page.locator(`[data-step-id="${id}"]`);
const group = id => page.locator(`[data-group-id="${id}"]`).first();
const panel = () => page.getByRole('complementary', { name: '变量面板', exact: true });
const row = id => panel().locator(`[data-variable-id="${id}"]`);
const selectionToolbar = () => page.getByRole('toolbar', { name: '选区变量操作', exact: true });
const inline = (source, label) => source.locator(`[data-inline-field="${label}"]`);
const ref = id => ({ parameterId: id });
const longLiteral = Array.from({ length: 85 }, (_, index) => `# QA plain line ${String(index + 1).padStart(3, '0')} · 仅用于长命令编辑与滚动\n`).join('')
  + '\nSELECT_RANGE SELECT_RANGE\ncaret-anchor\nGLOBAL_SLOT\nNEW_LOCAL NEW_LOCAL\n';
const initialDocument = {
  groups: [{ id: 'variable-group-a', name: '玩家 A', description: 'A 组说明。' }, { id: 'variable-group-b', name: '玩家 B', description: 'B 组说明。' }],
  parameters: [
    { id: 'variable-env', name: '环境', description: '整个流程共用。', defaultValue: 'release' },
    { id: 'variable-player-a', ownerId: 'variable-group-a', name: '玩家 ID', description: '只属于玩家 A。', defaultValue: 'PLAYER-A' },
    { id: 'variable-note-a', ownerId: 'variable-a-first', name: '备注', description: '只属于 A 的第一步。', defaultValue: 'NOTE-A' },
    { id: 'variable-player-b', ownerId: 'variable-group-b', name: '玩家 ID', description: '只属于玩家 B。', defaultValue: 'PLAYER-B' },
    { id: 'variable-note-b', ownerId: 'variable-b-first', name: '备注', description: '只属于 B 的步骤。', defaultValue: 'NOTE-B' },
  ],
  steps: [
    { id: 'variable-empty', title: [''], description: [''], commands: [] },
    { id: 'variable-a-first', groupId: 'variable-group-a', title: ['A 玩家 ', ref('variable-player-a')], description: ['选择 TOKEN TOKEN，只操作当前选区。'], commands: [{ id: 'variable-command-a', text: [longLiteral, '\nvalues=', ref('variable-env'), '|', ref('variable-player-a'), '|', ref('variable-note-a')] }] },
    { id: 'variable-a-second', groupId: 'variable-group-a', title: ['A 后续核对'], description: ['后续步骤。'], commands: [{ id: 'variable-command-a-second', text: ['publishgame ', ref('variable-env')] }] },
    { id: 'variable-b-first', groupId: 'variable-group-b', title: ['B 玩家 ', ref('variable-player-b')], description: ['B 组正文，不得被 A 的旧选区改写。'], commands: [{ id: 'variable-command-b', text: ['transferserver ', ref('variable-env'), ' ', ref('variable-player-b'), ' ', ref('variable-note-b')] }] },
    { id: 'variable-end', title: ['结束核对'], description: [''], commands: [] },
  ],
};
const strings = parts => parts.filter(part => typeof part === 'string').join('');
const references = (parts, id) => parts.filter(part => typeof part !== 'string' && part.parameterId === id).length;
const command = document => document.steps.find(item => item.id === 'variable-a-first').commands[0].text;
async function settle() {
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeEnabled();
  await expect(page.locator('.save-state')).toContainText('已保存在本机');
}
async function saved(predicate) { await expect.poll(predicate).toBe(true); await settle(); }
async function reload() { await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor(); }
async function openTemplate() {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '模板' }).click();
  await page.locator(`[data-template-id="${templateId}"] .tile-open`).click();
  await expect(inline(page, '模板名称')).toBeVisible();
  await expect(page.locator('.workspace-scroll [data-parameter-scope], .workspace-scroll .parameter-definitions')).toHaveCount(0);
}
async function edit(source, label, entry = 'double') {
  const display = inline(source, label), textbox = source.getByRole('textbox', { name: label, exact: true });
  if (!await textbox.count()) {
    if (entry === 'double') await display.dblclick();
    else { await display.focus(); await display.press(entry); }
  }
  await expect(textbox).toBeVisible(); return textbox;
}
async function locate(id) {
  await page.locator(`[data-nav-step-id="${id}"]`).click();
  await expect(panel()).toHaveAttribute('data-variable-target-step-id', id);
}
async function selection(editor, literal, collapsed = false, atStart = false) {
  await editor.focus();
  await editor.evaluate(async (element, { literal, collapsed, atStart }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.parentElement.closest('[data-parameter-id]')) continue;
      const index = text.textContent.indexOf(literal);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(text, index + (collapsed && !atStart ? literal.length : 0)); range.setEnd(text, index + (collapsed && atStart ? 0 : literal.length));
      const current = window.getSelection(); current.removeAllRanges(); current.addRange(range);
      // A long command has its own scrollport. Make its actual selection visible
      // there before positioning the editor in the outer document scrollport.
      const bounds = range.getBoundingClientRect(), editorBounds = element.getBoundingClientRect();
      const editorTop = editorBounds.top + element.clientTop, editorBottom = editorTop + element.clientHeight;
      if (bounds.top < editorTop + 8) element.scrollTop += bounds.top - editorTop - 8;
      else if (bounds.bottom > editorBottom - 8) element.scrollTop += bounds.bottom - editorBottom + 8;
      const root = element.closest('.workspace-scroll');
      if (root) {
        const rootBounds = root.getBoundingClientRect(), visibleEditor = element.getBoundingClientRect();
        root.scrollTo({ top: root.scrollTop + visibleEditor.top - rootBounds.top - root.clientTop - 36, behavior: 'instant' });
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Finish selection after the two nested scrollports have reached the
      // text, as a real drag's mouseup would; scrolling may dismiss old tools.
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return;
    }
    throw new Error(`Plain-text selection not found: ${literal}`);
  }, { literal, collapsed, atStart });
}
async function panelScopes(stepId, playerId, noteId) {
  await expect(panel()).toBeVisible(); await expect(panel()).toHaveAttribute('data-variable-target-step-id', stepId);
  for (const scope of ['global', 'group', 'step']) await expect(panel().locator(`[data-variable-scope="${scope}"]`)).toBeVisible();
  await expect(panel().locator('[data-variable-scope="global"] [data-variable-id="variable-env"]')).toHaveCount(1);
  await expect(panel().locator(`[data-variable-scope="group"] [data-variable-id="${playerId}"]`)).toHaveCount(1);
  await expect(panel().locator(`[data-variable-scope="step"] [data-variable-id="${noteId}"]`)).toHaveCount(1);
}
async function disabledReuse() {
  await expect(panel().getByRole('button', { name: /^复用变量 / })).toHaveCount(0);
  await expect(selectionToolbar()).toHaveCount(0);
  await expect(page.locator('[data-variable-popover]')).toHaveCount(0);
}
async function useSelectedVariable(id) {
  await selectionToolbar().getByRole('button', { name: '使用变量', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '使用变量', exact: true });
  await expect(dialog).toBeVisible(); await dialog.locator(`.token-choice[data-parameter-id="${id}"]`).click();
  await expect(dialog).toHaveCount(0);
}
async function captureSelectionToolbar(label, editor) {
  const toolbar = selectionToolbar(); await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button')).toHaveCount(2);
  await expect(toolbar.getByRole('button', { name: '使用变量', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '新增变量', exact: true })).toBeVisible();
  const geometry = await toolbar.evaluate(element => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return { viewport: { width: innerWidth, height: innerHeight }, workspace: rect(document.querySelector('.workspace-scroll')), toolbar: rect(element), buttons: [...element.querySelectorAll('button')].map(rect) };
  });
  geometry.selection = await editor.evaluate(element => {
    const selected = window.getSelection(), range = selected?.rangeCount ? selected.getRangeAt(0) : null;
    if (!range) return null;
    const r = range.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      insideEditor: element.contains(range.startContainer) && element.contains(range.endContainer), collapsed: range.collapsed };
  });
  await writeFile(`.artifacts/variable-selection-${label}-geometry.json`, JSON.stringify(geometry, null, 2), 'utf8');
  await page.screenshot({ path: `.artifacts/variable-selection-${label}.png` });
  const inside = bounds => bounds.left >= 0 && bounds.top >= 0 && bounds.right <= geometry.viewport.width + 1 && bounds.bottom <= geometry.viewport.height + 1;
  assert.ok(inside(geometry.toolbar) && geometry.buttons.every(inside), 'Selection toolbar and both actual actions must fit the viewport');
  assert.ok(geometry.toolbar.left >= geometry.workspace.left - 1 && geometry.toolbar.right <= geometry.workspace.right + 1 && geometry.toolbar.top >= geometry.workspace.top - 1 && geometry.toolbar.bottom <= geometry.workspace.bottom + 1, 'Floating selection actions must remain inside the document workspace');
  assert.ok(geometry.selection?.insideEditor && !geometry.selection.collapsed && geometry.selection.height > 0 && inside(geometry.selection), 'The toolbar must belong to a real visible nonempty selection in this editor');
  const horizontalGap = Math.max(0, geometry.selection.left - geometry.toolbar.right, geometry.toolbar.left - geometry.selection.right);
  const verticalGap = Math.max(0, geometry.selection.top - geometry.toolbar.bottom, geometry.toolbar.top - geometry.selection.bottom);
  assert.ok(horizontalGap <= 100 && verticalGap <= 100, 'The toolbar must follow its real selection rather than staying at the editor or page top');
  return geometry;
}
async function capture(label, editor) {
  const geometry = await panel().evaluate(element => {
    const bounds = element.getBoundingClientRect(), root = document.querySelector('.workspace-scroll'), app = document.querySelector('.checklist-app').getBoundingClientRect();
    const workspaceBounds = root.getBoundingClientRect();
    return { panel: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height },
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, documentWidth: document.documentElement.scrollWidth },
      workspace: { left: workspaceBounds.left + root.clientLeft, top: workspaceBounds.top + root.clientTop, right: workspaceBounds.left + root.clientLeft + root.clientWidth, bottom: workspaceBounds.top + root.clientTop + root.clientHeight,
        scrollTop: root.scrollTop, clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight }, app: { top: app.top } };
  });
  if (editor) geometry.editing = await editor.evaluate(element => {
    const rect = bounds => ({ left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height });
    const bounds = element.getBoundingClientRect(), selected = window.getSelection(), range = selected?.rangeCount ? selected.getRangeAt(0) : null;
    return { editor: { ...rect(bounds), scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      viewport: { left: bounds.left + element.clientLeft, top: bounds.top + element.clientTop, right: bounds.left + element.clientLeft + element.clientWidth, bottom: bounds.top + element.clientTop + element.clientHeight } },
      selection: range ? { ...rect(range.getBoundingClientRect()), collapsed: range.collapsed, insideEditor: element.contains(range.startContainer) && element.contains(range.endContainer) } : null };
  });
  await writeFile(`.artifacts/variable-panel-${label}-geometry.json`, JSON.stringify(geometry, null, 2), 'utf8');
  await page.screenshot({ path: `.artifacts/variable-panel-${label}.png` });
  assert.equal(geometry.viewport.scrollY, 0); assert.equal(geometry.app.top, 0);
  assert.ok(geometry.panel.left >= 0 && geometry.panel.top >= 0 && geometry.panel.right <= geometry.viewport.width + 1 && geometry.panel.bottom <= geometry.viewport.height + 1);
  assert.ok(geometry.viewport.documentWidth <= geometry.viewport.width + 1, 'The outer page must not overflow horizontally');
  assert.ok(geometry.workspace.scrollWidth <= geometry.workspace.clientWidth + 1, 'Long command editing must remain inside the document viewport');
  if (editor) {
    const { editor: field, selection: selected } = geometry.editing;
    const inside = (bounds, viewport) => bounds.left >= viewport.left - 1 && bounds.top >= viewport.top - 1 && bounds.right <= viewport.right + 1 && bounds.bottom <= viewport.bottom + 1;
    assert.ok(field.width > 0 && field.height > 0 && inside(field, geometry.workspace), 'The real long-command editor must be fully visible inside the workspace');
    assert.ok(selected?.insideEditor && selected.height > 0, 'The captured native selection must belong to the real long-command editor');
    assert.ok(inside(selected, field.viewport) && inside(selected, geometry.workspace), 'The native selection must be visible inside both editor and workspace scrollports');
  }
  return geometry;
}

try {
  await mkdir('.artifacts', { recursive: true });
  await page.setViewportSize({ width: 1360, height: 940 });
  await apply({ type: 'create_template', id: templateId, name: 'QA 变量面板与就地编辑', document: initialDocument });
  await reload(); await openTemplate();
  const beforePlaceholders = await workspace();
  for (const label of ['步骤标题', '操作说明']) {
    await expect(inline(step('variable-empty'), label)).toHaveAttribute('data-inline-empty', 'true');
    assert.ok((await inline(step('variable-empty'), label).textContent()).trim());
    await expect(step('variable-empty').getByRole('textbox', { name: label, exact: true })).toHaveCount(0);
  }
  assert.deepEqual(await workspace(), beforePlaceholders, 'Displaying gray placeholders must not save placeholder text');
  await disabledReuse();
  let editor = await edit(step('variable-empty'), '步骤标题');
  await editor.fill('双击写入的步骤标题'); await editor.press('Escape');
  await saved(async () => strings((await template()).document.steps[0].title) === '双击写入的步骤标题');
  editor = await edit(step('variable-empty'), '步骤标题', 'F2'); await editor.fill(''); await editor.press('Escape');
  await saved(async () => strings((await template()).document.steps[0].title) === '');
  await expect(inline(step('variable-empty'), '步骤标题')).toHaveAttribute('data-inline-empty', 'true');
  editor = await edit(step('variable-empty'), '操作说明', 'Enter');
  const keyboardDescription = '键盘进入的多行说明。\n第二行保持原样。';
  await editor.fill(keyboardDescription); await editor.press('Control+Enter');
  await expect(step('variable-empty').getByRole('textbox', { name: '操作说明', exact: true })).toHaveCount(0);
  await saved(async () => strings((await template()).document.steps[0].description) === keyboardDescription);
  editor = await edit(step('variable-empty'), '操作说明'); await editor.fill('');
  await inline(step('variable-a-first'), '步骤标题').click();
  await saved(async () => strings((await template()).document.steps[0].description) === '');
  assert.deepEqual((await template()).document.steps[0].title, ['']);
  assert.deepEqual((await template()).document.steps[0].description, ['']);
  checks.push('Empty title/description show non-persistent placeholders; double-click, F2 and Enter enter editing, Escape/blur/Ctrl+Enter end it, and exact empty or multiline content is saved without hints or extra newlines');

  editor = await edit(group('variable-group-a'), '步骤组名称');
  await editor.fill('玩家 A · 独立局部参数'); await editor.press('Enter');
  await saved(async () => (await template()).document.groups[0].name === '玩家 A · 独立局部参数');
  editor = await edit(group('variable-group-a'), '步骤组名称', 'F2'); await editor.fill(''); await editor.press('Enter');
  await saved(async () => (await template()).document.groups[0].name === '');
  await expect(inline(group('variable-group-a'), '步骤组名称')).toHaveAttribute('data-inline-empty', 'true');
  editor = await edit(group('variable-group-a'), '步骤组名称'); await editor.fill('玩家 A · 独立局部参数'); await editor.press('Escape');
  editor = await edit(group('variable-group-a'), '步骤组描述', 'F2');
  await editor.fill('组说明由键盘进入。\n原生保存两行。'); await editor.press('Control+Enter');
  await saved(async () => (await template()).document.groups[0].description === '组说明由键盘进入。\n原生保存两行。');
  editor = await edit(page, '模板名称'); await editor.fill('QA 固定变量面板与就地编辑'); await editor.press('Enter');
  await saved(async () => (await template()).name === 'QA 固定变量面板与就地编辑');
  checks.push('Document/group names and group descriptions share inline keyboard and mouse entry; an intentionally empty group name stays empty in native data rather than storing its placeholder');

  await locate('variable-a-first'); await panelScopes('variable-a-first', 'variable-player-a', 'variable-note-a');
  await expect(row('variable-player-b')).toHaveCount(0); await expect(row('variable-note-b')).toHaveCount(0);
  await expect(row('variable-player-a').locator('[data-variable-value]')).toHaveText('PLAYER-A');
  await disabledReuse();
  const longEditor = await edit(step('variable-a-first'), '命令 1');
  const beforeReuse = (await template()).document, beforeCommand = structuredClone(command(beforeReuse));
  await selection(longEditor, 'SELECT_RANGE');
  await expect(selectionToolbar()).toBeVisible();
  await expect(panel()).toContainText('命令 1');
  const firstGeometry = await capture('long-1360-before', longEditor);
  assert.ok(firstGeometry.workspace.scrollTop > 0);
  await captureSelectionToolbar('long-1360', longEditor);
  const beforeSelectionEscape = await workspace();
  await page.keyboard.press('Escape');
  await expect(selectionToolbar()).toHaveCount(0); await expect(page.locator('[data-variable-popover]')).toHaveCount(0);
  assert.deepEqual(await workspace(), beforeSelectionEscape);
  await selection(longEditor, 'SELECT_RANGE');
  await useSelectedVariable('variable-player-a');
  await saved(async () => references(command((await template()).document), 'variable-player-a') === 2);
  let changedCommand = command((await template()).document);
  assert.equal(strings(changedCommand), strings(beforeCommand).replace('SELECT_RANGE', ''));
  assert.equal(strings(changedCommand).split('SELECT_RANGE').length - 1, 1);
  assert.deepEqual((await template()).document.steps.find(item => item.id === 'variable-a-second'), beforeReuse.steps.find(item => item.id === 'variable-a-second'));
  const afterMouse = structuredClone(changedCommand);
  await selection(longEditor, 'caret-anchor', true, true);
  await longEditor.pressSequentially('{{备注');
  const caretSuggestions = page.getByRole('listbox', { name: '变量建议', exact: true });
  await expect(caretSuggestions.locator('[role="option"][data-parameter-id="variable-note-a"]')).toHaveAttribute('aria-selected', 'true');
  await longEditor.press('Enter');
  await saved(async () => references(command((await template()).document), 'variable-note-a') === 2);
  changedCommand = command((await template()).document);
  assert.equal(strings(changedCommand), strings(afterMouse), 'Collapsed-caret reuse must not delete text');
  const beforeGlobal = structuredClone(changedCommand);
  await selection(longEditor, 'GLOBAL_SLOT'); await useSelectedVariable('variable-env');
  await saved(async () => references(command((await template()).document), 'variable-env') === 2);
  assert.equal(strings(command((await template()).document)), strings(beforeGlobal).replace('GLOBAL_SLOT', ''));
  await selection(longEditor, 'caret-anchor', true);
  const afterGeometry = await capture('long-1360-after', longEditor);
  assert.equal(afterGeometry.panel.top, firstGeometry.panel.top);
  assert.equal(afterGeometry.panel.bottom, firstGeometry.panel.bottom);
  checks.push('The fixed panel exposes only global/A-group/A-step variables while editing a long command; mouse reuse replaces one selected occurrence, keyboard reuse inserts at the saved caret, and global reuse preserves every other literal and step');

  await page.setViewportSize({ width: 940, height: 640 });
  await selection(longEditor, 'caret-anchor', true);
  const smallGeometry = await capture('long-940', longEditor);
  assert.ok(smallGeometry.workspace.scrollTop > 0); await expect(panel()).toBeVisible();
  const beforeToolbarUse = (await template()).document;
  await selection(longEditor, 'SELECT_RANGE'); await captureSelectionToolbar('long-940', longEditor);
  await selectionToolbar().getByRole('button', { name: '使用变量', exact: true }).click();
  let selectionDialog = page.getByRole('dialog', { name: '使用变量', exact: true });
  await expect(selectionDialog).toBeVisible();
  await expect(selectionDialog.getByLabel('新变量名称', { exact: true })).toHaveCount(0);
  await expect(selectionDialog.getByRole('combobox', { name: '变量作用范围', exact: true })).toHaveCount(0);
  assert.deepEqual((await selectionDialog.locator('.token-choice').evaluateAll(elements => elements.map(element => element.dataset.parameterId))).sort(), ['variable-env', 'variable-note-a', 'variable-player-a'].sort());
  await selectionDialog.locator('.token-choice[data-parameter-id="variable-player-a"]').click();
  await saved(async () => references(command((await template()).document), 'variable-player-a') === 3);
  assert.equal(strings(command((await template()).document)), strings(command(beforeToolbarUse)).replace('SELECT_RANGE', ''));
  assert.deepEqual((await template()).document.parameters, beforeToolbarUse.parameters);
  const beforeToolbarCreate = (await template()).document;
  await selection(longEditor, 'NEW_LOCAL');
  await selectionToolbar().getByRole('button', { name: '新增变量', exact: true }).click();
  selectionDialog = page.getByRole('dialog', { name: '新增变量', exact: true });
  await expect(selectionDialog.locator('.token-choice')).toHaveCount(0);
  await expect(selectionDialog.getByLabel('默认值', { exact: true })).toHaveValue('NEW_LOCAL');
  await expect(selectionDialog.getByRole('combobox', { name: '变量作用范围', exact: true })).toHaveValue('variable-group-a');
  await selectionDialog.getByLabel('新变量名称', { exact: true }).fill('尾部选区变量');
  await selectionDialog.getByLabel('说明', { exact: true }).fill('仅来自当前长命令的一处选区。');
  await selectionDialog.getByRole('button', { name: '创建并替换选区', exact: true }).click();
  await saved(async () => (await template()).document.parameters.length === beforeToolbarCreate.parameters.length + 1);
  const afterToolbarCreate = (await template()).document, tailVariable = afterToolbarCreate.parameters.find(parameter => !beforeToolbarCreate.parameters.some(previous => previous.id === parameter.id));
  assert.equal(tailVariable.ownerId, 'variable-group-a'); assert.equal(tailVariable.defaultValue, 'NEW_LOCAL');
  assert.equal(references(command(afterToolbarCreate), tailVariable.id), 1);
  assert.equal(strings(command(afterToolbarCreate)), strings(command(beforeToolbarCreate)).replace('NEW_LOCAL', ''));
  assert.equal(strings(command(afterToolbarCreate)).split('NEW_LOCAL').length - 1, 1);
  assert.deepEqual(afterToolbarCreate.steps.filter(step => step.id !== 'variable-a-first'), beforeToolbarCreate.steps.filter(step => step.id !== 'variable-a-first'));
  await selection(longEditor, 'NEW_LOCAL');
  const beforePopoverEscape = await workspace();
  await selectionToolbar().getByRole('button', { name: '新增变量', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新增变量', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('[data-variable-popover]')).toHaveCount(0);
  assert.deepEqual(await workspace(), beforePopoverEscape);
  checks.push('A real selection near the long-command end shows two nearby floating actions within 1360/940 viewports; Use only lists the visible parameter IDs, New has its own defaulted local form, each replaces exactly one occurrence, and Escape dismisses the toolbar/popover without saving data');
  await page.setViewportSize({ width: 1360, height: 940 });
  await selection(longEditor, 'caret-anchor', true);
  await longEditor.evaluate(element => {
    const selected = window.getSelection();
    if (!selected?.rangeCount) throw new Error('The old editor must have a real range before testing delayed selectionchange');
    const range = selected.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) throw new Error('The saved delayed range must belong to A');
    window.__qaVariablePanelDelayedRange = range.cloneRange();
    window.__qaVariablePanelDelayedSource = { editor: element, startNode: range.startContainer, startOffset: range.startOffset, endNode: range.endContainer, endOffset: range.endOffset };
  });
  const beforeSwitch = await template();
  await locate('variable-b-first'); await panelScopes('variable-b-first', 'variable-player-b', 'variable-note-b');
  await expect(longEditor).toHaveCount(0);
  await expect(row('variable-player-a')).toHaveCount(0); await expect(row('variable-note-a')).toHaveCount(0);
  await disabledReuse(); assert.deepEqual(await template(), beforeSwitch);
  const beforeLateSelection = await workspace(), navigationB = page.locator('[data-nav-step-id="variable-b-first"]');
  await page.evaluate(() => {
    const source = window.__qaVariablePanelDelayedSource;
    if (!source || source.editor.isConnected || source.startNode.isConnected || source.endNode.isConnected) throw new Error('Navigating away must unmount the old inline command editor before its delayed selection event');
    const range = document.createRange(); range.setStart(source.startNode, source.startOffset); range.setEnd(source.endNode, source.endOffset);
    window.__qaVariablePanelDelayedRange = range;
    // Deliver an old, now detached selection without reopening its editor.
    // Chromium may ignore a detached Range, so real B navigation below still
    // establishes the actual focus/context before selectionchange is emitted.
    const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
  });
  await locate('variable-b-first'); await expect(navigationB).toBeFocused();
  await panelScopes('variable-b-first', 'variable-player-b', 'variable-note-b'); await disabledReuse();
  const delayedSelectionPreserved = await page.evaluate(() => {
    const selected = window.getSelection(), range = window.__qaVariablePanelDelayedRange;
    return !!selected?.rangeCount && selected.getRangeAt(0).startContainer === range.startContainer && selected.getRangeAt(0).endContainer === range.endContainer;
  });
  await page.evaluate(async () => {
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(navigationB).toBeFocused();
  await panelScopes('variable-b-first', 'variable-player-b', 'variable-note-b');
  await expect(row('variable-player-a')).toHaveCount(0); await expect(row('variable-note-a')).toHaveCount(0);
  await disabledReuse(); assert.deepEqual(await workspace(), beforeLateSelection);
  await page.evaluate(() => { delete window.__qaVariablePanelDelayedRange; delete window.__qaVariablePanelDelayedSource; });
  await locate('variable-a-first');
  const oldDescription = await edit(step('variable-a-first'), '操作说明');
  await selection(oldDescription, 'TOKEN');
  await expect(selectionToolbar()).toBeVisible();
  const beforeUnmount = await template();
  await locate('variable-b-first');
  await expect(step('variable-a-first').getByRole('textbox', { name: '操作说明', exact: true })).toHaveCount(0);
  await panelScopes('variable-b-first', 'variable-player-b', 'variable-note-b'); await disabledReuse();
  await row('variable-player-b').locator('[data-variable-value]').click();
  assert.deepEqual(await template(), beforeUnmount, 'A saved range from an unmounted A editor must not write into A or B');
  checks.push(`At 940 × 640 the panel and long command stay inside the viewport; navigating away unmounts A, and a late detached-A selectionchange while real B navigation owns focus (browser retained detached selection: ${delayedSelectionPreserved}) cannot restore the old write target or change either document`);

  const sourceTemplate = await template();
  await apply({ type: 'create_instance', id: runId, name: 'QA 已应用值与历史变量', templateId, fromInstanceId: null });
  await apply({ type: 'start_instance', id: runId });
  await apply({ type: 'record_result', id: runId, outcome: 'completed', reason: null });
  await apply({ type: 'record_result', id: runId, outcome: 'completed', reason: null });
  const historical = await run();
  assert.equal(historical.currentStepId, 'variable-a-second');
  await apply({ type: 'apply_parameters', id: runId, values: { ...historical.parameterValues, 'variable-env': 'release-current', 'variable-player-a': 'PLAYER-A-CURRENT' } });
  await reload(); await page.locator(`[data-instance-id="${runId}"]`).click();
  await expect(step('variable-a-second')).toHaveClass(/is-current/);
  await expect(panel()).toHaveAttribute('data-variable-target-step-id', 'variable-a-second');
  await expect(row('variable-env').locator('[data-variable-value]')).toHaveText('release-current');
  await expect(row('variable-player-a').locator('[data-variable-value]')).toHaveText('PLAYER-A-CURRENT');
  const beforeDraft = await run();
  await expect(page.locator('.workspace-scroll [data-parameter-scope], .workspace-scroll .parameter-definitions')).toHaveCount(0);
  const globalInputs = panel().locator('[data-parameter-scope="global"]');
  await expect(globalInputs.getByRole('textbox', { name: '环境', exact: true })).toBeVisible();
  await globalInputs.getByRole('textbox', { name: '环境', exact: true }).fill('release-UNAPPLIED');
  await expect(globalInputs.getByRole('textbox', { name: '环境', exact: true })).toHaveValue('release-UNAPPLIED');
  assert.deepEqual(await run(), beforeDraft, 'Filling a parameter draft cannot change stored values, history or the execution cursor');
  // Keep the applied-value assertions on the explicitly browsed current step,
  // retaining its unsubmitted draft through navigation.
  await locate('variable-a-second');
  await expect(panel().locator('.variable-panel-context')).toContainText('当前浏览');
  await expect(globalInputs.getByRole('textbox', { name: '环境', exact: true })).toHaveValue('release-UNAPPLIED');
  await expect(row('variable-env').locator('[data-variable-value]')).toHaveText('release-current');
  await expect(row('variable-env')).toContainText('有未应用修改');
  assert.equal((await run()).parameterValues['variable-env'], 'release-current');
  assert.deepEqual(await run(), beforeDraft, 'Browsing back to the current step retains the draft without applying or recording it');
  await globalInputs.getByRole('button', { name: '取消本范围修改', exact: true }).click(); await settle();
  const beforeHistory = await run();
  await locate('variable-a-first'); await panelScopes('variable-a-first', 'variable-player-a', 'variable-note-a');
  await expect(panel()).toContainText('历史快照');
  await expect(row('variable-env').locator('[data-variable-value]')).toHaveText('release');
  await expect(row('variable-player-a').locator('[data-variable-value]')).toHaveText('PLAYER-A');
  await expect(row('variable-note-a').locator('[data-variable-value]')).toHaveText('NOTE-A');
  await disabledReuse();
  for (const label of ['步骤标题', '操作说明']) {
    await expect(step('variable-a-first').getByRole('button', { name: `编辑${label}`, exact: true })).toHaveCount(0);
    await inline(step('variable-a-first'), label).dblclick();
    await expect(step('variable-a-first').getByRole('textbox', { name: label, exact: true })).toHaveCount(0);
  }
  assert.deepEqual(await run(), beforeHistory); assert.deepEqual(await template(), sourceTemplate);
  await locate('variable-b-first'); await panelScopes('variable-b-first', 'variable-player-b', 'variable-note-b');
  await expect(row('variable-player-a')).toHaveCount(0); await disabledReuse();
  assert.equal((await run()).currentStepId, 'variable-a-second');
  assert.deepEqual((await run()).entries, beforeHistory.entries);
  await capture('instance'); await settle();
  await expect(page.getByRole('alert')).toHaveCount(0); assert.deepEqual(pageErrors, []);
  checks.push('Instance panel values come from applied parameters despite a visible draft; browsing advanced steps restores their exact old global/group/step snapshot, offers no reuse/edit entry and never changes the execution cursor or source template');
  const result = { ok: true, isolatedDataDirectory: actualDirectory, checks, pageErrors, templateId, runId,
    currentStepId: (await run()).currentStepId, viewports: [{ width: 1360, height: 940 }, { width: 940, height: 640 }], clipboardTouched: false, maintenanceCommandsExecuted: false };
  await writeFile('.artifacts/variable-panel-check.json', JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  const state = await page.evaluate(() => ({
    panel: document.querySelector('[data-variable-panel]')?.outerHTML,
    editingFields: [...document.querySelectorAll('[data-inline-field].is-editing')].map(element => ({ label: element.getAttribute('data-inline-field'), text: element.textContent })),
    focused: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') },
    saveState: document.querySelector('.save-state')?.textContent,
    alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
  })).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/variable-panel-failure.json', JSON.stringify({ error: String(error), checks, pageErrors, state, workspace: await workspace().catch(() => null) }, null, 2), 'utf8').catch(() => {});
  await page.screenshot({ path: '.artifacts/variable-panel-failure.png' }).catch(() => {});
  throw error;
} finally { await browser.close(); }
