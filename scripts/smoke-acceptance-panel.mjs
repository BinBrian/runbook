// Run through check-desktop.mjs. No OS clipboard, file dialogs, or real user DB.
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-/);
assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
const output = path.resolve(process.env.RUNBOOK_TEST_OUTPUT_DIR ?? '.artifacts/acceptance-panel-2026-10-23');
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(14000);
const checks = [], screenshots = [], errors = [], colors = [], geometry = [];
page.on('pageerror', error => errors.push(error.message));
const workId = 'acceptance-variable-panel';
const key = 'runbook.variable-panel.v1';
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const work = async () => (await native('checklist_load')).instances.find(item => item.id === workId);
const panel = page.locator('.variable-panel'), row = id => panel.locator(`[data-variable-id="${id}"]`);
const input = id => row(id).locator('input[data-parameter-id]');
const preferences = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), key);
async function openWork() {
  await page.locator('.app-sidebar nav button').filter({ hasText: '工作记录' }).click();
  await page.locator(`[data-instance-id="${workId}"]`).click();
  await expect(page.locator('[data-inline-field="工作名称"]')).toContainText('变量面板验收');
}
async function openMenu(id) {
  await row(id).hover(); await row(id).getByRole('button', { name: /^变量操作 / }).click();
  await expect(page.locator('.variable-action-menu')).toBeVisible();
  return page.locator('.variable-action-menu');
}
async function changeValue(id, value) {
  const menu = await openMenu(id); await menu.getByRole('menuitem', { name: '修改本次值', exact: true }).click();
  await expect(input(id)).toBeFocused(); await input(id).fill(value); await input(id).press('Enter');
}
async function capture(name) {
  await page.mouse.move(2, 778);
  const layout = await page.evaluate(() => ({ width: innerWidth, root: document.documentElement.scrollWidth, panel: document.querySelector('.variable-panel')?.getBoundingClientRect().toJSON(), body: document.querySelector('.instance-step-column')?.getBoundingClientRect().toJSON() }));
  assert.ok(layout.root <= layout.width + 1); geometry.push({ name, ...layout });
  const screenshotPath = path.join(output, `${name}.png`); await page.screenshot({ path: screenshotPath }); screenshots.push(screenshotPath);
}
function rgb(hex) { return `rgb(${hex.trim().slice(1).match(/.{2}/g).map(value => parseInt(value, 16)).join(', ')})`; }

