// node scripts/check-desktop.mjs scripts/smoke-scoped-apply-all.mjs
// Uses only a new harness workspace. No clipboard or maintenance execution.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && path.isAbsolute(directory));
assert.equal(path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''), path.resolve(directory));
const target = await realpath('target'), actualDirectory = await realpath(directory);
assert.equal(path.dirname(actualDirectory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actualDirectory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actualDirectory}`));
assert.ok(process.env.RUNBOOK_CDP_URL);
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const pageErrors = [], checks = [], runId = 'qa-apply-all-run';
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action });
const run = async () => (await native('checklist_load')).instances.find(item => item.id === runId);
const variablePanel = page.locator('[data-variable-panel]');
const scope = id => variablePanel.locator(`section[data-parameter-scope="${id}"]`);
async function settle() { await expect(page.getByRole('button', { name: '导入', exact: true })).toBeEnabled(); }
async function selectScope(id) {
  const value = await run();
  const cursor = value.status === 'draft' ? 0 : value.document.steps.findIndex(item => item.id === value.currentStepId);
  const selected = value.document.steps.find((item, index) => index >= cursor && (id === 'global' || item.groupId === id || item.id === id));
  assert.ok(selected, `No unadvanced step exists for scope ${id}`);
  await page.locator(`[data-nav-step-id="${selected.id}"]`).click();
  await expect(variablePanel).toHaveAttribute('data-variable-target-step-id', selected.id);
  await expect(scope(id)).toBeVisible();
  return scope(id);
}
async function groupInput(id) {
  return (await selectScope(id)).getByRole('textbox', { name: '环境', exact: true });
}
function progress(value) { return { currentStepId: value.currentStepId, status: value.status, entries: value.entries, startedAt: value.startedAt }; }

try {
  await mkdir('.artifacts', { recursive: true });
  await page.setViewportSize({ width: 1360, height: 940 });
  const initial = { parameters: [{ id: 'all-global', name: '环境', description: '', defaultValue: 'release' }], steps: [
    { id: 'all-current', title: ['核对 ', { parameterId: 'all-global' }], description: ['只记录，不执行命令。'], commands: [] },
  ] };
  await apply({ type: 'create_template', id: 'qa-apply-all-template', name: '运行中新增两个空参数组', document: initial });
  await apply({ type: 'create_instance', id: runId, name: 'QA 运行中集中补齐', templateId: 'qa-apply-all-template', fromInstanceId: null });
  await apply({ type: 'start_instance', id: runId });
  const before = await run(), document = structuredClone(before.document);
  document.groups = ['sandboxa', 'sandboxb'].map(environment => ({ id: `future-${environment}`, name: `更新 ${environment}` }));
  for (const environment of ['sandboxa', 'sandboxb']) {
    document.parameters.push({ id: `env-${environment}`, ownerId: `future-${environment}`, name: '环境', description: '', defaultValue: '' });
    document.steps.push({ id: `stop-${environment}`, groupId: `future-${environment}`, title: ['停止服务'], description: [], commands: [
      { id: `command-${environment}`, text: ['stopserver ', { parameterId: `env-${environment}` }, ' all'] },
    ] });
  }
  await apply({ type: 'save_instance', id: runId, name: before.name, document });
  const missingBefore = await run();
  assert.deepEqual(progress(missingBefore), progress(before));
  assert.equal(missingBefore.parameterValues['env-sandboxa'], '');
  assert.equal(missingBefore.parameterValues['env-sandboxb'], '');
  await page.reload();
  await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  await page.locator(`[data-instance-id="${runId}"]`).click();
  await expect(page.locator('[data-step-id="all-current"]')).toHaveClass(/is-current/);
  const applyAll = page.getByRole('button', { name: '应用全部参数', exact: true });
  await expect(applyAll).toBeDisabled();
  await selectScope('future-sandboxa');
  await page.locator('[data-parameter-target="env-sandboxa"]').click();
  await expect(scope('future-sandboxa').getByRole('textbox', { name: '环境', exact: true })).toBeFocused();
  await scope('future-sandboxa').getByRole('textbox', { name: '环境', exact: true }).fill('sandboxa');
  await expect(applyAll).toBeDisabled();
  await selectScope('future-sandboxb');
  await page.locator('[data-parameter-target="env-sandboxb"]').click();
  await expect(scope('future-sandboxb').getByRole('textbox', { name: '环境', exact: true })).toBeFocused();
  await scope('future-sandboxb').getByRole('textbox', { name: '环境', exact: true }).fill('sandboxb');
  await expect(applyAll).toBeEnabled();
  assert.deepEqual((await run()).parameterValues, missingBefore.parameterValues, 'Unapplied local drafts must not leak into native data');
  await applyAll.click();
  await settle();
  await expect(applyAll).toHaveCount(0);
  let saved = await run();
  assert.deepEqual(progress(saved), progress(before));
  assert.equal(saved.parameterValues['all-global'], 'release');
  assert.equal(saved.parameterValues['env-sandboxa'], 'sandboxa');
  assert.equal(saved.parameterValues['env-sandboxb'], 'sandboxb');
  checks.push('Two newly inserted future groups can be filled independently and applied together; disabled state and locator links track missing values without changing execution progress');

  await (await groupInput('future-sandboxa')).fill('sandboxa-local-edit');
  await (await groupInput('future-sandboxb')).fill('sandboxb-still-draft');
  await selectScope('global');
  await scope('global').getByRole('textbox', { name: '环境', exact: true }).fill('preview-unapplied');
  await selectScope('future-sandboxa');
  await scope('future-sandboxa').getByRole('button', { name: '应用本组参数', exact: true }).click();
  await settle();
  saved = await run();
  assert.equal(saved.parameterValues['env-sandboxa'], 'sandboxa-local-edit');
  assert.equal(saved.parameterValues['env-sandboxb'], 'sandboxb');
  assert.equal(saved.parameterValues['all-global'], 'release');
  await selectScope('future-sandboxb');
  await expect(scope('future-sandboxb').getByRole('textbox', { name: '环境', exact: true })).toHaveValue('sandboxb-still-draft');
  await selectScope('global');
  await expect(scope('global').getByRole('textbox', { name: '环境', exact: true })).toHaveValue('preview-unapplied');
  await selectScope('future-sandboxb');
  await scope('future-sandboxb').getByRole('button', { name: '应用本组参数', exact: true }).click();
  await settle();
  await selectScope('global');
  await scope('global').getByRole('button', { name: '取消本范围修改', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存在本机');
  saved = await run();
  assert.equal(saved.parameterValues['env-sandboxb'], 'sandboxb-still-draft');
  assert.equal(saved.parameterValues['all-global'], 'release');
  assert.deepEqual(progress(saved), progress(before));
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: '.artifacts/scoped-apply-all.png' });
  checks.push('Normal per-group Apply changes only its own value while other local/global drafts stay visible and unapplied; applying/canceling the remaining scopes leaves current step, status and records unchanged');
  const result = { ok: true, isolatedDataDirectory: directory, runId, checks, pageErrors, currentStepId: saved.currentStepId,
    clipboardTouched: false, maintenanceCommandsExecuted: false };
  await writeFile('.artifacts/scoped-apply-all-check.json', JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: '.artifacts/scoped-apply-all-failure.png' }).catch(() => {});
  console.error(JSON.stringify({ checks, pageErrors }));
  throw error;
} finally { await browser.close(); }
