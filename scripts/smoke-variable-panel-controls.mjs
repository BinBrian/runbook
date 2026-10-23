// node scripts/check-desktop.mjs scripts/smoke-variable-panel-controls.mjs
// All fixture data belongs to the harness. No system clipboard or command runs.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && process.env.RUNBOOK_DATA_DIR === directory && process.env.RUNBOOK_CDP_URL);
const actual = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actual}`));
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const checks = [], geometryChecks = [], searchChecks = [], pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action });
const workspace = () => native('checklist_load');
const templateId = 'qa-variable-controls-template', runId = 'qa-variable-controls-run';
const template = async () => (await workspace()).templates.find(item => item.id === templateId);
const run = async () => (await workspace()).instances.find(item => item.id === runId);
const panel = () => page.getByRole('complementary', { name: '变量面板', exact: true });
const scope = owner => panel().locator(`[data-parameter-scope="${owner ?? 'global'}"]`);
const row = id => panel().locator(`[data-variable-id="${id}"]`);
const value = id => panel().locator(`input[data-parameter-id="${id}"]`);
const searchInput = () => panel().getByLabel('搜索变量', { exact: true });
const step = id => page.locator(`[data-step-id="${id}"]`);
const ownerOf = parameter => parameter.ownerId ?? 'global';
const ref = parameterId => ({ parameterId });
const definitionDescription = Array.from({ length: 24 }, (_, index) => `全局定义说明 ${index + 1}：本次填写值与默认值分别保存。`).join('\n');
const defaultGlobal = 'GLOBAL-DEFAULT', defaultA = 'PLAYER-A-DEFAULT', defaultB = 'PLAYER-B-DEFAULT', firstStepValue = 'STEP-A-FILLED';
const initialDocument = { parameters: [], groups: [{ id: 'controls-group-a', name: '玩家 A' }, { id: 'controls-group-b', name: '玩家 B' }],
  steps: ['controls-a-first', 'controls-a-second', 'controls-b-first', 'controls-b-second'].map((id, index) => ({ id, groupId: index < 2 ? 'controls-group-a' : 'controls-group-b', title: [`${index < 2 ? 'A' : 'B'} 核验 ${index % 2 + 1}`], description: ['人工核验并记录，不运行命令。'], commands: [{ id: `${id}-command`, text: ['echo placeholder'] }] })) };
const addLabels = { global: '新增全局变量', group: '新增步骤组变量', step: '新增步骤变量' };
async function saved(predicate) { await expect.poll(predicate).toBe(true); await expect(page.locator('.save-state')).toContainText('已保存在本机'); }
async function reload() { await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor(); }
async function noBodyParameters() { await expect(page.locator('.workspace-scroll [data-parameter-scope], .workspace-scroll .parameter-definitions, .workspace-scroll .instance-parameters')).toHaveCount(0); }
async function openTemplate() {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '模板' }).click();
  await page.locator(`[data-template-id="${templateId}"] .tile-open`).click(); await noBodyParameters();
}
async function locate(id) {
  await page.locator(`[data-nav-step-id="${id}"]`).click();
  await expect(panel()).toHaveAttribute('data-variable-target-step-id', id);
}
async function openInstance() {
  await reload(); await page.locator(`[data-instance-id="${runId}"]`).click();
  await expect(page.locator('[data-inline-field="实例名称"]')).toBeVisible(); await noBodyParameters();
}
async function form(kind = '新增变量') { const dialog = panel().getByRole('dialog', { name: kind, exact: true }); await expect(dialog).toBeVisible(); return dialog; }
async function fillDefinition(dialog, { name, description = '', defaultValue = '' }) {
  await dialog.getByRole('textbox', { name: '变量名称', exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: '变量说明', exact: true }).fill(description);
  await dialog.getByRole('textbox', { name: '变量默认值', exact: true }).fill(defaultValue);
}
async function createDefinition(kind, owner, fields) {
  const before = (await template()).document.parameters;
  await panel().locator(`[data-variable-scope="${kind}"]`).getByRole('button', { name: addLabels[kind], exact: true }).click();
  const dialog = await form(); await fillDefinition(dialog, fields);
  await dialog.getByRole('button', { name: '保存变量', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await saved(async () => (await template()).document.parameters.length === before.length + 1);
  const created = (await template()).document.parameters.find(item => !before.some(old => old.id === item.id));
  assert.equal(ownerOf(created), owner ?? 'global'); assert.equal(created.name, fields.name); assert.equal(created.defaultValue, fields.defaultValue ?? '');
  return created;
}
async function editDefinition(parameter, fields, item = template) {
  await row(parameter.id).getByRole('button', { name: `编辑变量 ${parameter.name}`, exact: true }).click();
  const dialog = await form('编辑变量定义'); await fillDefinition(dialog, fields);
  await dialog.getByRole('button', { name: '保存变量', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await saved(async () => { const current = (await item()).document.parameters.find(value => value.id === parameter.id); return current?.name === fields.name && current.description === fields.description && current.defaultValue === fields.defaultValue; });
  return (await item()).document.parameters.find(value => value.id === parameter.id);
}
async function deleteUnused(parameter, item = template) {
  await row(parameter.id).getByRole('button', { name: `删除变量 ${parameter.name}`, exact: true }).click();
  await expect.poll(async () => (await item()).document.parameters.some(value => value.id === parameter.id)).toBe(false);
  await expect(row(parameter.id)).toHaveCount(0);
}
async function assertLocked(parameter, referenced = false) {
  const edit = row(parameter.id).getByRole('button', { name: `编辑变量 ${parameter.name}`, exact: true });
  const remove = row(parameter.id).getByRole('button', { name: `删除变量 ${parameter.name}`, exact: true });
  if (!referenced) { await expect(edit).toBeDisabled(); assert.ok(await edit.getAttribute('title')); }
  await expect(remove).toBeDisabled(); assert.ok(await remove.getAttribute('title'));
}
async function readonlyPanel() {
  for (const input of await panel().locator('input[data-parameter-id]').all()) await expect(input).not.toBeEditable();
  for (const button of await panel().getByRole('button', { name: /^(新增全局变量|新增步骤组变量|新增步骤变量|编辑变量 |删除变量 |复用变量 )/ }).all()) await expect(button).toBeDisabled();
}
async function assertSearchRows(query, expected) {
  await expect(searchInput()).toHaveValue(query);
  const rows = panel().locator('[data-variable-id]');
  await expect(rows).toHaveCount(expected.length);
  assert.deepEqual((await rows.evaluateAll(elements => elements.map(element => element.dataset.variableId))).sort(), [...expected].sort());
  const document = (await run())?.document ?? (await template()).document;
  for (const key of ['global', 'group', 'step']) {
    const section = panel().locator(`[data-variable-scope="${key}"]`);
    await expect(section.locator('h3')).toBeVisible();
    const owner = await section.getAttribute('data-parameter-scope');
    const parameters = document.parameters.filter(parameter => ownerOf(parameter) === owner);
    const matches = parameters.filter(parameter => expected.includes(parameter.id)).length;
    await expect(section.locator('[data-variable-match-count]')).toHaveText(query.trim() ? `${matches} / ${parameters.length}` : String(parameters.length));
    await expect(section.locator('[data-variable-empty-search]')).toHaveCount(query.trim() && matches === 0 ? 1 : 0);
  }
  if (query.trim()) await expect(panel().locator('[data-variable-search-count]')).toHaveText(expected.length ? `找到 ${expected.length} 个变量` : '未找到匹配变量');
  else await expect(panel().locator('[data-variable-search-count]')).toHaveCount(0);
  searchChecks.push({ query, expectedIds: expected });
}
async function searchFor(query, expected) { await searchInput().fill(query); await assertSearchRows(query, expected); }
async function record(outcome) {
  const current = await run();
  if (outcome === 'failed') {
    await step(current.currentStepId).getByRole('button', { name: '记录失败', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '记录失败', exact: true });
    await expect(dialog.getByRole('button', { name: '保存失败记录', exact: true })).toBeDisabled();
    await dialog.getByRole('textbox', { name: '失败原因', exact: true }).fill('QA 外部核验失败，只记录结果。');
    await dialog.getByRole('button', { name: '保存失败记录', exact: true }).click();
  } else await step(current.currentStepId).getByRole('button', { name: current.currentStepId === 'controls-b-second' ? '完成并结束' : '完成并下一步', exact: true }).click();
  await expect.poll(async () => (await run()).entries.filter(item => item.type === 'result').length).toBe(current.entries.filter(item => item.type === 'result').length + 1);
}
async function geometry(label) {
  const metrics = await panel().evaluate(element => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }; };
    return { viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, documentWidth: document.documentElement.scrollWidth }, panel: rect(element), internal: rect(element.querySelector('.variable-panel-scroll')), workspace: rect(document.querySelector('.workspace-scroll')),
      inputs: [...element.querySelectorAll('input[data-parameter-id]')].map(node => ({ id: node.dataset.parameterId, ...rect(node) })) };
  });
  await writeFile(`.artifacts/variable-controls-${label}-geometry.json`, JSON.stringify(metrics, null, 2), 'utf8');
  await page.screenshot({ path: `.artifacts/variable-controls-${label}.png` });
  assert.equal(metrics.viewport.scrollX, 0); assert.equal(metrics.viewport.scrollY, 0);
  assert.ok(metrics.panel.left >= 0 && metrics.panel.top >= 0 && metrics.panel.right <= metrics.viewport.width + 1 && metrics.panel.bottom <= metrics.viewport.height + 1);
  assert.ok(metrics.internal.scrollHeight > metrics.internal.clientHeight, 'The long variable definitions must scroll within the fixed panel');
  for (const input of metrics.inputs) assert.ok(input.left >= metrics.panel.left && input.right <= metrics.panel.right, 'Parameter inputs must fit the fixed panel horizontally');
  assert.ok(metrics.panel.scrollWidth <= metrics.panel.clientWidth + 1 && metrics.internal.scrollWidth <= metrics.internal.clientWidth + 1);
  assert.ok(metrics.workspace.scrollWidth <= metrics.workspace.clientWidth + 1 && metrics.viewport.documentWidth <= metrics.viewport.width + 1);
  geometryChecks.push({ label, width: metrics.viewport.width, height: metrics.viewport.height });
}

try {
  await mkdir('.artifacts', { recursive: true }); await page.setViewportSize({ width: 1360, height: 940 });
  await apply({ type: 'create_template', id: templateId, name: 'QA 右侧定义与本次填参', document: initialDocument });
  await reload(); await openTemplate(); await locate('controls-a-first');
  const beforeEmptyName = await workspace();
  await panel().getByRole('button', { name: '新增全局变量', exact: true }).click();
  let dialog = await form(); await dialog.getByRole('textbox', { name: '变量名称', exact: true }).fill('   ');
  await expect(dialog.getByRole('button', { name: '保存变量', exact: true })).toBeDisabled();
  assert.deepEqual(await workspace(), beforeEmptyName);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  let global = await createDefinition('global', null, { name: '环境', description: '初始全局定义。', defaultValue: 'GLOBAL-OLD' });
  const duplicate = await createDefinition('global', null, { name: '环境', description: '同名但按 ID 隔离且未引用。', defaultValue: 'UNUSED-DEFAULT' });
  assert.notEqual(global.id, duplicate.id);
  const localA = await createDefinition('group', 'controls-group-a', { name: '玩家 ID', description: '玩家 A 独立身份。', defaultValue: defaultA });
  let localStep = await createDefinition('step', 'controls-a-first', { name: '备注', description: '必填，仅本步骤。', defaultValue: '' });
  await locate('controls-b-first');
  const localB = await createDefinition('group', 'controls-group-b', { name: '玩家 ID', description: '玩家 B 独立身份。', defaultValue: defaultB });
  const localStepB = await createDefinition('step', 'controls-b-first', { name: '备注', description: 'B 步骤的独立必填值。', defaultValue: '' });
  assert.notEqual(localA.id, localB.id); await expect(row(localA.id)).toHaveCount(0);
  await locate('controls-a-first');
  const beforeCaptured = (await template()).document.parameters;
  await panel().getByRole('button', { name: '新增步骤组变量', exact: true }).click();
  dialog = await form(); await fillDefinition(dialog, { name: '捕获所有者', description: '切换组后仍保存到原组。', defaultValue: 'CAPTURED-A' });
  await locate('controls-b-first'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '保存变量', exact: true }).click();
  await saved(async () => (await template()).document.parameters.length === beforeCaptured.length + 1);
  const captured = (await template()).document.parameters.find(item => !beforeCaptured.some(old => old.id === item.id));
  assert.equal(captured.ownerId, 'controls-group-a'); await expect(row(captured.id)).toHaveCount(0);
  await locate('controls-a-first'); await deleteUnused(captured);
  checks.push('The right panel creates global/group/step definitions, rejects blank names, preserves distinct IDs for same-scope and cross-group duplicate names, and a draft form retains its captured owner when browsing another group; unused definitions can be removed');

  const linked = structuredClone((await template()).document);
  for (const current of linked.steps) {
    const local = current.groupId === 'controls-group-a' ? localA : localB;
    current.commands[0].text = ['echo ', ref(global.id), '|', ref(local.id), ...(current.id === 'controls-a-first' ? ['|', ref(localStep.id), '\n', ...Array.from({ length: 85 }, (_, index) => `# QA inert long line ${index + 1}\n`)] : current.id === 'controls-b-first' ? ['|', ref(localStepB.id)] : [])];
  }
  await apply({ type: 'save_template', id: templateId, name: (await template()).name, document: linked });
  await reload(); await openTemplate(); await locate('controls-a-first');
  const beforeRenameSteps = structuredClone((await template()).document.steps);
  global = await editDefinition(global, { name: '部署环境', description: definitionDescription, defaultValue: defaultGlobal });
  assert.deepEqual((await template()).document.steps, beforeRenameSteps);
  assert.equal((await template()).document.parameters.find(item => item.id === duplicate.id).defaultValue, 'UNUSED-DEFAULT');
  assert.equal((await template()).document.parameters.find(item => item.id === localB.id).defaultValue, defaultB);
  await assertLocked(global, true); await assertLocked(localA, true); await assertLocked(localStep, true);
  const beforeTemplateSearch = await workspace(), visibleA = [global.id, duplicate.id, localA.id, localStep.id], visibleB = [global.id, duplicate.id, localB.id, localStepB.id];
  await searchFor('部署环境', [global.id]);
  await searchFor('玩家 A 独立身份', [localA.id]);
  await searchFor('  global-default  ', [global.id]);
  await searchFor('玩家 ID', [localA.id]);
  await searchFor(defaultB, []); await expect(row(localB.id)).toHaveCount(0);
  await locate('controls-b-first'); await assertSearchRows(defaultB, [localB.id]);
  await searchFor('玩家 ID', [localB.id]); await expect(row(localA.id)).toHaveCount(0);
  await searchFor('QA-NO-MATCH-SEARCH', []);
  await page.screenshot({ path: '.artifacts/variable-controls-search-empty.png' });
  await panel().getByRole('button', { name: '清空变量搜索', exact: true }).click(); await assertSearchRows('', visibleB);
  await searchFor('QA-NO-MATCH-ESCAPE', []); await searchInput().press('Escape'); await assertSearchRows('', visibleB);
  await searchFor('   ', visibleB); await searchInput().press('Escape');
  await locate('controls-a-first'); await assertSearchRows('', visibleA);
  assert.deepEqual(await workspace(), beforeTemplateSearch);
  checks.push('Search trims whitespace and ignores case while matching visible names, descriptions and template defaults; three scope headers retain exact match/total counts, another group cannot leak into results, zero-result feedback and clear/Escape work, and searching/switching groups does not write native data');
  const beforeLongView = await workspace();
  for (const viewport of [{ width: 1360, height: 940 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(viewport); await locate('controls-a-first');
    await page.locator('.workspace-scroll').evaluate(element => element.scrollTop += 320);
    await geometry(`template-${viewport.width}`); await noBodyParameters();
  }
  assert.deepEqual(await workspace(), beforeLongView);
  checks.push('Renaming a referenced definition and changing its description/default preserve every reference ID and unrelated same-name defaults; referenced deletion is disabled with a reason; long content and controls stay within the fixed panel at both viewport sizes without duplicate body parameter regions');

  await page.setViewportSize({ width: 1360, height: 940 });
  const sourceTemplate = await template();
  await apply({ type: 'create_instance', id: runId, name: 'QA 面板实例值与历史', templateId, fromInstanceId: null });
  await openInstance(); await locate('controls-a-first');
  await expect(value(global.id)).toHaveValue(defaultGlobal); await expect(value(localA.id)).toHaveValue(defaultA);
  await value(localStep.id).fill(firstStepValue);
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeDisabled();
  await page.locator('.workspace-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await searchFor('QA-MISSING-TARGET-HIDDEN', []);
  await panel().getByRole('button', { name: '收起变量面板', exact: true }).click();
  const beforeMissing = await run(), scrollBefore = await page.locator('.workspace-scroll').evaluate(element => element.scrollTop);
  await page.locator(`[data-parameter-target="${localStepB.id}"]`).first().click();
  await expect(panel()).toHaveClass(/is-open/); await expect(panel()).toHaveAttribute('data-variable-target-step-id', 'controls-b-first');
  await expect(searchInput()).toHaveValue('');
  await expect(value(localStepB.id)).toBeFocused();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(Math.abs(await page.locator('.workspace-scroll').evaluate(element => element.scrollTop) - scrollBefore) <= 1, 'Missing-parameter focus must only scroll the panel, never the document');
  assert.deepEqual(await run(), beforeMissing);
  await expect(value(global.id)).toHaveValue(defaultGlobal); await expect(value(localB.id)).toHaveValue(defaultB);
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeDisabled();
  await value(localStepB.id).pressSequentially('B');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(panel()).toHaveAttribute('data-variable-target-step-id', 'controls-b-first');
  await expect(value(localStepB.id)).toBeFocused(); await expect(value(localStepB.id)).toHaveValue('B');
  await expect(page.locator(`[data-parameter-target="${localStepB.id}"]`)).toHaveCount(0);
  await value(localStepB.id).pressSequentially('-FILLED');
  await expect(value(localStepB.id)).toBeFocused(); await expect(value(localStepB.id)).toHaveValue('B-FILLED');
  await expect(panel()).toHaveAttribute('data-variable-target-step-id', 'controls-b-first');
  assert.ok(Math.abs(await page.locator('.workspace-scroll').evaluate(element => element.scrollTop) - scrollBefore) <= 1, 'Removing missing links while typing must not scroll the document or switch the panel owner');
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeEnabled();
  assert.deepEqual(await run(), beforeMissing);
  await locate('controls-a-first'); await expect(value(localStep.id)).toHaveValue(firstStepValue);
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect(step('controls-a-first')).toHaveClass(/is-current/); await locate('controls-a-first');
  assert.equal((await run()).parameterValues[localStep.id], firstStepValue);
  localStep = await editDefinition(localStep, { name: localStep.name, description: localStep.description, defaultValue: 'STEP-DEFAULT-LATER' }, run);
  assert.equal((await run()).parameterValues[localStep.id], firstStepValue);
  assert.deepEqual(await template(), sourceTemplate);
  const beforeValueLayout = await run();
  for (const viewport of [{ width: 1360, height: 940 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(viewport); await locate('controls-a-first'); await geometry(`instance-${viewport.width}`);
  }
  assert.deepEqual(await run(), beforeValueLayout); await page.setViewportSize({ width: 1360, height: 940 }); await locate('controls-a-first');
  checks.push('Missing-parameter navigation opens the collapsed panel, selects the right owner and focuses its input without moving document scroll or writing data; defaults prefill, required current values are applied together only on start, and changing an instance default never replaces its current value or source template');

  const beforeSearchValues = await run();
  await searchFor(defaultGlobal.toLowerCase(), [global.id]);
  await searchFor('STEP-DEFAULT-LATER', []);
  await searchFor('', visibleA);
  await value(global.id).fill('GLOBAL-SEARCH-DRAFT'); await value(duplicate.id).fill('DUPLICATE-SEARCH-DRAFT');
  await value(localA.id).fill('GROUP-SEARCH-DRAFT'); await value(localStep.id).fill('STEP-SEARCH-DRAFT');
  await searchFor('  global-search-draft  ', [global.id]);
  await expect(row(global.id).locator('[data-variable-value]')).toHaveText(defaultGlobal);
  await searchFor(defaultGlobal, [global.id]);
  await searchFor('QA-NO-MATCH-WITH-DRAFTS', []); assert.deepEqual(await run(), beforeSearchValues);
  await searchFor('', visibleA);
  await expect(value(global.id)).toHaveValue('GLOBAL-SEARCH-DRAFT'); await expect(value(duplicate.id)).toHaveValue('DUPLICATE-SEARCH-DRAFT');
  await expect(value(localA.id)).toHaveValue('GROUP-SEARCH-DRAFT'); await expect(value(localStep.id)).toHaveValue('STEP-SEARCH-DRAFT');
  await searchFor('部署环境', [global.id]);
  await scope('global').getByRole('button', { name: '应用全局参数', exact: true }).click();
  await expect.poll(async () => (await run()).parameterValues[global.id]).toBe('GLOBAL-SEARCH-DRAFT');
  assert.equal((await run()).parameterValues[duplicate.id], 'DUPLICATE-SEARCH-DRAFT', 'Filtered application must include hidden variables in the same scope');
  await page.screenshot({ path: '.artifacts/variable-controls-search-applied.png' });
  await searchFor('', visibleA);
  await expect(value(localA.id)).toHaveValue('GROUP-SEARCH-DRAFT'); await expect(value(localStep.id)).toHaveValue('STEP-SEARCH-DRAFT');
  await value(global.id).fill('DISCARDED-VISIBLE'); await value(duplicate.id).fill('DISCARDED-HIDDEN');
  await searchFor('部署环境', [global.id]); const beforeFilteredCancel = await run();
  await scope('global').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await searchFor('', visibleA);
  await expect(value(global.id)).toHaveValue('GLOBAL-SEARCH-DRAFT'); await expect(value(duplicate.id)).toHaveValue('DUPLICATE-SEARCH-DRAFT');
  await expect(value(localA.id)).toHaveValue('GROUP-SEARCH-DRAFT'); await expect(value(localStep.id)).toHaveValue('STEP-SEARCH-DRAFT');
  assert.deepEqual(await run(), beforeFilteredCancel);
  await searchFor('QA-ZERO-RESULT-SCOPE-CANCEL', []);
  await scope('controls-group-a').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await scope('controls-a-first').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await searchFor('', visibleA);
  await expect(value(localA.id)).toHaveValue(defaultA); await expect(value(localStep.id)).toHaveValue(firstStepValue);
  await value(global.id).fill(defaultGlobal); await value(duplicate.id).fill('UNUSED-DEFAULT');
  await searchFor('部署环境', [global.id]); await scope('global').getByRole('button', { name: '应用全局参数', exact: true }).click();
  await expect.poll(async () => (await run()).parameterValues[global.id]).toBe(defaultGlobal);
  await searchFor('', visibleA);
  const afterSearchValues = await run();
  assert.deepEqual(afterSearchValues.parameterValues, beforeSearchValues.parameterValues);
  assert.deepEqual(afterSearchValues.document, beforeSearchValues.document); assert.deepEqual(afterSearchValues.entries, beforeSearchValues.entries);
  assert.equal(afterSearchValues.currentStepId, beforeSearchValues.currentStepId); assert.equal(afterSearchValues.status, beforeSearchValues.status);
  checks.push('Instance search matches applied and draft values without applying drafts; filtering retains every scope draft, filtered apply/cancel includes hidden variables in the complete scope, zero-result scope cancellation still works, and only explicit application changes stored values while documents, history and execution position remain exact');

  await value(duplicate.id).fill('UNUSED-PENDING'); await value(localA.id).fill('GROUP-DRAFT-TO-KEEP');
  await deleteUnused(duplicate, run);
  await expect(value(localA.id)).toHaveValue('GROUP-DRAFT-TO-KEEP');
  assert.ok(!Object.hasOwn((await run()).parameterValues, duplicate.id));
  await scope('controls-group-a').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await expect(value(localA.id)).toHaveValue(defaultA); await expect(page.locator('.save-state')).toContainText('已保存在本机');
  await record('failed');
  const failedInstance = await run(), failed = failedInstance.entries.find(item => item.type === 'result');
  assert.equal(failed.outcome, 'failed'); assert.equal(failedInstance.currentStepId, 'controls-a-first');
  assert.equal(failed.snapshot.parameterValues[global.id], defaultGlobal); assert.equal(failed.snapshot.parameterValues[localA.id], defaultA); assert.equal(failed.snapshot.parameterValues[localStep.id], firstStepValue);
  await value(global.id).fill('GLOBAL-DRAFT'); await value(localA.id).fill('PLAYER-A-APPLIED'); await value(localStep.id).fill('STEP-A-APPLIED');
  assert.deepEqual(await run(), failedInstance);
  await scope('controls-group-a').getByRole('button', { name: '应用本组参数', exact: true }).click();
  await expect.poll(async () => (await run()).parameterValues[localA.id]).toBe('PLAYER-A-APPLIED');
  await expect(value(global.id)).toHaveValue('GLOBAL-DRAFT'); await expect(value(localStep.id)).toHaveValue('STEP-A-APPLIED');
  assert.equal((await run()).parameterValues[global.id], defaultGlobal); assert.equal((await run()).parameterValues[localStep.id], firstStepValue);
  await scope('global').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await expect(value(global.id)).toHaveValue(defaultGlobal); await expect(value(localStep.id)).toHaveValue('STEP-A-APPLIED');
  await scope('controls-a-first').getByRole('button', { name: '应用本步骤参数', exact: true }).click();
  await expect.poll(async () => (await run()).parameterValues[localStep.id]).toBe('STEP-A-APPLIED');
  await value(global.id).fill('GLOBAL-APPLIED'); await value(localA.id).fill('GROUP-TO-CANCEL');
  await scope('global').getByRole('button', { name: '应用全局参数', exact: true }).click();
  await expect.poll(async () => (await run()).parameterValues[global.id]).toBe('GLOBAL-APPLIED');
  await expect(value(localA.id)).toHaveValue('GROUP-TO-CANCEL'); assert.equal((await run()).parameterValues[localA.id], 'PLAYER-A-APPLIED');
  await scope('controls-group-a').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await expect(value(localA.id)).toHaveValue('PLAYER-A-APPLIED');
  assert.deepEqual((await run()).entries, failedInstance.entries); assert.equal((await run()).currentStepId, 'controls-a-first');
  assert.equal((await run()).document.parameters.find(item => item.id === global.id).defaultValue, defaultGlobal);
  checks.push('Deleting an unused variable clears its pending value without losing another scope draft or leaving dirty state; group/step/global application and cancellation affect only their scope, preserve other drafts and leave failure snapshots, defaults and the execution cursor unchanged');

  await record('completed'); await locate('controls-a-second');
  await assertLocked(global); await assertLocked(localA);
  await expect(value(localA.id)).toBeEditable(); await value(localA.id).fill('PLAYER-A-LATER');
  await scope('controls-group-a').getByRole('button', { name: '应用本组参数', exact: true }).click();
  await expect.poll(async () => (await run()).parameterValues[localA.id]).toBe('PLAYER-A-LATER');
  const beforeHistory = await run(), completedFirst = beforeHistory.entries.filter(item => item.type === 'result' && item.stepId === 'controls-a-first').at(-1);
  assert.equal(completedFirst.snapshot.parameterValues[localA.id], 'PLAYER-A-APPLIED');
  await locate('controls-a-first'); await expect(panel()).toContainText('历史快照');
  await expect(row(global.id).locator('[data-variable-value]')).toHaveText('GLOBAL-APPLIED');
  await expect(row(localA.id).locator('[data-variable-value]')).toHaveText('PLAYER-A-APPLIED');
  await expect(row(localStep.id).locator('[data-variable-value]')).toHaveText('STEP-A-APPLIED');
  await readonlyPanel(); assert.deepEqual(await run(), beforeHistory);
  await searchFor('PLAYER-A-APPLIED', [localA.id]);
  await searchFor('PLAYER-A-LATER', []);
  await searchFor('STEP-DEFAULT-LATER', []);
  await searchFor('STEP-A-APPLIED', [localStep.id]);
  await searchInput().press('Escape'); await assertSearchRows('', [global.id, localA.id, localStep.id]);
  await readonlyPanel(); assert.deepEqual(await run(), beforeHistory);
  const old = step('controls-a-first').locator('.result-record.old');
  if (await old.getAttribute('open') === null) await old.locator(':scope > summary').click();
  const details = old.locator('.snapshot-details'); if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  await expect(old.locator('.snapshot-command pre')).toContainText(`echo ${defaultGlobal}|${defaultA}|${firstStepValue}`);
  assert.deepEqual((await run()).entries.find(item => item.id === failed.id), failed);
  await locate('controls-b-first'); await expect(value(localB.id)).toHaveValue(defaultB); await expect(row(localA.id)).toHaveCount(0);
  assert.deepEqual(await run(), beforeHistory); assert.deepEqual(await template(), sourceTemplate);
  await locate('controls-a-second'); await record('completed'); await record('completed'); await record('completed');
  const ended = await run(); assert.equal(ended.status, 'completed'); await locate('controls-b-second'); await readonlyPanel();
  assert.deepEqual(await run(), ended); assert.deepEqual(await template(), sourceTemplate);
  const blockId = 'qa-variable-controls-block';
  await apply({ type: 'create_block', id: blockId, name: 'QA 块仅局部变量', document: { parameters: [], groups: [{ id: 'controls-block-group', name: '独立局部块' }], steps: [{ id: 'controls-block-step', groupId: 'controls-block-group', title: ['局部步骤'], description: [''], commands: [] }] } });
  await reload(); await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '步骤块' }).click();
  await page.locator(`[data-block-id="${blockId}"] .tile-open`).click();
  await expect(panel().locator('[data-variable-scope="global"]')).toHaveCount(0);
  await expect(panel().getByRole('button', { name: '新增全局变量', exact: true })).toHaveCount(0);
  await expect(panel().getByRole('button', { name: '新增步骤组变量', exact: true })).toBeEnabled();
  await expect(panel().getByRole('button', { name: '新增步骤变量', exact: true })).toBeEnabled();
  assert.deepEqual(await run(), ended); assert.deepEqual(await template(), sourceTemplate);
  await noBodyParameters(); assert.deepEqual(pageErrors, []); await expect(page.getByRole('alert')).toHaveCount(0);
  checks.push('Partially advanced group definitions are locked while the remaining group value stays editable; completed steps show their exact applied snapshot, earlier failures retain their older command values, same-name B stays independent, ended instances expose only read-only controls, and reusable block management offers only local scopes without changing source definitions or results');
  checks.push('Missing-parameter focus clears a no-match search before reopening the collapsed panel; historical search matches only the displayed snapshot values and excludes later applied values and changed defaults without unlocking or changing history');
  const result = { ok: true, isolatedDataDirectory: actual, templateId, runId, checks, geometryChecks, searchChecks, pageErrors, clipboardTouched: false, systemClipboardVerified: false, maintenanceCommandsExecuted: false };
  await writeFile('.artifacts/variable-controls-check.json', JSON.stringify(result, null, 2), 'utf8'); console.log(JSON.stringify(result));
} catch (error) {
  const state = await page.evaluate(() => ({ panel: document.querySelector('[data-variable-panel]')?.outerHTML, scrollTop: document.querySelector('.workspace-scroll')?.scrollTop,
    focus: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), parameterId: document.activeElement?.getAttribute('data-parameter-id') },
    save: document.querySelector('.save-state')?.textContent, alerts: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent) })).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/variable-controls-failure.json', JSON.stringify({ error: String(error), checks, geometryChecks, searchChecks, pageErrors, state, workspace: await workspace().catch(() => null) }, null, 2), 'utf8').catch(() => {});
  await page.screenshot({ path: '.artifacts/variable-controls-failure.png' }).catch(() => {}); throw error;
} finally { await browser.close(); }
