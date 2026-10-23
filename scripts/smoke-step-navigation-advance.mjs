import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

// The native launcher owns this database/process. Never open the user's workspace.
const directory = await realpath(process.env.RUNBOOK_TEST_DATA_DIR), target = await realpath('target');
assert.equal(path.dirname(directory).toLowerCase(), target.toLowerCase());
assert.match(path.basename(directory), /^desktop-smoke-/);
const output = process.env.RUNBOOK_TEST_OUTPUT_DIR ?? '.artifacts/navigation-advance-2026-10-23';
await mkdir(output, { recursive: true });
const baseline = process.env.RUNBOOK_NAV_TEST_MODE === 'baseline';
const boundaries = process.env.RUNBOOK_NAV_TEST_MODE === 'boundaries';
const browser = await chromium.connectOverCDP(process.env.RUNBOOK_CDP_URL);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const cases = [], errors = [], failures = [];
page.on('pageerror', error => errors.push(error.message));
const native = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const apply = action => native('checklist_apply', { action });
const load = () => native('checklist_load');
const step = id => page.locator(`[data-step-id="${id}"]`);
const row = id => page.locator(`[data-nav-step-id="${id}"]`);
const content = {
  parameters: [],
  groups: [
    { id: 'g1', name: '准备检查' }, { id: 'g2', name: '发布和维护' },
    { id: 'g3', name: '玩家转区' }, { id: 'g4', name: '外服更新' }, { id: 'g5', name: '结束检查' },
  ],
  steps: Array.from({ length: 92 }, (_, index) => ({
    id: `s${index}`, groupId: index < 24 ? 'g1' : index < 48 ? 'g2' : index < 77 ? 'g3' : index < 86 ? 'g4' : 'g5',
    title: [`步骤 ${index + 1} · ${index % 4 === 0 ? '详细核对并记录维护结果，长标题用于验证目录截断与正文换行' : '核对当前服务状态'}`],
    description: [Array.from({ length: [2, 32, 5, 44, 1][index % 5] }, (_, line) => `检查项 ${line + 1}：第 ${index + 1} 步只记录操作，不运行实际命令。`).join('\n')],
    commands: index % 3 === 0 ? [] : [{ id: `command-${index}`, text: [Array.from({ length: index % 2 === 0 ? 18 : 2 }, (_, line) => `record-only step-${index + 1} line-${line + 1}`).join('\n')] }],
  })),
};

