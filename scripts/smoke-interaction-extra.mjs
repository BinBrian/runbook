import { openCommentComposer } from './step-materials.mjs';
// node scripts/check-desktop.mjs scripts/smoke-interaction-extra.mjs
// Test data belongs to the harness. Termination and comments use the real UI.
// Setup uses native fixture creation/start only. No clipboard or command runs.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && process.env.RUNBOOK_CDP_URL, 'Run through the isolated desktop harness');
assert.equal(path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''), path.resolve(directory));
const actual = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actual}`));

const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(15000);
const extraSteps = [], pageErrors = [], consoleErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), workspace = () => native('checklist_load');
const templateId = 'qa-extra-termination-template', blockId = 'qa-extra-search-block', instanceId = 'qa-extra-termination-instance';
const currentOtherId = 'qa-extra-current-other', archiveId = 'qa-extra-archive-needle', archiveOtherId = 'qa-extra-archive-other';
const firstId = 'extra-first', lastId = 'extra-last';
const document = { parameters: [], steps: [
  { id: firstId, title: ['人工核验当前步骤'], description: ['本轮仅测试记录操作，不执行指令。'], commands: [] },
  { id: lastId, title: ['尚未处理的后续步骤'], description: ['终止后仍保持未执行。'], commands: [] },
] };
const blockDocument = { parameters: [], groups: [{ id: 'extra-block-group', name: '搜索测试步骤组' }], steps: [
  { id: 'extra-block-step', groupId: 'extra-block-group', title: ['搜索测试子步骤'], description: [''], commands: [] },
] };
const instance = async () => (await workspace()).instances.find(item => item.id === instanceId);
const step = id => page.locator(`[data-step-id="${id}"]`);
async function singleMain(stage) {
  assert.equal(await page.locator('.checklist-app').count(), 1, `${stage}: one app`);
  assert.equal(await page.locator('.app-main').count(), 1, `${stage}: one main`);
}
async function nav(label) {
  const button = page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: label });
  await expect(button).toHaveCount(1); await button.click(); await expect(page.locator('.library-page')).toBeVisible(); await singleMain(label);
}
async function evidence(id, title, action, expected, observed) {
  await singleMain(id);
  const screenshot = `.artifacts/interaction-extra-${id}.png`;
  await page.screenshot({ path: screenshot });
  extraSteps.push({ id, title, action, expected, observed, result: 'passed', screenshot });
}
async function openTermination() {
  // The real details element remains open while ActionDialog is shown and after
  // cancellation. Observe it before toggling; a second unconditional click would
  // close the already-open menu instead of exposing its termination entry.
  const menu = page.locator('.workspace-titlebar details.more-menu'); await expect(menu).toHaveCount(1);
  const more = menu.getByLabel('更多操作', { exact: true }); await expect(more).toHaveCount(1);
  if (!await menu.evaluate(element => element.open)) await more.click();
  await expect(menu).toHaveJSProperty('open', true);
  const terminate = menu.getByRole('button', { name: '终止', exact: true }); await expect(terminate).toBeVisible(); await terminate.click();
  const dialog = page.getByRole('dialog', { name: '终止本次工作', exact: true }); await expect(dialog).toBeVisible(); await singleMain('termination-dialog'); return dialog;
}

try {
  await mkdir('.artifacts', { recursive: true }); await page.setViewportSize({ width: 1360, height: 940 });
  // Establish the explicit prerequisite; the assertions below do not count this
  // fixture IPC as a tested UI create/start interaction.
  await apply({ type: 'create_template', id: templateId, name: 'QA EXTRA NEEDLE · 终止测试模板', document });
  await apply({ type: 'create_block', id: blockId, name: 'QA EXTRA NEEDLE · 搜索测试步骤块', document: blockDocument });
  await apply({ type: 'create_instance', id: instanceId, name: 'QA EXTRA CURRENT NEEDLE · 终止实例交互验证', templateId, fromInstanceId: null });
  await apply({ type: 'start_instance', id: instanceId });
  await apply({ type: 'create_instance', id: currentOtherId, name: 'QA EXTRA CURRENT OTHER · 列表搜索对照', templateId, fromInstanceId: null });
  for (const [id, name] of [[archiveId, 'QA EXTRA ARCHIVE NEEDLE · 历史搜索验证'], [archiveOtherId, 'QA EXTRA ARCHIVE OTHER · 历史搜索对照']]) {
    await apply({ type: 'create_instance', id, name, templateId, fromInstanceId: null });
    await apply({ type: 'start_instance', id });
    await apply({ type: 'record_result', id, outcome: 'completed', reason: null });
    await apply({ type: 'record_result', id, outcome: 'completed', reason: null });
    await apply({ type: 'archive_instance', id, archived: true });
  }
  await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor();

  for (const [kind, label, id, createLabel, nameLabel, submitLabel] of [
    ['template', '模板', templateId, '新建模板', '模板名称', '创建模板'],
    ['block', '步骤块', blockId, '新建步骤块', '步骤块名称', '创建步骤块'],
  ]) {
    await nav(label); const before = await workspace();
    const search = page.getByRole('textbox', { name: '搜索', exact: true }); await expect(search).toBeVisible(); await search.fill('qa extra needle');
    await expect(page.locator('.template-tile')).toHaveCount(1); await expect(page.locator(`[data-${kind}-id="${id}"]`)).toBeVisible();
    assert.deepEqual(await workspace(), before, 'Library filtering must not write data');
    await evidence(`${kind}-search`, `${label}库搜索`, '在库搜索栏输入小写 qa extra needle。', '仅展示名称匹配的对象，搜索不改变存储。', `唯一匹配夹具 ${id}；完整原生工作区未变化。`);
    await search.fill('QA EXTRA NO MATCH'); await expect(page.locator('.template-tile')).toHaveCount(0); await search.fill('');
    await expect(page.locator(`[data-${kind}-id="${id}"]`)).toBeVisible();
    const create = page.getByRole('button', { name: createLabel, exact: true }); await expect(create).toBeVisible(); await create.click();
    const dialog = page.getByRole('dialog', { name: createLabel, exact: true }); await expect(dialog).toBeVisible();
    const name = dialog.getByRole('textbox', { name: nameLabel, exact: true }), submit = dialog.getByRole('button', { name: submitLabel, exact: true });
    await expect(name).toHaveValue(''); await expect(submit).toBeDisabled(); await name.fill('   '); await expect(submit).toBeDisabled();
    assert.deepEqual(await workspace(), before, 'An empty/whitespace name cannot create an object');
    await evidence(`${kind}-empty-name`, `新建${label}空名校验`, '打开新建窗口，检查空名称，再输入全空格。', '空名称和纯空格均禁用创建；取消不落库。', '创建按钮持续禁用，工作区未变化；下一步通过取消返回列表。');
    // The header X has title="取消" too. Select the observed footer text action
    // explicitly rather than silently choosing one of two accessible matches.
    const cancel = dialog.locator('footer').getByRole('button', { name: '取消', exact: true }); await expect(cancel).toHaveCount(1);
    await cancel.click(); await expect(dialog).toHaveCount(0); assert.deepEqual(await workspace(), before); await singleMain(`${kind}-create-cancel`);
    extraSteps.at(-1).observed = '创建按钮在空名和全空格时持续禁用；随后点击页脚取消返回列表，完整原生工作区零变化。';
  }

  await nav('步骤块'); const beforeCreation = await workspace();
  await page.getByRole('button', { name: '新建步骤块', exact: true }).click();
  const createBlockDialog = page.getByRole('dialog', { name: '新建步骤块', exact: true }); await expect(createBlockDialog).toBeVisible();
  const createdName = 'QA UI 空白步骤块'; await createBlockDialog.getByRole('textbox', { name: '步骤块名称', exact: true }).fill(`  ${createdName}  `);
  const createBlock = createBlockDialog.locator('footer').getByRole('button', { name: '创建步骤块', exact: true }); await expect(createBlock).toBeEnabled(); await createBlock.click();
  await expect(createBlockDialog).toHaveCount(0); await expect(page.locator('[data-inline-field="步骤块名称"]')).toHaveText(createdName);
  const oldBlocks = new Set(beforeCreation.blocks.map(item => item.id));
  await expect.poll(async () => (await workspace()).blocks.filter(item => !oldBlocks.has(item.id)).length).toBe(1);
  const afterCreation = await workspace(), createdBlock = afterCreation.blocks.find(item => !oldBlocks.has(item.id));
  assert.equal(createdBlock.kind, 'block'); assert.equal(createdBlock.name, createdName); assert.equal(createdBlock.formatVersion, 2);
  assert.deepEqual(createdBlock.document.parameters, []); assert.equal(createdBlock.document.groups.length, 1); assert.equal(createdBlock.document.groups[0].name, createdName);
  assert.equal(createdBlock.document.steps.length, 1); const createdStep = createdBlock.document.steps[0];
  assert.equal(createdStep.groupId, createdBlock.document.groups[0].id); assert.deepEqual(createdStep.title, ['']); assert.deepEqual(createdStep.description, ['']); assert.deepEqual(createdStep.commands, []);
  assert.deepEqual(afterCreation.templates, beforeCreation.templates); assert.deepEqual(afterCreation.instances, beforeCreation.instances);
  assert.deepEqual(afterCreation.blocks.filter(item => oldBlocks.has(item.id)), beforeCreation.blocks);
  await evidence('block-create-confirm', '确认创建空白步骤块', '在步骤块库新建，填写非空名称并点击创建步骤块。', '创建独立空白块并打开详情，保留唯一组和一个空子步骤，不影响原有对象。', 'UI创建成功；原生数据为一个组、一个组内空标题/描述/命令子步骤、无参数，名称去除首尾空格；其他对象未变化。');

  const listSearches = [];
  for (const [label, id, query, archived] of [['当前工作', instanceId, 'qa extra current needle', false], ['归档', archiveId, 'qa extra archive needle', true]]) {
    await nav(label); const before = await workspace(), expectedCount = before.instances.filter(item => Boolean(item.archivedAt) === archived).length;
    await expect(page.locator('.instance-row')).toHaveCount(expectedCount); assert.ok(expectedCount >= 2, 'Search must have a real nonmatching peer');
    const search = page.getByRole('textbox', { name: '搜索', exact: true }); await expect(search).toBeVisible(); await search.fill(query);
    await expect(page.locator('.instance-row')).toHaveCount(1); await expect(page.locator(`[data-instance-id="${id}"]`)).toBeVisible();
    await search.fill('QA EXTRA NO MATCH'); await expect(page.locator('.instance-row')).toHaveCount(0); await search.fill('');
    await expect(page.locator('.instance-row')).toHaveCount(expectedCount); await expect(page.locator(`[data-instance-id="${id}"]`)).toBeVisible();
    assert.deepEqual(await workspace(), before); listSearches.push({ label, matchingId: id, restoredCount: expectedCount, storageUnchanged: true });
  }
  await evidence('instance-list-searches', '当前与归档列表搜索', '分别在当前工作和归档中搜索匹配名称、无匹配名称，再清空搜索。', '筛选只作用于所在列表，匹配唯一项、无匹配为空、清空恢复；不改工作数据。', `两个列表均完成真实搜索与清空；${listSearches.map(item => `${item.label}恢复${item.restoredCount}项`).join('，')}，原生工作区零变化。`);

  await nav('当前工作');
  const row = page.locator(`[data-instance-id="${instanceId}"]`); await expect(row).toBeVisible(); await expect(row).toContainText('进行中'); await row.click();
  await expect(page.locator('[data-inline-field="实例名称"]')).toHaveText('QA EXTRA CURRENT NEEDLE · 终止实例交互验证'); await singleMain('running-instance');
  await expect(step(firstId).getByRole('button', { name: '完成并下一步', exact: true })).toBeVisible();
  const running = await instance(); assert.equal(running.status, 'in_progress'); assert.equal(running.currentStepId, firstId); assert.deepEqual(running.entries, []);
  let dialog = await openTermination(); let reason = dialog.getByRole('textbox', { name: '终止原因', exact: true });
  const submit = dialog.getByRole('button', { name: '确认终止', exact: true });
  await expect(reason).toHaveValue(''); await expect(submit).toBeDisabled(); await reason.fill('  \n  '); await expect(submit).toBeDisabled();
  assert.deepEqual(await instance(), running);
  await evidence('termination-empty-reason', '终止必须填写原因', '从实例更多菜单进入终止，检查空原因及纯空白原因。', '确认终止禁用，实例仍进行中，当前步骤和记录不变化。', '两种空原因均被禁用；原生实例与终止前完全一致。');
  await reason.fill('临时原因，仅验证取消不会写入。'); await expect(submit).toBeEnabled();
  const cancelTermination = dialog.locator('footer').getByRole('button', { name: '取消', exact: true }); await expect(cancelTermination).toHaveCount(1);
  await cancelTermination.click(); await expect(dialog).toHaveCount(0); assert.deepEqual(await instance(), running);
  await expect(step(firstId).getByRole('button', { name: '完成并下一步', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-titlebar details.more-menu')).toHaveJSProperty('open', true);
  await evidence('termination-cancel', '取消终止保留工作', '填写临时终止原因后点击取消。', '关闭对话框，原实例保持进行中，结果操作继续可用。', '实例数据零变化；当前步完成按钮仍可见。原更多菜单保持展开，后续直接使用其现有终止入口。');

  dialog = await openTermination(); reason = dialog.getByRole('textbox', { name: '终止原因', exact: true }); await expect(reason).toHaveValue('');
  const terminationReason = '测试窗口结束，后续维护另建实例。'; await reason.fill(`  ${terminationReason}  `);
  const confirm = dialog.getByRole('button', { name: '确认终止', exact: true }); await expect(confirm).toBeEnabled();
  await evidence('termination-confirm', '确认终止', '重新打开终止窗口，填写明确原因，准备确认。', '原因非空才可确认；确认后停止推进且不能恢复。', '终止原因已输入，确认按钮可用；下一步点击确认并核对持久状态。');
  await confirm.click(); await expect(dialog).toHaveCount(0); await expect(page.locator('.completion-banner.terminated')).toContainText(terminationReason);
  await expect.poll(async () => (await instance()).status).toBe('terminated'); const terminated = await instance();
  assert.equal(terminated.terminationReason, terminationReason); assert.equal(terminated.currentStepId, null); assert.ok(terminated.finishedAt);
  assert.deepEqual(terminated.document, running.document); assert.deepEqual(terminated.entries, running.entries);
  await expect(page.locator('.result-actions')).toHaveCount(0); await expect(page.getByRole('button', { name: '步骤新增', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更多步骤操作', exact: true })).toHaveCount(0);
  const title = step(firstId).locator('[data-inline-field="步骤标题"]'); await title.dblclick(); await expect(step(firstId).getByRole('textbox', { name: '步骤标题', exact: true })).toHaveCount(0);
  await evidence('terminated-readonly', '终止后流程只读', '确认终止后检查状态、推进入口及标题双击。', '显示终止原因，结束推进、结构修改和正文编辑，已有流程及记录保留。', '已终止、currentStepId=null；完成/失败/跳过和结构菜单消失，双击不进入标题编辑，文档与旧记录未变化。');

  await openCommentComposer(step(firstId));
  const comment = step(firstId).getByRole('textbox', { name: '添加评论', exact: true }); await expect(comment).toBeVisible(); await expect(comment).toBeEnabled();
  const commentText = '终止后的补充说明：这里只补充留档，不改变推进结果。'; await comment.fill(commentText);
  const addComment = step(firstId).getByRole('button', { name: '添加评论', exact: true }); await expect(addComment).toBeEnabled(); await addComment.click();
  await expect.poll(async () => (await instance()).entries.some(entry => entry.type === 'comment' && entry.text === commentText)).toBe(true);
  await expect(comment).toHaveValue(''); await expect(step(firstId).locator('.comment-record')).toContainText(commentText);
  const afterComment = await instance(); assert.equal(afterComment.status, 'terminated'); assert.equal(afterComment.terminationReason, terminationReason); assert.equal(afterComment.currentStepId, null);
  assert.deepEqual(afterComment.document, running.document); assert.equal(afterComment.entries.length, running.entries.length + 1); assert.equal(afterComment.entries.at(-1).type, 'comment');
  await expect(page.locator('.save-state')).toContainText('已保存在本机'); await expect(page.getByRole('alert')).toHaveCount(0);
  await evidence('terminated-comment', '终止后仍可补充评论', '在终止实例当前展开步骤下填写评论并提交。', '评论独立留档，终止原因、流程和推进结果保持原状。', '评论已在真实原生记录和页面中保存；终止状态、原因、currentStepId及文档均未改变。');

  async function detailAction(label) {
    const menu = page.locator('.workspace-titlebar details.more-menu'); await expect(menu).toHaveCount(1);
    if (!await menu.evaluate(element => element.open)) await menu.getByLabel('更多操作', { exact: true }).click();
    await expect(menu).toHaveJSProperty('open', true);
    const action = menu.getByRole('button', { name: label, exact: true }); await expect(action).toBeVisible(); await action.click();
  }
  const stableContent = ({ archivedAt, updatedAt, ...retained }) => retained;
  await detailAction('归档'); await expect.poll(async () => Boolean((await instance()).archivedAt)).toBe(true);
  const archived = await instance(); assert.equal(typeof archived.archivedAt, 'string'); assert.deepEqual(stableContent(archived), stableContent(afterComment));
  await nav('当前工作'); await expect(page.locator(`[data-instance-id="${instanceId}"]`)).toHaveCount(0);
  await nav('归档'); const archivedRow = page.locator(`[data-instance-id="${instanceId}"]`); await expect(archivedRow).toHaveCount(1); await expect(archivedRow).toBeVisible(); await archivedRow.click();
  await expect(page.locator('[data-inline-field="实例名称"]')).toHaveText(afterComment.name); await singleMain('archived-instance-detail');
  await detailAction('移回当前'); await expect.poll(async () => (await instance()).archivedAt).toBe(null);
  const restored = await instance(); assert.deepEqual(stableContent(restored), stableContent(afterComment));
  await nav('归档'); await expect(page.locator(`[data-instance-id="${instanceId}"]`)).toHaveCount(0);
  await nav('当前工作'); const restoredRow = page.locator(`[data-instance-id="${instanceId}"]`); await expect(restoredRow).toHaveCount(1); await expect(restoredRow).toBeVisible(); await expect(restoredRow).toContainText('已终止');
  await expect(page.locator('.save-state')).toContainText('已保存在本机'); await expect(page.getByRole('alert')).toHaveCount(0);
  await evidence('archive-return-current', '归档并移回当前工作', '通过详情更多菜单归档，在归档列表重开详情，再点移回当前。', '归档只改变列表归属；移回后archivedAt清空，文档、参数、终止记录和评论保持完整。', '两次操作均使用实际UI：归档后仅归档列表出现，移回后仅当前列表出现；原生archivedAt先有时间后为null，其余内容逐项相等。');
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
  const result = { ok: true, isolatedDataDirectory: actual, fixtureSetup: 'Native create_template/create_block/create_instance/start_instance plus completion/archive of search peers; all tested termination, UI block creation, cancellation, search, comment and archive/return actions use real UI', templateId, blockId, instanceId, createdBlockId: createdBlock.id, listSearches, extraSteps, pageErrors, consoleErrors, clipboardTouched: false, maintenanceCommandsExecuted: false, separateProcessRestartVerified: false, finalInstance: restored };
  await writeFile('.artifacts/interaction-extra-check.json', JSON.stringify(result, null, 2), 'utf8'); console.log(JSON.stringify(result));
} catch (error) {
  const observed = await page.evaluate(() => ({ mains: document.querySelectorAll('.app-main').length, dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => ({ label: node.getAttribute('aria-label'), text: node.textContent })), moreMenus: [...document.querySelectorAll('.workspace-titlebar details.more-menu')].map(node => ({ open: node.open, text: node.textContent })), alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent), active: document.activeElement?.getAttribute('aria-label') })).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/interaction-extra-failure.json', JSON.stringify({ error: String(error), extraSteps, pageErrors, consoleErrors, observed, workspace: await workspace().catch(() => null) }, null, 2), 'utf8').catch(() => {});
  await page.screenshot({ path: '.artifacts/interaction-extra-failure.png' }).catch(() => {}); throw error;
} finally { await browser.close(); }
