import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, rustEnvironment } from './environment.mjs';
const desktop = path.join(root, 'apps', 'desktop');
const result = spawnSync(process.execPath, [path.join(desktop, 'node_modules', 'vite', 'bin', 'vite.js'), ...process.argv.slice(2)], {
  cwd: desktop, env: rustEnvironment(), stdio: 'inherit', windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
