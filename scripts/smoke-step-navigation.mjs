import { openCommentComposer } from './step-materials.mjs';
// Build first, then run only through the owned-process desktop harness:
// node scripts/check-desktop.mjs scripts/smoke-step-navigation.mjs
// Uses a fresh harness database, never touches the clipboard, and executes no displayed commands.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && path.isAbsolute(directory), 'Explicit isolated test directory required');
assert.equal(path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''), path.resolve(directory));
const targetDirectory = await realpath('target'), actualDirectory = await realpath(directory);
assert.equal(path.dirname(actualDirectory).toLowerCase(), targetDirectory.toLowerCase());
assert.match(path.basename(actualDirectory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actualDirectory}`));
assert.ok(process.env.RUNBOOK_CDP_URL, 'Owned harness CDP endpoint required');

const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const checks = [], pageErrors = [], screenshots = [], layouts = [], colors = {}, locations = [], previewPreparations = [];
let lastLocation;
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const workspace = () => native('checklist_load');
const apply = action => native('checklist_apply', { action });
const navigator = () => page.locator('aside.step-navigation[data-step-navigation]');
const item = id => navigator().locator(`button[data-nav-step-id="${id}"]`);
const card = id => page.locator(`[data-step-id="${id}"]`);
const runId = 'qa-navigation-active', currentRunId = 'qa-navigation-current', completeRunId = 'qa-navigation-completed', terminatedRunId = 'qa-navigation-terminated';
const fixtureTemplateId = 'qa-navigation-template';
const stepIds = ['nav-completed', 'nav-skipped', 'nav-failed', 'nav-pending'];
const environmentId = 'nav-environment';
const ref = parameterId => ({ parameterId });

async function settle() {
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeEnabled();
  await expect(page.locator('.save-state')).toContainText('已保存在本机');
}
async function reload() {
  await page.reload();
  await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  await expect(page.locator('.library-page')).toBeVisible();
}
async function openTemplate(id) {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '模板' }).click();
  await page.locator(`[data-template-id="${id}"]`).locator('.tile-open').click();
  await expect(page.locator('[data-inline-field="模板名称"]')).toBeVisible();
  await expect(navigator()).toBeVisible();
  await settle();
}
async function openInstance(id) {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '当前工作' }).click();
  await page.locator(`[data-instance-id="${id}"]`).click();
  await expect(page.locator('[data-inline-field="实例名称"]')).toBeVisible();
  await expect(navigator()).toBeVisible();
  await settle();
  const current = navigator().locator('button[data-nav-step-id][data-current="true"]');
  if (await current.count()) {
    const snapshot = (await workspace()).instances.find(value => value.id === id); assert.ok(snapshot);
    const currentId = await current.getAttribute('data-nav-step-id'); assert.equal(currentId, snapshot.currentStepId);
    await waitForLocated(currentId, snapshot.document);
    await expect(page.locator('[data-variable-panel]')).toHaveAttribute('data-variable-target-step-id', currentId);
  }
}
async function compact() {
  const collapse = navigator().getByRole('button', { name: '收起步骤目录', exact: true });
  if (await collapse.count()) await collapse.click();
  await expect(navigator().getByRole('button', { name: '展开步骤目录', exact: true })).toBeVisible();
}
async function expand() {
  const toggle = navigator().getByRole('button', { name: '展开步骤目录', exact: true });
  if (await toggle.count()) await toggle.click();
  await expect(navigator().getByRole('button', { name: '收起步骤目录', exact: true })).toBeVisible();
}
async function showPreview(id, mode = 'hover') {
  // Leave the previous row before its list scrolls; a late real mouseleave
  // must finish before the one new pointer-enter request under test.
  if (mode === 'focus') await navigator().locator('.step-nav-header button').focus();
  else await page.mouse.move(1, 1);
  await item(id).scrollIntoViewIfNeeded();
  const preparation = await page.evaluate(id => new Promise(resolve => {
    let previous, stable = 0, frames = 0;
    function measure() {
      const root = document.querySelector('.workspace-scroll'), list = document.querySelector('.step-nav-list');
      const button = [...document.querySelectorAll('[data-nav-step-id]')].find(element => element.dataset.navStepId === id);
      if (!root || !list || !button) { resolve({ ready: false, id, missing: true }); return; }
      const row = button.getBoundingClientRect(), area = list.getBoundingClientRect();
      const positions = [scrollX, scrollY, innerWidth, innerHeight, root.scrollTop, root.scrollLeft, list.scrollTop, list.scrollLeft, area.left, area.top, area.width, area.height, row.left, row.top, row.width, row.height];
      stable = previous && positions.every((value, index) => Math.abs(value - previous[index]) < 0.25) ? stable + 1 : 0;
      previous = positions;
      const rowVisible = row.top >= area.top - 1 && row.bottom <= area.bottom + 1 && row.left >= area.left - 1 && row.right <= area.right + 1 && row.width > 0 && row.height > 0;
      const result = { ready: rowVisible && stable >= 3, id, frames: ++frames, stableFrames: stable + 1, rowVisible,
        workspaceScroll: root.scrollTop, listScroll: list.scrollTop, row: { left: row.left, top: row.top, right: row.right, bottom: row.bottom },
        list: { left: area.left, top: area.top, right: area.right, bottom: area.bottom }, focusedStep: document.activeElement?.getAttribute('data-nav-step-id') };
      if (result.ready || frames >= 180) resolve(result); else requestAnimationFrame(measure);
    }
    requestAnimationFrame(measure);
  }), id);
  previewPreparations.push(preparation);
  assert.ok(preparation.ready, `${id}: workspace/list scrolling and the real preview trigger must settle before requesting a preview`);
  if (mode === 'focus') {
    await item(id).evaluate(element => element.focus({ preventScroll: true }));
    await expect(item(id)).toBeFocused();
  } else {
    await item(id).hover();
    assert.ok(await item(id).evaluate(element => element.matches(':hover')), `${id}: actual pointer hover must reach the requested row`);
  }
  const tooltip = page.locator(`[role="tooltip"][data-preview-step-id="${id}"]`);
  await expect(tooltip).toBeVisible();
  return tooltip;
}
async function dismissPreview() {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
}
async function snapshotLayout(name, tooltipId) {
  const layout = await page.evaluate(({ name, tooltipId }) => {
    const rect = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
    };
    const navigation = document.querySelector('aside.step-navigation[data-step-navigation]');
    return { name, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, documentWidth: document.documentElement.scrollWidth,
      app: rect('.checklist-app'), sidebar: rect('.app-sidebar'), navigation: rect('aside.step-navigation[data-step-navigation]'),
      workspaceFrame: rect('.workspace-with-navigation'), workspace: rect('.workspace-scroll'),
      navigationOverlay: navigation ? getComputedStyle(navigation).position === 'absolute' : false,
      tooltip: tooltipId ? rect(`[role="tooltip"][data-preview-step-id="${tooltipId}"]`) : null };
  }, { name, tooltipId });
  layouts.push(layout);
  await writeFile(`.artifacts/step-navigation-layout-${name}.json`, JSON.stringify(layout, null, 2), 'utf8');
  const filename = `.artifacts/step-navigation-${name}.png`;
  await page.screenshot({ path: filename });
  screenshots.push(filename);
  assert.equal(layout.viewport.scrollX, 0, `${name}: desktop root must not scroll horizontally`);
  assert.equal(layout.viewport.scrollY, 0, `${name}: desktop root must not scroll vertically`);
  assert.ok(layout.documentWidth <= layout.viewport.width + 1, `${name}: root horizontal overflow`);
  for (const key of ['app', 'sidebar', 'navigation', 'workspace']) {
    const rect = layout[key];
    assert.ok(rect && rect.width > 0 && rect.height > 0, `${name}: missing ${key}`);
    assert.ok(rect.x >= -1 && rect.right <= layout.viewport.width + 1 && rect.y >= -1 && rect.bottom <= layout.viewport.height + 1, `${name}: ${key} escaped the viewport`);
  }
  assert.ok(layout.workspaceFrame, `${name}: workspace frame expected`);
  assert.ok(Math.abs(layout.navigation.x - layout.workspaceFrame.x) <= 1, `${name}: step navigation must stay at the left edge of the document area`);
  assert.ok(layout.navigation.x <= layout.workspace.x + 1, `${name}: navigation must be on the left of the document`);
  if (!layout.navigationOverlay) {
    assert.ok(Math.abs(layout.navigation.right - layout.workspace.x) <= 1, `${name}: compact/wide navigation and document must share an adjacent edge`);
  } else {
    assert.ok(layout.navigation.right > layout.workspace.x, `${name}: narrow expanded navigation should overlay the document after the reserved compact gutter`);
  }
  if (tooltipId) {
    assert.ok(layout.tooltip && layout.tooltip.width > 0 && layout.tooltip.height > 0, `${name}: visible preview expected`);
    assert.ok(layout.tooltip.x >= 0 && layout.tooltip.right <= layout.viewport.width + 1 && layout.tooltip.y >= 0 && layout.tooltip.bottom <= layout.viewport.height + 1, `${name}: preview must be clamped inside the viewport`);
  }
  return layout;
}
async function inspectColor(id, status) {
  await expect(item(id)).toHaveAttribute('data-nav-status', status);
  const value = await item(id).locator('[data-nav-indicator]').evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { backgroundColor: style.backgroundColor, color: style.color, borderColor: style.borderColor, opacity: style.opacity, width: rect.width, height: rect.height };
  });
  assert.ok(value.width > 0 && value.height > 0, `${status}: visible colored status indicator required`);
  colors[status] = value;
  return value;
}
async function assertViewing(id) {
  await expect(item(id)).toHaveAttribute('data-viewing', 'true');
  await expect(navigator().locator('button[data-nav-step-id][data-viewing="true"]')).toHaveCount(1);
}
async function waitForLocated(id, initialDocument) {
  // CSS visibility only proves that an off-screen card is mounted. Wait for the
  // real heading to enter the document viewport, then require three consecutive
  // animation frames with the same inner scroll offset before checking the
  // observer-driven viewing marker. This also catches optimistic markers that
  // are overwritten after the smooth scroll reaches a short final step.
  await expect.poll(async () => {
    lastLocation = await page.evaluate(({ id, groupFirstSteps }) => new Promise(resolve => {
      let prior, stable = 0, frames = 0;
      function measure() {
        const root = document.querySelector('.workspace-scroll');
        const target = [...document.querySelectorAll('.step-card[data-step-id]')].find(element => element.getAttribute('data-step-id') === id);
        const heading = target?.querySelector('.step-card-heading') ?? target;
        if (!root || !heading) { resolve({ ready: false, id, missing: true }); return; }
        const bounds = root.getBoundingClientRect(), position = heading.getBoundingClientRect();
        const documentEntries = [...root.querySelectorAll('.step-card[data-step-id], .step-group[data-group-id]')].map(node => node.dataset.stepId ?? (!node.querySelector('.step-card') ? groupFirstSteps[node.dataset.groupId] : undefined)).filter(Boolean);
        stable = prior !== undefined && Math.abs(root.scrollTop - prior) < 0.25 ? stable + 1 : 0;
        prior = root.scrollTop;
        const headingVisible = position.top >= bounds.top - 1 && position.bottom <= bounds.bottom + 1 && position.width > 0 && position.height > 0;
        const result = { ready: headingVisible && stable >= 2, id, scrollTop: root.scrollTop, stableFrames: stable + 1, headingVisible,
          heading: { top: position.top, bottom: position.bottom }, viewport: { top: bounds.top, bottom: bounds.bottom },
          clientHeight: root.clientHeight, scrollHeight: root.scrollHeight, atBottom: root.scrollTop > 0 && root.scrollHeight > root.clientHeight + 2 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2,
          lastDocumentStepId: documentEntries.at(-1),
          viewing: document.querySelector('[data-nav-step-id][data-viewing="true"]')?.getAttribute('data-nav-step-id') };
        if (result.ready || ++frames >= 120) resolve(result); else requestAnimationFrame(measure);
      }
      requestAnimationFrame(measure);
    }), { id, groupFirstSteps: Object.fromEntries((initialDocument?.groups ?? []).map(group => [group.id, initialDocument.steps.find(step => step.groupId === group.id)?.id])) });
    return lastLocation.ready;
  }, { message: `${id}: target heading must be inside the document viewport after its inner scroll settles`, timeout: 15000 }).toBe(true);
  // On initial open, a short expanded current step can already occupy the
  // document's maximum scroll offset. The existing reading rule marks the last
  // rendered row there, even when it is a collapsed later group. Current step
  // visibility/identity and panel context are independent and stay mandatory.
  // Explicit goTo/manual-scroll calls below retain the exact target assertion.
  const expectedViewing = initialDocument && lastLocation.atBottom ? lastLocation.lastDocumentStepId : id;
  assert.ok(expectedViewing, 'An initial bottom position must have a real last rendered step/group row');
  await assertViewing(expectedViewing);
  lastLocation.initialOpen = Boolean(initialDocument); lastLocation.expectedViewing = expectedViewing;
  locations.push(lastLocation);
}
async function goTo(id) {
  await item(id).click();
  await expect(card(id)).toBeVisible();
  await waitForLocated(id);
}
async function record(id, outcome, reason = null) { await apply({ type: 'record_result', id, outcome, reason }); }
async function newRun(id) {
  await apply({ type: 'create_instance', id, name: id, templateId: fixtureTemplateId, fromInstanceId: null });
  await apply({ type: 'start_instance', id });
}

try {
  await mkdir('.artifacts', { recursive: true });
  await page.setViewportSize({ width: 1360, height: 940 });
  const maintenance = JSON.parse(await readFile('templates/release-maintenance/maintenance.runbook.json', 'utf8'));
  assert.equal(maintenance.document.steps.length, 46);
  const importPreview = await native('checklist_preview_import', { name: 'maintenance.runbook.json', bytes: [...Buffer.from(JSON.stringify(maintenance))] });
  assert.equal(importPreview.kind, 'template');
  assert.equal(importPreview.duplicate, false);
  await native('checklist_commit_import', { token: importPreview.token, asCopy: false });
  const definition = { groups: [{ id: 'nav-prior-group', name: '已推进阶段' }, { id: 'nav-active-group', name: '当前与后续阶段' }],
    parameters: [{ id: environmentId, name: '导航验证环境', description: '仅验证文字预览，不执行任何命令', defaultValue: 'release' }],
    steps: stepIds.map((id, index) => ({ id, groupId: index < 2 ? 'nav-prior-group' : 'nav-active-group',
      title: [`导航步骤 ${index + 1} `, ref(environmentId)],
      description: [`描述标记 NAV-${index + 1}，预览环境为 `, ref(environmentId), '\n只用于人工记录与导航验证。'],
      commands: [{ id: `${id}-command`, text: ['echo NAV-', String(index + 1), ' ', ref(environmentId)] }] })) };
  await apply({ type: 'create_template', id: fixtureTemplateId, name: '导航状态与快照夹具', document: definition });
  await newRun(runId);
  await record(runId, 'completed');
  await record(runId, 'skipped', '演练：此步无需执行');
  await record(runId, 'failed', '演练：人工记录失败，停留当前步骤');
  const active = (await workspace()).instances.find(value => value.id === runId);
  await apply({ type: 'apply_parameters', id: runId, values: { ...active.parameterValues, [environmentId]: 'sandboxa' } });
  await newRun(currentRunId);
  await newRun(completeRunId);
  for (const id of stepIds) await record(completeRunId, 'completed');
  await newRun(terminatedRunId);
  await record(terminatedRunId, 'completed');
  await apply({ type: 'terminate_instance', id: terminatedRunId, reason: '演练：终止后保留未执行状态' });
  await reload();

  await openTemplate(maintenance.id);
  await expect(navigator().getByRole('button', { name: '展开步骤目录', exact: true })).toBeVisible();
  await expect(navigator().locator('button[data-nav-step-id]')).toHaveCount(46);
  const templateBaseline = await workspace();
  const first = maintenance.document.steps[0].id, last = maintenance.document.steps.at(-1).id;
  let tooltip = await showPreview(last);
  await expect(tooltip).toContainText('开放登录');
  await snapshotLayout('maintenance-compact-last', last);
  await dismissPreview();
  await goTo(last);
  await expect(card(last).locator('[data-inline-field="步骤标题"]')).toBeVisible();
  await expand();
  await expect(navigator()).toContainText(maintenance.document.groups[0].name);
  const groupedTarget = maintenance.document.steps.find(step => step.groupId === maintenance.document.groups.at(-1).id);
  await goTo(groupedTarget.id);
  tooltip = await showPreview(groupedTarget.id, 'focus');
  await snapshotLayout('maintenance-expanded', groupedTarget.id);
  await dismissPreview();
  const exitIndex = maintenance.document.steps.findIndex((step, index, steps) => index > 0 && !step.groupId && steps[index - 1].groupId && maintenance.document.groups.find(group => group.id === steps[index - 1].groupId)?.name.includes('转区'));
  if (exitIndex > 0) {
    await goTo(maintenance.document.steps[exitIndex].id);
    await dismissPreview();
    await mkdir('.artifacts/nav-legend-2026-10-21', { recursive: true });
    await navigator().screenshot({ path: '.artifacts/nav-legend-2026-10-21/group-exit.png' });
    const boundaries = await navigator().locator('.step-nav-entry').evaluateAll((nodes, steps) => nodes.map((node, index) => ({ number: index + 1, groupId: steps[index].groupId ?? null, title: node.textContent, border: getComputedStyle(node).borderTopWidth })), maintenance.document.steps);
    await writeFile('.artifacts/nav-legend-2026-10-21/rows.json', JSON.stringify(boundaries, null, 2));
  }
  await item(first).focus();
  await page.keyboard.press('End');
  await expect(item(last)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(item(first)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(item(maintenance.document.steps[1].id)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(item(first)).toBeFocused();
  await page.keyboard.press('Enter');
  await waitForLocated(first);
  await dismissPreview();
  assert.deepEqual(await workspace(), templateBaseline, 'Template previews, keyboard movement, and step navigation must perform no data mutation');
  checks.push('The actual 46-step maintenance template imports natively, opens with a compact directory, groups are shown as sections, and pointer/keyboard navigation locates any step without changing saved data');

  for (const size of [{ width: 1360, height: 940 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(size);
    for (const expanded of [false, true]) {
      if (expanded) await expand(); else await compact();
      for (const id of [first, last]) {
        await showPreview(id);
        await snapshotLayout(`maintenance-${size.width}-${expanded ? 'expanded' : 'compact'}-${id === first ? 'first' : 'last'}`, id);
        await dismissPreview();
      }
    }
  }
  assert.deepEqual(await workspace(), templateBaseline, 'Responsive layout and preview checks must leave the template unchanged');
  checks.push('At 1360×940 and 940×640, compact and expanded directories remain within the desktop viewport, and first/last-step previews are clamped within all four screen edges');

  await page.setViewportSize({ width: 1360, height: 940 });
  await openInstance(runId);
  await compact();
  await expect(page.locator('.instance-progressbar')).toHaveCount(0);
  await expect(navigator().locator('[data-nav-progress]')).toContainText(/2\s*\/\s*4/);
  await expect(item(stepIds[2])).toHaveAttribute('data-current', 'true');
  await expect(navigator().locator('button[data-nav-step-id][data-current="true"]')).toHaveCount(1);
  for (const [index, status] of ['completed', 'skipped', 'failed', 'pending'].entries()) await inspectColor(stepIds[index], status);
  const activeColors = ['completed', 'skipped', 'failed', 'pending'].map(status => JSON.stringify([colors[status].backgroundColor, colors[status].color, colors[status].borderColor, colors[status].opacity]));
  assert.equal(new Set(activeColors).size, 4, 'Completed, skipped, failed, and pending indicators must use distinct visible status styles');
  const activeBaseline = await workspace();
  for (let index = 0; index < stepIds.length; index++) {
    tooltip = await showPreview(stepIds[index]);
    const expectedEnvironment = index < 2 ? 'release' : 'sandboxa';
    await expect(tooltip).toContainText(`导航步骤 ${index + 1} ${expectedEnvironment}`);
    await expect(tooltip).toContainText(`echo NAV-${index + 1} ${expectedEnvironment}`);
    if (index < 2) await expect(tooltip).not.toContainText('sandboxa');
    await dismissPreview();
  }
  assert.deepEqual(await workspace(), activeBaseline, 'Hover/focus previews must not save or advance execution');
  checks.push('Execution directory replaces the top progress bar, shows 2/4 with distinct outcome colors, and renders completed/skipped previews from frozen release snapshots while current/future previews use applied sandboxa values');

  await navigator().getByRole('button', { name: '返回当前步骤', exact: true }).click();
  await waitForLocated(stepIds[2]);
  await expect(card(stepIds[2]).getByRole('button', { name: /完成并/ })).toBeVisible();
  const variablePanel = page.getByRole('complementary', { name: '变量面板', exact: true });
  if (await variablePanel.getByRole('button', { name: '展开变量面板', exact: true }).count()) await variablePanel.getByRole('button', { name: '展开变量面板', exact: true }).click();
  const global = variablePanel.locator('[data-parameter-scope="global"]');
  const parameterInput = global.getByRole('textbox', { name: '导航验证环境', exact: true });
  await parameterInput.fill('ios-audit-unapplied-draft');
  await openCommentComposer(card(stepIds[2]));
  await card(stepIds[2]).getByRole('textbox', { name: '添加评论', exact: true }).fill('导航期间保留的未提交评论');
  for (const id of [stepIds[3], stepIds[0], stepIds[2]]) {
    await goTo(id);
    await expect(card(id).locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(stepIds[2])).toHaveAttribute('data-current', 'true');
  }
  for (const id of [stepIds[2], stepIds[3]]) {
    tooltip = await showPreview(id);
    await expect(tooltip).toContainText('sandboxa');
    await expect(tooltip).not.toContainText('ios-audit-unapplied-draft');
    await dismissPreview();
  }
  await expect(parameterInput).toHaveValue('ios-audit-unapplied-draft');
  await openCommentComposer(card(stepIds[2]));
  await expect(card(stepIds[2]).getByRole('textbox', { name: '添加评论', exact: true })).toHaveValue('导航期间保留的未提交评论');
  assert.deepEqual(await workspace(), activeBaseline, 'Previous/future/current navigation must preserve all documents, results, status, and applied values; unsaved inputs must stay local');
  await snapshotLayout('active-drafts-preserved');
  checks.push('Clicking previous, future, and current steps only expands/scrolls; current identity and all saved data remain exact, unsent comment/parameter inputs remain visible, and parameter drafts never affect previews');

  // Manual inner scrolling is independent of execution. Align a prior card in the
  // scroll container to verify the viewing marker follows the viewport itself.
  await goTo(stepIds[0]);
  await card(stepIds[3]).evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await waitForLocated(stepIds[3]);
  await expect(item(stepIds[2])).toHaveAttribute('data-current', 'true');
  await navigator().getByRole('button', { name: '返回当前步骤', exact: true }).click();
  await waitForLocated(stepIds[2]);
  await item(stepIds[0]).focus();
  tooltip = page.locator(`[role="tooltip"][data-preview-step-id="${stepIds[0]}"]`);
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(item(stepIds[0])).toBeFocused();
  assert.deepEqual(await workspace(), activeBaseline);
  checks.push('The viewing marker tracks manual document scrolling independently of the current execution step, Return to current restores its position, and Escape dismisses the keyboard preview without moving focus');

  // Clear explicit drafts before leaving this workspace; no save or execution
  // action is needed or expected for discarded UI-only input.
  await global.getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await card(stepIds[2]).getByRole('button', { name: '清空', exact: true }).click();
  await settle();
  assert.deepEqual(await workspace(), activeBaseline);
  await openInstance(currentRunId);
  await expect(item(stepIds[0])).toHaveAttribute('data-current', 'true');
  await inspectColor(stepIds[0], 'current');
  assert.notDeepEqual([colors.current.backgroundColor, colors.current.color, colors.current.borderColor], [colors.failed.backgroundColor, colors.failed.color, colors.failed.borderColor], 'Active and failed current indicators must differ');
  await expect(navigator().locator('[data-nav-progress]')).toContainText(/0\s*\/\s*4/);
  await openInstance(completeRunId);
  await expect(navigator().locator('[data-nav-progress]')).toContainText(/4\s*\/\s*4/);
  await expect(navigator().locator('button[data-nav-step-id][data-nav-status="completed"]')).toHaveCount(4);
  await expect(navigator().locator('button[data-nav-step-id][data-current="true"]')).toHaveCount(0);
  await snapshotLayout('completed');
  await openInstance(terminatedRunId);
  await expect(navigator().locator('[data-nav-progress]')).toContainText(/1\s*\/\s*4/);
  await expect(navigator().locator('button[data-nav-step-id][data-nav-status="unexecuted"]')).toHaveCount(3);
  await expect(navigator().locator('button[data-nav-step-id][data-current="true"]')).toHaveCount(0);
  await inspectColor(stepIds[3], 'unexecuted');
  const terminatedBaseline = await workspace();
  await goTo(stepIds[3]);
  await expect(card(stepIds[3]).getByRole('button', { name: /完成并/ })).toHaveCount(0);
  await showPreview(stepIds[3], 'focus');
  await snapshotLayout('terminated-preview', stepIds[3]);
  await dismissPreview();
  assert.deepEqual(await workspace(), terminatedBaseline, 'Navigating an ended/terminated instance must not resume it or write results');
  checks.push('Active steps without failure have their own current color; completed instances show 4/4 with no current step, and terminated instances retain completed progress plus three unexecuted steps without exposing execution actions');
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
  const result = { ok: true, isolatedDataDirectory: directory, maintenanceTemplateId: maintenance.id, runId, currentRunId, completeRunId, terminatedRunId,
    checks, colors, screenshots, layouts, locations, previewPreparations, pageErrors, clipboardTouched: false, maintenanceCommandsExecuted: false, nativeFileChooserAutomated: false,
    note: 'All fixture creation/import and equality reads use real native checklist IPC. Navigation/preview assertions use the actual desktop UI; OS file chooser interaction is not part of this test.' };
  await writeFile('.artifacts/step-navigation-check.json', JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  await mkdir('.artifacts', { recursive: true }).catch(() => {});
  await page.screenshot({ path: '.artifacts/step-navigation-failure.png' }).catch(() => {});
  const diagnostics = await page.evaluate(() => ({
    navigation: document.querySelector('[data-step-navigation]')?.outerHTML,
    previews: [...document.querySelectorAll('[role="tooltip"]')].map(element => element.outerHTML),
    focused: document.activeElement?.outerHTML,
    saveState: document.querySelector('.save-state')?.textContent,
    alert: document.querySelector('[role="alert"]')?.textContent,
    scroll: { x: scrollX, y: scrollY, workspace: document.querySelector('.workspace-scroll')?.scrollTop },
  })).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/step-navigation-failure.json', JSON.stringify({ checks, pageErrors, layouts, colors, locations, lastLocation, previewPreparations, diagnostics, error: String(error) }, null, 2), 'utf8').catch(() => {});
  console.error(JSON.stringify({ checks, pageErrors }));
  throw error;
} finally { await browser.close(); }
