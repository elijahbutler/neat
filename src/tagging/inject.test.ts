import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildTaggingBundle } from './bundle';
import { injectTagging, resolveNextVersion, rewriteNextConfig } from './inject';

let dir = '';
let stubPath = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'neat-inject-'));
  // A stand-in for the real with-tagging bundle, so rewritten configs can be imported and checked.
  stubPath = join(dir, 'stub-with-tagging.mjs');
  await writeFile(stubPath, 'export function withNeatTagging(c, o) { return async (phase) => ({ original: typeof c === "function" ? await c(phase) : c, opts: o }); }\n');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const opts = () => ({ loaderPath: '/neat/loader.cjs', withTaggingPath: stubPath, root: '/repo' });

async function load(fileName: string, source: string) {
  const path = join(dir, `${crypto.randomUUID()}-${fileName}`);
  await writeFile(path, rewriteNextConfig(source, fileName, opts()));
  const mod = await import(path);
  const exported = mod.default as (phase: string, ctx: object) => Promise<{ original: unknown; opts: unknown }>;
  return exported('phase-development-server', { defaultConfig: {} });
}

describe('rewriteNextConfig', () => {
  test('wraps a TypeScript object export', async () => {
    const out = await load('next.config.ts', "import type { NextConfig } from 'next';\nconst nextConfig: NextConfig = { poweredByHeader: false };\nexport default nextConfig;\n");
    expect(out.original).toEqual({ poweredByHeader: false });
    expect(out.opts).toEqual({ loaderPath: '/neat/loader.cjs', root: '/repo' });
  });

  test('wraps a default-exported function', async () => {
    const out = await load('next.config.ts', 'export default function config(phase: string) { return { env: { P: phase } }; }\n');
    expect(out.original).toEqual({ env: { P: 'phase-development-server' } });
  });

  test('wraps an .mjs config', async () => {
    const out = await load('next.config.mjs', 'const nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n');
    expect(out.original).toEqual({ reactStrictMode: true });
  });

  test('wraps a CommonJS config', () => {
    const code = rewriteNextConfig('module.exports = { reactStrictMode: true };\n', 'next.config.js', opts());
    expect(code).toContain('const __neatOriginalConfig = { reactStrictMode: true };');
    expect(code).toContain('module.exports = async function neatTaggedConfig');
  });

  test('wraps the last module.exports assignment so plugins that re-wrap it survive', () => {
    const code = rewriteNextConfig('module.exports = { a: 1 };\nmodule.exports = withPlugin(module.exports);\n', 'next.config.js', opts());
    expect(code).toContain('module.exports = { a: 1 };\nconst __neatOriginalConfig = withPlugin(module.exports);');
  });

  test('refuses a config without an export', () => {
    expect(() => rewriteNextConfig('const a = 1;\n', 'next.config.mjs', opts())).toThrow('no default export');
  });
});

