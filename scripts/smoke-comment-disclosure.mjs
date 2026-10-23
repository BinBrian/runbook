import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const output = '.artifacts/comment-disclosure-2026-10-21', checks = [], errors = [];
await mkdir(output, { recursive: true }); page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action });
const id = 'comment-disclosure-run', step = name => page.locator(`[data-step-id="${name}"]`);
const disclosure = () => step('first').locator('.comment-details'), summary = () => disclosure().locator(':scope > summary');
const comment = () => disclosure().locator('textarea[aria-label="添加评论"]');
const instance = async () => (await native('checklist_load')).instances.find(item => item.id === id);
const open = async () => { await page.getByRole('button', { name: '导入', exact: true }).waitFor(); await page.locator(`[data-instance-id="${id}"]`).click(); };
function progress(value) { return { document: value.document, status: value.status, currentStepId: value.currentStepId, parameterValues: value.parameterValues }; }
try {
  const document = { parameters: [], steps: ['first', 'second'].map(name => ({ id: name, title: [name === 'first' ? '核对服务状态' : '后续检查'], description: ['手动核对并记录结果。'], commands: [] })) };
  await apply({ type: 'create_template', id: 'comment-disclosure-template', name: 'QA 补充记录折叠', document });
  await apply({ type: 'create_instance', id, name: '补充记录验收', templateId: 'comment-disclosure-template', fromInstanceId: null });
  await apply({ type: 'start_instance', id }); await page.reload(); await open();
  const baseline = await instance();
  await expect(disclosure()).not.toHaveAttribute('open'); await expect(comment()).toBeHidden();
  for (const viewport of [{ width: 1360, height: 940 }, { width: 940, height: 640 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-switcher').click();
      await expect(comment()).toBeHidden(); await page.screenshot({ path: `${output}/collapsed-${theme}-${viewport.width}.png` });
      await summary().focus(); await summary().press('Space'); await expect(comment()).toBeVisible();
      await expect(disclosure().getByRole('button', { name: '添加图片', exact: true })).toHaveText('添加图片');
      await expect(disclosure()).not.toContainText('PNG / JPG'); await expect(disclosure()).not.toContainText('MiB');
      const geometry = await disclosure().evaluate(node => ({ width: innerWidth, rootWidth: document.documentElement.scrollWidth, rect: node.getBoundingClientRect().toJSON() }));
      assert.ok(geometry.rootWidth <= geometry.width + 1 && geometry.rect.left >= 0 && geometry.rect.right <= geometry.width);
      await page.screenshot({ path: `${output}/expanded-${theme}-${viewport.width}.png` });
      await summary().focus(); await summary().press('Enter'); await expect(comment()).toBeHidden();
    }
  }
  assert.deepEqual(await instance(), baseline);
  checks.push('Composer defaults closed and keyboard Space/Enter toggles it; both themes and 1360/940 layouts fit without format/size helper text, while opening/closing does not change data');
  await page.setViewportSize({ width: 1360, height: 940 });
  await summary().click(); await comment().fill('待补充：服务状态核对通过。'); await summary().click();
  await expect(summary()).toContainText('有未提交评论'); await expect(comment()).toBeHidden();
  await expect(comment()).toHaveValue('待补充：服务状态核对通过。');
  await step('first').getByRole('button', { name: '收起步骤 1', exact: true }).first().click();
  await page.locator('[data-nav-step-id="second"]').click();
  await page.locator('[data-nav-step-id="first"]').click();
  await expect(comment()).toBeHidden(); await expect(summary()).toContainText('有未提交评论');
  await summary().click(); await expect(comment()).toHaveValue('待补充：服务状态核对通过。'); assert.deepEqual(await instance(), baseline);
  await disclosure().getByRole('button', { name: '添加评论', exact: true }).click();
  await expect.poll(async () => (await instance()).entries.filter(entry => entry.type === 'comment').length).toBe(1);
  await expect(comment()).toHaveValue(''); await expect(summary()).not.toContainText('有未提交评论');
  assert.deepEqual(progress(await instance()), progress(baseline));
  checks.push('Collapsing the composer and step navigation preserve the unsent draft and visible pending marker; explicit submission saves one comment and clears only its draft without advancing');
  const imagePath = path.join(directory, 'fixture.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF2cAAAAASUVORK5CYII=', 'base64');
  await writeFile(imagePath, bytes);
  const chooser = page.waitForEvent('filechooser'); await disclosure().getByRole('button', { name: '添加图片', exact: true }).click(); await (await chooser).setFiles(imagePath);
  await expect(step('first').locator('.image-preview img')).toBeVisible();
  const image = (await instance()).entries.find(entry => entry.type === 'image'); assert.ok(image);
  assert.deepEqual(await readFile(path.join(directory, 'checklist-images', id, image.path)), bytes);
  await summary().click(); await expect(comment()).toBeHidden();
  await expect(step('first').locator('.comment-record')).toContainText('服务状态核对通过'); await expect(step('first').locator('.image-preview img')).toBeVisible();
  await page.screenshot({ path: `${output}/records-remain-visible.png` });
  checks.push('The Add Image button still invokes the chooser and saves the exact PNG bytes through native IPC; existing comments/images remain visible when only the composer is collapsed');
  await apply({ type: 'terminate_instance', id, reason: 'QA 检查结束后补充' }); await page.reload(); await open();
  await expect(comment()).toBeHidden(); const ended = await instance();
  await summary().click(); await comment().fill('终止后仍可补充备注。'); await disclosure().getByRole('button', { name: '添加评论', exact: true }).click();
  await expect.poll(async () => (await instance()).entries.filter(entry => entry.type === 'comment').length).toBe(2);
  assert.deepEqual(progress(await instance()), progress(ended));
  checks.push('Ended instances also start collapsed and still accept explicit comments without changing frozen flow, status or results');
  assert.deepEqual(errors, []);
  const result = { ok: true, directory, checks, errors, clipboardTouched: false, nativeFilePickerAutomated: false, fileChooserFixture: true, maintenanceCommandsExecuted: false };
  await writeFile(`${output}/report.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await writeFile(`${output}/failure.json`, JSON.stringify({ directory, error: String(error), checks, errors }, null, 2)); throw error;
} finally { await browser.close(); }
