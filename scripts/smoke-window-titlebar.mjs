import { openCommentComposer } from './step-materials.mjs';
// Run only through check-desktop.mjs. No user data, clipboard or maintenance commands.
// Window state comes from the installed Tauri window API command implementation.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const directory = process.env.RUNBOOK_TEST_DATA_DIR;
assert.ok(directory && process.env.RUNBOOK_DATA_DIR === directory && process.env.RUNBOOK_CDP_URL);
const actual = await realpath(directory), target = await realpath('target');
assert.equal(path.dirname(actual).toLowerCase(), target.toLowerCase());
assert.match(path.basename(actual), /^desktop-smoke-[A-Za-z0-9_-]+$/);
assert.ok((await readFile('target/debug/runbook-startup.log', 'utf8')).includes(`Data directory: ${actual}`));
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0], checks = [], layouts = [], pageErrors = [], states = [];
page.setDefaultTimeout(15000);
page.on('pageerror', error => pageErrors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const win = command => native(`plugin:window|${command}`, { label: 'main' });
const apply = action => native('checklist_apply', { action });
const load = () => native('checklist_load');
const titlebar = () => page.locator('header.app-topbar[data-window-titlebar]');
const minimize = () => page.getByRole('button', { name: '最小化窗口', exact: true });
const maximize = () => page.getByRole('button', { name: '最大化窗口', exact: true });
const restore = () => page.getByRole('button', { name: '还原窗口', exact: true });
const close = () => page.getByRole('button', { name: '关闭窗口', exact: true });
const templateId = 'qa-window-titlebar-template', runId = 'qa-window-titlebar-run', firstId = 'window-first';

async function saved() { await expect(page.locator('.save-state')).toContainText('已保存在本机'); }
async function capture(name) {
  const layout = await page.evaluate(name => {
    const box = element => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
    };
    const region = document.querySelector('header.app-topbar[data-window-titlebar]');
    const interactive = 'button,input,textarea,select,a,[role="button"],[contenteditable="true"]';
    const controls = [...region.querySelectorAll('button')].map(button => ({ label: button.getAttribute('aria-label') ?? button.textContent.trim(), box: box(button), drag: button.hasAttribute('data-tauri-drag-region') && button.getAttribute('data-tauri-drag-region') !== 'false', dragChildren: button.querySelectorAll('[data-tauri-drag-region]:not([data-tauri-drag-region="false"])').length }));
    const drag = [...document.querySelectorAll('[data-tauri-drag-region]:not([data-tauri-drag-region="false"])')].map(element => ({ tag: element.tagName, box: box(element), interactive: element.matches(interactive) || Boolean(element.closest(interactive)) }));
    return { name, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, documentWidth: document.documentElement.scrollWidth,
      app: box(document.querySelector('.checklist-app')), sidebar: box(document.querySelector('.app-sidebar')), titlebar: box(region),
      breadcrumb: box(region.querySelector('.breadcrumb')), workspace: box(document.querySelector('.workspace-page, .library-page')),
      controls, drag, blockedControlContainers: [...region.querySelectorAll('.topbar-right,.window-controls')].map(element => element.getAttribute('data-tauri-drag-region')),
      obsoleteTitlebar: document.querySelectorAll('.native-titlebar,.window-titlebar').length };
  }, name);
  layouts.push(layout);
  await writeFile(`.artifacts/window-titlebar-layout-${name}.json`, JSON.stringify(layout, null, 2), 'utf8');
  await page.screenshot({ path: `.artifacts/window-titlebar-${name}.png` });
  assert.equal(layout.viewport.scrollX, 0, `${name}: no root horizontal scroll`);
  assert.equal(layout.viewport.scrollY, 0, `${name}: no root vertical scroll`);
  assert.ok(layout.documentWidth <= layout.viewport.width + 1, `${name}: no root horizontal overflow`);
  for (const key of ['app', 'sidebar', 'titlebar', 'workspace']) {
    const box = layout[key];
    assert.ok(box && box.width > 0 && box.height > 0, `${name}: visible ${key}`);
    assert.ok(box.x >= -1 && box.y >= -1 && box.right <= layout.viewport.width + 1 && box.bottom <= layout.viewport.height + 1, `${name}: ${key} inside viewport`);
  }
  assert.equal(layout.app.y, 0, `${name}: application starts at the window top`);
  assert.equal(layout.sidebar.y, 0, `${name}: sidebar starts at the window top`);
  assert.equal(layout.titlebar.y, 0, `${name}: single integrated topbar starts at the window top`);
  assert.ok(layout.titlebar.height >= 28 && layout.titlebar.height <= 64, `${name}: no second title row`);
  assert.equal(layout.obsoleteTitlebar, 0, `${name}: no duplicate title row`);
  assert.ok(layout.drag.some(region => region.box.width > 20 && region.box.height > 10), `${name}: visible native drag region`);
  assert.ok(layout.drag.every(region => !region.interactive), `${name}: drag attributes must not be placed on interactive targets`);
  assert.ok(layout.controls.every(control => !control.drag && !control.dragChildren), `${name}: header controls must remain interactive`);
  assert.ok(layout.blockedControlContainers.length >= 2 && layout.blockedControlContainers.every(value => value === 'false'), `${name}: control containers explicitly block inherited deep dragging`);
  for (const label of ['最小化窗口', '关闭窗口']) {
    const button = layout.controls.find(control => control.label === label);
    assert.ok(button && button.box.width >= 28 && button.box.height >= 28, `${name}: usable ${label} target`);
    assert.ok(button.box.right <= layout.viewport.width + 1 && button.box.y >= 0 && button.box.bottom <= layout.titlebar.bottom + 1, `${name}: ${label} inside titlebar`);
  }
  return layout;
}

