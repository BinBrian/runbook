import { openCommentComposer } from './step-materials.mjs';
// Real Windows file dialogs and close guard; controlled only through the Sky UI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const executable = await realpath('target/debug/runbook-desktop.exe');
const directory = await mkdtemp(path.resolve('target/desktop-smoke-'));
const artifacts = path.resolve('.artifacts/interaction-audit/native-ui', path.basename(directory));
await mkdir(artifacts, { recursive: true });
const exports = path.join(directory, 'native-exports'); await mkdir(exports);
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const child = spawn(executable, [], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore', env: {
  ...process.env, RUNBOOK_DATA_DIR: directory, RUNBOOK_NO_ERROR_DIALOG: '1',
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
} });
const exited = new Promise(resolve => child.once('exit', resolve));
const checks = [], phases = [], pageErrors = [];
let browser, page;
async function wait(predicate, label, milliseconds = 300000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function phase(id, detail = {}) {
  const value = { id, at: new Date().toISOString(), isolatedDataDirectory: directory, artifactsDirectory: artifacts, processId: child.pid, ...detail };
  phases.push(value); await writeFile(path.join(artifacts, 'native-phase.json'), JSON.stringify(value, null, 2));
  await writeFile(path.resolve('.artifacts/interaction-audit/native-current.json'), JSON.stringify(value, null, 2));
  console.log(JSON.stringify(value));
}
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action }), workspace = () => native('checklist_load');
const templateId = 'native-file-template', instanceId = 'native-file-instance';
const document = { groups: [], parameters: [], steps: [{ id: 'native-check', title: ['核对维护文件'], description: ['本流程只验证文件和窗口交互。'], commands: [{ id: 'native-command', text: ['echo 本地交互验证'] }] }] };
const files = { template: path.join(exports, '文件交互模板.runbook.json'), instance: path.join(exports, '文件交互实例.runbook.zip') };
async function exists(file) { try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function open(kind) {
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: kind === 'template' ? '模板' : '当前工作' }).click();
  const row = page.locator(`[data-${kind}-id="${kind === 'template' ? templateId : instanceId}"]`);
  await (kind === 'template' ? row.locator('.tile-open') : row).click();
  await expect(page.locator(`[data-inline-field="${kind === 'template' ? '模板名称' : '实例名称'}"]`)).toBeVisible();
}
try {
  await wait(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true; } catch { return false; } }, 'CDP', 20000);
  page = browser.contexts()[0].pages()[0]; page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  await apply({ type: 'create_template', id: templateId, name: '文件交互模板', document });
  await apply({ type: 'create_instance', id: instanceId, name: '文件交互实例', templateId, fromInstanceId: null });
  await apply({ type: 'start_instance', id: instanceId });
  await page.reload(); await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  console.log(`Isolated test data: ${directory}`);
  for (const kind of ['template', 'instance']) {
    await open(kind);
    await phase(`save-${kind}`, { path: files[kind], instruction: '在实际另存为对话框中填写路径并保存' });
    await page.getByRole('button', { name: kind === 'template' ? '导出模板' : '导出存档', exact: true }).click();
    await wait(() => exists(files[kind]), `native ${kind} save`);
    await expect(page.getByRole('status')).toContainText(kind === 'template' ? '模板已导出' : '完整存档已导出');
    const bytes = await readFile(files[kind]);
    if (kind === 'template') assert.equal(JSON.parse(bytes.toString('utf8')).id, templateId);
    else assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    await page.screenshot({ path: path.join(artifacts, `native-export-${kind}.png`) });
    checks.push(`实际 Windows 另存为保存 ${kind}，文件名含中文，原生导出文件校验通过`);
    const before = await workspace(), oldIds = new Set((kind === 'template' ? before.templates : before.instances).map(item => item.id));
    await phase(`open-${kind}`, { path: files[kind], instruction: '在实际打开对话框中填写同一路径并打开' });
    await page.getByRole('button', { name: '导入', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '导入预览', exact: true });
    await preview.waitFor({ timeout: 300000 }); await expect(preview).toContainText('本地已存在');
    await page.screenshot({ path: path.join(artifacts, `native-import-${kind}-preview.png`) });
    await preview.getByRole('button', { name: '导入为独立副本', exact: true }).click();
    await expect(preview).toHaveCount(0);
    const after = await workspace(), imported = (kind === 'template' ? after.templates : after.instances).find(item => !oldIds.has(item.id));
    assert.ok(imported); assert.deepEqual(imported.document, document);
    assert.ok(after.templates.some(item => item.id === templateId)); assert.ok(after.instances.some(item => item.id === instanceId));
    checks.push(`实际 Windows 打开读取 ${kind} 后预览重复提示，独立导入保留来源`);
  }
  await open('instance');
  await phase('window-controls', { instruction: 'Sky 验证最大化/还原、拖动、最小化/重新激活，完成后写 window-controls-done.json' });
  await wait(() => exists(path.join(artifacts, 'window-controls-done.json')), 'Sky window controls');
  await openCommentComposer(page);
  const comment = page.getByRole('textbox', { name: '添加评论', exact: true }); await comment.fill('原生关闭保护验证');
  const drafts = await page.evaluate(() => JSON.parse(localStorage.getItem('runbook.explicit-drafts.v1')));
  assert.ok(drafts.entries.some(([, entry]) => entry.value === '原生关闭保护验证'));
  await expect(comment).toHaveValue('原生关闭保护验证');
  await page.screenshot({ path: path.join(artifacts, 'native-local-draft.png') });
  await open('template');
  await page.locator('[data-inline-field="模板名称"]').dblclick();
  await page.getByRole('textbox', { name: '模板名称', exact: true }).fill('原生关闭后已保存');
  await phase('close-final', { instruction: '点击实际窗口关闭按钮，验证自动刷新并正常退出' });
  let closeTimer;
  let code;
  try { code = await Promise.race([exited, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Native close timeout')), 300000); })]); }
  finally { clearTimeout(closeTimer); }
  assert.equal(code, 0);
  const baseline = spawnSync('python', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(json.loads(c.execute("SELECT body FROM checklist_workspace WHERE id=1").fetchone()[0]),ensure_ascii=True))', path.join(directory, 'checklist.sqlite3')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(baseline.status, 0, baseline.stderr);
  const saved = JSON.parse(baseline.stdout); assert.equal(saved.templates.find(item => item.id === templateId).name, '原生关闭后已保存');
  assert.ok(!saved.instances.find(item => item.id === instanceId).entries.some(entry => entry.type === 'comment' && entry.text === '原生关闭保护验证'));
  checks.push('真实关闭请求保留本机草稿并正常退出，SQLite 只读校验编辑后的名称，未提交评论不成为记录；跨进程草稿恢复由 check-close-drafts.mjs 独立验证');
  assert.deepEqual(pageErrors, []);
  const result = { ok: true, isolatedDataDirectory: directory, files, phases, checks, pageErrors, nativeFileChooserAutomated: true, maintenanceCommandsExecuted: false };
  await writeFile(path.join(artifacts, 'native-interactions-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  await writeFile(path.join(artifacts, 'native-interactions-failure.json'), JSON.stringify({ error: String(error), checks, phases, pageErrors }, null, 2));
  throw error;
} finally { await browser?.close().catch(() => {}); if (child.exitCode === null) child.kill(); }
