// Build first, then: node scripts/check-desktop.mjs scripts/smoke-visual.mjs
// Each run owns a new database, a temporary CDP port and only its own process.
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import path from 'node:path';
import assert from 'node:assert/strict';

const executable = path.resolve(process.env.RUNBOOK_TEST_EXECUTABLE ?? 'target/debug/runbook-desktop.exe');
assert.equal(path.dirname(executable).toLowerCase(), path.resolve('target/debug').toLowerCase());
assert.ok(['runbook-desktop.exe', 'runbook-desktop-candidate.exe'].includes(path.basename(executable).toLowerCase()));
const testScript = path.resolve(process.argv[2] ?? 'scripts/smoke-visual.mjs');
await access(executable);
await access(testScript);
const socket = createServer();
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
const port = socket.address().port;
await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
const dataDirectory = await mkdtemp(path.resolve('target/desktop-smoke-'));
const cdpUrl = `http://127.0.0.1:${port}`;
const env = { ...process.env, RUNBOOK_DATA_DIR: dataDirectory, RUNBOOK_TEST_DATA_DIR: dataDirectory,
  RUNBOOK_NO_ERROR_DIALOG: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, RUNBOOK_CDP_URL: cdpUrl };
const child = spawn(executable, [], { cwd: path.dirname(executable), env, windowsHide: true, stdio: 'ignore' });
let startupError;
child.once('error', error => { startupError = error; });
const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
let browser, closeTimeout;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Test application exited ${child.exitCode}`);
    try { browser = await chromium.connectOverCDP(cdpUrl); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(browser, 'Test WebView2 did not start');
  const page = browser.contexts()[0].pages()[0];
  await page.getByRole('button', { name: '导入', exact: true }).first().waitFor();
  if (env.RUNBOOK_TEST_EXPECTED_ASSET) {
    const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src));
    assert.ok(scripts.some(src => src.endsWith(`/assets/${env.RUNBOOK_TEST_EXPECTED_ASSET}`)), 'Unexpected embedded UI build');
  }
  // Optional display-only fixture; it never changes the business document.
  if (env.RUNBOOK_TEST_THEME) {
    assert.ok(['light', 'dark'].includes(env.RUNBOOK_TEST_THEME));
    await page.evaluate(theme => localStorage.setItem('runbook.appearance', theme), env.RUNBOOK_TEST_THEME);
    await page.reload();
    await page.getByRole('button', { name: '导入', exact: true }).first().waitFor();
    await page.locator(`html[data-theme="${env.RUNBOOK_TEST_THEME}"]`).waitFor();
  }
  console.log(`Isolated test data: ${dataDirectory}`);
  const script = spawn(process.execPath, [testScript], { env, windowsHide: true, stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => { script.once('error', reject); script.once('exit', resolve); });
  assert.equal(result, 0, 'Desktop verification failed');
  const close = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$p = Get-Process -Id $env:RUNBOOK_TEST_PID; if ($p.Path -ne $env:RUNBOOK_TEST_EXE) { throw "Unexpected process path" }; if (-not $p.CloseMainWindow()) { throw "Close request failed" }'], {
    env: { ...env, RUNBOOK_TEST_PID: String(child.pid), RUNBOOK_TEST_EXE: executable }, windowsHide: true, encoding: 'utf8',
  });
  assert.equal(close.status, 0, close.stderr);
  const timedOut = new Promise((_, reject) => { closeTimeout = setTimeout(() => reject(new Error('Test application close timed out')), 10000); });
  assert.equal(await Promise.race([exit, timedOut]), 0);
  console.log('Desktop verification complete; test application closed normally.');
} finally {
  clearTimeout(closeTimeout);
  if (browser) await browser.close().catch(() => {});
  if (child.pid && child.exitCode === null) child.kill();
}
