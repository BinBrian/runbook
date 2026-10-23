// Run current desktop suites sequentially and preserve each fresh evidence set.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const systemClipboard = args.includes('--system-clipboard');
const scripts = args.filter(value => !value.startsWith('--'));
assert.ok(scripts.length, 'Pass desktop smoke/check filenames');
for (const name of scripts) assert.match(name, /^(smoke|check)-[a-z-]+\.mjs$/);
const directory = path.resolve('.artifacts/interaction-audit');
await mkdir(directory, { recursive: true });
const resultFile = path.join(directory, 'suite-runs.json');
let previous;
try { previous = JSON.parse(await readFile(resultFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const executable = path.resolve('target/debug/runbook-desktop.exe');
const hash = createHash('sha256').update(await readFile(executable)).digest('hex');
const report = previous ?? { date: '2026-10-21', executable, executableSha256: hash, runs: [] };
assert.equal(report.executableSha256, hash, 'Do not mix builds in one audit');
let failed = false;
for (const name of scripts) {
  const started = new Date(), startMs = started.getTime();
  const id = `${name.replace('.mjs', '')}-${started.toISOString().replace(/[:.]/g, '-')}`;
  const output = path.join(directory, id);
  await mkdir(output, { recursive: true });
  const env = { ...process.env };
  if (systemClipboard) delete env.RUNBOOK_CLIPBOARD_TEST_MODE;
  else env.RUNBOOK_CLIPBOARD_TEST_MODE = 'transport';
  const command = name.startsWith('check-') ? [`scripts/${name}`] : ['scripts/check-desktop.mjs', `scripts/${name}`];
  console.log(`START ${name} (${systemClipboard ? 'system clipboard' : 'transport'})`);
  const child = spawn(process.execPath, command, { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await writeFile(path.join(output, 'run.log'), `${stdout}\n${stderr}`, 'utf8');
  const evidence = [];
  for (const entry of await readdir('.artifacts', { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(png|json)$/.test(entry.name)) continue;
    const source = path.resolve('.artifacts', entry.name);
    if ((await stat(source)).mtimeMs < startMs - 100) continue;
    const destination = path.join(output, entry.name);
    await copyFile(source, destination); evidence.push(destination);
  }
  const run = { id, script: name, startedAt: started.toISOString(), finishedAt: new Date().toISOString(), exitCode,
    clipboardMode: systemClipboard ? 'system' : 'transport', log: path.join(output, 'run.log'),
    isolatedDataDirectory: stdout.match(/Isolated test data:\s*([^\r\n]+)/)?.[1] ?? null, evidence };
  report.runs.push(run);
  await writeFile(resultFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ script: name, exitCode, evidenceCount: evidence.length, isolatedDataDirectory: run.isolatedDataDirectory, id }));
  if (exitCode !== 0) { failed = true; console.log((stdout + stderr).split(/\r?\n/).slice(-25).join('\n')); }
}
process.exitCode = failed ? 1 : 0;