try {
  await mkdir('.artifacts', { recursive: true });
  assert.equal(await win('is_decorated'), false, 'Native system titlebar decorations are disabled');
  assert.equal(await win('is_resizable'), true, 'The frameless native window remains resizable');
  await expect(titlebar()).toHaveCount(1);
  for (const button of [minimize(), close()]) await expect(button).toBeVisible();
  const initialMaximized = await win('is_maximized');
  states.push({ phase: 'initial', maximized: initialMaximized, decorated: await win('is_decorated') });
  if (initialMaximized) { await restore().click(); await expect.poll(() => win('is_maximized')).toBe(false); }
  await expect(maximize()).toBeVisible();
  await maximize().click();
  await expect.poll(() => win('is_maximized')).toBe(true);
  await expect(restore()).toBeVisible();
  states.push({ phase: 'custom-button-maximized', maximized: await win('is_maximized') });
  await page.screenshot({ path: '.artifacts/window-titlebar-native-maximized.png' });
  await restore().click();
  await expect.poll(() => win('is_maximized')).toBe(false);
  await expect(maximize()).toBeVisible();
  states.push({ phase: 'custom-button-restored', maximized: await win('is_maximized') });
  checks.push('Native decorations are absent; the original application topbar owns accessible window controls; maximize and restore buttons change real native state and update their labels');

  await page.setViewportSize({ width: 1360, height: 940 });
  await capture('library-wide');
  const document = { parameters: [], groups: [], steps: [firstId, 'window-second'].map((id, index) => ({ id, title: [`窗口集成验证 ${index + 1}`], description: ['只记录人工结果，不执行命令。'], commands: [] })) };
  await apply({ type: 'create_work', id: runId, name: '窗口集成验证工作', document });
  await apply({ type: 'start_instance', id: runId });
  await page.reload();
  await page.locator(`[data-instance-id="${runId}"]`).click();
  await expect(page.locator('[data-inline-field="工作名称"]')).toBeVisible();
  await expect(page.locator(`[data-step-id="${firstId}"]`)).toHaveClass(/is-current/);
  await saved();
  await capture('instance-wide');
  await page.setViewportSize({ width: 940, height: 640 });
  await capture('instance-small');
  checks.push('Library and live-instance topbars start at y=0 beside the sidebar; wide and small viewports preserve usable native controls, breadcrumb and internal scrolling without duplicate title rows or root overflow');

  const step = page.locator(`[data-step-id="${firstId}"]`), comment = step.locator('textarea[aria-label="添加评论"]');
  await openCommentComposer(step);
  await comment.fill('尚未提交的窗口关闭验证评论');
  await step.locator('.comment-details > summary').click();
  await expect(comment).toBeHidden();
  const before = await load();
  const localDrafts = await page.evaluate(() => JSON.parse(localStorage.getItem('runbook.explicit-drafts.v1')));
  assert.ok(localDrafts.entries.some(([key, entry]) => key === `comment:${runId}:${firstId}` && entry.value === '尚未提交的窗口关闭验证评论'));
  await expect(comment).toHaveValue('尚未提交的窗口关闭验证评论');
  assert.deepEqual(await load(), before, 'Saving a local draft must not submit a comment or mutate the workspace');
  assert.equal(page.isClosed(), false);
  await capture('local-draft-retained');
  await openCommentComposer(step);
  await step.getByRole('button', { name: '清空', exact: true }).click();
  await expect(comment).toHaveValue('');
  await saved();
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.deepEqual(await load(), before);
  checks.push('Collapsed comment input is saved as a local draft without changing business data; actual close/restart with active drafts is covered by check-close-drafts.mjs');
  assert.deepEqual(pageErrors, []);
  const result = { ok: true, isolatedDataDirectory: actual, templateId, runId, checks, states, layouts, pageErrors, clipboardTouched: false, maintenanceCommandsExecuted: false,
    realDragAutomated: false, dragLimitation: 'Drag attributes are inspected; native mouse capture, snap and system titlebar menus are not automated.' };
  await writeFile('.artifacts/window-titlebar-check.json', JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: '.artifacts/window-titlebar-failure.png' }).catch(() => {});
  await writeFile('.artifacts/window-titlebar-check.json', JSON.stringify({ ok: false, isolatedDataDirectory: actual, checks, states, layouts, pageErrors, error: String(error) }, null, 2), 'utf8');
  throw error;
} finally {
  await browser.close();
}
