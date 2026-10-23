// Build first: pnpm build:desktop
// Run: node scripts/check-desktop.mjs scripts/smoke-checklist.mjs
// Explicit IPC-only clipboard fallback: RUNBOOK_CLIPBOARD_TEST_MODE=transport.
// Only the harness-owned database is used. No displayed maintenance command runs.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
const clipboardMode = process.env.RUNBOOK_CLIPBOARD_TEST_MODE ?? 'system';
assert.ok(['system', 'transport'].includes(clipboardMode), 'RUNBOOK_CLIPBOARD_TEST_MODE must be system or transport; an unknown mode cannot bypass clipboard preservation');
assert.ok(directory && path.isAbsolute(directory), 'Explicit isolated RUNBOOK_TEST_DATA_DIR required');
assert.equal(path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''), path.resolve(directory));
const relative = path.relative(await realpath('target'), await realpath(directory));
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Use a new target/desktop-smoke-* directory');
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${path.resolve(directory)}`));
assert.ok(process.env.RUNBOOK_CDP_URL, 'The desktop harness must supply its private CDP URL');

const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const checks = [], pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const workspace = () => native('checklist_load');
const instance = async id => (await workspace()).instances.find(item => item.id === id);
const template = async id => (await workspace()).templates.find(item => item.id === id);
const step = id => page.locator(`[data-step-id="${id}"]`);
const capture = name => page.screenshot({ path: `.artifacts/checklist-${name}.png` });
const nav = label => page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: label }).click();
const uiName = 'QA 补丁维护闭环';
const oldPath = String.raw`C:\RunbookDemo\packages\patch-0.1.1.zip`;
const newPath = String.raw`C:\RunbookDemo\packages\patch-0.1.1-repacked.zip`;
const exactLiteralCommand = '  Write-Output "{{version}} { $_.Name } 中文😀"  \r\n\r\n  Write-Output \'after blank\'  \r\n';
const imagePath = path.resolve('docs/examples/patch-maintenance/images/package-check-demo.png');
const imageBytes = await readFile(imagePath);
let clipboard, clipboardTouched = false;

// Keep the clipboard snapshot in one STA process, including its non-text formats.
// The helper only reads/restores clipboard data; it never executes copied text.
async function preserveClipboard() {
  const source = String.raw`
    $ErrorActionPreference = 'Stop'
    [Console]::Error.WriteLine('STAGE initialize-windows-forms')
    Add-Type -AssemblyName System.Windows.Forms
    function Invoke-ClipboardRetry([scriptblock] $Operation) {
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try { return (& $Operation) }
        catch {
          [Console]::Error.WriteLine('STAGE retry ' + ($attempt + 1) + '; exception-type=' + $_.Exception.GetType().FullName)
          if ($attempt -eq 19) { throw }; Start-Sleep -Milliseconds 100
        }
      }
    }
    # All original formats must be captured before the app may copy anything.
    # Retry the complete snapshot on a transient clipboard lock; never continue
    # with a partial snapshot or overwrite content that cannot be restored.
    $captured = Invoke-ClipboardRetry {
      [Console]::Error.WriteLine('STAGE snapshot-get-data-object')
      $original = [System.Windows.Forms.Clipboard]::GetDataObject()
      $snapshot = New-Object System.Windows.Forms.DataObject
      $hadData = $null -ne $original
      if ($hadData) {
        [Console]::Error.WriteLine('STAGE snapshot-enumerate-formats')
        $formats = $original.GetFormats($false)
        foreach ($format in $formats) {
          $formatName = $format -replace '[\r\n]', ' '
          [Console]::Error.WriteLine('STAGE snapshot-read-format: ' + $formatName)
          $data = $original.GetData($format, $false)
          if ($null -eq $data) { throw 'An original clipboard format could not be captured completely' }
          [Console]::Error.WriteLine('STAGE snapshot-cache-format: ' + $formatName)
          $snapshot.SetData($format, $false, $data)
        }
      }
      return @{ Snapshot = $snapshot; HadData = $hadData }
    }
    [Console]::Error.WriteLine('STAGE snapshot-complete')
    [Console]::WriteLine('READY')
    while ($null -ne ($operation = [Console]::ReadLine())) {
      if ($operation -eq 'READ') {
        [Console]::Error.WriteLine('STAGE read-copied-text')
        $copied = Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::GetText() }
        [Console]::WriteLine('TEXT:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($copied)))
      } elseif ($operation -eq 'RESTORE') {
        [Console]::Error.WriteLine('STAGE restore-complete-snapshot')
        Invoke-ClipboardRetry { if ($captured.HadData) { [System.Windows.Forms.Clipboard]::SetDataObject($captured.Snapshot, $true, 1, 20) } else { [System.Windows.Forms.Clipboard]::Clear() } }
        [Console]::Error.WriteLine('STAGE restore-complete')
        [Console]::WriteLine('RESTORED')
        break
      }
    }
  `;
  const helper = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', source], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: helper.stdout });
  const buffered = [], pending = [];
  let stderr = '', exited = false, helperError;
  const closed = new Promise(resolve => helper.once('close', resolve));
  const diagnostics = () => `PID ${helper.pid ?? 'not spawned'}; ${stderr}`;
  const rejectPending = error => { for (const waiter of pending.splice(0)) waiter.reject(error); };
  const onError = error => { helperError = error; rejectPending(new Error(`Clipboard helper error: ${error.message}; ${diagnostics()}`)); };
  helper.on('error', onError);
  helper.stdin.on('error', onError);
  helper.stderr.on('data', value => { stderr += value.toString(); });
  lines.on('line', line => { const waiter = pending.shift(); if (waiter) waiter.resolve(line); else buffered.push(line); });
  helper.on('exit', (code, signal) => { exited = true; rejectPending(new Error(`Clipboard helper exited ${code} (${signal ?? 'no signal'}): ${diagnostics()}`)); });
  function line(timeoutMs = 10000, phase = 'response') {
    if (buffered.length) return Promise.resolve(buffered.shift());
    if (helperError) return Promise.reject(new Error(`Clipboard helper error: ${helperError.message}; ${diagnostics()}`));
    if (exited) return Promise.reject(new Error(`Clipboard helper exited: ${diagnostics()}`));
    return new Promise((resolve, reject) => {
      const waiter = { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } };
      const timeout = setTimeout(() => { const index = pending.indexOf(waiter); if (index !== -1) pending.splice(index, 1); reject(new Error(`Clipboard helper ${phase} timed out after ${timeoutMs}ms: ${diagnostics()}`)); }, timeoutMs);
      pending.push(waiter);
    });
  }
  async function stopHelper() {
    helper.stdin.end(); lines.close();
    // Only terminate the process created above, including a pre-READY hang.
    // No name-based or global PowerShell cleanup may touch another process.
    if (!exited && helper.pid) helper.kill();
    let timeout;
    try {
      await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Clipboard helper did not close after cleanup: ${diagnostics()}`)), 3000); })]);
    } finally { clearTimeout(timeout); }
  }
  try { assert.equal(await line(20000, 'READY'), 'READY'); }
  catch (error) {
    try { await stopHelper(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Clipboard snapshot startup failed and its helper cleanup failed'); }
    throw error;
  }
  return {
    async read() { helper.stdin.write('READ\n'); const value = await line(10000, 'READ'); assert.ok(value.startsWith('TEXT:')); return Buffer.from(value.slice(5), 'base64').toString('utf8'); },
    async restore() { try { helper.stdin.write('RESTORE\n'); assert.equal(await line(10000, 'RESTORE'), 'RESTORED'); } finally { await stopHelper(); } },
  };
}

async function installDialogFixtures() {
  await page.evaluate(clipboardMode => {
    // Tauri 2 protects __TAURI_INTERNALS__.invoke against reassignment. Its
    // custom-protocol transport uses fetch, which is the intentional test seam.
    // Return Tauri error responses (do not reject fetch, which makes Tauri switch
    // permanently to its postMessage fallback and bypass this test seam).
    const originalFetch = window.fetch.bind(window);
    window.__checklistSmoke = { imports: [], exports: [], clipboardWrites: [], clipboardMode, failSave: false, calls: { probe: 0, pickImport: 0, saveExport: 0, failedSave: 0, clipboardWriteCount: 0 } };
    const reply = (value, ok = true) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': ok ? 'ok' : 'error' } });
    const wrappedFetch = async (input, init) => {
      const address = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (address.origin !== 'http://ipc.localhost' && !(address.protocol === 'ipc:' && address.hostname === 'localhost')) return originalFetch(input, init);
      const command = decodeURIComponent(address.pathname.slice(1));
      const args = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const state = window.__checklistSmoke;
      if (clipboardMode === 'transport' && command === 'plugin:clipboard-manager|write_text') {
        if (typeof args.text !== 'string') return reply('QA clipboard write payload must contain an exact text string', false);
        state.calls.clipboardWriteCount += 1;
        state.clipboardWrites.push(structuredClone(args));
        return reply(null);
      }
      if (command === 'checklist_smoke_probe') { state.calls.probe += 1; return reply({ intercepted: true }); }
      if (command === 'checklist_pick_import') { state.calls.pickImport += 1; return state.imports.length ? reply(state.imports.shift()) : reply('QA 导入夹具缺失', false); }
      if (command === 'checklist_save_export') { state.calls.saveExport += 1; state.exports.push(structuredClone(args)); return reply(true); }
      if (command === 'checklist_apply' && args.action?.type === 'save_template' && state.failSave) { state.calls.failedSave += 1; return reply('QA 模拟保存失败', false); }
      return originalFetch(input, init);
    };
    window.fetch = wrappedFetch;
    if (window.fetch !== wrappedFetch) throw new Error('QA IPC transport hook could not be installed');
  }, clipboardMode);
  assert.deepEqual(await native('checklist_smoke_probe'), { intercepted: true }, 'The fixture hook must be proven active before editing');
  assert.equal(await page.evaluate(() => window.__checklistSmoke.calls.probe), 1);
}
async function openInstance(id, archived = false) {
  await nav(archived ? '归档' : '当前工作');
  await page.locator(`[data-instance-id="${id}"]`).click();
  await expect(page.locator('[data-inline-field="实例名称"]')).toBeVisible();
}
async function showGlobalParameters() {
  const panel = page.getByRole('complementary', { name: '变量面板', exact: true });
  const expand = panel.getByRole('button', { name: '展开变量面板', exact: true });
  if (await expand.count()) await expand.click();
  await expect(panel.locator('[data-parameter-scope="global"]')).toBeVisible();
  await expect(page.locator('.workspace-scroll [data-parameter-scope], .workspace-scroll .parameter-definitions')).toHaveCount(0);
}
async function expandStep(id) {
  const header = step(id).locator('.step-card-heading');
  if (await header.getAttribute('aria-expanded') !== 'true') await header.locator('.step-expand-toggle').first().click();
}
async function menuAction(label) {
  const menu = page.locator('.more-menu');
  if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
  await menu.getByRole('button', { name: label, exact: true }).click();
}
async function selectLiteral(locator, literal) {
  await locator.focus();
  await locator.evaluate((element, literal) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.parentElement.closest('[data-parameter-id]')) continue;
      const index = text.textContent.indexOf(literal);
      if (index !== -1) {
        const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + literal.length);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return;
      }
    }
    throw new Error(`Literal selection not found: ${literal}`);
  }, literal);
}
async function exportThroughUi(buttonName) {
  const before = await page.evaluate(() => window.__checklistSmoke.exports.length);
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__checklistSmoke.exports.length)).toBe(before + 1);
  return page.evaluate(() => window.__checklistSmoke.exports.at(-1));
}
async function assertClipboard(button, expected) {
  const before = clipboardMode === 'transport' ? await page.evaluate(() => window.__checklistSmoke.calls.clipboardWriteCount) : null;
  await button.click();
  await expect(page.locator('.toast[role="status"]')).toContainText('命令已复制');
  if (clipboardMode === 'transport') await expect.poll(() => page.evaluate(() => window.__checklistSmoke.calls.clipboardWriteCount)).toBe(before + 1);
  await expect.poll(() => clipboard.read()).toBe(expected);
}