async function settle() {
  await page.evaluate(() => new Promise(resolve => {
    let previous, stable = 0, count = 0;
    const tick = () => {
      const main = document.querySelector('.workspace-scroll'), list = document.querySelector('.step-nav-list');
      const state = [main?.scrollTop, main?.scrollHeight, list?.scrollTop, document.querySelector('[data-viewing="true"]')?.dataset.navStepId];
      stable = previous && state.every((value, index) => value === previous[index]) ? stable + 1 : 0;
      previous = state;
      if (stable >= 8 || ++count >= 180) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

async function openWork(id, completed = 74, expanded = false, fixture = content) {
  await apply({ type: 'create_work', id, name: `目录推进验证 ${id}`, document: fixture });
  await apply({ type: 'start_instance', id });
  for (let index = 0; index < completed; index++) await apply({ type: 'record_result', id, outcome: 'completed', reason: null });
  await page.reload();
  await page.locator(`[data-instance-id="${id}"]`).click();
  await expect(step(`s${completed}`)).toHaveClass(/is-current/);
  if (expanded) await page.getByRole('button', { name: '展开步骤目录', exact: true }).click();
  await settle();
}

async function clickVisibleComplete(button) {
  // At 940px the explicitly expanded directory is an overlay. Use the visible
  // right edge of this real button, not force/DOM click or its covered center.
  const bounds = await button.boundingBox();
  assert.ok(bounds && bounds.width > 24 && bounds.height > 10);
  const position = { x: bounds.width - 12, y: bounds.height / 2 };
  const point = { x: bounds.x + position.x, y: bounds.y + position.y };
  const exposed = await button.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point);
  assert.ok(exposed, 'the chosen completion click point must be genuinely exposed');
  await button.click({ position });
}

async function positionList(id, placement) {
  // Set up a user's independently chosen directory position without changing any
  // execution state. Trace capture begins only after this setup has settled.
  return page.evaluate(({ id, placement }) => {
    const list = document.querySelector('.step-nav-list'), item = list.querySelector(`[data-nav-step-id="${id}"]`);
    const box = list.getBoundingClientRect(), rect = item.getBoundingClientRect();
    const documentTop = list.scrollTop + rect.top - box.top;
    const top = placement === 'top' ? 0 : placement === 'visible' ? documentTop - box.height / 2 : documentTop - box.height + 4;
    list.scrollTo({ top, behavior: 'instant' });
    const final = item.getBoundingClientRect();
    return { placement, top: list.scrollTop, itemTop: final.top - box.top, itemBottom: final.bottom - box.top, height: list.clientHeight };
  }, { id, placement });
}

async function record(targetId, duration = 1650) {
  await page.evaluate(({ targetId, duration }) => {
    window.__navAdvanceTrace?.finish?.();
    const root = document.querySelector('.workspace-scroll'), list = document.querySelector('.step-nav-list');
    if (!root || !list) throw new Error('Missing document or directory scroll area');
    const samples = [], calls = [], events = [], restored = [], start = performance.now();
    const now = () => performance.now() - start;
    for (const [name, element] of [['document', root], ['directory', list]]) {
      const own = Object.getOwnPropertyDescriptor(element, 'scrollTo'), original = element.scrollTo;
      element.scrollTo = function (...args) {
        const options = typeof args[0] === 'object' ? args[0] : { left: args[0], top: args[1] };
        calls.push({ t: now(), area: name, behavior: options?.behavior ?? 'auto', from: this.scrollTop,
          to: Math.max(0, Math.min(options?.top ?? this.scrollTop, this.scrollHeight - this.clientHeight)) });
        return Reflect.apply(original, this, args);
      };
      const wheel = event => events.push({ t: now(), area: name, type: 'wheel', deltaY: event.deltaY, top: element.scrollTop });
      element.addEventListener('wheel', wheel, { capture: true, passive: true });
      restored.push(() => { if (own) Object.defineProperty(element, 'scrollTo', own); else delete element.scrollTo; element.removeEventListener('wheel', wheel, true); });
    }
    let resolve, frame, finished = false;
    const done = new Promise(value => { resolve = value; });
    const data = { targetId, samples, calls, events };
    function finish() {
      if (finished) return;
      finished = true; cancelAnimationFrame(frame); restored.forEach(restore => restore()); resolve(data);
    }
    function sample() {
      const item = list.querySelector(`[data-nav-step-id="${targetId}"]`), bounds = list.getBoundingClientRect(), rect = item?.getBoundingClientRect();
      const heading = root.querySelector(`[data-step-id="${targetId}"] .step-card-heading`), head = heading?.getBoundingClientRect(), body = root.getBoundingClientRect();
      samples.push({ t: now(), navTop: list.scrollTop, navHeight: list.clientHeight, navMax: list.scrollHeight - list.clientHeight,
        viewing: list.querySelector('[data-viewing="true"]')?.dataset.navStepId,
        current: list.querySelector('[data-current="true"]')?.dataset.navStepId,
        rootTop: root.scrollTop, rootHeight: root.clientHeight, jumpTarget: root.dataset.stepJumpTarget ?? null,
        itemTop: rect ? rect.top - bounds.top : null, itemBottom: rect ? rect.bottom - bounds.top : null,
        headingTop: head ? head.top - body.top : null, headingBottom: head ? head.bottom - body.top : null,
      });
      if (now() >= duration) finish(); else frame = requestAnimationFrame(sample);
    }
    window.__navAdvanceTrace = { data, done, finish }; sample();
  }, { targetId, duration });
}
const recorded = () => page.evaluate(() => window.__navAdvanceTrace.done);

function inspect(trace) {
  const first = trace.samples[0], last = trace.samples.at(-1), selected = [];
  for (const sample of trace.samples) if (selected.at(-1)?.id !== sample.viewing) selected.push({ id: sample.viewing, t: sample.t, current: sample.current });
  const distance = last.navTop - first.navTop, direction = Math.sign(distance);
  const movement = trace.samples.slice(1).map((sample, index) => sample.navTop - trace.samples[index].navTop);
  const intermediate = new Set(trace.samples.filter(sample => Math.abs(sample.navTop - first.navTop) > .5 && Math.abs(sample.navTop - last.navTop) > .5).map(sample => Math.round(sample.navTop * 4) / 4)).size;
  const tail = trace.samples.slice(-8);
  return { ...trace, first, last, selected, distance, intermediate,
    reversed: direction !== 0 && movement.some(delta => delta * direction < -1.5),
    overshot: trace.samples.some(sample => sample.navTop < Math.min(first.navTop, last.navTop) - 1.5 || sample.navTop > Math.max(first.navTop, last.navTop) + 1.5),
    maxFrameDelta: Math.max(0, ...movement.map(Math.abs)),
    settledDrift: Math.max(...tail.map(sample => sample.navTop)) - Math.min(...tail.map(sample => sample.navTop)),
    visible: last.itemTop >= -1 && last.itemBottom <= last.navHeight + 1,
  };
}

async function check(name, result, verify) {
  const entry = { name, ...result };
  cases.push(entry);
  try { verify(entry); entry.ok = true; }
  catch (error) {
    entry.ok = false; entry.error = String(error); failures.push({ name, error: String(error) });
    await page.screenshot({ path: `${output}/${name}-failure.png` });
  }
}

function assertPinned(result, advancement = true) {
  const relevant = advancement ? result.samples.filter(sample => sample.current === result.targetId) : result.samples.slice(result.samples.findIndex(sample => sample.viewing === result.targetId));
  assert.ok(relevant.length > 10, 'must observe the settled target, not only one final frame');
  assert.deepEqual([...new Set(relevant.map(sample => sample.viewing))], [result.targetId], 'directory selection must go directly to the destination without flashing intermediate body steps');
  assert.equal(result.last.viewing, result.targetId);
  assert.ok(result.visible, 'the selected directory item must end fully visible');
  assert.ok(result.settledDrift < 1, 'directory must remain stable after navigation');
}

function assertSmooth(result) {
  assert.ok(Math.abs(result.distance) > 3, 'fixture must require some directory scrolling');
  assert.ok(!result.reversed && !result.overshot, 'directory scroll must approach its destination monotonically without snapping back');
  assert.ok(result.intermediate >= 2, 'directory movement must have visible intermediate animation frames, not one scrollTop jump');
  if (Math.abs(result.distance) > 50) assert.ok(result.maxFrameDelta < Math.abs(result.distance) * .85, 'a long directory move must not happen in one near-instant frame');
}

async function advance(from, placement, label, reduced = false) {
  const complete = step(`s${from}`).getByRole('button', { name: '完成并下一步', exact: true });
  await complete.scrollIntoViewIfNeeded(); await settle();
  const setup = await positionList(`s${from + 1}`, placement);
  await record(`s${from + 1}`); await clickVisibleComplete(complete);
  await expect(step(`s${from + 1}`)).toHaveClass(/is-current/);
  const result = { setup, ...inspect(await recorded()) };
  await check(label, result, value => {
    assertPinned(value);
    if (placement === 'visible') assert.ok(value.samples.every(sample => Math.abs(sample.navTop - value.first.navTop) < 1.5), 'already-visible next item must not scroll the directory');
    else if (reduced) assert.ok(!value.calls.some(call => call.area === 'directory' && call.behavior === 'smooth'), 'reduced motion must avoid smooth directory animation');
    else assertSmooth(value);
  });
}

async function interrupted(area) {
  const id = `interrupt-${area}`;
  await openWork(id, 76, true);
  const complete = step('s76').getByRole('button', { name: '完成并下一步', exact: true });
  await complete.scrollIntoViewIfNeeded(); await settle(); await positionList('s77', 'top');
  await record('s77', 1900); await clickVisibleComplete(complete);
  await page.waitForFunction(() => {
    const data = window.__navAdvanceTrace.data;
    return data.samples.some(sample => Math.abs(sample.navTop - data.samples[0].navTop) > 2);
  }, {}, { polling: 'raf' });
  const bounds = await page.locator(area === 'directory' ? '.step-nav-list' : '.workspace-scroll').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -260);
  const result = inspect(await recorded());
  await check(`interrupt-${area}`, result, value => {
    const event = value.events.find(item => item.area === area && item.type === 'wheel');
    assert.ok(event, 'must deliver a real wheel event to the intended scroll area');
    assert.equal(value.last.current, 's77', 'scroll interruption must not change the committed execution step');
    assert.ok(value.settledDrift < 1, 'user scroll must settle rather than fight automatic scrolling');
    if (area === 'directory') {
      const calls = value.calls.filter(call => call.area === 'directory' && call.t >= event.t);
      assert.ok(!calls.some(call => call.behavior === 'smooth'), 'directory wheel must cancel automatic directory follow, not restart it');
      assert.ok(!calls.some(call => Math.abs(call.to - call.from) > 1.5), 'directory wheel must not be followed by an instant jump back');
      assert.ok(value.last.navTop < event.top + 2, 'upward user wheel must not be overruled by continued downward follow');
    } else {
      const late = value.samples.filter(sample => sample.t > event.t + 300);
      assert.ok(late.every(sample => sample.jumpTarget !== 's77'), 'body wheel must release the programmatic navigation target');
      assert.ok(!value.calls.some(call => call.area === 'document' && call.t > event.t && call.behavior === 'smooth'), 'body wheel must not restart the canceled document animation');
    }
  });
  await page.locator('.back-button').click();
}

async function filterAtTop() {
  const id = 'navigation-short-filter', fixture = {
    parameters: [
      { id: 'filter-value', name: '搜索目标', description: '', defaultValue: '已确认' },
      { id: 'unused-value', name: '无引用变量', description: '', defaultValue: '保留' },
    ],
    groups: [],
    steps: [
      { id: 'short-a', title: ['第一步'], description: ['当前执行步骤'], commands: [] },
      { id: 'short-b', title: ['引用步骤'], description: [{ parameterId: 'filter-value' }], commands: [] },
      { id: 'short-c', title: ['最后一步'], description: [], commands: [] },
    ],
  };
  await apply({ type: 'create_work', id, name: '顶部短工作引用筛选', document: fixture });
  await apply({ type: 'start_instance', id });
  await page.reload(); await page.locator(`[data-instance-id="${id}"]`).click(); await settle();
  const initial = await page.locator('.workspace-scroll').evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight, target: element.dataset.stepJumpTarget }));
  assert.equal(initial.top, 0, 'short-work fixture must start at scrollTop 0');
  assert.equal(initial.max, 0, 'short-work fixture must fit entirely in the document viewport');
  assert.equal(initial.target, 'short-a', 'initial navigation should retain the first-step identity');
  const search = page.getByRole('searchbox', { name: '搜索变量', exact: true });
  if (!await search.isVisible()) await page.getByRole('button', { name: '展开变量面板', exact: true }).click();
  const saved = (await load()).instances.find(item => item.id === id);
  await record('short-b'); await search.fill('搜索目标');
  await expect(step('short-a')).toHaveCount(0); await expect(step('short-b')).toBeVisible();
  await check('short-top-filter-releases-target', { initial, ...inspect(await recorded()) }, value => {
    assertPinned(value, false);
    assert.equal(value.last.current, 'short-a', 'filter must not advance execution');
    assert.equal(value.last.jumpTarget, null, 'filter must release the old hidden target even when scrollTop cannot change');
    assert.equal(value.last.rootTop, 0);
  });
  await page.getByRole('button', { name: '清空变量搜索', exact: true }).click(); await settle();
  await expect(page.locator('.step-card[data-step-id]')).toHaveCount(3);
  // Re-establish the old target at exactly zero before testing the separate
  // variable-click path whose reference set is empty.
  await row('short-a').click(); await settle();
  assert.equal(await page.locator('.workspace-scroll').getAttribute('data-step-jump-target'), 'short-a');
  await record('short-a');
  await page.locator('[data-variable-id="unused-value"] [data-variable-name]').click();
  await expect(page.locator('.step-card[data-step-id]')).toHaveCount(0);
  await expect(page.getByText('没有匹配的变量引用步骤', { exact: true })).toBeVisible();
  await check('short-top-empty-filter-releases-target', inspect(await recorded()), value => {
    assert.equal(value.last.jumpTarget, null, 'selecting an unreferenced variable must release the hidden old target');
    assert.equal(value.last.viewing, undefined, 'empty results must not keep a hidden directory reading selection');
    assert.equal(value.last.current, 'short-a');
    assert.equal(value.last.rootTop, 0);
  });
  await page.getByRole('button', { name: '清空变量搜索', exact: true }).click(); await settle();
  await expect(page.locator('.step-card[data-step-id]')).toHaveCount(3);
  assert.deepEqual((await load()).instances.find(item => item.id === id), saved, 'filter and clearing it must leave execution data unchanged');
  await page.locator('.back-button').click();
}

