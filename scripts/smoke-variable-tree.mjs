import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
assert.equal(process.env.RUNBOOK_CLIPBOARD_TEST_MODE, 'transport');
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase()); assert.match(path.basename(directory), /^desktop-smoke-/);
const output = process.env.RUNBOOK_TEST_OUTPUT_DIR ?? '.artifacts/variable-tree-2026-10-21'; await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(12000);
const errors = [], checks = [], layouts = []; page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), load = () => native('checklist_load');
const workId = 'tree-work', work = async () => (await load()).instances.find(i => i.id === workId);
const panel = page.getByRole('complementary', { name: '变量面板' }), row = id => panel.locator(`[data-variable-id="${id}"]`), value = id => row(id).locator('input[data-parameter-id]');
const search = panel.locator('input[aria-label="搜索变量"]'), step = id => page.locator(`[data-step-id="${id}"]`);
async function menu(id, item) { await row(id).hover(); await row(id).getByRole('button', { name: /^变量操作 / }).click(); await page.getByRole('menuitem', { name: item, exact: true }).click(); }
async function fillValue(id, text) { if (!await value(id).count()) await row(id).locator('[data-variable-value]').dblclick(); await value(id).fill(text); }
async function clear() { if (await panel.getByRole('button', { name: '清空变量搜索', exact: true }).count()) await panel.getByRole('button', { name: '清空变量搜索', exact: true }).click(); }
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('.variable-panel'), a = panel.getBoundingClientRect(), leaf = panel.querySelector('[data-variable-id]'), r = leaf.getBoundingClientRect(), styles = getComputedStyle(leaf);
    return { width: innerWidth, rootWidth: document.documentElement.scrollWidth, panelWidth: a.width, panelScrollWidth: panel.scrollWidth, rowHeight: r.height, border: styles.borderTopWidth, background: styles.backgroundColor, bodySearches: document.querySelectorAll('.instance-step-column input[type=search]').length };
  });
  assert.ok(geometry.rootWidth <= geometry.width); assert.ok(geometry.panelScrollWidth <= geometry.panelWidth); assert.ok(geometry.rowHeight <= 38); assert.equal(geometry.border, '0px'); assert.equal(geometry.bodySearches, 0);
  layouts.push({ name, ...geometry }); await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' });
}
const document = { groups: [{ id: 'players', name: '玩家转区' }, { id: 'restart', name: '维护 sandboxa' }, { id: 'empty', name: '空组' }], parameters: [
  { id: 'env', name: '环境', description: '这是应只在编辑时出现的长说明', defaultValue: 'release' },
  { id: 'window', name: '维护时间', description: '', defaultValue: ' \t ' },
  { id: 'player', ownerId: 'players', name: '玩家ID', description: '', defaultValue: '123' },
  { id: 'local-env', ownerId: 'players', name: '环境', description: '', defaultValue: 'preview' },
  { id: 'server-env', ownerId: 'restart', name: '环境', description: '', defaultValue: 'sandboxa' },
  { id: 'account', ownerId: 'transfer-two', name: '平台账号', description: '', defaultValue: '456' },
  { id: 'version', ownerId: 'finish', name: '版本', description: '', defaultValue: 'v1' },
  ...Array.from({ length: 10 }, (_, i) => ({ id: 'extra-' + i, name: i === 9 ? '用于验证超长变量名称不会挤压实际值区域' : '扩展参数 ' + (i + 1), description: '', defaultValue: i === 9 ? '2026-10-21-very-long-value-with-no-spaces' : String(i) })),
], steps: [
  { id: 'prepare', title: ['维护准备 ', { parameterId: 'window' }], description: [{ parameterId: 'window' }, ' / ', { parameterId: 'extra-0' }], commands: [{ id: 'cmd-prepare', text: ['maintain ', { parameterId: 'env' }, ' ', { parameterId: 'window' }] }] },
  { id: 'transfer-one', groupId: 'players', title: ['检查玩家'], description: [{ parameterId: 'player' }], commands: [{ id: 'cmd-check', text: ['check ', { parameterId: 'local-env' }] }] },
  { id: 'transfer-two', groupId: 'players', title: ['导出玩家'], description: [{ parameterId: 'window' }, { parameterId: 'account' }], commands: [{ id: 'cmd-export', text: ['export ', { parameterId: 'player' }] }] },
  { id: 'server', groupId: 'restart', title: ['停止服务'], description: [], commands: [{ id: 'cmd-stop', text: ['stopserver ', { parameterId: 'server-env' }, ' all'] }] },
  { id: 'empty-step', groupId: 'empty', title: ['人工核验'], description: [], commands: [] },
  { id: 'finish', title: ['结束'], description: [{ parameterId: 'version' }], commands: [] },
] };
try {
  await page.addInitScript(() => { const original = window.fetch.bind(window); window.__treeCopies = []; window.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); const command = decodeURIComponent(url.pathname.slice(1)); if (url.origin === 'http://ipc.localhost' && command.startsWith('plugin:clipboard-manager|write_')) { window.__treeCopies.push({ command, args: JSON.parse(init.body) }); return new Response('null', { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } }); } return original(input, init); }; });
  await apply({ type: 'create_work', id: workId, name: '变量树交互验证', document }); await page.reload(); await page.locator(`[data-instance-id="${workId}"]`).click(); await expect(panel).toBeVisible();
  const pending = step('prepare').locator('.variable-token[data-parameter-id="window"]');
  await expect(pending).toHaveText(['维护时间','维护时间','维护时间']);
  for(const token of await pending.all()) { await expect(token).toHaveAttribute('title','未填写'); await expect(token).toHaveAttribute('aria-description','未填写'); assert.equal(await token.evaluate(n=>getComputedStyle(n).borderStyle),'dashed'); }
  await pending.first().hover(); await expect(pending.first()).toHaveAttribute('title','未填写');
  const zero = step('prepare').locator('.variable-token[data-parameter-id="extra-0"]'); await expect(zero).toHaveText('0'); assert.equal(await zero.getAttribute('data-variable-missing'),null); assert.equal(await zero.evaluate(n=>getComputedStyle(n).borderStyle),'solid');
  const summary = page.locator('.missing-parameter-tag[data-parameter-target="window"]'); await expect(summary).toHaveText('维护时间'); await expect(summary).toHaveAttribute('title','维护时间：未填写'); assert.equal(await summary.evaluate(n=>getComputedStyle(n).borderStyle),'dashed');
  for(const theme of ['light','dark']) { if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('.theme-switcher').click(); await page.setViewportSize({width:theme==='light'?1360:940,height:780}); await page.screenshot({path:`${output}/pending-${theme}.png`}); }
  await page.setViewportSize({width:1360,height:780}); await page.locator('.theme-switcher').click();
  checks.push('Whitespace-only applied values show only the variable name in title/description/command tags with dashed borders and hover/accessibility missing hints; summaries use the same border semantic, while text zero remains a filled solid tag');
  await expect(page.locator('.variable-step-search,.variable-panel-context,.variable-value-caption')).toHaveCount(0);
  await expect(panel.locator('[data-variable-scope="global"]')).not.toContainText('已应用值'); await expect(row('env')).not.toContainText('本次值');
  assert.equal(await row('env').getAttribute('aria-level'), '1'); await expect(panel.locator('[data-parameter-scope="empty"]')).toHaveCount(0);
  await panel.getByRole('button', { name: '展开 玩家转区', exact: true }).click(); await expect(row('player').locator('[data-variable-value]')).toHaveText('123');
  assert.equal(await row('player').getAttribute('aria-level'), '2'); assert.equal(await row('account').getAttribute('aria-level'), '3');
  await row('player').getByRole('button', { name: '选择变量 玩家ID', exact: true }).click(); await expect(row('player')).toHaveAttribute('data-selected', 'true'); await expect(search).toHaveValue('玩家转区.玩家ID'); await expect.poll(() => page.locator('[data-step-id]').evaluateAll(nodes => nodes.map(n => n.dataset.stepId))).toEqual(['transfer-one', 'transfer-two']);
  await clear(); await search.fill('维护 sandboxa.环境'); await expect(row('server-env').locator('[data-variable-value]')).toHaveText('sandboxa'); await expect(row('local-env')).toHaveCount(0); await expect(page.locator('[data-step-id]')).toHaveCount(1); await expect(step('server')).toBeVisible();
  await search.press('Escape'); await expect(page.locator('[data-group-id]')).toHaveCount(3);
  checks.push('Whole-work tree has global root leaves, group/local children and nested step locals; empty scopes have no placeholder, one right-side search filters exact namespaced references and Escape restores all steps');
  await menu('env', '复制变量引用 环境'); await expect.poll(() => page.evaluate(() => window.__treeCopies.length)).toBe(1); const copied = await page.evaluate(() => window.__treeCopies[0]); assert.match(copied.command, /write_html$/); assert.ok(JSON.stringify(copied.args).includes('env'));
  await menu('env', '编辑变量 环境'); const form = page.getByRole('dialog', { name: '编辑变量定义', exact: true }); await expect(form.getByRole('textbox', { name: '变量说明', exact: true })).toHaveValue('这是应只在编辑时出现的长说明'); await form.getByRole('button', { name: '取消', exact: true }).click();
  await row('env').hover(); await row('env').getByRole('button', { name: '变量操作 环境', exact: true }).click(); await expect(page.getByRole('menuitem', { name: '删除变量 环境', exact: true })).toBeDisabled(); await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: '新增变量', exact: true }).click(); await page.getByRole('menuitem', { name: '新增全局变量', exact: true }).click(); let add = page.getByRole('dialog', { name: '新增变量', exact: true }); await add.getByRole('textbox', { name: '变量名称', exact: true }).fill('可删除的变量'); await add.getByRole('textbox', { name: '变量默认值', exact: true }).fill('new-default'); await add.getByRole('button', { name: '保存变量', exact: true }).click(); await expect(add).toHaveCount(0); await expect(page.locator('.save-state')).toHaveText('已保存在本机'); const created = (await work()).document.parameters.find(p => p.name === '可删除的变量'); assert.ok(created); await menu(created.id, '删除变量 可删除的变量'); await expect(row(created.id)).toHaveCount(0);
  await panel.locator('[data-parameter-scope="restart"]').getByRole('button', { name: '作用域操作 维护 sandboxa', exact: true }).click(); await page.getByRole('menuitem', { name: '新增步骤组变量', exact: true }).click(); add = page.getByRole('dialog', { name: '新增变量', exact: true }); await add.getByRole('textbox', { name: '变量名称', exact: true }).fill('本组新增'); await add.getByRole('textbox', { name: '变量默认值', exact: true }).fill('group-only'); await add.getByRole('button', { name: '保存变量', exact: true }).click(); await expect(add).toHaveCount(0); await expect(page.locator('.save-state')).toHaveText('已保存在本机'); assert.equal((await work()).document.parameters.find(p => p.name === '本组新增').ownerId, 'restart');
  checks.push('All leaf management is in keyboard-accessible ellipsis menus; reference copy sends exact HTML IPC, edit opens the original definition form, referenced deletion is disabled, top/branch add preserves global/local ownership');
  await fillValue('env', 'preview'); assert.equal((await work()).parameterValues.env, 'release'); await expect(row('env').getByRole('status', { name: '未应用', exact: true })).toBeVisible();
  await page.locator('.missing-parameter-tags').getByRole('button').filter({ hasText: '维护时间' }).click(); await expect(value('window')).toBeFocused(); await expect(search).toHaveValue('维护时间'); await expect(page.locator('[data-step-id]')).toHaveCount(2);
  await fillValue('window', '2026-10-21-08-00'); await expect(pending).toHaveText(['维护时间','维护时间','维护时间']);
  assert.equal(await pending.first().evaluate(n=>getComputedStyle(n,'::before').borderStyle),'dashed','search highlight must preserve missing-state borders');
  await panel.getByRole('button', { name: '应用全局参数', exact: true }).click(); await expect.poll(async () => (await work()).parameterValues.env).toBe('preview'); assert.equal((await work()).parameterValues.window, '2026-10-21-08-00');
  await expect(pending).toHaveText(['2026-10-21-08-00','2026-10-21-08-00','2026-10-21-08-00']); assert.equal(await pending.first().getAttribute('data-variable-missing'),null); assert.equal(await pending.first().evaluate(n=>getComputedStyle(n,'::before').borderStyle),'solid'); await clear(); assert.equal(await pending.first().evaluate(n=>getComputedStyle(n).borderStyle),'solid');
  checks.push('Typing a value draft leaves body tags pending until explicit apply; search background remains dashed while pending and becomes solid with the applied value; clearing search retains the correct filled state');
  await fillValue('env', 'cancel-me'); await panel.getByRole('button', { name: '取消本范围修改', exact: true }).click(); await expect(row('env').locator('[data-variable-value]')).toHaveText('preview'); await clear();
  for (const theme of ['light', 'dark']) { if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-switcher').click(); for (const width of [1360, 940]) { await page.setViewportSize({ width, height: 780 }); await capture(`tree-${theme}-${width}`); } const colors = await page.evaluate(() => { const root = getComputedStyle(document.documentElement), g = document.querySelector('[data-variable-id="env"]'), l = document.querySelector('[data-variable-id="player"]'); return { global: getComputedStyle(g).getPropertyValue('--variable-ink').trim(), local: getComputedStyle(l).getPropertyValue('--variable-ink').trim(), expectedGlobal: root.getPropertyValue('--variable-global').trim(), expectedLocal: root.getPropertyValue('--variable-local').trim() }; }); assert.equal(colors.global, colors.expectedGlobal); assert.equal(colors.local, colors.expectedLocal); }
  checks.push('Missing tags drive the same right-hand query, expand ancestors and focus the exact input; unapplied cross-scope drafts are retained, apply/cancel remains explicit; neutral compact rows have global orange/local blue tokens in both appearances and widths');
  await page.getByRole('button', { name: '开始记录', exact: true }).click(); await expect(step('prepare')).toHaveClass(/is-current/); await step('prepare').getByRole('button', { name: '完成并下一步', exact: true }).click(); await expect(step('transfer-one')).toHaveClass(/is-current/);
  await fillValue('env', 'production'); await panel.getByRole('button', { name: '应用全局参数', exact: true }).click(); await expect.poll(async () => (await work()).parameterValues.env).toBe('production');
  await page.locator('[data-nav-step-id="prepare"]').click(); await expect(row('env').locator('[data-variable-value]')).toHaveText('preview'); await expect(row('env').locator('[data-variable-value]')).toHaveAttribute('data-value-readonly', 'true'); await expect(row('server-env').locator('[data-variable-value]')).toHaveAttribute('data-value-readonly', 'false');
  await search.fill('维护 sandboxa.环境'); await menu('server-env', '编辑变量 环境'); await expect(page.getByRole('dialog', { name: '编辑变量定义', exact: true }).getByRole('textbox', { name: '变量默认值', exact: true })).toHaveValue('sandboxa'); await page.getByRole('dialog', { name: '编辑变量定义', exact: true }).getByRole('button', { name: '取消', exact: true }).click(); await clear();
  assert.equal((await work()).entries.filter(e => e.type === 'result').length, 1); await page.reload(); await page.locator(`[data-instance-id="${workId}"]`).click(); await expect(page.locator('.variable-step-search')).toHaveCount(0); assert.equal((await work()).currentStepId, 'transfer-one');
  checks.push('Historical globals show frozen values and stay read-only; unrelated future group definitions remain editable, current applied values/results survive reload without snapshot changes');
  assert.deepEqual(errors, []); await writeFile(`${output}/inspection.json`, JSON.stringify({ ok: true, directory, checks, layouts, errors, realUserDataOpened: false, maintenanceCommandsExecuted: false, clipboardMode: 'transport', nativeFileDialogsAutomated: false }, null, 2)); console.log(JSON.stringify({ ok: true, directory, checks }));
} catch (error) { await page.screenshot({ path: `${output}/failure.png` }).catch(() => {}); await writeFile(`${output}/inspection.json`, JSON.stringify({ ok: false, directory, checks, layouts, errors, error: String(error) }, null, 2)); throw error; }
finally { await browser.close(); }
