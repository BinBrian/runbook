// Real Windows acceptance support. GUI actions are exclusively @oai/sky in node_repl.
// This CLI never clicks, types, replaces clipboard/dialog IPC, or synthesizes events.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.artifacts/acceptance-2026-10-23/native');
const args = Object.fromEntries(process.argv.slice(3).map(arg => {
  const i = arg.indexOf('='); return [arg.slice(0, i), arg.slice(i + 1)];
}));
const mode = process.argv[2] ?? 'help';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2), 'utf8');
const within = (base, value) => {
  const relative = path.relative(base, value);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Outside isolated root: ${value}`);
  return value;
};
async function loadSession() {
  assert.ok(args['--session'], 'Pass --session=<absolute session directory>');
  const dir = await realpath(within(output, path.resolve(args['--session'])));
  const session = JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8'));
  assert.equal(session.directory, dir);
  for (const field of ['executable', 'dataDirectory', 'exportsDirectory']) within(dir, session[field]);
  assert.equal(sha(await readFile(session.executable)), session.sha256, 'Candidate bytes changed');
  return session;
}
async function connect(session) {
  const { chromium } = await import('@playwright/test');
  const launch = JSON.parse(await readFile(path.join(session.directory, 'launch.json'), 'utf8'));
  assert.equal(launch.executable, session.executable);
  const browser = await chromium.connectOverCDP(launch.cdpUrl);
  const pages = browser.contexts().flatMap(context => context.pages());
  assert.equal(pages.length, 1, 'Expected one isolated WebView');
  return { browser, page: pages[0], launch };
}
if (mode === 'prepare') {
  assert.ok(args['--candidate'], 'Pass --candidate=<built candidate exe>');
  const candidate = await realpath(args['--candidate']);
  assert.equal(path.dirname(candidate).toLowerCase(), path.join(root, 'target/debug').toLowerCase());
  assert.ok(['runbook-desktop.exe', 'runbook-desktop-candidate.exe'].includes(path.basename(candidate).toLowerCase()));
  await mkdir(output, { recursive: true });
  const dir = await mkdtemp(path.join(output, 'session-'));
  for (const name of ['bin', 'data', 'exports', 'evidence']) await mkdir(path.join(dir, name));
  const executable = path.join(dir, 'bin/runbook-native-acceptance.exe');
  await copyFile(candidate, executable);
  const session = {
    version: 1, createdAt: new Date().toISOString(), directory: dir, candidate, executable,
    sha256: sha(await readFile(executable)), dataDirectory: path.join(dir, 'data'),
    exportsDirectory: path.join(dir, 'exports'),
    realUserDataOpened: false, maintenanceCommandsExecuted: false,
    nativeActionsPerformed: false, clipboardTransportHook: false, fileDialogReplacement: false,
  };
  await json(path.join(dir, 'session.json'), session);
  await json(path.join(dir, 'results.json'), { status: 'prepared', checks: [] });
  console.log(JSON.stringify(session, null, 2));
} else if (mode === 'launch') {
  assert.equal(args['--candidate-ready'], 'yes', 'Launch only after root confirms the final candidate is ready');
  const session = await loadSession();
  let previous;
  try { previous = JSON.parse(await readFile(path.join(session.directory, 'launch.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    try { process.kill(previous.pid, 0); assert.fail('Previous isolated process still running; close it normally through Sky'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(session.executable, [], {
    cwd: path.dirname(session.executable), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, RUNBOOK_DATA_DIR: session.dataDirectory, RUNBOOK_NO_ERROR_DIALOG: '1',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  // Keep this launcher alive in the exec session. Detached + unref is not enough
  // when the execution host places children in a job that ends with the command.
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const launch = { at: new Date().toISOString(), executable: session.executable, pid: child.pid,
    generation: (previous?.generation ?? 0) + 1, previousPid: previous?.pid ?? null, cdpUrl: `http://127.0.0.1:${port}` };
  await json(path.join(session.directory, 'launch.json'), launch);
  await json(path.join(session.directory, `launch-${launch.generation}.json`), launch);
  console.log(JSON.stringify(launch, null, 2));
  console.log('Launcher is waiting for the isolated window to close normally. Retain this exec session.');
  const heartbeat = setInterval(() => {
    json(path.join(session.directory, 'launcher-status.json'), {
      at: new Date().toISOString(), launcherPid: process.pid, childPid: child.pid,
      generation: launch.generation, status: 'waiting_for_normal_ui_close',
    }).catch(error => console.error(String(error)));
  }, 10000);
  try {
    const exit = await exited;
    const result = { at: new Date().toISOString(), ...launch, launcherPid: process.pid, ...exit,
      normalExit: exit.code === 0 && exit.signal === null };
    await json(path.join(session.directory, `exit-${launch.generation}.json`), result);
    await json(path.join(session.directory, 'launcher-status.json'), { ...result, status: 'exited' });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = exit.code ?? 1;
  } finally { clearInterval(heartbeat); }
} else if (mode === 'seed') {
  const session = await loadSession();
  const { browser, page } = await connect(session);
  try {
    const snapshot = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('checklist_load'));
    assert.ok(snapshot.instances.every(item => item.id === 'demo-patch-template' && item.status === 'draft' && item.entries.length === 0),
      'Fixture setup only in a new isolated database containing at most the built-in untouched demo');
    const document = {
      groups: [{ id: 'native-group-a', name: '验收 A' }, { id: 'native-group-b', name: '验收 B' }],
      parameters: [
        { id: 'native-env', name: '环境', description: '全局变量', defaultValue: 'NATIVE-APPLIED' },
        { id: 'native-a', ownerId: 'native-group-a', name: '同名值', description: '仅 A 组', defaultValue: 'A-ONLY' },
        { id: 'native-b', ownerId: 'native-group-b', name: '同名值', description: '仅 B 组', defaultValue: 'B-ONLY' },
      ],
      steps: [
        { id: 'native-first', groupId: 'native-group-a', title: ['原生验收第一步'],
          description: ['用于真实复制粘贴和输入法验收。'],
          commands: [{ id: 'native-command', text: ['原生复制核对｜中文 & <tag> "引号"\n环境=', { parameterId: 'native-env' }, '｜组=', { parameterId: 'native-a' }, '\n尾行  空格'] }] },
        { id: 'native-next', groupId: 'native-group-a', title: ['引用粘贴目标'], description: ['前缀 SLOT 后缀'], commands: [] },
        { id: 'native-other', groupId: 'native-group-b', title: ['跨组身份核对'], description: ['跨组 SLOT 后缀'], commands: [] },
      ],
    };
    await page.evaluate(document => window.__TAURI_INTERNALS__.invoke('checklist_apply', { action: {
      type: 'create_work', id: 'native-acceptance-work', name: 'Windows 原生验收隔离工作', document,
    } }), document);
    await json(path.join(session.directory, 'seed.json'), { setupOnly: true, nativeUiEvidence: false, document });
    console.log('Fixture seeded through real business API. Refresh/open via Sky; this setup is not a UI pass.');
  } finally { await browser.close(); }
} else if (mode === 'probe') {
  const session = await loadSession(); const { browser, page } = await connect(session);
  try {
    await page.evaluate(() => {
      if (window.__nativeAcceptanceEvents) return;
      window.__nativeAcceptanceEvents = [];
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown', 'paste']) {
        document.addEventListener(type, event => {
          window.__nativeAcceptanceEvents.push({ at: Date.now(), type, trusted: event.isTrusted,
            key: event.key, code: event.code, isComposing: event.isComposing, inputType: event.inputType, data: event.data,
            target: event.target?.getAttribute?.('aria-label'), text: event.target?.textContent,
            clipboardTypes: event.clipboardData ? [...event.clipboardData.types] : undefined });
        }, true);
      }
    });
    console.log('Read-only event observer installed. No event dispatch or input interception.');
  } finally { await browser.close(); }
} else if (mode === 'snapshot') {
  const session = await loadSession(); const { browser, page, launch } = await connect(session);
  try {
    const label = args['--label'] ?? 'state'; assert.match(label, /^[a-zA-Z0-9_-]+$/);
    const state = await page.evaluate(async () => ({
      at: new Date().toISOString(), workspace: await window.__TAURI_INTERNALS__.invoke('checklist_load'),
      events: window.__nativeAcceptanceEvents ?? [],
      focused: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'),
        text: document.activeElement?.textContent, value: document.activeElement?.value },
      scripts: [...document.scripts].map(script => script.src).filter(Boolean),
      saveStatus: document.querySelector('.save-state')?.textContent,
    }));
    await json(path.join(session.directory, 'evidence', `${label}.json`), { ...state, launch });
    console.log(JSON.stringify({ label, instances: state.workspace.instances.length, events: state.events.length, saveStatus: state.saveStatus }));
  } finally { await browser.close(); }
} else {
  console.log('prepare --candidate=<target/debug/candidate.exe> | launch --session=<dir> --candidate-ready=yes | seed/probe/snapshot --session=<dir> [--label=id]');
  console.log('All GUI input must use the companion Sky module in node_repl. Default/help never launches any GUI.');
}