try {
  await page.setViewportSize({ width: 1360, height: 780 });
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, 'A fresh isolated profile has no panel preference');
  await native('checklist_apply', { action: { type: 'create_work', id: workId, name: '变量面板验收 · 维护测试服', document: {
    groups: [{ id: 'g1', name: '维护测试服' }, { id: 'g2', name: '维护体验服' }],
    parameters: [
      { id: 'env', name: '环境', description: '全局环境', defaultValue: '测试服' },
      { id: 'window', name: '维护时间', description: '必填', defaultValue: '' },
      { id: 'local-env', ownerId: 'g1', name: '环境', description: '本组环境', defaultValue: '测试一区' },
      { id: 'other-env', ownerId: 'g2', name: '环境', description: '另一组同名环境', defaultValue: '体验一区' },
    ], steps: [
      { id: 'p1', groupId: 'g1', title: ['维护前核对'], description: ['全局 ', { parameterId: 'env' }, '，本组 ', { parameterId: 'local-env' }, '，窗口 ', { parameterId: 'window' }], commands: [{ id: 'c1', text: ['echo ', { parameterId: 'env' }] }] },
      { id: 'p2', groupId: 'g2', title: ['体验服核对'], description: [{ parameterId: 'other-env' }], commands: [] },
      { id: 'p3', title: ['人工复核'], description: [], commands: [] },
    ],
  } } });
  await page.reload(); await openWork();
  await expect(panel).toHaveClass(/is-open/); await expect(panel).not.toHaveClass(/is-narrow/);
  let menu = await openMenu('local-env');
  await expect(menu.locator('.variable-menu-heading > strong')).toHaveText('环境');
  await expect(menu.locator('.variable-menu-heading > small')).toHaveText('步骤组 · 维护测试服');
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['查看引用', '修改本次值', '复制变量引用', '编辑定义与默认值', '删除变量变量正在被引用，不能删除']);
  await expect(menu.getByRole('menuitem', { name: '删除变量', exact: true })).toBeDisabled();
  await capture('01-menu-context'); await page.keyboard.press('Escape');
  menu = await openMenu('env'); await menu.getByRole('menuitem', { name: '编辑定义与默认值', exact: true }).click();
  let form = panel.getByRole('dialog', { name: '编辑变量定义', exact: true });
  await form.getByRole('textbox', { name: '变量默认值', exact: true }).fill('下次默认环境');
  await form.getByRole('button', { name: '保存变量', exact: true }).click();
  await expect.poll(async () => (await work()).document.parameters.find(p => p.id === 'env').defaultValue).toBe('下次默认环境');
  assert.equal((await work()).parameterValues.env, '测试服');
  checks.push('03: compact action labels share one exact variable name/scope header; definition editing retains the independent applied value and referenced deletion guard.');

  await changeValue('env', '未应用环境'); assert.equal((await work()).parameterValues.env, '测试服');
  await panel.getByRole('button', { name: '收起变量面板', exact: true }).click();
  assert.equal((await preferences()).wide, false);
  await page.setViewportSize({ width: 940, height: 780 });
  await expect(panel).toHaveClass(/is-narrow/); await expect(panel).not.toBeVisible();
  await expect(page.locator('[data-panel-missing-count]')).toHaveText('1'); await expect(page.locator('[data-panel-pending-count]')).toHaveText('1');
  const widthBefore = await page.locator('.instance-step-column').evaluate(node => node.getBoundingClientRect().width);
  assert.ok(widthBefore > 600, 'The narrow view leaves useful width for the document');
  await capture('02-narrow-rail');
  await page.getByRole('button', { name: '展开变量面板', exact: true }).click();
  await expect(panel).toBeVisible(); await expect(panel).toHaveAttribute('role', 'dialog');
  assert.equal((await preferences()).narrow, true);
  assert.ok(Math.abs(await page.locator('.instance-step-column').evaluate(node => node.getBoundingClientRect().width) - widthBefore) < 1);
  await expect(row('env').locator('[data-variable-value]')).toHaveText('未应用环境');
  await capture('03-narrow-drawer');

  menu = await openMenu('env'); await menu.getByRole('menuitem', { name: '编辑定义与默认值', exact: true }).click();
  form = panel.getByRole('dialog', { name: '编辑变量定义', exact: true });
  await form.getByRole('textbox', { name: '变量说明', exact: true }).fill('抽屉收起后继续编辑的说明');
  await page.getByRole('button', { name: '关闭变量面板并返回正文', exact: true }).click();
  await expect(panel).not.toBeVisible(); assert.equal((await preferences()).narrow, false);
  await page.getByRole('button', { name: '展开变量面板', exact: true }).click();
  await expect(form.getByRole('textbox', { name: '变量说明', exact: true })).toHaveValue('抽屉收起后继续编辑的说明');
  await form.getByRole('button', { name: '保存变量', exact: true }).click();
  await expect.poll(async () => (await work()).document.parameters.find(p => p.id === 'env').description).toBe('抽屉收起后继续编辑的说明');
  await panel.getByRole('button', { name: '收起变量面板', exact: true }).click();
  assert.equal((await preferences()).narrow, false);
  await page.locator('[data-step-id="p1"] .variable-token[data-parameter-id="env"]').first().click();
  await expect(panel).toBeVisible(); await expect(input('env')).toBeFocused();
  await expect(input('env')).toHaveValue('未应用环境'); assert.equal((await preferences()).narrow, false, 'Automatic locating must not write open preference');
  await capture('04-auto-open-retains-draft');
  await input('env').press('Escape'); await expect(panel).toBeVisible();
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
  assert.equal((await work()).parameterValues.env, '测试服');
  checks.push('07: 940px defaults to a 44px rail with exact missing/pending counts; opening preserves document width; backdrop and Escape close; value/definition drafts survive; auto locating focuses the original value without changing preferences.');

  await page.getByRole('button', { name: '展开变量面板', exact: true }).click();
  await panel.getByRole('button', { name: '应用全局参数', exact: true }).click();
  await expect.poll(async () => (await work()).parameterValues.env).toBe('未应用环境');
  assert.equal((await preferences()).narrow, true);
  await page.reload(); await openWork(); await expect(panel).toBeVisible(); await expect(panel).toHaveClass(/is-narrow/);
  assert.equal((await preferences()).wide, false);
  await page.setViewportSize({ width: 1360, height: 780 }); await expect(panel).toHaveClass(/is-collapsed/);
  await panel.getByRole('button', { name: '展开变量面板', exact: true }).click();
  await expect(panel).toHaveClass(/is-open/); await expect(panel).not.toHaveClass(/is-narrow/);
  assert.equal((await preferences()).wide, true); assert.equal((await preferences()).narrow, true);
  checks.push('07: explicit narrow open preference survives WebView reload; wide and narrow choices are independent. Reload is not a second-process restart test.');

  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-switcher').click();
    const otherBranch = panel.getByRole('button', { name: '展开 维护体验服', exact: true }); if (await otherBranch.count()) await otherBranch.click();
    await row('local-env').getByRole('button', { name: '选择变量 环境', exact: true }).click();
    await panel.getByRole('button', { name: '清空变量搜索', exact: true }).click();
    const tokens = await page.evaluate(() => Object.fromEntries(['--text', '--accent', '--variable-attention'].map(key => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim()])));
    const global = await row('env').locator('[data-variable-name]').evaluate(node => getComputedStyle(node).color);
    const local = await row('other-env').locator('[data-variable-name]').evaluate(node => getComputedStyle(node).color);
    const selected = await row('local-env').locator('[data-variable-name]').evaluate(node => getComputedStyle(node).color);
    const missing = await row('window').locator('[data-variable-name]').evaluate(node => getComputedStyle(node).color);
    assert.equal(global, rgb(tokens['--text'])); assert.equal(local, global);
    assert.equal(selected, rgb(tokens['--accent'])); assert.equal(missing, rgb(tokens['--variable-attention']));
    const missingToken = page.locator('[data-step-id="p1"] .variable-token[data-parameter-id="window"]').first();
    assert.equal(await missingToken.evaluate(node => getComputedStyle(node).color), rgb(tokens['--variable-attention']));
    await changeValue('env', theme + '-待应用');
    assert.equal(await row('env').locator('[data-variable-name]').evaluate(node => getComputedStyle(node).color), rgb(tokens['--variable-attention']));
    colors.push({ theme, global, local, selected, missing, tokens }); await capture(`05-colors-${theme}`);
    await panel.locator('[data-parameter-scope="global"]').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  }
  checks.push('10: both themes keep ordinary global/local variables neutral, selected variables blue, missing and unapplied values orange; body missing tokens use the same warning role.');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ ok: true, directory, checks, screenshots, geometry, colors, errors, preference: await preferences(), finalWork: await work(), realUserDataOpened: false, maintenanceCommandsExecuted: false, nativeMutations: 'single isolated create_work seed only', systemClipboardAccessed: false, nativeFileDialogsAutomated: false }, null, 2));
  console.log(JSON.stringify({ ok: true, output, directory, checks }));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ ok: false, directory, checks, screenshots, geometry, colors, errors, error: String(error), ui: await page.locator('body').innerText().catch(() => '') }, null, 2));
  throw error;
} finally { await browser.close(); }