describe('injectTagging', () => {
  for (const file of ['next.config.js', 'next.config.cjs', 'next.config.ts', 'next.config.mts']) {
    test(`Node loads the real CommonJS tagging bundle through ${file}`, async () => {
      const project = await mkdtemp(join(dir, 'node-config-'));
      await writeFile(join(project, 'package.json'), JSON.stringify({ type: file.endsWith('ts') ? 'module' : 'commonjs' }));
      const bundle = await buildTaggingBundle(join(project, '.neat'));
      await writeFile(join(project, file), file.endsWith('ts')
        ? 'export default async (phase: string) => ({ poweredByHeader: false, env: { CONFIG_PHASE: phase } });'
        : 'module.exports = async phase => ({ poweredByHeader: false, env: { CONFIG_PHASE: phase } });');
      await injectTagging(project, bundle, 'http://127.0.0.1:4460');
      const script = `(async () => {
        const imported = await import(${JSON.stringify(join(project, file))});
        const result = await imported.default('phase-development-server', { defaultConfig: {} });
        process.stdout.write(JSON.stringify({ poweredByHeader: result.poweredByHeader, phase: result.env.CONFIG_PHASE, headers: await result.headers() }));
      })().catch(error => { console.error(error); process.exitCode = 1; });`;
      const child = Bun.spawn(['node', ...(file.endsWith('ts') ? ['--experimental-strip-types'] : []), '--eval', script], { cwd: project, stdout: 'pipe', stderr: 'pipe' });
      const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, errors).toBe(0);
      expect(JSON.parse(out)).toEqual({ poweredByHeader: false, phase: 'phase-development-server', headers: [
        { source: '/:path*', headers: [{ key: 'content-security-policy', value: 'frame-ancestors http://127.0.0.1:4460' }] },
      ] });
    }, 30000);
  }

  test('a compiled TypeScript config loads Neat independently of compiler path aliases', async () => {
    const project = await mkdtemp(join(dir, 'compiler-paths-'));
    await mkdir(join(project, 'node_modules'));
    const localRequire = createRequire(import.meta.url);
    for (const name of ['next', 'typescript']) {
      const packagePath = localRequire.resolve(`${name}/package.json`);
      await symlink(join(packagePath, '..'), join(project, 'node_modules', name));
    }
    const bundle = await buildTaggingBundle(join(project, '.neat'));
    await writeFile(join(project, 'wrong.cjs'), 'throw new Error("Compiler aliases must not replace the injected loader");');
    await writeFile(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { [bundle.withTaggingCjsPath!]: ['./wrong.cjs'] } } }));
    await writeFile(join(project, 'next.config.ts'), 'export default { poweredByHeader: false };');
    await injectTagging(project, bundle);
    // Release the compiler's native bindings when this test ends instead of retaining them through the whole suite.
    const script = `(async () => {
      const { loadBindings } = require('next/dist/build/swc');
      await loadBindings();
      const { transpileConfig } = require('next/dist/build/next-config-ts/transpile-config');
      const config = await transpileConfig({ nextConfigPath: ${JSON.stringify(join(project, 'next.config.ts'))}, dir: ${JSON.stringify(project)} });
      const result = await config.default('phase-development-server', { defaultConfig: {} });
      process.stdout.write(String(result.poweredByHeader));
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const child = Bun.spawn(['node', '--eval', script], { cwd: project, stdout: 'pipe', stderr: 'pipe' });
    const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, errors).toBe(0);
    expect(out).toBe('false');
  }, 120000);

  test('writes next.config.mjs when the project has none', async () => {
    const project = await mkdtemp(join(dir, 'p-'));
    expect(await injectTagging(project, { loaderPath: '/l.cjs', withTaggingPath: stubPath })).toBe('next.config.mjs');
    expect(await readFile(join(project, 'next.config.mjs'), 'utf8')).toContain('const __neatOriginalConfig = {}');
  });

  test('uses the real path of the project as the tag root', async () => {
    const project = await mkdtemp(join(dir, 'p-'));
    await injectTagging(project, { loaderPath: '/l.cjs', withTaggingPath: stubPath });
    const code = await readFile(join(project, 'next.config.mjs'), 'utf8');
    expect(code).toContain(JSON.stringify(await realpath(project)));
  });

  test('rewrites an existing config in place', async () => {
    const project = await mkdtemp(join(dir, 'p-'));
    await writeFile(join(project, 'next.config.ts'), 'export default {};\n');
    expect(await injectTagging(project, { loaderPath: '/l.cjs', withTaggingPath: stubPath })).toBe('next.config.ts');
  });
});

describe('buildTaggingBundle', () => {
  test('builds a loader that runs under CommonJS require', async () => {
    const bundle = await buildTaggingBundle(join(dir, 'bundle'));
    const loader = require(bundle.loaderPath) as { default: (this: unknown, s: string) => void };
    let code = '';
    loader.default.call({ resourcePath: '/repo/a.tsx', getOptions: () => ({ root: '/repo' }), callback: (_e: unknown, c: string) => { code = c; } }, 'const a = <div />;');
    expect(code).toContain('data-nl-src');
    const wrapper = (await import(bundle.withTaggingPath)) as { withNeatTagging: unknown };
    expect(typeof wrapper.withNeatTagging).toBe('function');
  }, 30_000);
});

for (const fixture of ['orbit-studio', 'acme-analytics', 'messy-market']) {
  test(`rewrites ${fixture}'s config without losing its settings`, async () => {
    const fixtureDir = join(import.meta.dir, '../../fixtures', fixture);
    const filename = fixture === 'messy-market' ? 'next.config.mjs' : 'next.config.ts';
    const result = await load(filename, await readFile(join(fixtureDir, filename), 'utf8'));
    expect(result.original).toEqual(fixture === 'orbit-studio' ? { poweredByHeader: false, env: { BUILD_PHASE: 'phase-development-server' } }
      : fixture === 'messy-market' ? { reactStrictMode: true } : {});
  });
}

