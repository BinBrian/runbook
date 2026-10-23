// RUNBOOK_CLIPBOARD_TEST_MODE=transport node scripts/check-desktop.mjs scripts/smoke-inline-commands.mjs
// Isolated native records; clipboard write IPC only. Commands never execute.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && process.env.RUNBOOK_DATA_DIR === directory && process.env.RUNBOOK_CDP_URL);
assert.equal(process.env.RUNBOOK_CLIPBOARD_TEST_MODE, 'transport', 'Use explicit transport mode; this test must never access the OS clipboard');
const actual = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase()); assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actual}`));
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(15000);
const checks = [], geometryChecks = [], copies = [], pageErrors = []; let hookInstalls = 0;
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }); const workspace = () => native('checklist_load');
const templateId = 'qa-inline-command-template', runId = 'qa-inline-command-run';
const template = async () => (await workspace()).templates.find(item => item.id === templateId), run = async () => (await workspace()).instances.find(item => item.id === runId);
const step = id => page.locator(`[data-step-id="${id}"]`), card = id => page.locator(`[data-command-id="${id}"]`);
const field = id => card(id).locator('[data-inline-field]'), panel = () => page.getByRole('complementary', { name: '变量面板', exact: true });
const globalId = 'inline-env', ref = parameterId => ({ parameterId });
const strings = parts => parts.filter(part => typeof part === 'string').join(''), refs = (parts, id) => parts.filter(part => typeof part !== 'string' && part.parameterId === id).length;
const commands = (document, stepId) => document.steps.find(item => item.id === stepId).commands;
const command = (document, id) => document.steps.flatMap(step => step.commands).find(item => item.id === id);
const exact = '  Write-Output "{{literal}} { $_.Name } 中文😀"  \r\n\r\n  done  \r\n';
const initialDocument = { parameters: [{ id: globalId, name: 'ENVIRONMENT', description: '默认值与本次应用值分开。', defaultValue: 'release' }],
  groups: [{ id: 'inline-group-a', name: '主流程' }, { id: 'inline-group-b', name: '后续检查' }], steps: [
    { id: 'inline-first', groupId: 'inline-group-a', title: ['当前核验'], description: ['人工确认，不执行命令。'], commands: [{ id: 'inline-c1', text: ['initial ', ref(globalId)] }, { id: 'inline-c2', text: ['second ', ref(globalId)] }] },
    { id: 'inline-next', groupId: 'inline-group-a', title: ['后续核验'], description: [''], commands: [{ id: 'inline-next-c', text: ['sync ', ref(globalId)] }] },
    { id: 'inline-manual', groupId: 'inline-group-b', title: ['人工步骤可添加命令'], description: [''], commands: [] },
    { id: 'inline-tail', groupId: 'inline-group-b', title: ['可调整后续步骤'], description: [''], commands: [{ id: 'inline-tail-c', text: ['tail'] }] },
  ] };
async function transport() {
  await page.evaluate(() => {
    const fetch = window.fetch.bind(window); window.__inlineCommandSmoke = { writes: [], probes: 0 };
    const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'http://ipc.localhost' && !(url.protocol === 'ipc:' && url.hostname === 'localhost')) return fetch(input, init);
      const command = decodeURIComponent(url.pathname.slice(1)), args = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (command === 'inline_command_smoke_probe') { window.__inlineCommandSmoke.probes++; return reply(true); }
      if (command === 'plugin:clipboard-manager|write_text') {
        if (typeof args.text !== 'string') throw new Error('Expected exact clipboard text payload');
        window.__inlineCommandSmoke.writes.push(structuredClone(args)); return reply(null);
      }
      if (command.startsWith('plugin:clipboard-manager|')) throw new Error('Unexpected OS clipboard operation in transport-only test');
      return fetch(input, init);
    };
  });
  assert.equal(await native('inline_command_smoke_probe'), true); assert.equal(await page.evaluate(() => window.__inlineCommandSmoke.probes), 1); hookInstalls++;
}
async function reload() { await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor(); await transport(); }
async function saved(predicate) { await expect.poll(predicate).toBe(true); await expect(page.locator('.save-state')).toContainText('已保存在本机'); }
async function locate(id) { await page.locator(`[data-nav-step-id="${id}"]`).click(); await expect(step(id).locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true'); }
async function edit(id, entry = 'double') {
  const input = card(id).getByRole('textbox');
  if (!await input.count()) { if (entry === 'double') await field(id).dblclick(); else { await field(id).focus(); await field(id).press(entry); } }
  await expect(input).toBeVisible(); return input;
}
async function openMenu(trigger) {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.evaluate(() => new Promise(resolve => { const root = document.querySelector('.workspace-scroll'); let prior, stable = 0, frames = 0; function check() { const current = root.scrollTop; stable = prior !== undefined && Math.abs(current - prior) < .25 ? stable + 1 : 0; prior = current; if (stable >= 3 || ++frames > 180) resolve(); else requestAnimationFrame(check); } requestAnimationFrame(check); }));
  await trigger.click(); const menu = page.getByRole('menu'); await expect(menu).toBeVisible(); return menu;
}
async function stepAction(id, label) { await locate(id); const more = ['上移步骤', '下移步骤', '删除步骤', '删除当前步骤'].includes(label), name = label === '删除步骤' ? '删除当前步骤' : label; const menu = await openMenu(step(id).getByRole('button', { name: more ? '更多步骤操作' : '步骤新增', exact: true })); await menu.getByRole('menuitem', { name, exact: true }).click(); await expect(menu).toHaveCount(0); }
async function commandAction(id, label) { const menu = await openMenu(card(id).getByRole('button', { name: '命令操作', exact: true })); await menu.getByRole('menuitem', { name: label, exact: true }).click(); await expect(menu).toHaveCount(0); }
async function assertCopy(id, expected) {
  const before = await page.evaluate(() => window.__inlineCommandSmoke.writes.length);
  await card(id).getByRole('button', { name: '复制命令', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__inlineCommandSmoke.writes.length)).toBe(before + 1);
  const payload = await page.evaluate(() => window.__inlineCommandSmoke.writes.at(-1)); assert.equal(payload.text, expected); copies.push({ commandId: id, ...payload });
}
async function pasteExact(editor, text) {
  await editor.evaluate((element, text) => { element.focus(); const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); const data = new DataTransfer(); data.setData('text/plain', text); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, text);
}
async function insertVariable(editor, prefix) {
  await pasteExact(editor, prefix);
  assert.equal(await editor.textContent(), prefix, 'The query fixture must preserve the exact trailing delimiter after replacing a CRLF document');
  await editor.pressSequentially('{{ENVIRONMENT');
  const menu = page.getByRole('listbox', { name: '变量建议', exact: true }); await expect(menu).toBeVisible(); await menu.locator(`[role="option"][data-parameter-id="${globalId}"]`).click();
}
async function selectLiteral(editor, literal) {
  await editor.focus(); await editor.evaluate(async (element, literal) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let text;
    while ((text = walker.nextNode())) { if (text.parentElement.closest('[data-parameter-id]')) continue; const index = text.textContent.indexOf(literal); if (index < 0) continue;
      const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + literal.length); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const r = range.getBoundingClientRect(), f = element.getBoundingClientRect(); if (r.top < f.top + 10) element.scrollTop += r.top - f.top - 10; else if (r.bottom > f.top + element.clientHeight - 10) element.scrollTop += r.bottom - f.top - element.clientHeight + 10;
      const root = element.closest('.workspace-scroll'); root.scrollTo({ top: root.scrollTop + element.getBoundingClientRect().top - root.getBoundingClientRect().top - 36, behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return;
    } throw new Error('Selection literal missing');
  }, literal);
}
async function layout(id, label, editing = false) {
  const metrics = await card(id).evaluate(element => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }; };
    const field = element.querySelector('[data-inline-field]'), actions = element.querySelector('[data-command-header]'), editor = field.querySelector('[contenteditable]');
    const headerStyle = getComputedStyle(actions), content = editor ?? field, contentStyle = getComputedStyle(content);
    const rects = []; const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT); let text;
    while ((text = walker.nextNode())) if (text.textContent.trim()) { const range = document.createRange(); range.selectNodeContents(text); rects.push(...range.getClientRects()); }
    const firstTop = Math.min(...rects.map(r => r.top)), first = rects.filter(r => Math.abs(r.top - firstTop) < 3);
    const root = document.querySelector('.workspace-scroll');
    return { viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, documentWidth: document.documentElement.scrollWidth }, card: rect(element), field: rect(field), actions: rect(actions), workspace: rect(root), editor: editor ? rect(editor) : null,
      firstLine: first.length ? { top: Math.min(...first.map(r => r.top)), bottom: Math.max(...first.map(r => r.bottom)), right: Math.max(...first.map(r => r.right)) } : null,
      headerBackground: headerStyle.backgroundColor, headerText: actions.innerText, headerContentLeft: actions.getBoundingClientRect().left + parseFloat(headerStyle.paddingLeft), headerContentRight: actions.getBoundingClientRect().right - parseFloat(headerStyle.paddingRight),
      contentLeft: content.getBoundingClientRect().left + parseFloat(contentStyle.paddingLeft), contentRight: content.getBoundingClientRect().right - parseFloat(contentStyle.paddingRight), buttons: [...actions.querySelectorAll('button')].map(rect),
      text: element.innerText, terminalIcons: element.querySelectorAll('.lucide-terminal').length };
  });
  await writeFile(`.artifacts/inline-commands-${label}-geometry.json`, JSON.stringify(metrics, null, 2), 'utf8'); await page.screenshot({ path: `.artifacts/inline-commands-${label}.png` });
  assert.equal(metrics.viewport.scrollX, 0); assert.equal(metrics.viewport.scrollY, 0); assert.equal(metrics.terminalIcons, 0);
  assert.ok(!metrics.text.split(/\r?\n/).some(line => /^命令\s*\d+\s*$/.test(line.trim())), 'Commands must not render a redundant visible numbered title');
  assert.ok(metrics.card.scrollWidth <= metrics.card.clientWidth + 1 && metrics.workspace.scrollWidth <= metrics.workspace.clientWidth + 1 && metrics.viewport.documentWidth <= metrics.viewport.width + 1);
  assert.ok(metrics.actions.left >= metrics.card.left && metrics.actions.right <= metrics.card.right && metrics.actions.top >= metrics.card.top && metrics.actions.top <= metrics.card.top + 2, 'The shared action header must start at the card top');
  const channels = metrics.headerBackground.match(/[\d.]+/g)?.map(Number), dark = await page.locator('html').getAttribute('data-theme') === 'dark';
  assert.ok(channels?.length >= 3 && channels.slice(0, 3).every(value => dark ? value >= 30 && value <= 55 : value >= 225 && value <= 252) && Math.max(...channels.slice(0, 3)) - Math.min(...channels.slice(0, 3)) <= 3 && (channels.length < 4 || channels[3] === 1), 'Commands retain a visible neutral header in the active theme');
  assert.ok(metrics.buttons.every(button => button.top >= metrics.actions.top && button.bottom <= metrics.actions.bottom && button.right <= metrics.headerContentRight + 1));
  assert.ok(Math.abs(metrics.contentLeft - metrics.headerContentLeft) <= 2 && Math.abs(metrics.contentRight - metrics.headerContentRight) <= 2, 'Header and command body use aligned horizontal insets');
  if (!editing) { assert.ok(metrics.firstLine && metrics.firstLine.top >= metrics.actions.bottom - 1, 'The first command line must stay below the gray action header without overlap'); }
  else assert.ok(metrics.editor && metrics.editor.top >= metrics.workspace.top - 1 && metrics.editor.bottom <= metrics.workspace.bottom + 1 && metrics.editor.left >= metrics.workspace.left && metrics.editor.right <= metrics.workspace.right);
  geometryChecks.push({ label, width: metrics.viewport.width, height: metrics.viewport.height });
}

try {
  await mkdir('.artifacts', { recursive: true }); await page.setViewportSize({ width: 1360, height: 940 });
  await apply({ type: 'create_template', id: templateId, name: 'QA 原位命令', document: initialDocument }); await apply({ type: 'create_instance', id: runId, name: 'QA 原位命令实例', templateId, fromInstanceId: null });
  await reload(); await page.locator(`[data-instance-id="${runId}"]`).click(); await locate('inline-first');
  const originalTemplate = await template();
  await expect(page.getByRole('button', { name: '编辑本步骤', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '完成编辑', exact: true })).toHaveCount(0);
  await expect(card('inline-c1').getByRole('textbox')).toHaveCount(0); await assertCopy('inline-c1', 'initial release');
  let editor = await edit('inline-c1'); await pasteExact(editor, exact); await assertCopy('inline-c1', exact);
  await saved(async () => strings(command((await run()).document, 'inline-c1').text) === exact); assert.deepEqual(command((await run()).document, 'inline-c1').text, [exact]);
  editor = await edit('inline-c2', 'F2'); await insertVariable(editor, 'second '); await assertCopy('inline-c2', 'second release');
  await saved(async () => refs(command((await run()).document, 'inline-c2').text, globalId) === 1);
  const beforeAdd = await run(); await stepAction('inline-first', '添加命令');
  await saved(async () => commands((await run()).document, 'inline-first').length === 3);
  const added = commands((await run()).document, 'inline-first').find(item => !commands(beforeAdd.document, 'inline-first').some(old => old.id === item.id));
  assert.ok(added); assert.deepEqual(added.text, ['']); await expect(card(added.id).getByRole('textbox')).toBeFocused();
  editor = card(added.id).getByRole('textbox'); await insertVariable(editor, 'third '); await editor.press('Control+Enter');
  await saved(async () => refs(command((await run()).document, added.id).text, globalId) === 1);
  const three = commands((await run()).document, 'inline-first'), neighbors = (await run()).document.steps.filter(item => item.id !== 'inline-first');
  let menu = await openMenu(card('inline-c1').getByRole('button', { name: '命令操作', exact: true })); await expect(menu.getByRole('menuitem', { name: '上移命令', exact: true })).toBeDisabled(); await expect(menu.getByRole('menuitem', { name: '下移命令', exact: true })).toBeEnabled();
  const beforeCancel = await run(); await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); assert.deepEqual(await run(), beforeCancel);
  menu = await openMenu(card(added.id).getByRole('button', { name: '命令操作', exact: true })); await expect(menu.getByRole('menuitem', { name: '下移命令', exact: true })).toBeDisabled(); await page.keyboard.press('Escape');
  await commandAction(added.id, '上移命令'); await saved(async () => commands((await run()).document, 'inline-first')[1].id === added.id);
  assert.deepEqual(commands((await run()).document, 'inline-first'), [three[0], three[2], three[1]]);
  await commandAction(added.id, '下移命令'); await saved(async () => commands((await run()).document, 'inline-first')[2].id === added.id);
  assert.deepEqual(commands((await run()).document, 'inline-first'), three);
  await commandAction('inline-c2', '下移命令'); await saved(async () => commands((await run()).document, 'inline-first')[1].id === added.id);
  await commandAction(added.id, '删除命令'); await saved(async () => commands((await run()).document, 'inline-first').length === 2);
  assert.deepEqual(commands((await run()).document, 'inline-first'), [three[0], three[1]]); assert.deepEqual((await run()).document.steps.filter(item => item.id !== 'inline-first'), neighbors);
  assert.deepEqual(await template(), originalTemplate);
  checks.push('Draft commands edit directly by double-click/F2 with exact CRLF/blank/trailing text; copy remains available and flushes the field. Step plus adds an empty focused command, double braces insert the visible stable ID, three-command movement preserves exact IDs/text/references and adjacent steps, boundaries disable, middle deletion is exact and menu cancellation writes nothing');

  await locate('inline-next'); editor = await edit('inline-next-c', 'Enter'); await insertVariable(editor, 'future '); await editor.press('Control+Enter');
  await saved(async () => strings(command((await run()).document, 'inline-next-c').text) === 'future ');
  await locate('inline-manual'); await stepAction('inline-manual', '添加命令'); await saved(async () => commands((await run()).document, 'inline-manual').length === 1);
  const longId = commands((await run()).document, 'inline-manual')[0].id; await expect(card(longId).getByRole('textbox')).toBeFocused();
  const longText = 'LONG_FIRST_LINE_' + 'unchanged-'.repeat(36) + '\n' + Array.from({ length: 85 }, (_, index) => `# inert line ${index + 1}\n`).join('') + 'TARGET TARGET';
  editor = card(longId).getByRole('textbox'); await editor.fill(longText); await editor.press('Control+Enter'); await saved(async () => strings(command((await run()).document, longId).text) === longText);
  const beforeGeometry = await run();
  for (const viewport of [{ width: 1360, height: 940 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(viewport); await locate('inline-manual');
    await card(longId).evaluate(element => { const root = element.closest('.workspace-scroll'); root.scrollTo({ top: root.scrollTop + element.getBoundingClientRect().top - root.getBoundingClientRect().top - 24, behavior: 'instant' }); });
    await layout(longId, `display-${viewport.width}`);
    editor = await edit(longId, 'F2'); await selectLiteral(editor, 'TARGET'); await layout(longId, `editing-${viewport.width}`, true);
    const beforePanel = await run(); await panel().getByLabel('搜索变量', { exact: true }).focus(); await expect(editor).toBeVisible();
    assert.deepEqual(await run(), beforePanel); await expect(page.getByRole('toolbar', { name: '选区变量操作', exact: true })).toBeVisible();
    await editor.press('Escape');
    if (await editor.count()) await editor.press('Control+Enter');
    await expect(field(longId)).toHaveClass(/is-display/);
  }
  assert.deepEqual(await run(), beforeGeometry);
  editor = await edit(longId); await selectLiteral(editor, 'TARGET');
  await page.getByRole('toolbar', { name: '选区变量操作', exact: true }).getByRole('button', { name: '使用变量', exact: true }).click();
  await page.getByRole('dialog', { name: '使用变量', exact: true }).locator(`.token-choice[data-parameter-id="${globalId}"]`).click(); await editor.press('Control+Enter');
  await saved(async () => refs(command((await run()).document, longId).text, globalId) === 1);
  assert.equal(strings(command((await run()).document, longId).text), longText.replace('TARGET', ''));
  checks.push('Future/manual steps edit without a mode switch; adding the first command opens its field. At 1360/940 long commands retain an aligned shallow-gray action header without visible number/Terminal, first-line text avoids controls, editors stay within the workspace, panel focus preserves the selected field, and variable insertion replaces only the selected occurrence');

  await page.setViewportSize({ width: 1360, height: 940 }); await page.getByRole('button', { name: '开始记录', exact: true }).click(); await expect(step('inline-first')).toHaveClass(/is-current/);
  await locate('inline-next'); editor = await edit('inline-next-c'); await insertVariable(editor, 'future run '); await editor.press('Control+Enter'); await saved(async () => strings(command((await run()).document, 'inline-next-c').text) === 'future run ');
  assert.equal((await run()).currentStepId, 'inline-first');
  const beforeStepMove = (await run()).document; await stepAction('inline-tail', '上移步骤'); await saved(async () => (await run()).document.steps[2].id === 'inline-tail');
  assert.deepEqual((await run()).document.steps.map(item => item.id), ['inline-first', 'inline-next', 'inline-tail', 'inline-manual']);
  await stepAction('inline-tail', '下移步骤'); await saved(async () => (await run()).document.steps[3].id === 'inline-tail'); assert.deepEqual((await run()).document, beforeStepMove);
  await stepAction('inline-tail', '删除步骤'); await saved(async () => (await run()).document.steps.length === 3); assert.ok(!(await run()).document.steps.some(item => item.id === 'inline-tail'));
  await locate('inline-first'); await step('inline-first').getByRole('button', { name: '记录失败', exact: true }).click();
  const failure = page.getByRole('dialog', { name: '记录失败', exact: true }); await failure.getByRole('textbox', { name: '失败原因', exact: true }).fill('QA 仅人工记录失败。'); await failure.getByRole('button', { name: '保存失败记录', exact: true }).click();
  await expect.poll(async () => (await run()).entries.filter(item => item.type === 'result').length).toBe(1); const failed = (await run()).entries.find(item => item.type === 'result'); assert.equal(failed.snapshot.commands[0].text, exact);
  await panel().locator(`input[data-parameter-id="${globalId}"]`).fill('sandboxa'); await panel().locator('[data-parameter-scope="global"]').getByRole('button', { name: '应用全局参数', exact: true }).click(); await expect.poll(async () => (await run()).parameterValues[globalId]).toBe('sandboxa');
  editor = await edit('inline-c1'); await insertVariable(editor, 'current '); await assertCopy('inline-c1', 'current sandboxa'); await saved(async () => refs(command((await run()).document, 'inline-c1').text, globalId) === 1);
  assert.deepEqual((await run()).entries.find(item => item.id === failed.id), failed);
  await step('inline-first').getByRole('button', { name: '完成并下一步', exact: true }).click(); await expect.poll(async () => (await run()).currentStepId).toBe('inline-next');
  const completed = (await run()).entries.filter(item => item.type === 'result').at(-1); assert.equal(completed.snapshot.commands.find(item => item.id === 'inline-c1').text, 'current sandboxa');
  await panel().locator(`input[data-parameter-id="${globalId}"]`).fill('ios-audit'); await panel().locator('[data-parameter-scope="global"]').getByRole('button', { name: '应用全局参数', exact: true }).click(); await expect.poll(async () => (await run()).parameterValues[globalId]).toBe('ios-audit');
  await locate('inline-first'); await expect(card('inline-c1').getByRole('button', { name: '命令操作', exact: true })).toHaveCount(0); await field('inline-c1').dblclick(); await expect(card('inline-c1').getByRole('textbox')).toHaveCount(0);
  await expect(field('inline-c1')).toHaveText('current sandboxa'); await assertCopy('inline-c1', 'current sandboxa');
  const beforeReadonly = await run(); assert.deepEqual(beforeReadonly.entries.find(item => item.id === failed.id), failed); assert.deepEqual(beforeReadonly.entries.find(item => item.id === completed.id), completed);
  await locate('inline-next'); await panel().locator(`input[data-parameter-id="${globalId}"]`).fill('UNAPPLIED-DRAFT'); await expect(field('inline-next-c')).toHaveText('future run ios-audit'); await assertCopy('inline-next-c', 'future run ios-audit'); assert.deepEqual(await run(), beforeReadonly);
  await locate('inline-next');
  await expect(panel().locator(`input[data-parameter-id="${globalId}"]`)).toHaveValue('UNAPPLIED-DRAFT');
  await panel().locator('[data-parameter-scope="global"]').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await expect(panel().locator(`input[data-parameter-id="${globalId}"]`)).toHaveValue('ios-audit');
  await apply({ type: 'record_result', id: runId, outcome: 'completed', reason: null }); await apply({ type: 'record_result', id: runId, outcome: 'completed', reason: null });
  await reload(); await page.locator(`[data-instance-id="${runId}"]`).click(); await locate('inline-next'); const ended = await run(); assert.equal(ended.status, 'completed');
  await expect(card('inline-next-c').getByRole('button', { name: '命令操作', exact: true })).toHaveCount(0); await field('inline-next-c').dblclick(); await expect(card('inline-next-c').getByRole('textbox')).toHaveCount(0); await assertCopy('inline-next-c', 'future run ios-audit'); assert.deepEqual(await run(), ended); assert.deepEqual(await template(), originalTemplate);
  checks.push('Current/future editing and step moves/deletion respect the execution cursor; failed and completed command snapshots keep exact earlier text. Applied values drive display and copy despite drafts, progressed/ended commands have no edit/menu entry but remain copyable, and the source template is unchanged');
  assert.ok(copies.length > 0 && hookInstalls > 0); assert.deepEqual(pageErrors, []); await expect(page.getByRole('alert')).toHaveCount(0);
  const result = { ok: true, isolatedDataDirectory: actual, templateId, runId, checks, geometryChecks, copies, hookInstalls, pageErrors, clipboardMode: 'transport', clipboardTouched: false, systemClipboardVerified: false, maintenanceCommandsExecuted: false };
  await writeFile('.artifacts/inline-commands-check.json', JSON.stringify(result, null, 2), 'utf8'); console.log(JSON.stringify(result));
} catch (error) {
  const state = await page.evaluate(() => ({ focus: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }, menus: [...document.querySelectorAll('[role="menu"]')].map(node => node.outerHTML), cards: [...document.querySelectorAll('[data-command-id]')].map(node => ({ id: node.dataset.commandId, html: node.outerHTML })), save: document.querySelector('.save-state')?.textContent })).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/inline-commands-failure.json', JSON.stringify({ error: String(error), checks, geometryChecks, copies, pageErrors, state, workspace: await workspace().catch(() => null) }, null, 2), 'utf8').catch(() => {}); await page.screenshot({ path: '.artifacts/inline-commands-failure.png' }).catch(() => {}); throw error;
} finally { await browser.close(); }
