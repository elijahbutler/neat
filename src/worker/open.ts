import { realpath, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { resolveNextVersion } from '../tagging/inject';

export function parseOpenArgs(args: string[]) {
  const repo = args[0];
  if (!repo || repo.startsWith('-')) throw new Error('Usage: neat open <dir> [--app <subdir>] [--port <port>] [--docker]');
  let app = '.', port = 4317, docker = false;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--docker') { docker = true; continue; }
    if (flag !== '--app' && flag !== '--port') throw new Error(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    if (flag === '--app') app = value;
    else { port = Number(value); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an integer between 1024 and 65535.'); }
  }
  if (isAbsolute(app) || relative(resolve(repo), resolve(repo, app)).startsWith('..')) throw new Error('--app must be a subdirectory of the repo.');
  if (docker && app !== '.') throw new Error('--docker with --app is not supported yet. Use the default worktree provider.');
  return { repo: resolve(repo), app, port, docker };
}
const packageSchema = z.object({ dependencies: z.record(z.string(), z.string()).optional(), devDependencies: z.record(z.string(), z.string()).optional() });
export async function validateNextApp(repo: string, app = '.') {
  const root = await realpath(repo);
  const target = await realpath(resolve(root, app));
  if (relative(root, target).startsWith('..')) throw new Error('--app resolves outside the repository.');
  const pkg = packageSchema.parse(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')));
  const next = pkg.dependencies?.next ?? pkg.devDependencies?.next;
  if (!next || !['app', 'src/app'].some(dir => existsSync(join(target, dir)))) throw new Error('Neat requires a Next.js 14, 15, or 16 App Router app with app/ or src/app/.');
  const installed = await resolveNextVersion(target);
  if (!/^(14|15|16)\./.test(installed)) throw new Error('Neat supports installed Next.js versions 14 to 16 App Router.');
  return root;
}