try {
  await mkdir('.artifacts', { recursive: true });
  await page.setViewportSize({ width: 1360, height: 940 });
  const initial = await workspace();
  assert.equal(initial.instances.length, 0, 'Run the smoke against a fresh harness database');
  assert.ok(initial.templates.length >= 1, 'A fresh workspace seeds the sample template');
  const originalTemplate = initial.templates.find(item => item.name === '示例补丁维护');
  assert.ok(originalTemplate, 'The five-step patch-maintenance example must be seeded');
  await installDialogFixtures();
  if (clipboardMode === 'transport') {
    clipboard = {
      read: () => page.evaluate(() => window.__checklistSmoke.clipboardWrites.at(-1)?.text ?? null),
      // This explicit mode never starts the clipboard helper or calls the OS.
      async restore() {},
    };
  } else {
    clipboardTouched = true;
    clipboard = await preserveClipboard();
  }

  await nav('模板');
  await page.locator(`[data-template-id="${originalTemplate.id}"]`).locator('.tile-open').click();
  await page.locator('.template-steps .step-card').first().locator('[data-inline-field="操作说明"]').dblclick();
  const description = page.locator('.template-steps .step-card').first().getByRole('textbox', { name: '操作说明', exact: true });
  await description.fill('演练编号 DEMO-01；保留同字 DEMO-01。Literal {{version}} { $_.Name }');
  await selectLiteral(description, 'DEMO-01');
  const selectionToolbar = page.getByRole('toolbar', { name: '选区变量操作', exact: true });
  await expect(selectionToolbar).toBeVisible(); await expect(selectionToolbar.getByRole('button')).toHaveCount(2);
  await selectionToolbar.getByRole('button', { name: '新增变量', exact: true }).click();
  let convert = page.getByRole('dialog', { name: '新增变量', exact: true });
  await expect(convert.locator('.token-choice')).toHaveCount(0);
  await expect(convert.getByLabel('默认值', { exact: true })).toHaveValue('DEMO-01');
  // This legacy-flow regression deliberately keeps all its parameters global;
  // the scoped-block smoke separately verifies the new local default.
  await convert.getByRole('combobox', { name: '变量作用范围', exact: true }).selectOption('');
  await convert.getByLabel('新变量名称', { exact: true }).fill('演练编号');
  await convert.getByLabel('说明', { exact: true }).fill('用于验证单选区替换与复用');
  await convert.getByRole('button', { name: '创建并替换选区', exact: true }).click();
  await expect(description.locator('[data-parameter-id]')).toHaveCount(1);
  await expect(description).toContainText('DEMO-01。Literal {{version}} { $_.Name }');
  await selectLiteral(description, 'DEMO-01');
  await selectionToolbar.getByRole('button', { name: '使用变量', exact: true }).click();
  convert = page.getByRole('dialog', { name: '使用变量', exact: true });
  await expect(convert.getByLabel('新变量名称', { exact: true })).toHaveCount(0);
  await expect(convert.getByRole('combobox', { name: '变量作用范围', exact: true })).toHaveCount(0);
  await convert.locator('.token-choice').filter({ hasText: '演练编号' }).click();
  await expect(description.locator('[data-parameter-id]')).toHaveCount(2);
  const packageEditor = page.locator('.template-steps [data-step-id="s2-package"]');
  await packageEditor.getByRole('button', { name: '步骤新增', exact: true }).click();
  const packageActions = page.getByRole('menu', { name: '步骤新增', exact: true });
  await expect(packageActions).toBeVisible();
  await packageActions.getByRole('menuitem', { name: '添加命令', exact: true }).click();
  await expect(packageActions).toHaveCount(0);
  const literalCommand = packageEditor.getByRole('textbox', { name: '命令 3', exact: true });
  await expect(literalCommand).toBeFocused();
  await literalCommand.evaluate((element, text) => {
    element.focus();
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const transfer = new DataTransfer(); transfer.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, exactLiteralCommand);

  // The dirty input must survive a real UI flush failure and must not open the
  // creation dialog using stale on-disk content. The failure is injected only at
  // the IPC boundary; the native database and user's data remain untouched.
  await page.evaluate(() => { window.__checklistSmoke.failSave = true; });
  await page.locator('[data-inline-field="模板名称"]').dblclick();
  await page.getByRole('textbox', { name: '模板名称', exact: true }).fill('QA 示例补丁维护');
  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('QA 模拟保存失败');
  assert.ok(await page.evaluate(() => window.__checklistSmoke.calls.failedSave > 0), 'A native save response was actually intercepted');
  await expect(page.getByRole('dialog', { name: '创建实例', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-inline-field="模板名称"]')).toHaveText('QA 示例补丁维护');
  await page.locator('[data-inline-field="模板名称"]').dblclick();
  await expect(page.getByRole('textbox', { name: '模板名称', exact: true })).toHaveValue('QA 示例补丁维护');
  await page.evaluate(() => { window.__checklistSmoke.failSave = false; });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(async () => (await template(originalTemplate.id)).name).toBe('QA 示例补丁维护');
  const savedTemplate = await template(originalTemplate.id);
  const newParameter = savedTemplate.document.parameters.find(item => item.name === '演练编号');
  assert.ok(newParameter);
  assert.equal(savedTemplate.document.steps[0].description.filter(part => typeof part !== 'string' && part.parameterId === newParameter.id).length, 2);
  assert.ok(savedTemplate.document.steps[0].description.some(part => typeof part === 'string' && part.includes('{{version}} { $_.Name }')));
  assert.deepEqual(savedTemplate.document.steps[1].commands[2].text, [exactLiteralCommand], 'Plain text paste preserves CRLF, blank lines, indentation and trailing whitespace');
  checks.push('UI selection creates/reuses one variable at a time; literal braces survive; failed auto-save preserves dirty text and blocks navigation until retry');

  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '创建实例', exact: true });
  await dialog.getByRole('textbox', { name: '实例名称', exact: true }).fill(uiName);
  await dialog.getByRole('button', { name: '创建实例', exact: true }).click();
  await expect(page.locator('[data-inline-field="实例名称"]')).toHaveText(uiName);
  const runId = (await workspace()).instances.find(item => item.name === uiName).id;
  await showGlobalParameters();
  await expect(page.getByRole('textbox', { name: '环境', exact: true })).toHaveValue('演示环境');
  await expect(page.getByRole('textbox', { name: '目标版本', exact: true })).toHaveValue('0.1.0');
  await expect(page.getByRole('textbox', { name: '演练编号', exact: true })).toHaveValue('DEMO-01');
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '环境', exact: true }).fill('演示环境 A');
  await page.getByRole('textbox', { name: '目标版本', exact: true }).fill('0.1.1');
  await page.getByRole('textbox', { name: '补丁包路径', exact: true }).fill(oldPath);
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect.poll(async () => (await instance(runId)).currentStepId).toBe('s1-target');
  await expect(step('s1-target')).toHaveClass(/is-current/);
  await expect(page.locator('.save-state')).toHaveText('已保存在本机');
  await expect(step('s2-package').locator('.step-content')).toHaveCount(0);
  await step('s1-target').getByRole('button', { name: '完成并下一步', exact: true }).click();
  await expect(step('s2-package')).toHaveClass(/is-current/);
  await expect(step('s1-target').locator('.step-content')).toHaveCount(0);
  await assertClipboard(step('s2-package').getByRole('button', { name: '复制命令', exact: true }).first(), `Get-Item -LiteralPath '${oldPath}'`);
  await assertClipboard(step('s2-package').getByRole('button', { name: '复制命令', exact: true }).nth(2), exactLiteralCommand);
  checks.push(`independent instance pre-fills defaults, requires missing parameters, starts and focuses current step; ${clipboardMode === 'transport' ? 'intercepted clipboard write IPC receives exact substituted and literal command text (system clipboard not verified or touched)' : 'system clipboard receives the complete substituted and literal commands, verified by actual reads'}`);

  await step('s2-package').getByRole('button', { name: '记录失败', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '记录失败', exact: true });
  await expect(dialog.getByRole('button', { name: '保存失败记录', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: '失败原因', exact: true }).fill('补丁包 SHA256 与发布清单不一致。');
  await dialog.getByRole('button', { name: '保存失败记录', exact: true }).click();
  await expect(step('s2-package')).toHaveClass(/is-current/);
  await step('s2-package').locator('.comment-details > summary').click();
  await step('s2-package').getByRole('textbox', { name: '添加评论', exact: true }).fill('已重新取得补丁包，准备更新本次包路径。');
  await step('s2-package').getByRole('button', { name: '添加评论', exact: true }).click();
  await expect(step('s2-package').locator('.comment-record')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeEnabled();
  await step('s2-package').locator('input[type=file]').setInputFiles(imagePath);
  await expect(step('s2-package').locator('.image-preview img')).toBeVisible();
  await showGlobalParameters();
  await page.getByRole('textbox', { name: '补丁包路径', exact: true }).fill(newPath);
  await page.getByRole('textbox', { name: '环境', exact: true }).fill('演示环境 B');
  // A draft value does not change the command until explicitly applied.
  await expect(step('s2-package').locator('[data-inline-field="命令 1"]')).toContainText(oldPath);
  await page.getByRole('button', { name: '应用全局参数', exact: true }).click();
  await expect(step('s2-package').locator('[data-inline-field="命令 1"]')).toContainText(newPath);
  await expect(step('s1-target').locator('.step-card-heading')).toContainText('演示环境 A');
  await assertClipboard(step('s2-package').getByRole('button', { name: '复制命令', exact: true }).first(), `Get-Item -LiteralPath '${newPath}'`);
  await step('s2-package').getByRole('button', { name: '完成并下一步', exact: true }).click();
  const afterRetry = await instance(runId);
  const packageResults = afterRetry.entries.filter(item => item.type === 'result' && item.stepId === 's2-package');
  assert.deepEqual(packageResults.map(item => item.outcome), ['failed', 'completed']);
  assert.equal(packageResults[0].snapshot.parameterValues.packagePath, oldPath);
  assert.equal(packageResults[1].snapshot.parameterValues.packagePath, newPath);
  await expect(step('s3-backup')).toHaveClass(/is-current/);
  await expect(step('s2-package').locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'false');
  await expandStep('s2-package');
  await expect(step('s2-package').locator('.result-record.old')).not.toHaveAttribute('open', '');
  await step('s2-package').locator('.result-record.old > summary').click();
  await step('s2-package').locator('.result-record.old .snapshot-details > summary').click();
  await expect(step('s2-package').locator('.result-record.old .snapshot-command pre').first()).toHaveText(`Get-Item -LiteralPath '${oldPath}'`);
  await capture('history');
  checks.push('failure requires a reason and stays current; comment and image are recorded; applying parameters changes only current/future content and preserves failed/advanced snapshots in UI history');

  await step('s3-backup').getByRole('button', { name: '跳过', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '跳过这一步', exact: true });
  await expect(dialog.getByRole('button', { name: '确认跳过', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: '跳过原因', exact: true }).fill('虚构演练不替换真实文件，正式维护必须核对备份。');
  await dialog.getByRole('button', { name: '确认跳过', exact: true }).click();
  await expect(step('s4-apply')).toHaveClass(/is-current/);
  const command4 = (await instance(runId)).document.steps[3].commands[0].text.map(part => typeof part === 'string' ? part : afterRetry.parameterValues[part.parameterId]).join('');
  await assertClipboard(step('s4-apply').getByRole('button', { name: '复制命令', exact: true }), command4);
  await step('s4-apply').getByRole('button', { name: '完成并下一步', exact: true }).click();
  await step('s5-verify').getByRole('button', { name: '完成并结束', exact: true }).click();
  await expect(page.locator('.completion-banner')).toContainText('本次工作已结束');
  assert.equal((await instance(runId)).status, 'completed');
  assert.equal((await instance(runId)).archivedAt, null);
  await nav('当前工作');
  await expect(page.locator(`[data-instance-id="${runId}"]`)).toBeVisible();
  await page.locator(`[data-instance-id="${runId}"]`).click();
  await page.locator('.completion-banner').getByRole('button', { name: '归档', exact: true }).click();
  await nav('当前工作');
  await expect(page.locator(`[data-instance-id="${runId}"]`)).toHaveCount(0);
  await openInstance(runId, true);
  await expandStep('s5-verify');
  await step('s5-verify').locator('.comment-details > summary').click();
  await step('s5-verify').getByRole('textbox', { name: '添加评论', exact: true }).fill('归档后补充：演练验收结论已整理。');
  await step('s5-verify').getByRole('button', { name: '添加评论', exact: true }).click();
  const beforeExport = await instance(runId);
  const archive = await exportThroughUi('导出存档');
  assert.match(archive.name, /\.runbook\.zip$/);
  assert.equal(Buffer.from(archive.bytes).subarray(0, 2).toString(), 'PK');
  const archivePath = path.join(directory, 'qa-complete.runbook.zip');
  await writeFile(archivePath, Buffer.from(archive.bytes));
  const zipCheck = spawnSync('python', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n d=json.loads(z.read("runbook.json")); images=[e["path"] for e in d["entries"] if e["type"]=="image"]\n assert set(z.namelist())==set(["runbook.json"]+images)\n assert len(images)==1\n assert z.read(images[0])==open(sys.argv[2],"rb").read()\n assert d["status"]=="completed" and d["archivedAt"]\n print(json.dumps({"entries":len(d["entries"]),"images":len(images),"formatVersion":d["formatVersion"]}))', archivePath, imagePath], { encoding: 'utf8', windowsHide: true });
  assert.equal(zipCheck.status, 0, zipCheck.stderr);
  checks.push('skip reason, completion summary, current-list retention, manual archive and post-archive comments; UI export produces a native ZIP containing JSON and exact image bytes');

  const preview = await native('checklist_preview_import', { name: archive.name, bytes: archive.bytes });
  assert.equal(preview.duplicate, true);
  await assert.rejects(() => native('checklist_commit_import', { token: preview.token, asCopy: false }));
  assert.deepEqual(await instance(runId), beforeExport, 'A rejected duplicate cannot overwrite or alter the local original');
  const idsBeforeImport = new Set((await workspace()).instances.map(item => item.id));
  await page.evaluate(file => window.__checklistSmoke.imports.push(file), archive);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入预览', exact: true });
  await expect(dialog).toContainText('本地已存在同一份实例');
  await dialog.getByRole('button', { name: '导入为独立副本', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const imported = (await workspace()).instances.find(item => !idsBeforeImport.has(item.id));
  assert.ok(imported);
  assert.deepEqual(imported.document, beforeExport.document);
  assert.deepEqual(imported.parameterValues, beforeExport.parameterValues);
  assert.deepEqual(imported.entries.filter(item => item.type !== 'image'), beforeExport.entries.filter(item => item.type !== 'image'));
  assert.equal(imported.status, beforeExport.status);
  assert.equal(imported.archivedAt, beforeExport.archivedAt);
  assert.deepEqual(await instance(runId), beforeExport);
  await expandStep('s2-package');
  await expect(step('s2-package').locator('.image-preview img')).toBeVisible();
  const importedImage = imported.entries.find(item => item.type === 'image');
  const dataUrl = await native('checklist_read_image', { instanceId: imported.id, path: importedImage.path });
  assert.deepEqual(Buffer.from(dataUrl.split(',')[1], 'base64'), imageBytes);
  await step('s2-package').getByRole('button', { name: '编辑评论', exact: true }).click();
  await step('s2-package').getByRole('textbox', { name: '编辑评论', exact: true }).fill('仅修改导入副本的评论。');
  await step('s2-package').getByRole('button', { name: '保存评论', exact: true }).click();
  await step('s2-package').getByRole('button', { name: '删除图片', exact: true }).click();
  await expect(step('s2-package').locator('.image-preview img')).toHaveCount(0);
  assert.deepEqual(await instance(runId), beforeExport, 'Imported comments/images must be independent of the original');
  const originalImage = beforeExport.entries.find(item => item.type === 'image');
  assert.deepEqual(Buffer.from((await native('checklist_read_image', { instanceId: runId, path: originalImage.path })).split(',')[1], 'base64'), imageBytes);
  checks.push('duplicate import requires explicit independent-copy confirmation; restores complete archived history and images; editing imported comments/deleting its image leaves original data and bytes intact');

  await openInstance(runId, true);
  await menuAction('复制为新实例');
  dialog = page.getByRole('dialog', { name: '复制为新实例', exact: true });
  const restartName = 'QA 从第一步重新记录';
  await dialog.getByRole('textbox', { name: '实例名称', exact: true }).fill(restartName);
  await dialog.getByRole('button', { name: '创建实例', exact: true }).click();
  const restart = (await workspace()).instances.find(item => item.name === restartName);
  assert.ok(restart);
  assert.equal(restart.status, 'draft');
  assert.equal(restart.currentStepId, null);
  assert.deepEqual(restart.entries, []);
  assert.deepEqual(restart.parameterValues, beforeExport.parameterValues);
  assert.deepEqual(restart.document, beforeExport.document);
  await showGlobalParameters();
  await expect(page.getByRole('textbox', { name: '目标版本', exact: true })).toHaveValue('0.1.1');
  await expect(page.getByRole('textbox', { name: '补丁包路径', exact: true })).toHaveValue(newPath);
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect(step('s1-target')).toHaveClass(/is-current/);
  await menuAction('另存为新模板');
  dialog = page.getByRole('dialog', { name: '另存为新模板', exact: true });
  const savedName = 'QA 保留默认值的新模板';
  await dialog.getByRole('textbox', { name: '模板名称', exact: true }).fill(savedName);
  await dialog.getByRole('button', { name: '保存新模板', exact: true }).click();
  const saved = (await workspace()).templates.find(item => item.name === savedName);
  assert.ok(saved);
  assert.deepEqual(saved.document, beforeExport.document);
  assert.equal(saved.document.parameters.find(item => item.id === 'version').defaultValue, '0.1.0');
  const templateExport = await exportThroughUi('导出模板');
  assert.match(templateExport.name, /\.runbook\.json$/);
  const exportedTemplate = JSON.parse(Buffer.from(templateExport.bytes).toString('utf8'));
  assert.equal(exportedTemplate.kind, 'template');
  assert.deepEqual(exportedTemplate.document, saved.document);
  assert.ok(!('entries' in exportedTemplate) && !('parameterValues' in exportedTemplate));
  assert.deepEqual(await instance(runId), beforeExport);
  checks.push('copy for fresh work preserves flow/current values, clears old materials/progress and starts at step one; save-as-template preserves original defaults and excludes instance values/results');

  await capture('complete');
  assert.deepEqual(pageErrors, []);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const fixtureCalls = await page.evaluate(() => window.__checklistSmoke.calls);
  assert.equal(fixtureCalls.probe, 1);
  assert.equal(fixtureCalls.pickImport, 1);
  assert.equal(fixtureCalls.saveExport, 2);
  assert.ok(fixtureCalls.failedSave > 0);
  if (clipboardMode === 'transport') assert.ok(fixtureCalls.clipboardWriteCount > 0, 'Actual clipboard plugin write IPC must reach the transport hook');
  const clipboardWrites = clipboardMode === 'transport' ? await page.evaluate(() => window.__checklistSmoke.clipboardWrites) : undefined;
  if (clipboardMode === 'transport') assert.equal(clipboardWrites.length, fixtureCalls.clipboardWriteCount);
  const result = { ok: true, isolatedDataDirectory: directory, checks, pageErrors, templateId: originalTemplate.id, runId, importedId: imported.id, restartId: restart.id, archivePath,
    fixtureCalls, clipboardMode, systemClipboardVerified: clipboardMode === 'system', clipboardTouched, clipboardWrites,
    nativeFileChooserAutomated: false, note: `${clipboardMode === 'transport' ? 'Explicit transport mode intercepts the actual clipboard plugin write IPC and verifies its exact text payloads; the system clipboard is neither accessed nor verified. ' : 'Command text is verified through actual system clipboard reads and its full original snapshot is restored in cleanup. '}OS file chooser return/save destination is replaced by the harness; native archive export, validation and import commit are real. Copied maintenance commands are never executed.` };
  await writeFile('.artifacts/checklist-check.json', JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  await capture('failure').catch(() => {});
  console.error(JSON.stringify({ checks, pageErrors, clipboardMode, systemClipboardVerified: false, clipboardTouched }));
  throw error;
} finally {
  if (clipboard) await clipboard.restore();
  await browser.close();
}
