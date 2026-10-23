// Current work-centered product flow. Uses only the desktop harness's isolated data.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openCommentComposer } from './step-materials.mjs';

assert.equal(process.env.RUNBOOK_CLIPBOARD_TEST_MODE, 'transport', 'This check must not access the system clipboard');
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase()); assert.match(path.basename(directory), /^desktop-smoke-/);
assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
const output = '.artifacts/work-records-2026-10-21'; await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(14000);
const checks = [], errors = [], layouts = []; page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), load = () => native('checklist_load');
const work = async id => (await load()).instances.find(item => item.id === id);
const sourceId = 'qa-work-history', step = id => page.locator(`[data-step-id="${id}"]`);
const nav = label => page.locator('.app-sidebar nav button').filter({ hasText: label }).click();
const row = id => page.locator(`[data-variable-id="${id}"]`), value = id => row(id).locator('input[data-parameter-id]');
async function fillValue(id, text) { if (!await value(id).count()) await row(id).locator('[data-variable-value]').dblclick(); await value(id).fill(text); }
async function shownValue(id) { return row(id).locator('[data-variable-value]').evaluate(n => n instanceof HTMLInputElement ? n.value : n.textContent); }
async function open(id, archived = false) { await nav(archived ? '归档' : '工作记录'); await page.locator(`[data-instance-id="${id}"]`).click(); await expect(page.locator('[data-inline-field="工作名称"]')).toBeVisible(); }
async function reason(type, text) { await step(type === 'failed' ? 'stop' : 'publish').getByRole('button', { name: type === 'failed' ? '记录失败' : '跳过', exact: true }).click(); const dialog = page.getByRole('dialog', { name: type === 'failed' ? '记录失败' : '跳过这一步', exact: true }); await dialog.getByRole('textbox').fill(text); await dialog.getByRole('button', { name: type === 'failed' ? '保存失败记录' : '确认跳过', exact: true }).click(); await expect(dialog).toHaveCount(0); }
async function repeat(name, carry = true) { await page.locator('.heading-actions').getByRole('button', { name: '再做一次', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '再做一次', exact: true }); await dialog.getByRole('textbox', { name: '工作名称', exact: true }).fill(name); await expect(dialog.getByRole('checkbox')).toBeChecked(); if (!carry) await dialog.getByRole('checkbox').uncheck(); await dialog.getByRole('button', { name: '创建新工作', exact: true }).click(); await expect(dialog).toHaveCount(0); const item = (await load()).instances.find(item => item.name === name); assert.ok(item); return item; }
async function copyCommand(id, expected) { const before = await page.evaluate(() => window.__workSmoke.copies.length); await step(id).getByRole('button', { name: '复制命令', exact: true }).click(); await expect.poll(() => page.evaluate(() => window.__workSmoke.copies.length)).toBe(before + 1); assert.equal(await page.evaluate(() => window.__workSmoke.copies.at(-1)), expected); }
async function capture(name) { const geometry = await page.evaluate(() => ({ width: innerWidth, rootWidth: document.documentElement.scrollWidth, workspaces: document.querySelectorAll('.workspace-page').length })); assert.ok(geometry.rootWidth <= geometry.width); assert.equal(geometry.workspaces, 1); layouts.push({ name, ...geometry }); await page.screenshot({ path: `${output}/${name}.png` }); }

