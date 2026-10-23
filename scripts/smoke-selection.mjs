// Connect only to an isolated Runbook test window; maintenance commands are never executed.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { convertSelection } from '../packages/markdown/editor/src/transforms.ts';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && path.isAbsolute(directory), 'An isolated RUNBOOK_TEST_DATA_DIR is required');
const relative = path.relative(path.resolve('target'), directory);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${directory}`));
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL ?? 'http://127.0.0.1:9345');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  // Check the transformed source against the authoritative native parser, not only text snapshots.
  const command = '  echo "中文🙂"  ';
  const stepId = '5cc32c5a-dbb9-46f6-a447-43a52e2a445d';
  const cases = [
    [command + '\n后说明', command],
    ['前说明\n' + command + '\n后说明', command],
    ['前说明\n' + command, command],
    ['前说明\r\n' + command + '\r\n后说明', command + '\r\n'],
    ['前说明\n' + command + '\n后说明', 'echo "中文🙂"'],
    ['前缀 echo selected 后缀', 'echo selected'],
    [`<!-- runbook:document version="1" -->\n\n<!-- runbook:step id="${stepId}" -->\n\n前说明\n${command}\n后说明\n\n<!-- /runbook:step -->`, command],
  ];
  for (const [source, selected] of cases) {
    const from = source.indexOf(selected);
    const markdown = convertSelection(source, { from, to: from + selected.length }, 'command');
    const parsed = await page.evaluate(markdown => window.__TAURI_INTERNALS__.invoke('parse_markdown', { markdown }), markdown);
    assert.deepEqual(parsed.diagnostics, [], markdown);
    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].commands.length, 1);
    assert.equal(parsed.steps[0].commands[0].text, selected);
    if (source.includes(stepId)) assert.equal(parsed.steps[0].id, stepId);
  }

  await page.getByRole('button', { name: '新建模板', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('textbox').fill('单行转换回归');
  await page.getByRole('button', { name: '创建并编辑', exact: true }).click();
  await page.getByRole('button', { name: '源码对照', exact: true }).click();
  await page.locator('.cm-content').click();
  const uiCommand = '  echo "selected line"  ';
  await page.keyboard.insertText('前面的说明\n' + uiCommand + '\n后面的说明');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  // CodeMirror's smart Home first chooses the indentation, then the physical line start.
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: '转为指令', exact: true }).click();
  await expect(page.locator('.preview-panel .command-card')).toContainText('echo "selected line"');
  await expect(page.locator('.preview-panel')).toContainText('前面的说明');
  await expect(page.locator('.preview-panel')).toContainText('后面的说明');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.getByRole('button', { name: '创建执行实例', exact: true }).click();
  await page.getByRole('button', { name: '创建并开始记录', exact: true }).click();
  await expect(page.locator('.step-description .command-card')).toContainText('echo "selected line"');
  const workspace = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('load_workspace'));
  const run = workspace.runs.find(item => item.initial_template_snapshot.name === '单行转换回归');
  assert.ok(run);
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].definition.commands[0].text, uiCommand);
  assert.match(run.applied_markdown, /前面的说明/);
  assert.match(run.applied_markdown, /后面的说明/);
  assert.deepEqual(errors, []);
  await mkdir('.artifacts', { recursive: true });
  await page.screenshot({ path: '.artifacts/selection-line.png' });
  console.log(JSON.stringify({ ok: true, nativeCases: cases.length, selectedText: uiCommand, surroundingTextPreserved: true, pageErrors: errors }));
} finally { await browser.close(); }