async function finalSteps() {
  const id = 'navigation-last-steps', fixture = {
    ...content,
    steps: content.steps.map((item, index) => index < 90 ? item : { ...item, title: [`最后确认 ${index + 1}`], description: ['简短确认内容。'], commands: [] }),
  };
  await openWork(id, 90, true, fixture);
  await advance(90, 'edge', 'last-step-clamped-arrival');
  const arrival = cases.at(-1).last;
  assert.equal(arrival.current, 's91');
  const clamped = await page.locator('.workspace-scroll').evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
  assert.ok(Math.abs(clamped.top - clamped.max) < 1.5, 'last-step fixture must exercise a destination clamped to the document bottom');
  const complete = step('s91').getByRole('button', { name: '完成并结束', exact: true });
  await complete.scrollIntoViewIfNeeded(); await settle(); await record('s91'); await clickVisibleComplete(complete);
  await expect(step('s91').locator('.step-status-label')).toHaveText('已完成');
  await check('completion-releases-target', inspect(await recorded()), value => {
    assert.equal(value.last.current, undefined, 'completed work has no current execution step');
    assert.equal(value.last.jumpTarget, null, 'completion must remove the retained navigation target');
    assert.equal(value.last.viewing, 's91');
    assert.ok(value.visible && value.settledDrift < 1, 'final directory selection must remain visible and stable');
  });
  const saved = (await load()).instances.find(item => item.id === id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.entries.filter(entry => entry.type === 'result').length, 92);
  await page.locator('.back-button').click();
}

