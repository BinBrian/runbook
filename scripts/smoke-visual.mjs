// Run only after rebuilding with the visual editor:
// node scripts/check-desktop.mjs scripts/smoke-visual.mjs
// The launcher owns app startup/exit. This script never accesses .local-data.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && path.isAbsolute(directory), 'Explicit isolated RUNBOOK_TEST_DATA_DIR required');
assert.equal(path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''), path.resolve(directory), 'Launcher directories must match');
const relative = path.relative(await realpath('target'), await realpath(directory));
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'The database must be inside target, never user .local-data');
const startupLog = await readFile('target/debug/runbook-startup.log', 'utf8');
assert.ok(startupLog.includes(`Data directory: ${path.resolve(directory)}`), 'Startup log must confirm the isolated database');

const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL ?? 'http://127.0.0.1:9345');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const pageErrors = [], checks = [];
page.on('pageerror', error => pageErrors.push(error.message));
const workspace = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('load_workspace'));
const template = async id => (await workspace()).templates.find(item => item.id === id);
const run = async id => (await workspace()).runs.find(item => item.id === id);
const mutate = async action => {
  const current = await workspace(), objectId = action.run_id ?? action.id;
  const entity = (action.type.includes('template') ? current.templates : current.runs).find(item => item.id === objectId);
  return page.evaluate(request => window.__TAURI_INTERNALS__.invoke('perform', { request }), {
    operation_id: crypto.randomUUID(), expected_revision: entity?.revision ?? null, action,
  });
};
const parse = markdown => page.evaluate(markdown => window.__TAURI_INTERNALS__.invoke('parse_markdown', { markdown }), markdown);
const capture = name => page.screenshot({ path: `.artifacts/visual-${name}.png` });
const openTemplate = async (name, archived = false) => {
  await page.reload();
  if (archived) await page.getByRole('button', { name: /^已归档模板/ }).click();
  await page.locator('.template-card-open').filter({ has: page.getByRole('heading', { name, exact: true }) }).click();
};
const openRun = async name => {
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: '进行中', exact: true }).click();
  await page.locator('.run-list-item').filter({ has: page.getByRole('heading', { name, exact: true }) }).click();
};

const stepId = '99757eca-cbee-4ccd-adfa-6e6872ad5923';
const commandId = '1cc11562-61cb-4948-97df-642230654cca';
const exactCommand = '  Write-Output "中文😀 `t {{rb:HOST}}"  \r\n';
const preservedTable = '| 保留表头 A | 保留表头 B |\r\n| :--- | ---: |\r\n| 原始  空格 | `不变` |';
const preservedHtml = '<details data-original="keep">\r\n<summary>保留的 HTML 块</summary>\r\n特殊原文  空格\r\n</details>';
const fidelitySource = [
  '<!-- runbook:document version="1" -->',
  '<!-- runbook:parameters {"HOST":"staging"} -->',
  '# 可视文档原始标题',
  '这是一段可直接编辑的正文。',
  preservedTable,
  preservedHtml,
  `<!-- runbook:step id="${stepId}" -->`,
  '## 核对参数命令',
  '命令前说明需要保留。',
  `<!-- runbook:command id="${commandId}" -->`,
  `~~~~powershell\r\n${exactCommand}\r\n~~~~`,
  '命令后说明需要保留。',
  '<!-- /runbook:step -->',
].join('\r\n\r\n');

