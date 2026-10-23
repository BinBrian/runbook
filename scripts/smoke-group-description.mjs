// Run with check-desktop.mjs; all data and processes belong to the isolated harness.
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
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0], pageErrors = [], checks = [], geometryChecks = [];
page.setDefaultTimeout(15000);
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action });
const workspace = () => native('checklist_load');
const templateId = 'qa-group-description-template', runId = 'qa-group-description-run';
const template = async () => (await workspace()).templates.find(item => item.id === templateId);
const run = async () => (await workspace()).instances.find(item => item.id === runId);
const editingGroup = id => page.locator(`.editing-group[data-group-id="${id}"]`);
const executionGroup = id => page.locator(`.execution-group[data-group-id="${id}"]`);
const description = '目的：按玩家分组处理。\n前提：核对本组身份。\n注意：{{literal}} 只保留为文字，不执行命令。';
const instanceDescription = '本次实例的独立说明。\n完成第一步后冻结。';
async function reload() { await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor(); }
async function settings(id) {
  const source = executionGroup(id), heading = source.locator(':scope > .execution-group-heading');
  if (await heading.getAttribute('aria-expanded') === 'false') await heading.locator('.group-expand-toggle').first().click();
  return source;
}
async function inlineEditor(source, label) {
  const textbox = source.getByRole('textbox', { name: label, exact: true });
  if (!await textbox.count()) await source.locator(`[data-inline-field="${label}"]`).dblclick();
  await expect(textbox).toBeVisible();
  return textbox;
}
async function waitSaved(check) { await expect.poll(check).toBe(true); await expect(page.locator('.save-state')).toContainText('已保存在本机'); }
async function showGroupHeader(selector) {
  await page.evaluate(selector => { const root = document.querySelector('.workspace-scroll'), group = document.querySelector(selector); root.scrollTo({ top: group.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 12, behavior: 'instant' }); }, selector);
}
async function chooseGroupAction(id, name) {
  const action = ({ 复制当前步骤块: '复制步骤组', 插入步骤块: '组后插入步骤块' })[name] ?? name;
  const trigger = editingGroup(id).getByRole('button', { name: action === '组后插入步骤块' ? '步骤组新增' : '更多步骤组操作', exact: true });
  await trigger.focus();
  await trigger.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: action, exact: true }).click();
  await expect(menu).toHaveCount(0);
}
async function checkDescriptionGeometry(id, label, editing = false) {
  const source = await settings(id), field = source.locator('[data-inline-field="步骤组描述"]');
  await showGroupHeader(`.execution-group[data-group-id="${id}"]`);
  await field.hover();
  await field.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await source.evaluate(element => {
    const rect = node => {
      const bounds = node.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
    };
    const frame = element.querySelector(':scope > .execution-group-body > [data-group-description]');
    const description = frame.querySelector('[data-inline-field="步骤组描述"]'), editor = description.querySelector('textarea');
    const root = document.querySelector('.workspace-scroll');
    return { viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, documentWidth: document.documentElement.scrollWidth },
      group: rect(element), frame: rect(frame), description: rect(description), editor: editor ? rect(editor) : null, workspace: rect(root),
      displayClass: description.className, hovered: description.matches(':hover'),
      styles: { frameMargin: getComputedStyle(frame).margin, descriptionMargin: getComputedStyle(description).margin } };
  });
  await writeFile(`.artifacts/group-description-${label}-geometry.json`, JSON.stringify(geometry, null, 2), 'utf8');
  await page.screenshot({ path: `.artifacts/group-description-${label}.png` });
  assert.equal(geometry.viewport.scrollX, 0); assert.equal(geometry.viewport.scrollY, 0);
  assert.ok(geometry.hovered, 'The tested description must really be hovered');
  for (const [name, bounds] of [['frame', geometry.frame], ['description', geometry.description], ...(editing ? [['textarea', geometry.editor]] : [])]) {
    assert.ok(bounds?.width > 0 && bounds.height > 0, `${label}: ${name} must have a real rendered box`);
    assert.ok(bounds.left - geometry.group.left >= 15 && geometry.group.right - bounds.right >= 15,
      `${label}: ${name} must retain at least 15px of left/right space inside the group`);
    assert.ok(bounds.left >= geometry.frame.left - 1 && bounds.right <= geometry.frame.right + 1,
      `${label}: ${name} must not spill out of the description frame`);
    assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, `${label}: ${name} must not overflow horizontally`);
  }
  assert.equal(Boolean(geometry.editor), editing, `${label}: the expected display/editor state must be active`);
  assert.ok(geometry.group.scrollWidth <= geometry.group.clientWidth + 1, `${label}: the group must not overflow horizontally`);
  assert.ok(geometry.workspace.scrollWidth <= geometry.workspace.clientWidth + 1, `${label}: the document must not overflow horizontally`);
  assert.ok(geometry.viewport.documentWidth <= geometry.viewport.width + 1, `${label}: the page must not overflow horizontally`);
  geometryChecks.push({ label, width: geometry.viewport.width, height: geometry.viewport.height, editing });
}
try {
  await mkdir('.artifacts', { recursive: true });
  await page.setViewportSize({ width: 1360, height: 940 });
  const document = { parameters: [], groups: [{ id: 'group-main', name: '旧组仅有名称' }, { id: 'group-tail', name: '后续步骤块' }],
    steps: ['first', 'second', 'tail'].map((id, index) => ({ id, groupId: index < 2 ? 'group-main' : 'group-tail', title: [`子步骤 ${index + 1}`], description: ['人工确认，不执行命令。'], commands: [] })) };
  await apply({ type: 'create_template', id: templateId, name: '步骤块标题描述验证', document });
  await reload();
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '模板' }).click();
  await page.locator(`[data-template-id="${templateId}"] .tile-open`).click();
  await expect(editingGroup('group-main').locator('[data-inline-field="步骤组描述"]')).toHaveAttribute('data-inline-empty', 'true');
  assert.equal((await template()).document.groups[0].description ?? '', '');
  const nameEditor = await inlineEditor(editingGroup('group-main'), '步骤组名称');
  await nameEditor.fill('玩家转区 · 含子步骤的步骤块'); await nameEditor.press('Escape');
  const descriptionEditor = await inlineEditor(editingGroup('group-main'), '步骤组描述');
  await descriptionEditor.fill(description); await descriptionEditor.press('Control+Enter');
  await waitSaved(async () => (await template()).document.groups[0].description === description);
  await chooseGroupAction('group-main', '复制当前步骤块');
  await waitSaved(async () => (await template()).document.groups.length === 3);
  let saved = await template();
  const copied = saved.document.groups.find(group => !['group-main', 'group-tail'].includes(group.id));
  assert.equal(copied.description, description);
  await chooseGroupAction('group-main', '保存为步骤块');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '步骤块名称', exact: true }).fill('复用玩家步骤块');
  await dialog.getByRole('button', { name: '保存步骤块', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const block = (await workspace()).blocks.find(item => item.name === '复用玩家步骤块');
  assert.equal(block.document.groups[0].description, description);
  await chooseGroupAction('group-main', '插入步骤块');
  await page.getByRole('dialog').locator('.block-choice').filter({ hasText: block.name }).click();
  await waitSaved(async () => (await template()).document.groups.length === 4);
  saved = await template();
  const inserted = saved.document.groups.find(group => group.sourceBlockId === block.id);
  assert.equal(inserted.description, description);
  const changed = `${description}\n仅原位置补充。`;
  const changedEditor = await inlineEditor(editingGroup('group-main'), '步骤组描述');
  await changedEditor.fill(changed); await changedEditor.press('Control+Enter');
  await waitSaved(async () => (await template()).document.groups[0].description === changed);
  saved = await template();
  assert.equal(saved.document.groups.find(group => group.id === copied.id).description, description);
  assert.equal(saved.document.groups.find(group => group.id === inserted.id).description, description);
  assert.equal((await workspace()).blocks.find(item => item.id === block.id).document.groups[0].description, description);
  checks.push('Legacy groups without description open empty; title and multiline literal description auto-save; copying, saving reusable blocks and inserting retain independent descriptions');
  await showGroupHeader('.editing-group[data-group-id="group-main"]');
  await expect(editingGroup('group-main').locator('[data-inline-field="步骤组描述"]')).toBeInViewport();
  await page.screenshot({ path: '.artifacts/group-description-template.png' });

  await apply({ type: 'create_instance', id: runId, name: '步骤块实例说明', templateId, fromInstanceId: null });
  await reload();
  await page.locator(`[data-instance-id="${runId}"]`).click();
  await expect(executionGroup('group-main').locator('[data-inline-field="步骤组描述"]')).toHaveText(changed);
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  const controls = await settings('group-main');
  const instanceEditor = await inlineEditor(controls, '步骤组描述');
  await instanceEditor.fill(instanceDescription); await instanceEditor.press('Control+Enter');
  await waitSaved(async () => (await run()).document.groups[0].description === instanceDescription);
  assert.equal((await template()).document.groups[0].description, changed);
  await page.locator('[data-step-id="first"]').getByRole('button', { name: '完成并下一步', exact: true }).click();
  await expect(page.locator('[data-step-id="second"]')).toHaveClass(/is-current/);
  const frozen = await settings('group-main');
  await expect(frozen.locator('[data-inline-field="步骤组名称"]')).toHaveText('玩家转区 · 含子步骤的步骤块');
  await expect(frozen.locator('[data-inline-field="步骤组描述"]')).toHaveText(instanceDescription);
  for (const label of ['步骤组名称', '步骤组描述']) {
    await expect(frozen.getByRole('button', { name: `编辑${label}`, exact: true })).toHaveCount(0);
    await expect(frozen.getByRole('textbox', { name: label, exact: true })).toHaveCount(0);
    await frozen.locator(`[data-inline-field="${label}"]`).dblclick();
    await expect(frozen.getByRole('textbox', { name: label, exact: true })).toHaveCount(0);
  }
  const beforePreview = await workspace();
  const nav = page.locator('[data-nav-step-id="second"]');
  await showGroupHeader('.execution-group[data-group-id="group-main"]');
  await nav.hover();
  await expect(page.getByRole('tooltip')).toContainText(instanceDescription);
  assert.deepEqual(await workspace(), beforePreview);
  await page.screenshot({ path: '.artifacts/group-description-execution.png' });
  await page.keyboard.press('Escape');
  const archive = await native('checklist_export_data', { kind: 'instance', id: runId });
  const preview = await native('checklist_preview_import', { name: archive.name, bytes: archive.bytes });
  assert.equal(preview.duplicate, true);
  const restored = await native('checklist_commit_import', { token: preview.token, asCopy: true });
  const imported = restored.instances.find(item => item.id !== runId);
  assert.deepEqual(imported.document, (await run()).document);
  assert.deepEqual(imported.entries, (await run()).entries);
  checks.push('Instance group description displays before child steps, edits independently before progress, freezes with its title after advancement, appears in read-only navigation previews and survives native ZIP independent import');
  await reload();
  await page.locator(`[data-instance-id="${runId}"]`).click();
  await expect(executionGroup('group-main').locator('[data-inline-field="步骤组描述"]')).toHaveText(instanceDescription);
  assert.equal((await run()).currentStepId, 'second');
  assert.equal((await template()).document.groups[0].description, changed);

  // Independent synthetic instance keeps layout cases separate from the
  // existing reuse/archive/freeze assertions and their exact original data.
  const beforeGeometry = await workspace();
  const geometryTemplateId = 'qa-group-description-geometry-template', geometryRunId = 'qa-group-description-geometry-run', geometryGroupId = 'description-geometry-group';
  const geometryDocument = { parameters: [], groups: [{ id: geometryGroupId, name: '描述边界核验组' }],
    steps: ['description-geometry-first', 'description-geometry-second'].map((id, index) => ({ id, groupId: geometryGroupId, title: [`几何核验 ${index + 1}`], description: ['人工确认，不运行命令。'], commands: [] })) };
  await apply({ type: 'create_template', id: geometryTemplateId, name: '描述边界独立夹具', document: geometryDocument });
  await apply({ type: 'create_instance', id: geometryRunId, name: '实例描述边界核验', templateId: geometryTemplateId, fromInstanceId: null });
  await reload(); await page.locator(`[data-instance-id="${geometryRunId}"]`).click();
  const geometryField = executionGroup(geometryGroupId).locator('[data-inline-field="步骤组描述"]');
  const viewports = [{ width: 1360, height: 940 }, { width: 940, height: 640 }];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport); await settings(geometryGroupId);
    await expect(geometryField).toHaveAttribute('data-inline-empty', 'true');
    await expect(geometryField).toContainText('添加描述');
    const beforeHover = await workspace();
    await checkDescriptionGeometry(geometryGroupId, `empty-hover-${viewport.width}`);
    assert.deepEqual(await workspace(), beforeHover, 'Hovering an empty instance description must not save its placeholder');
  }
  const longDescription = `无断词：${'UNBROKEN'.repeat(32)}\n第二行：多行内容保持在步骤组内。\n第三行：截图只用于边界验证。`;
  await page.setViewportSize(viewports[0]);
  const geometryEditor = await inlineEditor(await settings(geometryGroupId), '步骤组描述');
  assert.equal(await geometryEditor.evaluate(element => element.tagName), 'TEXTAREA');
  await geometryEditor.fill(longDescription);
  await waitSaved(async () => (await workspace()).instances.find(item => item.id === geometryRunId).document.groups[0].description === longDescription);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport); await expect(geometryEditor).toHaveValue(longDescription);
    await checkDescriptionGeometry(geometryGroupId, `editing-${viewport.width}`, true);
  }
  await geometryEditor.press('Control+Enter'); await expect(geometryEditor).toHaveCount(0);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport); await expect(geometryField).toHaveText(longDescription);
    await checkDescriptionGeometry(geometryGroupId, `long-display-${viewport.width}`);
  }
  assert.equal((await workspace()).templates.find(item => item.id === geometryTemplateId).document.groups[0].description ?? '', '');
  await apply({ type: 'start_instance', id: geometryRunId });
  await apply({ type: 'record_result', id: geometryRunId, outcome: 'completed', reason: null });
  const frozenGeometryInstance = (await workspace()).instances.find(item => item.id === geometryRunId);
  assert.equal(frozenGeometryInstance.currentStepId, 'description-geometry-second');
  await reload(); await page.locator(`[data-instance-id="${geometryRunId}"]`).click();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport); await settings(geometryGroupId);
    await expect(geometryField).toHaveText(longDescription);
    await expect(executionGroup(geometryGroupId).getByRole('button', { name: '编辑步骤组描述', exact: true })).toHaveCount(0);
    await geometryField.dblclick();
    await expect(executionGroup(geometryGroupId).getByRole('textbox', { name: '步骤组描述', exact: true })).toHaveCount(0);
    await checkDescriptionGeometry(geometryGroupId, `frozen-${viewport.width}`);
    assert.deepEqual((await workspace()).instances.find(item => item.id === geometryRunId), frozenGeometryInstance);
  }
  const afterGeometry = await workspace();
  assert.deepEqual(afterGeometry.templates.filter(item => item.id !== geometryTemplateId), beforeGeometry.templates);
  assert.deepEqual(afterGeometry.instances.filter(item => item.id !== geometryRunId), beforeGeometry.instances);
  assert.deepEqual(afterGeometry.blocks, beforeGeometry.blocks);
  checks.push('At 1360 × 940 and 940 × 640, empty description hover, long unbroken/multiline display, the inline textarea and advanced read-only descriptions retain at least 15px left/right group spacing without horizontal overflow; hover/read-only states preserve data and the independent geometry fixture leaves original templates, instances, archives and blocks unchanged');
  assert.deepEqual(pageErrors, []);
  const result = { ok: true, isolatedDataDirectory: actual, checks, geometryChecks, pageErrors, templateId, runId, importedId: imported.id, blockId: block.id,
    geometryTemplateId, geometryRunId, clipboardTouched: false, maintenanceCommandsExecuted: false };
  await writeFile('.artifacts/group-description-check.json', JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: '.artifacts/group-description-failure.png' }).catch(() => {});
  throw error;
} finally { await browser.close(); }