try {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__workSmoke = { copies: [], exports: [], imports: [], probe: 0 };
    const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'http://ipc.localhost' && !(url.protocol === 'ipc:' && url.hostname === 'localhost')) return original(input, init);
      const command = decodeURIComponent(url.pathname.slice(1)), args = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (command === 'work_smoke_probe') { window.__workSmoke.probe++; return reply(true); }
      if (command === 'plugin:clipboard-manager|write_text') { window.__workSmoke.copies.push(args.text); return reply(null); }
      if (command === 'checklist_save_export') { window.__workSmoke.exports.push(structuredClone(args)); return reply(true); }
      if (command === 'checklist_pick_import') return reply(window.__workSmoke.imports.shift() ?? null);
      return original(input, init);
    };
  });
  await page.reload(); await expect(page.locator('.library-page')).toBeVisible(); assert.equal(await native('work_smoke_probe'), true);
  const initial = await load(); assert.equal(initial.templates.length, 0); assert.ok(initial.instances.some(item => item.name === '示例补丁维护' && item.status === 'draft'));
  assert.deepEqual(await page.locator('.app-sidebar nav button > span').allTextContents(), ['工作记录', '收藏的步骤', '归档']);
  await expect(page.getByRole('button', { name: '新建工作', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建工作', exact: true }).click(); let dialog = page.getByRole('dialog', { name: '新建工作', exact: true }); await dialog.getByRole('textbox', { name: '工作名称' }).fill('QA 空白直接工作'); await dialog.getByRole('button', { name: '新建工作', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const blank = (await load()).instances.find(item => item.name === 'QA 空白直接工作'); assert.ok(blank); assert.equal(blank.sourceTemplateId, null); assert.equal(blank.status, 'draft'); assert.equal(blank.document.steps.length, 1);
  const blankStep = step(blank.document.steps[0].id); await blankStep.locator('[data-inline-field="步骤标题"]').dblclick(); await blankStep.getByRole('textbox', { name: '步骤标题', exact: true }).fill('直接编辑本次步骤');
  await blankStep.getByRole('button', { name: '步骤新增', exact: true }).click(); await page.getByRole('menuitem', { name: '添加命令', exact: true }).click(); await blankStep.getByRole('textbox', { name: '命令 1', exact: true }).fill('echo independent-work'); await copyCommand(blank.document.steps[0].id, 'echo independent-work');
  await expect.poll(async () => (await work(blank.id)).document.steps[0].title).toEqual(['直接编辑本次步骤']);
  checks.push('No template module or template prerequisite remains: a fresh sample is a work; direct new-work creation, inline step/command editing, left-plus add and exact copy transport work');

  const document = { groups: [{ id: 'player-group', name: '玩家转区', description: '一名玩家的一组工作' }], parameters: [{ id: 'env', name: '环境', description: '', defaultValue: 'release' }, { id: 'player', ownerId: 'player-group', name: '玩家 ID', description: '', defaultValue: '123' }], steps: [
    { id: 'stop', groupId: 'player-group', title: ['停止服务 ', { parameterId: 'player' }], description: ['核对环境 ', { parameterId: 'env' }], commands: [{ id: 'stop-command', text: ['stopserver ', { parameterId: 'env' }, ' all'] }] },
    { id: 'publish', groupId: 'player-group', title: ['发布更新'], description: ['玩家 ', { parameterId: 'player' }], commands: [{ id: 'publish-command', text: ['publishgame ', { parameterId: 'env' }] }] },
    { id: 'verify', title: ['人工核验'], description: [], commands: [] },
  ] };
  await apply({ type: 'create_work', id: sourceId, name: 'QA 维护历史', document }); await page.reload(); await expect(page.locator('.library-page')).toBeVisible(); await open(sourceId);
  await fillValue('env', 'sandboxa'); await fillValue('player', '456'); await page.getByRole('button', { name: '开始记录', exact: true }).click(); await expect(step('stop')).toHaveClass(/is-current/); await expect(page.locator('.save-state')).toHaveText('已保存在本机');
  await copyCommand('stop', 'stopserver sandboxa all'); await reason('failed', '服务状态未确认');
  await openCommentComposer(step('stop')); await step('stop').getByRole('textbox', { name: '添加评论', exact: true }).fill('外部输出和本次异常'); await step('stop').getByRole('button', { name: '添加评论', exact: true }).click();
  await expect(step('stop').locator('.comment-record')).toContainText('外部输出和本次异常');
  await expect(step('stop').locator('input[type="file"]')).toBeEnabled();
  const imageBytes = await readFile('docs/examples/patch-maintenance/images/package-check-demo.png'); await step('stop').locator('input[type="file"]').setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: imageBytes }); await expect(step('stop').locator('.image-preview img')).toBeVisible();
  await fillValue('env', 'preview'); const beforeDraftCopy = await work(sourceId); const fromFailure = await repeat('QA 从失败工作再做一次'); assert.equal(fromFailure.parameterValues.env, 'sandboxa'); assert.equal(fromFailure.entries.length, 0); assert.deepEqual(await work(sourceId), beforeDraftCopy);
  await open(sourceId); await expect.poll(() => shownValue('env')).toBe('preview'); await page.getByRole('button', { name: '应用全局参数', exact: true }).click(); await copyCommand('stop', 'stopserver preview all'); await step('stop').getByRole('button', { name: '完成并下一步', exact: true }).click();
  await expect(step('publish')).toHaveClass(/is-current/); await reason('skipped', '本次无需重新发布'); await expect(step('verify')).toHaveClass(/is-current/); await step('verify').getByRole('button', { name: '完成并结束', exact: true }).click();
  await expect(page.locator('.completion-banner')).toContainText('本次工作已结束'); await page.locator('.completion-banner').getByRole('button', { name: '归档', exact: true }).click();
  const original = await work(sourceId); assert.ok(original.archivedAt); assert.equal(original.status, 'completed'); assert.equal(original.entries.filter(entry => entry.type === 'result').length, 4); assert.equal(original.entries.find(entry => entry.type === 'result').snapshot.parameterValues.env, 'sandboxa');
  checks.push('Work-centered fill/start/copy/manual failure, output comment, image, parameter apply, retry, skip, completion and archive form a complete flow; rerunning a failed current work copies applied values and excludes unapplied drafts');

  const repeated = await repeat('QA 本次独立工作'); assert.equal(repeated.status, 'draft'); assert.equal(repeated.sourceInstanceId, sourceId); assert.equal(repeated.sourceTemplateId, null); assert.deepEqual(repeated.document, original.document); assert.deepEqual(repeated.parameterValues, original.parameterValues); assert.deepEqual(repeated.entries, []); for (const key of ['startedAt', 'finishedAt', 'currentStepId', 'terminationReason', 'archivedAt']) assert.equal(repeated[key], null);
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeVisible(); await step('stop').locator('[data-inline-field="命令 1"]').dblclick(); await step('stop').getByRole('textbox', { name: '命令 1', exact: true }).fill('echo only-this-work'); await copyCommand('stop', 'echo only-this-work'); assert.deepEqual(await work(sourceId), original);
  await fillValue('env', 'sandboxd'); await page.getByRole('button', { name: '应用全局参数', exact: true }).click(); assert.equal((await work(repeated.id)).parameterValues.env, 'sandboxd'); assert.deepEqual(await work(sourceId), original);
  await open(sourceId, true); const defaults = await repeat('QA 使用默认值重做', false); assert.equal(defaults.parameterValues.env, 'release'); assert.equal(defaults.parameterValues.player, '123'); assert.deepEqual(await work(sourceId), original);
  checks.push('Completed archived work can be rerun with copied values or definition defaults; every new work is editable, unstarted and independent; all old results/materials/time/archival fields remain only in the source');

  for (const theme of ['light', 'dark']) { if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-switcher').click(); for (const width of [1360, 940]) { await page.setViewportSize({ width, height: 760 }); await capture(`work-${theme}-${width}`); } }
  await open(sourceId, true); await page.getByRole('button', { name: '导出存档', exact: true }).click(); await expect.poll(() => page.evaluate(() => window.__workSmoke.exports.length)).toBe(1); const archive = await page.evaluate(() => window.__workSmoke.exports[0]); assert.match(archive.name, /\.runbook\.zip$/); await writeFile(path.join(directory, 'completed-work.runbook.zip'), Buffer.from(archive.bytes));
  await page.evaluate(file => window.__workSmoke.imports.push(file), archive); await page.getByRole('button', { name: '导入', exact: true }).click(); dialog = page.getByRole('dialog', { name: '导入预览', exact: true }); await expect(dialog).toContainText('本地已存在同一份工作记录'); const oldIds = new Set((await load()).instances.map(item => item.id)); await dialog.getByRole('button', { name: '导入为独立副本', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const imported = (await load()).instances.find(item => !oldIds.has(item.id)); assert.ok(imported); assert.deepEqual(imported.entries, original.entries); assert.deepEqual(imported.document, original.document); assert.deepEqual(imported.parameterValues, original.parameterValues); assert.equal(imported.status, original.status); assert.equal(imported.archivedAt, original.archivedAt);
  const image = imported.entries.find(entry => entry.type === 'image'); const dataUrl = await native('checklist_read_image', { instanceId: imported.id, path: image.path }); assert.deepEqual(Buffer.from(dataUrl.split(',')[1], 'base64'), imageBytes); assert.deepEqual(await work(sourceId), original);
  await repeat('QA 导入历史也能再做一次');
  checks.push('Native complete ZIP export and UI duplicate import preserve all work history, values and exact image bytes; imported historical work is also an ordinary reusable prototype');

  await open(blank.id); await page.locator('.heading-actions .more-menu > summary').click(); await page.getByRole('button', { name: '删除工作', exact: true }).click(); dialog = page.getByRole('dialog', { name: '删除工作', exact: true }); await dialog.getByRole('button', { name: '确认删除工作', exact: true }).click(); await expect(dialog).toHaveCount(0); assert.equal(await work(blank.id), undefined); assert.deepEqual(await work(sourceId), original);
  await nav('收藏的步骤'); await expect(page.locator('[data-favorite-id]').first()).toBeVisible(); await page.locator('[data-favorite-id] .favorite-toggle').first().click(); await expect(page.locator('[data-favorite-preview]')).toBeVisible();
  checks.push('Whole-work deletion has explicit confirmation and preserves other records; reusable step blocks remain available as content tools without a template module');
  assert.deepEqual(errors, []); const report = { ok: true, directory, checks, layouts, errors, sourceId, repeatedId: repeated.id, defaultId: defaults.id, importedId: imported.id, realUserDataOpened: false, maintenanceCommandsExecuted: false, clipboardMode: 'transport', nativeFileDialogsAutomated: false };
  await writeFile(`${output}/inspection.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page.screenshot({ path: `${output}/failure.png` }).catch(() => {}); await writeFile(`${output}/inspection.json`, JSON.stringify({ ok: false, directory, checks, layouts, errors, error: String(error) }, null, 2)); throw error; }
finally { await browser.close(); }
