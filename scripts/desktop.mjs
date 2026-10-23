import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { root, rustEnvironment } from './environment.mjs';
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { cwd: path.join(root, 'apps/desktop'), env: rustEnvironment(), stdio: 'inherit', windowsHide: true });
child.on('exit', code => process.exit(code ?? 1));