const visual = page.getByRole('textbox', { name: '文档内容', exact: true });
const visualTools = page.getByRole('toolbar', { name: '文档格式与插入', exact: true });
const documentMode = () => page.locator('.editor-toolbar').getByRole('button', { name: '文档', exact: true }).click();
const sourceMode = () => page.locator('.editor-toolbar').getByRole('button', { name: '源码', exact: true }).click();
async function assertVisualDefault() {
  await expect(visual).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCount(0);
  const visible = await visual.innerText();
  assert.doesNotMatch(visible, /<!--\s*\/?runbook:/, 'Internal Markdown markers are hidden');
  assert.ok(!visible.includes(stepId) && !visible.includes(commandId), 'Actual internal identities are hidden');
}
async function replaceRenderedLine(locator, text) {
  await locator.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.insertText(text);
}
async function selectSuffix(locator, count) {
  await locator.click();
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let index = 0; index < count; index++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
}
const clipboardMime = 'application/x-runbook-visual+json';
async function clipboardEvent(type, items = {}) {
  // DataTransfer is local to the DOM event. navigator.clipboard and the system
  // clipboard are never accessed by these tests.
  return visual.evaluate((element, { type, items }) => {
    const transfer = new DataTransfer();
    for (const [format, value] of Object.entries(items)) transfer.setData(format, value);
    const event = new ClipboardEvent(type, { clipboardData: transfer, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, items: Object.fromEntries([...transfer.types].map(format => [format, transfer.getData(format)])) };
  }, { type, items });
}
async function copySelected() {
  const result = await clipboardEvent('copy');
  assert.ok(result.prevented && result.items[clipboardMime], 'Semantic copy is captured by the editor');
  return result.items;
}
async function pasteItems(items) {
  const result = await clipboardEvent('paste', items);
  assert.ok(result.prevented, 'The editor handles the synthetic paste event');
}
async function selectRenderedNode(locator) {
  // Clicking the atom's border gives ProseMirror a real node selection;
  // selecting the nested React DOM wrapper with Range does not reliably do so.
  await locator.click({ position: { x: 1, y: 1 } });
  await expect.poll(() => locator.evaluate(element => !!element.closest('.ProseMirror-selectednode'))).toBe(true);
}
async function checkExternalHtml(id) {
  const probe = 'https://runbook-paste.invalid', resourceRequests = [];
  const onRequest = request => { if (request.url().startsWith(probe + '/')) resourceRequests.push(request.url()); };
  const blockProbe = route => route.abort();
  page.on('request', onRequest);
  await page.route(probe + '/**', blockProbe);
  await page.evaluate(() => { window.__visualPasteExecuted = 0; });
  try {
    await page.locator('.visual-append').click();
    const html = '<section><article><p>嵌套容器中的中文正文保留。</p><p><strong>保留加粗中文</strong></p></article></section>'
      + '<script>window.__visualPasteExecuted += 1</script>'
      + `<script src="${probe}/script.js"></script>`
      + `<iframe src="${probe}/frame"></iframe>`
      + `<img src="${probe}/image.png" onerror="window.__visualPasteExecuted += 1">`;
    await pasteItems({ 'text/html': html, 'text/plain': '嵌套容器中的中文正文保留。\n保留加粗中文' });
    await expect(visual.locator('p').filter({ hasText: '嵌套容器中的中文正文保留。' })).toBeVisible();
    await expect(visual.locator('strong').filter({ hasText: '保留加粗中文' })).toBeVisible();
    await expect.poll(async () => (await template(id)).draft_markdown.includes('嵌套容器中的中文正文保留。')).toBe(true);
    // ProseMirror inserts a src-less IMG separator after inline atoms on WebKit.
    // That editor caret helper is unrelated to pasted image content.
    await expect(visual.locator('script,iframe,img:not(.ProseMirror-separator),img[src],img[srcset],[onerror]')).toHaveCount(0);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__visualPasteExecuted), 0, 'Pasted script and event handlers never execute');
    assert.deepEqual(resourceRequests, [], 'Pasted HTML never requests external script, frame or image resources');
    const saved = (await template(id)).draft_markdown;
    assert.doesNotMatch(saved, /runbook-paste\.invalid|__visualPasteExecuted|<script|<iframe|<img|onerror/i, 'Unsafe HTML is absent from persisted Markdown');
    assert.ok(saved.includes('**保留加粗中文**'), 'Allowed rich text survives while unknown containers are unwrapped');
    checks.push('external HTML unwraps section/article and keeps Chinese text; script/iframe/img/handlers removed without execution or resource requests');
  } finally {
    page.off('request', onRequest);
    await page.unroute(probe + '/**', blockProbe);
    await page.evaluate(() => { delete window.__visualPasteExecuted; });
  }
}
async function checkClipboard() {
  const sourceId = crypto.randomUUID(), sourceName = '外部 Markdown 粘贴验证';
  await mutate({ type: 'create_template', id: sourceId, name: sourceName, markdown: '' });
  await openTemplate(sourceName);
  await visual.click();
  const external = [
    '<!-- runbook:document version="1" -->',
    '<!-- runbook:parameters {"HOST":"paste-default","ADDED":"new-default"} -->',
    '# 粘贴后仍为标题',
    '- 粘贴清单一\n- 粘贴清单二',
    '```sh\nprintf "{{rb:HOST}}"\n```',
    '粘贴目标 {{rb:HOST}}',
  ].join('\n\n');
  await pasteItems({ 'text/plain': external });
  await expect(visual.getByRole('heading', { name: '粘贴后仍为标题', exact: true })).toBeVisible();
  await expect(visual.locator('ul li')).toHaveCount(2);
  await expect(visual.locator('.visual-code-card')).toHaveCount(1);
  await expect(visual.locator('.visual-command-card:not(.visual-code-card)')).toHaveCount(0);
  await expect.poll(async () => (await template(sourceId)).draft_markdown.includes('{{rb:HOST}}')).toBe(true);
  const imported = await parse((await template(sourceId)).draft_markdown);
  assert.deepEqual(imported.diagnostics, []);
  assert.equal(imported.steps.length, 0, 'Ordinary pasted code is not promoted to an executable step');
  assert.equal(imported.parameters.find(item => item.name === 'HOST').default_value, 'paste-default');
  await assertVisualDefault();
  checks.push('external Markdown paste preserves headings/list/ordinary code and variable definitions');

  await selectSuffix(visual.locator('p').filter({ hasText: '粘贴目标' }), 1);
  const beforeVariableCopy = await template(sourceId), variableItems = await copySelected();
  const variablePayload = JSON.parse(variableItems[clipboardMime]);
  assert.deepEqual(variablePayload.parameters, { HOST: 'paste-default' }, 'Copy carries only referenced variable defaults');
  assert.match(variableItems['text/plain'], /\{\{rb:HOST\}\}/);
  assert.deepEqual(await template(sourceId), beforeVariableCopy, 'Copying a variable leaves its source unchanged');

  await page.getByRole('button', { name: '在当前行插入元素', exact: true }).click();
  await page.getByRole('menu', { name: '插入元素', exact: true }).getByRole('menuitem', { name: '指令', exact: true }).click();
  const command = visual.locator('.visual-command-card:not(.visual-code-card)');
  await command.getByRole('textbox', { name: '指令内容', exact: true }).fill('echo {{rb:HOST}} {{rb:ADDED}}');
  await command.getByRole('button', { name: '完成编辑', exact: true }).click();
  await expect.poll(async () => (await template(sourceId)).draft_markdown.includes('echo {{rb:HOST}} {{rb:ADDED}}')).toBe(true);
  const beforeCommandCopy = await template(sourceId), sourceDocument = await parse(beforeCommandCopy.draft_markdown);
  assert.deepEqual(sourceDocument.diagnostics, []);
  const originalCommand = sourceDocument.steps.flatMap(step => step.commands)[0];
  await selectRenderedNode(command);
  const commandItems = await copySelected(), commandPayload = JSON.parse(commandItems[clipboardMime]);
  assert.deepEqual(commandPayload.parameters, { HOST: 'paste-default', ADDED: 'new-default' });
  assert.equal(commandItems['text/plain'], 'echo {{rb:HOST}} {{rb:ADDED}}');
  assert.deepEqual(await template(sourceId), beforeCommandCopy, 'Copying a command is read-only');

  const destinationId = crypto.randomUUID(), destinationName = '粘贴引用与身份验证';
  await mutate({ type: 'create_template', id: destinationId, name: destinationName, markdown: '接收文档正文。' });
  await openTemplate(destinationName);
  await visual.locator('p').filter({ hasText: '接收文档正文。' }).click();
  await page.keyboard.press('End');
  await pasteItems(variableItems);
  await expect(visual.locator('.visual-variable-chip')).toHaveCount(1);
  await expect.poll(async () => (await template(destinationId)).draft_markdown.includes('{{rb:HOST}}')).toBe(true);
  const withVariable = await parse((await template(destinationId)).draft_markdown);
  assert.deepEqual(withVariable.diagnostics, []);
  assert.equal(withVariable.parameters.find(item => item.name === 'HOST').default_value, 'paste-default');

  const beforeConflict = await template(destinationId);
  await pasteItems({ 'text/plain': '<!-- runbook:parameters {"HOST":"conflicting-default"} -->\n\n## 应被拒绝的粘贴 {{rb:HOST}}' });
  await expect(page.locator('.visual-notice')).toContainText('默认值与当前文档不同');
  await page.waitForTimeout(750);
  assert.deepEqual(await template(destinationId), beforeConflict, 'Conflicting defaults reject the whole paste without overwriting the existing document');
  if (await page.locator('.error-banner').count()) await page.locator('.error-banner').getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.locator('.visual-notice').getByRole('button', { name: '关闭提示', exact: true }).click();
  checks.push('synthetic variable copy/paste carries definitions; conflicting external defaults refuse without mutation');

  for (let copy = 0; copy < 2; copy++) {
    await page.locator('.visual-append').click();
    await pasteItems(commandItems);
    await expect.poll(async () => (await parse((await template(destinationId)).draft_markdown)).steps.flatMap(step => step.commands).length).toBe(copy + 1);
  }
  const destination = await parse((await template(destinationId)).draft_markdown);
  assert.deepEqual(destination.diagnostics, []);
  assert.equal(destination.parameters.find(item => item.name === 'HOST').default_value, 'paste-default', 'Compatible existing defaults are reused');
  assert.equal(destination.parameters.find(item => item.name === 'ADDED').default_value, 'new-default', 'Missing command references import their definitions');
  const commands = destination.steps.flatMap(step => step.commands);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands.map(item => item.text), ['echo {{rb:HOST}} {{rb:ADDED}}', 'echo {{rb:HOST}} {{rb:ADDED}}']);
  assert.equal(new Set(commands.map(item => item.id)).size, 2);
  assert.ok(commands.every(item => item.id !== originalCommand.id), 'Every pasted command has a fresh identity');
  assert.equal(new Set(destination.steps.map(step => step.id)).size, destination.steps.length);
  assert.ok(destination.steps.every(step => !sourceDocument.steps.some(original => original.id === step.id)), 'Standalone commands receive fresh enclosing steps');
  assert.deepEqual(await template(sourceId), beforeCommandCopy, 'Cross-document pastes preserve their source');
  await checkExternalHtml(destinationId);
  await capture('clipboard');
  checks.push('synthetic command copy/paste keeps references and exact text, with fresh command/step identities for each paste');
  return [sourceId, destinationId];
}
async function assertPreserved(id) {
  const saved = await template(id);
  assert.ok(saved.draft_markdown.includes(preservedTable), 'Unsupported table source stays byte-for-byte');
  assert.ok(saved.draft_markdown.includes(preservedHtml), 'Unsupported HTML source stays byte-for-byte');
  const parsed = await parse(saved.draft_markdown);
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.steps[0].id, stepId, 'Editing prose retains step identity');
  assert.equal(parsed.steps[0].commands[0].id, commandId, 'Editing prose retains command identity');
  assert.equal(parsed.steps[0].commands[0].text, exactCommand, 'Spaces, Unicode, backtick and trailing CRLF stay exact');
}
async function checkLongDocumentAndReadonly(id, name) {
  const original = await template(id), end = 'VISUAL_SCROLL_END_120';
  const longSource = original.draft_markdown + '\n\n' + Array.from({ length: 120 }, (_, index) => `维护检查 ${index + 1}：确认当前记录与操作结果。`).join('\n\n') + '\n\n' + end;
  await mutate({ type: 'save_template', id, name, description: '', markdown: longSource });
  await openTemplate(name);
  await page.setViewportSize({ width: 1100, height: 600 });
  const scroller = page.locator('.visual-scroll');
  const toolbarTop = await visualTools.evaluate(element => element.getBoundingClientRect().top);
  const rect = await scroller.boundingBox();
  assert.ok(rect && rect.height > 100 && rect.y + rect.height <= 601, 'Visual document has a bounded content viewport');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await visual.focus();
  await page.keyboard.press('Control+End');
  await expect(visual.getByText(end, { exact: true })).toBeInViewport();
  assert.ok(Math.abs(await visualTools.evaluate(element => element.getBoundingClientRect().top) - toolbarTop) <= 1, 'Formatting tools stay fixed while the document scrolls');
  await expect(visualTools).toBeInViewport();
  await capture('long-document');
  checks.push('600px long-document wheel and Ctrl+End reachability; fixed formatting tools');

  await mutate({ type: 'archive_template', id, archived: true });
  await openTemplate(name, true);
  await expect(visual).toHaveAttribute('contenteditable', 'false');
  assert.equal(await visual.locator('[contenteditable="true"],textarea:not([readonly]):not([disabled]),input:not([readonly]):not([disabled])').count(), 0, 'Archived visual content exposes no writable fields');
  const before = await template(id);
  await sourceMode();
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await documentMode();
  // Let any incorrectly scheduled autosave surface before comparing revisions.
  await page.waitForTimeout(750);
  assert.deepEqual(await template(id), before, 'Read-only viewing and mode changes never write the archived template');
  await capture('readonly');
  checks.push('archived document/source remain read-only without writes');
}

