import { spawnSync } from 'node:child_process';
import { root, rustEnvironment } from './environment.mjs';
const result = spawnSync('cargo', process.argv.slice(2), { cwd: root, env: rustEnvironment(), stdio: 'inherit', windowsHide: true });
if (result.error) console.error('无法启动 cargo。请安装 Rust MSVC 工具链，或配置项目内 .toolchain。', result.error.message);
process.exit(result.status ?? 1);
