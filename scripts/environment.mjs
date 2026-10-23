import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function rustEnvironment() {
  const env = { ...process.env };
  // Windows treats Path/PATH as one key; node's spawn chooses only one spelling.
  const searchPath = process.env.PATH ?? process.env.Path ?? '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = searchPath;
  const temp = path.join(root, 'target', 'tmp');
  mkdirSync(temp, { recursive: true });
  env.TEMP = temp;
  env.TMP = temp;
  const local = path.join(root, '.toolchain');
  if (existsSync(path.join(local, 'cargo', 'bin', 'cargo.exe'))) {
    env.CARGO_HOME = path.join(local, 'cargo');
    env.RUSTUP_HOME = path.join(local, 'rustup');
    env.PATH = `${path.join(local, 'cargo', 'bin')}${path.delimiter}${env.PATH}`;
  }
  return env;
}
