// Import this module only in node_repl after reading Computer Use guidance/API.
// Each observe must be inspected before exactly one action; action refreshes immediately.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, appendFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { root } from './environment.mjs';

// Pass an existing repository-relative evidence root, e.g. .artifacts/native-audit.
export async function createNativeAudit(sky, sessionDirectory, evidenceRoot) {
  assert.ok(typeof evidenceRoot === 'string' && evidenceRoot.trim(), 'Pass an existing evidence root');
  assert.ok(typeof sessionDirectory === 'string' && sessionDirectory.trim(), 'Pass an existing isolated session directory');
  const dir = path.resolve(root, sessionDirectory), allowedRoot = path.resolve(root, evidenceRoot);
  const isChild = (parent, child) => {
    const relative = path.relative(parent, child);
    return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  assert.ok(isChild(path.join(root, '.artifacts'), allowedRoot), 'Evidence root must be inside this repository\'s .artifacts');
  assert.ok((await stat(allowedRoot)).isDirectory(), 'Evidence root must be an existing directory');
  assert.ok((await stat(dir)).isDirectory(), 'Session must be an existing directory');
  const [artifactsPath, allowedPath, sessionPath] = await Promise.all([
    realpath(path.join(root, '.artifacts')), realpath(allowedRoot), realpath(dir),
  ]);
  assert.ok(isChild(artifactsPath, allowedPath), 'Evidence root must resolve inside .artifacts');
  assert.ok(isChild(allowedPath, sessionPath), 'Session must resolve inside the evidence root');
  const session = JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8'));
  assert.equal(session.directory, dir);
  const evidence = path.join(dir, 'evidence'); await mkdir(evidence, { recursive: true });
  const allowedApps = new Set([`process:${session.executable}`.toLowerCase().replaceAll('/', '\\'), 'process:c:\\windows\\system32\\notepad.exe']);
  let latest = null, sequence = 0;
  const check = window => assert.ok(allowedApps.has(window.app.toLowerCase().replaceAll('/', '\\')), 'Window must be the isolated executable or a newly selected Notepad');
  async function log(value) { await appendFile(path.join(evidence, 'sky-actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', 'utf8'); }
  async function store(state, label) {
    assert.match(label, /^[a-zA-Z0-9_-]+$/);
    const prefix = `${String(++sequence).padStart(3, '0')}-${label}`;
    const frames = [];
    for (const [index, screenshot] of state.screenshots.entries()) {
      const match = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(screenshot.url);
      assert.ok(match, 'Unexpected screenshot encoding');
      const file = path.join(evidence, `${prefix}-${index}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`);
      await writeFile(file, Buffer.from(match[2], 'base64')); frames.push(file);
    }
    await writeFile(path.join(evidence, `${prefix}.json`), JSON.stringify({ at: new Date().toISOString(), window: state.window, accessibility: state.accessibility, frames }, null, 2));
    return { tree: state.accessibility?.tree, focused: state.accessibility?.focused_element, frames };
  }
  return {
    async select(app, title) {
      const windows = (await sky.list_windows()).filter(window => window.app.toLowerCase().replaceAll('/', '\\') === app.toLowerCase().replaceAll('/', '\\') && (title === undefined || window.title === title));
      assert.equal(windows.length, 1, `Expected exactly one returned window, found ${windows.length}`);
      check(windows[0]); latest = null; return windows[0];
    },
    async observe(window, label, screenshots = true) {
      check(window); latest = null;
      const state = await sky.get_window_state({ window, include_screenshot: screenshots, include_text: true });
      latest = state; return await store(state, label);
    },
    async act(action, label) {
      assert.ok(latest, 'Observe and inspect a fresh state before acting');
      const observation = latest; latest = null; check(observation.window);
      assert.ok(['click', 'press_key', 'type_text', 'scroll', 'activate_window'].includes(action.method));
      if (action.method === 'press_key') assert.ok(!/(?:^|\+)(?:meta|windows|win|cmd|command|super|os)(?:\+|$)/i.test(action.key), 'Windows-key shortcuts are forbidden');
      if (action.method === 'type_text') assert.ok(observation.accessibility?.focused_element, 'Observe editor focus before typing');
      const { method, ...input } = action;
      if ('x' in input || 'y' in input) {
        assert.ok(observation.screenshots?.[0]?.id, 'Coordinates require latest screenshot');
        input.screenshotId = observation.screenshots[0].id;
      }
      await log({ stage: 'before', method, input, window: observation.window });
      await sky[method]({ ...input, window: observation.window });
      const state = await sky.get_window_state({ window: observation.window, include_screenshot: true, include_text: true });
      // Do not arm another action; inspect this refresh then explicitly observe again.
      await log({ stage: 'after', method, window: state.window });
      return await store(state, label);
    },
  };
}
