// Current work-center interaction audit. Run only through check-desktop.mjs.
// Native calls outside UI are limited to one isolated seed and read-only assertions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openCommentComposer } from './step-materials.mjs';

assert.equal(process.env.RUNBOOK_CLIPBOARD_TEST_MODE, 'transport');
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-/);
assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
const output = path.resolve(process.env.RUNBOOK_TEST_OUTPUT_DIR ?? path.join(directory, 'work-lifecycle-audit'));
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(14000);
const records = [], errors = [], layouts = [], evidence = {}, fixtureCalls = [];
const fileNote = '原生文件框返回/保存目的地由 IPC transport 夹具替代；业务导出、结构校验和导入提交使用真实原生实现。';
const copyNote = '只捕获 clipboard-manager write_text IPC 内容；未读写 Windows 系统剪贴板，也未执行复制的命令。';
const imageNote = '实际点击“添加图片”，由 Playwright 文件选择夹具提供本轮 W08 的真实界面 PNG；未自动操作 Windows 文件框。';
let current = null;
page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const load = () => native('checklist_load');
const work = async id => (await load()).instances.find(item => item.id === id);
const sourceId = 'audit-work-lifecycle-source';
const step = id => page.locator(`[data-step-id="${id}"]`);
const nav = label => page.locator('.app-sidebar nav button').filter({ hasText: label }).click();
const row = id => page.locator(`[data-variable-id="${id}"]`);
async function fillValue(id, text) {
  if (!await row(id).locator('input[data-parameter-id]').count()) await row(id).locator('[data-variable-value]').dblclick();
  await row(id).locator('input[data-parameter-id]').fill(text);
}
async function open(id, archived = false) {
  await nav(archived ? '归档' : '工作记录');
  await page.locator(`[data-instance-id="${id}"]`).click();
  await expect(page.locator('[data-inline-field="工作名称"]')).toBeVisible();
}
async function expand(id) {
  const card = step(id);
  if (!await card.locator('.step-content').count()) await card.locator('.step-card-heading > button.icon-button[aria-expanded]').click();
  await expect(card.locator('.step-content')).toBeVisible();
}
async function menu(label) {
  const details = page.locator('.heading-actions .more-menu');
  if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
  await details.getByRole('button', { name: label, exact: true }).click();
}
function begin(id, title, section, action, expected) { current = { id, title, section, action, expected }; }
async function capture(suffix = '') {
  await page.mouse.move(3, 775);
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, rootWidth: document.documentElement.scrollWidth, workspaces: document.querySelectorAll('.workspace-page').length }));
  assert.ok(geometry.rootWidth <= geometry.width, 'No horizontal document overflow');
  assert.ok(geometry.workspaces <= 1, 'Only one main workspace may remain mounted');
  const screenshotPath = path.join(output, `${current.id}${suffix}.png`);
  await page.screenshot({ path: screenshotPath });
  layouts.push({ id: current.id, suffix, screenshotPath, ...geometry });
  return screenshotPath;
}
async function record(observed, { status = 'passed', notes = [], screenshotPath } = {}) {
  records.push({ ...current, observed, status, screenshotPath: screenshotPath ?? await capture(), notes });
  await writeFile(path.join(output, 'records.json'), JSON.stringify(records, null, 2));
  await writeInspection(false);
}
async function writeInspection(ok, error) {
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ ok, directory, output, current, records, layouts, evidence, fixtureCalls, errors, error, sourceId, realUserDataOpened: false, maintenanceCommandsExecuted: false, clipboardMode: 'transport', nativeFileDialogsAutomated: false, nativeArchiveImplementationUsed: true, secondProcessReopenTested: false }, null, 2));
}
async function copy(id, expected) {
  const before = await page.evaluate(() => window.__lifecycleAudit.copies.length);
  await step(id).getByRole('button', { name: '复制命令', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__lifecycleAudit.copies.length)).toBe(before + 1);
  assert.equal(await page.evaluate(() => window.__lifecycleAudit.copies.at(-1)), expected);
}
async function attachImage(id, imageBytes) {
  await openCommentComposer(step(id));
  const chooser = page.waitForEvent('filechooser');
  await step(id).getByRole('button', { name: '添加图片', exact: true }).click();
  await (await chooser).setFiles({ name: '验收附件-W08评论与记录.png', mimeType: 'image/png', buffer: imageBytes });
  await expect(step(id).locator('.image-preview img')).toBeVisible();
}
async function repeat(name, carry) {
  await page.locator('.heading-actions').getByRole('button', { name: '再做一次', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '再做一次', exact: true });
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  await dialog.getByRole('textbox', { name: '工作名称', exact: true }).fill(name);
  if (!carry) await dialog.getByRole('checkbox').uncheck();
  const screenshotPath = await capture('-dialog');
  await dialog.getByRole('button', { name: '创建新工作', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const item = (await load()).instances.find(item => item.name === name);
  assert.ok(item);
  assert.equal(item.status, 'draft');
  assert.equal(item.sourceInstanceId, sourceId);
  assert.deepEqual(item.entries, []);
  for (const key of ['startedAt', 'finishedAt', 'currentStepId', 'terminationReason', 'archivedAt']) assert.equal(item[key], null);
  return { item, screenshotPath };
}
async function exportUi(button) {
  const before = await page.evaluate(() => window.__lifecycleAudit.exports.length);
  await button.click();
  await expect.poll(() => page.evaluate(() => window.__lifecycleAudit.exports.length)).toBe(before + 1);
  return page.evaluate(() => window.__lifecycleAudit.exports.at(-1));
}

try {
  await page.setViewportSize({ width: 1360, height: 780 });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__lifecycleAudit = { copies: [], exports: [], imports: [] };
    const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'http://ipc.localhost' && !(url.protocol === 'ipc:' && url.hostname === 'localhost')) return original(input, init);
      const command = decodeURIComponent(url.pathname.slice(1)), args = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (command === 'lifecycle_audit_probe') return reply(true);
      if (command === 'plugin:clipboard-manager|write_text') { window.__lifecycleAudit.copies.push(args.text); return reply(null); }
      if (command === 'checklist_save_export') { window.__lifecycleAudit.exports.push(structuredClone(args)); return reply(true); }
      if (command === 'checklist_pick_import') return reply(window.__lifecycleAudit.imports.shift() ?? null);
      return original(input, init);
    };
  });
  await page.reload();
  await expect(page.locator('.library-page')).toBeVisible();
  assert.equal(await native('lifecycle_audit_probe'), true);
  assert.deepEqual(await page.locator('.app-sidebar nav button > span').allTextContents(), ['工作记录', '收藏的步骤', '归档']);
  const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src));
  assert.ok(scripts.some(src => src.endsWith('/assets/index-CCGITBUJ.js')), 'Audit must use the current desktop build');
  evidence.assetScripts = scripts;

  begin('W01', '直接新建工作', '工作与开始', '点击新建工作，检查空名称保护，再输入中文名称并创建。', '空名称不可提交；创建独立未开始工作，初始只有一个步骤。');
  await page.getByRole('button', { name: '新建工作', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新建工作', exact: true });
  await expect(dialog.getByRole('button', { name: '新建工作', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: '工作名称' }).fill('外服补丁维护·验收草稿');
  const newDialogShot = await capture('-dialog');
  await dialog.getByRole('button', { name: '新建工作', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const blank = (await load()).instances.find(item => item.name === '外服补丁维护·验收草稿');
  assert.ok(blank); assert.equal(blank.status, 'draft'); assert.equal(blank.sourceTemplateId, null); assert.equal(blank.document.steps.length, 1);
  evidence.blankId = blank.id;
  await record('空名称时创建按钮禁用；填写名称后生成一份独立草稿。', { screenshotPath: newDialogShot });

  begin('W02', '名称与正文就地编辑', '工作与开始', '双击工作名称及步骤标题编辑；从左侧＋添加命令。', '自动保存真实中文名称和步骤内容，命令仅作为文本。');
  await page.locator('[data-inline-field="工作名称"]').dblclick();
  await page.getByRole('textbox', { name: '工作名称', exact: true }).fill('外服补丁维护·可删除草稿');
  await page.getByRole('textbox', { name: '工作名称', exact: true }).press('Enter');
  const blankStep = step(blank.document.steps[0].id);
  await blankStep.locator('[data-inline-field="步骤标题"]').dblclick();
  await blankStep.getByRole('textbox', { name: '步骤标题', exact: true }).fill('核对本次维护范围');
  await blankStep.getByRole('button', { name: '步骤新增', exact: true }).click();
  await page.getByRole('menuitem', { name: '添加命令', exact: true }).click();
  await blankStep.getByRole('textbox', { name: '命令 1', exact: true }).fill('echo audit-only');
  await blankStep.getByRole('textbox', { name: '命令 1', exact: true }).press('Escape');
  await expect.poll(async () => (await work(blank.id)).name).toBe('外服补丁维护·可删除草稿');
  await expect.poll(async () => (await work(blank.id)).document.steps[0].commands[0].text).toEqual(['echo audit-only']);
  assert.deepEqual((await work(blank.id)).document.steps[0].title, ['核对本次维护范围']);
  await record('名称与步骤标题已保存；命令文本同步保存到隔离工作。');

  const document = { groups: [{ id: 'patch-group', name: '外服补丁发布', description: '维护演练，仅展示与复制命令；所有结果人工记录。' }], parameters: [
    { id: 'env', name: '环境', description: '本次维护环境', defaultValue: 'release' },
    { id: 'player', ownerId: 'patch-group', name: '玩家 ID', description: '人工核对对象', defaultValue: '' },
  ], steps: [
    { id: 'stop', groupId: 'patch-group', title: ['检查停服状态'], description: ['确认 ', { parameterId: 'env' }, ' 环境与玩家 ', { parameterId: 'player' }, '，由操作者记录检查结论。'], commands: [{ id: 'stop-command', text: ['stopserver ', { parameterId: 'env' }, ' all'] }] },
    { id: 'publish', groupId: 'patch-group', title: ['发布补丁包'], description: ['核对补丁包校验结果，确认是否需要重复发布。'], commands: [{ id: 'publish-command', text: ['publishgame ', { parameterId: 'env' }] }] },
    { id: 'verify', title: ['人工复核并结束'], description: ['核对完成项、跳过原因及本次证据。'], commands: [] },
  ] };
  fixtureCalls.push({ type: 'create_work', id: sourceId, reason: '一次性种子夹具提供含变量的三步真实工作；此后生命周期完全由 UI 推进。' });
  await native('checklist_apply', { action: { type: 'create_work', id: sourceId, name: '外服补丁维护·验收', document } });
  await page.reload(); await expect(page.locator('.library-page')).toBeVisible(); await open(sourceId);
  begin('W03', '缺值保护', '工作与开始', '打开含空默认值的工作，检查待填参数和开始按钮。', '玩家 ID 缺失时不能开始记录；原生状态仍为 draft。');
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeDisabled();
  await expect(page.locator('.start-panel')).toContainText('还需填写 1 个参数');
  assert.equal((await work(sourceId)).status, 'draft');
  await record('缺失玩家 ID 清楚列出；开始记录按钮禁用。', { notes: ['三步流程由原生种子夹具创建，缺值保护直接观察真实 UI。'] });

  begin('W04', '填参并显式开始', '工作与开始', '填写环境 sandboxa 与玩家 ID 456，点击开始记录。', '显式开始后保存本次值，首步成为当前步骤。');
  await fillValue('env', 'sandboxa'); await fillValue('player', '456');
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect(step('stop')).toHaveClass(/is-current/);
  await expect(page.locator('.save-state')).toHaveText('已保存在本机');
  assert.equal((await work(sourceId)).parameterValues.env, 'sandboxa'); assert.equal((await work(sourceId)).status, 'in_progress');
  await record('工作进入进行中，首步成为当前步骤，本次参数已应用。');

  begin('W05', '复制已替换变量的命令', '人工执行记录', '点击当前命令卡的复制按钮。', 'IPC 收到 stopserver sandboxa all，复制不推进执行。');
  await copy('stop', 'stopserver sandboxa all'); assert.equal((await work(sourceId)).entries.length, 0);
  evidence.copiedCommand = await page.evaluate(() => window.__lifecycleAudit.copies.at(-1));
  await record('复制 IPC 捕获到完整替换后的文本；没有结果记录或步骤推进。', { status: 'partial', notes: [copyNote] });

  begin('W06', '失败原因必填', '人工执行记录', '点击记录失败，检查空原因按钮禁用，填写原因后保存。', '空白不可提交；保存失败后停留当前步骤。');
  await step('stop').getByRole('button', { name: '记录失败', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '记录失败', exact: true });
  await expect(dialog.getByRole('button', { name: '保存失败记录', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox').fill('监控尚未确认停服状态，先记录异常再复核。');
  const failureDialogShot = await capture('-dialog');
  await dialog.getByRole('button', { name: '保存失败记录', exact: true }).click(); await expect(dialog).toHaveCount(0);
  assert.equal((await work(sourceId)).currentStepId, 'stop'); assert.equal((await work(sourceId)).entries.at(-1).outcome, 'failed');
  await record('必填原因生效；提交后保留失败原因和当前步骤。', { screenshotPath: failureDialogShot });

  begin('W07', '查看失败时内容', '人工执行记录', '展开失败时的内容与参数。', '标题栏展示最新失败，折叠区保留失败时命令与参数。');
  await step('stop').locator('[data-current-failure-snapshot] > summary').click();
  await expect(step('stop').locator('[data-current-failure-snapshot]')).toContainText('stopserver sandboxa all');
  await expect(step('stop').locator('.step-result-reason')).toContainText('监控尚未确认');
  await record('当前失败原因在标题栏可见；快照保留 sandboxa 命令。');
  await step('stop').locator('[data-current-failure-snapshot] > summary').click();

  begin('W08', '补充记录与评论管理', '评论与图片', '展开补充记录、填写后收起再展开；新增评论，编辑保存，再新增并删除临时评论。', '收起不丢草稿；新增、编辑和删除均准确作用于对应评论。');
  await openCommentComposer(step('stop'));
  await step('stop').getByRole('textbox', { name: '添加评论', exact: true }).fill('已核对外部监控，等待复核停服状态。');
  await step('stop').locator('.comment-details > summary').click();
  await expect(step('stop').locator('.comment-details > summary')).toContainText('有未提交评论');
  await capture('-collapsed-draft');
  await openCommentComposer(step('stop'));
  await expect(step('stop').getByRole('textbox', { name: '添加评论', exact: true })).toHaveValue('已核对外部监控，等待复核停服状态。');
  await step('stop').getByRole('button', { name: '添加评论', exact: true }).click();
  await step('stop').getByRole('button', { name: '编辑评论', exact: true }).click();
  await step('stop').getByRole('textbox', { name: '编辑评论', exact: true }).fill('复核完成：停服状态已经确认，保留本次人工检查证据。');
  await step('stop').getByRole('button', { name: '保存评论', exact: true }).click();
  await expect(step('stop').locator('.comment-record')).toContainText('已编辑');
  await step('stop').getByRole('textbox', { name: '添加评论', exact: true }).fill('临时备注，验证精确删除。');
  await step('stop').getByRole('button', { name: '添加评论', exact: true }).click();
  await step('stop').locator('.comment-record').filter({ hasText: '临时备注' }).getByRole('button', { name: '删除评论', exact: true }).click();
  await expect(step('stop').locator('.comment-record')).toHaveCount(1);
  assert.equal((await work(sourceId)).entries.filter(entry => entry.type === 'comment').length, 1);
  await record('折叠后草稿仍在；已编辑评论保留，临时评论单独删除。');

  begin('W09', '图片添加、查看与删除', '评论与图片', '点击添加图片并提供本轮 W08 界面 PNG，查看大图，再删除后重新添加用于存档核验。', '图片显示和大图查看正常；删除仅移除当前材料，再添加的原始字节保留。');
  const sourceScreenshotPath = records.find(record => record.id === 'W08').screenshotPath;
  const imagePath = path.join(output, 'test-image-W08-comment-record.png');
  await copyFile(sourceScreenshotPath, imagePath);
  evidence.imageFixture = { sourceScreenshotPath, imagePath, source: '本轮真实 UI 截图，仅作为附件测试材料，不是新增业务证据。' };
  const imageBytes = await readFile(imagePath);
  await attachImage('stop', imageBytes);
  // The nested image contributes its caption to the accessible button name.
  // The UI tooltip, not the computed accessible name, identifies this action.
  await step('stop').getByTitle('查看完整图片', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: '图片预览', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '图片预览', exact: true }).locator(':scope > img')).toHaveJSProperty('naturalWidth', 1360);
  evidence.imagePreview = await page.getByRole('dialog', { name: '图片预览', exact: true }).evaluate(node => {
    const img = node.querySelector(':scope > img'), close = node.querySelector('.lightbox-close'), svg = close.querySelector('svg');
    const closeStyle = getComputedStyle(close), svgStyle = getComputedStyle(svg);
    return { imageWidth: img.naturalWidth, imageHeight: img.naturalHeight, renderedWidth: img.getBoundingClientRect().width, renderedHeight: img.getBoundingClientRect().height,
      closeColor: closeStyle.color, closeBackground: closeStyle.backgroundColor, iconColor: svgStyle.color, iconStroke: svgStyle.stroke, iconWidth: svg.getBoundingClientRect().width, iconHeight: svg.getBoundingClientRect().height };
  });
  assert.equal(evidence.imagePreview.imageWidth, 1360); assert.equal(evidence.imagePreview.imageHeight, 780);
  const imageShot = await capture('-preview');
  await page.getByRole('dialog', { name: '图片预览', exact: true }).getByTitle('关闭图片', { exact: true }).click();
  await step('stop').getByRole('button', { name: '删除图片', exact: true }).click();
  await expect(step('stop').locator('.image-preview img')).toHaveCount(0);
  await attachImage('stop', imageBytes);
  const retainedImage = (await work(sourceId)).entries.find(entry => entry.type === 'image');
  assert.deepEqual(Buffer.from((await native('checklist_read_image', { instanceId: sourceId, path: retainedImage.path })).split(',')[1], 'base64'), imageBytes);
  const imageNotes = [imageNote];
  if (evidence.imagePreview.iconColor === evidence.imagePreview.closeBackground) imageNotes.push('视觉观察：预览右上角关闭图标与按钮底色相同，呈空白方块；点击可正常关闭，图标对比度待修复。');
  await record('图片能添加、打开大图、删除及重新添加；原生读取的图片字节一致。', { status: 'partial', screenshotPath: imageShot, notes: imageNotes });

  begin('W10', '重试成功与历史冻结', '人工执行记录', '将环境改为 preview 并应用，重新复制后完成当前步，再查看旧失败快照。', '当前成功使用新值，先前失败仍保留 sandboxa；完成后推进到发布步骤。');
  await fillValue('env', 'preview'); await page.getByRole('button', { name: '应用全局参数', exact: true }).click();
  await copy('stop', 'stopserver preview all');
  await step('stop').getByRole('button', { name: '完成并下一步', exact: true }).click();
  await expect(step('publish')).toHaveClass(/is-current/);
  const attempts = (await work(sourceId)).entries.filter(entry => entry.type === 'result' && entry.stepId === 'stop');
  assert.deepEqual(attempts.map(entry => entry.outcome), ['failed', 'completed']);
  assert.equal(attempts[0].snapshot.parameterValues.env, 'sandboxa'); assert.equal(attempts[1].snapshot.parameterValues.env, 'preview');
  await expand('stop'); await step('stop').locator('.result-record > summary').click();
  await step('stop').locator('.result-record .snapshot-details > summary').click();
  await expect(step('stop').locator('.result-record')).toContainText('stopserver sandboxa all');
  await record('同一步保留失败与完成两次结果；失败快照未被新参数覆盖。', { notes: [copyNote] });

  begin('W11', '跳过必须说明原因', '人工执行记录', '在发布步骤点击跳过，检查必填保护并提交原因。', '空原因不能提交；确认后记录跳过并进入人工复核。');
  await step('publish').getByRole('button', { name: '跳过', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '跳过这一步', exact: true });
  await expect(dialog.getByRole('button', { name: '确认跳过', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox').fill('补丁包已在前一维护窗口发布，本次无需重复发布。');
  const skipShot = await capture('-dialog');
  await dialog.getByRole('button', { name: '确认跳过', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(step('verify')).toHaveClass(/is-current/);
  assert.equal((await work(sourceId)).entries.filter(entry => entry.type === 'result').at(-1).outcome, 'skipped');
  await record('原因必填生效；发布步骤记为跳过，当前执行位置前进。', { screenshotPath: skipShot });

  begin('W12', '完成并结束工作', '人工执行记录', '在人工复核步骤点击完成并结束。', '显示结束摘要，状态为 completed，保留四条结果。');
  await step('verify').getByRole('button', { name: '完成并结束', exact: true }).click();
  await expect(page.locator('.completion-banner')).toContainText('本次工作已结束');
  const completed = await work(sourceId); assert.equal(completed.status, 'completed'); assert.equal(completed.entries.filter(entry => entry.type === 'result').length, 4);
  await page.locator('.completion-banner').scrollIntoViewIfNeeded();
  await record('结束摘要显示 2 步完成、1 步跳过；失败尝试仍留在历史中。');

  begin('W13', '再做一次：带入已应用值', '复用与归档', '从已完成工作再做一次，保留带入上次参数值，修改新工作的命令和环境。', '新工作未开始且无历史材料；新旧文档、参数互相独立。');
  const carried = await repeat('外服补丁维护·带值再做一次', true);
  assert.deepEqual(carried.item.parameterValues, completed.parameterValues);
  await expand('stop'); await step('stop').locator('[data-inline-field="命令 1"]').dblclick();
  await step('stop').getByRole('textbox', { name: '命令 1', exact: true }).fill('echo isolated-new-work');
  await step('stop').getByRole('textbox', { name: '命令 1', exact: true }).press('Escape');
  await fillValue('env', 'sandboxd'); await page.getByRole('button', { name: '应用全局参数', exact: true }).click();
  // Clicking returns before the app's flush/apply queue completes. Wait for
  // the persisted value; never submit the action a second time to make it pass.
  await expect.poll(async () => (await work(carried.item.id)).parameterValues.env).toBe('sandboxd');
  await expect(page.locator('.save-state')).toHaveText('已保存在本机');
  assert.deepEqual((await work(carried.item.id)).document.steps[0].commands[0].text, ['echo isolated-new-work']);
  assert.deepEqual(await work(sourceId), completed);
  evidence.carriedId = carried.item.id;
  await record('独立草稿带入 preview/456；改成 sandboxd 和新命令后，来源完整记录未变化。', { screenshotPath: carried.screenshotPath });

  begin('W14', '再做一次：使用定义默认值', '复用与归档', '回到来源工作，再做一次并取消带入上次参数值。', '环境恢复 release、玩家 ID 为空，缺值保护重新生效。');
  await open(sourceId); const defaults = await repeat('外服补丁维护·默认值重做', false);
  assert.equal(defaults.item.parameterValues.env, 'release'); assert.equal(defaults.item.parameterValues.player, '');
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeDisabled();
  assert.deepEqual(await work(sourceId), completed); evidence.defaultsId = defaults.item.id;
  await record('取消带入后使用定义默认值；玩家 ID 需重新填写，来源历史保持不变。', { screenshotPath: defaults.screenshotPath });

  begin('W15', '终止与原因保护', '复用与归档', '打开带值副本并开始，更多操作选择终止；验证空原因，填写后确认。', '终止要求原因；结束推进并保留原因，可继续管理材料或再做一次。');
  await open(carried.item.id); await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await menu('终止'); dialog = page.getByRole('dialog', { name: '终止本次工作', exact: true });
  await expect(dialog.getByRole('button', { name: '确认终止', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox').fill('本轮仅验证独立副本，终止演练。'); await capture('-dialog');
  await dialog.getByRole('button', { name: '确认终止', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.locator('.completion-banner')).toContainText('本次工作已终止');
  assert.equal((await work(carried.item.id)).status, 'terminated'); assert.deepEqual(await work(sourceId), completed);
  await record('副本已终止，原因清楚保留；来源完成记录未受影响。');

  begin('W16', '手动归档', '复用与归档', '将已完成来源工作归档，分别核对工作记录与归档列表。', '归档改变列表归属，结果和材料保持完整。');
  await open(sourceId); await page.locator('.completion-banner').getByRole('button', { name: '归档', exact: true }).click();
  await nav('工作记录'); await expect(page.locator(`[data-instance-id="${sourceId}"]`)).toHaveCount(0);
  await nav('归档'); await expect(page.locator(`[data-instance-id="${sourceId}"]`)).toBeVisible();
  assert.ok((await work(sourceId)).archivedAt); assert.deepEqual((await work(sourceId)).entries, completed.entries);
  await record('工作从当前列表移出并出现在归档列表；全部记录仍在。');

  begin('W17', '归档移回当前', '复用与归档', '打开归档工作，从更多操作选择移回当前。', '工作回到当前列表，仍为已完成，历史未改变。');
  await open(sourceId, true); await menu('移回当前');
  await nav('归档'); await expect(page.locator(`[data-instance-id="${sourceId}"]`)).toHaveCount(0);
  await nav('工作记录'); await expect(page.locator(`[data-instance-id="${sourceId}"]`)).toBeVisible();
  assert.equal((await work(sourceId)).archivedAt, null); assert.equal((await work(sourceId)).status, 'completed');
  assert.deepEqual((await work(sourceId)).entries, completed.entries);
  await record('工作回到当前列表，状态仍为已完成，原历史完整保留。');

  begin('W18', 'ZIP 完整存档导出', '导入与导出', '点击工作导出存档，保存真实原生 ZIP 到隔离目录并检查包内容。', 'ZIP 含 runbook.json 与唯一登记图片，中文内容、结果和图片字节一致。');
  await open(sourceId); const original = await work(sourceId);
  const archive = await exportUi(page.getByRole('button', { name: '导出存档', exact: true }));
  assert.match(archive.name, /\.runbook\.zip$/); assert.equal(Buffer.from(archive.bytes).subarray(0, 2).toString(), 'PK');
  const archivePath = path.join(directory, 'audit-complete.runbook.zip'); await writeFile(archivePath, Buffer.from(archive.bytes));
  const zipCheck = spawnSync('python', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n d=json.loads(z.read("runbook.json")); images=[e["path"] for e in d["entries"] if e["type"]=="image"]\n assert set(z.namelist())==set(["runbook.json"]+images)\n assert len(images)==1\n assert z.read(images[0])==open(sys.argv[2],"rb").read()\n assert d["status"]=="completed"\n print(json.dumps({"entries":len(d["entries"]),"images":len(images),"formatVersion":d["formatVersion"],"status":d["status"]}))', archivePath, imagePath], { encoding: 'utf8', windowsHide: true });
  assert.equal(zipCheck.status, 0, zipCheck.stderr); evidence.zip = { archivePath, ...JSON.parse(zipCheck.stdout) };
  await record('原生 ZIP 解包检查通过：完整 JSON、6 条记录及 1 张原始图片。', { status: 'partial', notes: [fileNote, '落盘和 ZIP 解包由测试脚本在本轮 desktop-smoke 隔离目录完成。'] });

  begin('W19', 'ZIP 重复导入确认', '导入与导出', '从导入入口选取刚导出的 ZIP，检查重复提示并确认独立副本。', '重复记录不能静默覆盖；新副本保留所有历史与图片。');
  const oldIds = new Set((await load()).instances.map(item => item.id));
  await page.evaluate(file => window.__lifecycleAudit.imports.push(file), archive);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入预览', exact: true });
  await expect(dialog).toContainText('本地已存在同一份工作记录'); await expect(dialog).toContainText('内容已通过结构与完整性校验');
  const importShot = await capture('-dialog');
  await dialog.getByRole('button', { name: '导入为独立副本', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const imported = (await load()).instances.find(item => !oldIds.has(item.id)); assert.ok(imported);
  assert.deepEqual(imported.document, original.document); assert.deepEqual(imported.entries, original.entries); assert.deepEqual(imported.parameterValues, original.parameterValues);
  assert.equal(imported.status, original.status); assert.deepEqual(await work(sourceId), original);
  evidence.importedId = imported.id;
  await record('重复预览明确要求独立副本；导入后流程、参数、结果、评论、图片完整，原记录未覆盖。', { status: 'partial', screenshotPath: importShot, notes: [fileNote] });

  begin('W20', '导入副本材料独立', '导入与导出', '仅编辑导入副本的评论并删除其图片，复核来源材料。', '副本可独立管理材料，原记录评论和图片字节不变。');
  await expand('stop'); await expect(step('stop').locator('.image-preview img')).toBeVisible();
  await step('stop').getByRole('button', { name: '编辑评论', exact: true }).click();
  await step('stop').getByRole('textbox', { name: '编辑评论', exact: true }).fill('只修改导入副本：材料已独立整理。');
  await step('stop').getByRole('button', { name: '保存评论', exact: true }).click();
  await step('stop').getByRole('button', { name: '删除图片', exact: true }).click(); await expect(step('stop').locator('.image-preview img')).toHaveCount(0);
  assert.deepEqual(await work(sourceId), original);
  assert.deepEqual(Buffer.from((await native('checklist_read_image', { instanceId: sourceId, path: retainedImage.path })).split(',')[1], 'base64'), imageBytes);
  await record('导入副本评论已修改、图片已删除；来源数据与原图字节完全一致。');

  begin('W21', '收藏 JSON 导出', '导入与导出', '进入收藏的步骤，从一份现有收藏菜单导出收藏。', '生成有效 v2 JSON，保留该收藏名称、变量与步骤。');
  await nav('收藏的步骤'); const favorite = (await load()).blocks[0]; assert.ok(favorite);
  const favoriteCard = page.locator(`[data-favorite-id="${favorite.id}"]`);
  await favoriteCard.locator('.favorite-toggle').click(); await favoriteCard.locator('.more-menu > summary').click();
  const jsonFile = await exportUi(favoriteCard.getByRole('button', { name: '导出收藏', exact: true }));
  assert.match(jsonFile.name, /\.runbook\.json$/); const jsonData = JSON.parse(Buffer.from(jsonFile.bytes).toString('utf8'));
  assert.equal(jsonData.formatVersion, 2); assert.equal(jsonData.kind, 'block'); assert.equal(jsonData.name, favorite.name); assert.deepEqual(jsonData.document, favorite.document);
  const jsonPath = path.join(directory, 'audit-favorite.runbook.json'); await writeFile(jsonPath, Buffer.from(jsonFile.bytes)); evidence.favoriteJson = { jsonPath, favoriteId: favorite.id, kind: jsonData.kind, formatVersion: jsonData.formatVersion };
  await record('收藏成功导出 v2 JSON；解析后名称、变量与全部步骤与原收藏一致。', { status: 'partial', notes: [fileNote] });

  begin('W22', 'JSON 重复导入独立副本', '导入与导出', '通过导入入口选择收藏 JSON，确认重复提示并导入为独立副本。', '收藏副本使用新身份，完整内容保留，原收藏不变。');
  const oldBlocks = new Set((await load()).blocks.map(item => item.id));
  await page.evaluate(file => window.__lifecycleAudit.imports.push(file), jsonFile); await page.getByRole('button', { name: '导入', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入预览', exact: true }); await expect(dialog).toContainText('本地已存在同一份收藏');
  const jsonImportShot = await capture('-dialog');
  await dialog.getByRole('button', { name: '导入为独立副本', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const importedFavorite = (await load()).blocks.find(item => !oldBlocks.has(item.id)); assert.ok(importedFavorite);
  assert.notEqual(importedFavorite.id, favorite.id); assert.deepEqual(importedFavorite.document, favorite.document);
  assert.deepEqual((await load()).blocks.find(item => item.id === favorite.id), favorite); evidence.importedFavoriteId = importedFavorite.id;
  await record('重复收藏导入创建新身份；流程内容一致，原收藏未覆盖。', { status: 'partial', screenshotPath: jsonImportShot, notes: [fileNote] });

  begin('W23', '删除工作：取消', '删除与保护', '打开本轮新建草稿，选择删除工作，核对名称后取消。', '确认框说明范围；取消不删除对象或改动内容。');
  await open(blank.id); const beforeDelete = await work(blank.id); await menu('删除工作');
  dialog = page.getByRole('dialog', { name: '删除工作', exact: true }); await expect(dialog).toContainText('外服补丁维护·可删除草稿');
  const deleteShot = await capture('-dialog'); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
  assert.deepEqual(await work(blank.id), beforeDelete);
  await record('确认框列明将删除该工作的流程、参数、记录和材料；取消后对象完全保留。', { screenshotPath: deleteShot });

  begin('W24', '删除工作：明确确认', '删除与保护', '再次删除本轮草稿并明确确认，回到工作列表。', '仅目标草稿删除，来源和其他独立副本完整。');
  await menu('删除工作'); dialog = page.getByRole('dialog', { name: '删除工作', exact: true });
  await dialog.getByRole('button', { name: '确认删除工作', exact: true }).click(); await expect(dialog).toHaveCount(0);
  assert.equal(await work(blank.id), undefined); assert.deepEqual(await work(sourceId), original); assert.ok(await work(imported.id));
  await nav('工作记录'); await expect(page.locator(`[data-instance-id="${blank.id}"]`)).toHaveCount(0);
  await record('目标草稿从工作列表和原生数据移除；来源与导入副本仍完整。');
  assert.deepEqual(errors, []);
  evidence.finalWorkspace = await load();
  await writeInspection(true);
  console.log(JSON.stringify({ ok: true, output, directory, records: records.length, sourceId, evidenceIds: { carried: carried.item.id, defaults: defaults.item.id, imported: imported.id } }));
} catch (error) {
  const screenshotPath = path.join(output, 'failure.png');
  await page.mouse.move(3, 775).catch(() => {});
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  if (current) records.push({ ...current, observed: String(error), status: 'failed', screenshotPath, notes: ['失败现场保留；未将未完成动作记录为通过。'] });
  await writeFile(path.join(output, 'records.json'), JSON.stringify(records, null, 2));
  await writeInspection(false, String(error));
  throw error;
} finally { await browser.close(); }
