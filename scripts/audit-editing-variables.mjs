// Current-work-center interaction audit. Run only through check-desktop.mjs.
// Native mutations create isolated seed works only; all audited changes use UI.
// Clipboard transport captures IPC and replays its formats without OS clipboard IO.
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

assert.equal(process.env.RUNBOOK_CLIPBOARD_TEST_MODE, 'transport');
assert.ok(process.env.RUNBOOK_TEST_OUTPUT_DIR && process.env.RUNBOOK_CDP_URL);
assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
const output = path.resolve(process.env.RUNBOOK_TEST_OUTPUT_DIR);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(13000);
const records = [], errors = [], details = [], layouts = [], interactionIssues = [];
let activeCase, currentWorkId = 'audit-editing-work';
page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const seed = (id, name, document) => native('checklist_apply', { action: { type: 'create_work', id, name, document } });
const load = () => native('checklist_load');
const work = async (id = currentWorkId) => (await load()).instances.find(item => item.id === id);
const storedStep = async id => (await work()).document.steps.find(item => item.id === id);
const card = id => page.locator(`[data-step-id="${id}"]`);
const group = id => page.locator(`[data-group-id="${id}"]`);
const panel = page.getByRole('complementary', { name: '变量面板', exact: true });
const row = id => panel.locator(`[data-variable-id="${id}"]`);
const search = panel.getByRole('searchbox', { name: '搜索变量', exact: true });
const valueInput = id => row(id).locator('input[data-parameter-id]');
const ref = parameterId => ({ parameterId });
const stepFixture = (id, title, description = [], commands = [], groupId) => ({ id, title: [title], description, commands, ...(groupId ? { groupId } : {}) });

