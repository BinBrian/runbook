// Run after smoke-scoped-blocks.mjs has passed and the harness has closed normally.
// Only the manifest-owned target/desktop-smoke-* workspace and owned PIDs are used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.artifacts'), resultFile = path.join(artifacts, 'scoped-reopen-check.json');
const manifest = JSON.parse(await readFile(path.join(artifacts, 'scoped-check.json'), 'utf8'));
assert.equal(manifest.ok, true, 'Complete scoped smoke must pass before restart verification');
assert.ok(path.isAbsolute(manifest.isolatedDataDirectory ?? ''));
const target = await realpath(path.join(root, 'target')), directory = await realpath(manifest.isolatedDataDirectory);
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
const database = await realpath(path.join(directory, 'checklist.sqlite3'));
assert.equal(path.dirname(database).toLowerCase(), directory.toLowerCase());
for (const name of ['runId', 'importedId', 'currentStepId', 'currentGroupId', 'legacyTemplateId']) assert.match(manifest[name] ?? '', /^[A-Za-z0-9_-]+$/);
const executable = await realpath(path.join(target, 'debug', 'runbook-desktop.exe'));
const read = spawnSync('python', ['-c', [
  'import json,pathlib,sqlite3,sys',
  'db=pathlib.Path(sys.argv[1]).resolve()',
  'with sqlite3.connect(db.as_uri()+"?mode=ro",uri=True) as c:',
  ' row=c.execute("SELECT body FROM checklist_workspace WHERE id=1").fetchone()',
  ' assert row is not None',
  ' print(json.dumps(json.loads(row[0]),ensure_ascii=True))',
].join('\n'), database], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
assert.equal(read.status, 0, read.stderr);
const baseline = JSON.parse(read.stdout);
const find = (workspace, id) => { const value = workspace.instances.find(item => item.id === id); assert.ok(value, `Missing stored instance ${id}`); return value; };
const original = find(baseline, manifest.runId), imported = find(baseline, manifest.importedId);
assert.deepEqual(baseline.blocks, []);
assert.equal(original.status, 'in_progress');
assert.equal(imported.status, 'in_progress');
assert.equal(original.currentStepId, manifest.currentStepId);
assert.deepEqual(imported.document, original.document);
assert.deepEqual(imported.parameterValues, original.parameterValues);
assert.equal(baseline.templates.find(item => item.id === manifest.legacyTemplateId).formatVersion, 2);
const imageBytes = await readFile(path.join(root, 'docs/examples/patch-maintenance/images/package-check-demo.png'));
const checks = [], pageErrors = [], launches = [], closeDiagnostics = [];
let active;

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return value;
}
async function launch() {
  const cdpPort = await port();
  const env = { ...process.env, RUNBOOK_DATA_DIR: directory, RUNBOOK_TEST_DATA_DIR: directory, RUNBOOK_NO_ERROR_DIALOG: '1',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1` };
  const child = spawn(executable, [], { cwd: path.dirname(executable), env, windowsHide: true, stdio: 'ignore' });
  let startupError;
  child.once('error', error => { startupError = error; });
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
  const session = { child, env, exit, cdpPort };
  active = session;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    assert.equal(child.exitCode, null, `Owned application exited ${child.exitCode}`);
    try { session.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1000 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(session.browser, 'Owned WebView2 did not become available');
  session.page = session.browser.contexts()[0].pages()[0];
  assert.ok(session.page);
  session.page.setDefaultTimeout(15000);
  session.page.on('pageerror', error => pageErrors.push(error.message));
  await session.page.setViewportSize({ width: 1360, height: 940 });
  await session.page.getByRole('button', { name: '导入', exact: true }).waitFor();
  await expect(session.page.locator('.library-page')).toBeVisible();
  assert.ok((await readFile(path.join(target, 'debug/runbook-startup.log'), 'utf8')).includes(`Data directory: ${directory}`));
  launches.push({ pid: child.pid, cdpPort });
  return session;
}
function native(session, command, args) { return session.page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args }); }
const load = session => native(session, 'checklist_load');
async function open(session, id) {
  await session.page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '当前工作' }).click();
  await session.page.locator(`[data-instance-id="${id}"]`).click();
  await expect(session.page.locator('[data-inline-field="实例名称"]')).toBeVisible();
}
async function currentVisible(session, id, stepId, groupId) {
  await open(session, id);
  const group = session.page.locator(`[data-group-id="${groupId}"]`).first();
  await expect(group).toHaveAttribute('data-group-current', 'true');
  await expect(group.locator(':scope > .execution-group-heading')).toHaveAttribute('aria-expanded', 'true');
  const step = session.page.locator(`[data-step-id="${stepId}"]`);
  await expect(step).toHaveClass(/is-current/);
  await expect(step.locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true');
  await expect(step.locator('.step-content')).toBeVisible();
  return step;
}
async function imageIntact(session, id) {
  const record = find(await load(session), id).entries.find(entry => entry.type === 'image');
  assert.ok(record);
  const url = await native(session, 'checklist_read_image', { instanceId: id, path: record.path });
  assert.deepEqual(Buffer.from(url.split(',')[1], 'base64'), imageBytes);
}
async function diagnoseClose(session, phase) {
  // Diagnostics are restricted to the PID and WebView owned by this script.
  // They never enumerate or close unrelated Runbook/user application windows.
  const processState = spawnSync('powershell.exe', ['-NoProfile', '-Command', [
    '$ErrorActionPreference = "Stop"',
    '$p = Get-Process -Id $env:RUNBOOK_TEST_PID -ErrorAction SilentlyContinue',
    'if ($null -eq $p) { @{ exists=$false; pid=[int]$env:RUNBOOK_TEST_PID } | ConvertTo-Json -Compress; exit 0 }',
    'if ($p.Path -ne $env:RUNBOOK_TEST_EXE) { throw "Unexpected owned process path during diagnosis" }',
    '$p.Refresh()',
    '@{ exists=$true; pid=$p.Id; path=$p.Path; responding=$p.Responding; mainWindowHandle=$p.MainWindowHandle.ToInt64().ToString(); mainWindowTitle=$p.MainWindowTitle; hasExited=$p.HasExited } | ConvertTo-Json -Compress',
  ].join('; ')], { cwd: root, env: { ...session.env, RUNBOOK_TEST_PID: String(session.child.pid), RUNBOOK_TEST_EXE: executable },
    windowsHide: true, encoding: 'utf8', timeout: 5000 });
  let ui, diagnosticTimer;
  try {
    ui = await Promise.race([session.page.evaluate(() => ({
      readyState: document.readyState, title: document.title, focused: document.hasFocus(),
      saveState: [...document.querySelectorAll('.save-state')].map(element => ({ text: element.textContent, className: element.className })),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => ({ label: element.getAttribute('aria-label'), visible: Boolean(element.getClientRects().length) })),
      scopes: [...document.querySelectorAll('[data-parameter-scope]')].map(element => ({
        scope: element.getAttribute('data-parameter-scope'),
        visible: Boolean(element.getClientRects().length),
        heading: element.querySelector('.parameters-heading')?.textContent,
        pending: [...element.querySelectorAll('b')].some(value => value.textContent?.includes('未应用')),
        actions: [...element.querySelectorAll('.parameter-actions button')].map(button => ({ label: button.textContent, disabled: button.disabled })),
      })),
      pendingLabels: [...document.querySelectorAll('b,.local-save-label')].filter(element => /未应用|未提交|等待保存/.test(element.textContent ?? '')).map(element => element.textContent),
    })), new Promise(resolve => { diagnosticTimer = setTimeout(() => resolve({ unavailable: 'Owned WebView diagnostic timed out after 3 seconds' }), 3000); })]);
  } catch (error) { ui = { unavailable: String(error) }; }
  finally { clearTimeout(diagnosticTimer); }
  const state = { phase, at: new Date().toISOString(), ownedPid: session.child.pid, exitCode: session.child.exitCode,
    connected: session.browser?.isConnected(), pageClosed: session.page?.isClosed(), url: session.page?.url(),
    processQuery: { status: processState.status, stdout: processState.stdout?.trim(), stderr: processState.stderr?.trim(), error: processState.error?.message }, ui };
  closeDiagnostics.push(state);
  await writeFile(path.join(artifacts, 'scoped-reopen-close-diagnostics.json'), JSON.stringify(closeDiagnostics, null, 2), 'utf8');
  if (phase !== 'before-normal-close') console.error(JSON.stringify({ closeDiagnostic: state }));
  return state;
}
async function close(session) {
  if (session.child.exitCode !== null) return;
  await diagnoseClose(session, 'before-normal-close');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference = "Stop"; $p = Get-Process -Id $env:RUNBOOK_TEST_PID; if ($p.Path -ne $env:RUNBOOK_TEST_EXE) { throw "Unexpected owned process path" }; if (-not $p.CloseMainWindow()) { throw "Owned process close failed" }'], {
    cwd: root, env: { ...session.env, RUNBOOK_TEST_PID: String(session.child.pid), RUNBOOK_TEST_EXE: executable }, windowsHide: true, encoding: 'utf8', timeout: 5000,
  });
  if (result.status !== 0) await diagnoseClose(session, 'normal-close-request-failed');
  assert.equal(result.status, 0, result.stderr);
  let timeout;
  try { assert.equal(await Promise.race([session.exit, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Normal close guard did not exit')), 15000); })]), 0); }
  catch (error) { await diagnoseClose(session, 'normal-close-exit-failed'); throw error; }
  finally { clearTimeout(timeout); }
  await session.browser.close().catch(() => {});
  if (active === session) active = undefined;
}

try {
  const first = await launch();
  assert.deepEqual(await load(first), baseline);
  await currentVisible(first, manifest.runId, manifest.currentStepId, manifest.currentGroupId);
  await imageIntact(first, manifest.runId); await imageIntact(first, manifest.importedId);
  checks.push('Real relaunch exactly restores the read-only SQLite baseline, four scoped groups, independent imported instance, history, images, imported legacy template and empty source block library');
  const current = first.page.locator(`[data-step-id="${manifest.currentStepId}"]`);
  await current.getByRole('button', { name: /^完成并/ }).click();
  await expect(first.page.getByRole('button', { name: '导入', exact: true })).toBeEnabled();
  await expect.poll(async () => find(await load(first), manifest.runId).currentStepId).not.toBe(manifest.currentStepId);
  const beforeClose = await load(first), advanced = find(beforeClose, manifest.runId);
  const groupId = advanced.document.steps.find(step => step.id === advanced.currentStepId).groupId;
  assert.equal(groupId, manifest.currentGroupId, 'Completing the first member must advance within the same group');
  assert.deepEqual(find(beforeClose, manifest.importedId), imported, 'The independently imported instance must not advance with its source');
  await first.page.screenshot({ path: path.join(artifacts, 'scoped-reopen-before-close.png') });
  await close(first);
  checks.push('UI advances one concrete step inside the current group; normal window close persists progress while the independent imported copy stays at its previous step');

  const second = await launch();
  assert.deepEqual(await load(second), beforeClose);
  const reopenedStep = await currentVisible(second, manifest.runId, advanced.currentStepId, groupId);
  await expect(reopenedStep.locator('[data-inline-field="命令 1"]')).toContainText('sandboxb');
  await expect(second.page.locator(`[data-step-id="${manifest.currentStepId}"] .step-content`)).toHaveCount(0);
  await imageIntact(second, manifest.runId); await imageIntact(second, manifest.importedId);
  await second.page.screenshot({ path: path.join(artifacts, 'scoped-reopen-current-group.png') });
  await expect(second.page.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
  await close(second);
  checks.push('Second normal relaunch restores the complete saved workspace exactly, expands the current group and step, collapses the prior step and preserves local sandboxb without the deleted block definition');
  const result = { ok: true, isolatedDataDirectory: directory, runId: manifest.runId, importedId: manifest.importedId,
    currentStepId: advanced.currentStepId, currentGroupId: groupId, checks, pageErrors, launches, normalCloseCount: 2,
    fullWorkspaceEqual: true, readonlyBaseline: true, clipboardTouched: false, maintenanceCommandsExecuted: false, closeDiagnostics };
  await writeFile(resultFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  if (active?.page) await active.page.screenshot({ path: path.join(artifacts, 'scoped-reopen-failure.png') }).catch(() => {});
  await writeFile(resultFile, JSON.stringify({ ok: false, isolatedDataDirectory: directory, checks, pageErrors, launches, closeDiagnostics, error: String(error) }, null, 2), 'utf8');
  throw error;
} finally {
  if (active) {
    const owned = active;
    try { await close(owned); } catch { /* Only this script's owned PID may be stopped. */ }
    await owned.browser?.close().catch(() => {});
    if (owned.child.pid && owned.child.exitCode === null) owned.child.kill();
  }
}