try {
  assert.deepEqual(await workspace(), { templates: [], runs: [] }, 'Use a new launcher-created isolated workspace');
  await mkdir('.artifacts', { recursive: true });
  const parsed = await parse(fidelitySource);
  assert.deepEqual(parsed.diagnostics, [], 'The fidelity fixture is valid native Runbook Markdown');
  assert.equal(parsed.steps[0].commands[0].text, exactCommand);
  const fidelityId = crypto.randomUUID(), fidelityName = '可视编辑保真验证';
  await mutate({ type: 'create_template', id: fidelityId, name: fidelityName, markdown: fidelitySource });
  await openTemplate(fidelityName);
  await assertVisualDefault();
  const pristine = await template(fidelityId);
  await sourceMode();
  await expect(page.locator('.cm-content')).toBeVisible();
  await documentMode();
  await page.waitForTimeout(750);
  assert.deepEqual(await template(fidelityId), pristine, 'Opening and mode toggles preserve exact Markdown and revision');
  await capture('default-document');
  checks.push('default document hides metadata/IDs; no-op source roundtrip is exact');

  await replaceRenderedLine(visual.getByRole('heading', { name: '可视文档原始标题', exact: true }), '可视文档修改标题');
  await page.keyboard.press('Control+z');
  await expect(visual.getByRole('heading', { name: '可视文档原始标题', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect(visual.getByRole('heading', { name: '可视文档修改标题', exact: true })).toBeVisible();
  await expect.poll(async () => (await template(fidelityId)).draft_markdown.includes('可视文档修改标题')).toBe(true);
  await replaceRenderedLine(visual.locator('p').filter({ hasText: '这是一段可直接编辑的正文。' }), '正文已在文档界面直接修改。');
  // Switch immediately, before the 500ms save debounce, to check local input.
  await sourceMode();
  await expect(page.locator('.cm-content')).toContainText('正文已在文档界面直接修改。');
  await documentMode();
  await expect.poll(async () => (await template(fidelityId)).draft_markdown.includes('正文已在文档界面直接修改。')).toBe(true);
  await assertPreserved(fidelityId);
  checks.push('heading undo/redo and immediate source switch preserve edits, unknown blocks and exact command/identities');

  // A second template is built entirely through visible editing controls.
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '新建模板', exact: true }).first().click();
  const interactionName = '可视交互与实例验证';
  await page.getByRole('dialog').getByRole('textbox').fill(interactionName);
  await page.getByRole('button', { name: '创建并编辑', exact: true }).click();
  await assertVisualDefault();
  const interactionId = (await workspace()).templates.find(item => item.name === interactionName).id;
  await visual.click();
  await page.keyboard.insertText('echo staging');
  await expect.poll(async () => (await template(interactionId)).draft_markdown.includes('echo staging')).toBe(true);
  const beforeDialog = await template(interactionId);
  await selectSuffix(visual.locator('p').filter({ hasText: 'echo staging' }), 7);
  await visualTools.getByRole('button', { name: '设为变量', exact: true }).click();
  const variableDialog = page.getByRole('dialog', { name: '设为变量', exact: true });
  await expect(variableDialog.getByLabel('默认值', { exact: true })).toHaveValue('staging');
  await variableDialog.getByLabel('变量名称', { exact: true }).fill('CANCELLED');
  await variableDialog.getByLabel('默认值', { exact: true }).fill('unsaved-dialog-value');
  await variableDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(await template(interactionId), beforeDialog, 'Cancelling a variable dialog does not change the persisted document');
  await selectSuffix(visual.locator('p').filter({ hasText: 'echo staging' }), 7);
  await visualTools.getByRole('button', { name: '设为变量', exact: true }).click();
  await variableDialog.getByLabel('变量名称', { exact: true }).fill('HOST');
  await expect(variableDialog.getByLabel('默认值', { exact: true })).toHaveValue('staging');
  await variableDialog.getByRole('button', { name: '创建变量', exact: true }).click();
  await expect(visual.locator('.visual-variable-chip')).toContainText('HOST');
  await expect.poll(async () => (await template(interactionId)).draft_markdown.includes('{{rb:HOST}}')).toBe(true);

  // Whole-paragraph conversion must serialize the variable atom as its token.
  await visual.locator('p').filter({ hasText: 'echo' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await visualTools.getByRole('button', { name: '转为指令', exact: true }).click();
  await expect(visual.locator('.visual-command-card')).toHaveCount(1);
  await visual.locator('.visual-command-preview').click();
  await page.getByRole('button', { name: '在当前行插入元素', exact: true }).click();
  await page.getByRole('menu', { name: '插入元素', exact: true }).getByRole('menuitem', { name: '步骤', exact: true }).click();
  await expect(visual.locator('.visual-step')).toHaveCount(2);
  await replaceRenderedLine(visual.getByRole('heading', { name: '新步骤', exact: true }), '人工确认检查点');
  await expect.poll(async () => (await template(interactionId)).draft_markdown.includes('人工确认检查点')).toBe(true);
  const interactiveRaw = await parse((await template(interactionId)).draft_markdown);
  assert.deepEqual(interactiveRaw.diagnostics, []);
  assert.equal(interactiveRaw.steps.length, 2);
  const rawCommandStep = interactiveRaw.steps.find(step => step.commands.length > 0);
  assert.equal(rawCommandStep.commands[0].text, 'echo {{rb:HOST}}');
  assert.equal(interactiveRaw.parameters.find(item => item.name === 'HOST').default_value, 'staging');
  assert.ok(interactiveRaw.steps.some(step => step.title === '人工确认检查点' && step.commands.length === 0));
  const originalStepIds = interactiveRaw.steps.map(step => step.id);
  await visual.locator(`.visual-step[data-step-id="${rawCommandStep.id}"]`).getByRole('button', { name: '复制步骤', exact: true }).click();
  await expect.poll(async () => (await parse((await template(interactionId)).draft_markdown)).steps.length).toBe(3);
  const withCopy = await parse((await template(interactionId)).draft_markdown);
  assert.deepEqual(withCopy.diagnostics, []);
  const copiedStep = withCopy.steps.find(step => !originalStepIds.includes(step.id));
  assert.ok(copiedStep, 'Copy creates a new step identity');
  assert.equal(new Set(withCopy.steps.map(step => step.id)).size, 3);
  assert.equal(copiedStep.commands[0].text, rawCommandStep.commands[0].text);
  assert.notEqual(copiedStep.commands[0].id, rawCommandStep.commands[0].id, 'Copied commands also receive new identities');
  const copiedCard = visual.locator(`.visual-step[data-step-id="${copiedStep.id}"]`);
  const expectedOrder = withCopy.steps.map(step => step.id), copyIndex = expectedOrder.indexOf(copiedStep.id);
  assert.equal(expectedOrder[copyIndex - 1], rawCommandStep.id, 'New copy starts immediately after its original');
  [expectedOrder[copyIndex - 1], expectedOrder[copyIndex]] = [expectedOrder[copyIndex], expectedOrder[copyIndex - 1]];
  await copiedCard.getByRole('button', { name: '上移步骤', exact: true }).click();
  await expect.poll(async () => (await parse((await template(interactionId)).draft_markdown)).steps.map(step => step.id)).toEqual(expectedOrder);
  const movedCopy = (await parse((await template(interactionId)).draft_markdown)).steps.find(step => step.id === copiedStep.id);
  assert.equal(movedCopy.commands[0].id, copiedStep.commands[0].id, 'Moving preserves command and step identities');
  await copiedCard.getByRole('button', { name: '删除步骤', exact: true }).click();
  await expect.poll(async () => (await parse((await template(interactionId)).draft_markdown)).steps.map(step => step.id)).toEqual(originalStepIds);
  checks.push('step card copy gives unique step/command IDs; move preserves IDs; removing the copy leaves the original two steps');
  await capture('interactive-template');
  checks.push('variable cancel/creation, variable-atom command conversion, visual step/checkpoint creation');

  const sourceTemplate = await template(interactionId), instanceName = '可视编辑独立实例';
  await page.getByRole('button', { name: '创建执行实例', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: '创建独立执行实例', exact: true });
  await createDialog.getByRole('textbox').first().fill(instanceName);
  await createDialog.getByLabel('参数 HOST', { exact: true }).fill('prod-a');
  await createDialog.getByRole('button', { name: '创建并开始记录', exact: true }).click();
  await expect(page.locator('.execution-workspace')).toBeVisible();
  const created = (await workspace()).runs.find(item => item.name === instanceName), runId = created.id;
  const commandStep = created.steps.find(step => step.step_id === rawCommandStep.id);
  assert.equal(commandStep.definition.commands[0].text, 'echo prod-a');
  await page.locator('.run-outline-item').filter({ hasText: commandStep.definition.title }).click();
  await page.getByRole('button', { name: '标记完成', exact: true }).click();
  await expect(page.getByText('本步骤已完成', { exact: true })).toBeVisible();
  const completed = await run(runId), oldAttempt = completed.steps.find(step => step.step_id === commandStep.step_id).attempts[0];
  await page.locator('.workspace-header').getByRole('button', { name: '编辑实例', exact: true }).click();
  await assertVisualDefault();
  await page.getByLabel('参数 HOST', { exact: true }).fill('prod-b');
  const commandCard = visual.locator(`.visual-command-card[data-command-id="${rawCommandStep.commands[0].id}"]`);
  await commandCard.getByRole('button', { name: '编辑指令', exact: true }).click();
  await commandCard.getByRole('textbox', { name: '指令内容', exact: true }).fill('echo {{rb:HOST}}\n# 仅实例补充');
  await commandCard.getByRole('button', { name: '完成编辑', exact: true }).click();
  await expect.poll(async () => (await run(runId)).draft_markdown.includes('仅实例补充')).toBe(true);
  const draft = await run(runId);
  assert.equal(draft.applied_markdown, completed.applied_markdown, 'Visual edits remain a draft until explicit apply');
  assert.equal(draft.parameters.HOST, 'prod-a');
  assert.equal(draft.draft_parameters.HOST, 'prod-b');
  await page.getByRole('button', { name: '应用并返回执行', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '应用修改', exact: true }).click();
  await expect(page.locator('.execution-workspace')).toBeVisible();
  const applied = await run(runId), appliedStep = applied.steps.find(step => step.step_id === commandStep.step_id);
  assert.equal(applied.parameters.HOST, 'prod-b');
  assert.equal(appliedStep.definition.commands[0].text, 'echo prod-b\n# 仅实例补充');
  assert.equal(appliedStep.status, 'pending');
  assert.equal(appliedStep.content_version, commandStep.content_version + 1);
  assert.deepEqual(appliedStep.attempts[0], oldAttempt, 'Old result, command and parameter snapshots remain immutable');
  assert.equal(oldAttempt.parameters.HOST, 'prod-a');
  assert.equal(oldAttempt.step_snapshot.commands[0].text, 'echo prod-a');
  assert.deepEqual(applied.initial_template_snapshot, created.initial_template_snapshot);
  assert.deepEqual(await template(interactionId), sourceTemplate, 'Instance edits do not change their source template');
  await mutate({ type: 'save_template', id: interactionId, name: interactionName, description: '模板后续调整', markdown: sourceTemplate.draft_markdown + '\n\n模板后续说明。' });
  assert.deepEqual(await run(runId), applied, 'Later template edits do not overwrite the independent instance');
  await capture('instance-history');
  checks.push('instance draft/apply, changed step reset, immutable old attempt/parameters, bidirectional template isolation');

  const clipboardTemplateIds = await checkClipboard();
  await checkLongDocumentAndReadonly(fidelityId, fidelityName);
  await mutate({ type: 'archive_template', id: interactionId, archived: true });
  assert.ok((await template(fidelityId)).archived && (await template(interactionId)).archived);
  assert.deepEqual(await run(runId), applied, 'Archiving either source template does not alter execution history');
  assert.deepEqual(pageErrors, []);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  const result = { ok: true, isolatedDataDirectory: directory, checks, pageErrors, templateIds: [fidelityId, interactionId], clipboardTemplateIds, runId };
  await writeFile('.artifacts/visual-check.json', JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  await capture('failure').catch(() => {});
  console.error(JSON.stringify({ checks, pageErrors }));
  throw error;
} finally { await browser.close(); }
