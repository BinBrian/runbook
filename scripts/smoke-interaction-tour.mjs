import { openCommentComposer } from './step-materials.mjs';
// Run only through: node scripts/check-desktop.mjs scripts/smoke-interaction-tour.mjs
// A chronological demonstration, not a replacement for the boundary smoke suites.
// OS clipboard and native file dialogs are intentionally replaced at the IPC seam.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && path.isAbsolute(directory) && process.env.RUNBOOK_CDP_URL);
assert.equal(path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''), path.resolve(directory));
const actual = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes('Data directory: ' + actual));
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const output = '.artifacts/interaction-tour';
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const workspace = () => native('checklist_load');
const apply = action => native('checklist_apply', { action });
const collection = { template: 'templates', block: 'blocks', instance: 'instances' };
const entity = async (kind, id) => (await workspace())[collection[kind]].find(item => item.id === id);
const step = id => page.locator('[data-step-id="' + id + '"]');
const group = id => page.locator('[data-group-id="' + id + '"]').first();
const card = id => page.locator('[data-command-id="' + id + '"]');
const panel = () => page.getByRole('complementary', { name: '变量面板', exact: true });
const ref = parameterId => ({ parameterId });
const templateId = 'tour-maintenance-template';
const originalName = '周末补丁维护';
const imagePath = path.resolve('docs/examples/patch-maintenance/images/package-check-demo.png');
const records = [], pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const manifest = {
  formatVersion: 1, title: 'Runbook 桌面交互实录', startedAt: new Date().toISOString(),
  isolatedDataDirectory: actual, status: 'running', frames: records,
  limitations: [
    '全部记录和附件位于 check-desktop 创建的独立临时库，不读取或修改用户库。',
    '维护命令只作为文字展示及复制；从未执行命令、连接维护服务器或发送通知。',
    '剪贴板仅捕获 write_text/write_html IPC；未访问 Windows 系统剪贴板。',
    '导入/导出文件对话框通过 IPC 夹具返回；原生存档生成、验证和提交均实际调用。',
    '图片通过真实文件输入选择测试 PNG，未操作系统文件选择窗口。',
    '选区截图通过实际鼠标拖动，斜杠菜单通过实际键入；DOM读取仅用于定位和检查。',
    '此脚本记录产品演示路径，权限、异常、恶意存档和重启边界由专项脚本覆盖。',
  ],
};
const seed = {
  groups: [{ id: 'tour-test-group', name: '测试服更新', description: '先完成测试环境更新，再核对日志。' }],
  parameters: [
    { id: 'tour-env', name: '正式环境', description: '正式服环境标识。', defaultValue: 'release' },
    { id: 'tour-test-env', ownerId: 'tour-test-group', name: '测试环境', description: '本组各命令共用。', defaultValue: 'sandboxa' },
    { id: 'tour-version', ownerId: 'tour-prepare', name: '补丁版本', description: '创建实例后填写本次版本。', defaultValue: '' },
  ],
  steps: [
    { id: 'tour-prepare', title: ['准备维护窗口'], description: ['提前在维护群通知，核对维护窗口。'], commands: [{ id: 'tour-prepare-command', text: ['prepare ', ref('tour-env'), ' --version ', ref('tour-version')] }] },
    { id: 'tour-stop', groupId: 'tour-test-group', title: ['停止测试服'], description: ['在外部维护工具操作后，在此记录结果。'], commands: [{ id: 'tour-stop-command', text: ['stopserver ', ref('tour-test-env'), ' all'] }] },
    { id: 'tour-start', groupId: 'tour-test-group', title: ['启动测试服'], description: ['检查服务注册和就绪日志。'], commands: [{ id: 'tour-start-command', text: ['startserver ', ref('tour-test-env'), ' all'] }] },
    { id: 'tour-final', title: ['最终核对'], description: ['确认公告、邮件与登录状态。'], commands: [] },
  ],
};
async function flushManifest() { await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8'); }
async function frame(id, title, actions, expected, observed, checks, focus, locatorDescription) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve, reject) => {
      let last, stable = 0, frames = 0;
      function sample() {
        const root = document.querySelector('.workspace-scroll');
        const values = [root?.scrollTop ?? 0, root?.scrollHeight ?? 0, document.querySelectorAll('[role="dialog"]').length];
        stable = last && values.every((value, index) => Math.abs(value - last[index]) < 0.1) ? stable + 1 : 1;
        last = values;
        if (stable >= 3) resolve(); else if (++frames > 180) reject(new Error('Tour capture did not reach a stable layout')); else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
  });
  const index = records.length + 1, prefix = String(index).padStart(2, '0') + '-' + id;
  const screenshot = path.resolve(output, prefix + '.png');
  const bounds = focus ? await focus.first().boundingBox() : null;
  const context = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    saveState: document.querySelector('.save-state')?.textContent,
    heading: document.querySelector('.workspace-title')?.innerText,
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => node.getAttribute('aria-label') || node.getAttribute('aria-labelledby')),
    alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
  }));
  assert.equal(context.viewport.scrollY, 0);
  assert.equal(await page.locator('.checklist-app').count(), 1);
  const item = {
    index, id, title, capturedAt: new Date().toISOString(), actions, expected, observed,
    checks: checks.map(description => ({ description, passed: true })),
    evidence: { screenshot, ui: [{ locator: locatorDescription || '.workspace-page', bounds }] },
    suggestedCrop: bounds ? { x: Math.max(0, bounds.x - 20), y: Math.max(0, bounds.y - 20), width: Math.min(context.viewport.width - Math.max(0, bounds.x - 20), bounds.width + 40), height: Math.min(context.viewport.height - Math.max(0, bounds.y - 20), bounds.height + 40) } : null,
    context,
  };
  await page.screenshot({ path: screenshot });
  records.push(item);
  await writeFile(path.join(output, prefix + '.json'), JSON.stringify(item, null, 2), 'utf8');
  await flushManifest();
}
async function installFixtures() {
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.__tour = { imports: [], exports: [], clipboard: [], probes: 0 };
    const reply = (value, ok = true) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': ok ? 'ok' : 'error' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'http://ipc.localhost' && !(url.protocol === 'ipc:' && url.hostname === 'localhost')) return original(input, init);
      const command = decodeURIComponent(url.pathname.slice(1)), args = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (command === 'tour_probe') { window.__tour.probes++; return reply({ isolated: true }); }
      if (command === 'plugin:clipboard-manager|write_text' || command === 'plugin:clipboard-manager|write_html') { window.__tour.clipboard.push({ command, args: structuredClone(args) }); return reply(null); }
      if (command === 'checklist_pick_import') return window.__tour.imports.length ? reply(window.__tour.imports.shift()) : reply('Tour import fixture missing', false);
      if (command === 'checklist_save_export') { window.__tour.exports.push(structuredClone(args)); return reply(true); }
      return original(input, init);
    };
  });
  assert.deepEqual(await native('tour_probe'), { isolated: true });
}
async function settle() {
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeEnabled();
  await expect(page.locator('.save-state')).toContainText('已保存在本机');
}
async function saved(predicate) { await expect.poll(predicate).toBe(true); await settle(); }
async function nav(name) { await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: name }).click(); }
async function open(kind, id) {
  const item = await entity(kind, id); assert.ok(item);
  await nav(kind === 'instance' ? item.archivedAt ? '归档' : '当前工作' : kind === 'template' ? '模板' : '步骤块');
  const tile = page.locator('[data-' + kind + '-id="' + id + '"]');
  await (kind === 'instance' ? tile : tile.locator('.tile-open')).click();
  await expect(page.locator('[data-inline-field="' + (kind === 'instance' ? '实例名称' : kind === 'template' ? '模板名称' : '步骤块名称') + '"]')).toBeVisible();
}
async function locate(id) {
  await page.locator('[data-nav-step-id="' + id + '"]').click();
  await expect(panel()).toHaveAttribute('data-variable-target-step-id', id);
}
async function editor(source, label) {
  const field = source.getByRole('textbox', { name: label, exact: true });
  if (!await field.count()) await source.locator('[data-inline-field="' + label + '"]').dblclick();
  await expect(field).toBeVisible(); return field;
}
async function editInline(source, label, text) { const field = await editor(source, label); await field.fill(text); await field.press('Escape'); }
async function stable(trigger) {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.evaluate(element => new Promise((resolve, reject) => {
    let previous, stable = 0, frames = 0;
    function sample() {
      if (!element.isConnected) return reject(new Error('Tour trigger detached'));
      const rect = element.getBoundingClientRect(), root = element.closest('.workspace-scroll');
      const values = [rect.x, rect.y, root?.scrollTop ?? 0];
      stable = previous && values.every((value, index) => Math.abs(value - previous[index]) < 0.1) ? stable + 1 : 1;
      previous = values;
      if (stable >= 3) resolve(); else if (++frames > 180) reject(new Error('Tour trigger did not stabilize')); else requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }));
}
async function structure(source, action, more = false, isGroup = false) {
  more ||= ['删除当前步骤', '删除步骤组及子步骤'].includes(action);
  const label = isGroup ? more ? '更多步骤组操作' : '步骤组新增' : more ? '更多步骤操作' : '步骤新增';
  const trigger = source.getByRole('button', { name: label, exact: true });
  await stable(trigger); await trigger.click();
  const menu = page.getByRole('menu', { name: label, exact: true }); await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(more ? 5 : 3);
  if (action) { await menu.getByRole('menuitem', { name: action, exact: true }).click(); await expect(menu).toHaveCount(0); }
  return menu;
}
async function topAction(action) {
  const more = page.locator('.workspace-titlebar details.more-menu');
  if (await more.getAttribute('open') === null) await more.getByLabel('更多操作', { exact: true }).click();
  await more.getByRole('button', { name: action, exact: true }).click();
}
async function addVariable(scope, name, description, value) {
  const label = scope === 'global' ? '新增全局变量' : scope === 'group' ? '新增步骤组变量' : '新增步骤变量';
  await panel().getByRole('button', { name: label, exact: true }).click();
  const dialog = panel().getByRole('dialog', { name: '新增变量', exact: true });
  await dialog.getByRole('textbox', { name: '变量名称', exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: '变量说明', exact: true }).fill(description);
  await dialog.getByRole('textbox', { name: '变量默认值', exact: true }).fill(value);
  await dialog.getByRole('button', { name: '保存变量', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await saved(async () => (await entity('template', templateId)).document.parameters.some(parameter => parameter.name === name));
  return (await entity('template', templateId)).document.parameters.find(parameter => parameter.name === name);
}
async function exportUi(label) {
  const count = await page.evaluate(() => window.__tour.exports.length);
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tour.exports.length)).toBe(count + 1);
  const file = await page.evaluate(() => window.__tour.exports.at(-1));
  assert.equal(path.basename(file.name), file.name);
  await writeFile(path.join(output, file.name), Buffer.from(file.bytes)); return file;
}
async function commandCopy(id, expected) {
  const count = await page.evaluate(() => window.__tour.clipboard.length);
  await card(id).getByRole('button', { name: '复制命令', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__tour.clipboard.length)).toBe(count + 1);
  assert.equal((await page.evaluate(() => window.__tour.clipboard.at(-1))).args.text, expected);
}
const rendered = (parts, values) => parts.map(part => typeof part === 'string' ? part : values[part.parameterId]).join('');
let runId, copiedRunId, restoredRunId;

try {
  await mkdir(output, { recursive: true }); await flushManifest();
  await page.setViewportSize({ width: 1440, height: 960 });
  assert.ok(!(await workspace()).templates.some(item => item.id === templateId));
  await apply({ type: 'create_template', id: templateId, name: originalName, document: seed });
  manifest.seed = { method: 'checklist_apply create_template', id: templateId, name: originalName, note: '预置友好演示数据；下面被记录的交互均由真实 UI 点击、键入或拖动完成。' };
  await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor(); await installFixtures();
  await nav('模板');
  await frame('library', '模板库：从可复用流程开始', ['进入模板列表'], '模板按独立卡片展示。', '可见“周末补丁维护”演示模板及本机保存状态。', ['演示模板确实存在于隔离库'], page.locator('.library-page'), '.library-page');

  await page.getByRole('button', { name: '新建模板', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新建模板', exact: true });
  await dialog.getByRole('textbox', { name: '模板名称', exact: true }).fill('临时排查清单');
  await frame('new-template', '新建一份空白模板', ['点击新建模板', '输入“临时排查清单”'], '先给模板命名，再创建独立定义。', '新建对话框内名称已填写，尚未提交。', ['名称输入框可编辑'], dialog, 'dialog[新建模板]');
  await dialog.getByRole('button', { name: '创建模板', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const scratch = (await workspace()).templates.find(item => item.name === '临时排查清单'); assert.ok(scratch);
  const scratchStep = scratch.document.steps[0].id;
  await editInline(step(scratchStep), '步骤标题', '核对补丁准备情况');
  await editInline(step(scratchStep), '操作说明', '确认版本、时间窗口和通知范围。');
  await structure(step(scratchStep), '添加命令');
  let scratchDoc = (await entity('template', scratch.id)).document;
  await saved(async () => (await entity('template', scratch.id)).document.steps[0].commands.length === 1);
  scratchDoc = (await entity('template', scratch.id)).document;
  const scratchCommand = scratchDoc.steps[0].commands[0].id;
  let field = card(scratchCommand).getByRole('textbox', { name: '命令 1', exact: true }); await expect(field).toBeFocused();
  await field.fill('checkpackage patch-2026.10.21'); await field.press('Control+Enter'); await settle();
  await frame('inline-edit', '标题、说明和命令就地编辑', ['双击填写步骤标题和说明', '从左“＋”添加命令', '填写命令后 Ctrl+Enter 完成编辑'], '编辑直接发生在内容位置，命令只记录不执行。', '空白模板已有一条可复用步骤，命令卡恢复展示。', ['新命令保留稳定 ID', '命令文本已通过缓冲保存'], step(scratchStep), '[data-step-id="' + scratchStep + '"]');

  await open('template', templateId); await locate('tour-prepare');
  await structure(step('tour-prepare'));
  await frame('step-basic', '步骤左侧“＋”：新增内容', ['打开步骤左侧“＋”'], '新增步骤、命令和插入步骤块各有一个入口。', '新增菜单展示三项，删除在右上角更多菜单。', ['三个新增菜单项实际可见'], page.getByRole('menu'), 'menu[步骤新增]');
  await page.keyboard.press('Escape');
  await structure(step('tour-prepare'), '转为步骤组', true);
  await saved(async () => Boolean((await entity('template', templateId)).document.steps[0].groupId));
  const preparationGroup = (await entity('template', templateId)).document.steps[0].groupId;
  await editInline(group(preparationGroup), '步骤组名称', '维护前准备');
  await editInline(group(preparationGroup), '步骤组描述', '维护前统一核对并通知相关人员。');
  await structure(group(preparationGroup), '添加子步骤', false, true);
  await saved(async () => (await entity('template', templateId)).document.steps.filter(item => item.groupId === preparationGroup).length === 2);
  let document = (await entity('template', templateId)).document;
  const noticeStep = document.steps.find(item => item.groupId === preparationGroup && item.id !== 'tour-prepare').id;
  await editInline(step(noticeStep), '步骤标题', '确认公告已发出');
  await editInline(step(noticeStep), '操作说明', '核对大群公告中的维护时间。');
  await frame('group-child', '把相关步骤整理成组', ['从右“⋯”把普通步骤转组', '填写组标题与描述', '从组左“＋”添加子步骤'], '组是单层连续流程，子步骤仍独立记录。', '“维护前准备”包含准备和公告两个步骤。', ['两个成员归属同一组', '文档顺序保持连续'], group(preparationGroup), '[data-group-id="' + preparationGroup + '"]');

  const beforeGroupCopy = structuredClone(document);
  await structure(group(preparationGroup), '复制步骤组', true, true);
  await saved(async () => (await entity('template', templateId)).document.groups.length === beforeGroupCopy.groups.length + 1);
  document = (await entity('template', templateId)).document;
  const groupCopy = document.groups.find(item => !beforeGroupCopy.groups.some(old => old.id === item.id));
  assert.ok(groupCopy && groupCopy.id !== preparationGroup);
  assert.equal(document.steps.filter(item => item.groupId === groupCopy.id).length, 2);
  await structure(group(groupCopy.id), '上移步骤组', true, true); await settle();
  await structure(group(groupCopy.id), '下移步骤组', true, true); await settle();
  await frame('group-copy-move', '复制并整体移动步骤组', ['复制“维护前准备”', '整体上移一次，再下移回原位置'], '副本身份独立，移动保持组成员连续。', '副本位于原组后方，原组内容仍然保留。', ['新组 ID 与原组不同', '组内局部变量按副本独立重建'], group(groupCopy.id), '[data-group-id="' + groupCopy.id + '"]');
  await structure(group(groupCopy.id), '删除步骤组及子步骤', false, true);
  await saved(async () => !(await entity('template', templateId)).document.groups.some(item => item.id === groupCopy.id));

  await structure(group(preparationGroup), '保存为步骤块', true, true);
  dialog = page.getByRole('dialog', { name: '保存为步骤块', exact: true });
  await dialog.getByRole('textbox', { name: '步骤块名称', exact: true }).fill('维护准备步骤块');
  await frame('save-block', '把常用流程保存到步骤块库', ['组右“⋯”选择保存为步骤块', '命名“维护准备步骤块”'], '只保存流程和原默认值，不携带执行结果。', '保存对话框说明副本独立和全局引用局部化。', ['保存复用对话框已打开'], dialog, 'dialog[保存为步骤块]');
  await dialog.getByRole('button', { name: '保存步骤块', exact: true }).click(); await expect(dialog).toHaveCount(0); await settle();
  const savedBlock = (await workspace()).blocks.find(item => item.name === '维护准备步骤块'); assert.ok(savedBlock);
  assert.equal(savedBlock.document.groups.length, 1);
  assert.ok(savedBlock.document.parameters.every(parameter => parameter.ownerId));
  await open('block', savedBlock.id);
  await frame('block-library', '步骤块定义也使用同样的命令卡', ['打开步骤块库中的“维护准备步骤块”'], '复用块自包含一组及其局部参数。', '步骤块页面展示独立定义，命令支持同一套原位交互。', ['块只含一个组', '没有外部全局参数依赖'], page.locator('.workspace-page'), '.workspace-page[步骤块]');

  await open('template', templateId); await locate('tour-final');
  await structure(step('tour-final'), '插入步骤块');
  dialog = page.getByRole('dialog', { name: '插入步骤块', exact: true });
  await frame('insert-picker', '按需插入复用步骤块', ['在最终核对步骤左“＋”选择插入步骤块'], '从库中选择后生成独立使用副本。', '选择器列出了“维护准备步骤块”的步骤和参数数量。', ['复用选择器实际打开'], dialog, 'dialog[插入步骤块]');
  const beforeInsert = (await entity('template', templateId)).document;
  await dialog.locator('.block-choice').filter({ hasText: '维护准备步骤块' }).click(); await expect(dialog).toHaveCount(0);
  await saved(async () => (await entity('template', templateId)).document.groups.length === beforeInsert.groups.length + 1);
  document = (await entity('template', templateId)).document;
  const inserted = document.groups.find(item => item.sourceBlockId === savedBlock.id); assert.ok(inserted);
  assert.notEqual(inserted.id, savedBlock.document.groups[0].id);
  await locate(document.steps.find(item => item.groupId === inserted.id).id);
  await frame('inserted-block', '插入后是可以独立修改的副本', ['选择步骤块并查看插入位置'], '来源定义和使用副本不会共享可变数据。', '插入组位于原流程之后，带有独立组和步骤 ID。', ['sourceBlockId 指向来源', '副本 ID 与块定义不同'], group(inserted.id), '[data-group-id="' + inserted.id + '"]');

  await locate('tour-final');
  const oldSteps = new Set(document.steps.map(item => item.id));
  await structure(step('tour-final'), '复制当前步骤', true);
  await saved(async () => (await entity('template', templateId)).document.steps.length === oldSteps.size + 1);
  document = (await entity('template', templateId)).document;
  const copiedStep = document.steps.find(item => !oldSteps.has(item.id));
  await structure(step(copiedStep.id), '上移步骤', true); await settle();
  await structure(step(copiedStep.id), '下移步骤', true); await settle();
  await structure(step(copiedStep.id), '删除当前步骤');
  await saved(async () => !(await entity('template', templateId)).document.steps.some(item => item.id === copiedStep.id));
  await frame('step-copy-move-delete', '普通步骤也能独立复制和调整', ['右“⋯”复制步骤', '上移、下移后从右“⋯”删除这个副本'], '动作只改变选中的步骤副本。', '原“最终核对”仍在，临时副本已经移除。', ['原步骤 ID 保留', '其他组及其顺序未被拆分'], step('tour-final'), '[data-step-id="tour-final"]');

  await locate('tour-prepare');
  const ticket = await addVariable('global', '变更单', '关联本次维护的工作单。', 'OPS-1021');
  await frame('global-variable', '全局变量：整份流程共用', ['在右侧新增全局变量“变更单”', '设置说明和默认值'], '全局变量不依附某个步骤。', '右侧全局分区显示 OPS-1021 默认值。', ['新变量没有 ownerId'], panel(), 'aside[变量面板] [data-variable-scope="global"]');
  assert.equal(ticket.ownerId, undefined);
  const channel = await addVariable('group', '通知渠道', '维护前准备组共用。', '维护群');
  await frame('group-variable', '组局部变量：只属于当前步骤组', ['在当前步骤组新增“通知渠道”'], '同一组共享，其他组不可按同名串值。', '变量归属于“维护前准备”，与全局分区分开。', ['新变量 ownerId 等于当前组 ID'], panel(), 'aside[变量面板] [data-variable-scope="group"]');
  assert.equal(channel.ownerId, preparationGroup);
  const temporary = await addVariable('step', '临时备注', '用于演示定义修改与删除。', '待核对');
  await panel().getByRole('button', { name: '编辑变量 临时备注', exact: true }).click();
  dialog = panel().getByRole('dialog', { name: '编辑变量定义', exact: true });
  await dialog.getByRole('textbox', { name: '变量默认值', exact: true }).fill('已核对');
  await dialog.getByRole('button', { name: '保存变量', exact: true }).click();
  await saved(async () => (await entity('template', templateId)).document.parameters.find(item => item.id === temporary.id).defaultValue === '已核对');
  await panel().getByRole('button', { name: '删除变量 临时备注', exact: true }).click();
  await saved(async () => !(await entity('template', templateId)).document.parameters.some(item => item.id === temporary.id));
  await panel().getByRole('searchbox', { name: '搜索变量', exact: true }).fill('OPS');
  await expect(panel().locator('[data-variable-id="' + ticket.id + '"]')).toBeVisible();
  await frame('variable-crud-search', '变量定义管理与当前范围搜索', ['创建步骤局部备注', '编辑默认值后删除未引用备注', '搜索 OPS 定位变更单'], '未引用变量可删除，搜索不改原数据。', '只显示当前可见范围内匹配的变更单。', ['临时变量已从原生文档移除', '变更单 ID 未变化'], panel(), 'aside[变量面板] [aria-label="搜索变量"]');
  await panel().getByRole('button', { name: '清空变量搜索', exact: true }).click();

  field = await editor(card('tour-prepare-command'), '命令 1'); await field.press('Control+End'); await field.pressSequentially(' --ticket {{变更单');
  const slash = page.getByRole('listbox', { name: '变量建议', exact: true }); await expect(slash).toBeVisible();
  await frame('slash-suggestions', '键入“{{”直接选择已有变量', ['在命令末尾输入“ --ticket {{变更单”'], '只建议当前可见的全局、组和步骤变量。', '候选按名称筛选，键盘或鼠标均可接受。', ['候选中存在变更单稳定 ID'], slash, 'listbox[变量建议]');
  await slash.locator('[data-parameter-id="' + ticket.id + '"]').click(); await field.press('Control+Enter'); await settle();
  field = await editor(step('tour-prepare'), '操作说明');
  await field.scrollIntoViewIfNeeded();
  const selectionBounds = await field.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) { const at = node.textContent.indexOf('维护群'); if (at < 0) continue; const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 3); const rect = range.getBoundingClientRect(); return { x: rect.left, y: rect.top + rect.height / 2, right: rect.right }; }
    throw new Error('Tour selection literal not found');
  });
  await page.mouse.move(selectionBounds.x + 1, selectionBounds.y); await page.mouse.down(); await page.mouse.move(selectionBounds.right - 1, selectionBounds.y, { steps: 12 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '维护群');
  const toolbar = page.getByRole('toolbar', { name: '选区变量操作', exact: true }); await expect(toolbar).toBeVisible();
  await frame('selection-tools', '选中文字后就近处理变量', ['拖动选中说明中的“维护群”'], '只针对当前选中的这一处，工具浮在行附近。', '行左侧出现“使用变量 / 新增变量”两个入口。', ['实际鼠标选区为完整“维护群”', '工具栏可见且属于本字段'], toolbar, 'toolbar[选区变量操作]');
  await toolbar.getByRole('button', { name: '新增变量', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新增变量', exact: true });
  await dialog.getByRole('textbox', { name: '新变量名称', exact: true }).fill('通知范围');
  await expect(dialog.getByRole('textbox', { name: '默认值', exact: true })).toHaveValue('维护群');
  await frame('selection-create', '选区转变量自动带入原内容', ['选择新增变量', '填写名称“通知范围”'], '默认值来自选中文字，默认归属当前组。', '创建表单保留“维护群”，只会替换当前一处。', ['默认值精确等于原选区'], dialog, 'dialog[新增变量]');
  await dialog.getByRole('button', { name: '创建并替换选区', exact: true }).click(); await expect(dialog).toHaveCount(0); await field.press('Control+Enter'); await settle();
  const templateFile = await exportUi('导出模板');
  assert.match(templateFile.name, /\.runbook\.json$/);
  assert.equal(JSON.parse(Buffer.from(templateFile.bytes).toString('utf8')).kind, 'template');
  await frame('template-ready', '模板完成并导出可复用定义', ['完成说明编辑', '点击导出模板'], '导出结构化 JSON，定义与未来执行记录分开。', '模板 JSON 已由原生生成，保存目的地使用测试夹具。', ['真实原生导出返回 JSON 字节', '不会执行展示的命令'], page.locator('.workspace-page'), '.workspace-page');

  await page.getByRole('button', { name: '创建实例', exact: true }).click(); dialog = page.getByRole('dialog', { name: '创建实例', exact: true });
  await dialog.getByRole('textbox', { name: '实例名称', exact: true }).fill('周末维护 · 第一次记录');
  await frame('create-instance', '每次维护创建独立实例', ['从模板创建实例', '填写本次工作名称'], '实例复制流程快照，后续记录不污染模板。', '对话框明确提示实例和来源独立。', ['创建动作尚未提交'], dialog, 'dialog[创建实例]');
  await dialog.getByRole('button', { name: '创建实例', exact: true }).click(); await expect(dialog).toHaveCount(0); await settle();
  runId = (await workspace()).instances.find(item => item.name === '周末维护 · 第一次记录').id;
  let current = await entity('instance', runId); assert.equal(current.status, 'draft');
  const pending = page.locator('[data-parameter-target]');
  while (await pending.count()) {
    const id = await pending.first().getAttribute('data-parameter-target');
    await pending.first().click(); const input = panel().locator('input[data-parameter-id="' + id + '"]'); await expect(input).toBeFocused(); await input.fill('2026.10.21');
    await expect(page.locator('[data-parameter-target="' + id + '"]')).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeEnabled();
  await frame('fill-instance', '按作用域补齐本次参数', ['点击缺失项定位右侧输入', '补齐每个副本的补丁版本'], '默认值自动带入，补齐引用参数后才开始。', '所有缺失项已补齐，开始记录按钮可用。', ['实例仍未开始', '各局部参数按 ID 独立填写'], panel(), 'aside[变量面板] input[data-parameter-id]');
  await page.getByRole('button', { name: '开始记录', exact: true }).click(); await saved(async () => (await entity('instance', runId)).status === 'in_progress');
  current = await entity('instance', runId);
  const first = current.document.steps[0], firstCommand = first.commands[0];
  await commandCopy(firstCommand.id, rendered(firstCommand.text, current.parameterValues));
  await frame('running-copy', '当前步骤聚焦与一键复制', ['开始记录', '点击当前命令的复制按钮'], '复制使用已应用参数，命令由外部工具操作。', '当前步骤高亮，复制 IPC 的文本与已应用值一致。', ['原生状态为进行中', 'transport 精确捕获文本，未访问 OS 剪贴板'], step(first.id), '[data-step-id="' + first.id + '"]');

  await step(first.id).getByRole('button', { name: '记录失败', exact: true }).click(); dialog = page.getByRole('dialog', { name: '记录失败', exact: true });
  await dialog.getByRole('textbox', { name: '失败原因', exact: true }).fill('补丁包校验值需要二次确认');
  await frame('failure-reason', '失败必须留下简短原因', ['点击记录失败', '填写本次问题原因'], '失败停留当前步骤，详细材料可另补。', '原因已填写，提交后不会自动跳过。', ['失败原因必填表单可见'], dialog, 'dialog[记录失败]');
  await dialog.getByRole('button', { name: '保存失败记录', exact: true }).click(); await expect(dialog).toHaveCount(0); await settle();
  assert.equal((await entity('instance', runId)).currentStepId, first.id);
  await openCommentComposer(step(first.id));
  await step(first.id).getByRole('textbox', { name: '添加评论', exact: true }).fill('已重新核对补丁包，版本与维护窗口一致。');
  await step(first.id).getByRole('button', { name: '添加评论', exact: true }).click(); await settle();
  const chooserPromise = page.waitForEvent('filechooser'); await step(first.id).getByRole('button', { name: '添加图片', exact: true }).click(); await (await chooserPromise).setFiles(imagePath);
  await saved(async () => (await entity('instance', runId)).entries.some(entry => entry.type === 'image'));
  await expect(step(first.id).locator('.image-preview img')).toBeVisible();
  await frame('failure-materials', '用评论和图片补充证据', ['保存失败记录', '提交核对评论', '点击添加图片并选取测试 PNG'], '材料属于本步骤，不会改写先前失败快照。', '失败原因、评论和截图附件同时保留。', ['当前步骤未推进', '评论与 PNG 已写入隔离库'], step(first.id).locator('.timeline'), '.timeline');

  await step(first.id).getByRole('button', { name: '完成并下一步', exact: true }).click(); await saved(async () => (await entity('instance', runId)).currentStepId !== first.id);
  current = await entity('instance', runId); const second = current.document.steps.find(item => item.id === current.currentStepId);
  await step(second.id).getByRole('button', { name: '跳过', exact: true }).click(); dialog = page.getByRole('dialog', { name: '跳过这一步', exact: true });
  await dialog.getByRole('textbox', { name: '跳过原因', exact: true }).fill('公告已在前一天确认，本次无需重复');
  await frame('skip-reason', '跳过也需要说明原因', ['核对后完成当前步骤', '在公告步骤选择跳过'], '完成和跳过均向前推进，旧结果继续保留。', '跳过对话框要求填写原因。', ['前一步最新结果为完成', '没有恢复或覆盖失败记录'], dialog, 'dialog[跳过这一步]');
  await dialog.getByRole('button', { name: '确认跳过', exact: true }).click(); await expect(dialog).toHaveCount(0); await settle();
  await locate(first.id);
  const oldFailure = step(first.id).locator('.result-record.old.failed');
  if (await oldFailure.count()) await oldFailure.locator(':scope > summary.result-record-heading').click();
  await frame('frozen-history', '推进后只读回看，历史依然完整', ['跳过公告步骤', '从导航回到准备步骤', '展开旧失败记录'], '已推进内容冻结，失败、完成及材料都留档。', '同一步的旧失败与新完成并存，正文没有修改入口。', ['已推进步骤没有增删菜单', '旧失败原因仍在原生结果中'], step(first.id), '[data-step-id="' + first.id + '"]');

  await page.getByRole('button', { name: '展开步骤目录', exact: true }).click();
  current = await entity('instance', runId); await locate(current.currentStepId);
  await frame('navigation', '完整目录与当前执行位置分开', ['展开步骤目录', '定位当前测试服步骤'], '浏览不推进，颜色和文字共同表达状态。', '目录显示完成、跳过与当前步骤，可跳转回看。', ['导航没有改写执行记录'], page.locator('[data-step-navigation]'), 'aside[data-step-navigation]');

  const completedTitles = [];
  for (;;) {
    current = await entity('instance', runId); if (current.status !== 'in_progress') break;
    const active = current.document.steps.find(item => item.id === current.currentStepId); completedTitles.push(rendered(active.title, current.parameterValues));
    await locate(active.id);
    const isLast = current.document.steps.at(-1).id === active.id;
    await step(active.id).getByRole('button', { name: isLast ? '完成并结束' : '完成并下一步', exact: true }).click();
    await saved(async () => (await entity('instance', runId)).currentStepId !== active.id || (await entity('instance', runId)).status === 'completed');
  }
  current = await entity('instance', runId); assert.equal(current.status, 'completed');
  await page.locator('.workspace-scroll').hover(); await page.mouse.wheel(0, -10000);
  await frame('completed', '完成后留在当前工作，等待手动归档', completedTitles.map(title => '手动确认完成：' + title), '最后一步完成后结束，结果和材料保留。', '显示本次工作已结束与完成/跳过汇总。', ['实例状态为 completed', '原失败、评论和图片仍保留'], page.locator('.completion-banner'), '.completion-banner.completed');

  await page.getByRole('button', { name: '归档', exact: true }).click(); await saved(async () => Boolean((await entity('instance', runId)).archivedAt));
  await nav('归档');
  await frame('archived', '手动归档整理当前工作列表', ['点击归档', '进入归档列表'], '归档只改变列表位置，不删除执行数据。', '本次维护出现在归档列表。', ['archivedAt 已设置', '原记录数量保持'], page.locator('.library-page'), '.library-page[归档]');
  await open('instance', runId); await topAction('复制为新实例');
  dialog = page.getByRole('dialog', { name: '复制为新实例', exact: true }); await dialog.getByRole('textbox', { name: '实例名称', exact: true }).fill('周末维护 · 重新核对');
  await frame('copy-instance', '复制当前流程，重新记录一次', ['更多操作中复制为新实例', '为副本填写新名称'], '复制流程和本次参数，从第一步重新开始。', '对话框明确旧结果、评论和图片留在原实例。', ['来源实例已归档且保持原样'], dialog, 'dialog[复制为新实例]');
  await dialog.getByRole('button', { name: '创建实例', exact: true }).click(); await expect(dialog).toHaveCount(0); await settle();
  copiedRunId = (await workspace()).instances.find(item => item.name === '周末维护 · 重新核对').id;
  const copy = await entity('instance', copiedRunId); assert.equal(copy.status, 'draft'); assert.equal(copy.entries.length, 0);
  await topAction('另存为新模板'); dialog = page.getByRole('dialog', { name: '另存为新模板', exact: true }); await dialog.getByRole('textbox', { name: '模板名称', exact: true }).fill('维护流程 · 复用版');
  await frame('save-template', '将临时调整另存为新模板', ['从实例选择另存为新模板', '填写复用版名称'], '不更新来源模板，仍保留原默认值语义。', '另存说明不携带结果和本次填写值。', ['工作副本没有旧执行记录'], dialog, 'dialog[另存为新模板]');
  await dialog.getByRole('button', { name: '保存新模板', exact: true }).click(); await expect(dialog).toHaveCount(0); await settle();

  await open('instance', runId); const archive = await exportUi('导出存档'); assert.match(archive.name, /\.runbook\.zip$/); assert.ok(archive.bytes.length > 100);
  await frame('export-archive', '把流程、结果和图片一起导出', ['打开已归档原实例', '点击导出存档'], '生成自包含 ZIP，文件保存框使用夹具。', '原生返回完整存档字节，已保存到演示证据目录。', ['ZIP 大于空文件', '源实例和图片未删除'], page.locator('.workspace-titlebar'), '.workspace-titlebar');
  const previousIds = new Set((await workspace()).instances.map(item => item.id));
  await page.evaluate(file => window.__tour.imports.push(file), archive);
  await page.getByRole('button', { name: '导入', exact: true }).click(); dialog = page.getByRole('dialog', { name: '导入预览', exact: true });
  await expect(dialog).toContainText('已存在');
  await frame('import-preview', '重复存档先预览，明确导入为副本', ['点击导入，夹具返回刚导出的 ZIP'], '原生先验证，重复时不覆盖本地原实例。', '预览识别到重复，要求导入为独立副本。', ['原生预检通过', '提交前本地实例数量未变'], dialog, 'dialog[导入预览]');
  await dialog.getByRole('button', { name: '导入为独立副本', exact: true }).click(); await expect(dialog).toHaveCount(0); await settle();
  restoredRunId = (await workspace()).instances.find(item => !previousIds.has(item.id)).id;
  const restored = await entity('instance', restoredRunId);
  assert.equal(restored.status, 'completed'); assert.equal(restored.entries.length, (await entity('instance', runId)).entries.length);
  await locate(restored.document.steps[0].id);
  await frame('restored', '导入后完整还原，原实例继续独立', ['确认导入独立副本', '查看还原后的历史和材料'], '副本恢复执行记录和图片，但拥有独立身份。', '导入副本已结束，原始实例仍在归档列表。', ['副本与来源 ID 不同', '记录数量和状态一致'], page.locator('.workspace-page'), '.workspace-page[导入副本]');

  await topAction('删除实例'); dialog = page.getByRole('dialog', { name: '删除实例', exact: true });
  await frame('delete-confirmation', '整项删除前明确影响范围', ['在导入副本的更多操作中选择删除实例'], '必须确认；删除副本不影响来源和其他实例。', '对话框明确将删除流程、记录、评论和图片。', ['对象名称出现在确认框', '确认前副本依然存在'], dialog, 'dialog[删除实例]');
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0); assert.ok(await entity('instance', restoredRunId));
  await topAction('删除实例'); dialog = page.getByRole('dialog', { name: '删除实例', exact: true });
  await dialog.getByRole('button', { name: '确认删除实例', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await saved(async () => !await entity('instance', restoredRunId));
  assert.ok(await entity('instance', runId)); assert.ok(await entity('instance', copiedRunId));
  await nav('归档');
  await frame('delete-result', '取消不改数据，确认只删除选定副本', ['先取消并检查副本仍存在', '再次确认删除导入副本', '回到归档列表'], '删除只作用于被确认的对象。', '导入副本已移除，原维护实例和重新核对实例仍然保留。', ['目标副本原生记录已不存在', '来源与其他实例仍存在'], page.locator('.library-page'), '.library-page[删除后]');

  assert.equal(pageErrors.length, 0);
  assert.ok(records.length >= 25 && records.length <= 35, 'Keep the narrated tour at 25–35 frames');
  manifest.status = 'passed'; manifest.finishedAt = new Date().toISOString();
  manifest.result = { frames: records.length, templateId, runId, copiedRunId, deletedImportedInstanceId: restoredRunId, pageErrors, clipboardTransportWrites: await page.evaluate(() => window.__tour.clipboard.length), nativeFileDialogFixture: true, osClipboardTouched: false, maintenanceCommandsExecuted: false };
  await flushManifest(); console.log(JSON.stringify(manifest.result));
} catch (error) {
  manifest.status = 'failed'; manifest.finishedAt = new Date().toISOString(); manifest.failure = { message: String(error), pageErrors, completedFrames: records.length };
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure-workspace.json'), JSON.stringify(await workspace().catch(() => null), null, 2), 'utf8').catch(() => {});
  await flushManifest().catch(() => {}); throw error;
} finally { await browser.close(); }
