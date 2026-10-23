// RUNBOOK_CLIPBOARD_TEST_MODE=transport node scripts/check-desktop.mjs scripts/smoke-definition-commands.mjs
// Real native records and UI; clipboard writes are captured without touching the OS.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && process.env.RUNBOOK_DATA_DIR === directory && process.env.RUNBOOK_CDP_URL);
assert.equal(process.env.RUNBOOK_CLIPBOARD_TEST_MODE, 'transport');
const actual = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase()); assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actual}`));
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(15000);
const checks = [], geometries = [], scrollDismissals = [], clipboardWrites = [], pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), workspace = () => native('checklist_load');
const templateId = 'qa-definition-command-template', blockId = 'qa-definition-command-block', runId = 'qa-definition-command-existing-instance';
const ref = parameterId => ({ parameterId }), strings = parts => parts.filter(part => typeof part === 'string').join('');
const fixture = (prefix, value) => ({ groups: [{ id: `${prefix}-group`, name: `${prefix} 独立步骤组` }], parameters: [{ id: `${prefix}-env`, ownerId: `${prefix}-group`, name: 'ENVIRONMENT', description: '仅本组可见。', defaultValue: value }], steps: [
  { id: `${prefix}-first`, groupId: `${prefix}-group`, title: ['更新服务'], description: ['仅编辑与复制命令，不执行。'], commands: [{ id: `${prefix}-c1`, text: ['initial ', ref(`${prefix}-env`)] }, { id: `${prefix}-c2`, text: ['second'] }] },
  { id: `${prefix}-second`, groupId: `${prefix}-group`, title: ['人工核验'], description: ['相邻步骤不得被命令排序改变。'], commands: [{ id: `${prefix}-neighbor`, text: ['neighbor ', ref(`${prefix}-env`)] }] },
] });
const contexts = [{ kind: 'template', id: templateId, prefix: 'definition-template', value: 'release' }, { kind: 'block', id: blockId, prefix: 'definition-block', value: 'sandboxa' }];
const entity = async context => (await workspace())[context.kind === 'block' ? 'blocks' : 'templates'].find(item => item.id === context.id);
const run = async () => (await workspace()).instances.find(item => item.id === runId);
const step = id => page.locator(`[data-step-id="${id}"]`), card = id => page.locator(`[data-command-id="${id}"]`), field = id => card(id).locator('[data-inline-field]');
const panel = () => page.getByRole('complementary', { name: '变量面板', exact: true });
const commandList = (value, stepId) => value.document.steps.find(item => item.id === stepId).commands;
const command = (value, commandId) => value.document.steps.flatMap(item => item.commands).find(item => item.id === commandId);
const exactText = '  Write-Output "{{literal}} 中文😀"  \r\n\r\n  final  \r\n';

async function installTransport() {
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window); window.__definitionCommandsSmoke = { writes: [], probes: 0 };
    const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'http://ipc.localhost' && !(url.protocol === 'ipc:' && url.hostname === 'localhost')) return originalFetch(input, init);
      const name = decodeURIComponent(url.pathname.slice(1)), args = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (name === 'definition_commands_smoke_probe') { window.__definitionCommandsSmoke.probes++; return reply(true); }
      if (name === 'plugin:clipboard-manager|write_text' || name === 'plugin:clipboard-manager|write_html') {
        if (name.endsWith('write_text') ? typeof args.text !== 'string' : typeof args.html !== 'string' || typeof args.altText !== 'string') throw new Error('Unexpected clipboard payload');
        window.__definitionCommandsSmoke.writes.push({ command: name, ...structuredClone(args) }); return reply(null);
      }
      if (name.startsWith('plugin:clipboard-manager|')) throw new Error('OS clipboard access is forbidden in this transport-only test');
      return originalFetch(input, init);
    };
    const diagnostics = { timeline: [], trigger: null };
    const rect = node => { if (!node?.getBoundingClientRect) return null; const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const describe = node => {
      if (!(node instanceof Element)) return { node: node?.nodeName ?? null };
      return { tag: node.tagName, className: typeof node.className === 'string' ? node.className : node.className?.baseVal, label: node.getAttribute('aria-label'), commandId: node.closest('[data-command-id]')?.dataset.commandId, stepId: node.closest('[data-step-id]')?.dataset.stepId, rect: rect(node), scrollTop: node.scrollTop, scrollLeft: node.scrollLeft, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
    };
    diagnostics.record = (type, target) => {
      diagnostics.timeline.push({ at: performance.now(), type, target: describe(target), active: describe(document.activeElement), trigger: describe(diagnostics.trigger), triggerCard: describe(diagnostics.trigger?.closest('[data-command-id]')),
        workspace: describe(document.querySelector('.workspace-scroll')), window: { scrollX, scrollY }, menus: [...document.querySelectorAll('[role="menu"]')].map(describe) });
      if (diagnostics.timeline.length > 300) diagnostics.timeline.splice(0, diagnostics.timeline.length - 300);
    };
    window.__definitionCommandDiagnostics = diagnostics;
    for (const name of ['scroll', 'focusin', 'focusout', 'pointerdown', 'pointerup', 'click']) document.addEventListener(name, event => diagnostics.record(name, event.target), true);
  });
  assert.equal(await native('definition_commands_smoke_probe'), true); assert.equal(await page.evaluate(() => window.__definitionCommandsSmoke.probes), 1);
}
async function reload() { await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor(); await installTransport(); }
async function saved(predicate) { await expect.poll(predicate).toBe(true); await expect(page.locator('.save-state')).toContainText('已保存在本机'); }
async function open(context) {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: context.kind === 'block' ? '步骤块' : '模板' }).click();
  await page.locator(`[data-${context.kind}-id="${context.id}"] .tile-open`).click(); await expect(page.locator(`[data-inline-field="${context.kind === 'block' ? '步骤块名称' : '模板名称'}"]`)).toBeVisible();
}
async function locate(id) { await page.locator(`[data-nav-step-id="${id}"]`).click(); await expect(panel()).toHaveAttribute('data-variable-target-step-id', id); }
async function editorFor(id, entry = 'double') {
  const editor = card(id).getByRole('textbox');
  if (!await editor.count()) { if (entry === 'double') await field(id).dblclick(); else { await field(id).focus(); await field(id).press(entry); } }
  await expect(editor).toBeVisible(); return editor;
}
async function pasteText(editor, text) {
  await editor.evaluate((element, text) => { element.focus(); const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); const data = new DataTransfer(); data.setData('text/plain', text); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, text);
  assert.equal(await editor.textContent(), text);
}
async function select(editor, literal) {
  await editor.focus(); await editor.evaluate(async (element, literal) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('[data-parameter-id]')) continue; const index = node.textContent.indexOf(literal); if (index < 0) continue;
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + literal.length); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const r = range.getBoundingClientRect(), e = element.getBoundingClientRect(); if (r.bottom > e.top + element.clientHeight - 8) element.scrollTop += r.bottom - e.top - element.clientHeight + 8; else if (r.top < e.top + 8) element.scrollTop += r.top - e.top - 8;
      const card = element.closest('[data-command-id]'), root = element.closest('.workspace-scroll'); root.scrollTo({ top: root.scrollTop + card.getBoundingClientRect().top - root.getBoundingClientRect().top - 20, behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return;
    } throw new Error(`Literal not found in the active field: ${literal}`);
  }, literal);
}
async function openMenu(trigger) {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.evaluate(button => new Promise((resolve, reject) => { let previous, stable = 0, frames = 0; function frame() { const r = button.getBoundingClientRect(), root = button.closest('.workspace-scroll'), sample = [r.x, r.y, root?.scrollTop ?? 0]; stable = previous && sample.every((value, index) => Math.abs(value - previous[index]) < .1) ? stable + 1 : 1; previous = sample; if (stable >= 3) resolve(); else if (++frames >= 180) reject(new Error('The action trigger did not stabilize')); else requestAnimationFrame(frame); } requestAnimationFrame(frame); }));
  await trigger.evaluate(button => { const diagnostics = window.__definitionCommandDiagnostics; diagnostics.trigger = button; diagnostics.record('before-menu-click', button); });
  await trigger.click(); const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
  await trigger.evaluate(button => window.__definitionCommandDiagnostics.record('menu-visible', button)); return menu;
}
async function stepAction(id, name) { await locate(id); const menu = await openMenu(step(id).getByRole('button', { name: '步骤新增', exact: true })); await menu.getByRole('menuitem', { name, exact: true }).click(); await expect(menu).toHaveCount(0); }
async function commandAction(id, name) { const menu = await openMenu(card(id).getByRole('button', { name: '命令操作', exact: true })); await menu.getByRole('menuitem', { name, exact: true }).click(); await expect(menu).toHaveCount(0); }
async function clipboardAction(button) {
  const before = await page.evaluate(() => window.__definitionCommandsSmoke.writes.length); await button.click(); await expect.poll(() => page.evaluate(() => window.__definitionCommandsSmoke.writes.length)).toBe(before + 1);
  const payload = await page.evaluate(() => window.__definitionCommandsSmoke.writes.at(-1)); clipboardWrites.push(payload); return payload;
}
async function copyCommand(id, expected) { const payload = await clipboardAction(card(id).getByRole('button', { name: '复制命令', exact: true })); assert.equal(payload.command, 'plugin:clipboard-manager|write_text'); assert.equal(payload.text, expected); }
async function verifyScrollDismissal(context, commandId) {
  const viewport = page.viewportSize(), root = page.locator('.workspace-scroll'), trigger = card(commandId).getByRole('button', { name: '命令操作', exact: true });
  await page.setViewportSize({ width: 940, height: 640 });
  const before = await entity(context);
  let menu = await openMenu(trigger);
  const beforeWheel = await root.evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  assert.ok(beforeWheel.scrollHeight - beforeWheel.clientHeight > 10, 'Use the existing long-command fixture for a genuine ancestor scroll');
  const bounds = await root.boundingBox(); assert.ok(bounds);
  await page.mouse.move(bounds.x + 12, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, beforeWheel.scrollTop < beforeWheel.scrollHeight - beforeWheel.clientHeight - 2 ? 40 : -40);
  await expect(menu).toHaveCount(0); await expect.poll(() => root.evaluate(element => element.scrollTop)).not.toBe(beforeWheel.scrollTop);
  const afterWheel = await root.evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  assert.deepEqual(await entity(context), before, 'Real wheel dismissal cannot write a definition');

  menu = await openMenu(trigger);
  const programmatic = await root.evaluate(element => {
    const before = { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    const maximum = element.scrollHeight - element.clientHeight;
    if (maximum <= 10) throw new Error('The ancestor must have real scrolling room');
    element.scrollTo({ top: before.scrollTop + (before.scrollTop < maximum - 2 ? 30 : -30), behavior: 'instant' });
    return { before, after: { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight } };
  });
  assert.notEqual(programmatic.before.scrollTop, programmatic.after.scrollTop);
  assert.equal(programmatic.before.scrollHeight, programmatic.after.scrollHeight); assert.equal(programmatic.before.clientHeight, programmatic.after.clientHeight);
  await expect(menu).toHaveCount(0); assert.deepEqual(await entity(context), before, 'A real programmatic scroll with unchanged ancestor dimensions must dismiss without writing');
  scrollDismissals.push({ context: context.kind, wheel: { before: beforeWheel, after: afterWheel }, programmatic });
  await page.setViewportSize(viewport);
}
async function capture(context, commandId, label, editor) {
  const metrics = await card(commandId).evaluate(element => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }; };
    const header = element.querySelector('[data-command-header]'), field = element.querySelector('[data-inline-field]'), editor = field.querySelector('[contenteditable]'), content = editor ?? field;
    const h = getComputedStyle(header), c = getComputedStyle(content), root = element.closest('.workspace-scroll'), selection = window.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const r = range && editor?.contains(range.startContainer) && editor.contains(range.endContainer) ? range.getBoundingClientRect() : null;
    return { viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, documentWidth: document.documentElement.scrollWidth }, workspace: rect(root), card: rect(element), header: rect(header), content: rect(content), editor: editor ? rect(editor) : null,
      headerBackground: h.backgroundColor, headerLeft: header.getBoundingClientRect().left + parseFloat(h.paddingLeft), headerRight: header.getBoundingClientRect().right - parseFloat(h.paddingRight), contentLeft: content.getBoundingClientRect().left + parseFloat(c.paddingLeft), contentRight: content.getBoundingClientRect().right - parseFloat(c.paddingRight),
      text: element.innerText, terminalIcons: element.querySelectorAll('.lucide-terminal').length, selection: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, text: selection.toString() } : null };
  });
  await writeFile(`.artifacts/definition-commands-${label}-geometry.json`, JSON.stringify(metrics, null, 2), 'utf8'); await page.screenshot({ path: `.artifacts/definition-commands-${label}.png` });
  const rgb = metrics.headerBackground.match(/[\d.]+/g)?.map(Number), dark = await page.locator('html').getAttribute('data-theme') === 'dark';
  assert.ok(rgb?.length >= 3 && rgb.slice(0, 3).every(value => dark ? value >= 30 && value <= 55 : value >= 225 && value <= 252) && Math.max(...rgb.slice(0, 3)) - Math.min(...rgb.slice(0, 3)) <= 3 && (rgb.length < 4 || rgb[3] === 1), 'All contexts share a neutral action header in the active theme');
  assert.equal(metrics.terminalIcons, 0); assert.ok(!metrics.text.split(/\r?\n/).some(line => /^命令\s*\d+\s*$/.test(line.trim())), 'No visible command-number title');
  assert.ok(metrics.header.top >= metrics.card.top && metrics.header.top <= metrics.card.top + 2 && metrics.content.top >= metrics.header.bottom - 1);
  assert.ok(Math.abs(metrics.headerLeft - metrics.contentLeft) <= 2 && Math.abs(metrics.headerRight - metrics.contentRight) <= 2, 'Header and body horizontal insets must align');
  assert.equal(metrics.viewport.scrollX, 0); assert.equal(metrics.viewport.scrollY, 0); assert.ok(metrics.viewport.documentWidth <= metrics.viewport.width + 1 && metrics.workspace.scrollWidth <= metrics.workspace.clientWidth + 1 && metrics.card.scrollWidth <= metrics.card.clientWidth + 1);
  assert.ok(metrics.content.scrollHeight > metrics.content.clientHeight + 50, 'Long commands scroll inside their own bounded field');
  if (editor) { assert.ok(metrics.editor.scrollTop > 0 && metrics.selection?.text === 'TAIL_SLOT'); const r = metrics.selection, e = metrics.editor, w = metrics.workspace; assert.ok(r.left >= e.left && r.right <= e.right + 1 && r.top >= e.top && r.bottom <= e.top + e.clientHeight + 1 && r.top >= w.top && r.bottom <= w.bottom + 1, 'The real tail selection remains visible inside both nested scrollports'); }
  geometries.push({ context: context.kind, label, ...metrics });
}

try {
  await mkdir('.artifacts', { recursive: true }); await page.setViewportSize({ width: 1360, height: 940 });
  await apply({ type: 'create_block', id: blockId, name: 'QA 共享命令步骤块', document: fixture(contexts[1].prefix, contexts[1].value) });
  await apply({ type: 'create_template', id: templateId, name: 'QA 共享命令模板', document: fixture(contexts[0].prefix, contexts[0].value) });
  await reload(); await open(contexts[0]); await stepAction('definition-template-first', '插入步骤块');
  const insertDialog = page.getByRole('dialog', { name: '插入步骤块', exact: true }); await insertDialog.locator('.block-choice').filter({ hasText: 'QA 共享命令步骤块' }).click(); await expect(insertDialog).toHaveCount(0);
  await saved(async () => (await entity(contexts[0])).document.groups.length === 2);
  const insertedTemplate = await entity(contexts[0]), insertedGroup = insertedTemplate.document.groups.find(group => group.sourceBlockId === blockId); assert.ok(insertedGroup);
  const insertedSnapshot = { group: insertedGroup, steps: insertedTemplate.document.steps.filter(step => step.groupId === insertedGroup.id), parameters: insertedTemplate.document.parameters.filter(parameter => parameter.ownerId === insertedGroup.id || insertedTemplate.document.steps.some(step => step.groupId === insertedGroup.id && step.id === parameter.ownerId)) };
  await apply({ type: 'create_instance', id: runId, name: 'QA 已有独立实例', templateId, fromInstanceId: null }); const existingInstance = await run();

  for (const context of contexts) {
    await page.setViewportSize({ width: 1360, height: 940 }); await open(context); await locate(`${context.prefix}-first`);
    const firstId = `${context.prefix}-c1`, secondId = `${context.prefix}-c2`, parameterId = `${context.prefix}-env`, firstStepId = `${context.prefix}-first`;
    await expect(card(firstId).getByRole('textbox')).toHaveCount(0); await expect(card(secondId).getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '添加命令', exact: true })).toHaveCount(0); await expect(card(firstId).getByRole('button', { name: '删除命令', exact: true })).toHaveCount(0);
    await copyCommand(firstId, `initial ${context.value}`);
    let editor = await editorFor(firstId); await pasteText(editor, exactText); await copyCommand(firstId, exactText); await saved(async () => strings(command(await entity(context), firstId).text) === exactText);
    assert.deepEqual(command(await entity(context), firstId).text, [exactText]);
    editor = await editorFor(firstId, 'F2'); await pasteText(editor, 'prefix SLOT suffix SLOT'); await select(editor, 'SLOT');
    const reference = await clipboardAction(panel().locator(`[data-variable-id="${parameterId}"]`).getByRole('button', { name: '复制变量引用 ENVIRONMENT', exact: true })); assert.equal(reference.command, 'plugin:clipboard-manager|write_html');
    await editor.evaluate((element, payload) => { element.focus(); const selected = window.getSelection(); if (selected?.toString() !== 'SLOT') throw new Error('The selected literal must survive panel copy'); const data = new DataTransfer(); data.setData('text/html', payload.html); data.setData('text/plain', payload.altText); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); }, reference);
    // Copy while the buffer still owns focus: the request must flush and use
    // the newest definition, including the newly pasted scoped reference.
    await copyCommand(firstId, `prefix ${context.value} suffix SLOT`); await saved(async () => command(await entity(context), firstId).text.some(part => part.parameterId === parameterId));
    assert.deepEqual(command(await entity(context), firstId).text, ['prefix ', ref(parameterId), ' suffix SLOT']);
    editor = await editorFor(firstId); await editor.press('Control+End'); await editor.pressSequentially(' pending-copy');
    await copyCommand(secondId, 'second'); await saved(async () => strings(command(await entity(context), firstId).text).endsWith(' pending-copy'));
    editor = await editorFor(firstId); await editor.press('Control+End'); await editor.pressSequentially(' pending-menu');
    const adjacentTrigger = card(secondId).getByRole('button', { name: '命令操作', exact: true }); const adjacentMenu = await openMenu(adjacentTrigger);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const menuBounds = await adjacentMenu.boundingBox(), triggerBounds = await adjacentTrigger.boundingBox(), viewport = page.viewportSize(); assert.ok(menuBounds && triggerBounds);
    assert.ok(menuBounds.x >= 0 && menuBounds.y >= 0 && menuBounds.x + menuBounds.width <= viewport.width + 1 && menuBounds.y + menuBounds.height <= viewport.height + 1);
    assert.ok(Math.min(Math.abs(menuBounds.y - triggerBounds.y), Math.abs(menuBounds.y + menuBounds.height - triggerBounds.y - triggerBounds.height), Math.abs(menuBounds.y - 10), Math.abs(menuBounds.y + menuBounds.height - viewport.height + 10)) <= 2, 'An adjacent-card menu must track its final anchor after the earlier editor collapses');
    await adjacentMenu.getByRole('menuitem', { name: '上移命令', exact: true }).click(); await saved(async () => commandList(await entity(context), firstStepId)[0].id === secondId);
    assert.deepEqual(command(await entity(context), firstId).text, ['prefix ', ref(parameterId), ' suffix SLOT pending-copy pending-menu']);
    await commandAction(secondId, '下移命令'); await saved(async () => commandList(await entity(context), firstStepId)[0].id === firstId);
    editor = await editorFor(secondId, 'Enter'); await pasteText(editor, 'second edited'); await editor.press('Control+Enter'); await saved(async () => strings(command(await entity(context), secondId).text) === 'second edited');
    const beforeAdd = await entity(context); await stepAction(firstStepId, '添加命令'); await saved(async () => commandList(await entity(context), firstStepId).length === 3);
    const added = commandList(await entity(context), firstStepId).find(item => !commandList(beforeAdd, firstStepId).some(previous => previous.id === item.id)); assert.ok(added); assert.deepEqual(added.text, ['']);
    editor = card(added.id).getByRole('textbox'); await expect(editor).toBeFocused(); await pasteText(editor, 'third '); await editor.pressSequentially('{{ENVIRONMENT');
    const slashMenu = page.getByRole('listbox', { name: '变量建议', exact: true }); assert.deepEqual(await slashMenu.getByRole('option').evaluateAll(nodes => nodes.map(node => node.dataset.parameterId)), [parameterId]); await slashMenu.locator(`[data-parameter-id="${parameterId}"]`).click(); await editor.press('Control+Enter');
    await saved(async () => command(await entity(context), added.id).text.some(part => part.parameterId === parameterId));
    const three = commandList(await entity(context), firstStepId), neighbors = (await entity(context)).document.steps.filter(step => step.id !== firstStepId);
    let menu = await openMenu(card(firstId).getByRole('button', { name: '命令操作', exact: true })); await expect(menu.getByRole('menuitem', { name: '上移命令', exact: true })).toBeDisabled(); await expect(menu.getByRole('menuitem', { name: '下移命令', exact: true })).toBeEnabled(); const beforeCancel = await entity(context); await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); assert.deepEqual(await entity(context), beforeCancel);
    menu = await openMenu(card(added.id).getByRole('button', { name: '命令操作', exact: true })); await expect(menu.getByRole('menuitem', { name: '下移命令', exact: true })).toBeDisabled(); await page.keyboard.press('Escape');
    await commandAction(added.id, '上移命令'); await saved(async () => commandList(await entity(context), firstStepId)[1].id === added.id); assert.deepEqual(commandList(await entity(context), firstStepId), [three[0], three[2], three[1]]);
    await commandAction(added.id, '下移命令'); await saved(async () => commandList(await entity(context), firstStepId)[2].id === added.id); assert.deepEqual(commandList(await entity(context), firstStepId), three);
    await commandAction(secondId, '下移命令'); await saved(async () => commandList(await entity(context), firstStepId)[1].id === added.id); await commandAction(added.id, '删除命令'); await saved(async () => commandList(await entity(context), firstStepId).length === 2);
    assert.deepEqual(commandList(await entity(context), firstStepId), [three[0], three[1]]); assert.deepEqual((await entity(context)).document.steps.filter(step => step.id !== firstStepId), neighbors);
    checks.push(`${context.kind}: default display, double-click/F2/Enter, exact CRLF and default-substituted copy before blur, scoped reference paste and double-brace acceptance, direct adjacent-card copy/menu without losing pending text or drifting its final anchor, left-plus empty focused add, stable-ID moves/precise middle delete, boundary disabled and cancellation with no write`);

    const longText = 'LONG_FIRST_' + 'unchanged-'.repeat(36) + '\n' + Array.from({ length: 85 }, (_, index) => `# inert line ${index + 1}\n`).join('') + 'TAIL_SLOT';
    editor = await editorFor(secondId); await pasteText(editor, longText); await editor.press('Control+Enter'); await saved(async () => strings(command(await entity(context), secondId).text) === longText);
    await verifyScrollDismissal(context, secondId);
    checks.push(`${context.kind}: after the cross-card menu operation, reopening once and using real workspace wheel dismisses it; a separate unchanged-size programmatic ancestor scroll also dismisses, and both preserve the entire saved definition`);
    const beforeLayout = await entity(context);
    for (const viewport of [{ width: 1360, height: 940 }, { width: 940, height: 640 }]) {
      await page.setViewportSize(viewport); await locate(firstStepId); await card(secondId).evaluate(element => { const root = element.closest('.workspace-scroll'); root.scrollTo({ top: root.scrollTop + element.getBoundingClientRect().top - root.getBoundingClientRect().top - 20, behavior: 'instant' }); }); await capture(context, secondId, `${context.kind}-display-${viewport.width}`);
      editor = await editorFor(secondId); await select(editor, 'TAIL_SLOT'); await capture(context, secondId, `${context.kind}-editing-${viewport.width}`, editor); await editor.press('Escape'); if (await editor.count()) await editor.press('Control+Enter'); await expect(field(secondId)).toHaveClass(/is-display/);
    }
    assert.deepEqual(await entity(context), beforeLayout); assert.deepEqual(await run(), existingInstance);
    if (context.kind === 'block') { const current = await entity(contexts[0]); assert.deepEqual(current.document.groups.find(group => group.id === insertedSnapshot.group.id), insertedSnapshot.group); assert.deepEqual(current.document.steps.filter(step => step.groupId === insertedSnapshot.group.id), insertedSnapshot.steps); assert.deepEqual(current.document.parameters.filter(parameter => insertedSnapshot.parameters.some(original => original.id === parameter.id)), insertedSnapshot.parameters); assert.equal((await entity(context)).kind, 'block'); assert.equal((await entity(context)).document.groups.length, 1); }
    checks.push(`${context.kind}: 1360/940 gray header without visible numbered title/Terminal, equal left/right content insets, bounded long-command scroll and real visible tail selection, no layout writes; existing instance and inserted block snapshot stay independent`);
  }
  // A definition may contain a required variable without a default, but a
  // copy request must fail before any clipboard IPC is written.
  const completeTemplate = await entity(contexts[0]), missingDocument = structuredClone(completeTemplate.document);
  missingDocument.parameters.find(item => item.id === 'definition-template-env').defaultValue = '';
  await apply({ type: 'save_template', id: templateId, name: completeTemplate.name, document: missingDocument }); await reload(); await open(contexts[0]); await locate('definition-template-first');
  const beforeMissingCopy = await entity(contexts[0]), writesBeforeMissing = await page.evaluate(() => window.__definitionCommandsSmoke.writes.length);
  await card('definition-template-c1').getByRole('button', { name: '复制命令', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('填写默认值');
  assert.equal(await page.evaluate(() => window.__definitionCommandsSmoke.writes.length), writesBeforeMissing); assert.deepEqual(await entity(contexts[0]), beforeMissingCopy); assert.deepEqual(await run(), existingInstance);
  await apply({ type: 'save_template', id: templateId, name: completeTemplate.name, document: completeTemplate.document }); await reload(); await open(contexts[0]);
  checks.push('A definition command with a missing referenced default reports the missing-default error before clipboard write; the saved document and existing instance remain unchanged');
  assert.ok(clipboardWrites.filter(item => item.command.endsWith('write_text')).length >= 8 && clipboardWrites.filter(item => item.command.endsWith('write_html')).length === 2); assert.deepEqual(pageErrors, []); await expect(page.getByRole('alert')).toHaveCount(0);
  const result = { ok: true, isolatedDataDirectory: actual, templateId, blockId, runId, checks, geometries, scrollDismissals, clipboardWrites, pageErrors, clipboardMode: 'transport', clipboardTouched: false, systemClipboardVerified: false, maintenanceCommandsExecuted: false };
  await writeFile('.artifacts/definition-commands-check.json', JSON.stringify(result, null, 2), 'utf8'); console.log(JSON.stringify(result));
} catch (error) {
  const state = await page.evaluate(() => {
    const diagnostics = window.__definitionCommandDiagnostics; diagnostics?.record('failure', document.activeElement);
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const ancestors = []; let ancestor = diagnostics?.trigger;
    while (ancestor instanceof Element) { ancestors.push({ tag: ancestor.tagName, className: typeof ancestor.className === 'string' ? ancestor.className : ancestor.className?.baseVal, label: ancestor.getAttribute('aria-label'), rect: rect(ancestor), scrollTop: ancestor.scrollTop, scrollLeft: ancestor.scrollLeft, scrollHeight: ancestor.scrollHeight, clientHeight: ancestor.clientHeight }); ancestor = ancestor.parentElement; }
    return { focus: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), html: document.activeElement?.outerHTML }, cards: [...document.querySelectorAll('[data-command-id]')].map(node => ({ id: node.dataset.commandId, rect: rect(node), html: node.outerHTML })), menuCount: document.querySelectorAll('[role="menu"]').length, menus: [...document.querySelectorAll('[role="menu"]')].map(node => ({ rect: rect(node), html: node.outerHTML })), triggerAncestors: ancestors, timeline: diagnostics?.timeline, save: document.querySelector('.save-state')?.textContent };
  }).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/definition-commands-failure.json', JSON.stringify({ error: String(error), checks, clipboardWrites, pageErrors, state, workspace: await workspace().catch(() => null) }, null, 2), 'utf8').catch(() => {}); await page.screenshot({ path: '.artifacts/definition-commands-failure.png' }).catch(() => {}); throw error;
} finally { await browser.close(); }
