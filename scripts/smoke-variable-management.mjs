// Run with scripts/check-desktop.mjs. All work belongs to its isolated data directory.
// No maintenance command, system clipboard, native file dialog or real data is used.
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

assert.ok(process.env.RUNBOOK_TEST_DATA_DIR && process.env.RUNBOOK_CDP_URL);
assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
const output = process.env.RUNBOOK_TEST_OUTPUT_DIR ?? '.artifacts/variable-management-2026-10-23';
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(14000);
const checks = [], layouts = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), load = () => native('checklist_load');
const work = async id => (await load()).instances.find(item => item.id === id);
const panel = () => page.locator('aside[data-variable-panel]');
const row = id => panel().locator(`[data-variable-id="${id}"]`);
const step = id => page.locator(`[data-step-id="${id}"]`);
const search = () => panel().getByRole('searchbox', { name: '搜索变量', exact: true });
const suggestions = () => page.getByRole('listbox', { name: '变量建议', exact: true });
const ref = parameterId => ({ parameterId });
const definition = (id, name, defaultValue, ownerId) => ({ id, name, description: `QA ${name}`, defaultValue, ...(ownerId ? { ownerId } : {}) });
const references = (document, id) => document.steps.flatMap(s => [...s.title, ...s.description, ...s.commands.flatMap(c => c.text)]).filter(p => typeof p !== 'string' && p.parameterId === id).length;
const allParts = document => document.steps.flatMap(s => [...s.title, ...s.description, ...s.commands.flatMap(c => c.text)]);
const commandParts = document => document.steps[0].commands[0].text;
const text = parts => parts.filter(p => typeof p === 'string').join('');
async function saved(predicate) { if (predicate) await expect.poll(predicate).toBe(true); await expect(page.locator('.save-state')).toHaveText(/已保存在本机|草稿已保留/); }
async function open(id) {
  await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  await page.locator(`[data-instance-id="${id}"]`).click(); await expect(page.locator('[data-inline-field="工作名称"]')).toBeVisible();
}
async function revealPanel() { if (!await search().isVisible()) await page.getByRole('button', { name: '展开变量面板', exact: true }).first().click(); await expect(search()).toBeVisible(); }
async function clearSearch() { const clear = panel().getByRole('button', { name: '清空变量搜索', exact: true }); if (await clear.count()) await clear.click(); }
async function find(name) { await revealPanel(); await search().fill(name); }
async function variableMenu(id) { await row(id).hover(); await row(id).getByRole('button', { name: /^变量操作 / }).click(); }
async function editValue(id, name, value) {
  await find(name); await variableMenu(id); await page.getByRole('menuitem', { name: '修改本次值', exact: true }).click();
  const input = row(id).locator('input[data-parameter-id]'); await input.fill(value); await input.press('Enter');
}
async function valueOf(id) { return row(id).locator('[data-variable-value]').evaluate(node => node instanceof HTMLInputElement ? node.value : node.textContent); }
async function editor(id, label = '命令 1') {
  const group = step(id).locator('xpath=ancestor::*[@data-group-id][1]');
  if (!await step(id).isVisible() && await group.count()) await group.getByRole('button', { name: '展开步骤组', exact: true }).click();
  const expand = step(id).getByRole('button', { name: /^展开步骤 \d+$/ });
  if (await expand.count()) await expand.click();
  const input = step(id).getByRole('textbox', { name: label, exact: true });
  if (!await input.count()) await step(id).locator(`[data-inline-field="${label}"]`).dblclick();
  await expect(input).toBeVisible(); return input;
}
async function enterBulk() {
  await revealPanel(); await panel().getByRole('button', { name: '变量管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '批量删除变量', exact: true }).click();
  await expect(panel().getByRole('button', { name: '删除所选变量', exact: true })).toBeVisible();
}
async function checkbox(id) { return row(id).getByRole('checkbox'); }
async function deleteSelected(cancel = false) {
  await panel().getByRole('button', { name: '删除所选变量', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除变量', exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: cancel ? '取消' : '确认删除', exact: true }).click(); await expect(dialog).toHaveCount(0);
}
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await panel().evaluate(element => {
    const r = element.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, rootWidth: document.documentElement.scrollWidth, panel: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }, controls: [...element.querySelectorAll('input,button')].filter(n => n.getClientRects().length).map(n => { const b = n.getBoundingClientRect(); return { label: n.getAttribute('aria-label') ?? n.textContent, left: b.left, right: b.right, width: b.width }; }) };
  });
  assert.ok(geometry.rootWidth <= geometry.width + 1, 'No document horizontal overflow');
  assert.ok(geometry.panel.left >= 0 && geometry.panel.right <= geometry.width + 1, 'Variable panel remains in viewport');
  assert.ok(geometry.panel.scrollWidth <= geometry.panel.clientWidth + 1, 'Variable panel has no horizontal overflow');
  for (const control of geometry.controls) assert.ok(control.left >= geometry.panel.left - 1 && control.right <= geometry.panel.right + 1, `${control.label} remains in the panel`);
  layouts.push({ name, ...geometry }); await page.screenshot({ path: `${output}/${name}.png` });
}

const quickId = 'qa-management-quick', managedId = 'qa-management-bulk', lockedId = 'qa-management-history';
const quickDocument = { parameters: [definition('existing', '既有变量', 'EXISTING')], steps: [
  { id: 'quick-step', title: ['快捷创建验收'], description: ['仅编辑惰性文本'], commands: [{ id: 'quick-command', text: ['echo initial'] }] },
] };
const managedDocument = { groups: [{ id: 'managed-group', name: '测试步骤组' }], parameters: [
  definition('keep', '保留变量', 'KEEP'), definition('global-collision', '重复名称', 'GLOBAL'),
  definition('local-collision', '重复名称', 'LOCAL', 'managed-group'),
  definition('group-promote', '组变量提升', 'GROUP-DEFAULT', 'managed-group'),
  definition('step-promote', '步骤变量提升', 'STEP-DEFAULT', 'managed-step'),
  definition('delete-a', '删除甲', 'APPLIED-A'), definition('delete-b', '删除乙', 'APPLIED-B'),
  definition('delete-unused', '删除空闲', ''), definition('empty-used', '空值被引用', ''),
], steps: [
  { id: 'managed-step', groupId: 'managed-group', title: ['核验 ', ref('delete-a')], description: [ref('group-promote'), ' / ', ref('step-promote'), ' / ', ref('delete-b')], commands: [{ id: 'managed-command', text: ['echo ', ref('delete-a'), ' ', ref('delete-b'), ' ', ref('keep'), ' ', ref('local-collision')] }] },
  { id: 'managed-second', groupId: 'managed-group', title: ['后续核验'], description: [ref('group-promote'), ' ', ref('empty-used')], commands: [] },
] };
const lockedDocument = { parameters: [definition('locked-variable', '历史锁定', 'HISTORY'), definition('future-variable', '后续可删', 'FUTURE')], steps: [
  { id: 'history-step', title: ['已推进 ', ref('locked-variable')], description: [], commands: [{ id: 'history-command', text: ['echo ', ref('locked-variable')] }] },
  { id: 'future-step', title: ['当前步骤'], description: [ref('future-variable')], commands: [] },
] };

try {
  await page.setViewportSize({ width: 1360, height: 880 });
  for (const [id, name, document] of [[quickId, 'QA 快捷创建', quickDocument], [managedId, 'QA 变量管理', managedDocument], [lockedId, 'QA 历史保护', lockedDocument]]) await apply({ type: 'create_work', id, name, document });
  await apply({ type: 'start_instance', id: lockedId }); await apply({ type: 'record_result', id: lockedId, outcome: 'completed', reason: null });
  await open(quickId); let field = await editor('quick-step');
  await field.fill('echo '); await field.pressSequentially('{{新建中文变量'); await expect(suggestions()).toBeVisible();
  await expect(suggestions().getByRole('option').filter({ hasText: '创建' })).toContainText('新建中文变量');
  await field.press('Enter'); await expect(suggestions()).toHaveCount(0);
  await saved(async () => (await work(quickId)).document.parameters.some(p => p.name === '新建中文变量'));
  const created = (await work(quickId)).document.parameters.find(p => p.name === '新建中文变量');
  assert.equal(created.ownerId, undefined); assert.equal(created.defaultValue, ''); assert.equal(references((await work(quickId)).document, created.id), 1);
  assert.equal(text(commandParts((await work(quickId)).document)), 'echo ');
  await field.press('Control+Enter');
  checks.push('Typing a missing Chinese name after {{ and pressing Enter creates one global definition with an empty default and replaces only the query with its stable-ID reference');

  field = await editor('quick-step'); await field.fill('echo '); await field.pressSequentially('{{既有变量');
  await expect(suggestions().locator('[role="option"][data-parameter-id="existing"]')).toBeVisible();
  await expect(suggestions().getByRole('option').filter({ hasText: '创建' })).toHaveCount(0);
  await field.press('Enter'); await saved(async () => references((await work(quickId)).document, 'existing') === 1);
  assert.equal((await work(quickId)).document.parameters.length, 2);
  await field.fill('echo '); await field.pressSequentially('{{输入法保护');
  const beforeIme = (await work(quickId)).document.parameters;
  await field.evaluate(element => { element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true })); });
  await expect(suggestions()).toBeVisible(); assert.deepEqual((await work(quickId)).document.parameters, beforeIme);
  await field.evaluate(element => { element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true })); });
  await expect(suggestions()).toBeVisible(); assert.deepEqual((await work(quickId)).document.parameters, beforeIme);
  await field.press('Escape'); await expect(suggestions()).toHaveCount(0); assert.equal(await field.textContent(), 'echo {{输入法保护');
  await field.press('Control+Enter');
  checks.push('An exact existing name inserts its original ID without a duplicate; synthetic keyCode 229 and composing Enter do not create or accept, and Escape preserves literal text');

  field = await editor('quick-step'); await field.fill('echo '); await field.pressSequentially('{{放弃创建');
  await search().click(); await expect(suggestions()).toHaveCount(0);
  await search().press('Enter'); assert.equal((await work(quickId)).document.parameters.length, 2);
  await clearSearch(); await page.locator('[data-inline-field="工作名称"]').click();
  checks.push('Moving focus away invalidates the creation query; later Enter in another control does not create an orphan or use the old selection');

  await open(managedId); await editValue('group-promote', '组变量提升', 'GROUP-PENDING');
  await row('group-promote').getByRole('button', { name: '选择变量 组变量提升', exact: true }).click();
  const originalGroup = (await work(managedId)).document.parameters.find(p => p.id === 'group-promote');
  const originalReferences = references((await work(managedId)).document, 'group-promote');
  await variableMenu('group-promote'); await page.getByRole('menuitem', { name: '转为全局变量', exact: true }).click();
  await saved(async () => !(await work(managedId)).document.parameters.find(p => p.id === 'group-promote').ownerId);
  const { ownerId: previousGroupOwner, ...expectedGlobalGroup } = originalGroup;
  assert.equal(previousGroupOwner, 'managed-group'); assert.deepEqual((await work(managedId)).document.parameters.find(p => p.id === 'group-promote'), expectedGlobalGroup);
  assert.equal((await work(managedId)).parameterValues['group-promote'], 'GROUP-DEFAULT');
  assert.equal(references((await work(managedId)).document, 'group-promote'), originalReferences);
  await expect.poll(() => valueOf('group-promote')).toBe('GROUP-PENDING'); await expect(row('group-promote')).toHaveAttribute('aria-level', '1');
  await expect(search()).toHaveValue('组变量提升'); await expect(page.locator('[data-step-id]')).toHaveCount(2);
  await clearSearch(); await editValue('step-promote', '步骤变量提升', 'STEP-PENDING');
  const originalStep = (await work(managedId)).document.parameters.find(p => p.id === 'step-promote');
  await variableMenu('step-promote'); await page.getByRole('menuitem', { name: '转为全局变量', exact: true }).click();
  await saved(async () => !(await work(managedId)).document.parameters.find(p => p.id === 'step-promote').ownerId);
  const { ownerId: previousStepOwner, ...expectedGlobalStep } = originalStep;
  assert.equal(previousStepOwner, 'managed-step'); assert.deepEqual((await work(managedId)).document.parameters.find(p => p.id === 'step-promote'), expectedGlobalStep);
  assert.equal((await work(managedId)).parameterValues['step-promote'], 'STEP-DEFAULT'); await expect.poll(() => valueOf('step-promote')).toBe('STEP-PENDING');
  checks.push('Group and step locals promote in place: ID, name, description, default, applied value, pending draft and all references remain intact; the selected namespaced search follows the new global scope');

  await find('重复名称'); const beforeCollision = await work(managedId); await variableMenu('local-collision');
  const collision = page.getByRole('menuitem', { name: '转为全局变量', exact: true });
  if (await collision.isDisabled()) { assert.ok(await collision.getAttribute('title') || await collision.textContent()); await page.keyboard.press('Escape'); }
  else { await collision.click(); await expect(panel()).toContainText(/同名|已经存在|已存在/); }
  assert.deepEqual(await work(managedId), beforeCollision);
  assert.equal((await work(managedId)).document.parameters.filter(p => p.name === '重复名称').length, 2);
  checks.push('A conflicting global name is rejected without merging identities, changing values or partially changing the document');

  await editValue('delete-a', '删除甲', 'UNAPPLIED-A'); await clearSearch(); await enterBulk();
  await (await checkbox('delete-a')).check(); await (await checkbox('delete-unused')).check();
  const beforeCancel = await work(managedId); await deleteSelected(true); assert.deepEqual(await work(managedId), beforeCancel);
  await expect(await checkbox('delete-a')).toBeChecked(); await expect(await checkbox('delete-unused')).toBeChecked();
  await panel().getByRole('button', { name: '删除所选变量', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: '删除变量', exact: true });
  await expect(deleteDialog).toContainText(/未应用/); await deleteDialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(deleteDialog).toHaveCount(0);
  await saved(async () => !(await work(managedId)).document.parameters.some(p => ['delete-a', 'delete-unused'].includes(p.id)));
  const afterSubset = await work(managedId);
  assert.equal(references(afterSubset.document, 'delete-a'), 0); assert.ok(text(allParts(afterSubset.document)).includes('APPLIED-A'));
  assert.ok(!text(allParts(afterSubset.document)).includes('UNAPPLIED-A')); assert.equal(afterSubset.parameterValues['delete-a'], undefined);
  assert.ok(afterSubset.document.parameters.some(p => p.id === 'delete-b')); assert.ok(afterSubset.document.parameters.some(p => p.id === 'keep'));
  checks.push('Bulk subset selection and cancel leave data untouched; confirmed deletion freezes every selected reference to the applied value, never the pending draft, and removes only selected definitions and parameter values');

  await find('删除'); await enterBulk(); await panel().getByRole('button', { name: '全选', exact: true }).click();
  await expect(await checkbox('delete-b')).toBeChecked(); await deleteSelected();
  await saved(async () => !(await work(managedId)).document.parameters.some(p => p.id === 'delete-b'));
  assert.equal(references((await work(managedId)).document, 'delete-b'), 0); assert.ok(text(allParts((await work(managedId)).document)).includes('APPLIED-B'));
  assert.ok((await work(managedId)).document.parameters.some(p => p.id === 'keep'));
  await clearSearch(); await enterBulk(); await expect(await checkbox('empty-used')).toBeEnabled();
  await (await checkbox('empty-used')).check();
  checks.push('Select all is limited to the current search; a referenced empty value can be selected for explicit removal');

  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1360, height: 880 });
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-switcher').click();
    for (const width of [1360, 940]) { await page.setViewportSize({ width, height: 820 }); await revealPanel(); await capture(`bulk-${theme}-${width}`); }
  }
  await page.setViewportSize({ width: 1360, height: 880 });
  await panel().getByRole('button', { name: '删除所选变量', exact: true }).click();
  const emptyDialog = page.getByRole('dialog', { name: '删除变量', exact: true });
  await expect(emptyDialog).toContainText(/没有生效值|生效值为空|空值/);
  await emptyDialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await saved(async () => !(await work(managedId)).document.parameters.some(p => p.id === 'empty-used'));
  assert.equal(references((await work(managedId)).document, 'empty-used'), 0);
  assert.ok(!text(allParts((await work(managedId)).document)).includes('空值被引用'));
  checks.push('Deleting a referenced empty value requires a confirmation that explains removal of empty references, and persists the literal empty replacement without a dangling reference');
  await open(managedId); const persisted = await work(managedId);
  assert.equal(persisted.document.parameters.filter(p => ['delete-a', 'delete-b', 'delete-unused'].includes(p.id)).length, 0);
  await find('组变量提升'); await expect.poll(() => valueOf('group-promote')).toBe('GROUP-PENDING');
  await find('步骤变量提升'); await expect.poll(() => valueOf('step-promote')).toBe('STEP-PENDING');
  assert.equal(persisted.parameterValues['group-promote'], 'GROUP-DEFAULT'); assert.equal(persisted.parameterValues['step-promote'], 'STEP-DEFAULT');
  checks.push('Reload preserves the promoted definitions and literal replacements; unrelated unapplied drafts survive and are still not treated as applied values');

  await open(lockedId); const originalHistory = (await work(lockedId)).entries;
  await clearSearch(); await enterBulk(); await expect(await checkbox('locked-variable')).toBeDisabled();
  await panel().getByRole('button', { name: '全选', exact: true }).click(); await expect(await checkbox('future-variable')).toBeChecked();
  await expect(await checkbox('locked-variable')).not.toBeChecked(); await deleteSelected();
  await saved(async () => !(await work(lockedId)).document.parameters.some(p => p.id === 'future-variable'));
  assert.deepEqual((await work(lockedId)).entries, originalHistory); assert.ok((await work(lockedId)).document.parameters.some(p => p.id === 'locked-variable'));
  await clearSearch(); const expandHistory = step('history-step').getByRole('button', { name: /^展开步骤 / }); if (await expandHistory.count()) await expandHistory.click();
  await step('history-step').locator('[data-inline-field="命令 1"]').dblclick();
  await expect(step('history-step').getByRole('textbox')).toHaveCount(0); await expect(suggestions()).toHaveCount(0);
  assert.deepEqual((await work(lockedId)).entries, originalHistory);
  await open(lockedId); assert.deepEqual((await work(lockedId)).entries, originalHistory);
  checks.push('Already advanced definitions stay unselectable and are excluded by select-all; deleting a future reference leaves result snapshots byte-for-byte unchanged, frozen command double-click remains read-only, and reload preserves history');

  assert.deepEqual(errors, []);
  await writeFile(`${output}/inspection.json`, JSON.stringify({ ok: true, directory, checks, layouts, errors, realUserDataOpened: false, maintenanceCommandsExecuted: false, systemClipboardUsed: false, nativeFileDialogsAutomated: false, imeGuardUsesSyntheticEvents: true, freshProcessRestartTested: false }, null, 2));
  console.log(JSON.stringify({ ok: true, directory, checks, screenshots: layouts.map(item => item.name) }));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await writeFile(`${output}/inspection.json`, JSON.stringify({ ok: false, directory, checks, layouts, errors, error: String(error) }, null, 2)); throw error;
} finally { await browser.close(); }