for (const prefix of ['', 'src/']) for (const ext of ['ts', 'js', 'mjs']) {
  test(`chains ${prefix}instrumentation-client.${ext} before the bridge`, async () => {
    const { mkdir } = await import('node:fs/promises');
    const { prepareTaggedProject } = await import('./inject');
    const project = await mkdtemp(join(dir, 'chain-'));
    await mkdir(join(project, prefix, 'app'), { recursive: true });
    await mkdir(join(project, 'node_modules/next'), { recursive: true });
    await writeFile(join(project, 'node_modules/next/package.json'), JSON.stringify({ version: '16.3.5' }));
    const log = join(project, 'events.txt');
    const file = `${prefix}instrumentation-client.${ext}`;
    await writeFile(join(project, file), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'user\\n');\n`);
    const prepared = await prepareTaggedProject(project, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'bridge\\n');`);
    await import(join(project, file));
    for (let i = 0; i < 100; i++) {
      if ((await readFile(log, 'utf8')).includes('bridge')) break;
      await Bun.sleep(5);
    }
    expect(await readFile(log, 'utf8')).toBe('user\nbridge\n');
    expect(prepared.injectedPaths).toEqual(['.neat/', '.neat/neat-tag-loader.cjs', '.neat/neat-tag-loader.mjs', '.neat/with-tagging.cjs', '.neat/with-tagging.mjs', '.neat/selection-bridge.js', 'next.config.mjs', file, ...(ext === 'mjs' ? [`${prefix}instrumentation-client.js`] : [])]);
  }, 30000);
}

test('emits both module formats and a TypeScript config uses the CJS wrapper', async () => {
  const bundle = await buildTaggingBundle(join(dir, 'dual-bundle'));
  const cjs = require(bundle.withTaggingCjsPath!) as { withNeatTagging: typeof import('./with-tagging').withNeatTagging };
  const config = await cjs.withNeatTagging({ poweredByHeader: false }, { loaderPath: bundle.loaderPath, root: dir })('phase-development-server', { defaultConfig: {} });
  expect(config.poweredByHeader).toBe(false);
  expect(rewriteNextConfig('export default {};', 'next.config.ts', { ...bundle, root: dir })).toContain(JSON.stringify(bundle.withTaggingCjsPath));
  const esmLoader = await import(bundle.loaderEsmPath!);
  let result = '';
  esmLoader.default.call({ resourcePath: '/repo/a.jsx', getOptions: () => ({ root: '/repo' }), callback: (_error: unknown, code: string) => { result = code; } }, 'const x = <div />;');
  expect(result).toContain('data-nl-src={"a.jsx:1:11"}');
}, 30000);

for (const version of ['14.2.35', '15.2.0', '15.3.0', '16.3.5']) {
  test(`selects the Turbopack configuration supported by Next ${version}`, async () => {
    const { mkdir } = await import('node:fs/promises');
    const { addTagging } = await import('./with-tagging');
    const project = await mkdtemp(join(dir, 'version-'));
    await mkdir(join(project, 'node_modules/next'), { recursive: true });
    await writeFile(join(project, 'node_modules/next/package.json'), JSON.stringify({ version }));
    const result = addTagging({}, { loaderPath: '/loader.cjs', root: project });
    const legacy = result.experimental as { turbo?: { rules?: Record<string, unknown> } } | undefined;
    const rules = version === '14.2.35' || version === '15.2.0' ? legacy?.turbo?.rules : result.turbopack?.rules;
    expect(rules?.['*.tsx']).toMatchObject({ loaders: [{ loader: '/loader.cjs', options: { root: project } }] });
    expect(rules?.['*.mjs']).toEqual(rules?.['*.cjs']);
  });
}

test('Next 14 preserves a client root layout and its directive on disk', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { prepareTaggedProject } = await import('./inject');
  const project = await mkdtemp(join(dir, 'legacy-'));
  await mkdir(join(project, 'src/app'), { recursive: true });
  await mkdir(join(project, 'node_modules/next'), { recursive: true });
  await writeFile(join(project, 'node_modules/next/package.json'), JSON.stringify({ version: '14.2.35' }));
  await writeFile(join(project, 'src/app/layout.tsx'), "'use client';\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }");
  await writeFile(join(project, 'src/instrumentation-client.ts'), 'globalThis.userInstrumentation = true;');
  const prepared = await prepareTaggedProject(project, '// bridge');
  expect(await readFile(join(project, 'src/app/neat-client.js'), 'utf8')).toBe("'use client';\nimport \"../instrumentation-client.ts\";\n");
  expect(await readFile(join(project, 'src/app/layout.tsx'), 'utf8')).toStartWith("'use client';\nexport default");
  expect(prepared.injectedPaths).not.toContain('src/app/layout.tsx');
  const { parse } = await import('@babel/parser');
  for (const ext of ['cjs', 'mjs']) {
    const module = await import(join(project, `.neat/neat-tag-loader.${ext}`));
    let compiled = '';
    module.default.call({ resourcePath: join(project, 'src/app/layout.tsx'), getOptions: () => ({ root: project }), callback: (_error: unknown, code: string) => { compiled = code; } }, await readFile(join(project, 'src/app/layout.tsx'), 'utf8'));
    expect(parse(compiled, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program.directives.map(d => d.value.value)).toEqual(['use client']);
    expect(compiled).toContain("import './neat-client.js';");
  }
}, 30000);

