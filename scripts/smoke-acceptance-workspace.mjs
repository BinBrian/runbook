// Focused acceptance for items 04/05/06/08/09. Run through check-desktop.mjs.
// Native writes create isolated fixtures only; audited actions use real WebView2 UI.
// Clipboard IPC is captured in transport mode; no claim of Windows clipboard IO.
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
assert.equal(process.env.RUNBOOK_CLIPBOARD_TEST_MODE, 'transport');
assert.ok(process.env.RUNBOOK_CDP_URL);
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
const output = path.resolve(process.env.RUNBOOK_TEST_OUTPUT_DIR ?? '.artifacts/acceptance-workspace-2026-10-23');
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const checks = [], errors = [];
let activeCheck;
page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const seed = (id, name, document) => native('checklist_apply', { action: { type: 'create_work', id, name, document } });
const id = 'workspace-acceptance', work = async (workId = id) => (await native('checklist_load')).instances.find(item => item.id === workId);
const card = stepId => page.locator(`[data-step-id="${stepId}"]`);
const command = commandId => page.locator(`[data-command-id="${commandId}"]`);
const panel = page.locator('.variable-panel'), row = parameterId => panel.locator(`[data-variable-id="${parameterId}"]`);
const input = parameterId => row(parameterId).locator('input[data-parameter-id]');
const scope = ownerId => panel.locator(`[data-parameter-scope="${ownerId}"]`);
const scroll = page.locator('.workspace-scroll'), quick = page.locator('.current-step-actions');
const ref = parameterId => ({ parameterId });
const long = Array.from({ length: 32 }, (_, i) => `人工核对 ${i + 1}：维护测试服，记录状态和结果。`).join('\n');
const documentFixture = {
  parameters: [
    { id: 'ticket', name: '维护单', description: '本次维护标识', defaultValue: '' },
    { id: 'env-a', ownerId: 'group-a', name: '环境', description: '甲组目标', defaultValue: '蓝服' },
    { id: 'env-b', ownerId: 'group-b', name: '环境', description: '乙组目标', defaultValue: '灰服' },
    { id: 'unused', name: '未使用备注', description: '无引用变量', defaultValue: '保留' },
  ],
  groups: [{ id: 'group-a', name: '甲组维护' }, { id: 'group-b', name: '乙组维护' }],
  steps: [
    { id: 'a1', groupId: 'group-a', title: ['维护测试服 · 长步骤'], description: ['目标：', ref('env-a'), '；维护单：', ref('ticket'), '\n', long], commands: [
      { id: 'dependent', text: ['维护目标=', ref('env-a')] },
      { id: 'unrelated', text: ['人工核对维护窗口'] },
    ] },
    { id: 'a2', groupId: 'group-a', title: ['甲组复核'], description: ['复核目标：', ref('env-a'), '\n', long], commands: [] },
    { id: 'b1', groupId: 'group-b', title: ['乙组核对'], description: ['独立目标：', ref('env-b'), '\n', long], commands: [] },
    { id: 'tail', title: ['最后人工确认'], description: ['确认记录完整。'], commands: [] },
  ],
};
async function frames(count = 12) {
  await page.evaluate(count => new Promise(resolve => { const frame = () => --count <= 0 ? resolve() : requestAnimationFrame(frame); requestAnimationFrame(frame); }), count);
}
async function stable() {
  await scroll.evaluate(element => new Promise((resolve, reject) => {
    let last, same = 0, attempts = 0;
    const frame = () => {
      const next = element.scrollTop;
      same = last !== undefined && Math.abs(next - last) < .1 ? same + 1 : 0; last = next;
      if (same >= 6) resolve(); else if (++attempts > 240) reject(new Error('Workspace scroll failed to stabilize')); else requestAnimationFrame(frame);
    }; requestAnimationFrame(frame);
  }));
}
async function locate(stepId) {
  await page.locator(`[data-nav-step-id="${stepId}"]`).click();
  await expect(card(stepId).locator(':scope > .step-card-heading')).toHaveAttribute('aria-expanded', 'true');
  await stable();
}
async function open(workId) {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '工作记录' }).click();
  await page.locator(`[data-instance-id="${workId}"]`).click();
  await expect(page.locator('[data-inline-field="工作名称"]')).toBeVisible();
}
async function bodyValue(stepId, parameterId) {
  await locate(stepId);
  const token = card(stepId).locator(`.step-description .variable-token[data-parameter-id="${parameterId}"]`);
  await token.scrollIntoViewIfNeeded(); await stable();
  const before = await scroll.evaluate(element => element.scrollTop);
  await token.click(); await expect(input(parameterId)).toBeFocused(); await frames();
  const after = await scroll.evaluate(element => element.scrollTop);
  assert.ok(Math.abs(after - before) <= 3, `Body variable ${parameterId} moved reading position ${before} -> ${after}`);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-parameter-id')), parameterId);
  return { parameterId, stepId, before, after };
}
async function editValue(parameterId, next) {
  await row(parameterId).hover();
  await row(parameterId).getByRole('button', { name: /^变量操作 / }).click();
  await page.getByRole('menuitem', { name: '修改本次值', exact: true }).click();
  await input(parameterId).fill(next); await input(parameterId).press('Enter');
  await expect(row(parameterId)).toHaveAttribute('data-variable-pending', 'true');
}
async function saveCheck(name, details = {}) {
  const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, rootWidth: document.documentElement.scrollWidth }));
  assert.ok(layout.rootWidth <= layout.width + 1, 'No document horizontal overflow');
  const screenshotPath = path.join(output, `${name}.png`);
  await page.screenshot({ path: screenshotPath, animations: 'disabled' });
  checks.push({ name, status: 'passed', ...details, layout, screenshotPath });
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ status: 'running', directory, clipboardMode: 'transport', actualWindowsClipboard: false, checks, errors }, null, 2), 'utf8');
}
async function copy(commandId, expected) {
  const before = await page.evaluate(() => window.__copies.length);
  await command(commandId).getByRole('button', { name: '复制命令', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__copies.length)).toBe(before + 1);
  const call = await page.evaluate(() => window.__copies.at(-1));
  assert.equal(call.text, expected); return call;
}
async function quickGeometry() {
  return quick.evaluate(element => {
    const root = element.previousElementSibling, bounds = element.getBoundingClientRect(), content = root.getBoundingClientRect();
    return { previousClass: root.className, sibling: root.classList.contains('workspace-scroll'), bottom: bounds.bottom, top: bounds.top, scrollBottom: content.bottom, height: innerHeight, position: getComputedStyle(element).position };
  });
}
try {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window); window.__copies = [];
    window.fetch = async (request, init) => {
      const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
      if (url.origin === 'http://ipc.localhost' || url.protocol === 'ipc:' && url.hostname === 'localhost') {
        const operation = decodeURIComponent(url.pathname.slice(1));
        if (operation.startsWith('plugin:clipboard-manager|')) {
          if (operation !== 'plugin:clipboard-manager|write_text') throw new Error(`Unexpected clipboard operation: ${operation}`);
          window.__copies.push(JSON.parse(init.body));
          return new Response('null', { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
        }
      }
      return original(request, init);
    };
  });
  await seed('workspace-no-variables', '维护测试服 · 无变量', { parameters: [], groups: [], steps: [{ id: 'plain', title: ['人工确认'], description: [], commands: [] }] });
  await seed(id, '维护测试服 · 工作区专项', documentFixture);
  const mergeId = 'workspace-merge-search';
  await seed(mergeId, '维护测试服 · 合组后筛选恢复', {
    parameters: [{ id: 'merge-env', name: '合组目标', description: '', defaultValue: '维护测试服' }], groups: [], steps: [
      { id: 'merge-lead', title: ['合组前说明'], description: [long], commands: [] },
      { id: 'merge-one', title: ['连续核对一'], description: [ref('merge-env'), '\n', long], commands: [] },
      { id: 'merge-two', title: ['连续核对二'], description: [ref('merge-env'), '\n', long], commands: [] },
      { id: 'merge-tail', title: ['末尾阅读位置'], description: [long, '\n', long], commands: [] },
    ],
  });
  await page.reload(); await page.setViewportSize({ width: 1360, height: 780 });

  activeCheck = '09-start-no-variables';
  await open('workspace-no-variables');
  await expect(page.locator('.start-panel')).toContainText('准备开始');
  await expect(page.locator('.start-panel')).not.toContainText('填写');
  await expect(page.locator('.start-panel p')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeEnabled();
  await saveCheck(activeCheck);
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect.poll(async () => (await work('workspace-no-variables')).status).toBe('in_progress');

  activeCheck = '09-start-missing';
  await open(id); await expect(page.locator('.start-panel')).toContainText('还需填写 1 个参数');
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeDisabled();
  await saveCheck(activeCheck);
  await editValue('ticket', '维护测试服-01');
  activeCheck = '09-start-pending';
  await expect(page.locator('.start-panel')).toContainText('1 个参数修改待应用');
  await expect(page.getByRole('button', { name: '应用并开始', exact: true })).toBeEnabled();
  assert.equal((await work()).parameterValues.ticket, ''); await saveCheck(activeCheck);
  await scope('global').getByRole('button', { name: '应用全局参数', exact: true }).click();
  await expect.poll(async () => (await work()).parameterValues.ticket).toBe('维护测试服-01');
  activeCheck = '09-start-ready';
  await expect(page.locator('.start-panel')).toContainText('参数已就绪');
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeEnabled(); await saveCheck(activeCheck);
  await editValue('ticket', '维护测试服-02');
  await page.getByRole('button', { name: '应用并开始', exact: true }).click();
  await expect.poll(async () => (await work()).status).toBe('in_progress');
  assert.equal((await work()).parameterValues.ticket, '维护测试服-02');

  activeCheck = '05-body-stable-identity';
  const beforeIdentity = await work(), identity = [];
  identity.push(await bodyValue('a2', 'env-a'));
  await expect(scope('group-a')).toHaveAttribute('aria-expanded', 'true');
  await expect(input('env-a')).toHaveValue('蓝服');
  await input('env-a').press('Enter');
  identity.push(await bodyValue('b1', 'env-b'));
  await expect(scope('group-b')).toHaveAttribute('aria-expanded', 'true');
  await expect(input('env-b')).toHaveValue('灰服');
  assert.equal(await input('env-a').count(), 0);
  assert.deepEqual(await work(), beforeIdentity); await saveCheck(activeCheck, { identity });
  await input('env-b').press('Enter');

  activeCheck = '06-filter-count-and-restore';
  await locate('b1');
  await scroll.hover(); await page.mouse.wheel(0, 190); await stable();
  const original = await scroll.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight }));
  const beforeFilter = await work();
  if (await scope('group-a').getAttribute('aria-expanded') === 'false') await scope('group-a').locator('[data-variable-tree-toggle]').first().click();
  await row('env-a').locator('[data-variable-name]').click();
  await expect(page.locator('.variable-filter-summary')).toContainText('甲组维护');
  await expect(page.locator('.variable-filter-summary')).toContainText('2 步 · 3 处引用');
  assert.deepEqual(await page.locator('[data-step-id]').evaluateAll(elements => elements.map(e => e.dataset.stepId)), ['a1', 'a2']);
  await saveCheck(activeCheck, { original });
  await page.getByRole('button', { name: '显示全部', exact: true }).click(); await stable();
  await expect(page.locator('.variable-filter-summary')).toHaveCount(0);
  const restored = await scroll.evaluate(element => element.scrollTop);
  assert.ok(Math.abs(restored - original.top) <= 3, `Search restore ${original.top} -> ${restored}`);
  assert.deepEqual(await work(), beforeFilter);
  checks.at(-1).restoredTop = restored;
  activeCheck = '06-filter-empty';
  await row('unused').locator('[data-variable-name]').click();
  await expect(page.locator('.variable-filter-summary')).toContainText('0 步 · 0 处引用');
  await expect(page.locator('.variable-search-empty')).toHaveText('没有匹配的变量引用步骤');
  await expect(page.locator('[data-step-id]')).toHaveCount(0); await saveCheck(activeCheck);
  await page.getByRole('button', { name: '显示全部', exact: true }).click(); await stable();
  assert.ok(Math.abs(await scroll.evaluate(element => element.scrollTop) - original.top) <= 3);

  activeCheck = '05-body-tag-keeps-existing-filter';
  const search = panel.getByRole('searchbox', { name: '搜索变量', exact: true });
  await search.fill('甲组维护.环境'); await stable();
  await expect(page.locator('.variable-filter-summary')).toContainText('2 步 · 3 处引用');
  await expect(row('ticket')).toHaveCount(0);
  const otherToken = card('a1').locator('.step-description .variable-token[data-parameter-id="ticket"]');
  await otherToken.scrollIntoViewIfNeeded(); await stable();
  const beforeTag = await scroll.evaluate(element => element.scrollTop), beforeTagWork = await work();
  await otherToken.click(); await expect(input('ticket')).toBeFocused(); await frames();
  const afterTag = await scroll.evaluate(element => element.scrollTop);
  await expect(search).toHaveValue('甲组维护.环境');
  await expect(page.locator('.variable-filter-summary')).toContainText('2 步 · 3 处引用');
  assert.deepEqual(await page.locator('[data-step-id]').evaluateAll(elements => elements.map(element => element.dataset.stepId)), ['a1', 'a2']);
  assert.ok(Math.abs(afterTag - beforeTag) <= 3, `Filtered body tag moved reading position ${beforeTag} -> ${afterTag}`);
  assert.deepEqual(await work(), beforeTagWork);
  await saveCheck(activeCheck, { query: '甲组维护.环境', requestedId: 'ticket', beforeTag, afterTag });
  await input('ticket').press('Enter');
  await page.getByRole('button', { name: '显示全部', exact: true }).click(); await stable();
  assert.ok(Math.abs(await scroll.evaluate(element => element.scrollTop) - original.top) <= 3);

  activeCheck = '04-pending-command-boundary';
  await bodyValue('a1', 'env-a'); await input('env-a').fill('绿服'); await input('env-a').press('Enter');
  await command('dependent').scrollIntoViewIfNeeded(); await stable();
  await expect(command('dependent').locator('.command-pending-values')).toContainText('当前生效：蓝服');
  await expect(command('dependent').locator('.command-pending-values')).toContainText('待应用：绿服');
  await expect(command('unrelated').locator('.command-pending-values')).toHaveCount(0);
  const copiedApplied = await copy('dependent', '维护目标=蓝服');
  const beforeRejected = await work();
  for (const name of ['完成并下一步', '记录失败', '跳过']) {
    await card('a1').locator('[data-step-result-actions]').getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.error-strip')).toContainText('未应用');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.deepEqual(await work(), beforeRejected);
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  }
  await saveCheck(activeCheck, { copiedApplied, clipboardMode: 'transport', actualWindowsClipboard: false, rejected: ['completed', 'failed', 'skipped'] });
  await command('dependent').getByRole('button', { name: /^查看并应用 / }).click();
  await expect(input('env-a')).toBeFocused(); await expect(input('env-a')).toHaveValue('绿服');
  await scope('group-a').getByRole('button', { name: '应用本组参数', exact: true }).click();
  await expect.poll(async () => (await work()).parameterValues['env-a']).toBe('绿服');
  await expect(command('dependent').locator('.command-pending-values')).toHaveCount(0);
  const copiedNext = await copy('dependent', '维护目标=绿服');
  await saveCheck('04-command-applied', { copiedNext });

  activeCheck = '08-long-step-and-reading-other';
  const geometry = [];
  for (const width of [1360, 940]) {
    await page.setViewportSize({ width, height: 780 });
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-switcher').click();
      await locate('a1');
      await expect(quick.getByRole('button', { name: '快捷完成并下一步', exact: true })).toBeVisible();
      await expect(quick).toContainText('当前步骤 · 1'); await expect(quick).toContainText('维护测试服 · 长步骤');
      const metrics = await quickGeometry();
      assert.ok(metrics.sibling && metrics.top >= metrics.scrollBottom - 1 && metrics.bottom <= metrics.height + 1);
      geometry.push({ width, theme, ...metrics });
      await locate('b1');
      await expect(quick.getByRole('button', { name: '返回当前步骤', exact: true })).toBeVisible();
      await expect(quick.getByRole('button', { name: '快捷完成并下一步', exact: true })).toHaveCount(0);
      assert.equal((await work()).currentStepId, 'a1');
      await quick.getByRole('button', { name: '返回当前步骤', exact: true }).click(); await stable();
      await expect(quick.getByRole('button', { name: '快捷完成并下一步', exact: true })).toBeVisible();
      await saveCheck(`${activeCheck}-${width}-${theme}`, { metrics });
    }
  }
  await page.setViewportSize({ width: 1360, height: 780 });
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.locator('.theme-switcher').click();
  activeCheck = '08-comments-reachable';
  await locate('a1');
  await card('a1').locator('.comment-details > summary').click();
  const comment = card('a1').getByRole('textbox', { name: '添加评论', exact: true });
  await comment.fill('维护测试服：底部备注可完整阅读和提交。');
  const addComment = card('a1').getByRole('button', { name: '添加评论', exact: true });
  await addComment.scrollIntoViewIfNeeded(); await stable();
  const commentBounds = await comment.boundingBox(), actionBounds = await addComment.boundingBox(), scrollBounds = await scroll.boundingBox();
  assert.ok(commentBounds.y >= scrollBounds.y - 1 && actionBounds.y + actionBounds.height <= scrollBounds.y + scrollBounds.height + 1);
  if (await quick.count()) { const bar = await quick.boundingBox(); assert.ok(bar.y >= scrollBounds.y + scrollBounds.height - 1); }
  await saveCheck(activeCheck, { commentBounds, actionBounds, scrollBounds });
  await addComment.click();
  await expect.poll(async () => (await work()).entries.some(entry => entry.type === 'comment' && entry.text === '维护测试服：底部备注可完整阅读和提交。')).toBe(true);

  activeCheck = '08-quick-submit-results';
  await locate('a1'); await quick.getByRole('button', { name: '快捷完成并下一步', exact: true }).click();
  await expect.poll(async () => (await work()).currentStepId).toBe('a2');
  await locate('a2'); await quick.getByRole('button', { name: '快捷记录失败', exact: true }).click();
  const failure = page.getByRole('dialog', { name: '记录失败', exact: true });
  await failure.getByRole('textbox', { name: '失败原因', exact: true }).fill('维护测试服：人工核对暂未通过。');
  await failure.getByRole('button', { name: '保存失败记录', exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect.poll(async () => (await work()).entries.some(entry => entry.type === 'result' && entry.stepId === 'a2' && entry.outcome === 'failed')).toBe(true);
  assert.equal((await work()).currentStepId, 'a2');
  await locate('a2'); await quick.getByRole('button', { name: '快捷跳过', exact: true }).click();
  const skip = page.getByRole('dialog', { name: '跳过这一步', exact: true });
  await skip.getByRole('textbox', { name: '跳过原因', exact: true }).fill('维护测试服：保留失败记录后继续下一组核对。');
  await skip.getByRole('button', { name: '确认跳过', exact: true }).click();
  await expect.poll(async () => (await work()).currentStepId).toBe('b1');
  assert.deepEqual((await work()).entries.filter(entry => entry.type === 'result').map(entry => [entry.stepId, entry.outcome]), [['a1', 'completed'], ['a2', 'failed'], ['a2', 'skipped']]);
  await saveCheck(activeCheck, { geometry });

  activeCheck = '06-merge-invalidates-old-search-origin';
  await open(mergeId); await locate('merge-tail');
  await scroll.hover(); await page.mouse.wheel(0, 500); await stable();
  const oldOrigin = await scroll.evaluate(element => element.scrollTop);
  await row('merge-env').locator('[data-variable-name]').click();
  await expect(page.locator('.variable-filter-summary')).toContainText('2 步 · 2 处引用');
  await card('merge-one').getByRole('checkbox', { name: '选择步骤 2', exact: true }).click();
  await card('merge-two').getByRole('checkbox', { name: '选择步骤 3', exact: true }).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: '合并为步骤组', exact: true }).click();
  await expect.poll(async () => (await work(mergeId)).document.groups.length).toBe(1);
  await expect(page.locator('.variable-filter-summary')).toHaveCount(0);
  const groupId = (await work(mergeId)).document.groups[0].id;
  const merged = page.locator(`[data-group-id="${groupId}"]`);
  const groupName = merged.getByRole('textbox', { name: '步骤组名称', exact: true });
  await expect(groupName).toBeFocused(); await groupName.fill('维护测试服核对组'); await groupName.press('Enter');
  await expect.poll(async () => (await work(mergeId)).document.groups[0].name).toBe('维护测试服核对组');
  await stable();
  // Do not navigate: navigation also clears the old search origin and would hide the regression.
  await scroll.hover(); await page.mouse.wheel(0, 120); await stable();
  const newOrigin = await scroll.evaluate(element => element.scrollTop), mergedWork = await work(mergeId);
  assert.ok(Math.abs(newOrigin - oldOrigin) > 120, 'Fixture must separate the old and new reading positions');
  await row('merge-env').locator('[data-variable-name]').click();
  await expect(page.locator('.variable-filter-summary')).toContainText('2 步 · 2 处引用');
  await page.getByRole('button', { name: '显示全部', exact: true }).click(); await stable();
  const afterMergeClear = await scroll.evaluate(element => element.scrollTop);
  assert.ok(Math.abs(afterMergeClear - newOrigin) <= 3, `Second search restored stale origin: old=${oldOrigin}, new=${newOrigin}, actual=${afterMergeClear}`);
  await expect(merged.locator(':scope > .execution-group-heading')).toHaveAttribute('aria-expanded', 'true');
  await expect(card('merge-one').locator(':scope > .step-card-heading')).toHaveAttribute('aria-expanded', 'true');
  await expect(card('merge-two').locator(':scope > .step-card-heading')).toHaveAttribute('aria-expanded', 'true');
  assert.deepEqual(await work(mergeId), mergedWork);
  await saveCheck(activeCheck, { oldOrigin, newOrigin, afterMergeClear, groupId });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ status: 'passed', directory, clipboardMode: 'transport', actualWindowsClipboard: false, checks, errors, final: await work(), finalMerge: await work(mergeId) }, null, 2), 'utf8');
  console.log(`Workspace acceptance passed: ${checks.length} focused captures. ${output}`);
} catch (error) {
  const screenshotPath = path.join(output, 'failure.png');
  await page.screenshot({ path: screenshotPath, animations: 'disabled' }).catch(() => {});
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ status: 'failed', directory, activeCheck, error: String(error), stack: error.stack, screenshotPath, clipboardMode: 'transport', actualWindowsClipboard: false, checks, errors, body: await page.locator('body').innerText().catch(() => ''), final: await work().catch(() => null), finalMerge: await work('workspace-merge-search').catch(() => null) }, null, 2), 'utf8');
  throw error;
} finally { await browser.close(); }
