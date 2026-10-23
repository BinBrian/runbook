// Owns all launched processes and a fresh profile; never attaches to the user's app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const executable = path.resolve(process.env.RUNBOOK_TEST_EXECUTABLE ?? 'target/debug/runbook-desktop-candidate.exe');
assert.equal(path.dirname(executable).toLowerCase(), path.resolve('target/debug').toLowerCase());
assert.ok(['runbook-desktop.exe', 'runbook-desktop-candidate.exe'].includes(path.basename(executable)));
const directory = await mkdtemp(path.resolve('target/desktop-smoke-'));
const output = process.env.RUNBOOK_TEST_OUTPUT_DIR ?? '.artifacts/close-drafts-2026-10-21'; await mkdir(output, { recursive: true });
const checks = [], errors = [], layouts = [], exits = [];
let child, browser, page, exited;
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), load = () => native('checklist_load');
const templateId = 'close-draft-template', runId = 'close-draft-run', firstId = 'close-first', secondId = 'close-second';
const panel = () => page.getByRole('complementary', { name: '变量面板' });
const step = id => page.locator(`[data-step-id="${id}"]`);
const row = id => panel().locator(`[data-variable-id="${id}"]`);
const storage = () => page.evaluate(() => JSON.parse(localStorage.getItem('runbook.explicit-drafts.v1') || '{"entries":[]}'));
async function launch() {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  child = spawn(executable, [], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore', env: { ...process.env, RUNBOOK_DATA_DIR: directory, RUNBOOK_NO_ERROR_DIALOG: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
  exited = new Promise(resolve => child.once('exit', resolve));
  for (let attempt = 0; attempt < 70; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await new Promise(resolve => setTimeout(resolve, 150)); }
    assert.equal(child.exitCode, null);
  }
  assert.ok(browser); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.library-page')).toBeVisible();
  assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${directory}`));
  if (process.env.RUNBOOK_TEST_EXPECTED_ASSET) assert.ok((await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src))).some(src => src.endsWith(`/assets/${process.env.RUNBOOK_TEST_EXPECTED_ASSET}`)));
}
async function close(button = '关闭窗口') {
  const pid = child.pid;
  await page.getByRole('button', { name: button, exact: true }).click().catch(error => { if (!/closed/i.test(String(error))) throw error; });
  let timer; const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Normal close timed out')), 12000); })]).finally(() => clearTimeout(timer));
  assert.equal(code, 0); exits.push({ pid, code, button });
  await browser.close().catch(() => {}); browser = null;
}
async function open(kind, id) {
  await page.locator('.app-sidebar nav button').filter({ hasText: '工作记录' }).click();
  await page.locator(`[data-instance-id="${id}"]`).click();
}
async function openDraft(label) {
  await page.locator('.draft-menu > summary').click();
  await page.locator('.draft-menu-row').filter({ hasText: label }).locator('button').first().click();
}
async function capture(name) {
  const state = await page.evaluate(() => {
    const r = document.querySelector('.draft-menu')?.getBoundingClientRect(), c = document.querySelector('.window-close')?.getBoundingClientRect();
    return { width: innerWidth, rootWidth: document.documentElement.scrollWidth, draft: r && { left: r.left, right: r.right, width: r.width }, close: c && { left: c.left, right: c.right } };
  });
  assert.ok(state.rootWidth <= state.width); assert.ok(state.draft.width > 55); assert.ok(state.draft.right <= state.close.left);
  layouts.push({ name, ...state }); await page.screenshot({ path: `${output}/${name}.png` });
}
try {
  await launch();
  const document = { groups: [{ id: 'close-group', name: '玩家转区' }], parameters: [{ id: 'env', name: '环境', description: '', defaultValue: 'release' }, { id: 'player', ownerId: 'close-group', name: '玩家 ID', description: '', defaultValue: '9002001' }], steps: [
    { id: firstId, title: ['停止服务'], description: [], commands: [{ id: 'stop', text: ['stopserver ', { parameterId: 'env' }, ' all'] }] },
    { id: secondId, groupId: 'close-group', title: ['转区 ', { parameterId: 'player' }], description: [], commands: [] },
  ] };
  await apply({ type: 'create_work', id: templateId, name: '草稿原型工作', document });
  await apply({ type: 'repeat_work', id: runId, name: '关闭草稿工作', sourceId: templateId, carryValues: true });
  await apply({ type: 'start_instance', id: runId });
  await apply({ type: 'add_comment', id: runId, stepId: firstId, entryId: 'existing-comment', text: '已提交的评论' });
  await page.reload();
  await open('template', templateId);
  await row('env').getByRole('button', { name: '变量操作 环境', exact: true }).click();
  await page.getByRole('menuitem', { name: '编辑变量 环境', exact: true }).click();
  await panel().getByRole('textbox', { name: '变量默认值', exact: true }).fill('sandboxa 未提交');
  await open('instance', runId);
  if (!await row('env').locator('input[data-parameter-id]').count()) await row('env').locator('[data-variable-value]').dblclick(); await row('env').locator('input[data-parameter-id]').fill('preview 未应用');
  await page.locator(`[data-nav-step-id="${secondId}"]`).click();
  await step(secondId).locator('.comment-details > summary').click();
  await step(secondId).getByRole('textbox', { name: '添加评论' }).fill('后续组内步骤的评论草稿\n保留换行');
  await step(secondId).locator('.comment-details > summary').click();
  await page.locator(`[data-nav-step-id="${firstId}"]`).click();
  await step(firstId).getByRole('button', { name: '编辑评论', exact: true }).click();
  await step(firstId).getByRole('textbox', { name: '编辑评论' }).fill('评论编辑草稿');
  await page.locator('.heading-actions .more-menu > summary').click();
  await page.locator('.heading-actions .more-menu').getByRole('button', { name: '终止', exact: true }).click();
  await page.getByRole('textbox', { name: '终止原因' }).fill('尚未确认终止的原因草稿');
  const before = await load(), drafts = await storage(); assert.equal(drafts.entries.length, 5);
  await close(); checks.push('Active variable definition, unapplied parameter values, hidden group-step comment, comment edit and reason dialog do not block a normal close');

  await launch(); assert.deepEqual(await load(), before); assert.deepEqual(await storage(), drafts);
  checks.push('A real process restart with the same isolated profile restores all five exact drafts; SQLite values, comments, result history and progress are unchanged');
  await openDraft('变量定义');
  await expect(panel().getByRole('textbox', { name: '变量默认值', exact: true })).toHaveValue('sandboxa 未提交');
  await panel().getByRole('button', { name: '取消', exact: true }).click();
  await openDraft('步骤评论');
  await expect(step(secondId).getByRole('textbox', { name: '添加评论' })).toBeVisible();
  await expect(step(secondId).getByRole('textbox', { name: '添加评论' })).toHaveValue('后续组内步骤的评论草稿\n保留换行');
  await step(secondId).getByRole('button', { name: '添加评论', exact: true }).click();
  await expect(step(secondId).locator('.comment-record')).toContainText('后续组内步骤的评论草稿');
  await openDraft('评论编辑');
  await expect(step(firstId).getByRole('textbox', { name: '编辑评论' })).toHaveValue('评论编辑草稿');
  await step(firstId).getByRole('button', { name: '取消', exact: true }).click();
  await openDraft('终止本次工作');
  await expect(page.getByRole('textbox', { name: '终止原因' })).toHaveValue('尚未确认终止的原因草稿');
  await page.getByRole('dialog', { name: '终止本次工作' }).getByRole('button', { name: '取消', exact: true }).last().click();
  await openDraft('工作参数');
  await expect(row('env').locator('input[data-parameter-id]')).toHaveValue('preview 未应用');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { localStorage.setItem('runbook.appearance', theme); document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1360, 940]) { await page.setViewportSize({ width, height: 760 }); await page.locator('.draft-menu > summary').click(); await capture(`draft-menu-${theme}-${width}`); await page.locator('.draft-menu > summary').click(); }
  }
  await panel().getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await expect(page.locator('.draft-menu')).toHaveCount(0); assert.equal((await storage()).entries.length, 0);
  checks.push('Draft menu restores the original entity and expands/focuses the exact hidden group step; explicit submit/cancel clears only its own durable draft; four menu layouts remain usable');
  await step(firstId).getByRole('button', { name: '记录失败', exact: true }).click();
  await page.getByRole('textbox', { name: '失败原因' }).fill('恢复后仍需确认参数的失败原因');
  await page.reload(); await open('instance', runId);
  if (!await row('env').locator('input[data-parameter-id]').count()) await row('env').locator('[data-variable-value]').dblclick(); await row('env').locator('input[data-parameter-id]').fill('尚未应用的另一环境');
  await openDraft('记录失败');
  const beforeReason = await load();
  await page.getByRole('button', { name: '保存失败记录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请先应用或取消');
  assert.deepEqual(await load(), beforeReason);
  await expect(page.getByRole('textbox', { name: '失败原因' })).toHaveValue('恢复后仍需确认参数的失败原因');
  await page.getByRole('dialog', { name: '记录失败', exact: true }).getByRole('button', { name: '取消', exact: true }).last().click();
  await panel().getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  assert.equal((await storage()).entries.length, 0);
  checks.push('A restored failure reason retains the usual unapplied-parameter check: attempting submit preserves the reason and changes no business state');
  const name = page.locator('[data-inline-field="工作名称"]'); await name.dblclick(); await page.getByRole('textbox', { name: '工作名称', exact: true }).fill('关闭前即时编辑');
  await close(); await launch();
  assert.equal((await load()).instances.find(item => item.id === runId).name, '关闭前即时编辑'); assert.equal((await storage()).entries.length, 0);
  checks.push('Closing before the 500ms autosave interval still flushes inline content, and cleared drafts stay cleared after a second real restart');

  await open('instance', runId); await step(firstId).locator('.comment-details > summary').click();
  await page.evaluate(() => { const original = Storage.prototype.setItem; window.__restoreDraftStorage = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = function(key, value) { if (key === 'runbook.explicit-drafts.v1') throw new Error('QA storage write failure'); return original.call(this, key, value); }; });
  await step(firstId).getByRole('textbox', { name: '添加评论' }).fill('存储失败时保留的输入');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: '关闭前保存失败' })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toContainText('QA storage write failure');
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  await expect(step(firstId).getByRole('textbox', { name: '添加评论' })).toHaveValue('存储失败时保留的输入');
  await page.evaluate(() => window.__restoreDraftStorage());
  await close(); await launch();
  await openDraft('步骤评论');
  await expect(step(firstId).getByRole('textbox', { name: '添加评论' })).toHaveValue('存储失败时保留的输入');
  checks.push('A real draft write error offers return/retry/close; returning retains exact input, repairing storage then closing persists it across a third real restart');
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'runbook.explicit-drafts.v1') throw new Error('QA unrecoverable write failure'); return original.call(this, key, value); }; });
  await step(firstId).getByRole('textbox', { name: '添加评论' }).fill('明确放弃这一处失败的写入');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.screenshot({ path: `${output}/save-failure-choice.png` });
  await close('仍然关闭'); checks.push('Explicit still-close choice exits normally even if the storage error cannot be repaired; there is no unresolvable close lock');
  await launch(); await open('instance', runId);
  await step(firstId).locator(':scope > .step-card-heading [data-step-more-actions] button').click();
  await page.getByRole('menuitem', { name: '收藏这一步', exact: true }).click();
  await page.getByRole('textbox', { name: '收藏名称', exact: true }).fill('收藏名称未提交输入');
  const destination = (await load()).blocks[0].id;
  await page.getByLabel('保存到收藏').selectOption(destination);
  const favoriteBefore = await load(), favoriteDrafts = await storage();
  await close(); await launch();
  assert.deepEqual(await load(), favoriteBefore); assert.deepEqual(await storage(), favoriteDrafts);
  await openDraft('收藏步骤');
  await expect(page.getByRole('textbox', { name: '收藏名称', exact: true })).toHaveValue('收藏名称未提交输入');
  await expect(page.getByLabel('保存到收藏')).toHaveValue(destination);
  await page.getByRole('dialog', { name: '收藏步骤', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(!(await storage()).entries.some(([key]) => key.startsWith('favorite:')));
  await close(); checks.push('Favorite dialog name, original source step and explicit update destination survive a normal process exit/restart; cancel removes only the favorite draft and no snapshot is silently saved');
  assert.deepEqual(errors, []);
  const report = { ok: true, directory, executable, expectedAsset: process.env.RUNBOOK_TEST_EXPECTED_ASSET, checks, layouts, exits, errors, realUserDataOpened: false, maintenanceCommandsExecuted: false };
  await writeFile(`${output}/inspection.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await writeFile(`${output}/inspection.json`, JSON.stringify({ ok: false, directory, checks, exits, errors, error: String(error) }, null, 2)); throw error;
} finally {
  await browser?.close().catch(() => {}); if (child && child.exitCode === null) child.kill();
}
