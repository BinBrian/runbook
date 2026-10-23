// Inspect the candidate file set without staging files, reading local data, or contacting a remote.
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
const actualRoot = path.resolve(git(['rev-parse', '--show-toplevel']).trim());
if (actualRoot.toLowerCase() !== root.toLowerCase()) throw new Error('Run from the independent Runbook repository.');
const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
const problems = [], notes = [], groups = {};
let totalBytes = 0;
const excluded = /(^|\/)(node_modules|target|dist|\.toolchain|\.pnpm-store|\.local-data|\.test-data|\.artifacts|reports|test-results|playwright-report|__pycache__|\.venv)(\/|$)|(^|\/)\.env(?:$|\.(?!example$))|\.(?:db|sqlite3?)(?:-(?:wal|shm))?$|\.local\.json$|\.log$|^(?:AGENTS\.md|docs\/verification\.md)$/i;
const textFile = /\.(?:md|txt|json|[cm]?js|tsx?|css|html|rs|toml|yaml|yml|lock|py|sql)$/i;
// Report only file names and categories, never matched credential values.
const credentialPatterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['embedded-url-credentials', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
];
for (const file of files) {
  if (excluded.test(file)) { problems.push({ file, reason: 'local or generated file is a candidate' }); continue; }
  const absolute = path.resolve(root, file);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) { problems.push({ file, reason: 'review non-regular file separately' }); continue; }
  totalBytes += stat.size;
  const group = groups[file.includes('/') ? file.split('/')[0] : '(root)'] ??= { files: 0, bytes: 0 };
  group.files++; group.bytes += stat.size;
  if (stat.size > 10 * 1024 * 1024) { problems.push({ file, reason: 'larger than the 10 MiB source-review threshold' }); continue; }
  if (!textFile.test(file)) continue;
  const content = await readFile(absolute, 'utf8');
  for (const [reason, pattern] of credentialPatterns) if (pattern.test(content)) problems.push({ file, reason });
  if (file.endsWith('.json')) {
    try { JSON.parse(content); } catch { problems.push({ file, reason: 'invalid JSON' }); }
  }
}
for (const required of ['README.md', 'CONTRIBUTING.md', '.gitignore', '.gitattributes', 'pnpm-lock.yaml', 'Cargo.lock']) {
  if (!files.includes(required)) problems.push({ file: required, reason: 'missing from candidate set' });
}
if (!files.some(file => /^LICENSE(?:\.|$)/.test(file))) notes.push('License is not selected; decide before making the repository public.');
const ignoredSamples = [
  '.local-data/checklist.sqlite3', 'target/debug/runbook-desktop.exe', 'node_modules/example/index.js',
  '.toolchain/cargo/bin/cargo.exe', '.artifacts/github-prep/originals/source.txt', 'reports/audit/output.pptx',
  'runbook.local.json', '.env', '.env.production', 'checklist.sqlite3-wal', 'AGENTS.md', 'docs/verification.md',
];
const ignored = git(['check-ignore', '--no-index', ...ignoredSamples]).trim().split(/\r?\n/);
for (const sample of ignoredSamples) if (!ignored.includes(sample)) problems.push({ file: sample, reason: 'ignore rule missing' });
console.log(JSON.stringify({ ok: problems.length === 0, files: files.length, bytes: totalBytes, groups, problems, notes }, null, 2));
if (problems.length) process.exitCode = 1;
