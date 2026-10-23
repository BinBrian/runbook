// Run after the successful desktop checklist smoke and its normal application exit.
// Restarts only the manifest-owned target/desktop-smoke-* workspace. No commands
// are copied or executed, and no real application workspace is read or changed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.artifacts');
const resultFile = path.join(artifacts, 'checklist-reopen-check.json');
const manifest = JSON.parse(await readFile(path.join(artifacts, 'checklist-check.json'), 'utf8'));
assert.equal(manifest.ok, true, 'Complete checklist smoke must pass before restart verification');
assert.ok(typeof manifest.isolatedDataDirectory === 'string' && path.isAbsolute(manifest.isolatedDataDirectory));
const target = await realpath(path.join(root, 'target'));
const dataDirectory = await realpath(path.resolve(manifest.isolatedDataDirectory));
assert.equal(path.dirname(dataDirectory).toLowerCase(), target.toLowerCase(), 'Only a direct test directory under this project target may be opened');
assert.match(path.basename(dataDirectory), /^desktop-smoke-[A-Za-z0-9_-]+$/, 'Only harness-owned desktop-smoke-* data may be opened');
const relative = path.relative(target, dataDirectory);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
const database = await realpath(path.join(dataDirectory, 'checklist.sqlite3'));
assert.equal(path.dirname(database).toLowerCase(), dataDirectory.toLowerCase(), 'The test database must stay inside its isolated directory');
for (const field of ['runId', 'importedId', 'restartId']) assert.match(manifest[field] ?? '', /^[A-Za-z0-9_-]+$/, `Missing safe ${field} in smoke manifest`);
const executable = await realpath(path.join(target, 'debug', 'runbook-desktop.exe'));
await access(executable);
await mkdir(artifacts, { recursive: true });

