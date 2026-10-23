// Native IPC + real WebView2 in a harness-owned workspace. No command execution.
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const output = '.artifacts/variable-step-search-2026-10-21', checks = [], geometry = [], errors = [];
await mkdir(output, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), workspace = () => native('checklist_load');
const runId = 'tags-run', templateId = 'tags-template', ref = parameterId => ({ parameterId });
const parameter = (id, name, ownerId) => ({ id, name, description: '', defaultValue: '', ...(ownerId ? { ownerId } : {}) });
const document = { groups: [{ id: 'player-a', name: '玩家转区' }, { id: 'player-b', name: '玩家转区2' }, { id: 'unnamed', name: '' }], parameters: [
  parameter('start', '维护开始时间'), parameter('end', '维护结束时间'), parameter('global-late', '变更单号'),
  parameter('target-a', '目标区服', 'player-a'), parameter('player', '玩家ID', 'player-a'), parameter('source', '来源区服', 'step-a'),
  parameter('target-b', '目标区服', 'player-b'), parameter('group-empty', '环境', 'unnamed'), parameter('step-empty', '区服', 'empty-step'),
  parameter('unused', '未使用变量'),
], steps: [
  { id: 'first', title: ['设置维护时间'], description: [ref('start'), ' 至 ', ref('end')], commands: [] },
  ...Array.from({ length: 18 }, (_, index) => ({ id: `filler-${index}`, title: [`准备检查 ${index + 1}`], description: ['人工核对'], commands: [] })),
  { id: 'intro-a', groupId: 'player-a', title: ['阅读转区须知'], description: ['本步骤不引用任何参数。'], commands: [] },
  { id: 'step-a', groupId: 'player-a', title: ['核对目标'], description: [ref('target-a'), ' / ', ref('player'), ' / ', ref('source')], commands: [] },
  { id: 'intro-b', groupId: 'player-b', title: ['阅读转区须知'], description: ['本步骤不引用任何参数。'], commands: [] },
  { id: 'step-b', groupId: 'player-b', title: ['核对目标 ', ref('global-late')], description: ['核对后在外部操作。'], commands: [{ id: 'command-b', text: ['check ', ref('target-b')] }] },
  { id: 'empty-step', groupId: 'unnamed', title: [''], description: [ref('group-empty'), ' / ', ref('step-empty'), ' / ', ref('global-late')], commands: [] },
] };
const tags = () => page.getByRole('list', { name: '待填写变量', exact: true });
const tag = id => page.locator(`[data-parameter-target="${id}"]`);
const input = id => page.locator(`[data-variable-id="${id}"] input[data-parameter-id]`);
const search = () => page.getByRole('searchbox', { name: '按变量搜索步骤', exact: true });
const shownStepIds = () => page.locator('.execution-steps .step-card[data-step-id]').evaluateAll(nodes => nodes.map(node => node.dataset.stepId));
const run = async () => (await workspace()).instances.find(item => item.id === runId);
const expected = ['维护开始时间', '维护结束时间', '变更单号', '玩家转区.目标区服', '玩家转区.玩家ID', '玩家转区.核对目标.来源区服', '玩家转区2.目标区服', '未命名步骤组.环境', '未命名步骤组.未命名步骤.区服'];
async function assertUsage(stepId, parameterId) {
  await expect(page.locator(`[data-step-id="${stepId}"]`)).toHaveClass(/is-expanded/);
  await expect(page.locator('[data-variable-panel]')).toHaveAttribute('data-variable-target-step-id', stepId);
  await expect(input(parameterId)).toBeFocused();
  await expect.poll(() => input(parameterId).evaluate(input => {
    const r = input.getBoundingClientRect(), area = input.closest('.variable-panel-scroll').getBoundingClientRect();
    return r.top >= area.top - 1 && r.bottom <= area.bottom + 1;
  })).toBe(true);
  await expect.poll(() => page.locator('.workspace-scroll').evaluate((root, id) => {
    const card = [...root.querySelectorAll('[data-step-id]')].find(node => node.dataset.stepId === id);
    if (!card) return false;
    const r = root.getBoundingClientRect(), c = card.getBoundingClientRect();
    return c.top >= r.top - 1 && c.top + 45 <= r.bottom;
  }, stepId)).toBe(true);
}
function contrast(rgb, background) {
  const luminance = text => text.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  const a = luminance(rgb), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
async function snapshot(name) {
  const measurement = await tags().evaluate(node => ({ width: innerWidth, rootWidth: document.documentElement.scrollWidth, list: node.getBoundingClientRect().toJSON(), tags: [...node.querySelectorAll('button')].map(button => ({ label: button.textContent, kind: button.dataset.parameterKind, rect: button.getBoundingClientRect().toJSON(), color: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor })) }));
  assert.ok(measurement.rootWidth <= measurement.width + 1);
  for (const item of measurement.tags) { assert.ok(item.rect.left >= measurement.list.left - 1 && item.rect.right <= measurement.list.right + 1); assert.ok(contrast(item.color, item.background) >= 4.5); }
  assert.notEqual(measurement.tags[0].color, measurement.tags[3].color);
  geometry.push({ name, ...measurement }); await page.screenshot({ path: `${output}/${name}.png` });
}
try {
  await page.setViewportSize({ width: 1360, height: 940 });
  await apply({ type: 'create_template', id: templateId, name: 'QA 待填变量标签', document });
  await apply({ type: 'create_instance', id: runId, name: '维护填参', templateId, fromInstanceId: null });
  await page.reload(); await page.locator(`[data-instance-id="${runId}"]`).click();
  await expect(tags().getByRole('button')).toHaveText(expected);
  await expect(tag('unused')).toHaveCount(0);
  await expect(tags().locator('small,svg')).toHaveCount(0);
  await expect(tags()).not.toContainText('定位');
  for (const id of ['start', 'end', 'global-late']) await expect(tag(id)).toHaveAttribute('data-parameter-kind', 'global');
  for (const id of ['target-a', 'player', 'source', 'target-b', 'group-empty', 'step-empty']) await expect(tag(id)).toHaveAttribute('data-parameter-kind', 'local');
  const original = await workspace();
  for (const size of [{ width: 1360, height: 940 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(size);
    for (const theme of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-switcher').click();
      await snapshot(`${theme}-${size.width}`);
    }
  }
  assert.deepEqual(await workspace(), original);
  checks.push('Only referenced missing variables appear as one list tag each, with group/step namespaces, empty-name fallbacks and no locator text, small scope labels or arrows; both themes and viewport widths keep tags inside the list at >=4.5:1 contrast');
  await page.setViewportSize({ width: 1360, height: 940 });
  await page.locator('[data-variable-panel]').getByRole('searchbox').fill('NO_MATCH');
  await page.locator('[data-variable-panel]').getByRole('button', { name: '收起变量面板' }).click();
  await tag('target-b').focus(); await tag('target-b').press('Enter'); await expect(input('target-b')).toBeFocused();
  await assertUsage('step-b', 'target-b');
  await expect(search()).toHaveValue('玩家转区2.目标区服');
  assert.deepEqual(await shownStepIds(), ['step-b']);
  await expect(page.locator('[data-variable-panel]').getByRole('searchbox')).toHaveValue('');
  assert.deepEqual(await workspace(), original);
  await tag('target-a').click(); await expect(input('target-a')).toBeFocused();
  await assertUsage('step-a', 'target-a');
  await expect(page.locator('[data-step-id="intro-a"]')).toHaveCount(0);
  assert.deepEqual(await shownStepIds(), ['step-a']);
  await tag('source').click(); await assertUsage('step-a', 'source');
  await tag('global-late').click(); await assertUsage('step-b', 'global-late');
  await tag('global-late').focus(); await tag('global-late').press('Space'); await assertUsage('step-b', 'global-late');
  assert.deepEqual(await shownStepIds(), ['step-b', 'empty-step']);
  await expect(page.locator('[data-step-id="empty-step"]')).toHaveClass(/is-expanded/);
  await expect(page.locator('[data-step-id="step-b"] .step-status-icon')).toHaveText('23');
  await expect(page.getByRole('search', { name: '变量引用步骤' }).getByRole('status')).toHaveText(`2 / ${document.steps.length} 步`);
  await page.screenshot({ path: `${output}/usage-wide.png` });
  await page.setViewportSize({ width: 940, height: 640 });
  await tag('target-a').click(); await assertUsage('step-a', 'target-a');
  await page.screenshot({ path: `${output}/usage-narrow.png` });
  await page.setViewportSize({ width: 1360, height: 940 });
  assert.deepEqual(await workspace(), original);
  checks.push('Mouse/Enter/Space and repeated tags enter an exact variable search, show every title/description/command reference in original order and numbering, hide unrelated group members, expand all matches, and retain right input focus in wide/narrow layouts without data writes');
  await search().fill('目标区服');
  await expect.poll(shownStepIds).toEqual(['step-a', 'step-b']);
  await expect(search()).toBeFocused();
  await search().fill('玩家转区.目标区服');
  await expect.poll(shownStepIds).toEqual(['step-a']);
  await search().fill('NO_MATCH');
  await expect(page.getByText('没有匹配的变量引用步骤', { exact: true })).toBeVisible();
  assert.deepEqual(await shownStepIds(), []);
  await search().press('Escape');
  await expect(search()).toHaveValue('');
  await expect.poll(async () => (await shownStepIds()).length).toBe(document.steps.length);
  assert.deepEqual(await workspace(), original);
  checks.push('Typed variable/namespace searches find all matching identities, empty results are explicit, and Escape restores the whole process without editing native data');
  const long = structuredClone((await run()).document);
  long.groups.find(group => group.id === 'player-b').name = '玩家转区长命名空间'.repeat(16);
  await apply({ type: 'save_instance', id: runId, name: '维护填参', document: long });
  await page.reload(); await page.locator(`[data-instance-id="${runId}"]`).click();
  await page.setViewportSize({ width: 940, height: 640 });
  await expect(tag('target-b')).toHaveText(`${long.groups[1].name}.目标区服`);
  await snapshot('long-namespace-940');
  await tag('step-empty').click(); await expect(input('step-empty')).toBeFocused();
  await assertUsage('empty-step', 'step-empty');
  checks.push('Very long namespaces wrap within narrow content and unnamed group/step labels remain clickable');
  const beforeFill = await run();
  await page.setViewportSize({ width: 1360, height: 940 });
  for (const [id, value] of [['start', '2026-10-21-08-00'], ['end', '2026-10-21-09-00'], ['global-late', 'OPS-1021'], ['target-a', '9001002'], ['player', '9002001'], ['source', '9001001'], ['target-b', '9001003'], ['group-empty', 'sandboxa'], ['step-empty', '201']]) {
    await tag(id).click(); await expect(input(id)).toBeFocused(); await input(id).fill(value); await expect(tag(id)).toHaveCount(0);
  }
  assert.deepEqual(await run(), beforeFill);
  await expect(tags()).toHaveCount(0);
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect.poll(async () => (await run()).status).toBe('in_progress');
  let saved = await run(); assert.equal(saved.currentStepId, 'first'); assert.equal(saved.entries.length, 0); assert.equal(saved.parameterValues['target-a'], '9001002');
  await apply({ type: 'record_result', id: runId, outcome: 'completed', reason: null });
  await page.reload(); await page.locator(`[data-instance-id="${runId}"]`).click();
  const history = await run();
  await search().fill('维护开始时间');
  await expect.poll(shownStepIds).toEqual(['first']);
  await expect(page.locator('[data-step-id="first"] [data-inline-field="操作说明"]')).toHaveClass(/is-readonly/);
  assert.deepEqual(await run(), history);
  await search().press('Escape');
  saved = await run();
  checks.push('Searching an advanced step keeps its frozen snapshot and results unchanged, and the execution cursor stays on the next actual step');
  const beforeAppend = structuredClone(saved), extended = structuredClone(saved.document);
  extended.groups.push({ id: 'future', name: '更新外服' });
  extended.parameters.push(parameter('future-env', '环境', 'future'));
  extended.steps.push({ id: 'future-intro', groupId: 'future', title: ['外服更新须知'], description: ['不使用变量的首个步骤'], commands: [] }, { id: 'future-step', groupId: 'future', title: ['更新外服'], description: [ref('future-env')], commands: [] });
  await apply({ type: 'save_instance', id: runId, name: saved.name, document: extended });
  await page.reload(); await page.locator(`[data-instance-id="${runId}"]`).click();
  await expect(tags().getByRole('button')).toHaveText(['更新外服.环境']);
  const applyAll = page.getByRole('button', { name: '应用全部参数', exact: true }); await expect(applyAll).toBeDisabled();
  await tag('future-env').click(); await assertUsage('future-step', 'future-env');
  assert.deepEqual(await shownStepIds(), ['future-step']);
  await page.screenshot({ path: `${output}/runtime-usage.png` });
  await input('future-env').fill('sandboxb');
  await expect(tags()).toHaveCount(0); await expect(applyAll).toBeEnabled();
  assert.equal((await run()).parameterValues['future-env'], '');
  await search().fill('NO_MATCH');
  await search().press('Escape');
  await page.locator('[data-nav-step-id="future-step"]').click();
  await expect(input('future-env')).toHaveValue('sandboxb');
  await applyAll.click(); await expect.poll(async () => (await run()).parameterValues['future-env']).toBe('sandboxb');
  saved = await run(); assert.equal(saved.currentStepId, beforeAppend.currentStepId); assert.deepEqual(saved.entries, beforeAppend.entries);
  assert.deepEqual(errors, []);
  checks.push('Filling tags only updates drafts until Start; runtime missing tags share the same presentation and remain unapplied until Apply All, without advancing or rewriting records');
  await writeFile(`${output}/report.json`, JSON.stringify({ ok: true, directory, checks, geometry, errors, clipboardTouched: false, maintenanceCommandsExecuted: false }, null, 2));
  console.log(JSON.stringify({ ok: true, directory, checks, errors }));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await writeFile(`${output}/failure.json`, JSON.stringify({ directory, error: String(error), checks, errors }, null, 2)); throw error;
} finally { await browser.close(); }
