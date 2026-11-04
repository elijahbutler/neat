import { describe, expect, test } from 'bun:test';
import neatTagLoader, { toProjectPath } from './loader';

function run(resourcePath: string, source: string, root = '/repo') {
  let result: { error: Error | null; code?: string; map?: unknown } | undefined;
  neatTagLoader.call(
    { resourcePath, getOptions: () => ({ root }), callback: (error, code, map) => { result = { error, code, map }; } },
    source,
  );
  return result!;
}

describe('toProjectPath', () => {
  test('returns a forward-slash path inside the root', () => {
    expect(toProjectPath('/repo', '/repo/app/page.tsx')).toBe('app/page.tsx');
  });

  // Review focus 2: hoisted packages and files outside the app stay untouched.
  test('rejects files outside the root or in node_modules', () => {
    expect(toProjectPath('/repo', '/other/page.tsx')).toBeNull();
    expect(toProjectPath('/repo', '/repo/node_modules/ui/button.tsx')).toBeNull();
    expect(toProjectPath('/repo/apps/web', '/repo/packages/ui/button.tsx')).toBeNull();
  });
});

describe('neatTagLoader', () => {
  test('tags project files', () => {
    const out = run('/repo/app/page.tsx', 'const a = <div />;');
    expect(out.error).toBeNull();
    expect(out.code).toContain('data-nl-src={"app/page.tsx:1:11"}');
  });

  test('resolves a symlinked root to its real path', async () => {
    const { mkdtemp, mkdir, realpath, symlink, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const real = await realpath(await mkdtemp(join(tmpdir(), 'neat-real-')));
    await mkdir(join(real, 'app'));
    const link = `${real}-link`;
    await symlink(real, link);
    const out = run(join(real, 'app', 'page.tsx'), 'const a = <div />;', link);
    expect(out.code).toContain('data-nl-src={"app/page.tsx:1:11"}');
    await rm(link);
    await rm(real, { recursive: true });
  });

  test('passes node_modules through unchanged', () => {
    const out = run('/repo/node_modules/x/index.jsx', 'const a = <div />;');
    expect(out.code).toBe('const a = <div />;');
  });

  test('passes syntax errors through unchanged', () => {
    const out = run('/repo/app/page.tsx', 'const a = <div>;');
    expect(out.error).toBeNull();
    expect(out.code).toBe('const a = <div>;');
  });
});

test('tags JSX in ESM and CommonJS JavaScript without interpreting TypeScript', () => {
  for (const [file, source] of [['view.mjs', 'export const view = <h1>Hello</h1>;'], ['view.cjs', 'module.exports = <h1>Hello</h1>;']]) {
    let result = '';
    neatTagLoader.call({ resourcePath: `/repo/${file}`, getOptions: () => ({ root: '/repo' }), callback: (error, code) => {
      if (error) throw error;
      result = code ?? '';
    } }, source!);
    expect(result).toContain(`data-nl-src={"${file}:1:`);
  }
});
