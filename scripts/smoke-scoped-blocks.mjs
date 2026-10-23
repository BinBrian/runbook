import { openCommentComposer } from './step-materials.mjs';
// Build first, then run with the existing owned-process harness:
// node scripts/check-desktop.mjs scripts/smoke-scoped-blocks.mjs
// This script never executes maintenance commands and never opens real user data.
// Explicit IPC-only clipboard option: RUNBOOK_CLIPBOARD_TEST_MODE=transport.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { readChecklistLayout } from './read-checklist-layout.mjs';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
const clipboardMode = process.env.RUNBOOK_CLIPBOARD_TEST_MODE ?? 'system';
assert.ok(['system', 'transport'].includes(clipboardMode), 'Clipboard transport must be explicitly selected; unknown modes cannot bypass complete clipboard preservation');
assert.ok(directory && path.isAbsolute(directory), 'Explicit isolated test directory required');
assert.equal(path.resolve(process.env.RUNBOOK_DATA_DIR ?? ''), path.resolve(directory));
const target = await realpath('target'), actualDirectory = await realpath(directory);
assert.equal(path.dirname(actualDirectory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actualDirectory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actualDirectory}`));
assert.ok(process.env.RUNBOOK_CDP_URL);
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const checks = [], pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const workspace = () => native('checklist_load');
const apply = action => native('checklist_apply', { action });
const templateId = 'qa-scoped-maintenance';
const template = async () => (await workspace()).templates.find(item => item.id === templateId);
const instance = async id => (await workspace()).instances.find(item => item.id === id);
const step = id => page.locator(`[data-step-id="${id}"]`);
const group = id => page.locator(`[data-group-id="${id}"]`).first();
const variablePanel = page.locator('[data-variable-panel]');
const scope = id => variablePanel.locator(`section[data-parameter-scope="${id}"]`);
let activeInstanceId;
async function capture(name) {
  const layout = await readChecklistLayout(page, name);
  await writeFile(`.artifacts/scoped-layout-${name}.json`, JSON.stringify(layout, null, 2), 'utf8');
  const screenshot = await page.screenshot({ path: `.artifacts/scoped-${name}.png` });
  // Save both diagnostics before asserting, so a viewport regression keeps its
  // evidence. Only the outer page is fixed; workspace-scroll may move freely.
  assert.equal(layout.window.scrollY, 0, `${name}: the browser page must not scroll outside the desktop viewport`);
  for (const selector of ['.checklist-app', '.app-sidebar']) {
    const element = layout.elements[selector];
    if (element) assert.equal(element.rect.y, 0, `${name}: ${selector} must stay anchored to the top of the viewport`);
  }
  return screenshot;
}
const nav = name => page.locator('.app-sidebar nav').getByRole('button').filter({ hasText: name }).click();
const imagePath = path.resolve('docs/examples/patch-maintenance/images/package-check-demo.png');
const imageBytes = await readFile(imagePath);
const ref = id => ({ parameterId: id });
const originalDocument = {
  groups: [{ id: 'qa-sandboxa', name: '示例环境A · 更新重启' }],
  parameters: [
    { id: 'qa-global-env', name: '环境', description: '正式维护所用的公共环境', defaultValue: 'release' },
    { id: 'qa-local-env', ownerId: 'qa-sandboxa', name: '环境', description: '仅本次更新重启使用', defaultValue: '' },
  ],
  steps: [
    { id: 'qa-before', title: ['核对正式维护 ', ref('qa-global-env')], description: ['全局标识 GLOBAL-01，核对后继续。'], commands: [] },
    ...[
      ['stop', '停止服务', ['stopserver ', ref('qa-local-env'), ' all']],
      ['publish', '发布程序', ['publishgame ', ref('qa-local-env')]],
      ['sync', '同步服务', ['syncgame ', ref('qa-local-env'), ' all']],
      ['start', '启动服务', ['startserver ', ref('qa-local-env'), ' all']],
    ].map(([id, title, text]) => ({ id: `qa-${id}`, groupId: 'qa-sandboxa', title: [title],
      description: [id === 'stop' ? '检查演练编号 LOCAL-01，保留另一处 LOCAL-01。' : '按实际操作记录结果。'], commands: [{ id: `qa-command-${id}`, text }] })),
    { id: 'qa-tail', title: ['正式维护后续'], description: ['继续使用公共环境。'], commands: [{ id: 'qa-global-command', text: ['allowlogin ', ref('qa-global-env'), ' all'] }] },
  ],
};
let clipboard, clipboardWriteCount = 0;
const clipboardWrites = [];

// Hold the full clipboard in one STA process and restore it even if an assertion
// fails. Only the test command text is returned; existing clipboard data is not.
async function preserveClipboard() {
  const source = String.raw`
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Windows.Forms
    function Invoke-ClipboardRetry([scriptblock] $Operation) {
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try { return (& $Operation) }
        catch { if ($attempt -eq 19) { throw }; Start-Sleep -Milliseconds 100 }
      }
    }
    # Do not announce READY until every original format has been captured. A
    # transient clipboard lock retries the complete snapshot; exhaustion fails
    # this script before the application is allowed to copy anything.
    $captured = Invoke-ClipboardRetry {
      $original = [System.Windows.Forms.Clipboard]::GetDataObject()
      $snapshot = New-Object System.Windows.Forms.DataObject
      $hadData = $null -ne $original
      if ($hadData) {
        foreach ($format in $original.GetFormats($false)) {
          $data = $original.GetData($format, $false)
          if ($null -eq $data) { throw 'An original clipboard format could not be captured completely' }
          $snapshot.SetData($format, $false, $data)
        }
      }
      return @{ Snapshot = $snapshot; HadData = $hadData }
    }
    [Console]::WriteLine('READY')
    while ($null -ne ($operation = [Console]::ReadLine())) {
      if ($operation -eq 'READ') {
        $copied = Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::GetText() }
        [Console]::WriteLine('TEXT:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($copied)))
      } elseif ($operation -eq 'RESTORE') {
        Invoke-ClipboardRetry { if ($captured.HadData) { [System.Windows.Forms.Clipboard]::SetDataObject($captured.Snapshot, $true, 1, 20) } else { [System.Windows.Forms.Clipboard]::Clear() } }
        [Console]::WriteLine('RESTORED')
        break
      }
    }
  `;
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', source], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout }), buffered = [], pending = [];
  let stderr = '', exited = false;
  child.stderr.on('data', value => { stderr += value.toString(); });
  lines.on('line', value => { const waiter = pending.shift(); if (waiter) waiter.resolve(value); else buffered.push(value); });
  child.on('exit', code => { exited = true; for (const waiter of pending.splice(0)) waiter.reject(new Error(`Clipboard helper exited ${code}: ${stderr}`)); });
  function line() {
    if (buffered.length) return Promise.resolve(buffered.shift());
    if (exited) return Promise.reject(new Error(`Clipboard helper exited: ${stderr}`));
    return new Promise((resolve, reject) => {
      const waiter = { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } };
      const timeout = setTimeout(() => { const index = pending.indexOf(waiter); if (index !== -1) pending.splice(index, 1); reject(new Error(`Clipboard helper timed out: ${stderr}`)); }, 10000);
      pending.push(waiter);
    });
  }
  assert.equal(await line(), 'READY');
  return {
    async read() { child.stdin.write('READ\n'); const result = await line(); assert.ok(result.startsWith('TEXT:')); return Buffer.from(result.slice(5), 'base64').toString('utf8'); },
    async restore() { try { child.stdin.write('RESTORE\n'); assert.equal(await line(), 'RESTORED'); } finally { child.stdin.end(); lines.close(); if (!exited) child.kill(); } },
  };
}

async function installFileFixtures() {
  await page.evaluate(clipboardMode => {
    const original = window.fetch.bind(window);
    window.__scopedSmoke = { imports: [], exports: [], clipboardWrites: [], calls: { probe: 0, pickImport: 0, saveExport: 0, clipboardWriteCount: 0 } };
    const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' } });
    const wrapped = async (input, init) => {
      const address = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (address.origin !== 'http://ipc.localhost' && !(address.protocol === 'ipc:' && address.hostname === 'localhost')) return original(input, init);
      const command = decodeURIComponent(address.pathname.slice(1)), state = window.__scopedSmoke;
      if (command === 'scoped_smoke_probe') { state.calls.probe++; return reply({ active: true }); }
      if (command === 'checklist_pick_import') { state.calls.pickImport++; if (!state.imports.length) throw new Error('Missing isolated import fixture'); return reply(state.imports.shift()); }
      if (command === 'checklist_save_export') { state.calls.saveExport++; state.exports.push(JSON.parse(init.body)); return reply(true); }
      if (clipboardMode === 'transport' && command === 'plugin:clipboard-manager|write_text') {
        const args = JSON.parse(init.body); if (typeof args.text !== 'string') throw new Error('Expected exact clipboard text payload');
        state.calls.clipboardWriteCount++; state.clipboardWrites.push(structuredClone(args)); return reply(null);
      }
      if (clipboardMode === 'transport' && command.startsWith('plugin:clipboard-manager|')) throw new Error('Unexpected OS clipboard operation in explicit transport mode');
      return original(input, init);
    };
    window.fetch = wrapped;
    if (window.fetch !== wrapped) throw new Error('File-dialog test seam did not install');
  }, clipboardMode);
  assert.deepEqual(await native('scoped_smoke_probe'), { active: true });
}
async function settle() {
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeEnabled();
  await expect(page.locator('.save-state')).toContainText('已保存在本机');
}
async function reload() {
  await page.reload();
  await page.getByRole('button', { name: '导入', exact: true }).waitFor();
  await expect(page.locator('.library-page')).toBeVisible();
}
async function openTemplate(id = templateId) {
  await nav('模板');
  await page.locator(`[data-template-id="${id}"]`).locator('.tile-open').click();
  await expect(page.locator('[data-inline-field="模板名称"]')).toBeVisible();
}
async function openInstance(id) {
  await nav('当前工作');
  await page.locator(`[data-instance-id="${id}"]`).click();
  await expect(page.locator('[data-inline-field="实例名称"]')).toBeVisible();
  activeInstanceId = id;
}
async function inlineEditor(source, label) {
  const textbox = source.getByRole('textbox', { name: label, exact: true });
  if (!await textbox.count()) await source.locator(`[data-inline-field="${label}"]`).dblclick();
  await expect(textbox).toBeVisible();
  return textbox;
}
async function selectLiteral(locator, literal) {
  await locator.focus();
  await locator.evaluate((element, literal) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.parentElement.closest('[data-parameter-id]')) continue;
      const index = text.textContent.indexOf(literal);
      if (index === -1) continue;
      const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + literal.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return;
    }
    throw new Error(`Selection not found: ${literal}`);
  }, literal);
}
async function chooseStepAction(source, name, isGroup = false) {
  const action = isGroup ? ({ 复制当前步骤块: '复制步骤组', 插入步骤块: '组后插入步骤块' })[name] ?? name : ({ 复制当前步骤块: '复制当前步骤' })[name] ?? name;
  const more = ['复制步骤组', '复制当前步骤', '保存为步骤块', '删除当前步骤', '删除步骤组及子步骤'].includes(action);
  const trigger = source.getByRole('button', { name: isGroup ? more ? '更多步骤组操作' : '步骤组新增' : more ? '更多步骤操作' : '步骤新增', exact: true });
  await trigger.focus();
  await trigger.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: action, exact: true }).click();
  await expect(menu).toHaveCount(0);
}
async function exportUi(name) {
  await settle();
  const count = await page.evaluate(() => window.__scopedSmoke.exports.length);
  await page.getByRole('button', { name, exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__scopedSmoke.exports.length)).toBe(count + 1);
  await settle();
  return page.evaluate(() => window.__scopedSmoke.exports.at(-1));
}
async function assertCopy(locator, text) {
  const before = clipboardMode === 'transport' ? await page.evaluate(() => window.__scopedSmoke.calls.clipboardWriteCount) : 0;
  await locator.click();
  if (clipboardMode === 'transport') {
    await expect.poll(() => page.evaluate(() => window.__scopedSmoke.calls.clipboardWriteCount)).toBe(before + 1);
    const payload = await page.evaluate(() => window.__scopedSmoke.clipboardWrites.at(-1)); assert.equal(payload.text, text); clipboardWrites.push(payload); clipboardWriteCount++;
  }
  await expect.poll(() => clipboard.read()).toBe(text);
  await settle();
}
async function complete(id) {
  await settle();
  await step(id).getByRole('button', { name: /^完成并/ }).click();
  await settle();
}
async function ensureOpenScope(id, { historical = false } = {}) {
  assert.ok(activeInstanceId, 'A selected isolated instance is required for parameter scope navigation');
  const value = await instance(activeInstanceId);
  assert.ok(value);
  const cursor = value.status === 'draft' ? 0 : value.document.steps.findIndex(item => item.id === value.currentStepId);
  const members = id === 'global' ? value.document.steps : value.document.steps.filter(item => item.id === id || item.groupId === id);
  const selected = historical ? members[0] : members.find(item => value.document.steps.indexOf(item) >= cursor);
  assert.ok(selected, `No ${historical ? 'historical' : 'unadvanced'} step exists for scope ${id}`);
  await page.locator(`[data-nav-step-id="${selected.id}"]`).click();
  await expect(variablePanel).toHaveAttribute('data-variable-target-step-id', selected.id);
  await expect(scope(id)).toBeVisible();
  return scope(id);
}
async function importNativeFixture(filename) {
  const fixture = JSON.parse(await readFile(filename, 'utf8'));
  const before = await workspace(), list = fixture.kind === 'block' ? 'blocks' : 'templates';
  const known = new Set((before[list] ?? []).map(item => item.id));
  const preview = await native('checklist_preview_import', { name: path.basename(filename), bytes: [...Buffer.from(JSON.stringify(fixture))] });
  const next = await native('checklist_commit_import', { token: preview.token, asCopy: preview.duplicate });
  const saved = next[list].find(item => !known.has(item.id));
  assert.ok(saved);
  assert.deepEqual(saved.document, fixture.document);
  const exported = await native('checklist_export_data', { kind: fixture.kind, id: saved.id });
  const reread = JSON.parse(Buffer.from(exported.bytes).toString('utf8'));
  assert.deepEqual(reread.document, fixture.document);
  assert.equal(reread.kind, fixture.kind);
  return saved;
}

try {
  await mkdir('.artifacts', { recursive: true });
  await page.setViewportSize({ width: 1360, height: 940 });
  clipboard = clipboardMode === 'transport' ? { read: () => page.evaluate(() => window.__scopedSmoke.clipboardWrites.at(-1)?.text ?? null), async restore() {} } : await preserveClipboard();
  const restartFixture = await importNativeFixture('docs/examples/blocks/restart-services.runbook.json');
  const transferFixture = await importNativeFixture('docs/examples/blocks/transfer-player.runbook.json');
  assert.equal(restartFixture.document.steps.length, 4);
  assert.equal(transferFixture.document.steps.length, 7);
  const maintenance = await importNativeFixture('templates/release-maintenance/maintenance.runbook.json');
  assert.equal(maintenance.document.steps.length, 46);
  assert.equal(maintenance.document.steps.reduce((sum, s) => sum + s.commands.length, 0), 32);
  assert.equal(maintenance.document.groups.length, 5);
  assert.equal(maintenance.document.parameters.length, 17);
  assert.deepEqual(maintenance.document.parameters.filter(p => !p.ownerId).map(p => [p.id, p.defaultValue]), [['environment', 'release']]);
  assert.equal(maintenance.document.parameters.find(p => p.id === 'sourceBranch').ownerId, 'copy-branch');
  assert.equal(maintenance.document.parameters.find(p => p.id === 'maintenanceStart').ownerId, 'maintenance-announcement');
  assert.equal(maintenance.document.parameters.find(p => p.id === 'maintenanceEnd').ownerId, 'maintenance-announcement');
  checks.push('Actual restart/transfer block files and the 46-step release template pass native import/export with the expected global/local identities and exact documents');
  await apply({ type: 'create_template', id: templateId, name: 'QA 参数作用域与步骤块', document: originalDocument });
  await reload();
  await installFileFixtures();
  await openTemplate();

  // A selected occurrence is group-local by default. An explicit global choice
  // is separate; identical labels never bind another group's parameter by name.
  const description = await inlineEditor(step('qa-stop'), '操作说明');
  await selectLiteral(description, 'LOCAL-01');
  await page.getByRole('button', { name: '新增变量', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新增变量', exact: true });
  await expect(dialog.locator('.token-choice')).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: '变量作用范围', exact: true }).locator('option:checked')).toHaveText('局部 · 本步骤组');
  await dialog.getByLabel('新变量名称', { exact: true }).fill('演练编号');
  await dialog.getByRole('button', { name: '创建并替换选区', exact: true }).click();
  await expect(description.locator('[data-parameter-id]')).toHaveCount(1);
  await expect(description).toContainText('保留另一处 LOCAL-01');
  await selectLiteral(await inlineEditor(step('qa-before'), '操作说明'), 'GLOBAL-01');
  await page.getByRole('button', { name: '新增变量', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新增变量', exact: true });
  await expect(dialog.locator('.token-choice')).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '变量作用范围', exact: true }).selectOption('');
  await dialog.getByLabel('新变量名称', { exact: true }).fill('全局标识');
  await dialog.getByRole('button', { name: '创建并替换选区', exact: true }).click();
  await settle();
  let saved = await template();
  const localCode = saved.document.parameters.find(p => p.name === '演练编号');
  const globalCode = saved.document.parameters.find(p => p.name === '全局标识');
  assert.equal(localCode.ownerId, 'qa-sandboxa');
  assert.ok(!globalCode.ownerId);
  checks.push('UI selection defaults to group-local, explicit global selection has no owner, and only the selected occurrence becomes a variable');

  await chooseStepAction(group('qa-sandboxa'), '保存为步骤块', true);
  dialog = page.getByRole('dialog', { name: '保存为步骤块', exact: true });
  await dialog.getByRole('textbox', { name: '步骤块名称', exact: true }).fill('QA 更新重启服务');
  await dialog.getByRole('button', { name: '保存步骤块', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settle();
  let block = (await workspace()).blocks.find(item => item.name === 'QA 更新重启服务');
  assert.ok(block);
  assert.equal(block.kind, 'block');
  assert.equal(block.document.groups.length, 1);
  assert.equal(block.document.steps.length, 4);
  assert.ok(block.document.parameters.every(p => p.ownerId));
  await chooseStepAction(group('qa-sandboxa'), '复制当前步骤块', true);
  await expect.poll(async () => (await template()).document.groups.length).toBe(2);
  await settle();
  for (let i = 0; i < 2; i++) {
    const last = (await template()).document.steps.at(-1);
    await chooseStepAction(last.groupId ? group(last.groupId) : step(last.id), '插入步骤块', Boolean(last.groupId));
    dialog = page.getByRole('dialog', { name: '插入步骤块', exact: true });
    await dialog.getByRole('button').filter({ hasText: 'QA 更新重启服务' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await template()).document.groups.length).toBe(3 + i);
    await settle();
  }
  await inlineEditor(step('qa-stop'), '操作说明');
  await selectLiteral(description, 'LOCAL-01');
  await page.getByRole('button', { name: '使用变量', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '使用变量', exact: true });
  await expect(dialog.getByLabel('新变量名称', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '创建并替换选区', exact: true })).toHaveCount(0);
  await expect(dialog.locator('.token-choice')).toHaveCount(4); // Two global + two owned by this group.
  await expect(dialog.locator('.token-choice').filter({ hasText: '演练编号' })).toHaveCount(1);
  await dialog.locator('.token-choice').filter({ hasText: '演练编号' }).click();
  await settle();
  saved = await template();
  assert.equal(saved.document.steps.length, 18);
  const groupIds = [...new Set(saved.document.steps.filter(s => s.groupId).map(s => s.groupId))];
  assert.equal(groupIds.length, 4);
  assert.equal(saved.document.steps.find(s => s.id === 'qa-stop').description.filter(part => typeof part !== 'string' && part.parameterId === localCode.id).length, 2);
  const storedBlock = (await workspace()).blocks.find(item => item.id === block.id);
  assert.equal(storedBlock.document.steps[0].description.filter(part => typeof part !== 'string').length, 1, 'An inserted group edit must not mutate the saved block definition');
  const allIds = [...saved.document.groups.map(g => g.id), ...saved.document.parameters.map(p => p.id), ...saved.document.steps.flatMap(s => [s.id, ...s.commands.map(c => c.id)])];
  assert.equal(new Set(allIds).size, allIds.length);
  const groupEnvironments = groupIds.map(id => saved.document.parameters.find(p => p.ownerId === id && p.name === '环境'));
  assert.ok(groupEnvironments.every(Boolean));
  assert.equal(new Set(groupEnvironments.map(p => p.id)).size, 4);
  for (const id of groupIds) {
    const allowed = new Set(saved.document.parameters.filter(p => !p.ownerId || p.ownerId === id || saved.document.steps.some(s => s.groupId === id && s.id === p.ownerId)).map(p => p.id));
    for (const s of saved.document.steps.filter(s => s.groupId === id)) for (const parts of [s.title, s.description, ...s.commands.map(c => c.text)]) {
      for (const part of parts) if (typeof part !== 'string') assert.ok(allowed.has(part.parameterId), 'A copied/inserted command must not reference another group');
    }
  }
  await capture('template');
  checks.push('UI saves a self-contained block, copies the player/environment group, and inserts two independent block uses with fresh IDs and local references');

  await nav('步骤块');
  await page.locator(`[data-block-id="${block.id}"]`).locator('.tile-open').click();
  const blockFile = await exportUi('导出步骤块');
  const exportedBlock = JSON.parse(Buffer.from(blockFile.bytes).toString('utf8'));
  assert.equal(exportedBlock.kind, 'block');
  assert.deepEqual(exportedBlock.document, block.document);
  assert.ok(!('parameterValues' in exportedBlock) && !('entries' in exportedBlock));
  await openTemplate();
  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '创建实例', exact: true });
  await dialog.getByRole('textbox', { name: '实例名称', exact: true }).fill('QA 四环境独立记录');
  await dialog.getByRole('button', { name: '创建实例', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const runId = (await workspace()).instances.find(item => item.name === 'QA 四环境独立记录').id;
  activeInstanceId = runId;
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeDisabled();
  const environments = ['sandboxa', 'sandboxb', 'sandboxc', 'sandboxd'];
  for (let i = 0; i < groupIds.length; i++) {
    await ensureOpenScope(groupIds[i]);
    await page.locator(`[data-parameter-target="${groupEnvironments[i].id}"]`).click();
    const input = scope(groupIds[i]).getByRole('textbox', { name: '环境', exact: true });
    await expect(input).toBeFocused();
    await input.fill(environments[i]);
    await expect(input).toHaveValue(environments[i]);
  }
  for (let i = 0; i < groupIds.length; i++) {
    await ensureOpenScope(groupIds[i]);
    await expect(scope(groupIds[i]).getByRole('textbox', { name: '环境', exact: true })).toHaveValue(environments[i]);
  }
  await expect(page.getByRole('button', { name: '开始记录', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  await expect.poll(async () => (await instance(runId)).currentStepId).toBe('qa-before');
  await settle();
  let run = await instance(runId);
  assert.equal(run.parameterValues['qa-global-env'], 'release');
  for (let i = 0; i < groupIds.length; i++) assert.equal(run.parameterValues[groupEnvironments[i].id], environments[i]);
  checks.push('Missing local values disable start, each missing-item link focuses its own scoped input, and four same-named environment values stay separate from global release');

  await complete('qa-before');
  await expect(group(groupIds[0])).toHaveAttribute('data-group-current', 'true');
  await expect(step('qa-stop')).toHaveClass(/is-current/);
  await assertCopy(step('qa-stop').getByRole('button', { name: '复制命令', exact: true }), 'stopserver sandboxa all');
  await step('qa-stop').getByRole('button', { name: '记录失败', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '记录失败', exact: true });
  await dialog.getByRole('textbox', { name: '失败原因', exact: true }).fill('演练：核对环境后重试，不执行命令。');
  await dialog.getByRole('button', { name: '保存失败记录', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settle();
  const localScope = await ensureOpenScope(groupIds[0]);
  await localScope.getByRole('textbox', { name: '环境', exact: true }).fill('sandboxa-verified');
  await expect(step('qa-stop').locator('[data-inline-field="命令 1"]')).toContainText('stopserver sandboxa all');
  await localScope.getByRole('button', { name: '应用本组参数', exact: true }).click();
  await settle();
  await expect(step('qa-stop').locator('[data-inline-field="命令 1"]')).toContainText('stopserver sandboxa-verified all');
  await complete('qa-stop');
  run = await instance(runId);
  const stopResults = run.entries.filter(e => e.type === 'result' && e.stepId === 'qa-stop');
  assert.deepEqual(stopResults.map(e => e.outcome), ['failed', 'completed']);
  assert.equal(stopResults[0].snapshot.commands[0].text, 'stopserver sandboxa all');
  assert.equal(stopResults[1].snapshot.commands[0].text, 'stopserver sandboxa-verified all');
  assert.equal(stopResults[0].snapshot.parameterValues[groupEnvironments[0].id], 'sandboxa');
  await ensureOpenScope(groupIds[0]); // Select the unadvanced member; the completed stop panel is read-only.
  await localScope.getByRole('textbox', { name: '环境', exact: true }).fill('sandboxa-final');
  await localScope.getByRole('button', { name: '应用本组参数', exact: true }).click();
  await settle();
  const globalScope = await ensureOpenScope('global');
  await globalScope.getByRole('textbox', { name: '环境', exact: true }).fill('release-verified');
  await globalScope.getByRole('button', { name: '应用全局参数', exact: true }).click();
  await settle();
  await expect(step('qa-publish').locator('[data-inline-field="命令 1"]')).toContainText('publishgame sandboxa-final');
  run = await instance(runId);
  assert.equal(run.entries.find(e => e.type === 'result' && e.stepId === 'qa-before').snapshot.title, '核对正式维护 release');
  for (let i = 1; i < groupIds.length; i++) assert.equal(run.parameterValues[groupEnvironments[i].id], environments[i]);
  await complete('qa-publish'); await complete('qa-sync'); await complete('qa-start');
  run = await instance(runId);
  const nextStep = run.document.steps.find(s => s.id === run.currentStepId);
  // The original tail is outside the group. Inserts may sit after that tail;
  // preserve the actual flat order and advance the manual outer step if needed.
  if (!nextStep.groupId) await complete(nextStep.id);
  run = await instance(runId);
  const currentStepId = run.currentStepId, currentGroupId = run.document.steps.find(s => s.id === currentStepId).groupId;
  assert.equal(currentGroupId, groupIds[1]);
  await expect(group(currentGroupId)).toHaveAttribute('data-group-current', 'true');
  await ensureOpenScope(groupIds[0], { historical: true });
  await expect(scope(groupIds[0]).getByRole('textbox', { name: '环境', exact: true })).toHaveAttribute('readonly', '');
  await expect(scope(groupIds[0]).getByRole('textbox', { name: '环境', exact: true })).toHaveValue(stopResults[1].snapshot.parameterValues[groupEnvironments[0].id]);
  const frozenBefore = await instance(runId);
  await assert.rejects(() => apply({ type: 'apply_parameters', id: runId, values: { ...frozenBefore.parameterValues, [groupEnvironments[0].id]: 'forbidden-change' } }));
  assert.deepEqual(await instance(runId), frozenBefore);
  checks.push('Local values require explicit application, failures and advanced results retain original snapshots, global edits do not change local environments, and completed group-local values become immutable');

  await page.locator(`[data-nav-step-id="${currentStepId}"]`).click();
  await expect(variablePanel).toHaveAttribute('data-variable-target-step-id', currentStepId);
  await openCommentComposer(step(currentStepId));
  await step(currentStepId).getByRole('textbox', { name: '添加评论', exact: true }).fill('局部环境核对完成；图片作为人工记录。');
  await step(currentStepId).getByRole('button', { name: '添加评论', exact: true }).click();
  await settle();
  await step(currentStepId).locator('input[type=file]').setInputFiles(imagePath);
  await expect(step(currentStepId).locator('.image-preview img')).toBeVisible();
  await settle();
  await capture('history');
  const beforeExport = await instance(runId);
  const archive = await exportUi('导出存档');
  const archivePath = path.join(directory, 'scoped-complete.runbook.zip');
  await writeFile(archivePath, Buffer.from(archive.bytes));
  const zipCheck = spawnSync('python', ['-c', [
    'import json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' d=json.loads(z.read("runbook.json")); images=[e["path"] for e in d["entries"] if e["type"]=="image"]',
    ' assert d["formatVersion"]==2 and len(d["document"]["groups"])==4',
    ' assert set(z.namelist())==set(["runbook.json"]+images) and len(images)==1',
    ' assert z.read(images[0])==open(sys.argv[2],"rb").read()',
  ].join('\n'), archivePath, imagePath], { encoding: 'utf8', windowsHide: true });
  assert.equal(zipCheck.status, 0, zipCheck.stderr);
  // Prove an instance archive is self-contained even after every source block
  // is removed. No production workspace or shared library is touched.
  for (const item of (await workspace()).blocks) await apply({ type: 'delete_block', id: item.id });
  assert.deepEqual((await workspace()).blocks, []);
  await reload();
  await installFileFixtures();
  await page.evaluate(file => window.__scopedSmoke.imports.push(file), archive);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导入预览', exact: true });
  await expect(dialog).toContainText('本地已存在同一份实例');
  await dialog.getByRole('button', { name: '导入为独立副本', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settle();
  const imported = (await workspace()).instances.find(item => item.id !== runId);
  assert.ok(imported);
  activeInstanceId = imported.id;
  assert.deepEqual(imported.document, beforeExport.document);
  assert.deepEqual(imported.parameterValues, beforeExport.parameterValues);
  assert.deepEqual(imported.entries.filter(e => e.type !== 'image'), beforeExport.entries.filter(e => e.type !== 'image'));
  assert.equal(imported.currentStepId, currentStepId);
  assert.deepEqual(await instance(runId), beforeExport);
  await expect(group(currentGroupId)).toHaveAttribute('data-group-current', 'true');
  await expect(step(currentStepId).locator('.image-preview img')).toBeVisible();
  const image = imported.entries.find(e => e.type === 'image');
  assert.deepEqual(Buffer.from((await native('checklist_read_image', { instanceId: imported.id, path: image.path })).split(',')[1], 'base64'), imageBytes);
  assert.deepEqual((await workspace()).blocks, []);
  checks.push('Native ZIP contains complete v2 document/local values/frozen history/image bytes; UI duplicate import restores a fully independent ongoing copy after deleting the entire source block library');

  await openTemplate(maintenance.id);
  for (const item of maintenance.document.groups) await expect(group(item.id)).toBeVisible();
  await page.getByRole('button', { name: '创建实例', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '创建实例', exact: true });
  await dialog.getByRole('textbox', { name: '实例名称', exact: true }).fill('QA 实际维护模板填参');
  await dialog.getByRole('button', { name: '创建实例', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settle();
  const maintenanceRunId = (await workspace()).instances.find(item => item.name === 'QA 实际维护模板填参').id;
  activeInstanceId = maintenanceRunId;
  const announcement = await ensureOpenScope('maintenance-announcement');
  await announcement.getByRole('textbox', { name: '维护开始时间', exact: true }).fill('2026-10-21-08-00');
  await announcement.getByRole('textbox', { name: '维护结束时间', exact: true }).fill('2026-10-21-09-00');
  await announcement.getByRole('button', { name: '应用本组参数', exact: true }).click();
  await settle();
  const player1 = await ensureOpenScope('player-transfer-1');
  await player1.getByRole('textbox', { name: '玩家 ID（通知用）', exact: true }).fill('QA-PLAYER-1');
  await player1.getByRole('button', { name: '应用本组参数', exact: true }).click();
  await settle();
  const maintenanceRun = await instance(maintenanceRunId);
  assert.equal(maintenanceRun.parameterValues.transfer1PlayerId, 'QA-PLAYER-1');
  assert.equal(maintenanceRun.parameterValues.transfer2PlayerId, '9002002');
  assert.equal(maintenanceRun.parameterValues.transfer3PlayerId, '9002003');
  assert.equal(maintenanceRun.parameterValues.environment, 'release');
  const sandboxaParameter = maintenanceRun.document.parameters.find(p => p.ownerId?.includes('sandboxa') && p.name.includes('环境'))
    ?? maintenanceRun.document.parameters.find(p => p.ownerId && p.defaultValue === 'sandboxa');
  assert.ok(sandboxaParameter);
  assert.equal(maintenanceRun.parameterValues[sandboxaParameter.id], 'sandboxa');
  assert.equal(maintenanceRun.status, 'draft');
  checks.push('Actual maintenance template renders all five groups; its local maintenance times and first player ID are filled/applied through the UI without changing the other players or sandboxa/global environments');

  const legacy = JSON.parse(await readFile('docs/examples/patch-maintenance/template.runbook.json', 'utf8'));
  legacy.id = 'qa-legacy-flat-template';
  // The old portable fixture intentionally omits optional timestamps. Give this
  // preservation check explicit originals so a generated default cannot satisfy
  // the assertion that importing/exporting retains supplied historical values.
  legacy.createdAt = '2026-10-19T01:00:00Z';
  legacy.updatedAt = '2026-10-19T02:00:00Z';
  const old = structuredClone(legacy);
  const preview = await native('checklist_preview_import', { name: 'legacy.runbook.json', bytes: [...Buffer.from(JSON.stringify(legacy))] });
  await native('checklist_commit_import', { token: preview.token, asCopy: false });
  const legacyRead = (await workspace()).templates.find(item => item.id === legacy.id);
  // Import is a new write, so the version upgrades to v2. Missing groups are
  // normalized to []; all old defaults, text and timestamps must stay intact.
  const normalizedOld = { ...old, formatVersion: 2, document: { ...old.document, groups: [] } };
  assert.deepEqual(legacyRead, normalizedOld);
  const legacyExport = await native('checklist_export_data', { kind: 'template', id: legacy.id });
  assert.deepEqual(JSON.parse(Buffer.from(legacyExport.bytes).toString('utf8')), normalizedOld);
  await reload();
  await openInstance(runId);
  await expect(group(currentGroupId)).toHaveAttribute('data-group-current', 'true');
  await expect(step(currentStepId)).toHaveClass(/is-current/);
  await settle();
  await capture('complete');
  assert.deepEqual(pageErrors, []);
  await expect(page.getByRole('alert')).toHaveCount(0);
  checks.push('Importing a v1 flat template upgrades only the version/missing empty groups, preserving its document/defaults/timestamps exactly through export; the ongoing original still opens at its saved current group and step');
  if (clipboardMode === 'transport') assert.ok(clipboardWriteCount > 0, 'At least one real clipboard write IPC must be captured');
  const result = { ok: true, isolatedDataDirectory: directory, checks, pageErrors, templateId, runId, importedId: imported.id,
    currentStepId, currentGroupId, groupIds, groupEnvironments: groupEnvironments.map(p => p.id), legacyTemplateId: legacy.id,
    maintenanceRunId, maintenanceTemplateId: maintenance.id, archivePath, imagePath, blocksEmpty: true, viewportRootAssertions: true, nativeFileChooserAutomated: false, maintenanceCommandsExecuted: false,
    clipboardMode, clipboardWriteCount, clipboardWrites, clipboardTouched: clipboardMode === 'system', systemClipboardVerified: clipboardMode === 'system',
    note: clipboardMode === 'transport' ? 'File-picker results/save destinations and clipboard write IPC are explicit fixtures; native export, ZIP validation and import commit are real. Exact copied text is verified without reading or writing the OS clipboard.' : 'Only OS file-picker results/save destinations are replaced; native export, ZIP validation and import commit are real. The full system clipboard is restored in finally.' };
  await writeFile('.artifacts/scoped-check.json', JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  // The startup guard above restricts this driver to its generated isolated
  // workspace. These are its synthetic test values, never a user workspace.
  const inputs = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll('input[data-parameter-id]')].map(input => ({
      parameterId: input.dataset.parameterId,
      scope: input.closest('[data-parameter-scope]')?.getAttribute('data-parameter-scope'),
      label: input.getAttribute('aria-label'), value: input.value,
      readonly: input.readOnly, disabled: input.disabled,
      focused: input === document.activeElement, visible: Boolean(input.getClientRects().length),
    })),
    missingTargets: [...document.querySelectorAll('[data-parameter-target]')].map(button => ({
      parameterId: button.getAttribute('data-parameter-target'), label: button.textContent,
    })),
    saveState: document.querySelector('.save-state')?.textContent,
  })).catch(reason => ({ unavailable: String(reason) }));
  await writeFile('.artifacts/scoped-parameter-inputs-failure.json', JSON.stringify(inputs, null, 2), 'utf8').catch(() => {});
  await capture('failure').catch(() => {});
  console.error(JSON.stringify({ checks, pageErrors }));
  throw error;
} finally {
  if (clipboard) await clipboard.restore();
  await browser.close();
}
