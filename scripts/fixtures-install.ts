#!/usr/bin/env bun
// Installs dependencies for every fixture app. Extraction tests need their node_modules for prop types.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'fixtures');
for (const name of readdirSync(root)) {
  const dir = join(root, name);
  if (!statSync(dir).isDirectory()) continue;
  const args = ['bun', 'install', ...(process.argv.includes('--update') ? [] : ['--frozen-lockfile'])];
  console.log(`$ ${args.join(' ')}  (fixtures/${name})`);
  const proc = Bun.spawnSync(args, { cwd: dir, stdout: 'inherit', stderr: 'inherit' });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}
