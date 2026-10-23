// node scripts/check-desktop.mjs scripts/smoke-slash-variables.mjs
// Owned isolated data only. Commands are inert text; no OS clipboard or shell.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && process.env.RUNBOOK_DATA_DIR === directory && process.env.RUNBOOK_CDP_URL);
const actual = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actual}`));
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const checks = [], geometries = [], pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action });
const workspace = () => native('checklist_load');
const templateId = 'qa-slash-template', runId = 'qa-slash-active', otherRunId = 'qa-slash-other';
const template = async () => (await workspace()).templates.find(item => item.id === templateId);
const run = async id => (await workspace()).instances.find(item => item.id === id);
const step = id => page.locator(`[data-step-id="${id}"]`);
const menu = () => page.getByRole('listbox', { name: '变量建议', exact: true });
const actualOption = id => menu().locator(`[role="option"][data-parameter-id="${id}"]`);
const reference = parameterId => ({ parameterId });
const ids = { environment: 'slash-env', alias: 'slash-alias', playerA: 'slash-player-a', noteA: 'slash-note-a', playerB: 'slash-player-b', noteB: 'slash-note-b' };
const parameters = [
  { id: ids.environment, name: 'ENVIRONMENT', description: '全局环境定义。', defaultValue: 'release' },
  { id: ids.alias, name: 'ENV_ALIAS', description: '第二个全局候选。', defaultValue: 'alias-default' },
  { id: ids.playerA, ownerId: 'slash-group-a', name: 'PLAYER', description: '玩家 A 组参数。', defaultValue: 'PLAYER-A' },
  { id: ids.noteA, ownerId: 'slash-a-first', name: 'NOTE', description: '仅 A 第一步。', defaultValue: 'NOTE-A' },
  { id: ids.playerB, ownerId: 'slash-group-b', name: 'PLAYER', description: '玩家 B 同名独立参数。', defaultValue: 'PLAYER-B' },
  { id: ids.noteB, ownerId: 'slash-b-first', name: 'NOTE', description: '仅 B 步骤。', defaultValue: 'NOTE-B' },
];
const initialDocument = { parameters, groups: [{ id: 'slash-group-a', name: '玩家 A' }, { id: 'slash-group-b', name: '玩家 B' }], steps: [
  { id: 'slash-a-first', groupId: 'slash-group-a', title: ['A 标题'], description: ['A 说明'], commands: [{ id: 'slash-command-a', text: ['echo A'] }] },
  { id: 'slash-a-second', groupId: 'slash-group-a', title: ['A 后续'], description: ['后续说明'], commands: [{ id: 'slash-command-second', text: ['echo SECOND'] }] },
  { id: 'slash-b-first', groupId: 'slash-group-b', title: ['B 标题'], description: ['{{ENVIRONMENT'], commands: [{ id: 'slash-command-b', text: ['echo B'] }] },
] };
const strings = parts => parts.filter(part => typeof part === 'string').join('');
const references = (parts, id) => parts.filter(part => typeof part !== 'string' && (!id || part.parameterId === id)).length;
const parts = (document, stepId, label = '命令 1') => { const found = document.steps.find(item => item.id === stepId); return label === '步骤标题' ? found.title : label === '操作说明' ? found.description : found.commands[0].text; };
async function saved(predicate) { await expect.poll(predicate).toBe(true); await expect(page.locator('.save-state')).toContainText('已保存在本机'); }
async function reload() { await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor(); }
async function locate(id) {
  await page.locator(`[data-nav-step-id="${id}"]`).click();
  await expect(page.locator('[data-variable-panel]')).toHaveAttribute('data-variable-target-step-id', id);
  const heading = step(id).locator('.step-card-heading');
  await expect(heading).toBeVisible();
  if (await step(id).evaluate(element => element.classList.contains('execution'))) await expect(heading).toHaveAttribute('aria-expanded', 'true');
  else { await expect(heading).toHaveClass(/definition-step-heading/); await expect(step(id).locator('.definition-step-content')).toBeVisible(); }
}
async function openTemplate() {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '模板' }).click();
  await page.locator(`[data-template-id="${templateId}"] .tile-open`).click();
  await expect(page.locator('[data-inline-field="模板名称"]')).toBeVisible();
}
async function openInstance(id) {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '当前工作' }).click();
  await page.locator(`[data-instance-id="${id}"]`).click(); await expect(page.locator('[data-inline-field="实例名称"]')).toBeVisible();
}
async function editorFor(id, label = '命令 1', instance = false) {
  await locate(id);
  const editor = step(id).getByRole('textbox', { name: label, exact: true });
  if (!await editor.count()) await step(id).locator(`[data-inline-field="${label}"]`).dblclick();
  await expect(editor).toBeVisible(); return editor;
}
async function expectOptions(expected) {
  await expect(menu()).toBeVisible(); await expect(menu()).toHaveAttribute('data-slash-menu', /.+|^$/);
  await expect(menu().getByRole('option')).toHaveCount(expected.length);
  assert.deepEqual((await menu().getByRole('option').evaluateAll(elements => elements.map(element => element.dataset.parameterId))).sort(), [...expected].sort());
}
async function chosen(id, editor) {
  await expect(actualOption(id)).toHaveAttribute('aria-selected', 'true');
  await expect(menu().locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  const optionId = await actualOption(id).getAttribute('id'); assert.ok(optionId);
  await expect(editor).toHaveAttribute('aria-activedescendant', optionId);
}
async function typeQuery(editor, query) { await editor.pressSequentially(query); await expect(menu()).toBeVisible(); }
async function paste(editor, text) {
  await editor.evaluate((element, text) => {
    const transfer = new DataTransfer(); transfer.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, text);
}
async function caretAfter(editor, literal) {
  await editor.focus();
  await editor.evaluate(async (element, literal) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let text;
    while ((text = walker.nextNode())) {
      if (text.parentElement.closest('[data-parameter-id]')) continue;
      const index = text.textContent.indexOf(literal); if (index < 0) continue;
      const range = document.createRange(); range.setStart(text, index + literal.length); range.collapse(true);
      const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
      const bounds = range.getBoundingClientRect(), field = element.getBoundingClientRect(), top = field.top + element.clientTop, bottom = top + element.clientHeight;
      if (bounds.top < top + 12) element.scrollTop += bounds.top - top - 12;
      else if (bounds.bottom > bottom - 12) element.scrollTop += bounds.bottom - bottom + 12;
      const root = element.closest('.workspace-scroll'), rootBounds = root.getBoundingClientRect();
      root.scrollTo({ top: root.scrollTop + element.getBoundingClientRect().top - rootBounds.top - 36, behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return;
    }
    throw new Error('Caret literal not found');
  }, literal);
}
async function menuGeometry(label, editor) {
  await expect(menu()).toBeVisible();
  const geometry = await menu().evaluate(element => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return { viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, menu: rect(element), workspace: rect(document.querySelector('.workspace-scroll')) };
  });
  geometry.caret = await editor.evaluate(element => {
    const selected = window.getSelection(), range = selected?.rangeCount ? selected.getRangeAt(0) : null; if (!range) return null;
    const r = range.getBoundingClientRect(), field = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height, collapsed: range.collapsed,
      inside: element.contains(range.startContainer) && element.contains(range.endContainer), field: { top: field.top + element.clientTop, bottom: field.top + element.clientTop + element.clientHeight, scrollTop: element.scrollTop } };
  });
  await writeFile(`.artifacts/slash-${label}-geometry.json`, JSON.stringify(geometry, null, 2), 'utf8');
  await page.screenshot({ path: `.artifacts/slash-${label}.png` });
  const r = geometry.menu, w = geometry.workspace;
  assert.equal(geometry.viewport.scrollX, 0); assert.equal(geometry.viewport.scrollY, 0);
  assert.ok(r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= geometry.viewport.width + 1 && r.bottom <= geometry.viewport.height + 1);
  assert.ok(r.left >= w.left - 1 && r.right <= w.right + 1 && r.top >= w.top - 1 && r.bottom <= w.bottom + 1, 'Slash candidates must stay inside the document workspace');
  const c = geometry.caret; assert.ok(c?.inside && c.collapsed && c.height > 0 && c.top >= c.field.top - 1 && c.bottom <= c.field.bottom + 1 && c.top >= w.top - 1 && c.bottom <= w.bottom + 1);
  assert.ok(Math.max(0, c.top - r.bottom, r.top - c.bottom) <= 20, 'Suggestions must remain adjacent to the actual visible caret');
  geometries.push({ label, ...geometry }); return geometry;
}

try {
  await mkdir('.artifacts', { recursive: true }); await page.setViewportSize({ width: 1360, height: 940 });
  await apply({ type: 'create_template', id: templateId, name: 'QA 双花括号变量', document: initialDocument });
  await reload(); await openTemplate();
  const beforeOldFocus = await workspace();
  let editor = await editorFor('slash-b-first', '操作说明');
  await editor.focus(); await expect(menu()).toHaveCount(0); assert.deepEqual(await workspace(), beforeOldFocus); await editor.press('Escape');
  editor = await editorFor('slash-a-first', '步骤标题');
  await editor.fill('TITLE '); await typeQuery(editor, '{{eNv'); await expectOptions([ids.environment, ids.alias]);
  await chosen(ids.environment, editor); await editor.press('ArrowDown'); await chosen(ids.alias, editor); await editor.press('ArrowUp'); await chosen(ids.environment, editor);
  await editor.press('Enter'); await expect(menu()).toHaveCount(0);
  await saved(async () => references(parts((await template()).document, 'slash-a-first', '步骤标题'), ids.environment) === 1);
  assert.equal(strings(parts((await template()).document, 'slash-a-first', '步骤标题')), 'TITLE '); await editor.press('Escape');
  editor = await editorFor('slash-a-first', '操作说明'); await editor.fill('DESC ');
  await typeQuery(editor, '{{PLAYER'); await expectOptions([ids.playerA]); await actualOption(ids.playerA).click();
  await saved(async () => references(parts((await template()).document, 'slash-a-first', '操作说明'), ids.playerA) === 1);
  assert.equal(strings(parts((await template()).document, 'slash-a-first', '操作说明')), 'DESC '); await editor.press('Control+Enter');
  editor = await editorFor('slash-a-first');
  await editor.fill('prefix='); await editor.pressSequentially('{'); await expect(menu()).toHaveCount(0);
  await editor.pressSequentially('{'); await expectOptions([ids.environment, ids.alias, ids.playerA, ids.noteA]);
  await editor.press('Backspace'); await expect(menu()).toHaveCount(0);
  await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === 'prefix={');
  await editor.pressSequentially('{'); await expectOptions([ids.environment, ids.alias, ids.playerA, ids.noteA]);
  await editor.pressSequentially('ENVIRONMENT'); await actualOption(ids.environment).click();
  await saved(async () => references(parts((await template()).document, 'slash-a-first'), ids.environment) === 1);
  assert.equal(strings(parts((await template()).document, 'slash-a-first')), 'prefix=');
  await editor.fill('NODE='); await editor.pressSequentially('{');
  // Preserve the first opener in a separate native Text node, as rich editing
  // can do. The second typed brace must replace both characters, not one node.
  await editor.evaluate(element => {
    const text = element.firstChild; if (text?.nodeType !== Node.TEXT_NODE) throw Error('Expected native text');
    const tail = text.splitText(text.length - 1), next = document.createTextNode(''); tail.after(next);
    const range = document.createRange(); range.setStart(next, 0); range.collapse(true);
    const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
  });
  await editor.pressSequentially('{'); await expectOptions([ids.environment, ids.alias, ids.playerA, ids.noteA]);
  await editor.pressSequentially('ENVIRONMENT'); await editor.press('Enter');
  await saved(async () => references(parts((await template()).document, 'slash-a-first'), ids.environment) === 1);
  assert.equal(strings(parts((await template()).document, 'slash-a-first')), 'NODE=');
  checks.push('A single brace stays literal; a second adjacent brace opens candidates after inline text, deleting it closes the menu, and accepting replaces both braces including an opener split across native text nodes');
  await editor.fill('KEEP {{ENVIRONMENT SAME {{ENVIRONMENT\nTARGET '); await typeQuery(editor, '{{');
  await expectOptions([ids.environment, ids.alias, ids.playerA, ids.noteA]);
  await editor.press('End'); await chosen(ids.noteA, editor); await editor.press('Home'); await chosen(ids.environment, editor);
  await editor.press('End'); await editor.press('Enter'); await expect(menu()).toHaveCount(0);
  await saved(async () => references(parts((await template()).document, 'slash-a-first'), ids.noteA) === 1);
  assert.equal(strings(parts((await template()).document, 'slash-a-first')), 'KEEP {{ENVIRONMENT SAME {{ENVIRONMENT\nTARGET ');
  await editor.fill('TAB '); await typeQuery(editor, '{{PLAYER'); await editor.press('Tab');
  await expect(editor).toBeFocused(); await saved(async () => references(parts((await template()).document, 'slash-a-first'), ids.playerA) === 1);
  assert.equal(strings(parts((await template()).document, 'slash-a-first')), 'TAB ');
  const quoted = 'keep --file "" SUFFIX {{ENVIRONMENT stays';
  await editor.fill(quoted); await caretAfter(editor, 'keep --file "'); await typeQuery(editor, '{{ENVIRONMENT');
  await actualOption(ids.environment).click(); await saved(async () => references(parts((await template()).document, 'slash-a-first'), ids.environment) === 1);
  const quotedParts = parts((await template()).document, 'slash-a-first');
  assert.equal(strings(quotedParts), quoted);
  assert.equal(quotedParts.map(part => typeof part === 'string' ? part : parameters.find(parameter => parameter.id === part.parameterId).defaultValue).join(''), 'keep --file "release" SUFFIX {{ENVIRONMENT stays');
  await editor.fill(''); await typeQuery(editor, '{{ENVIRONMENT'); await expectOptions([ids.environment]); await editor.press('Enter');
  await saved(async () => references(parts((await template()).document, 'slash-a-first'), ids.environment) === 1);
  assert.equal(strings(parts((await template()).document, 'slash-a-first')), '');
  await editor.fill('LINE\n'); await typeQuery(editor, '{{NOTE'); await expectOptions([ids.noteA]); await editor.press('Enter');
  await saved(async () => references(parts((await template()).document, 'slash-a-first'), ids.noteA) === 1);
  assert.equal(strings(parts((await template()).document, 'slash-a-first')), 'LINE\n');
  checks.push('Actual typing triggers in title/description/commands at whitespace, line or field starts and inside an opening quote; case-insensitive name filtering, mouse and Arrow/Home/End+Enter/Tab selection insert the visible stable ID and replace only the current double-brace query, preserving repeated literals, quotes and suffixes');

  for (const text of ['https://example.invalid', 'C:/', 'word/foo', '/ENVIRONMENT', '{ENVIRONMENT', '{{{ENVIRONMENT']) {
    await editor.fill('');
    for (const character of text) { await editor.pressSequentially(character); if (character === '/') await expect(menu()).toHaveCount(0); }
    await expect(menu()).toHaveCount(0); await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === text);
  }
  for (const ending of ['/', '\\', ' ', '}}', '{']) {
    await editor.fill('STOP '); await typeQuery(editor, '{{Env'); await editor.pressSequentially(ending); await expect(menu()).toHaveCount(0);
    await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === `STOP {{Env${ending}`);
  }
  await editor.fill('PASTE '); await paste(editor, '{{Env'); await expect(menu()).toHaveCount(0);
  await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === 'PASTE {{Env');
  await editor.fill('EMPTY '); await typeQuery(editor, '{{ZZZ-NO-VARIABLE'); await expectOptions([]); await editor.press('Enter');
  await expect(menu()).toHaveCount(0); await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === 'EMPTY {{ZZZ-NO-VARIABLE\n');
  await editor.fill('ESC '); await typeQuery(editor, '{{Env');
  await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === 'ESC {{Env');
  const beforeEscape = await workspace(); await editor.press('Escape'); await expect(menu()).toHaveCount(0); assert.deepEqual(await workspace(), beforeEscape);
  await editor.evaluate(element => element.blur()); await expect(editor).toHaveCount(0);
  const escapedDisplay = step('slash-a-first').locator('[data-inline-field="命令 1"]');
  await expect(escapedDisplay).toHaveClass(/is-display/); await expect(escapedDisplay).toHaveText('ESC {{Env');
  assert.deepEqual(await workspace(), beforeEscape);
  editor = await editorFor('slash-a-first'); await expect(editor).toBeFocused();
  assert.equal(await editor.textContent(), 'ESC {{Env'); await expect(menu()).toHaveCount(0); assert.deepEqual(await workspace(), beforeEscape);
  await editor.fill('MOVE '); await typeQuery(editor, '{{Env'); await editor.press('ArrowLeft'); await expect(menu()).toHaveCount(0);
  await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === 'MOVE {{Env');
  await editor.fill('RANGE '); await typeQuery(editor, '{{Env');
  await editor.evaluate(element => { const text = element.firstChild, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 2); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await expect(menu()).toHaveCount(0); await expect(page.getByRole('toolbar', { name: '选区变量操作', exact: true })).toBeVisible();
  await editor.press('Escape'); await expect(editor).toBeVisible();
  await editor.fill('IME '); await typeQuery(editor, '{{Env');
  const composing = await editor.evaluate(element => { const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true }); element.dispatchEvent(event); return { prevented: event.defaultPrevented, composing: event.isComposing }; });
  assert.equal(composing.composing, true); assert.equal(composing.prevented, false);
  await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === 'IME {{Env');
  assert.equal(references(parts((await template()).document, 'slash-a-first')), 0); await editor.press('Escape'); await expect(editor).toBeVisible();
  checks.push('Existing focused text, paste, URLs and word paths never open suggestions; query terminators including closing braces, no-match Enter, caret movement, selection and Escape retain literal text and close the query; selection toolbar still works and a synthetic composing Enter cannot accept a candidate');

  await editor.fill('FIELD '); await typeQuery(editor, '{{Env');
  await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === 'FIELD {{Env');
  const beforeFieldChange = await workspace();
  const otherEditor = await editorFor('slash-a-second'); await otherEditor.focus();
  await expect(menu()).toHaveCount(0); assert.deepEqual(await workspace(), beforeFieldChange);
  const bEditor = await editorFor('slash-b-first');
  await bEditor.fill('B '); await typeQuery(bEditor, '{{PLAYER'); await expectOptions([ids.playerB]); await actualOption(ids.playerB).click();
  await saved(async () => references(parts((await template()).document, 'slash-b-first'), ids.playerB) === 1);
  assert.equal(references(parts((await template()).document, 'slash-b-first'), ids.playerA), 0);
  editor = await editorFor('slash-a-first');
  const longPrefix = Array.from({ length: 85 }, (_, index) => `# QA inert line ${index + 1}\n`).join('') + 'TAIL ';
  for (const viewport of [{ width: 1360, height: 940 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(viewport); await editor.fill(`${longPrefix} SUFFIX`); await caretAfter(editor, 'TAIL '); await typeQuery(editor, '{{');
    await expectOptions([ids.environment, ids.alias, ids.playerA, ids.noteA]); await menuGeometry(`initial-long-${viewport.width}`, editor);
    await editor.pressSequentially('Env');
    await expectOptions([ids.environment, ids.alias]); await menuGeometry(`long-${viewport.width}`, editor);
    await editor.evaluate(element => { element.scrollTop -= 2; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await menuGeometry(`inner-scroll-${viewport.width}`, editor);
    await page.locator('.workspace-scroll').evaluate(element => { element.scrollTop += 3; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await menuGeometry(`outer-scroll-${viewport.width}`, editor);
    await editor.evaluate(element => { element.scrollTop = 0; }); await expect(menu()).toHaveCount(0);
    await saved(async () => strings(parts((await template()).document, 'slash-a-first')) === `${longPrefix}{{Env SUFFIX`);
  }
  checks.push('Changing fields clears old candidates, same-name group parameters remain isolated by ID, and menus at a long command tail stay beside the real caret inside both viewport sizes, follow nested scrolling and close when that query leaves view without deleting it');

  await page.setViewportSize({ width: 1360, height: 940 });
  const instanceSource = await template(), instanceDocument = structuredClone(instanceSource.document);
  instanceDocument.steps[0].commands[0].text = ['echo FROZEN ', reference(ids.environment), '|', reference(ids.playerA)];
  await apply({ type: 'save_template', id: templateId, name: instanceSource.name, document: instanceDocument });
  const sourceTemplate = await template();
  for (const id of [runId, otherRunId]) { await apply({ type: 'create_instance', id, name: id, templateId, fromInstanceId: null }); await apply({ type: 'start_instance', id }); }
  await apply({ type: 'record_result', id: runId, outcome: 'completed', reason: null });
  const beforeApply = await run(runId), frozen = beforeApply.entries.find(item => item.type === 'result');
  await apply({ type: 'apply_parameters', id: runId, values: { ...beforeApply.parameterValues, [ids.environment]: 'sandboxa' } });
  await reload(); await openInstance(runId); editor = await editorFor('slash-a-second', '命令 1', true);
  await editor.fill('OLD-INSTANCE '); await typeQuery(editor, '{{Env');
  await saved(async () => strings(parts((await run(runId)).document, 'slash-a-second')) === 'OLD-INSTANCE {{Env');
  const beforeInstanceSwitch = await run(runId), otherBefore = await run(otherRunId);
  await openInstance(otherRunId); await expect(menu()).toHaveCount(0);
  const freshEditor = await editorFor('slash-a-first', '命令 1', true); await freshEditor.focus(); await expect(menu()).toHaveCount(0);
  await freshEditor.press('Tab'); await expect(menu()).toHaveCount(0);
  assert.deepEqual(await run(runId), beforeInstanceSwitch); assert.deepEqual(await run(otherRunId), otherBefore);
  await openInstance(runId); editor = await editorFor('slash-a-second', '命令 1', true);
  await editor.fill('echo CURRENT '); await typeQuery(editor, '{{ENVIRONMENT'); await actualOption(ids.environment).click();
  await saved(async () => references(parts((await run(runId)).document, 'slash-a-second'), ids.environment) === 1);
  assert.equal((await run(runId)).parameterValues[ids.environment], 'sandboxa');
  await step('slash-a-second').getByRole('button', { name: '完成并下一步', exact: true }).click();
  await expect.poll(async () => (await run(runId)).currentStepId).toBe('slash-b-first');
  const progressed = await run(runId), secondResult = progressed.entries.filter(item => item.type === 'result').at(-1);
  assert.equal(secondResult.snapshot.commands[0].text, 'echo CURRENT sandboxa'); assert.deepEqual(progressed.entries.find(item => item.id === frozen.id), frozen);
  await locate('slash-a-first');
  for (const label of ['步骤标题', '操作说明']) { await step('slash-a-first').locator(`[data-inline-field="${label}"]`).dblclick(); await expect(step('slash-a-first').getByRole('textbox', { name: label, exact: true })).toHaveCount(0); }
  await expect(step('slash-a-first').getByRole('button', { name: '编辑本步骤', exact: true })).toHaveCount(0); await expect(menu()).toHaveCount(0);
  await expect(step('slash-a-first').locator('[data-inline-field="命令 1"]')).toHaveText('echo FROZEN release|PLAYER-A');
  await expect(step('slash-a-first').getByRole('button', { name: '命令操作', exact: true })).toHaveCount(0);
  assert.deepEqual(await run(runId), progressed);
  await locate('slash-b-first'); await step('slash-b-first').getByRole('button', { name: '完成并结束', exact: true }).click();
  await expect.poll(async () => (await run(runId)).status).toBe('completed');
  const ended = await run(runId); await locate('slash-a-second');
  await expect(step('slash-a-second').getByRole('textbox', { name: '命令 1', exact: true })).toHaveCount(0); await expect(menu()).toHaveCount(0);
  assert.deepEqual(await run(runId), ended); assert.deepEqual(await template(), sourceTemplate); assert.deepEqual(await run(otherRunId), otherBefore);
  assert.deepEqual(pageErrors, []); await expect(page.getByRole('alert')).toHaveCount(0);
  checks.push('Switching instances clears old candidates without inserting or changing either stored instance; current-step references use applied sandboxa values, old release snapshots stay exact, and advanced/ended steps have no editable variable-query entry or write side effects');
  const result = { ok: true, isolatedDataDirectory: actual, templateId, runId, otherRunId, checks, geometries, pageErrors, clipboardTouched: false, maintenanceCommandsExecuted: false, trigger: '{{',
    imeKeyboardGuardUsesSyntheticEvent: true, note: 'Typing, focus, mouse and keyboard acceptance use the real WebView2 UI; IME composition Enter is a synthetic keyboard guard check, not an OS IME session.' };
  await writeFile('.artifacts/slash-variables-check.json', JSON.stringify(result, null, 2), 'utf8'); console.log(JSON.stringify(result));
} catch (error) {
  const state = await page.evaluate(() => {
    const selected = window.getSelection(), range = selected?.rangeCount ? selected.getRangeAt(0) : null;
    const elementOf = node => node instanceof Element ? node : node?.parentElement;
    const focusedEditor = document.activeElement?.closest('[contenteditable][role="textbox"]');
    const editor = focusedEditor ?? elementOf(range?.startContainer)?.closest('[contenteditable][role="textbox"]');
    const nodeInfo = node => node ? { nodeType: node.nodeType, nodeName: node.nodeName, textContent: node.textContent,
      parentTag: node.parentElement?.tagName, parentHTML: node.parentElement?.innerHTML } : null;
    let prefix;
    if (editor && range) {
      try {
        const before = document.createRange(); before.selectNodeContents(editor); before.setEnd(range.startContainer, range.startOffset);
        const fragment = document.createElement('div'); fragment.append(before.cloneContents());
        prefix = { rangeToString: before.toString(), innerHTML: fragment.innerHTML, textContent: fragment.textContent };
      } catch (reason) { prefix = { unavailable: String(reason) }; }
    }
    return { menus: [...document.querySelectorAll('[data-slash-menu]')].map(node => node.outerHTML),
      focus: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') },
      editor: editor ? { label: editor.getAttribute('aria-label'), stepId: editor.closest('[data-step-id]')?.getAttribute('data-step-id'),
        innerHTML: editor.innerHTML, textContent: editor.textContent, innerText: editor.innerText, scrollTop: editor.scrollTop, clientHeight: editor.clientHeight, scrollHeight: editor.scrollHeight } : null,
      selection: range ? { text: selected.toString(), collapsed: range.collapsed, start: nodeInfo(range.startContainer), startOffset: range.startOffset,
        end: nodeInfo(range.endContainer), endOffset: range.endOffset, prefix } : null,
      selected: selected?.toString(), save: document.querySelector('.save-state')?.textContent };
  }).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/slash-variables-failure.json', JSON.stringify({ error: String(error), checks, geometries, pageErrors, state, workspace: await workspace().catch(() => null) }, null, 2), 'utf8').catch(() => {});
  await page.screenshot({ path: '.artifacts/slash-variables-failure.png' }).catch(() => {}); throw error;
} finally { await browser.close(); }
