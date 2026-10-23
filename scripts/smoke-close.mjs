// The caller must supply the exact isolated Runbook test process PID.
import { chromium, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const pid = Number(process.env.RUNBOOK_TEST_PID);
if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('RUNBOOK_TEST_PID must identify this test application');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages()[0];
try {
  await page.reload();
  await page.getByRole('button', { name: '新建模板', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('textbox').fill('退出恢复 · 无效草稿');
  await page.getByRole('button', { name: '创建并编辑' }).click();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const templateId = await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('load_workspace')).templates.at(-1).id);
  const markdown = '<!-- runbook:document version="1" -->\n\n<!-- runbook:step id="11111111-1111-4111-8111-111111111111" -->\n尚未闭合的中文草稿';
  await page.locator('.cm-content').click();
  await page.keyboard.insertText(markdown);
  const closed = page.waitForEvent('close', { timeout: 15000 });
  // A normal Windows close request exercises onCloseRequested + registered flushers.
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$p = Get-Process -Id $env:RUNBOOK_TEST_PID; if ($p.Path -ne $env:RUNBOOK_TEST_EXE) { throw "Unexpected process path" }; if (-not $p.CloseMainWindow()) { throw "Close request failed" }'], { env: { ...process.env, RUNBOOK_TEST_EXE: path.resolve('target/debug/runbook-desktop.exe') }, windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  await closed;
  await writeFile('.artifacts/recovery-expected.json', JSON.stringify({ templateId, markdown }), 'utf8');
  console.log('正常窗口关闭已完成；待重新启动后核对草稿。');
} finally { await browser.close(); }