try {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const [width, height, expanded] of boundaries ? [] : baseline ? [[1360, 780, false]] : [[1360, 780, false], [1360, 780, true], [940, 660, false], [940, 660, true]]) {
    await page.setViewportSize({ width, height });
    const mode = `${width}-${expanded ? 'expanded' : 'compact'}`, id = `navigation-${mode}`;
    await openWork(id, 74, expanded);
    await page.screenshot({ path: `${output}/${mode}-before.png` });
    await advance(74, 'visible', `${mode}-visible`);
    await advance(75, 'edge', `${mode}-edge`);
    await advance(76, 'edge', `${mode}-cross-group`);
    const saved = (await load()).instances.find(item => item.id === id);
    assert.equal(saved.currentStepId, 's77');
    assert.equal(saved.entries.filter(entry => entry.type === 'result').length, 77);
    if (!baseline) {
      // Arrow/Home/End move keyboard focus only. Enter navigates; none records a result.
      await row('s77').focus(); await page.keyboard.press('Home'); await expect(row('s0')).toBeFocused();
      await page.keyboard.press('End'); await expect(row('s91')).toBeFocused();
      await page.keyboard.press('ArrowUp'); await expect(row('s90')).toBeFocused();
      await record('s90'); await page.keyboard.press('Enter');
      await check(`${mode}-keyboard-locate`, inspect(await recorded()), value => { assertPinned(value, false); assert.equal(value.last.current, 's77'); });
      await record('s77'); await page.locator('.step-nav-return').click();
      await check(`${mode}-return-current`, inspect(await recorded()), value => {
        assertPinned(value, false); assert.equal(value.last.current, 's77');
        const alreadyVisible = value.first.itemTop >= 0 && value.first.itemBottom <= value.first.navHeight;
        if (alreadyVisible) assert.ok(value.samples.every(sample => Math.abs(sample.navTop - value.first.navTop) < 1.5), 'returning to an already-visible directory item must not move the list');
        else assertSmooth(value);
      });
      assert.deepEqual((await load()).instances.find(item => item.id === id), saved, 'directory keyboard navigation and return must not modify work data');
    }
    await page.screenshot({ path: `${output}/${mode}-after.png` });
    await page.locator('.back-button').click();
  }
  if (!baseline) {
    await page.setViewportSize({ width: 1360, height: 780 });
    if (!boundaries) { await interrupted('directory'); await interrupted('document'); }
    await filterAtTop(); await finalSteps();
    await page.emulateMedia({ reducedMotion: 'reduce' }); await openWork('navigation-reduced', 76, true);
    await advance(76, 'edge', 'reduced-motion-cross-group', true);
  }
  assert.deepEqual(errors, []);
  const report = { ok: failures.length === 0, baseline, boundaries, directory, cases, failures, errors, realUserDataOpened: false, maintenanceCommandsExecuted: false };
  await writeFile(`${output}/inspection.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, cases: cases.map(({ samples, calls, events, ...value }) => value) }));
  assert.equal(failures.length, 0, `${failures.length} directory trajectory checks failed; see inspection.json`);
} catch (error) {
  const pendingTrace = await page.evaluate(() => window.__navAdvanceTrace?.data).catch(() => null);
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await writeFile(`${output}/inspection.json`, JSON.stringify({ ok: false, baseline, boundaries, directory, cases, failures, errors, pendingTrace, error: String(error), realUserDataOpened: false, maintenanceCommandsExecuted: false }, null, 2));
  throw error;
} finally {
  await page.evaluate(() => window.__navAdvanceTrace?.finish?.()).catch(() => {});
  await browser.close();
}
