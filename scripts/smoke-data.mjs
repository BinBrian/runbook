import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages()[0];
const clipboard = script => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; ${script}`], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
let original = 'NON_TEXT';
let clipboardUnavailable = false;
try { original = clipboard("if ([System.Windows.Forms.Clipboard]::ContainsText()) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([System.Windows.Forms.Clipboard]::GetText())) } elseif ([System.Windows.Forms.Clipboard]::GetDataObject()) { 'NON_TEXT' } else { 'EMPTY' }"); }
catch { clipboardUnavailable = true; }
let copied = false;
try {
  const before = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('load_workspace'));
  // Preserve the user's existing text clipboard; leave non-text clipboard untouched.
  if (original !== 'NON_TEXT') {
    await page.getByRole('button', { name: '复制指令', exact: true }).first().click();
    await expect(page.getByRole('button', { name: '已复制', exact: true }).first()).toBeVisible();
    const actual = Buffer.from(clipboard("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([System.Windows.Forms.Clipboard]::GetText()))"), 'base64').toString('utf8');
    assert.equal(actual, '  Write-Output "Runbook 中文测试"  ');
    copied = true;
  }
  const backup = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('export_backup'));
  const after = await page.evaluate(json => window.__TAURI_INTERNALS__.invoke('perform', { request: { operation_id: crypto.randomUUID(), expected_revision: null, action: { type: 'import_bundle', json } } }), backup);
  assert.equal(after.templates.length, before.templates.length * 2);
  assert.equal(after.runs.length, before.runs.length * 2);
  for (const run of before.runs) assert.deepEqual(after.runs.find(item => item.id === run.id), run);
  const imported = after.runs.filter(item => !before.runs.some(old => old.id === item.id));
  assert.equal(imported.reduce((sum, run) => sum + run.steps.reduce((n, step) => n + step.attempts.length, 0), 0), before.runs.reduce((sum, run) => sum + run.steps.reduce((n, step) => n + step.attempts.length, 0), 0));
  console.log(JSON.stringify({ clipboardExactAndRestored: copied, clipboardUnavailable, nativeBackupImport: true, originalsUnchanged: true, importedRuns: imported.length }));
} finally {
  if (original === 'EMPTY') clipboard('[System.Windows.Forms.Clipboard]::Clear()');
  else if (original !== 'NON_TEXT') clipboard(`[System.Windows.Forms.Clipboard]::SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${original}')))`);
  await browser.close();
}
