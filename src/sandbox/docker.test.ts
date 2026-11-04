import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('failed Docker preparation removes its copy and attempts container cleanup without a daemon', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neat-docker-cleanup-'));
  try {
    const repo = join(temp, 'repo'), home = join(temp, 'home'), bin = join(temp, 'bin');
    await mkdir(repo); await mkdir(home); await mkdir(bin);
    await writeFile(join(repo, 'package.json'), '{"dependencies":{"next":"^16.3.5"}}');
    await mkdir(join(repo, 'readonly'));
    await writeFile(join(repo, 'readonly/keep'), 'copied');
    await chmod(join(repo, 'readonly'), 0o555);
    await writeFile(join(repo, 'next.config.mjs'), 'const noExport = {};');
    const log = join(temp, 'docker.log');
    await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_TEST_LOG"\nexit 1\n');
    await chmod(join(bin, 'docker'), 0o700);
    const script = `import { dockerProvider } from ${JSON.stringify(join(import.meta.dir, 'docker.ts'))}; try { await dockerProvider.start('cleanup-test', ${JSON.stringify(repo)}, { editorOrigin: 'http://localhost:4317' }); process.exit(2); } catch (error) { if (!(error instanceof Error) || !error.message.includes('no default export')) throw error; }`;
    const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, DOCKER_TEST_LOG: log }, stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(proc.stderr).text();
    expect({ exit: await proc.exited, stderr }).toEqual({ exit: 0, stderr: '' });
    expect(await Bun.file(join(home, '.neat/sandboxes/cleanup-test/package.json')).exists()).toBe(false);
    expect(await readFile(log, 'utf8')).toBe('rm -f neat-sb-cleanup-test\n');
  } finally {
    for (const path of [join(temp, 'repo/readonly'), join(temp, 'home/.neat/sandboxes/cleanup-test/readonly')]) await chmod(path, 0o700).catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);
