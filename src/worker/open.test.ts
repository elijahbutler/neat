import { expect, test } from 'bun:test';
import { parseOpenArgs, validateNextApp } from './open';
import { resolve } from 'node:path';
test('open defaults and explicit options', () => {
  expect(parseOpenArgs(['.'])).toEqual({ repo: resolve('.'), app: '.', port: 4317, docker: false });
  expect(parseOpenArgs(['.', '--app', 'apps/web', '--port', '4400'])).toEqual({ repo: resolve('.'), app: 'apps/web', port: 4400, docker: false });
  expect(parseOpenArgs(['.', '--docker']).docker).toBe(true);
});
test('invalid and missing arguments fail clearly', () => {
  for (const args of [[], ['.', '--unknown'], ['.', '--port'], ['.', '--port', 'no'], ['.', '--port', '3000.5'], ['.', '--app', '../outside'], ['.', '--app', '/tmp']]) expect(() => parseOpenArgs(args)).toThrow();
});
test('validates an actual App Router fixture', async () => {
  expect(await validateNextApp(resolve('fixtures/orbit-studio'))).toBe(resolve('fixtures/orbit-studio'));
});

test('validates the installed Next version for a latest range and a hoisted dependency', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'neat-next-version-'));
  try {
    await mkdir(join(root, 'apps/web/app'), { recursive: true });
    await mkdir(join(root, 'node_modules/next'), { recursive: true });
    await writeFile(join(root, 'apps/web/package.json'), '{"dependencies":{"next":"latest"}}');
    await writeFile(join(root, 'node_modules/next/package.json'), '{"version":"16.4.5"}');
    expect(await validateNextApp(root, 'apps/web')).toBe(root);
    await writeFile(join(root, 'node_modules/next/package.json'), '{"version":"17.0.0"}');
    await expect(validateNextApp(root, 'apps/web')).rejects.toThrow('14 to 16');
  } finally { await rm(root, { recursive: true, force: true }); }
});
