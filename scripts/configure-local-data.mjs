// Explicit opt-in for this development checkout; never changes system permissions.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './environment.mjs';
const executableDirectory = path.join(root, 'target', 'debug');
const configPath = path.join(executableDirectory, 'runbook.local.json');
const dataDirectory = path.join(root, '.local-data');
await mkdir(executableDirectory, { recursive: true });
try {
  await writeFile(configPath, `${JSON.stringify({ dataDirectory }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`Runbook data directory configured: ${dataDirectory}`);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const current = JSON.parse(await readFile(configPath, 'utf8'));
  if (current.dataDirectory !== dataDirectory) throw new Error(`已有数据目录配置，未覆盖：${configPath}`);
  console.log(`Runbook data directory already configured: ${dataDirectory}`);
}