test('executes CommonJS and ESM JavaScript configs with the same original settings', async () => {
  expect((await load('next.config.cjs', 'module.exports = { reactStrictMode: true };')).original).toEqual({ reactStrictMode: true });
  expect((await load('next.config.js', 'export default { reactStrictMode: true };')).original).toEqual({ reactStrictMode: true });
});

 test('preparation materializes external config, client, and parent symlinks without changing their sources', async () => {
  const { prepareTaggedProject } = await import('./inject');
  const project = await mkdtemp(join(dir, 'links-'));
  const original = await mkdtemp(join(dir, 'original-'));
  await mkdir(join(original, 'app'));
  const files = { 'next.config.mjs': 'export default {};\n', 'instrumentation-client.js': '// original client\n', 'app/layout.tsx': "'use client';\nexport default function Layout() { return <html />; }" };
  for (const [file, text] of Object.entries(files)) await writeFile(join(original, file), text);
  for (const file of ['next.config.mjs', 'instrumentation-client.js', 'app']) await symlink(join(original, file), join(project, file));
  await mkdir(join(project, 'node_modules/next'), { recursive: true });
  await writeFile(join(project, 'node_modules/next/package.json'), '{"version":"14.2.35"}');
  await prepareTaggedProject(project, '// bridge');
  for (const [file, text] of Object.entries(files)) expect(await readFile(join(original, file), 'utf8')).toBe(text);
 }, 30000);
 test('prepares a Docker copy without node_modules using the declared Next range', async () => {
  const { prepare } = await import('../sandbox/docker');
  const source = await mkdtemp(join(dir, 'docker-source-'));
  const target = join(dir, 'docker-copy');
  await mkdir(join(source, 'app'));
  await writeFile(join(source, 'app/layout.tsx'), 'export default function Layout() { return <html />; }');
  await writeFile(join(source, 'package.json'), '{"dependencies":{"next":"^14.2.35"}}');
  await prepare(source, target, 'http://localhost:4317');
  expect(await readFile(join(target, 'app/neat-client.js'), 'utf8')).toContain("'use client'");
 }, 30000);

test('a destination swapped to a symlink at write time never changes its source', async () => {
  const fs = await import('node:fs/promises');
  const { spyOn } = await import('bun:test');
  const project = await mkdtemp(join(dir, 'race-'));
  const source = join(dir, `${crypto.randomUUID()}.mjs`);
  const config = join(project, 'next.config.mjs');
  const original = 'export default { secret: "untouched" };\n';
  await writeFile(source, original); await writeFile(config, 'export default {};');
  const originalWrite = fs.writeFile;
  const originalRename = fs.rename;
  let swapped = false;
  async function swap() { if (!swapped) { swapped = true; await fs.unlink(config); await fs.symlink(source, config); } }
  const writeSpy = spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === config) await swap();
    return originalWrite(...args);
  });
  const renameSpy = spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith('/next.config.mjs')) await swap();
    return originalRename(...args);
  });
  try {
    await injectTagging(project, { loaderPath: '/l', withTaggingPath: stubPath });
    expect(swapped).toBe(true);
    expect(await readFile(source, 'utf8')).toBe(original);
    expect((await fs.lstat(config)).isSymbolicLink()).toBe(false);
  } finally { writeSpy.mockRestore(); renameSpy.mockRestore(); }
});

