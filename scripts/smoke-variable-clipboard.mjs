// RUNBOOK_CLIPBOARD_TEST_MODE=transport node scripts/check-desktop.mjs scripts/smoke-variable-clipboard.mjs
// Captures the real write_html IPC and pastes its exact two formats into WebView2.
// No operating-system clipboard read/write and no maintenance-command execution.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && process.env.RUNBOOK_DATA_DIR === directory && process.env.RUNBOOK_CDP_URL);
assert.equal(process.env.RUNBOOK_CLIPBOARD_TEST_MODE, 'transport', 'This test requires explicit transport mode and never accesses the OS clipboard');
const actual = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase()); assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actual}`));
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(15000);
const checks = [], writes = [], pageErrors = [], geometries = []; let hookInstalls = 0;
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), workspace = () => native('checklist_load');
const templateId = 'qa-variable-clipboard-template', runId = 'qa-variable-clipboard-run';
const template = async () => (await workspace()).templates.find(item => item.id === templateId), run = async () => (await workspace()).instances.find(item => item.id === runId);
const ids = { global: 'clipboard-env', a: 'clipboard-player-a', b: 'clipboard-player-b', step: 'clipboard-note', retired: 'clipboard-retired' };
const playerName = '玩家 <ID> & "号"';
const documentFixture = {
  groups: [{ id: 'clipboard-group-a', name: '玩家 A' }, { id: 'clipboard-group-b', name: '玩家 B' }],
  parameters: [
    { id: ids.global, name: '环境', description: '全局文本值。', defaultValue: 'release' },
    { id: ids.a, ownerId: 'clipboard-group-a', name: playerName, description: 'A 组独立身份。', defaultValue: 'PLAYER-A' },
    { id: ids.b, ownerId: 'clipboard-group-b', name: playerName, description: 'B 组同名但身份不同。', defaultValue: 'PLAYER-B' },
    { id: ids.step, ownerId: 'clipboard-a-first', name: '本步备注', description: '仅本步骤。', defaultValue: 'STEP-A' },
    { id: ids.retired, name: '待删除引用', description: '用于复制后定义消失的边界。', defaultValue: 'UNUSED' },
  ],
  steps: [
    { id: 'clipboard-a-first', groupId: 'clipboard-group-a', title: ['TITLE SLOT SUFFIX SLOT'], description: ['DESC SLOT SUFFIX'], commands: [{ id: 'clipboard-c-a', text: ['printf "SLOT" --suffix {{literal}}'] }] },
    { id: 'clipboard-a-second', groupId: 'clipboard-group-a', title: ['A 后续核验'], description: ['FOLLOW SLOT END'], commands: [{ id: 'clipboard-c-next', text: ['follow SLOT END'] }] },
    { id: 'clipboard-b-first', groupId: 'clipboard-group-b', title: ['B 独立核验'], description: ['B DESC SLOT'], commands: [{ id: 'clipboard-c-b', text: ['B SLOT END'] }] },
  ],
};
const step = id => page.locator(`[data-step-id="${id}"]`), panel = () => page.getByRole('complementary', { name: '变量面板', exact: true });
const row = id => panel().locator(`[data-variable-id="${id}"]`), inline = (id, label) => step(id).locator(`[data-inline-field="${label}"]`);
const storedStep = (value, id) => value.document.steps.find(item => item.id === id);
const ref = parameterId => ({ parameterId });
async function transport() {
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window); window.__variableClipboardSmoke = { writes: [], probes: 0 };
    const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'http://ipc.localhost' && !(url.protocol === 'ipc:' && url.hostname === 'localhost')) return originalFetch(input, init);
      const command = decodeURIComponent(url.pathname.slice(1)), args = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (command === 'variable_clipboard_smoke_probe') { window.__variableClipboardSmoke.probes++; return reply(true); }
      if (command === 'plugin:clipboard-manager|write_html') {
        if (typeof args.html !== 'string' || typeof args.altText !== 'string') throw new Error('Expected HTML and plain fallback in the real clipboard IPC');
        window.__variableClipboardSmoke.writes.push(structuredClone(args)); return reply(null);
      }
      if (command.startsWith('plugin:clipboard-manager|')) throw new Error('Unexpected OS clipboard operation in transport-only test');
      return originalFetch(input, init);
    };
  });
  assert.equal(await native('variable_clipboard_smoke_probe'), true); assert.equal(await page.evaluate(() => window.__variableClipboardSmoke.probes), 1); hookInstalls++;
}
async function reload() { await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor(); await transport(); }
async function saved(predicate, expectedStatus = '已保存在本机') { await expect.poll(predicate).toBe(true); await expect(page.locator('.save-state')).toHaveClass('save-state idle'); await expect(page.locator('.save-state')).toContainText(expectedStatus); }
async function locate(id) { await page.locator(`[data-nav-step-id="${id}"]`).click(); await expect(panel()).toHaveAttribute('data-variable-target-step-id', id); await expect(step(id).locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true'); }
async function edit(id, label, key) {
  const editor = step(id).getByRole('textbox', { name: label, exact: true });
  if (!await editor.count()) { if (key) { await inline(id, label).focus(); await inline(id, label).press(key); } else await inline(id, label).dblclick(); }
  await expect(editor).toBeVisible(); return editor;
}
async function select(editor, literal, collapsed = false) {
  await editor.focus(); await editor.evaluate((element, { literal, collapsed }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('[data-parameter-id]')) continue;
      const index = node.textContent.indexOf(literal); if (index < 0) continue;
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + (collapsed ? 0 : literal.length));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return;
    }
    throw new Error(`Plain selection missing: ${literal}`);
  }, { literal, collapsed });
}
async function copyVariable(id) {
  const definition = (await run()).document.parameters.find(item => item.id === id); assert.ok(definition);
  const button = row(id).getByRole('button', { name: `复制变量引用 ${definition.name}`, exact: true });
  await expect(button).toBeEnabled(); assert.equal((await button.innerText()).trim(), '', 'The panel copy entry must be an icon without a redundant text action');
  const before = await page.evaluate(() => window.__variableClipboardSmoke.writes.length); await button.click();
  await expect.poll(() => page.evaluate(() => window.__variableClipboardSmoke.writes.length)).toBe(before + 1);
  const payload = await page.evaluate(() => window.__variableClipboardSmoke.writes.at(-1));
  assert.deepEqual(Object.keys(payload).sort(), ['altText', 'html']); assert.equal(payload.altText, `{{${definition.name}}}`);
  const parsed = await page.evaluate(html => { const doc = new DOMParser().parseFromString(html, 'text/html'); const element = doc.body.firstElementChild; return { count: doc.body.children.length, tag: element?.tagName, version: element?.getAttribute('data-runbook-variable-ref'), id: element?.getAttribute('data-parameter-id'), text: element?.textContent, children: element?.children.length, attrs: element ? [...element.attributes].map(item => item.name).sort() : [] }; }, payload.html);
  assert.deepEqual(parsed, { count: 1, tag: 'SPAN', version: '1', id, text: definition.name, children: 0, attrs: ['data-parameter-id', 'data-runbook-variable-ref'] });
  writes.push({ id, ...payload }); return payload;
}
async function paste(editor, payload, expectedSelection) {
  const selected = await editor.evaluate((element, payload) => {
    element.focus(); const selection = window.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !element.contains(range.startContainer) || !element.contains(range.endContainer)) throw new Error('Paste must use the actual selection in this field');
    const before = selection.toString(), data = new DataTransfer(); data.setData('text/html', payload.html); data.setData('text/plain', payload.altText);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); return before;
  }, payload);
  assert.equal(selected, expectedSelection);
}
async function assertUnchanged(before) { assert.deepEqual(await run(), before); }
async function geometry(label) {
  const metrics = await panel().evaluate(element => { const r = element.getBoundingClientRect(), root = document.querySelector('.workspace-scroll'); return { viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, documentWidth: document.documentElement.scrollWidth }, panel: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }, body: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth }, copyIcons: element.querySelectorAll('button[aria-label^="复制变量引用 "]').length, reuseButtons: element.querySelectorAll('button[aria-label^="复用变量 "]').length }; });
  await writeFile(`.artifacts/variable-clipboard-${label}-geometry.json`, JSON.stringify(metrics, null, 2), 'utf8'); await page.screenshot({ path: `.artifacts/variable-clipboard-${label}.png` });
  assert.equal(metrics.viewport.scrollX, 0); assert.equal(metrics.viewport.scrollY, 0); assert.equal(metrics.reuseButtons, 0); assert.ok(metrics.copyIcons >= 3);
  assert.ok(metrics.panel.left >= 0 && metrics.panel.top >= 0 && metrics.panel.right <= metrics.viewport.width + 1 && metrics.panel.bottom <= metrics.viewport.height + 1);
  assert.ok(metrics.panel.scrollWidth <= metrics.panel.clientWidth + 1 && metrics.body.scrollWidth <= metrics.body.clientWidth + 1 && metrics.viewport.documentWidth <= metrics.viewport.width + 1); geometries.push({ label, ...metrics });
}

try {
  await mkdir('.artifacts', { recursive: true }); await page.setViewportSize({ width: 1360, height: 940 });
  await apply({ type: 'create_template', id: templateId, name: 'QA 变量引用剪贴板', document: documentFixture }); await apply({ type: 'create_instance', id: runId, name: 'QA 引用粘贴实例', templateId, fromInstanceId: null });
  await reload(); await page.locator(`[data-instance-id="${runId}"]`).click(); await locate('clipboard-a-first');
  const originalTemplate = await template(), initial = await run();
  await expect(panel().getByRole('button', { name: /^复用变量 / })).toHaveCount(0);
  const retiredPayload = await copyVariable(ids.retired); await assertUnchanged(initial);
  let editor = await edit('clipboard-a-first', '步骤标题', 'F2'); await select(editor, 'SLOT'); const aPayload = await copyVariable(ids.a);
  await expect(editor).toBeVisible(); await paste(editor, aPayload, 'SLOT'); await expect(editor.locator(`[data-parameter-id="${ids.a}"]`)).toHaveCount(1); await editor.press('Escape');
  await saved(async () => storedStep(await run(), 'clipboard-a-first').title.some(item => item.parameterId === ids.a));
  assert.deepEqual(storedStep(await run(), 'clipboard-a-first').title, ['TITLE ', ref(ids.a), ' SUFFIX SLOT']);
  editor = await edit('clipboard-a-first', '操作说明', 'Enter'); await select(editor, 'SLOT'); const globalPayload = await copyVariable(ids.global); await paste(editor, globalPayload, 'SLOT'); await editor.press('Control+Enter');
  await saved(async () => storedStep(await run(), 'clipboard-a-first').description.some(item => item.parameterId === ids.global));
  assert.deepEqual(storedStep(await run(), 'clipboard-a-first').description, ['DESC ', ref(ids.global), ' SUFFIX']);
  editor = await edit('clipboard-a-first', '命令 1'); await select(editor, 'SLOT'); const stepPayload = await copyVariable(ids.step); await paste(editor, stepPayload, 'SLOT'); await editor.press('Control+Enter');
  await saved(async () => storedStep(await run(), 'clipboard-a-first').commands[0].text.some(item => item.parameterId === ids.step));
  assert.deepEqual(storedStep(await run(), 'clipboard-a-first').commands[0].text, ['printf "', ref(ids.step), '" --suffix {{literal}}']);
  assert.deepEqual((await run()).document.parameters, initial.document.parameters); assert.deepEqual((await run()).parameterValues, initial.parameterValues); assert.deepEqual((await run()).entries, []); assert.equal((await run()).currentStepId, null);
  checks.push('Panel icon emits a single escaped HTML stable-ID span plus readable plain fallback through real write_html IPC; pasting its exact captured formats into title/description/command replaces only the selected occurrence, preserves quotes/suffix/literal braces and all definitions/defaults/values, and never creates or applies a parameter');

  for (const viewport of [{ width: 1360, height: 940 }, { width: 940, height: 640 }]) { await page.setViewportSize(viewport); await locate('clipboard-a-first'); await geometry(`panel-${viewport.width}`); }
  await page.setViewportSize({ width: 1360, height: 940 }); await locate('clipboard-b-first');
  await expect(row(ids.a)).toHaveCount(0); editor = await edit('clipboard-b-first', '命令 1'); await select(editor, 'SLOT');
  const beforeForeign = await run(); await paste(editor, aPayload, 'SLOT'); await expect(step('clipboard-b-first').locator('[data-variable-paste-error]')).toContainText('不属于当前步骤范围'); await assertUnchanged(beforeForeign);
  assert.equal(await editor.innerText(), 'B SLOT END'); await select(editor, 'SLOT'); const bPayload = await copyVariable(ids.b); assert.notEqual(bPayload.html, aPayload.html); assert.equal(bPayload.altText, aPayload.altText);
  await paste(editor, bPayload, 'SLOT'); await editor.press('Control+Enter'); await saved(async () => storedStep(await run(), 'clipboard-b-first').commands[0].text.some(item => item.parameterId === ids.b));
  assert.deepEqual(storedStep(await run(), 'clipboard-b-first').commands[0].text, ['B ', ref(ids.b), ' END']);
  await row(ids.retired).getByRole('button', { name: '删除变量 待删除引用', exact: true }).click(); await saved(async () => !(await run()).document.parameters.some(item => item.id === ids.retired));
  editor = await edit('clipboard-b-first', '操作说明'); await select(editor, 'SLOT'); const beforeMissing = await run(); await paste(editor, retiredPayload, 'SLOT');
  await expect(step('clipboard-b-first').locator('[data-variable-paste-error]')).toContainText('此变量不存在'); await assertUnchanged(beforeMissing); assert.equal(await editor.innerText(), 'B DESC SLOT');
  await select(editor, 'SLOT'); await paste(editor, { html: '<b data-external="1">外部 HTML 不应插入</b>', altText: '{{环境}}' }, 'SLOT'); await editor.press('Control+Enter');
  await saved(async () => JSON.stringify(storedStep(await run(), 'clipboard-b-first').description) === JSON.stringify(['B DESC {{环境}}']));
  assert.deepEqual(storedStep(await run(), 'clipboard-b-first').description, ['B DESC {{环境}}']); await expect(step('clipboard-b-first').locator('[data-external]')).toHaveCount(0);
  checks.push('Same-name variables remain isolated by owner/ID: a copied A reference is rejected in B without any write, B inserts its own identity, a deleted identity is rejected intact, and ordinary HTML/plain {{name}} stays literal without external HTML insertion or name-based rebinding');

  await page.getByRole('button', { name: '开始记录', exact: true }).click(); await expect.poll(async () => (await run()).currentStepId).toBe('clipboard-a-first'); await locate('clipboard-a-first');
  const beforeDraft = await run(); await row(ids.global).locator('input[data-parameter-id]').fill('UNAPPLIED-DRAFT');
  const appliedPayload = await copyVariable(ids.global); assert.equal(appliedPayload.html, globalPayload.html); await assertUnchanged(beforeDraft);
  await expect(row(ids.global).locator('input')).toHaveValue('UNAPPLIED-DRAFT'); await expect(row(ids.global).locator('[data-variable-value]')).toHaveText('release');
  editor = await edit('clipboard-a-first', '命令 1'); await select(editor, '--suffix', true); await paste(editor, appliedPayload, ''); await editor.press('Control+Enter');
  await saved(async () => storedStep(await run(), 'clipboard-a-first').commands[0].text.some(item => item.parameterId === ids.global), '草稿已保留');
  assert.deepEqual(storedStep(await run(), 'clipboard-a-first').commands[0].text, ['printf "', ref(ids.step), '" ', ref(ids.global), '--suffix {{literal}}']);
  await expect(inline('clipboard-a-first', '命令 1')).toHaveText('printf "STEP-A" release--suffix {{literal}}'); assert.equal((await run()).parameterValues[ids.global], 'release');
  await expect(row(ids.global).locator('input')).toHaveValue('UNAPPLIED-DRAFT'); await panel().locator('[data-parameter-scope="global"]').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await apply({ type: 'record_result', id: runId, outcome: 'failed', reason: 'QA 人工结果快照，不执行命令。' }); const failed = (await run()).entries.find(item => item.type === 'result');
  const afterFailure = await run(); await apply({ type: 'apply_parameters', id: runId, values: { ...afterFailure.parameterValues, [ids.global]: 'sandboxa' } }); await apply({ type: 'record_result', id: runId, outcome: 'completed', reason: null });
  await reload(); await page.locator(`[data-instance-id="${runId}"]`).click(); await locate('clipboard-a-first');
  const frozen = await run(); assert.deepEqual(frozen.entries.find(item => item.id === failed.id), failed); assert.equal(failed.snapshot.commands[0].text, 'printf "STEP-A" release--suffix {{literal}}');
  await expect(inline('clipboard-a-first', '命令 1')).toHaveText('printf "STEP-A" sandboxa--suffix {{literal}}'); await expect(row(ids.global).locator('[data-variable-value]')).toHaveText('sandboxa');
  await copyVariable(ids.a);
  for (const label of ['步骤标题', '操作说明', '命令 1']) {
    const display = inline('clipboard-a-first', label); await display.dblclick(); await expect(step('clipboard-a-first').getByRole('textbox', { name: label, exact: true })).toHaveCount(0);
    await display.evaluate((element, payload) => { const data = new DataTransfer(); data.setData('text/html', payload.html); data.setData('text/plain', payload.altText); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, globalPayload);
  }
  await assertUnchanged(frozen); assert.deepEqual(await template(), originalTemplate);
  checks.push('Copy and paste leave other-scope drafts unapplied and preserve defaults; a collapsed current-command caret inserts only the stable reference and displays the applied value. Failure snapshots retain release, later completion retains sandboxa, and progressed fields reject editing/paste while their reference copy icons remain available');
  assert.ok(writes.length > 0 && hookInstalls > 0); assert.deepEqual(pageErrors, []); await expect(page.getByRole('alert')).toHaveCount(0);
  const result = { ok: true, isolatedDataDirectory: actual, templateId, runId, checks, geometries, writes, clipboardWriteCount: writes.length, hookInstalls, pageErrors, clipboardMode: 'transport', clipboardTouched: false, systemClipboardVerified: false, pasteUsesCapturedFormats: true, maintenanceCommandsExecuted: false };
  await writeFile('.artifacts/variable-clipboard-check.json', JSON.stringify(result, null, 2), 'utf8'); console.log(JSON.stringify(result));
} catch (error) {
  const state = await page.evaluate(() => ({ focus: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }, selection: window.getSelection()?.toString(), editors: [...document.querySelectorAll('[contenteditable]')].map(node => ({ label: node.getAttribute('aria-label'), html: node.innerHTML })), pasteErrors: [...document.querySelectorAll('[data-variable-paste-error]')].map(node => node.textContent), panel: document.querySelector('[data-variable-panel]')?.outerHTML, save: document.querySelector('.save-state')?.textContent })).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/variable-clipboard-failure.json', JSON.stringify({ error: String(error), checks, writes, pageErrors, state, workspace: await workspace().catch(() => null) }, null, 2), 'utf8').catch(() => {}); await page.screenshot({ path: '.artifacts/variable-clipboard-failure.png' }).catch(() => {}); throw error;
} finally { await browser.close(); }
