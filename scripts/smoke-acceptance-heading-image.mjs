// Run through check-desktop.mjs against a freshly built candidate.
// Real WebView2 pointer/keyboard interactions; isolated native seed only.
// Composition dispatch is a regression guard, NOT a Windows IME acceptance.
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

assert.equal(process.env.RUNBOOK_DATA_DIR, process.env.RUNBOOK_TEST_DATA_DIR);
assert.ok(process.env.RUNBOOK_CDP_URL);
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-[A-Za-z0-9_-]+$/);
const output = path.resolve(process.env.RUNBOOK_TEST_OUTPUT_DIR ?? '.artifacts/acceptance-heading-image-2026-10-23');
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL), page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const checks = [], layouts = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action });
const id = 'heading-image-acceptance', load = () => native('checklist_load');
const work = async () => (await load()).instances.find(item => item.id === id);
const card = stepId => page.locator(`[data-step-id="${stepId}"]`);
const title = stepId => card(stepId).locator('[data-inline-field="步骤标题"]');
const editor = stepId => title(stepId).getByRole('textbox', { name: '步骤标题', exact: true });
const arrow = stepId => card(stepId).locator(':scope > .step-card-heading > button.step-expand-toggle.icon-button');
const longTitle = '维护测试服：先核对维护目标和维护窗口，再确认当前服务状态，最后记录核对结果\n第二行说明保留原有换行';
const documentFixture = { parameters: [], groups: [{ id: 'group', name: '维护核对组', description: '检查组内新增步骤和标题编辑入口。' }], steps: [
  { id: 'first', title: ['维护前准备'], description: ['只记录人工确认，不执行维护命令。'], commands: [] },
  ...Array.from({ length: 5 }, (_, index) => ({ id: `middle-${index}`, title: [`人工核验 ${index + 1}`], description: ['记录检查结果。'], commands: [] })),
  { id: 'child', groupId: 'group', title: ['核对测试服'], description: ['组内步骤。'], commands: [] },
  { id: 'tail', title: [longTitle], description: ['页尾展开后改变标题高度，也不能让双击落到邻卡。'], commands: [] },
] };
async function saved(predicate) { if (predicate) await expect.poll(predicate).toBe(true); await expect(page.locator('.save-state')).toContainText('已保存在本机'); }
async function locate(stepId) {
  await page.locator(`[data-nav-step-id="${stepId}"]`).click();
  await expect(card(stepId).locator(':scope > .step-card-heading')).toHaveAttribute('aria-expanded', 'true');
  await title(stepId).scrollIntoViewIfNeeded();
  await title(stepId).evaluate(element => new Promise((resolve, reject) => {
    let last, stable = 0, frames = 0;
    function sample() { const r = element.getBoundingClientRect(), next = [r.x, r.y, r.width, r.height]; stable = last && next.every((value, i) => Math.abs(value - last[i]) < .1) ? stable + 1 : 0; last = next; if (stable >= 3) resolve(); else if (++frames > 180) reject(new Error('Title failed to stabilize')); else requestAnimationFrame(sample); }
    requestAnimationFrame(sample);
  }));
}
async function capture(name) {
  const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, rootWidth: document.documentElement.scrollWidth, focused: document.activeElement?.getAttribute('aria-label') }));
  assert.ok(layout.rootWidth <= layout.width + 1); layouts.push({ name, ...layout });
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
}
async function syntheticCompositionGuard(field, label) {
  await field.dispatchEvent('compositionstart', { data: '维' });
  for (const key of ['Escape', 'Enter']) { await field.press(key); await expect(field).toBeVisible(); await expect(field).toBeFocused(); }
  await field.dispatchEvent('compositionend', { data: '维护' });
  await field.press('Escape'); await expect(field).toHaveCount(0);
  checks.push({ check: 'composition-key-guard', field: label, synthetic: true, actualWindowsIME: false });
}
async function contrast(button, state) {
  const metrics = await button.evaluate(element => {
    const style = getComputedStyle(element), svg = getComputedStyle(element.querySelector('svg'));
    function luminance(color) { const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; }
    const a = luminance(style.backgroundColor), b = luminance(svg.stroke);
    return { color: style.color, background: style.backgroundColor, stroke: svg.stroke, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), outline: style.outlineStyle, outlineWidth: style.outlineWidth, bounds: element.getBoundingClientRect().toJSON() };
  });
  assert.ok(metrics.contrast >= 4.5, `${state}: close icon contrast ${metrics.contrast}`);
  assert.ok(metrics.bounds.width >= 34 && metrics.bounds.height >= 34);
  if (state === 'keyboard-focus') assert.ok(metrics.outline !== 'none' && parseFloat(metrics.outlineWidth) >= 2);
  return { state, ...metrics };
}
try {
  await apply({ type: 'create_work', id, name: '维护测试服 · 标题和图片修复验收', document: documentFixture });
  await page.reload(); await page.locator(`[data-instance-id="${id}"]`).click();
  for (const width of [1360, 940]) {
    await page.setViewportSize({ width, height: 780 });
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-switcher').click();
      await locate('tail'); const before = await work();
      await title('tail').click(); await expect(card('tail').locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true');
      await arrow('tail').click(); await expect(card('tail').locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'false');
      await title('tail').click(); await expect(card('tail').locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'false');
      await arrow('tail').press('Enter'); await expect(card('tail').locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true');
      assert.deepEqual(await work(), before);
      await title('tail').hover(); const pencil = title('tail').getByRole('button', { name: '编辑步骤标题', exact: true });
      await expect.poll(() => pencil.evaluate(n => getComputedStyle(n).opacity)).toBe('1');
      const textBounds = await title('tail').locator('.parts-view').boundingBox(), pencilBounds = await pencil.boundingBox();
      assert.ok(pencilBounds.x > textBounds.x, 'Pencil remains on the title trailing edge');
      await capture(`title-hover-${theme}-${width}`);
      await pencil.click(); await expect(editor('tail')).toBeFocused(); await editor('tail').press('Escape');
      await title('tail').focus(); await expect.poll(() => pencil.evaluate(n => getComputedStyle(n).opacity)).toBe('1');
      await title('tail').press('F2'); await expect(editor('tail')).toBeFocused(); await editor('tail').press('Escape');
      await title('tail').press('Enter'); await expect(editor('tail')).toBeFocused(); await editor('tail').press('Escape');
      await locate('tail');
      const geometry = await title('tail').boundingBox();
      await title('tail').dblclick(); await expect(editor('tail')).toBeFocused();
      await expect(card('tail').locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true');
      await editor('tail').fill(`${longTitle} · ${theme} ${width}`); await editor('tail').press('Escape');
      await saved(async () => (await work()).document.steps.find(s => s.id === 'tail').title[0] === `${longTitle} · ${theme} ${width}`);
      const finalGeometry = await title('tail').boundingBox();
      checks.push({ check: 'title-single-click-arrow-and-edit', width, theme, originalGeometry: geometry, finalGeometry, explicitPencil: true, keyboard: ['Enter', 'F2'], endOfPageDoubleClick: true });
      await capture(`title-saved-${theme}-${width}`);
    }
  }
  await page.setViewportSize({ width: 1360, height: 780 });
  await locate('tail');
  await card('tail').locator(':scope > [data-step-actions] > button').click();
  await page.getByRole('menuitem', { name: '新增后续步骤', exact: true }).click();
  await saved(async () => (await work()).document.steps.length === 9);
  const added = (await work()).document.steps.at(-1);
  await expect(editor(added.id)).toBeFocused(); await editor(added.id).fill('新增后立即编辑标题'); await editor(added.id).press('Escape');
  await saved(async () => (await work()).document.steps.at(-1).title[0] === '新增后立即编辑标题');
  await locate('child'); await page.locator('[data-group-id="group"] > [data-step-actions] > button').click();
  await page.getByRole('menuitem', { name: '添加子步骤', exact: true }).click();
  await saved(async () => (await work()).document.steps.length === 10);
  const child = (await work()).document.steps.find(s => !documentFixture.steps.some(old => old.id === s.id) && s.id !== added.id);
  assert.equal(child.groupId, 'group'); await expect(editor(child.id)).toBeFocused(); await editor(child.id).fill('新增组内核对'); await editor(child.id).press('Escape'); await saved();
  checks.push({ check: 'new-step-title-auto-focus', standaloneId: added.id, groupedId: child.id, placeholderStored: false });

  await locate('tail'); await title('tail').press('F2'); await expect(editor('tail')).toBeFocused(); await syntheticCompositionGuard(editor('tail'), '步骤标题');
  const workTitle = page.locator('[data-inline-field="工作名称"]'); await workTitle.focus(); await workTitle.press('F2');
  await syntheticCompositionGuard(workTitle.getByRole('textbox', { name: '工作名称', exact: true }), '工作名称');
  await saved();
  await page.getByRole('button', { name: '开始记录', exact: true }).click(); await expect(card('first')).toHaveClass(/is-current/);
  const bytes = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 560; canvas.height = 300; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eef3fb'; ctx.fillRect(0, 0, 560, 300); ctx.fillStyle = '#2357a5'; ctx.fillRect(30, 40, 500, 8); ctx.font = '28px sans-serif'; ctx.fillText('维护测试服 · 图片预览', 40, 130); ctx.font = '18px sans-serif'; ctx.fillStyle = '#3a4658'; ctx.fillText('仅用于关闭按钮、主题和键盘焦点验收', 40, 185); return Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0)); });
  await native('checklist_attach_image', { instanceId: id, stepId: 'first', name: 'heading-image-fixture.png', mediaType: 'image/png', bytes });
  await page.reload(); await page.locator(`[data-instance-id="${id}"]`).click(); await locate('first');
  const baseline = await work();
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-switcher').click();
    for (const width of [1360, 940]) {
      await page.setViewportSize({ width, height: 780 });
      const thumbnail = card('first').locator('button.image-preview');
      await thumbnail.click(); const dialog = page.getByRole('dialog', { name: '图片预览', exact: true }), close = dialog.getByRole('button', { name: '关闭图片', exact: true });
      await expect(close).toBeFocused(); await page.mouse.move(50, 700);
      const states = [await contrast(close, 'normal')]; await close.hover(); states.push(await contrast(close, 'hover'));
      await page.mouse.move(50, 700); await close.press('Tab'); await expect(close).toBeFocused(); states.push(await contrast(close, 'keyboard-focus'));
      await capture(`image-close-${theme}-${width}`); await close.press('Escape'); await expect(dialog).toHaveCount(0); await expect(thumbnail).toBeFocused();
      await thumbnail.click(); await close.click(); await expect(dialog).toHaveCount(0); await expect(thumbnail).toBeFocused();
      assert.deepEqual(await work(), baseline); checks.push({ check: 'image-close-contrast-focus-and-dismiss', theme, width, states });
    }
  }
  await page.setViewportSize({ width: 1360, height: 780 }); await locate('first');
  await card('first').getByRole('button', { name: '完成并下一步', exact: true }).click();
  await expect.poll(async () => (await work()).currentStepId).toBe('middle-0');
  await locate('first'); const frozen = await work();
  await expect(title('first')).toHaveClass(/is-readonly/); await expect(title('first').locator('.inline-edit-trigger')).toHaveCount(0);
  await title('first').click(); await expect(card('first').locator('.step-card-heading')).toHaveAttribute('aria-expanded', 'true');
  await title('first').dblclick(); await expect(editor('first')).toHaveCount(0); assert.deepEqual(await work(), frozen);
  checks.push({ check: 'frozen-title-remains-readonly', currentStepId: frozen.currentStepId, imageCount: frozen.entries.filter(entry => entry.type === 'image').length });
  await capture('frozen-title');
  assert.deepEqual(errors, []);
  const result = { ok: true, directory, checks, layouts, errors, realUserDataOpened: false, maintenanceCommandsExecuted: false, systemClipboardAccessed: false, nativeFileDialogsAutomated: false, imageSetupUsesNativeFixture: true, actualWindowsIME: false, syntheticCompositionGuardOnly: true };
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify(result, null, 2), 'utf8'); console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  const ui = await page.evaluate(() => ({ body: document.body.innerText, focused: document.activeElement?.outerHTML, selected: getSelection()?.toString() })).catch(() => null);
  await writeFile(path.join(output, 'inspection.json'), JSON.stringify({ ok: false, directory, checks, layouts, errors, error: String(error), ui, actualWindowsIME: false }, null, 2), 'utf8'); throw error;
} finally { await browser.close(); }
