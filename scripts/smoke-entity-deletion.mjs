import { openCommentComposer } from './step-materials.mjs';
// node scripts/check-desktop.mjs scripts/smoke-entity-deletion.mjs
// Only harness-owned records/files are deleted. No clipboard or command execution.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && process.env.RUNBOOK_DATA_DIR === directory && process.env.RUNBOOK_CDP_URL);
const actual = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase()); assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actual}`));
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(15000);
const checks = [], deleted = [], pageErrors = [], consoleMessages = []; page.on('pageerror', error => pageErrors.push(error.message));
const confirmationScreenshots = new Set(); let rootInvariantChecks = 0;
page.on('console', message => { if (!['warning', 'error'].includes(message.type())) return; consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() }); if (consoleMessages.length > 200) consoleMessages.shift(); });
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), workspace = () => native('checklist_load');
const templateId = 'qa-entity-deletion-template', blockId = 'qa-entity-deletion-block', liveId = 'qa-entity-delete-live', keepId = 'qa-entity-delete-survivor';
const collection = { template: 'templates', block: 'blocks', instance: 'instances' }, labels = { template: '模板', block: '步骤块', instance: '实例' };
const item = async (kind, id) => (await workspace())[collection[kind]].find(value => value.id === id);
const step = id => page.locator(`[data-step-id="${id}"]`), panel = () => page.getByRole('complementary', { name: '变量面板', exact: true });
const firstId = 'deletion-first', imagePath = path.resolve('docs/examples/patch-maintenance/images/package-check-demo.png'), imageBytes = await readFile(imagePath);
const definition = (prefix, sourceBlockId) => ({ groups: [{ id: `${prefix}-group`, name: '独立使用副本', ...(sourceBlockId ? { sourceBlockId } : {}) }], parameters: [{ id: `${prefix}-env`, ownerId: `${prefix}-group`, name: '环境', description: '', defaultValue: 'release' }], steps: [
  { id: prefix === 'deletion' ? firstId : `${prefix}-first`, groupId: `${prefix}-group`, title: ['开始核验'], description: ['只记录，不执行命令。'], commands: [{ id: `${prefix}-command`, text: ['echo ', { parameterId: `${prefix}-env` }] }] },
  { id: `${prefix}-last`, groupId: `${prefix}-group`, title: ['结束核验'], description: [''], commands: [] },
] });
const cases = [
  { id: 'qa-entity-delete-draft', state: 'draft' },
  { id: 'qa-entity-delete-completed', state: 'completed' },
  { id: 'qa-entity-delete-terminated', state: 'terminated' },
  { id: 'qa-entity-delete-archived-completed', state: 'completed', archived: true },
  { id: 'qa-entity-delete-archived-terminated', state: 'terminated', archived: true },
];
async function installDiagnostics() {
  await page.evaluate(() => {
    const diagnostics = { timeline: [] };
    function counts() { return { roots: document.querySelectorAll('#root').length, apps: document.querySelectorAll('.checklist-app').length, mains: document.querySelectorAll('.app-main').length, workspaces: document.querySelectorAll('.workspace-page').length, dialogs: document.querySelectorAll('[role="dialog"]').length }; }
    function describe(node) {
      if (!(node instanceof Element)) return { node: node?.nodeName ?? null };
      const r = node.getBoundingClientRect(), main = node.closest('.app-main');
      return { tag: node.tagName, id: node.id, className: typeof node.className === 'string' ? node.className : node.className?.baseVal, label: node.getAttribute('aria-label'), inlineField: node.closest('[data-inline-field]')?.getAttribute('data-inline-field'), connected: node.isConnected, mainIndex: main ? [...document.querySelectorAll('.app-main')].indexOf(main) : null, text: node.textContent?.slice(0, 120), rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
    }
    diagnostics.record = (type, target) => {
      diagnostics.timeline.push({ at: performance.now(), type, target: describe(target), active: describe(document.activeElement), counts: counts(), openDetails: [...document.querySelectorAll('details.more-menu[open]')].map(describe), dialogs: [...document.querySelectorAll('[role="dialog"]')].map(describe) });
      if (diagnostics.timeline.length > 300) diagnostics.timeline.splice(0, diagnostics.timeline.length - 300);
    };
    window.__entityDeletionDiagnostics = diagnostics;
    for (const name of ['focusin', 'focusout', 'pointerdown', 'pointerup', 'click', 'toggle']) document.addEventListener(name, event => diagnostics.record(name, event.target), true);
    let previous = JSON.stringify(counts());
    new MutationObserver(() => { const current = JSON.stringify(counts()); if (current !== previous) { previous = current; diagnostics.record('root-main-count-change', document.body); } }).observe(document.body, { childList: true, subtree: true });
    diagnostics.record('diagnostics-installed', document.activeElement);
  });
}
async function reload() { await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor(); await installDiagnostics(); }
async function assertSingleRoot(stage) {
  assert.equal(await page.locator('.checklist-app').count(), 1, `${stage}: exactly one application root must exist immediately`);
  assert.equal(await page.locator('.app-main').count(), 1, `${stage}: exactly one main page must exist immediately`);
  rootInvariantChecks++;
}
async function nav(name) { await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: name }).click(); }
async function saved(predicate) { await expect.poll(predicate).toBe(true); await expect(page.locator('.save-state')).toContainText('已保存在本机'); }
async function open(kind, id) {
  await assertSingleRoot(`before open ${kind}:${id}`);
  const value = await item(kind, id); assert.ok(value);
  await nav(kind === 'instance' ? value.archivedAt ? '归档' : '当前工作' : labels[kind]);
  const tile = page.locator(`[data-${kind}-id="${id}"]`); await (kind === 'instance' ? tile : tile.locator('.tile-open')).click();
  await assertSingleRoot(`open ${kind}:${id}`);
  await expect(page.locator(`[data-inline-field="${kind === 'instance' ? '实例名称' : kind === 'block' ? '步骤块名称' : '模板名称'}"]`)).toBeVisible();
  await page.locator(`[data-nav-step-id="${value.document.steps[0].id}"]`).click(); await expect(panel()).toHaveAttribute('data-variable-target-step-id', value.document.steps[0].id);
}
async function deletionEntry(kind) {
  const more = page.getByLabel('更多操作', { exact: true }); await more.click();
  await page.getByRole('button', { name: `删除${labels[kind]}`, exact: true }).click();
  await assertSingleRoot(`delete entry ${kind}`);
}
async function dialogFor(kind, id) {
  await deletionEntry(kind); const dialog = page.getByRole('dialog', { name: `删除${labels[kind]}`, exact: true }); await expect(dialog).toBeVisible();
  await assertSingleRoot(`confirmation ${kind}:${id}`);
  if (!confirmationScreenshots.has(kind)) { await page.screenshot({ path: `.artifacts/entity-deletion-confirm-${kind}.png` }); confirmationScreenshots.add(kind); }
  await expect(dialog).toContainText((await item(kind, id)).name); await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused(); return dialog;
}
async function cancelAndVerify(kind, id, escape = false) {
  const before = await workspace(), dialog = await dialogFor(kind, id);
  await page.keyboard.press('Tab'); assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), 'Tab must remain inside deletion confirmation');
  if (escape) await page.keyboard.press('Escape'); else await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0); await assertSingleRoot(`cancel confirmation ${kind}:${id}`); assert.deepEqual(await workspace(), before, 'Cancelling confirmation must not write or remove any artifact');
}
async function remove(kind, id) {
  const dialog = await dialogFor(kind, id); await dialog.getByRole('button', { name: `确认删除${labels[kind]}`, exact: true }).click(); await assertSingleRoot(`after confirm click ${kind}:${id}`); await expect(dialog).toHaveCount(0);
  await expect.poll(async () => Boolean(await item(kind, id))).toBe(false); await expect(page.locator('.library-page')).toBeVisible(); await assertSingleRoot(`deleted ${kind}:${id}`); await expect(page.locator(`[data-${kind}-id="${id}"]`)).toHaveCount(0); deleted.push({ kind, id });
}
async function dismissGuard() { await page.getByRole('alert').getByRole('button', { name: '关闭提示', exact: true }).click(); await expect(page.getByRole('alert')).toHaveCount(0); }
function registeredPath(instanceId, relative) {
  assert.match(relative, /^images\/[A-Za-z0-9_.-]+$/); const root = path.resolve(actual, 'checklist-images', instanceId), result = path.resolve(root, ...relative.split('/'));
  assert.ok(result.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)); return result;
}
async function imageEntry(id) { const value = await item('instance', id); return value.entries.find(entry => entry.type === 'image'); }

try {
  await mkdir('.artifacts', { recursive: true }); await page.setViewportSize({ width: 1360, height: 940 });
  await apply({ type: 'create_block', id: blockId, name: 'QA 删除复用源块', document: definition('deletion-block') });
  await apply({ type: 'create_template', id: templateId, name: 'QA 删除源模板', document: definition('deletion', blockId) });
  for (const id of [keepId, liveId, ...cases.map(value => value.id)]) await apply({ type: 'create_instance', id, name: id, templateId, fromInstanceId: null });
  for (const id of [keepId, liveId]) await apply({ type: 'start_instance', id });
  await apply({ type: 'record_result', id: liveId, outcome: 'failed', reason: 'QA 真实人工记录，供删除实例验证。' });
  for (const value of cases) {
    if (value.state !== 'draft') await apply({ type: 'start_instance', id: value.id });
    if (value.state === 'completed') { await apply({ type: 'record_result', id: value.id, outcome: 'completed', reason: null }); await apply({ type: 'record_result', id: value.id, outcome: 'completed', reason: null }); }
    if (value.state === 'terminated') await apply({ type: 'terminate_instance', id: value.id, reason: 'QA 删除终止实例。' });
    if (value.archived) await apply({ type: 'archive_instance', id: value.id, archived: true });
  }
  await reload(); await open('instance', liveId);
  const valueInput = panel().locator('input[data-parameter-id="deletion-env"]'), originalLive = await item('instance', liveId);
  await valueInput.fill('PENDING-PARAMETER'); await deletionEntry('instance'); await expect(page.getByRole('dialog', { name: '删除实例', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('未提交的输入'); await expect(valueInput).toHaveValue('PENDING-PARAMETER'); assert.deepEqual(await item('instance', liveId), originalLive); await dismissGuard();
  await panel().getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await openCommentComposer(step(firstId));
  const comment = step(firstId).getByRole('textbox', { name: '添加评论', exact: true }); await comment.fill('PENDING-COMMENT'); await deletionEntry('instance');
  await expect(page.getByRole('dialog', { name: '删除实例', exact: true })).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('未提交的输入'); await expect(comment).toHaveValue('PENDING-COMMENT'); assert.deepEqual(await item('instance', liveId), originalLive); await dismissGuard();
  await comment.fill('已提交的评论应随本实例删除。'); await step(firstId).getByRole('button', { name: '添加评论', exact: true }).click(); await saved(async () => (await item('instance', liveId)).entries.some(entry => entry.type === 'comment'));
  await step(firstId).locator('input[type=file]').setInputFiles(imagePath); await expect(step(firstId).locator('.image-preview img')).toBeVisible();
  const liveImage = await imageEntry(liveId); assert.ok(liveImage); const liveImagePath = registeredPath(liveId, liveImage.path); assert.deepEqual(await readFile(liveImagePath), imageBytes);
  const sentinel = path.join(path.dirname(liveImagePath), 'qa-unregistered.keep'); await writeFile(sentinel, 'QA unregistered file must remain', 'utf8');
  await cancelAndVerify('instance', liveId); await cancelAndVerify('instance', liveId, true); assert.deepEqual(await readFile(liveImagePath), imageBytes);
  checks.push('Target parameter/comment drafts block deletion without losing input or changing storage; Cancel/Escape confirmation preserve complete failed records, comments, images and all artifacts, with default cancel focus and trapped Tab');

  await open('instance', keepId); await step(firstId).locator('input[type=file]').setInputFiles(imagePath); await expect(step(firstId).locator('.image-preview img')).toBeVisible();
  const keepImage = await imageEntry(keepId); assert.ok(keepImage); const keepImagePath = registeredPath(keepId, keepImage.path); assert.deepEqual(await readFile(keepImagePath), imageBytes);
  await openCommentComposer(step(firstId));
  await step(firstId).getByRole('textbox', { name: '添加评论', exact: true }).fill('OTHER-OBJECT-DRAFT');
  const keepBefore = await item('instance', keepId), templateBefore = await item('template', templateId), blockBefore = await item('block', blockId);
  await open('instance', liveId); await remove('instance', liveId); await assert.rejects(readFile(liveImagePath), { code: 'ENOENT' }); assert.equal(await readFile(sentinel, 'utf8'), 'QA unregistered file must remain');
  assert.deepEqual(await readFile(keepImagePath), imageBytes); assert.deepEqual(await item('instance', keepId), keepBefore); assert.deepEqual(await item('template', templateId), templateBefore); assert.deepEqual(await item('block', blockId), blockBefore);
  await open('instance', keepId); await openCommentComposer(step(firstId)); await expect(step(firstId).getByRole('textbox', { name: '添加评论', exact: true })).toHaveValue('OTHER-OBJECT-DRAFT'); await step(firstId).getByRole('textbox', { name: '添加评论', exact: true }).fill('');
  checks.push('Deleting a running instance removes its document/parameters/failure/comment/registered image while preserving unregistered files, another instance image and its pending comment, the source template and the block definition');

  for (const value of cases) { await open('instance', value.id); const stored = await item('instance', value.id); assert.equal(stored.status, value.state); assert.equal(Boolean(stored.archivedAt), Boolean(value.archived)); await remove('instance', value.id); assert.deepEqual(await item('instance', keepId), keepBefore); assert.deepEqual(await item('template', templateId), templateBefore); }
  checks.push('Detail deletion also returns to the correct list for draft, completed, terminated and both archived completed/terminated instances without touching the surviving independent instance');

  await open('template', templateId); await panel().getByRole('button', { name: '新增步骤组变量', exact: true }).click(); const definitionForm = page.getByRole('dialog', { name: '新增变量', exact: true }); await definitionForm.getByRole('textbox', { name: '变量名称', exact: true }).fill('UNSUBMITTED-DEFINITION');
  await deletionEntry('template'); await expect(page.getByRole('dialog', { name: '删除模板', exact: true })).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('未提交的输入'); await expect(definitionForm).toBeVisible(); assert.deepEqual(await item('template', templateId), templateBefore); await dismissGuard(); await definitionForm.getByRole('button', { name: '取消', exact: true }).click();
  await cancelAndVerify('template', templateId); await page.screenshot({ path: '.artifacts/entity-deletion-template-survivor.png' });
  await open('block', blockId); await cancelAndVerify('block', blockId); await remove('block', blockId);
  assert.deepEqual(await item('template', templateId), templateBefore); assert.deepEqual(await item('instance', keepId), keepBefore); assert.equal((await item('template', templateId)).document.groups[0].sourceBlockId, blockId);
  await open('template', templateId); await remove('template', templateId); const survivor = await item('instance', keepId); assert.deepEqual(survivor, keepBefore); assert.equal(survivor.sourceTemplateId, templateId); assert.equal(survivor.document.groups[0].sourceBlockId, blockId); assert.deepEqual(await readFile(keepImagePath), imageBytes);
  checks.push('An unsubmitted variable-definition form prevents deleting its template; template/block cancellation is zero-write, and confirming either definition deletion retains existing instance/inserted document copies and their original source identities');

  const afterDeletion = await workspace(); await reload(); assert.deepEqual(await workspace(), afterDeletion);
  await open('instance', keepId); await expect(step(firstId).locator('.image-preview img')).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0); assert.deepEqual(pageErrors, []);
  assert.deepEqual(Buffer.from((await native('checklist_read_image', { instanceId: keepId, path: keepImage.path })).split(',')[1], 'base64'), imageBytes);
  for (const value of deleted) assert.equal(await item(value.kind, value.id), undefined); await page.screenshot({ path: '.artifacts/entity-deletion-surviving-instance.png' });
  const result = { ok: true, isolatedDataDirectory: actual, templateId, blockId, liveId, keepId, deleted, checks, pageErrors, rootInvariantChecks, confirmationScreenshots: [...confirmationScreenshots], registeredDeletedImage: liveImagePath, survivingImage: keepImagePath, unregisteredSentinel: sentinel, clipboardTouched: false, maintenanceCommandsExecuted: false, webviewReloadAndNativeLoadVerified: true, separateProcessRestartVerified: false, expectedWorkspace: afterDeletion };
  await writeFile('.artifacts/entity-deletion-check.json', JSON.stringify(result, null, 2), 'utf8'); console.log(JSON.stringify(result));
} catch (error) {
  const state = await page.evaluate(() => {
    const diagnostics = window.__entityDeletionDiagnostics; diagnostics?.record('failure', document.activeElement);
    const summarize = node => ({ tag: node.tagName, id: node.id, className: node.className, parent: { tag: node.parentElement?.tagName, id: node.parentElement?.id, className: node.parentElement?.className }, childCount: node.children.length, fields: [...node.querySelectorAll('[data-inline-field]')].map(field => ({ label: field.getAttribute('data-inline-field'), text: field.textContent?.slice(0, 120) })), htmlStart: node.outerHTML.slice(0, 16000), htmlEnd: node.outerHTML.slice(-2000) });
    return { counts: { roots: document.querySelectorAll('#root').length, apps: document.querySelectorAll('.checklist-app').length, mains: document.querySelectorAll('.app-main').length, workspaces: document.querySelectorAll('.workspace-page').length }, roots: [...document.querySelectorAll('#root')].map(summarize), mains: [...document.querySelectorAll('.app-main')].map(summarize), bodyChildren: [...document.body.children].map(node => ({ tag: node.tagName, id: node.id, className: node.className })), focus: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }, dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => node.outerHTML), alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent), save: document.querySelector('.save-state')?.textContent, timeline: diagnostics?.timeline };
  }).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/entity-deletion-failure.json', JSON.stringify({ error: String(error), checks, deleted, pageErrors, rootInvariantChecks, confirmationScreenshots: [...confirmationScreenshots], consoleMessages, state, workspace: await workspace().catch(() => null) }, null, 2), 'utf8').catch(() => {}); await page.screenshot({ path: '.artifacts/entity-deletion-failure.png' }).catch(() => {}); throw error;
} finally { await browser.close(); }