async function saveRecords() { await writeFile(path.join(output, 'records.json'), JSON.stringify(records, null, 2), 'utf8'); }
async function saved(predicate) {
  if (predicate) await expect.poll(predicate).toBe(true);
  await expect(page.locator('.save-state')).toContainText('已保存在本机');
}
async function stable(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(element => new Promise((resolve, reject) => {
    let previous, same = 0, frames = 0;
    function frame() {
      const r = element.getBoundingClientRect(), next = [r.x, r.y, r.width, r.height];
      same = previous && next.every((x, i) => Math.abs(x - previous[i]) < .15) ? same + 1 : 0;
      previous = next;
      if (same >= 3) resolve(); else if (++frames > 180) reject(new Error('UI did not stabilize')); else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }));
}
async function snap(id) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, rootWidth: document.documentElement.scrollWidth, pages: document.querySelectorAll('.workspace-page,.favorites-library').length }));
  assert.ok(geometry.rootWidth <= geometry.width + 1, 'No root horizontal overflow');
  assert.equal(geometry.pages, 1, 'Exactly one active work or favorites page');
  layouts.push({ id, ...geometry });
  const screenshotPath = path.join(output, `${id}.png`);
  await page.screenshot({ path: screenshotPath, animations: 'disabled' });
  return screenshotPath;
}
async function audit(id, title, section, action, expected, run) {
  activeCase = { id, title, section, action, expected };
  const firstIssue = interactionIssues.length;
  console.log(`AUDIT ${id}: ${title}`);
  const result = await run();
  const screenshotPath = result.screenshotPath ?? await snap(id);
  const caseIssues = interactionIssues.slice(firstIssue);
  records.push({ ...activeCase, observed: result.observed, status: caseIssues.length ? 'partial' : result.status ?? 'passed', screenshotPath,
    notes: [...result.notes ?? [], ...caseIssues.map(issue => `${issue.message} 证据：${issue.screenshotPath}`)] });
  details.push({ id, ...result, screenshotPath });
  await saveRecords(); activeCase = null;
}
async function nav(name) { await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: name }).click(); }
async function openWork(id) {
  await nav('工作记录'); await page.locator(`[data-instance-id="${id}"]`).click(); currentWorkId = id;
  await expect(page.locator('[data-inline-field="工作名称"]')).toBeVisible();
}
async function locate(id) {
  await page.locator(`[data-nav-step-id="${id}"]`).click();
  await expect(card(id).locator(':scope > .step-card-heading')).toHaveAttribute('aria-expanded', 'true');
  await stable(card(id).locator(':scope > .step-card-heading'));
}
async function editStep(id, label, text) {
  await locate(id);
  const editor = card(id).getByRole('textbox', { name: label, exact: true });
  if (!await editor.count()) {
    const field = card(id).locator(`[data-inline-field="${label}"]`);
    await stable(field);
    await page.evaluate(() => { window.__auditPointerEvents = []; });
    const before = await field.evaluate(n => ({ bounds: n.getBoundingClientRect().toJSON(), expanded: n.closest('[data-step-id]').querySelector('.step-card-heading').getAttribute('aria-expanded') }));
    await field.dblclick();
    try { await expect(editor).toBeVisible({ timeout: 1800 }); }
    catch (error) {
      // Preserve the double-click failure, then use the existing keyboard entry
      // so unrelated insertion/structure/variable operations remain auditable.
      const screenshotPath = path.join(output, `${activeCase?.id ?? 'setup'}-activation-${interactionIssues.length + 1}.png`);
      await page.screenshot({ path: screenshotPath });
      const events = await page.evaluate(() => window.__auditPointerEvents);
      const after = await field.evaluate(n => ({ bounds: n.getBoundingClientRect().toJSON(), expanded: n.closest('[data-step-id]').querySelector('.step-card-heading').getAttribute('aria-expanded'), html: n.outerHTML, selected: getSelection()?.toString() }));
      const clicks = events.filter(event => event.type === 'click');
      const shifted = before.expanded === 'true' && after.expanded === 'false' && clicks[0]?.step === id && clicks[0]?.field === label && clicks.slice(1).some(event => event.step !== id);
      interactionIssues.push({ caseId: activeCase?.id, stepId: id, label, before, after, events, screenshotPath, error: String(error),
        classification: shifted ? 'confirmed-target-displacement' : 'double-click-entry-failed',
        message: shifted ? `${label}双击实测异常：首击收起导致目标位移，第二击落到其他步骤；F2仅用于继续其余验收，双击未通过。` : `${label}双击未进入编辑；已记录真实事件与截图，F2仅用于继续其余验收，双击未通过。` });
      await locate(id); await field.focus(); await field.press('F2');
    }
  }
  await expect(editor).toBeVisible();
  if (text !== undefined) { await editor.fill(text); await editor.press(label === '步骤标题' ? 'Escape' : 'Control+Enter'); }
  return editor;
}
async function stepAction(id, name) {
  await locate(id);
  const add = ['新增后续步骤', '添加命令', '插入收藏的步骤'].includes(name);
  const trigger = card(id).locator(add ? ':scope > [data-step-actions] > button' : ':scope > .step-card-heading [data-step-more-actions] > button');
  await stable(trigger); await trigger.click();
  const item = page.getByRole('menuitem', { name, exact: true }); await expect(item).toBeEnabled(); await item.click();
}
async function groupAction(id, name) {
  const member = (await work()).document.steps.find(step => step.groupId === id); await locate(member.id);
  const add = ['添加子步骤', '组后新增步骤', '组后插入收藏的步骤'].includes(name);
  const trigger = group(id).locator(add ? ':scope > [data-step-actions] > button' : ':scope > .execution-group-heading [data-step-more-actions] > button');
  await stable(trigger); await trigger.click();
  const item = page.getByRole('menuitem', { name, exact: true }); await expect(item).toBeEnabled(); await item.click();
}
async function variableMenu(id, action) {
  await row(id).scrollIntoViewIfNeeded(); await row(id).hover();
  await row(id).getByRole('button', { name: /^变量操作 / }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function clearSearch() {
  const clear = panel.getByRole('button', { name: '清空变量搜索', exact: true });
  if (await clear.count()) await clear.click();
  await expect(search).toHaveValue('');
}
async function expandBranch(name) {
  const button = panel.getByRole('button', { name: `展开 ${name}`, exact: true });
  if (await button.count()) await button.click();
}
async function fillValue(id, text) {
  if (!await valueInput(id).count()) await row(id).locator('[data-variable-value]').dblclick();
  await expect(valueInput(id)).toBeFocused(); await valueInput(id).fill(text); await valueInput(id).press('Enter');
}
async function createVariable(scope, name, defaultValue, description = '交互验收中新增的变量') {
  await panel.getByRole('button', { name: '新增变量', exact: true }).click();
  await page.getByRole('menuitem', { name: scope, exact: true }).click();
  const form = page.getByRole('dialog', { name: '新增变量', exact: true });
  await form.getByRole('textbox', { name: '变量名称', exact: true }).fill(name);
  await form.getByRole('textbox', { name: '变量说明', exact: true }).fill(description);
  await form.getByRole('textbox', { name: '变量默认值', exact: true }).fill(defaultValue);
  await form.getByRole('button', { name: '保存变量', exact: true }).click(); await expect(form).toHaveCount(0);
  await saved(async () => Boolean((await work()).document.parameters.find(p => p.name === name)));
  return (await work()).document.parameters.find(p => p.name === name);
}
async function editDefinition(id, name, defaultValue, description) {
  const old = (await work()).document.parameters.find(p => p.id === id);
  await variableMenu(id, `编辑变量 ${old.name}`);
  const form = page.getByRole('dialog', { name: '编辑变量定义', exact: true });
  if (name !== undefined) await form.getByRole('textbox', { name: '变量名称', exact: true }).fill(name);
  if (defaultValue !== undefined) await form.getByRole('textbox', { name: '变量默认值', exact: true }).fill(defaultValue);
  if (description !== undefined) await form.getByRole('textbox', { name: '变量说明', exact: true }).fill(description);
  await form.getByRole('button', { name: '保存变量', exact: true }).click(); await expect(form).toHaveCount(0);
  await saved(async () => { const p = (await work()).document.parameters.find(p => p.id === id); return (name === undefined || p.name === name) && (defaultValue === undefined || p.defaultValue === defaultValue); });
}
async function favorite(id, isGroup, name, replaceId) {
  if (isGroup) await groupAction(id, '收藏整个步骤组'); else await stepAction(id, '收藏这一步');
  const dialog = page.getByRole('dialog', { name: '收藏步骤', exact: true });
  await dialog.getByRole('textbox', { name: '收藏名称', exact: true }).fill(name);
  if (replaceId) await dialog.getByLabel('保存到收藏', { exact: true }).selectOption(replaceId);
  await dialog.getByRole('button', { name: replaceId ? '更新收藏' : '保存收藏', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => Boolean((await load()).blocks.find(b => b.name === name))).toBe(true);
  return (await load()).blocks.find(b => b.name === name);
}
async function insertFavorite(after, block) {
  await stepAction(after, '插入收藏的步骤');
  const dialog = page.getByRole('dialog', { name: '插入收藏的步骤', exact: true });
  await dialog.getByRole('textbox', { name: '搜索收藏', exact: true }).fill(block.name);
  await dialog.locator(`[data-step-action-block-id="${block.id}"]`).click(); await expect(dialog).toHaveCount(0); await saved();
}
async function selectAll(editor) { await editor.focus(); await editor.press('Control+A'); await expect(page.getByRole('toolbar', { name: '选区变量操作', exact: true })).toBeVisible(); }

const editingDocument = {
  groups: [{ id: 'existing-group', name: '维护测试服', description: '核对测试服后，再按顺序维护。' }],
  parameters: [{ id: 'edit-env', name: '环境', description: '全局环境', defaultValue: '测试服' }, { id: 'edit-player', ownerId: 'b', name: '玩家', description: '本步骤玩家', defaultValue: '1001' }, { id: 'edit-group-env', ownerId: 'existing-group', name: '环境', description: '本组环境', defaultValue: '测试一区' }],
  steps: [stepFixture('a', '维护准备', ['维护测试服前，先核对目标。'], [{ id: 'ca', text: ['核对 ', ref('edit-env')] }]), stepFixture('b', '核对玩家', ['玩家 ', ref('edit-player')]), stepFixture('c', '记录维护窗口', ['确认本次维护时间。']), stepFixture('d', '检查公告'), stepFixture('e', '核对测试服', [ref('edit-group-env')], [], 'existing-group'), stepFixture('f', '维护后确认', ['人工确认服务状态。'], [], 'existing-group'), stepFixture('h', '最终复核')],
};
const variableDocument = {
  groups: [{ id: 'vg', name: '维护测试服', description: '本组的环境与全局环境独立。' }, { id: 'other-group', name: '维护体验服', description: '用于核对同名局部变量的身份。' }],
  parameters: [{ id: 'env', name: '环境', description: '整个流程共享', defaultValue: '测试服' }, { id: 'window', name: '维护时间', description: '本次维护窗口', defaultValue: '' }, { id: 'group-env', ownerId: 'vg', name: '环境', description: '维护测试服组范围', defaultValue: '测试一区' }, { id: 'step-note', ownerId: 'v1', name: '核对人', description: '仅当前步骤', defaultValue: '小李' }, { id: 'other-env', ownerId: 'other-group', name: '环境', description: '体验服组范围', defaultValue: '体验一区' }, { id: 'unused', name: '备用标记', description: '没有正文引用', defaultValue: '备用' }],
  steps: [stepFixture('prep', '确认维护窗口', ['本次环境 ', ref('env'), '，维护时间 ', ref('window')], [{ id: 'cp', text: ['记录维护时间 ', ref('window')] }]), stepFixture('v1', '维护前核对', ['维护测试服：', ref('group-env'), '；核对人 ', ref('step-note')], [{ id: 'cv1', text: ['核对 ', ref('group-env')] }], 'vg'), stepFixture('v2', '维护后确认', ['复核 ', ref('group-env'), '，全局 ', ref('env')], [], 'vg'), stepFixture('v3', '体验服核对', [ref('other-env')], [], 'other-group'), stepFixture('finish', '结束复核', ['核对完成后记录。'])],
};

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window); window.__auditClipboard = [];
    window.__auditPointerEvents = [];
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) document.addEventListener(type, event => {
      const node = event.target instanceof Element ? event.target : event.target?.parentElement;
      window.__auditPointerEvents.push({ type, detail: event.detail, x: event.clientX, y: event.clientY, target: node?.tagName, text: node?.textContent?.slice(0, 80), field: node?.closest('[data-inline-field]')?.getAttribute('data-inline-field'), step: node?.closest('[data-step-id]')?.getAttribute('data-step-id') });
      if (window.__auditPointerEvents.length > 100) window.__auditPointerEvents.shift();
    }, true);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === 'http://ipc.localhost' || (url.protocol === 'ipc:' && url.hostname === 'localhost')) {
        const command = decodeURIComponent(url.pathname.slice(1));
        if (command.startsWith('plugin:clipboard-manager|')) {
          if (!['plugin:clipboard-manager|write_html', 'plugin:clipboard-manager|write_text'].includes(command)) throw new Error('OS clipboard access is prohibited by this transport audit');
          window.__auditClipboard.push({ command, args: JSON.parse(init.body) });
          return new Response('null', { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
        }
      }
      return original(input, init);
    };
  });
  await seed('audit-editing-work', '维护测试服 · 步骤与收藏验收', editingDocument);
  await seed('audit-variable-work', '维护测试服 · 变量交互验收', variableDocument);
  await seed('audit-favorite-destination', '维护测试服 · 插入收藏副本', { groups: [], parameters: [], steps: [stepFixture('base', '本次维护准备')] });
  await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src));
  assert.ok(scripts.some(src => src.endsWith('/assets/index-CCGITBUJ.js')), 'Audit must use the confirmed current executable UI asset');
  await openWork('audit-editing-work');

  await audit('E01', '双击编辑步骤标题与描述', '步骤与步骤组', '双击标题和描述，分别输入标题与两行说明，再结束编辑。', '标题、换行与中文精确保存在当前工作。', async () => {
    await editStep('a', '步骤标题', '维护测试服前的准备');
    await editStep('a', '操作说明', '维护测试服。\n先核对目标环境，再核对维护时间。');
    await saved(async () => JSON.stringify((await storedStep('a')).description) === JSON.stringify(['维护测试服。\n先核对目标环境，再核对维护时间。']));
    assert.deepEqual((await storedStep('a')).title, ['维护测试服前的准备']);
    return { observed: '标题与两行描述已按输入保存；退出编辑后以正文展示。' };
  });
  await audit('E02', '标题单击收起与展开', '步骤与步骤组', '单击步骤标题收起，再次单击展开，并检查标题没有意外选区。', '只改变阅读展开态，不修改流程内容或结果。', async () => {
    const before = await work(); const title = card('a').locator('[data-inline-field="步骤标题"]');
    await title.click(); await expect(card('a').locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'false');
    assert.equal(await page.evaluate(() => getSelection()?.toString()), '');
    await title.click(); await expect(card('a').locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true');
    assert.deepEqual(await work(), before);
    return { observed: '收起、展开均生效，标题无误选，保存数据与执行位置保持不变。' };
  });
  let addedStep;
  await audit('E03', '左侧＋新增步骤与命令', '步骤与步骤组', '从末步骤左＋新增后续步骤；从首步骤左＋添加命令并输入文本。', '新步骤位于指定位置；新命令自动进入编辑并精确保留。', async () => {
    const before = await work(); await stepAction('h', '新增后续步骤');
    await saved(async () => (await work()).document.steps.length === before.document.steps.length + 1);
    addedStep = (await work()).document.steps.at(-1).id;
    await editStep(addedStep, '步骤标题', '维护后填写交接记录'); await saved();
    await stepAction('a', '添加命令'); const editor = card('a').getByRole('textbox', { name: '命令 2', exact: true });
    await expect(editor).toBeFocused(); await editor.fill('echo 维护测试服'); await editor.press('Control+Enter');
    await saved(async () => (await storedStep('a')).commands.length === 2); assert.deepEqual((await storedStep('a')).commands[1].text, ['echo 维护测试服']);
    return { observed: '新增后续步骤位于流程末尾；第二条命令自动聚焦并保存，仅作为待复制文本。', notes: ['未执行命令。'] };
  });
  await audit('E04', '步骤⋯复制、移动与删除', '步骤与步骤组', '复制“检查公告”，将副本上移、下移，再删除副本。', '副本身份独立；移动不改内容；删除只影响所选副本。', async () => {
    const before = await work(); await stepAction('d', '复制当前步骤'); await saved(async () => (await work()).document.steps.length === before.document.steps.length + 1);
    const copy = (await work()).document.steps.find(s => !before.document.steps.some(old => old.id === s.id)); assert.ok(copy); assert.deepEqual(copy.title, ['检查公告']);
    await stepAction(copy.id, '上移步骤'); await saved(async () => (await work()).document.steps.findIndex(s => s.id === copy.id) < (await work()).document.steps.findIndex(s => s.id === 'd'));
    await stepAction(copy.id, '下移步骤'); await saved(async () => (await work()).document.steps.findIndex(s => s.id === copy.id) === (await work()).document.steps.findIndex(s => s.id === 'd') + 1);
    await stepAction(copy.id, '删除当前步骤'); await saved(async () => !(await work()).document.steps.some(s => s.id === copy.id)); assert.deepEqual((await work()).document, before.document); await locate('d');
    return { observed: '复制生成独立步骤；上移、下移顺序正确；删除副本后原文档完整恢复。', copiedStepId: copy.id };
  });
  await audit('E05', '非连续选择禁止合组', '步骤与步骤组', '点击第1步与第3步左侧编号。', '显示已选2步，合并按钮禁用并提示连续性限制。', async () => {
    const before = await work(); await locate('a'); await card('a').getByRole('checkbox').click(); await card('c').getByRole('checkbox').click();
    await expect(page.getByRole('button', { name: '合并为步骤组', exact: true })).toBeDisabled();
    await expect(page.getByRole('toolbar', { name: '批量步骤操作' })).toContainText('已选 2 步');
    const screenshotPath = await snap('E05'); await page.getByRole('button', { name: '取消选择', exact: true }).click(); assert.deepEqual(await work(), before);
    return { observed: '非连续选择被明确阻止；取消后未产生组、重排或其他数据变动。', screenshotPath };
  });
  let mergedGroup;
  await audit('E06', 'Shift连续选择并合组', '步骤与步骤组', '点击第1步编号，Shift点击第3步编号，执行合并并填写组名。', '三个连续步骤组成同级步骤组，原身份与顺序保留。', async () => {
    const before = await work(); await card('a').getByRole('checkbox').click(); await card('c').getByRole('checkbox').click({ modifiers: ['Shift'] });
    await expect(page.getByRole('toolbar', { name: '批量步骤操作' })).toContainText('已选 3 步');
    await page.getByRole('button', { name: '合并为步骤组', exact: true }).click();
    const title = page.getByRole('textbox', { name: '步骤组名称', exact: true }); await expect(title).toBeFocused(); await title.fill('维护前核对'); await title.press('Enter'); await saved();
    mergedGroup = (await work()).document.groups.find(g => g.id !== 'existing-group').id;
    assert.deepEqual((await work()).document.steps.map(s => s.id), before.document.steps.map(s => s.id));
    assert.deepEqual((await work()).document.steps.filter(s => s.groupId === mergedGroup).map(s => s.id), ['a', 'b', 'c']);
    assert.deepEqual((await work()).document.parameters, before.document.parameters); await locate('a');
    return { observed: '连续3步合并成功；组标题自动聚焦，步骤、命令和变量身份及原顺序均保留。', groupId: mergedGroup };
  });
  await audit('E07', '步骤组标题、描述与子步骤', '步骤与步骤组', '双击修改组标题与描述，从组左＋添加子步骤，再收起和展开组。', '组元数据和新增子步骤保存，子步骤归属当前组。', async () => {
    await group(mergedGroup).locator(':scope > .execution-group-heading [data-inline-field="步骤组名称"]').dblclick();
    let field = group(mergedGroup).getByRole('textbox', { name: '步骤组名称', exact: true }); await field.fill('维护前核对组'); await field.press('Enter');
    await group(mergedGroup).locator('[data-inline-field="步骤组描述"]').dblclick(); field = group(mergedGroup).getByRole('textbox', { name: '步骤组描述', exact: true }); await field.fill('维护测试服前逐项核对。\n组内步骤按原顺序处理。'); await field.press('Control+Enter'); await saved();
    const before = await work(); await groupAction(mergedGroup, '添加子步骤'); await saved(async () => (await work()).document.steps.length === before.document.steps.length + 1);
    const child = (await work()).document.steps.find(s => !before.document.steps.some(old => old.id === s.id)); assert.equal(child.groupId, mergedGroup);
    await editStep(child.id, '步骤标题', '补充维护前核验'); await saved();
    assert.equal((await work()).document.groups.find(g => g.id === mergedGroup).description, '维护测试服前逐项核对。\n组内步骤按原顺序处理。');
    const toggle = group(mergedGroup).locator(':scope > .execution-group-heading button[aria-label="收起步骤组"]').last(); await toggle.click(); await expect(group(mergedGroup).locator(':scope > .execution-group-body')).toHaveCount(0);
    await group(mergedGroup).locator(':scope > .execution-group-heading button[aria-label="展开步骤组"]').last().click(); await locate('a');
    return { observed: '组名、两行描述和新增子步骤保存；子步骤留在本组，组收起与展开正常。', childId: child.id };
  });
  await audit('E08', '整组复制、移动、删除与单步转组', '步骤与步骤组', '复制维护前核对组，将副本下移、上移后删除；再把交接步骤转为步骤组。', '组及成员独立复制、整体移动和精确删除；单步转组保留步骤身份。', async () => {
    const before = await work(); await groupAction(mergedGroup, '复制步骤组'); await saved(async () => (await work()).document.groups.length === before.document.groups.length + 1);
    const copied = (await work()).document.groups.find(g => !before.document.groups.some(old => old.id === g.id));
    const copiedMembers = (await work()).document.steps.filter(s => s.groupId === copied.id); assert.equal(copiedMembers.length, 4); assert.equal(copied.description, before.document.groups.find(g => g.id === mergedGroup).description);
    assert.ok(copiedMembers.every(s => !before.document.steps.some(old => old.id === s.id)));
    await groupAction(copied.id, '下移步骤组'); await saved(async () => (await work()).document.steps.findIndex(s => s.groupId === copied.id) > (await work()).document.steps.findIndex(s => s.id === 'd'));
    await groupAction(copied.id, '上移步骤组'); await saved();
    await groupAction(copied.id, '删除步骤组及子步骤'); await saved(async () => !(await work()).document.groups.some(g => g.id === copied.id)); assert.deepEqual((await work()).document, before.document);
    await stepAction(addedStep, '转为步骤组'); await saved(async () => Boolean((await storedStep(addedStep)).groupId));
    const converted = await storedStep(addedStep); assert.deepEqual(converted.title, ['维护后填写交接记录']); assert.equal((await work()).document.steps.filter(s => s.groupId === converted.groupId).length, 1); await locate(addedStep);
    return { observed: '4步组独立复制、整体移动及删除通过；交接步骤转为单步组，原步骤身份和内容保留。', copiedGroupId: copied.id, convertedGroupId: converted.groupId };
  });
  let singleFavorite, groupFavorite;
  await audit('E09', '收藏单步与整个步骤组', '收藏的步骤', '分别从步骤和组的⋯收藏当前内容。', '产生单步、组两类自包含收藏，仅携带定义默认值。', async () => {
    singleFavorite = await favorite('b', false, '核对玩家 · 单步收藏'); groupFavorite = await favorite(mergedGroup, true, '维护前核对 · 组收藏');
    assert.equal(singleFavorite.favorite.kind, 'step'); assert.equal(groupFavorite.favorite.kind, 'group'); assert.equal(groupFavorite.document.steps.length, 4);
    assert.equal(singleFavorite.document.parameters.find(p => p.name === '玩家').defaultValue, '1001');
    await nav('收藏的步骤'); await page.locator(`[data-favorite-id="${groupFavorite.id}"] .favorite-toggle`).click();
    await expect(page.locator(`[data-favorite-preview="${groupFavorite.id}"]`)).toBeVisible();
    return { observed: '单步与4步组收藏创建成功；组描述、步骤及变量默认值保留在只读预览中。' };
  });
  await audit('E10', '收藏搜索、预览、来源与重命名', '收藏的步骤', '先按步骤内容搜索，再用完整收藏名称筛选单步；预览、定位来源并重命名。', '内容搜索包含单步和组；完整名称筛选单项；预览只读且来源与收藏身份正确。', async () => {
    const input = page.getByRole('textbox', { name: '搜索收藏', exact: true }); await input.fill('核对玩家');
    await expect.poll(() => page.locator('[data-favorite-id]').evaluateAll(nodes => nodes.map(n => n.dataset.favoriteId).sort())).toEqual([singleFavorite.id, groupFavorite.id].sort());
    await input.fill(singleFavorite.name); await expect(page.locator('[data-favorite-id]')).toHaveCount(1);
    await page.locator(`[data-favorite-id="${singleFavorite.id}"] .favorite-toggle`).click(); await expect(page.locator('[data-favorite-preview]')).toBeVisible(); assert.equal(await page.locator('[contenteditable="true"]').count(), 0);
    await page.getByRole('button', { name: '维护测试服 · 步骤与收藏验收', exact: true }).click(); await expect(card('b')).toBeVisible();
    await nav('收藏的步骤'); await input.fill(''); await page.locator(`[data-favorite-id="${singleFavorite.id}"] summary`).click(); await page.getByRole('button', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名收藏', exact: true }); await dialog.getByRole('textbox', { name: '收藏名称', exact: true }).fill('维护测试服 · 玩家核对'); await dialog.getByRole('button', { name: '保存名称', exact: true }).click(); await expect(dialog).toHaveCount(0);
    singleFavorite = (await load()).blocks.find(b => b.id === singleFavorite.id); assert.equal(singleFavorite.name, '维护测试服 · 玩家核对');
    const toggle = page.locator(`[data-favorite-id="${singleFavorite.id}"] .favorite-toggle`); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    return { observed: '内容搜索匹配含该步骤的单步和组，完整名称筛选单项；预览只读，来源定位正确，重命名保持ID。' };
  });
  let insertedSingleId;
  await audit('E11', '插入收藏为独立流程副本', '收藏的步骤', '在另一工作中通过左＋插入单步与组收藏，然后编辑插入的单步。', '身份重新生成；局部参数归副本；编辑副本不影响收藏与来源。', async () => {
    const source = await work('audit-editing-work'); await openWork('audit-favorite-destination');
    await insertFavorite('base', singleFavorite); await saved(async () => (await work()).document.steps.length === 2);
    insertedSingleId = (await work()).document.steps[1].id; assert.notEqual(insertedSingleId, 'b');
    assert.ok((await work()).document.parameters.every(p => p.ownerId === insertedSingleId));
    await insertFavorite(insertedSingleId, groupFavorite); await saved(async () => (await work()).document.steps.length === 6);
    assert.equal((await work()).document.groups.length, 1);
    await editStep(insertedSingleId, '步骤标题', '本次工作独立核对玩家'); await saved(async () => JSON.stringify((await storedStep(insertedSingleId)).title) === JSON.stringify(['本次工作独立核对玩家']));
    assert.deepEqual((await load()).blocks.find(b => b.id === singleFavorite.id), singleFavorite); assert.deepEqual(await work('audit-editing-work'), source); await locate(insertedSingleId);
    return { observed: '插入1个单步和1个4步组；副本参数身份独立，修改插入标题未改变收藏或原工作。', insertedSingleId };
  });
  await audit('E12', '更新与移除收藏', '收藏的步骤', '将来源另一步显式更新到既有收藏，再从收藏列表移除；检查已插入副本。', '更新保留收藏身份；移除不删除来源或已插入流程。', async () => {
    const destination = await work('audit-favorite-destination'); await openWork('audit-editing-work');
    const updated = await favorite('c', false, '维护窗口 · 更新收藏', singleFavorite.id); assert.equal(updated.id, singleFavorite.id); assert.equal(updated.createdAt, singleFavorite.createdAt);
    assert.deepEqual(await work('audit-favorite-destination'), destination); await nav('收藏的步骤');
    await page.getByRole('textbox', { name: '搜索收藏', exact: true }).fill(''); await page.locator(`[data-favorite-id="${updated.id}"] summary`).click(); await page.getByRole('button', { name: '移除收藏', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '移除收藏', exact: true }); await expect(dialog).toContainText(updated.name); const screenshotPath = await snap('E12');
    await dialog.getByRole('button', { name: '确认移除收藏', exact: true }).click(); await expect(dialog).toHaveCount(0); assert.ok(!(await load()).blocks.some(b => b.id === updated.id));
    assert.deepEqual(await work('audit-favorite-destination'), destination); assert.ok((await work('audit-editing-work')).document.steps.some(s => s.id === 'c'));
    return { observed: '收藏被显式更新并移除；来源步骤与已插入的独立副本保留且不变。', screenshotPath, notes: ['截图为最后确认画面；随后确认删除并用保存数据核对独立副本。'] };
  });

  await openWork('audit-variable-work');
  for (const [caseId, scopeName, ownerId, title, localName] of [['E13', '新增全局变量', undefined, '全局变量新增、修改与删除', '验收备注'], ['E14', '新增步骤组变量', 'vg', '步骤组变量新增、修改与删除', '组核对备注'], ['E15', '新增步骤变量', 'v1', '步骤变量新增、修改与删除', '单步核对备注']]) {
    await audit(caseId, title, '变量定义与取值', `定位维护前核对，从变量＋选择${scopeName}，保存、修改后删除未引用变量。`, '名称、说明和默认值可编辑；归属不漂移；只允许删除未引用定义。', async () => {
      await clearSearch(); await locate('v1'); const created = await createVariable(scopeName, localName, '初始备注'); assert.equal(created.ownerId, ownerId);
      await editDefinition(created.id, `${localName}已修改`, '维护测试服', '已修改的说明');
      const changed = (await work()).document.parameters.find(p => p.id === created.id); assert.equal(changed.ownerId, ownerId); assert.equal(changed.description, '已修改的说明');
      await row(created.id).scrollIntoViewIfNeeded(); const screenshotPath = await snap(caseId);
      await variableMenu(created.id, `删除变量 ${localName}已修改`); await saved(async () => !(await work()).document.parameters.some(p => p.id === created.id));
      return { observed: `新增、修改和删除均成功；${ownerId ? `作用域固定为${ownerId === 'vg' ? '维护测试服组' : '维护前核对步骤'}` : '保持全局作用域'}。`, screenshotPath, notes: ['截图展示修改后、删除前状态；随后已执行删除并验证定义不再存在。'], parameterId: created.id, ownerId };
    });
  }
  await audit('E16', '定义默认值与本次值分离', '变量定义与取值', '编辑环境默认值后先取消，再重新修改并保存；核对实际值和正文。', '取消不保存定义；新默认值不覆盖本次应用值；被引用变量不能删除。', async () => {
    await clearSearch(); await locate('prep'); const before = await work();
    await variableMenu('env', '编辑变量 环境'); const form = page.getByRole('dialog', { name: '编辑变量定义', exact: true });
    await form.getByRole('textbox', { name: '变量默认值', exact: true }).fill('准备取消的默认值'); await form.getByRole('button', { name: '取消', exact: true }).click(); await expect(form).toHaveCount(0); assert.deepEqual(await work(), before);
    await editDefinition('env', undefined, '预发布服', '后续复用时使用的默认环境');
    assert.equal((await work()).parameterValues.env, before.parameterValues.env); assert.equal((await work()).document.parameters.find(p => p.id === 'env').defaultValue, '预发布服');
    await expect(card('prep').locator('.variable-token[data-parameter-id="env"]')).toHaveText('测试服');
    await row('env').hover(); await row('env').getByRole('button', { name: '变量操作 环境', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '删除变量 环境', exact: true })).toBeDisabled(); const screenshotPath = await snap('E16'); await page.keyboard.press('Escape');
    return { observed: '取消未提交定义无写入；保存默认值为预发布服后，本次值与正文仍是测试服；引用定义删除被禁用。', screenshotPath };
  });
  await audit('E17', '本次全局值取消与应用', '变量定义与取值', '双击全局环境输入本次值，先取消，再重新输入并应用全局参数。', '草稿不改变正文；取消还原；显式应用才更新实际值。', async () => {
    await fillValue('env', '准备取消的环境'); await expect(row('env').getByRole('status', { name: '未应用', exact: true })).toBeVisible(); assert.equal((await work()).parameterValues.env, '测试服');
    await clearSearch(); await panel.locator('[data-parameter-scope="global"]').getByRole('button', { name: '取消本范围修改', exact: true }).click(); await expect(row('env').locator('[data-variable-value]')).toHaveText('测试服');
    await fillValue('env', '测试二区'); await clearSearch(); await panel.getByRole('button', { name: '应用全局参数', exact: true }).click(); await saved(async () => (await work()).parameterValues.env === '测试二区');
    await locate('prep'); await expect(card('prep').locator('.variable-token[data-parameter-id="env"]')).toHaveText('测试二区');
    return { observed: '取消恢复测试服；第二次显式应用后保存与正文变为测试二区，默认值仍为预发布服。' };
  });
  await audit('E18', '组与步骤本次值按范围应用', '变量定义与取值', '分别修改组环境和步骤核对人，只应用组范围，再取消步骤草稿并重新应用步骤值。', '各范围互不串写；取消和应用只处理所选范围。', async () => {
    await locate('v1'); await expandBranch('维护测试服'); await expandBranch('维护前核对');
    await fillValue('group-env', '测试三区'); await clearSearch(); await fillValue('step-note', '待取消核对人'); await clearSearch();
    await panel.getByRole('button', { name: '应用本组参数', exact: true }).click();
    await expect.poll(async () => (await work()).parameterValues['group-env']).toBe('测试三区');
    await expect(page.locator('.save-state')).toContainText('草稿已保留');
    assert.equal((await work()).parameterValues['step-note'], '小李'); await expect(row('step-note').getByRole('status', { name: '未应用', exact: true })).toBeVisible();
    await panel.locator('[data-parameter-scope="v1"]').getByRole('button', { name: '取消本范围修改', exact: true }).click(); await expect(row('step-note').locator('[data-variable-value]')).toHaveText('小李');
    await fillValue('step-note', '小周'); await clearSearch(); await panel.getByRole('button', { name: '应用本步骤参数', exact: true }).click(); await saved(async () => (await work()).parameterValues['step-note'] === '小周');
    assert.equal((await work()).parameterValues['other-env'], '体验一区'); await locate('v1');
    return { observed: '组环境仅影响维护测试服组；步骤草稿取消后再应用小周；体验服同名环境保持体验一区。' };
  });
  await audit('E19', '缺值虚线标签与补填', '变量定义与取值', '查看缺少维护时间的虚线标签，点击待填摘要，输入并应用全局值。', '缺值只显示变量名；点击定位本次值；应用后正文标签变实线。', async () => {
    await locate('prep'); const tokens = card('prep').locator('.variable-token[data-parameter-id="window"]'); await expect(tokens).toHaveText(['维护时间', '维护时间']);
    assert.equal(await tokens.first().evaluate(n => getComputedStyle(n).borderStyle), 'dashed'); await expect(tokens.first()).toHaveAttribute('title', '未填写');
    const screenshotPath = await snap('E19');
    await page.locator('.missing-parameter-tag[data-parameter-target="window"]').click(); await expect(valueInput('window')).toBeFocused(); await valueInput('window').fill('今晚 22:00'); await valueInput('window').press('Enter');
    await expect(tokens).toHaveText(['维护时间', '维护时间']); await panel.getByRole('button', { name: '应用全局参数', exact: true }).click(); await saved(async () => (await work()).parameterValues.window === '今晚 22:00');
    await clearSearch(); await expect(tokens).toHaveText(['今晚 22:00', '今晚 22:00']); assert.equal(await tokens.first().evaluate(n => getComputedStyle(n).borderStyle), 'solid');
    return { observed: '缺值正文为“维护时间”虚线标签；输入草稿时保持缺值，显式应用后显示今晚22:00并变为实线。', screenshotPath, notes: ['截图展示补填前的待填状态；随后已完成定位、填写和应用断言。'] };
  });
  await audit('E20', '键入双花括号筛选已有变量', '变量引用与定位', '编辑说明，连续键入 {{，输入核对人过滤候选，并选择候选插入。', '候选只含可见作用域变量；选择后替换本次查询为稳定身份标签。', async () => {
    const editor = await editStep('v1', '操作说明'); await editor.fill('本次核对人：'); await editor.press('End'); await editor.pressSequentially('{{');
    const menu = page.getByRole('listbox', { name: '变量建议', exact: true }); await expect(menu).toBeVisible();
    const allIds = await menu.getByRole('option').evaluateAll(nodes => nodes.map(n => n.dataset.parameterId)); assert.ok(allIds.includes('env') && allIds.includes('group-env') && allIds.includes('step-note')); assert.ok(!allIds.includes('other-env'));
    await editor.pressSequentially('核对人'); await expect(menu.getByRole('option')).toHaveCount(1); await expect(menu.locator('[data-parameter-id="step-note"]')).toBeVisible(); const screenshotPath = await snap('E20');
    await menu.locator('[data-parameter-id="step-note"]').click(); await editor.press('Control+Enter'); await saved(async () => (await storedStep('v1')).description.some(p => p.parameterId === 'step-note'));
    assert.deepEqual((await storedStep('v1')).description, ['本次核对人：', ref('step-note')]);
    return { observed: '输入{{后出现本字段可用候选，筛选核对人只剩1项；接受后以原变量身份替换查询。', screenshotPath, notes: ['截图为接受前候选；接受与保存断言随后完成。'] };
  });
  await audit('E21', '选中文字复用已有变量', '变量引用与定位', '在说明中输入维护测试服，Ctrl+A选择文本，从选区工具栏使用已有组环境变量。', '只替换当前真实选区，保留原组变量身份与范围。', async () => {
    const editor = await editStep('v1', '操作说明'); await editor.fill('维护测试服'); await selectAll(editor);
    await page.getByRole('toolbar', { name: '选区变量操作', exact: true }).getByRole('button', { name: '使用变量', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '使用变量', exact: true }); await expect(dialog.locator('[data-parameter-id="group-env"]')).toBeVisible();
    await dialog.locator('[data-parameter-id="group-env"]').click(); await editor.press('Control+Enter');
    await saved(async () => JSON.stringify((await storedStep('v1')).description) === JSON.stringify([ref('group-env')]));
    return { observed: '真实键盘选区被组环境标签替换，定义没有新增；正文显示已应用的测试三区。', notes: ['文本选择通过WebView2键盘完成，未用DOM改写选区。'] };
  });
  let selectionVariable;
  await audit('E22', '选中文字新建局部变量', '变量引用与定位', '选择说明中的维护测试服，通过选区新增变量，将范围设为本步骤。', '选中文字成为默认值，新定义局限本步并替换当前选区。', async () => {
    const editor = await editStep('v1', '操作说明'); await editor.fill('维护测试服'); await selectAll(editor);
    await page.getByRole('toolbar', { name: '选区变量操作', exact: true }).getByRole('button', { name: '新增变量', exact: true }).click();
    const dialog = page.locator('[data-variable-popover][role="dialog"]'); await expect(dialog.getByRole('textbox', { name: '默认值', exact: true })).toHaveValue('维护测试服');
    await dialog.getByRole('textbox', { name: '新变量名称', exact: true }).fill('维护目标'); await dialog.getByRole('combobox', { name: '变量作用范围', exact: true }).selectOption('v1');
    const screenshotPath = await snap('E22'); await dialog.getByRole('button', { name: '创建并替换选区', exact: true }).click(); await editor.press('Control+Enter');
    await saved(async () => Boolean((await work()).document.parameters.find(p => p.name === '维护目标'))); selectionVariable = (await work()).document.parameters.find(p => p.name === '维护目标');
    assert.equal(selectionVariable.ownerId, 'v1'); assert.equal(selectionVariable.defaultValue, '维护测试服'); assert.deepEqual((await storedStep('v1')).description, [ref(selectionVariable.id)]);
    return { observed: '新建维护目标局部变量，默认值来自选中文字；说明仅替换当前选区，归属维护前核对步骤。', screenshotPath, notes: ['截图展示提交前表单；随后创建、替换与持久化均已断言。'], parameterId: selectionVariable.id };
  });
  await audit('E23', '复制变量引用并粘贴为标签', '变量引用与定位', '从变量⋯复制组环境引用，在步骤说明末尾粘贴捕获的HTML与纯文本格式。', '复制包含稳定变量ID；粘贴产生引用标签，保留已有内容。', async () => {
    await clearSearch(); await expandBranch('维护测试服'); const copyCount = await page.evaluate(() => window.__auditClipboard.length); await variableMenu('group-env', '复制变量引用 环境');
    await expect.poll(() => page.evaluate(() => window.__auditClipboard.length)).toBe(copyCount + 1);
    const payload = await page.evaluate(() => window.__auditClipboard.at(-1)); assert.equal(payload.command, 'plugin:clipboard-manager|write_html'); assert.equal(payload.args.altText, '{{环境}}'); assert.ok(payload.args.html.includes('group-env'));
    const editor = await editStep('v1', '操作说明'); await editor.press('Control+End'); await editor.pressSequentially('，引用：');
    await editor.evaluate((element, data) => { element.focus(); const selection = getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null; if (!range || !element.contains(range.startContainer)) throw new Error('Paste selection is outside the editor'); const transfer = new DataTransfer(); transfer.setData('text/html', data.html); transfer.setData('text/plain', data.altText); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); }, payload.args);
    await editor.press('Control+Enter'); await saved(async () => (await storedStep('v1')).description.some(p => p.parameterId === 'group-env'));
    const parts = (await storedStep('v1')).description; assert.ok(parts.some(p => p.parameterId === selectionVariable.id)); assert.ok(parts.some(p => p.parameterId === 'group-env'));
    return { observed: '真实复制按钮发出write_html IPC，载荷含group-env身份；同格式粘贴后正文为变量标签，原局部标签保留。', status: 'partial', notes: ['剪贴板使用transport夹具：已验证实际IPC载荷和WebView2粘贴处理，未操作系统剪贴板。'], payload };
  });
  await audit('E24', '变量树搜索与引用步骤过滤', '变量引用与定位', '在右侧搜索维护体验服.环境，再按Esc清空，并检查零引用变量。', '按命名空间区分同名变量，只显示实际引用步骤；清空恢复。', async () => {
    const before = await work(); await search.fill('维护体验服.环境'); await expect(row('other-env')).toBeVisible(); await expect(row('group-env')).toHaveCount(0);
    await expect.poll(() => page.locator('[data-step-id]').evaluateAll(nodes => nodes.map(n => n.dataset.stepId))).toEqual(['v3']);
    const screenshotPath = await snap('E24'); await search.press('Escape'); await expect(search).toHaveValue(''); await expect(page.locator('[data-step-id]')).toHaveCount(5);
    await row('unused').getByRole('button', { name: '选择变量 备用标记', exact: true }).click(); await expect(page.locator('.execution-steps')).toContainText('没有匹配的变量引用步骤');
    await clearSearch(); assert.deepEqual(await work(), before);
    return { observed: '体验服同名环境仅匹配自身1步；Esc恢复5步；无引用变量显示空结果，未改任何保存数据。', screenshotPath };
  });
  await audit('E25', '单击定位真实引用、高亮与清除', '变量引用与定位', '展开维护测试服变量分支并单击组环境，查看正文真实引用高亮，再清空搜索。', '右树保持稳定；真实引用步骤展开并定位；同名变量不混查；清空移除高亮。', async () => {
    const before = await work(); await locate('v1'); await expandBranch('维护测试服'); const button = row('group-env').getByRole('button', { name: '选择变量 环境', exact: true }); await stable(button); const beforeBox = await button.boundingBox(); await button.click();
    await expect(search).toHaveValue('维护测试服.环境'); await expect.poll(() => page.locator('[data-step-id]').evaluateAll(nodes => nodes.map(n => n.dataset.stepId))).toEqual(['v1', 'v2']);
    const afterBox = await button.boundingBox(); assert.ok(Math.abs(afterBox.y - beforeBox.y) < 2); assert.equal(await valueInput('group-env').count(), 0);
    const highlights = page.locator('.execution-steps [data-variable-match]'); await expect(highlights).toHaveCount(3);
    assert.deepEqual(await highlights.evaluateAll(nodes => [...new Set(nodes.map(n => n.dataset.parameterId))]), ['group-env']);
    assert.equal(await highlights.first().evaluate(n => getComputedStyle(n).transform), 'none');
    await expect.poll(() => highlights.first().evaluate(n => { const r = n.getBoundingClientRect(), v = n.closest('.workspace-scroll').getBoundingClientRect(); return r.top >= v.top - 2 && r.bottom <= v.bottom + 2; })).toBe(true);
    const screenshotPath = await snap('E25'); await clearSearch(); await expect(highlights).toHaveCount(0); await expect(page.locator('[data-step-id]')).toHaveCount(5); assert.deepEqual(await work(), before);
    return { observed: '单击精确定位2步中的3处组环境引用，右侧行位置稳定且不进入编辑；文字不缩放，清空移除高亮并恢复完整流程。', screenshotPath };
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ ok: true, directory, output, records: records.map(r => r.id), details, layouts, errors, interactionIssues, clipboardMode: 'transport', systemClipboardAccessed: false, realUserDataOpened: false, maintenanceCommandsExecuted: false, nativeMutations: 'create_work seeds only', expectedAsset: 'index-CCGITBUJ.js' }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, directory, output, recordCount: records.length }));
} catch (error) {
  const screenshotPath = path.join(output, activeCase ? `${activeCase.id}-failure.png` : 'failure.png'); await page.screenshot({ path: screenshotPath }).catch(() => {});
  if (activeCase) records.push({ ...activeCase, observed: String(error), status: 'failed', screenshotPath, notes: ['失败截图及已完成操作保留；未预填通过。'] });
  await saveRecords();
  const ui = await page.evaluate(() => ({ title: document.title, body: document.body.innerText, focus: document.activeElement?.outerHTML, selection: getSelection()?.toString(), clipboard: window.__auditClipboard })).catch(reason => ({ unavailable: String(reason) }));
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ ok: false, directory, output, activeCase, details, layouts, errors, interactionIssues, error: String(error), ui, workspace: await load().catch(() => null), clipboardMode: 'transport', systemClipboardAccessed: false, realUserDataOpened: false, maintenanceCommandsExecuted: false }, null, 2), 'utf8');
  throw error;
} finally { await browser.close(); }
