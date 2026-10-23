// Owns a fresh target/desktop-smoke-* directory and exactly one native process.
// Verifies actual minimize/restore and custom close flushes pending edits and exits normally.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = await realpath(path.join(root, 'target/debug/runbook-desktop.exe'));
const directory = await mkdtemp(path.join(root, 'target/desktop-smoke-'));
const artifacts = path.resolve(process.env.RUNBOOK_TEST_OUTPUT_DIR);
await mkdir(artifacts, { recursive: true });
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const env = { ...process.env, RUNBOOK_DATA_DIR: directory, RUNBOOK_TEST_DATA_DIR: directory, RUNBOOK_NO_ERROR_DIALOG: '1',
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` };
const child = spawn(executable, [], { cwd: path.dirname(executable), env, windowsHide: true, stdio: 'ignore' });
let startupError, browser, page, closeTimer;
child.once('error', error => { startupError = error; });
const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
const checks = [], states = [], pageErrors = [];
let restoreDiagnostic;
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const win = command => native(`plugin:window|${command}`, { label: 'main' });

// MainWindowHandle is a heuristic and can name another HWND owned by the same
// application. Enumerate top-level windows and restore only iconic HWNDs whose
// PID still matches the child immediately before each native operation.
const ownedWindowApi = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class RunbookOwnedWindowRestore {
  public delegate bool EnumWindowCallback(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder text, int length);
  [DllImport("user32.dll", SetLastError=true)] static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
  public class WindowState {
    public string Handle; public uint ProcessId; public bool Iconic; public bool Visible;
    public string Title; public string ClassName; public string Owner;
  }
  public class Attempt {
    public string Handle; public uint ProcessId; public string Method; public bool ReturnValue;
    public int LastError; public bool ExistsAfter; public bool IconicAfter;
  }
  static bool Owned(IntPtr handle, uint processId) {
    uint actual; GetWindowThreadProcessId(handle, out actual);
    return actual == processId && IsWindow(handle);
  }
  public static WindowState[] Snapshot(uint processId) {
    var result = new List<WindowState>();
    EnumWindows((handle, parameter) => {
      uint actual; GetWindowThreadProcessId(handle, out actual);
      if (actual == processId) {
        var title = new StringBuilder(1024); var name = new StringBuilder(256);
        GetWindowText(handle, title, title.Capacity); GetClassName(handle, name, name.Capacity);
        result.Add(new WindowState { Handle=handle.ToInt64().ToString(), ProcessId=actual,
          Iconic=IsIconic(handle), Visible=IsWindowVisible(handle), Title=title.ToString(),
          ClassName=name.ToString(), Owner=GetWindow(handle, 4).ToInt64().ToString() });
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static Attempt[] Restore(uint processId) {
    var result = new List<Attempt>();
    foreach (var state in Snapshot(processId)) {
      var handle = new IntPtr(Int64.Parse(state.Handle));
      if (!state.Iconic || !Owned(handle, processId)) continue;
      bool accepted = ShowWindowAsync(handle, 9); int error = Marshal.GetLastWin32Error();
      for (int i=0; i<20 && Owned(handle, processId) && IsIconic(handle); i++) Thread.Sleep(50);
      result.Add(new Attempt { Handle=state.Handle, ProcessId=processId, Method="ShowWindowAsync(SW_RESTORE)",
        ReturnValue=accepted, LastError=error, ExistsAfter=IsWindow(handle), IconicAfter=IsIconic(handle) });
      if (!Owned(handle, processId) || !IsIconic(handle)) continue;
      accepted = PostMessage(handle, 0x0112, new IntPtr(0xF120), IntPtr.Zero); error=Marshal.GetLastWin32Error();
      for (int i=0; i<20 && Owned(handle, processId) && IsIconic(handle); i++) Thread.Sleep(50);
      result.Add(new Attempt { Handle=state.Handle, ProcessId=processId, Method="PostMessage(WM_SYSCOMMAND,SC_RESTORE)",
        ReturnValue=accepted, LastError=error, ExistsAfter=IsWindow(handle), IconicAfter=IsIconic(handle) });
    }
    return result.ToArray();
  }
}`;

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    assert.equal(child.exitCode, null, `Owned application exited ${child.exitCode}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(browser, 'Owned native WebView did not start');
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  assert.ok((await readFile(path.join(root, 'target/debug/runbook-startup.log'), 'utf8')).includes(`Data directory: ${directory}`));
  assert.equal(await win('is_decorated'), false);
  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  await expect.poll(() => win('is_minimized')).toBe(true);
  states.push({ phase: 'custom-button-minimized', minimized: await win('is_minimized') });
  // Restore only the process created above. No application permission is added for testing.
  const restore = spawnSync('powershell.exe', ['-NoProfile', '-Command', [
    '$ErrorActionPreference = "Stop"',
    '$p = Get-Process -Id $env:RUNBOOK_TEST_PID',
    'if ($p.Path -ne $env:RUNBOOK_TEST_EXE) { throw "Unexpected owned process path" }',
    '$p.Refresh()',
    `Add-Type -TypeDefinition '${ownedWindowApi.replaceAll("'", "''")}'`,
    '$before = @([RunbookOwnedWindowRestore]::Snapshot([uint32]$p.Id))',
    '$attempts = @([RunbookOwnedWindowRestore]::Restore([uint32]$p.Id))',
    '$after = @([RunbookOwnedWindowRestore]::Snapshot([uint32]$p.Id))',
    '[ordered]@{ ownedPid=$p.Id; executable=$p.Path; processMainWindowHandle=$p.MainWindowHandle.ToInt64().ToString(); before=$before; attempts=$attempts; after=$after } | ConvertTo-Json -Depth 8 -Compress',
  ].join('; ')], { cwd: root, env: { ...env, RUNBOOK_TEST_PID: String(child.pid), RUNBOOK_TEST_EXE: executable }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  restoreDiagnostic = { status: restore.status, stdout: restore.stdout?.trim(), stderr: restore.stderr?.trim(), error: restore.error?.message };
  if (restore.status === 0 && restore.stdout?.trim()) restoreDiagnostic.detail = JSON.parse(restore.stdout);
  await writeFile(path.join(artifacts, 'window-titlebar-restore-diagnostic.json'), JSON.stringify(restoreDiagnostic, null, 2), 'utf8');
  assert.equal(restore.status, 0, restore.stderr);
  assert.ok(restoreDiagnostic.detail.before.some(state => state.Iconic), 'An iconic top-level HWND belonging to the owned native process must be identified');
  assert.ok(restoreDiagnostic.detail.attempts.length > 0, 'The native restore must target an identified owned iconic HWND');
  assert.ok(restoreDiagnostic.detail.attempts.every(attempt => attempt.ProcessId === child.pid), 'Restore attempts must never target a different process');
  await expect.poll(() => win('is_minimized')).toBe(false);
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeVisible();
  states.push({ phase: 'owned-process-restored', minimized: await win('is_minimized') });
  checks.push('Custom minimize button changes the real native window state; Win32 SW_RESTORE targets only this harness-owned PID and restores usable content without extra application permissions');

  await page.screenshot({ path: path.join(artifacts, 'window-restored.png') });
  const id = 'qa-window-close-buffered-template', originalName = '关闭前名称', finalName = '标题栏关闭已刷新最新编辑';
  await native('checklist_apply', { action: { type: 'create_work', id, name: originalName, document: { parameters: [], steps: [{ id: 'window-close-step', title: ['人工步骤'], description: [], commands: [] }] } } });
  await page.reload();
  await page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: '工作记录' }).click();
  await page.locator(`[data-instance-id="${id}"]`).click();
  await expect(page.locator('[data-inline-field="工作名称"]')).toHaveText(originalName);
  await page.locator('[data-inline-field="工作名称"]').dblclick();
  await expect(page.getByRole('textbox', { name: '工作名称', exact: true })).toHaveValue(originalName);
  await page.screenshot({ path: path.join(artifacts, 'window-titlebar-before-buffered-close.png') });
  await page.getByRole('textbox', { name: '工作名称', exact: true }).fill(finalName);
  const before = await native('checklist_load');
  assert.equal(before.instances.find(item => item.id === id).name, originalName, 'Edit must still be buffered before the close request');
  await expect(page.locator('.save-state')).toContainText('等待保存');
  // Do not wait for navigation after the click: successful close destroys the WebView.
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click({ noWaitAfter: true }).catch(error => {
    if (!/Target.*closed|page.*closed|context.*closed/i.test(String(error))) throw error;
  });
  const result = await Promise.race([exited, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Custom close did not exit normally')), 15000); })]);
  assert.equal(result, 0, 'Native application must exit normally through the close guard');
  clearTimeout(closeTimer);
  const database = await realpath(path.join(directory, 'checklist.sqlite3'));
  assert.equal(path.dirname(database).toLowerCase(), directory.toLowerCase());
  const stored = spawnSync('python', ['-c', [
    'import json,pathlib,sqlite3,sys',
    'db=pathlib.Path(sys.argv[1]).resolve()',
    'with sqlite3.connect(db.as_uri()+"?mode=ro",uri=True) as c:',
    ' row=c.execute("SELECT body FROM checklist_workspace WHERE id=1").fetchone()',
    ' assert row is not None',
    ' print(json.dumps(json.loads(row[0]),ensure_ascii=True))',
  ].join('\n'), database], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(stored.status, 0, stored.stderr);
  const workspace = JSON.parse(stored.stdout);
  assert.equal(workspace.instances.find(item => item.id === id).name, finalName);
  checks.push('Custom close button requests normal guarded close, flushes a confirmed pending name edit and exits 0; read-only SQLite inspection confirms the latest content was committed before exit');
  assert.deepEqual(pageErrors, []);
  const output = { ok: true, isolatedDataDirectory: directory, ownedPid: child.pid, normalCloseCount: 1, exitCode: result, checks, states, pageErrors,
    clipboardTouched: false, maintenanceCommandsExecuted: false, ownedWin32Restore: true, restoreDiagnostic };
  await writeFile(path.join(artifacts, 'window-titlebar-close-check.json'), JSON.stringify(output, null, 2), 'utf8');
  console.log(JSON.stringify(output));
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'window-titlebar-close-failure.png') }).catch(() => {});
  await writeFile(path.join(artifacts, 'window-titlebar-close-check.json'), JSON.stringify({ ok: false, isolatedDataDirectory: directory, ownedPid: child.pid, checks, states, pageErrors, restoreDiagnostic, error: String(error) }, null, 2), 'utf8');
  throw error;
} finally {
  clearTimeout(closeTimer);
  await browser?.close().catch(() => {});
  if (child.pid && child.exitCode === null) child.kill();
}