// This read-only SQLite baseline establishes that data existed before the new
// process started; a new in-memory workspace cannot satisfy the restart check.
const read = spawnSync('python', ['-c', [
  'import json,pathlib,sqlite3,sys',
  'db=pathlib.Path(sys.argv[1]).resolve()',
  'with sqlite3.connect(db.as_uri()+"?mode=ro",uri=True) as c:',
  ' row=c.execute("SELECT body FROM checklist_workspace WHERE id=1").fetchone()',
  ' assert row is not None',
  ' print(json.dumps(json.loads(row[0]),ensure_ascii=True))',
].join('\n'), database], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
assert.equal(read.status, 0, read.stderr || 'Read-only isolated SQLite baseline failed');
const baseline = JSON.parse(read.stdout);
const find = (workspace, id) => {
  const item = workspace.instances.find(value => value.id === id);
  assert.ok(item, `Persisted instance ${id} is missing`);
  return item;
};
const original = find(baseline, manifest.runId);
const imported = find(baseline, manifest.importedId);
const restarting = find(baseline, manifest.restartId);
assert.equal(original.status, 'completed');
assert.ok(original.archivedAt, 'Original complete run remains manually archived');
assert.ok(original.entries.some(entry => entry.type === 'comment' && entry.text.includes('归档后补充')), 'Post-archive comment must be persisted');
assert.equal(imported.status, 'completed');
assert.ok(imported.archivedAt, 'Imported archive keeps its archive state');
assert.ok(imported.entries.some(entry => entry.type === 'comment' && entry.text.includes('仅修改导入副本')), 'Imported comment edit must remain independent');
assert.equal(imported.entries.filter(entry => entry.type === 'image').length, 0, 'Deleted imported image must stay deleted');
assert.equal(restarting.status, 'in_progress');
assert.ok(['s1-target', 's2-package'].includes(restarting.currentStepId), 'Restart fixture must still be early in its five-step workflow');
const originalImage = original.entries.find(entry => entry.type === 'image');
assert.ok(originalImage, 'Original archive retains its image');
const imageBytes = await readFile(path.join(root, 'docs/examples/patch-maintenance/images/package-check-demo.png'));
const checks = [], pageErrors = [], launches = [];
let active;

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function launch() {
  const port = await availablePort();
  const env = { ...process.env, RUNBOOK_DATA_DIR: dataDirectory, RUNBOOK_TEST_DATA_DIR: dataDirectory,
    RUNBOOK_NO_ERROR_DIALOG: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` };
  const child = spawn(executable, [], { cwd: path.dirname(executable), env, windowsHide: true, stdio: 'ignore' });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
  const session = { child, env, exit, port, browser: undefined, page: undefined };
  active = session;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `Owned restart process exited ${child.exitCode}`);
    try { session.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(session.browser, 'Owned restart WebView2 did not become available');
  session.page = session.browser.contexts()[0].pages()[0];
  assert.ok(session.page, 'Owned restart WebView2 page is missing');
  session.page.setDefaultTimeout(15000);
  session.page.on('pageerror', error => pageErrors.push(error.message));
  await session.page.setViewportSize({ width: 1360, height: 940 });
  await session.page.getByRole('button', { name: '导入', exact: true }).waitFor();
  await expect(session.page.locator('.library-page')).toBeVisible();
  const startup = await readFile(path.join(target, 'debug', 'runbook-startup.log'), 'utf8');
  assert.ok(startup.includes(`Data directory: ${dataDirectory}`), 'Application must report exactly the isolated data directory');
  launches.push({ pid: child.pid, cdpPort: port });
  return session;
}
function native(session, command, args) {
  return session.page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
}
const load = session => native(session, 'checklist_load');
async function openInstance(session, id, archived) {
  const page = session.page;
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: archived ? '归档' : '当前工作' }).click();
  await page.locator(`[data-instance-id="${id}"]`).click();
  await expect(page.locator('[data-inline-field="实例名称"]')).toBeVisible();
}
async function showOriginal(session) {
  await openInstance(session, manifest.runId, true);
  const step = session.page.locator('[data-step-id="s2-package"]');
  if (await step.locator('.step-card-heading').getAttribute('aria-expanded') !== 'true') await step.locator('.step-expand-toggle').first().click();
  await expect(step.locator('.image-preview img')).toBeVisible();
  await expect(step.locator('.image-preview img')).toHaveJSProperty('complete', true);
  assert.ok(await step.locator('.image-preview img').evaluate(element => element.naturalWidth > 0));
  const dataUrl = await native(session, 'checklist_read_image', { instanceId: original.id, path: originalImage.path });
  assert.deepEqual(Buffer.from(dataUrl.split(',')[1], 'base64'), imageBytes, 'Original image bytes survive process restart');
}
async function closeNormally(session) {
  if (session.child.exitCode !== null) return;
  const close = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference = "Stop"; $p = Get-Process -Id $env:RUNBOOK_TEST_PID; if ($p.Path -ne $env:RUNBOOK_TEST_EXE) { throw "Unexpected owned process path" }; if (-not $p.CloseMainWindow()) { throw "Owned process close request failed" }'], {
    cwd: root, env: { ...session.env, RUNBOOK_TEST_PID: String(session.child.pid), RUNBOOK_TEST_EXE: executable }, windowsHide: true, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(close.status, 0, close.stderr || 'Normal window close request failed');
  let timer;
  try {
    const timedOut = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned application did not exit normally through its close guard')), 15000); });
    assert.equal(await Promise.race([session.exit, timedOut]), 0, 'Owned application must exit successfully');
  } finally { clearTimeout(timer); }
  if (session.browser) await session.browser.close().catch(() => {});
  if (active === session) active = undefined;
}

try {
  const first = await launch();
  assert.deepEqual(await load(first), baseline, 'First real relaunch must match the pre-launch SQLite baseline exactly');
  await showOriginal(first);
  await openInstance(first, manifest.importedId, true);
  assert.deepEqual(find(await load(first), manifest.importedId), imported);
  checks.push('Real process launch restores the complete read-only SQLite baseline, both archived instances, independent comments, deleted imported image and exact original image bytes');
  await openInstance(first, manifest.restartId, false);
  let restart = find(await load(first), manifest.restartId);
  if (restart.currentStepId === 's1-target') {
    await first.page.locator('[data-step-id="s1-target"]').getByRole('button', { name: '完成并下一步', exact: true }).click();
    await expect.poll(async () => find(await load(first), manifest.restartId).currentStepId).toBe('s2-package');
    restart = find(await load(first), manifest.restartId);
  }
  assert.equal(restart.currentStepId, 's2-package');
  const beforeClose = await load(first);
  await first.page.screenshot({ path: path.join(artifacts, 'checklist-reopen-before-close.png') });
  await expect(first.page.getByRole('alert')).toHaveCount(0);
  await closeNormally(first);
  checks.push('UI advances the independent working copy to step two; CloseMainWindow goes through the application close guard and exits normally');

  const second = await launch();
  const reopened = await load(second);
  assert.deepEqual(reopened, beforeClose, 'Second real relaunch must restore the complete workspace exactly as saved before exit');
  await openInstance(second, manifest.restartId, false);
  const current = second.page.locator('[data-step-id="s2-package"]');
  await expect(current).toHaveClass(/is-current/);
  await expect(current.locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true');
  await expect(current.locator('.step-content')).toBeVisible();
  await expect(second.page.locator('[data-step-id="s1-target"] .step-content')).toHaveCount(0);
  assert.equal(find(reopened, manifest.restartId).status, 'in_progress');
  await second.page.screenshot({ path: path.join(artifacts, 'checklist-reopen-current-step.png') });
  await showOriginal(second);
  await expect(second.page.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
  await closeNormally(second);
  checks.push('Second process restart preserves every template, parameter, result and material; reopening the ongoing instance expands and focuses its saved step two while step one is collapsed');
  const result = { ok: true, isolatedDataDirectory: dataDirectory, runId: manifest.runId, importedId: manifest.importedId, restartId: manifest.restartId,
    checks, pageErrors, launches, currentStepId: 's2-package', fullWorkspaceEqual: true, readonlyBaseline: true,
    clipboardTouched: false, maintenanceCommandsExecuted: false, normalCloseCount: 2 };
  await writeFile(resultFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  if (active?.page) await active.page.screenshot({ path: path.join(artifacts, 'checklist-reopen-failure.png') }).catch(() => {});
  await writeFile(resultFile, JSON.stringify({ ok: false, isolatedDataDirectory: dataDirectory, checks, pageErrors, launches, error: String(error) }, null, 2), 'utf8');
  throw error;
} finally {
  if (active) {
    const owned = active;
    try { await closeNormally(owned); } catch { /* Only this script's PID may be stopped below. */ }
    if (owned.browser) await owned.browser.close().catch(() => {});
    if (owned.child.pid && owned.child.exitCode === null) owned.child.kill();
  }
}