for (const external of [false, true]) for (const kind of ['mjs', 'cjs']) {
  test(`symlinked ${kind} config preserves relative imports with external=${external}`, async () => {
    const project = await mkdtemp(join(dir, 'relative-config-'));
    const shared = external ? await mkdtemp(join(dir, 'shared-')) : join(project, 'shared');
    await mkdir(shared, { recursive: true });
    const plugin = kind === 'mjs' ? 'export default { value: 42 };' : 'module.exports = { value: 42 };';
    const source = kind === 'mjs' ? "import x from './plugin.mjs'; export default x;" : "module.exports = require('./plugin.cjs');";
    await writeFile(join(shared, `plugin.${kind}`), plugin);
    const original = join(shared, `config.${kind}`);
    await writeFile(original, source);
    const config = join(project, `next.config.${kind}`);
    await symlink(original, config);
    expect((await import(config)).default).toEqual({ value: 42 });
    await injectTagging(project, { loaderPath: '/l', withTaggingPath: stubPath });
    // A subprocess avoids module-cache reuse masking the broken relative import.
    const proc = Bun.spawn([process.execPath, '-e', `const m = await import(${JSON.stringify(config)}); console.log(JSON.stringify(await m.default('dev', {})));`], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    expect({ exit: await proc.exited, error }).toEqual({ exit: 0, error: '' });
    expect(JSON.parse(output).original).toEqual({ value: 42 });
    expect(await readFile(original, 'utf8')).toBe(source);
  });
}

test('legacy route-group root layouts share one bridge module without tracked edits', async () => {
  const { prepareTaggedProject } = await import('./inject');
  const project = await mkdtemp(join(dir, 'groups-'));
  const layouts = ['app/(one)/layout.tsx', 'app/(two)/layout.tsx'];
  const source = 'export default function Layout({ children }) { return <html><body>{children}</body></html>; }';
  for (const file of [...layouts, 'app/(one)/nested/layout.tsx']) {
    await mkdir(join(project, file, '..'), { recursive: true }); await writeFile(join(project, file), source);
  }
  const prepared = await prepareTaggedProject(project, '// bridge', '14.2.35');
  const loader = await import(join(project, '.neat/neat-tag-loader.mjs'));
  for (const file of [...layouts, 'app/(one)/nested/layout.tsx']) {
    let compiled = '';
    loader.default.call({ resourcePath: join(project, file), getOptions: () => ({ root: project }), callback: (_error: unknown, code: string) => { compiled = code; } }, source);
    expect(compiled.includes("import '../neat-client.js';")).toBe(layouts.includes(file));
    expect(await readFile(join(project, file), 'utf8')).toBe(source);
    expect(prepared.injectedPaths).not.toContain(file);
  }
  expect(await readFile(join(project, 'app/neat-client.js'), 'utf8')).toContain('../instrumentation-client.js');
}, 30000);

test('replacing a parent immediately before rename cannot redirect generated bundle writes', async () => {
  const fs = await import('node:fs/promises');
  const { spyOn } = await import('bun:test');
  const { sandboxWrite } = await import('./inject');
  const project = await mkdtemp(join(dir, 'parent-race-'));
  const source = await mkdtemp(join(dir, 'parent-source-'));
  await mkdir(join(project, '.neat'));
  await writeFile(join(source, 'selection-bridge.js'), 'original');
  const rename = fs.rename;
  let swapped = false;
  const spy = spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith('/selection-bridge.js') && !swapped) {
      swapped = true;
      await rename(join(project, '.neat'), join(project, 'old-neat'));
      await symlink(source, join(project, '.neat'));
    }
    return rename(...args);
  });
  try {
    // Linux pins the directory; other platforms fail closed on the changed parent.
    await sandboxWrite(project, join(project, '.neat/selection-bridge.js'), 'generated').catch(() => {});
    expect(swapped).toBe(true);
    expect(await readFile(join(source, 'selection-bridge.js'), 'utf8')).toBe('original');
    expect(await fs.readdir(source)).toEqual(['selection-bridge.js']);
  } finally { spy.mockRestore(); }
});

describe('resolveNextVersion', () => {
  test('finds Next hoisted to the workspace root when the app has its own node_modules without it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neat-hoist-'));
    try {
      const app = join(root, 'apps/web');
      await mkdir(join(root, 'node_modules/next'), { recursive: true });
      await writeFile(join(root, 'node_modules/next/package.json'), JSON.stringify({ name: 'next', version: '16.3.5' }));
      await mkdir(join(app, 'node_modules/left-pad'), { recursive: true });
      await writeFile(join(app, 'package.json'), JSON.stringify({ dependencies: { next: '^16.0.0' } }));
      expect(await resolveNextVersion(app)).toBe('16.3.5');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
