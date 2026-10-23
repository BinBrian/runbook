// node scripts/check-desktop.mjs scripts/smoke-step-actions.mjs
// All documents, state changes and windows belong to the harness-owned workspace.
// "Copy" below duplicates document blocks; no clipboard or command execution occurs.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && path.isAbsolute(directory));
assert.equal(path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''), path.resolve(directory));
const actualDirectory = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actualDirectory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actualDirectory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actualDirectory}`));
assert.ok(process.env.RUNBOOK_CDP_URL);
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const checks = [], pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action });
const workspace = () => native('checklist_load');
const templateId = 'qa-step-actions-template', runningTemplateId = 'qa-step-actions-running-template', runId = 'qa-step-actions-run';
const blockId = 'qa-step-actions-block', longTemplateId = 'qa-step-actions-long';
const template = async (id = templateId) => (await workspace()).templates.find(item => item.id === id);
const run = async () => (await workspace()).instances.find(item => item.id === runId);
const step = id => page.locator(`[data-step-id="${id}"]`);
const group = id => page.locator(`[data-group-id="${id}"]`).first();
const menu = () => page.getByRole('menu');
const ref = id => ({ parameterId: id });
const basicNames = ['新增后续步骤', '添加命令', '插入步骤块'];
const moreNames = ['复制当前步骤', '上移步骤', '下移步骤', '转为步骤组', '删除当前步骤'];
const groupBasicNames = ['添加子步骤', '组后新增步骤', '组后插入步骤块'];
const groupMoreNames = ['复制步骤组', '上移步骤组', '下移步骤组', '保存为步骤块', '删除步骤组及子步骤'];
const initialDocument = {
  groups: [{ id: 'actions-player', name: '单个玩家转区', description: '每个玩家的参数只属于本组。' }],
  parameters: [
    { id: 'actions-global', name: '环境', description: '', defaultValue: 'release' },
    { id: 'actions-branch', ownerId: 'actions-head', name: '来源分支', description: '', defaultValue: 'preview' },
    { id: 'actions-player-id', ownerId: 'actions-player', name: '玩家 ID', description: '', defaultValue: '9002001' },
    { id: 'actions-district', ownerId: 'actions-first', name: '原区', description: '', defaultValue: '9001001' },
  ],
  steps: [
    { id: 'actions-head', title: ['准备 ', ref('actions-global')], description: ['只记录，不执行命令。'], commands: [{ id: 'actions-head-command', text: ['copybranch ', ref('actions-branch'), ' ', ref('actions-global')] }] },
    { id: 'actions-first', groupId: 'actions-player', title: ['检查 ', ref('actions-player-id')], description: ['原区 ', ref('actions-district')], commands: [{ id: 'actions-first-command', text: ['transferserver ', ref('actions-global'), ' ', ref('actions-district'), ' ', ref('actions-player-id'), ' checktransfer'] }] },
    { id: 'actions-second', groupId: 'actions-player', title: ['确认 ', ref('actions-player-id')], description: ['人工检查点。'], commands: [] },
    { id: 'actions-tail', title: ['开放登录'], description: ['人工确认后记录。'], commands: [{ id: 'actions-tail-command', text: ['allowlogin ', ref('actions-global'), ' all'] }] },
  ],
};
const blockDocument = {
  groups: [{ id: 'actions-block-group', name: '更新重启', description: '插入后独立记录。' }],
  parameters: [{ id: 'actions-block-env', ownerId: 'actions-block-group', name: '环境', description: '', defaultValue: 'sandboxa' }],
  steps: ['stopserver', 'startserver'].map((command, index) => ({ id: `actions-block-step-${index}`, groupId: 'actions-block-group', title: [index ? '启动服务' : '停止服务'], description: [],
    commands: [{ id: `actions-block-command-${index}`, text: [`${command} `, ref('actions-block-env'), ' all'] }] })),
};

async function settle() {
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeEnabled();
  await expect(page.locator('.save-state')).toContainText('已保存在本机');
}
async function installMenuDiagnostics() {
  await page.evaluate(() => {
    if (window.__stepActionDiagnostics) return;
    const state = { timeline: [], trigger: null, lastStable: null };
    function rectangle(element) {
      if (!element?.getBoundingClientRect) return null;
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
    function describe(element) {
      if (!(element instanceof Element)) return { node: element?.nodeName ?? null };
      return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : element.className?.baseVal,
        label: element.getAttribute('aria-label'), stepId: element.closest('[data-step-id]')?.getAttribute('data-step-id'),
        groupId: element.closest('[data-group-id]')?.getAttribute('data-group-id'), rectangle: rectangle(element) };
    }
    state.record = (type, target) => {
      const root = document.querySelector('.workspace-scroll');
      state.timeline.push({ at: performance.now(), type, target: describe(target), trigger: describe(state.trigger),
        active: describe(document.activeElement), windowScrollY: window.scrollY,
        workspace: root ? { scrollTop: root.scrollTop, scrollLeft: root.scrollLeft, rectangle: rectangle(root) } : null,
        menus: [...document.querySelectorAll('[role="menu"]')].map(menu => ({ rectangle: rectangle(menu), label: menu.getAttribute('aria-label'), itemCount: menu.querySelectorAll('[role="menuitem"]').length })),
      });
      if (state.timeline.length > 250) state.timeline.splice(0, state.timeline.length - 250);
    };
    window.__stepActionDiagnostics = state;
    document.addEventListener('scroll', event => state.record('document-scroll', event.target), true);
    document.addEventListener('focusin', event => state.record('focusin', event.target), true);
    document.addEventListener('pointerdown', event => state.record('pointerdown', event.target), true);
  });
}
async function waitTriggerStable(trigger) {
  await trigger.evaluate(button => new Promise((resolve, reject) => {
    const state = window.__stepActionDiagnostics;
    if (state) { state.trigger = button; state.record('wait-stable-start', button); }
    let previous, stable = 0, frames = 0;
    function frame() {
      if (!button.isConnected) { reject(new Error('The menu trigger was replaced before it became stable')); return; }
      const root = document.querySelector('.workspace-scroll'), bounds = button.getBoundingClientRect();
      const sample = [root?.scrollTop ?? 0, root?.scrollLeft ?? 0, bounds.x, bounds.y, bounds.width, bounds.height, scrollX, scrollY];
      stable = previous && sample.every((value, index) => Math.abs(value - previous[index]) < 0.1) ? stable + 1 : 1;
      previous = sample; frames++;
      if (stable >= 3) {
        if (state) { state.lastStable = { sample, frames, stableFrames: stable }; state.record('trigger-stable-before-open', button); }
        resolve();
      } else if (frames >= 180) {
        if (state) state.record('trigger-did-not-stabilize', button);
        reject(new Error('Workspace scroll position/menu-trigger rectangle did not remain stable for three animation frames'));
      } else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }));
}
async function menuDiagnostics() {
  return page.evaluate(() => {
    const state = window.__stepActionDiagnostics;
    return state ? { timeline: state.timeline, lastStable: state.lastStable } : { unavailable: 'No menu diagnostic listener installed' };
  }).catch(error => ({ unavailable: String(error) }));
}
async function reload() {
  await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  await installMenuDiagnostics();
}
async function openTemplate(id = templateId) {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '模板' }).click();
  await page.locator(`[data-template-id="${id}"] .tile-open`).click();
  await expect(page.locator('[data-inline-field="模板名称"]')).toBeVisible();
}
async function openActions(source, isGroup = false, more = false) {
  const expectedNames = isGroup ? more ? groupMoreNames : groupBasicNames : more ? moreNames : basicNames;
  const trigger = source.getByRole('button', { name: isGroup ? more ? '更多步骤组操作' : '步骤组新增' : more ? '更多步骤操作' : '步骤新增', exact: true });
  await trigger.focus();
  await waitTriggerStable(trigger);
  await trigger.click();
  await expect(menu()).toBeVisible();
  await expect(menu().getByRole('menuitem')).toHaveCount(expectedNames.length);
  for (const name of expectedNames) await expect(menu().getByRole('menuitem', { name, exact: true })).toBeVisible();
  const removal = menu().getByRole('menuitem', { name: isGroup ? '删除步骤组及子步骤' : '删除当前步骤', exact: true });
  if (more) { await expect(menu().getByRole('menuitem').last()).toHaveAttribute('aria-label', isGroup ? '删除步骤组及子步骤' : '删除当前步骤'); await expect(removal).toHaveClass(/destructive-menuitem/); }
  else await expect(removal).toHaveCount(0);
  if (more && await removal.isEnabled()) {
    const colors = await removal.evaluate(node => {
      const hex = getComputedStyle(document.documentElement).getPropertyValue('--failure').trim().slice(1);
      return { actual: getComputedStyle(node.querySelector('strong')).color, expected: `rgb(${hex.match(/../g).map(part => parseInt(part, 16)).join(', ')})` };
    });
    assert.equal(colors.actual, colors.expected, 'Enabled deletion must use the danger text role, not the disabled text role');
  }
  return trigger;
}
async function choose(source, name, isGroup = false) {
  const aliases = isGroup ? { 新增步骤块: '组后新增步骤', 复制当前步骤块: '复制步骤组', 插入步骤块: '组后插入步骤块' } : { 新增步骤块: '新增后续步骤', 复制当前步骤块: '复制当前步骤', 删除步骤: '删除当前步骤' };
  const action = aliases[name] ?? name;
  await openActions(source, isGroup, (isGroup ? groupMoreNames : moreNames).includes(action));
  const item = menu().getByRole('menuitem', { name: action, exact: true });
  await expect(item).toBeEnabled(); await item.click();
  await expect(menu()).toHaveCount(0);
}
async function chooseBlock(source, isGroup = false) {
  await choose(source, '插入步骤块', isGroup);
  const dialog = page.getByRole('dialog', { name: '插入步骤块', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.locator('.block-choice').filter({ hasText: 'QA 行侧复用块' }).click();
  await expect(dialog).toHaveCount(0);
}
async function savedTemplateSize(size) { await expect.poll(async () => (await template()).document.steps.length).toBe(size); await settle(); return (await template()).document; }
async function savedRunSize(size) { await expect.poll(async () => (await run()).document.steps.length).toBe(size); await settle(); return (await run()).document; }
async function savedBlockSize(size) {
  await expect.poll(async () => (await workspace()).blocks.find(item => item.id === blockId).document.steps.length).toBe(size);
  await settle(); return (await workspace()).blocks.find(item => item.id === blockId);
}
const members = (document, id) => document.steps.filter(item => item.groupId === id);
const lastIndex = (document, id) => document.steps.map(item => item.groupId).lastIndexOf(id);
function identitySet(document) { return new Set([...document.groups.map(g => g.id), ...document.parameters.map(p => p.id), ...document.steps.flatMap(s => [s.id, ...s.commands.map(c => c.id)])]); }
function assertUnique(document) {
  const count = document.groups.length + document.parameters.length + document.steps.reduce((sum, s) => sum + 1 + s.commands.length, 0);
  assert.equal(identitySet(document).size, count);
  for (const item of document.groups) {
    const indices = document.steps.flatMap((s, index) => s.groupId === item.id ? [index] : []);
    assert.ok(indices.length);
    assert.equal(indices.at(-1) - indices[0] + 1, indices.length, 'Each group must stay contiguous');
  }
}
function assertStepCopy(document, original, copy, expectedGroupId, parameterMap = new Map()) {
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.groupId, expectedGroupId);
  const originalOwned = document.parameters.filter(p => p.ownerId === original.id), copiedOwned = document.parameters.filter(p => p.ownerId === copy.id);
  assert.equal(copiedOwned.length, originalOwned.length);
  for (const source of originalOwned) {
    const target = copiedOwned.find(p => p.name === source.name && p.description === source.description && p.defaultValue === source.defaultValue);
    assert.ok(target); assert.notEqual(target.id, source.id); parameterMap.set(source.id, target.id);
  }
  const remap = parts => parts.map(part => typeof part === 'string' ? part : ref(parameterMap.get(part.parameterId) ?? part.parameterId));
  assert.deepEqual(copy.title, remap(original.title));
  assert.deepEqual(copy.description, remap(original.description));
  assert.equal(copy.commands.length, original.commands.length);
  for (let i = 0; i < copy.commands.length; i++) {
    assert.notEqual(copy.commands[i].id, original.commands[i].id);
    assert.deepEqual(copy.commands[i].text, remap(original.commands[i].text));
  }
}
function assertGroupCopy(before, after, originalGroupId, copiedGroupId) {
  const source = members(before, originalGroupId), copied = members(after, copiedGroupId), parameterMap = new Map();
  assert.equal(copied.length, source.length);
  assert.deepEqual(after.groups.find(g => g.id === originalGroupId), before.groups.find(g => g.id === originalGroupId));
  assert.equal(after.groups.find(g => g.id === copiedGroupId).description, before.groups.find(g => g.id === originalGroupId).description);
  const ownerMap = new Map([[originalGroupId, copiedGroupId], ...source.map((s, index) => [s.id, copied[index].id])]);
  const sourceParameters = before.parameters.filter(p => ownerMap.has(p.ownerId));
  for (const parameter of sourceParameters) {
    const duplicate = after.parameters.find(p => p.ownerId === ownerMap.get(parameter.ownerId) && p.name === parameter.name && p.description === parameter.description && p.defaultValue === parameter.defaultValue);
    assert.ok(duplicate); assert.notEqual(duplicate.id, parameter.id); parameterMap.set(parameter.id, duplicate.id);
  }
  for (let i = 0; i < source.length; i++) assertStepCopy(after, source[i], copied[i], copiedGroupId, parameterMap);
  assert.equal(after.steps.findIndex(s => s.groupId === copiedGroupId), lastIndex(after, originalGroupId) + 1);
  for (const s of copied) assert.ok(!identitySet(before).has(s.id));
  assertUnique(after);
}
async function assertNoBottomActions() {
  await expect(page.locator('.document-add-actions')).toHaveCount(0);
  await expect(page.locator('.document-column > .add-step-bottom')).toHaveCount(0);
  await expect(page.locator('.step-number-label, .step-edit-tools, .group-edit-controls')).toHaveCount(0);
  assert.ok(!await page.locator('.workspace-scroll').getByText(/^步骤\s*0\d+$/).count(), 'A step must not retain a second numbered heading');
}

try {
  await mkdir('.artifacts', { recursive: true });
  await page.setViewportSize({ width: 1360, height: 940 });
  await apply({ type: 'create_block', id: blockId, name: 'QA 行侧复用块', document: blockDocument });
  await apply({ type: 'create_template', id: templateId, name: 'QA 步骤行侧操作', document: initialDocument });
  await apply({ type: 'create_template', id: runningTemplateId, name: 'QA 运行中操作来源', document: initialDocument });
  await apply({ type: 'create_instance', id: runId, name: 'QA 当前与未来操作边界', templateId: runningTemplateId, fromInstanceId: null });
  await apply({ type: 'start_instance', id: runId });
  const release = JSON.parse(await readFile('templates/release-maintenance/maintenance.runbook.json', 'utf8'));
  assert.equal(release.document.steps.length, 46);
  await apply({ type: 'create_template', id: longTemplateId, name: 'QA 46 步菜单边界', document: release.document });
  await reload(); await openTemplate();
  await assertNoBottomActions();

  const unchanged = await workspace(), trigger = step('actions-head').getByRole('button', { name: '步骤新增', exact: true });
  await trigger.focus(); await waitTriggerStable(trigger); await trigger.press('Enter');
  await expect(menu()).toBeVisible();
  await expect(menu().getByRole('menuitem')).toHaveCount(basicNames.length);
  await expect(menu().getByRole('menuitem', { name: basicNames[0], exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu().getByRole('menuitem', { name: basicNames[1], exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu().getByRole('menuitem', { name: basicNames.at(-1), exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu().getByRole('menuitem', { name: basicNames[0], exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu()).toHaveCount(0); await expect(trigger).toBeFocused();
  await openActions(step('actions-head'));
  await page.locator('.workspace-title .eyebrow').click();
  await expect(menu()).toHaveCount(0);
  assert.deepEqual(await workspace(), unchanged, 'Opening, keyboard browsing, Escape and outside dismissal must not mutate data');
  await openActions(step('actions-head'), false, true);
  await expect(menu().getByRole('menuitem', { name: '添加命令', exact: true })).toHaveCount(0);
  await expect(menu().getByRole('menuitem', { name: '删除当前步骤', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); assert.deepEqual(await workspace(), unchanged);
  const descriptionDisplay = step('actions-head').locator('[data-inline-field="操作说明"]'); await descriptionDisplay.dblclick();
  const descriptionEditor = step('actions-head').getByRole('textbox', { name: '操作说明', exact: true }); await descriptionEditor.fill('QA 跨字段菜单：未退出编辑的输入必须保存。');
  const adjacentTrigger = step('actions-tail').getByRole('button', { name: '更多步骤操作', exact: true }); await adjacentTrigger.scrollIntoViewIfNeeded(); await waitTriggerStable(adjacentTrigger); await adjacentTrigger.click();
  await expect(menu()).toBeVisible(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const adjacentBounds = await adjacentTrigger.boundingBox(), menuBounds = await menu().boundingBox(); assert.ok(adjacentBounds && menuBounds);
  assert.ok(Math.min(Math.abs(menuBounds.y - adjacentBounds.y), Math.abs(menuBounds.y + menuBounds.height - adjacentBounds.y - adjacentBounds.height), Math.abs(menuBounds.y - 10), Math.abs(menuBounds.y + menuBounds.height - 930)) <= 2, 'Opening another step menu must follow its final anchor after editor collapse');
  await page.keyboard.press('Escape'); await expect.poll(async () => (await template()).document.steps[0].description.join('')).toBe('QA 跨字段菜单：未退出编辑的输入必须保存。'); await settle();
  checks.push('Steps have one number, no standing edit toolbar, three creation items under plus and five existing-object actions under more; deletion occurs only at the separated end of more. Keyboard and dismissal preserve focus and native data');

  let before = (await template()).document;
  await choose(step('actions-head'), '复制当前步骤块');
  let document = await savedTemplateSize(5), headCopy = document.steps[1];
  assertStepCopy(document, before.steps[0], headCopy, undefined);
  assert.deepEqual(document.steps[0], before.steps[0]);
  await choose(step('actions-head'), '新增步骤块');
  document = await savedTemplateSize(6);
  const addedHead = document.steps[1];
  assert.ok(!before.steps.some(s => s.id === addedHead.id));
  assert.ok(!addedHead.groupId); assert.deepEqual(addedHead.commands, []);
  await choose(step(addedHead.id), '转为步骤组');
  await expect.poll(async () => (await template()).document.steps.find(s => s.id === addedHead.id).groupId).toBeTruthy();
  await settle(); document = (await template()).document;
  const convertedGroupId = document.steps.find(s => s.id === addedHead.id).groupId;
  assert.deepEqual(members(document, convertedGroupId).map(s => s.id), [addedHead.id]);

  before = structuredClone(document);
  await choose(step('actions-first'), '复制当前步骤块');
  document = await savedTemplateSize(7);
  const childCopy = document.steps[document.steps.findIndex(s => s.id === 'actions-first') + 1];
  assertStepCopy(document, before.steps.find(s => s.id === 'actions-first'), childCopy, 'actions-player');
  assert.equal(childCopy.title.find(p => typeof p !== 'string').parameterId, 'actions-player-id', 'A copied child keeps its existing group reference');
  await choose(step('actions-first'), '新增步骤块');
  document = await savedTemplateSize(8);
  const addedChild = document.steps[document.steps.findIndex(s => s.id === 'actions-first') + 1];
  assert.equal(addedChild.groupId, 'actions-player'); assert.deepEqual(addedChild.commands, []);
  const beforeHeaderAdd = structuredClone(document), playerMembers = members(document, 'actions-player').map(s => s.id);
  await choose(group('actions-player'), '新增步骤块', true);
  document = await savedTemplateSize(9);
  const outside = document.steps[lastIndex(document, 'actions-player') + 1];
  assert.ok(!outside.groupId); assert.ok(!beforeHeaderAdd.steps.some(s => s.id === outside.id));
  assert.deepEqual(members(document, 'actions-player').map(s => s.id), playerMembers);
  const beforeChildAdd = structuredClone(document);
  await choose(group('actions-player'), '添加子步骤', true); document = await savedTemplateSize(10);
  const appendedChild = members(document, 'actions-player').at(-1);
  assert.ok(!beforeChildAdd.steps.some(s => s.id === appendedChild.id)); assert.deepEqual(appendedChild.commands, []);
  assert.deepEqual(members(document, 'actions-player').slice(0, -1).map(s => s.id), playerMembers);
  await choose(step(appendedChild.id), '删除当前步骤'); document = await savedTemplateSize(9); assert.deepEqual(document, beforeChildAdd);
  checks.push('Template actions insert immediately after the selected step; a child stays in its group, a group-header addition goes after the whole group, and only copied step-owned parameters receive fresh IDs');

  before = structuredClone(document);
  await choose(group('actions-player'), '复制当前步骤块', true);
  document = await savedTemplateSize(13);
  const copiedGroup = document.groups.find(g => !before.groups.some(old => old.id === g.id));
  assert.ok(copiedGroup); assertGroupCopy(before, document, 'actions-player', copiedGroup.id);
  const groupBeforeInsert = members(document, 'actions-player').map(s => s.id);
  await chooseBlock(step('actions-first'));
  document = await savedTemplateSize(15);
  const inserted = document.groups.find(g => g.sourceBlockId === blockId);
  assert.ok(inserted);
  assert.equal(document.steps.findIndex(s => s.groupId === inserted.id), lastIndex(document, 'actions-player') + 1);
  assert.deepEqual(members(document, 'actions-player').map(s => s.id), groupBeforeInsert, 'Inserting from a child must never split its existing group');
  assert.equal(members(document, inserted.id).length, 2);
  assert.equal(document.parameters.find(p => p.ownerId === inserted.id).defaultValue, 'sandboxa');
  assertUnique(document); await assertNoBottomActions();
  const beforeMoves = structuredClone(document), childIndex = document.steps.findIndex(s => s.id === childCopy.id);
  await choose(step(childCopy.id), '上移步骤'); await expect.poll(async () => (await template()).document.steps.findIndex(s => s.id === childCopy.id)).toBe(childIndex - 1); await settle();
  await choose(step(childCopy.id), '下移步骤'); await expect.poll(async () => (await template()).document.steps.findIndex(s => s.id === childCopy.id)).toBe(childIndex); await settle(); assert.deepEqual((await template()).document, beforeMoves);
  const groupIndex = document.steps.findIndex(s => s.groupId === 'actions-player');
  await choose(group('actions-player'), '上移步骤组', true); await expect.poll(async () => (await template()).document.steps.findIndex(s => s.groupId === 'actions-player')).not.toBe(groupIndex); await settle();
  await choose(group('actions-player'), '下移步骤组', true); await expect.poll(async () => (await template()).document.steps.findIndex(s => s.groupId === 'actions-player')).toBe(groupIndex); await settle(); assert.deepEqual((await template()).document, beforeMoves);
  await choose(group('actions-player'), '保存为步骤块', true);
  const saveDialog = page.getByRole('dialog', { name: '保存为步骤块', exact: true }); await saveDialog.getByRole('textbox', { name: '步骤块名称', exact: true }).fill('QA 统一菜单保存块'); await saveDialog.getByRole('button', { name: '保存步骤块', exact: true }).click(); await expect(saveDialog).toHaveCount(0);
  assert.ok((await workspace()).blocks.some(item => item.name === 'QA 统一菜单保存块'));
  await choose(group(copiedGroup.id), '删除步骤组及子步骤', true); document = await savedTemplateSize(11);
  assert.ok(!document.groups.some(g => g.id === copiedGroup.id)); assert.ok(!document.steps.some(s => s.groupId === copiedGroup.id));
  assert.deepEqual(members(document, 'actions-player'), members(beforeMoves, 'actions-player')); assert.deepEqual(members(document, inserted.id), members(beforeMoves, inserted.id)); assertUnique(document);
  await page.screenshot({ path: '.artifacts/step-actions-template.png' });
  checks.push('A group-header copy duplicates the complete contiguous group next to its source with fresh local identities; inserting a library block from a child places a self-contained group after the complete source group');

  await reload(); await page.locator(`[data-instance-id="${runId}"]`).click();
  await expect(step('actions-head')).toHaveClass(/is-current/);
  const originalRun = await run();
  const currentTrigger = await openActions(step('actions-head'));
  await expect(menu().getByRole('menuitem', { name: '添加命令', exact: true })).toBeEnabled();
  await expect(menu().getByRole('menuitem', { name: '删除当前步骤', exact: true })).toHaveCount(0);
  await page.keyboard.press('End'); await expect(menu().getByRole('menuitem', { name: '插入步骤块', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await expect(menu().getByRole('menuitem', { name: '新增后续步骤', exact: true })).toBeFocused(); await page.keyboard.press('Escape'); await expect(currentTrigger).toBeFocused();
  await openActions(step('actions-head'), false, true);
  const deleteCurrent = menu().getByRole('menuitem', { name: '删除当前步骤', exact: true }); await expect(deleteCurrent).toBeDisabled(); assert.ok(await deleteCurrent.getAttribute('title'));
  const convertCurrent = menu().getByRole('menuitem', { name: '转为步骤组', exact: true });
  await expect(convertCurrent).toBeDisabled();
  assert.ok(await convertCurrent.getAttribute('title'), 'A disabled action must explain why');
  for (const name of ['上移步骤', '下移步骤']) {
    const item = menu().getByRole('menuitem', { name, exact: true });
    await expect(item).toBeDisabled(); assert.ok(await item.getAttribute('title'), 'The current execution position cannot move or be deleted');
  }
  await page.keyboard.press('End');
  await expect(menu().getByRole('menuitem', { name: '复制当前步骤', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu().getByRole('menuitem', { name: '复制当前步骤', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(step('actions-head').getByRole('button', { name: '更多步骤操作', exact: true })).toBeFocused();
  const futureTrigger = await openActions(step('actions-tail'), false, true);
  await expect(menu().getByRole('menuitem', { name: '删除当前步骤', exact: true })).toBeEnabled();
  await page.keyboard.press('End');
  await expect(menu().getByRole('menuitem', { name: '删除当前步骤', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu().getByRole('menuitem', { name: '复制当前步骤', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(menu()).toHaveCount(0); await expect(futureTrigger).toBeFocused();
  assert.deepEqual(await run(), originalRun, 'Browsing the expanded instance action menu must not edit commands, steps or execution data');
  checks.push('Instance creation menus have three items and more menus have five; current delete/move/convert boundaries remain disabled with reasons, Home/End skip them, and browsing leaves execution data unchanged');
  await choose(step('actions-head'), '复制当前步骤块');
  document = await savedRunSize(5);
  assertStepCopy(document, originalRun.document.steps[0], document.steps[1], undefined);
  await choose(step('actions-head'), '新增步骤块');
  document = await savedRunSize(6); assert.ok(!document.steps[1].groupId);
  await chooseBlock(step('actions-head'));
  document = await savedRunSize(8);
  const runningInserted = document.groups.find(g => g.sourceBlockId === blockId);
  assert.equal(document.steps[1].groupId, runningInserted.id);
  let currentRun = await run();
  assert.equal(currentRun.currentStepId, 'actions-head');
  assert.deepEqual(currentRun.entries, []);
  assert.deepEqual(currentRun.document.steps[0], originalRun.document.steps[0]);
  await step('actions-head').getByRole('button', { name: '完成并下一步', exact: true }).click();
  await expect.poll(async () => (await run()).currentStepId).toBe(document.steps[1].id);
  await settle();
  const advanced = await run(), currentId = advanced.currentStepId, currentGroupId = advanced.document.steps.find(s => s.id === currentId).groupId;
  await expect(step('actions-head').getByRole('button', { name: '步骤新增', exact: true })).toHaveCount(0);
  await expect(step('actions-head').getByRole('button', { name: '更多步骤操作', exact: true })).toHaveCount(0);
  const frozenEntries = structuredClone(advanced.entries), oldCurrentMembers = members(advanced.document, currentGroupId).map(s => s.id);

  await chooseBlock(step(currentId));
  document = await savedRunSize(10);
  const newInserted = document.groups.find(g => !advanced.document.groups.some(old => old.id === g.id));
  assert.ok(newInserted);
  assert.equal(document.steps.findIndex(s => s.groupId === newInserted.id), lastIndex(document, currentGroupId) + 1);
  assert.deepEqual(members(document, currentGroupId).map(s => s.id), oldCurrentMembers);
  await choose(step('actions-tail'), '转为步骤组');
  await expect.poll(async () => (await run()).document.steps.find(s => s.id === 'actions-tail').groupId).toBeTruthy();
  await settle();
  await choose(step(currentId), '复制当前步骤块');
  document = await savedRunSize(11);
  const currentCopy = document.steps[document.steps.findIndex(s => s.id === currentId) + 1];
  assertStepCopy(document, advanced.document.steps.find(s => s.id === currentId), currentCopy, currentGroupId);
  await choose(step(currentId), '新增步骤块');
  document = await savedRunSize(12);
  assert.equal(document.steps[document.steps.findIndex(s => s.id === currentId) + 1].groupId, currentGroupId);
  currentRun = await run();
  assert.equal(currentRun.currentStepId, currentId); assert.equal(currentRun.status, 'in_progress');
  assert.deepEqual(currentRun.entries, frozenEntries, 'Structural actions must not rewrite advanced results or snapshots');
  assert.deepEqual(currentRun.document.steps[0], originalRun.document.steps[0]);
  assert.deepEqual((await template(runningTemplateId)).document, originalRun.document, 'Instance editing never changes the source template');
  assertUnique(document); await assertNoBottomActions();
  checks.push('Current-instance menus allow add/copy/insert without moving the cursor, prohibit regrouping with a reason, hide advanced-step plus controls, allow a future step to become a group and preserve the exact advanced snapshot');

  await step(currentId).getByRole('button', { name: '记录失败', exact: true }).click();
  const failedDialog = page.getByRole('dialog', { name: '记录失败', exact: true });
  await failedDialog.getByRole('textbox', { name: '失败原因', exact: true }).fill('QA：验证结构复制不改变当前失败记录。');
  await failedDialog.getByRole('button', { name: '保存失败记录', exact: true }).click();
  await expect(failedDialog).toHaveCount(0); await settle();
  const failed = await run();
  await choose(step(currentId), '复制当前步骤块');
  document = await savedRunSize(13);
  currentRun = await run();
  assert.equal(currentRun.currentStepId, currentId); assert.deepEqual(currentRun.entries, failed.entries);
  assert.equal(currentRun.entries.at(-1).outcome, 'failed');
  await page.screenshot({ path: '.artifacts/step-actions-instance.png' });
  checks.push('A current failed step still supports structural copying; its failure reason, command/parameter snapshot and earlier outcome remain immutable');
  await apply({ type: 'record_result', id: runId, outcome: 'completed', reason: null }); await reload(); await page.locator(`[data-instance-id="${runId}"]`).click();
  const partial = await run(); await page.locator(`[data-nav-step-id="${partial.currentStepId}"]`).click();
  await openActions(group(currentGroupId), true); await expect(menu().getByRole('menuitem', { name: '添加子步骤', exact: true })).toBeEnabled();
  await expect(menu().getByRole('menuitem', { name: '删除步骤组及子步骤', exact: true })).toHaveCount(0); await page.keyboard.press('Escape');
  await openActions(group(currentGroupId), true, true);
  await expect(menu().getByRole('menuitem', { name: '删除步骤组及子步骤', exact: true })).toBeDisabled();
  for (const name of ['上移步骤组', '下移步骤组']) { const item = menu().getByRole('menuitem', { name, exact: true }); await expect(item).toBeDisabled(); assert.ok(await item.getAttribute('title')); }
  await expect(menu().getByRole('menuitem', { name: '保存为步骤块', exact: true })).toBeEnabled(); await page.keyboard.press('Escape'); assert.deepEqual(await run(), partial);
  checks.push('A partially advanced group keeps legal future additions and save-as-block, but whole-group movement/deletion remain disabled and menu inspection preserves every result');

  const beforeBlockEdit = await workspace();
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '步骤块' }).click();
  await page.locator(`[data-block-id="${blockId}"] .tile-open`).click();
  await expect(page.locator('[data-inline-field="步骤块名称"]')).toHaveText('QA 行侧复用块');
  await assertNoBottomActions();
  await openActions(group('actions-block-group'), true);
  await expect(menu().getByRole('menuitem', { name: '添加子步骤', exact: true })).toBeEnabled();
  for (const name of ['组后新增步骤', '组后插入步骤块']) {
    const item = menu().getByRole('menuitem', { name, exact: true });
    await expect(item).toBeDisabled(); assert.ok(await item.getAttribute('title'), 'Disabled block-definition actions explain their boundary');
  }
  await page.keyboard.press('Escape'); await expect(menu()).toHaveCount(0);
  await openActions(group('actions-block-group'), true, true);
  for (const name of ['复制步骤组', '上移步骤组', '下移步骤组', '删除步骤组及子步骤']) { const item = menu().getByRole('menuitem', { name, exact: true }); await expect(item).toBeDisabled(); assert.ok(await item.getAttribute('title')); }
  await page.keyboard.press('Escape');
  await openActions(step('actions-block-step-0'));
  for (const name of ['新增后续步骤', '添加命令']) await expect(menu().getByRole('menuitem', { name, exact: true })).toBeEnabled();
  for (const name of ['插入步骤块']) {
    const item = menu().getByRole('menuitem', { name, exact: true });
    await expect(item).toBeDisabled(); assert.ok(await item.getAttribute('title'));
  }
  await page.keyboard.press('Escape'); await expect(menu()).toHaveCount(0);
  await openActions(step('actions-block-step-0'), false, true); await expect(menu().getByRole('menuitem', { name: '复制当前步骤', exact: true })).toBeEnabled(); await expect(menu().getByRole('menuitem', { name: '删除当前步骤', exact: true })).toBeEnabled(); await expect(menu().getByRole('menuitem', { name: '转为步骤组', exact: true })).toBeDisabled(); await page.keyboard.press('Escape');
  const originalBlock = (await workspace()).blocks.find(item => item.id === blockId);
  await choose(step('actions-block-step-0'), '复制当前步骤块');
  let editedBlock = await savedBlockSize(3);
  const blockStepCopy = editedBlock.document.steps[1];
  assertStepCopy(editedBlock.document, originalBlock.document.steps[0], blockStepCopy, 'actions-block-group');
  await choose(step('actions-block-step-0'), '新增步骤块');
  editedBlock = await savedBlockSize(4);
  assert.equal(editedBlock.kind, 'block');
  assert.equal(editedBlock.document.groups.length, 1);
  assert.equal(editedBlock.document.groups[0].id, 'actions-block-group');
  assert.equal(editedBlock.document.steps[1].groupId, 'actions-block-group');
  assert.deepEqual(editedBlock.document.steps[1].commands, []);
  assert.deepEqual(editedBlock.document.steps.map(item => item.id), ['actions-block-step-0', editedBlock.document.steps[1].id, blockStepCopy.id, 'actions-block-step-1']);
  assert.ok(editedBlock.document.steps.every(item => item.groupId === 'actions-block-group'));
  assertUnique(editedBlock.document);
  const allowedOwners = new Set(['actions-block-group', ...editedBlock.document.steps.map(item => item.id)]);
  assert.ok(editedBlock.document.parameters.every(parameter => parameter.ownerId && allowedOwners.has(parameter.ownerId)));
  for (const source of editedBlock.document.steps) {
    const allowed = new Set(editedBlock.document.parameters.filter(parameter => parameter.ownerId === source.groupId || parameter.ownerId === source.id).map(parameter => parameter.id));
    for (const parts of [source.title, source.description, ...source.commands.map(command => command.text)]) {
      for (const part of parts) if (typeof part !== 'string') assert.ok(allowed.has(part.parameterId), 'Block-definition copies must retain valid local references');
    }
  }
  const afterBlockEdit = await workspace();
  assert.deepEqual(afterBlockEdit.templates, beforeBlockEdit.templates);
  assert.deepEqual(afterBlockEdit.instances, beforeBlockEdit.instances, 'Editing a library block must not change any inserted template/instance copy or its history');
  for (const id of editedBlock.document.steps.slice(1).map(item => item.id)) await choose(step(id), '删除当前步骤');
  editedBlock = await savedBlockSize(1); assert.equal(editedBlock.document.groups.length, 1); assert.equal(editedBlock.document.steps[0].id, 'actions-block-step-0');
  await openActions(step('actions-block-step-0'), false, true); const lastDelete = menu().getByRole('menuitem', { name: '删除当前步骤', exact: true }); await expect(lastDelete).toBeDisabled(); assert.ok(await lastDelete.getAttribute('title')); await page.keyboard.press('Escape');
  assert.deepEqual((await workspace()).templates, beforeBlockEdit.templates); assert.deepEqual((await workspace()).instances, beforeBlockEdit.instances);
  await page.screenshot({ path: '.artifacts/step-actions-block-definition.png' });
  checks.push('Block-definition header menus prevent copying/inserting/regrouping the whole definition; child menus add/copy within its one group using fresh IDs and valid local references, without changing existing template or instance uses');

  await openTemplate(longTemplateId); await page.setViewportSize({ width: 940, height: 640 });
  const last = step(release.document.steps.at(-1).id), lastTrigger = last.getByRole('button', { name: '步骤新增', exact: true });
  await lastTrigger.focus();
  await lastTrigger.evaluate(button => {
    const root = document.querySelector('.workspace-scroll');
    const top = button.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top: Math.max(0, top - root.clientHeight + 72), behavior: 'instant' });
  });
  await waitTriggerStable(lastTrigger);
  const beforeLongMenu = await workspace();
  await lastTrigger.click(); await expect(menu()).toBeVisible();
  await expect(menu().getByRole('menuitem')).toHaveCount(basicNames.length);
  const geometry = await menu().evaluate(element => {
    const bounds = element.getBoundingClientRect(), trigger = document.activeElement?.getBoundingClientRect();
    const root = document.querySelector('.workspace-scroll'), app = document.querySelector('.checklist-app').getBoundingClientRect();
    return { menu: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      viewport: { width: innerWidth, height: innerHeight, scrollY }, root: { scrollTop: root.scrollTop, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight },
      app: { top: app.top, right: app.right }, focused: trigger ? { top: trigger.top, bottom: trigger.bottom } : null };
  });
  await writeFile('.artifacts/step-actions-menu-geometry.json', JSON.stringify(geometry, null, 2), 'utf8');
  await page.screenshot({ path: '.artifacts/step-actions-menu-bottom.png' });
  assert.equal(geometry.viewport.scrollY, 0); assert.equal(geometry.app.top, 0);
  assert.ok(geometry.root.scrollTop > 0, 'The 46-step template must genuinely be scrolled to its end region');
  assert.ok(geometry.menu.left >= 0 && geometry.menu.top >= 0 && geometry.menu.right <= 941 && geometry.menu.bottom <= 641, 'The complete menu must stay inside the 940 × 640 viewport');
  for (const item of await menu().getByRole('menuitem').all()) {
    const bounds = await item.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 641);
  }
  await page.keyboard.press('Escape'); await expect(menu()).toHaveCount(0); await expect(lastTrigger).toBeFocused();
  assert.deepEqual(await workspace(), beforeLongMenu);
  const moreTrigger = await openActions(last, false, true);
  await page.keyboard.press('End'); await expect(menu().getByRole('menuitem', { name: '删除当前步骤', exact: true })).toBeFocused();
  const moreBounds = await menu().boundingBox(); assert.ok(moreBounds && moreBounds.y >= 0 && moreBounds.x >= 0 && moreBounds.x + moreBounds.width <= 941 && moreBounds.y + moreBounds.height <= 641);
  await page.screenshot({ path: '.artifacts/step-actions-more-bottom.png' });
  await page.keyboard.press('Escape'); await expect(moreTrigger).toBeFocused(); assert.deepEqual(await workspace(), beforeLongMenu);
  await assertNoBottomActions(); await settle();
  await expect(page.getByRole('alert')).toHaveCount(0); assert.deepEqual(pageErrors, []);
  checks.push('At the end of the real 46-step template on a 940 × 640 viewport, every menu item fits on screen, Escape restores the trigger, the page root stays fixed and redundant bottom action containers do not exist');
  const result = { ok: true, isolatedDataDirectory: actualDirectory, checks, pageErrors, templateId, runId, blockId, longTemplateId,
    viewport: { width: 940, height: 640 }, clipboardTouched: false, maintenanceCommandsExecuted: false };
  await writeFile('.artifacts/step-actions-scroll-diagnostics.json', JSON.stringify(await menuDiagnostics(), null, 2), 'utf8');
  await writeFile('.artifacts/step-actions-check.json', JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  const state = await page.evaluate(() => ({ saveState: document.querySelector('.save-state')?.textContent,
    alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
    menus: [...document.querySelectorAll('[role="menu"]')].map(element => ({ text: element.textContent, items: [...element.querySelectorAll('[role="menuitem"]')].map(item => ({ text: item.textContent, disabled: item.disabled, title: item.title })) })),
  })).catch(reason => ({ unavailable: String(reason) }));
  const diagnostics = await menuDiagnostics();
  await writeFile('.artifacts/step-actions-scroll-diagnostics.json', JSON.stringify(diagnostics, null, 2), 'utf8').catch(() => {});
  await writeFile('.artifacts/step-actions-failure.json', JSON.stringify({ checks, pageErrors, error: String(error), state, diagnostics, workspace: await workspace().catch(() => null) }, null, 2), 'utf8').catch(() => {});
  await page.screenshot({ path: '.artifacts/step-actions-failure.png' }).catch(() => {});
  throw error;
} finally { await browser.close(); }
