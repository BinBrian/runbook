import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR); assert.equal(path.dirname(directory).toLowerCase(), (await realpath('target')).toLowerCase()); assert.match(path.basename(directory), /^desktop-smoke-/);
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(14000);
const output = '.artifacts/work-records-2026-10-21'; await mkdir(output, { recursive: true });
const checks = [], errors = []; page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), load = () => native('checklist_load');
const oldId = 'legacy-id-collision', document = { groups: [{ id: 'legacy-group', name: '玩家转区' }], parameters: [{ id: 'legacy-env', ownerId: 'legacy-group', name: '目标区服', description: '', defaultValue: '9001002' }], steps: [{ id: 'legacy-step', groupId: 'legacy-group', title: ['转区 ', { parameterId: 'legacy-env' }], description: [], commands: [] }] };
async function draft(label) { await page.locator('.draft-menu > summary').click(); await page.locator('.draft-menu-row').filter({ hasText: label }).locator('button').first().click(); }
try {
  await expect(page.locator('.library-page')).toBeVisible();
  await apply({ type: 'create_work', id: oldId, name: '已有工作保持原样', document });
  await apply({ type: 'start_instance', id: oldId }); await apply({ type: 'record_result', id: oldId, outcome: 'completed', reason: null });
  const original = (await load()).instances.find(item => item.id === oldId);
  await apply({ type: 'create_template', id: oldId, name: '旧定义保留为工作', document });
  const originalTemplate = (await load()).templates.find(item => item.id === oldId);
  // Simulate exact persisted input from the previously shipped version.
  await page.evaluate(({ id }) => localStorage.setItem('runbook.explicit-drafts.v1', JSON.stringify({ version: 1, entries: [
    [`variable-definition:template:${id}`, { label: '变量定义', target: { kind: 'template', id, stepId: 'legacy-step' }, value: { kind: 'edit', id: 'legacy-env', ownerId: 'legacy-group', ownerLabel: '当前步骤组 · 玩家转区', name: '目标区服', description: '保留这份说明', defaultValue: '尚未提交的区服值' } }],
    ['dialog:' + JSON.stringify(['createInstance', id, null, null]), { label: '旧命名草稿', target: { kind: 'template', id, dialog: 'createInstance' }, value: '从旧定义准备的工作名' }],
  ] })), { id: oldId });
  await page.reload(); await expect(page.locator('.library-page')).toBeVisible(); const loaded = await native('checklist_load_work'); const convertedId = loaded.convertedTemplates[oldId]; assert.ok(convertedId); assert.notEqual(convertedId, oldId); assert.equal(loaded.workspace.templates.length, 0); assert.deepEqual(loaded.workspace.instances.find(item => item.id === oldId), original);
  const converted = loaded.workspace.instances.find(item => item.id === convertedId); assert.equal(converted.status, 'draft'); assert.deepEqual(converted.document, originalTemplate.document); assert.equal(converted.entries.length, 0);
  await draft('变量定义'); await expect(page.locator('[data-inline-field="工作名称"]')).toHaveText('旧定义保留为工作'); const form = page.getByRole('dialog', { name: '编辑变量定义', exact: true }); await expect(form.getByRole('textbox', { name: '变量默认值' })).toHaveValue('尚未提交的区服值'); await expect(form).toContainText('玩家转区'); await form.getByRole('button', { name: '保存变量', exact: true }).click(); await expect(form).toHaveCount(0);
  await expect.poll(async () => (await load()).instances.find(item => item.id === convertedId).document.parameters[0].defaultValue).toBe('尚未提交的区服值'); assert.deepEqual((await load()).instances.find(item => item.id === oldId), original);
  checks.push('Existing completed work remains exact even when an old definition uses the same identity; conversion creates a distinct draft and restores the old local-variable form to its exact owner and value');
  await draft('旧命名草稿'); const dialog = page.getByRole('dialog', { name: '再做一次', exact: true }); await expect(dialog.getByRole('textbox', { name: '工作名称' })).toHaveValue('从旧定义准备的工作名'); await dialog.getByRole('checkbox').uncheck();
  await page.reload(); await expect(page.locator('.library-page')).toBeVisible(); await draft('再做一次'); const restored = page.getByRole('dialog', { name: '再做一次', exact: true }); await expect(restored.getByRole('checkbox')).not.toBeChecked(); await expect(restored.getByRole('textbox', { name: '工作名称' })).toHaveValue('从旧定义准备的工作名'); await restored.getByRole('button', { name: '创建新工作', exact: true }).click(); await expect(restored).toHaveCount(0);
  const next = (await load()).instances.find(item => item.name === '从旧定义准备的工作名'); assert.ok(next); assert.equal(next.parameterValues['legacy-env'], '尚未提交的区服值'); assert.equal(next.sourceInstanceId, convertedId);
  checks.push('Old creation-name draft becomes a rerun draft; the new carry-values checkbox and name survive reload, and explicit creation uses the selected definition defaults');
  const beforeReload = await load(); await page.reload(); await expect(page.locator('.library-page')).toBeVisible(); assert.deepEqual(await load(), beforeReload);
  await page.locator(`[data-instance-id="${convertedId}"]`).click(); await page.locator('.heading-actions .more-menu > summary').click(); await page.getByRole('button', { name: '删除工作', exact: true }).click(); await page.getByRole('button', { name: '确认删除工作', exact: true }).click(); await expect.poll(async () => (await load()).instances.some(item => item.id === convertedId)).toBe(false); await page.reload(); await expect(page.locator('.library-page')).toBeVisible(); assert.ok(!(await load()).instances.some(item => item.id === convertedId)); assert.deepEqual((await load()).instances.find(item => item.id === oldId), original);
  checks.push('Repeated loads are idempotent; deleting a converted work does not regenerate it, and an independent work created from it survives');
  await page.screenshot({ path: `${output}/migration-work-library.png` }); assert.deepEqual(errors, []);
  const report = { ok: true, directory, checks, convertedId, newId: next.id, errors, realUserDataOpened: false, maintenanceCommandsExecuted: false };
  await writeFile(`${output}/migration.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page.screenshot({ path: `${output}/migration-failure.png` }).catch(() => {}); await writeFile(`${output}/migration.json`, JSON.stringify({ ok: false, directory, checks, errors, error: String(error) }, null, 2)); throw error; }
finally { await browser.close(); }
