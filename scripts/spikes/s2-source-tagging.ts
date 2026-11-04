#!/usr/bin/env bun
// Spike S2: copy each fixture, inject tagging, run `next dev`, and measure source-tag coverage and hot reload.
// Usage: bun scripts/spikes/s2-source-tagging.ts [--bundler turbopack|webpack] [--no-tagging] [fixture...]
// --no-tagging runs the same startup without the loader, to measure its overhead.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTaggingBundle } from '../../src/tagging/bundle';
import { injectTagging } from '../../src/tagging/inject';
import { checkTags, findTagForText, listStaticRoutes, parseTagLocation, type CoverageReport } from '../../src/tagging/coverage';

type Bundler = 'turbopack' | 'webpack';
interface Probe { file: string; find: string; replace: string }
interface FixtureSpec { name: string; extraRoutes: string[]; probe: Probe }
interface HmrResult { ok: boolean; ms: number; detail: string }
interface FixtureResult { fixture: string; bundler: Bundler; tagging: boolean; configFile: string; readyMs: number; routes: Record<string, CoverageReport>; hmr: HmrResult; error?: string }

const FIXTURES: FixtureSpec[] = [
  { name: 'acme-analytics', extraRoutes: [], probe: { file: 'app/page.tsx', find: 'Know why your numbers moved', replace: 'Know why your numbers changed' } },
  { name: 'orbit-studio', extraRoutes: ['/work/harbor-coffee'], probe: { file: 'app/page.tsx', find: 'We design brands that people remember', replace: 'We design brands people remember' } },
  { name: 'messy-market', extraRoutes: [], probe: { file: 'app/page.tsx', find: 'Shop everything', replace: 'Shop all goods' } },
];

const repoRoot = join(import.meta.dir, '..', '..');

async function waitForServer(url: string, timeoutMs: number, server: { exitCode: number | null }): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`next dev exited with code ${server.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(1000);
  }
  throw new Error(`${url} did not respond within ${timeoutMs / 1000}s`);
}

async function probeHmr(work: string, base: string, probe: Probe): Promise<HmrResult> {
  const path = join(work, probe.file);
  const original = await readFile(path, 'utf8');
  const at = original.indexOf(probe.find);
  if (at === -1) return { ok: false, ms: 0, detail: `probe text not found in ${probe.file}` };
  const expectedLine = original.slice(0, at).split('\n').length;
  const started = Date.now();
  await writeFile(path, original.replace(probe.find, probe.replace));
  while (Date.now() - started < 30_000) {
    const html = await (await fetch(`${base}/`)).text();
    if (html.includes(probe.replace)) {
      const src = findTagForText(html, probe.replace);
      const loc = src ? parseTagLocation(src) : null;
      const ok = loc?.file === probe.file && loc.line === expectedLine;
      return { ok, ms: Date.now() - started, detail: `edited text tagged ${src ?? 'nothing'}; expected ${probe.file}:${expectedLine}` };
    }
    await Bun.sleep(50);
  }
  return { ok: false, ms: 30_000, detail: 'edit did not appear within 30s' };
}

async function runFixture(spec: FixtureSpec, bundler: Bundler, tagging: boolean, port: number): Promise<FixtureResult> {
  const work = await mkdtemp(join(tmpdir(), `neat-s2-${spec.name}-`));
  const result: FixtureResult = { fixture: spec.name, bundler, tagging, configFile: '', readyMs: 0, routes: {}, hmr: { ok: false, ms: 0, detail: 'not run' } };
  let server: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await cp(join(repoRoot, 'fixtures', spec.name), work, { recursive: true, filter: (src) => !/[\\/](node_modules|\.next)([\\/]|$)/.test(src) });
    const install = Bun.spawnSync(['bun', 'install', '--frozen-lockfile'], { cwd: work, stdout: 'ignore', stderr: 'inherit' });
    if (install.exitCode !== 0) throw new Error('bun install failed');
    result.configFile = tagging ? await injectTagging(work, await buildTaggingBundle(join(work, '.neat'))) : '(unchanged)';

    const started = Date.now();
    server = Bun.spawn(['node_modules/.bin/next', 'dev', '--port', String(port), ...(bundler === 'webpack' ? ['--webpack'] : [])], {
      cwd: work,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      stdout: 'ignore',
      stderr: 'inherit',
    });
    const base = `http://localhost:${port}`;
    await waitForServer(`${base}/`, 180_000, server);
    result.readyMs = Date.now() - started;
    if (!tagging) {
      result.hmr = { ok: true, ms: 0, detail: 'baseline run, not measured' };
      return result;
    }

    const read = (file: string, line: number) => {
      try {
        return readFileSync(join(work, file), 'utf8').split('\n')[line - 1];
      } catch {
        return undefined;
      }
    };
    for (const route of [...(await listStaticRoutes(join(work, 'app'))), ...spec.extraRoutes]) {
      result.routes[route] = checkTags(await (await fetch(base + route)).text(), read);
    }
    result.hmr = await probeHmr(work, base, spec.probe);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    server?.kill();
    await server?.exited;
    await rm(work, { recursive: true, force: true });
  }
  return result;
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : 'n/a';
}

const args = process.argv.slice(2);
const bundlerIndex = args.indexOf('--bundler');
const bundler: Bundler = bundlerIndex !== -1 && args[bundlerIndex + 1] === 'webpack' ? 'webpack' : 'turbopack';
const tagging = !args.includes('--no-tagging');
const names = args.filter((a, i) => !a.startsWith('--') && (bundlerIndex === -1 || i !== bundlerIndex + 1));
const specs = FIXTURES.filter((f) => names.length === 0 || names.includes(f.name));

const results: FixtureResult[] = [];
for (const [i, spec] of specs.entries()) {
  console.log(`\n== ${spec.name} (${bundler}${tagging ? '' : ', no tagging'}) ==`);
  const r = await runFixture(spec, bundler, tagging, 4100 + i);
  results.push(r);
  if (r.error) {
    console.log(`ERROR: ${r.error}`);
    continue;
  }
  console.log(`config: ${r.configFile}, ready in ${(r.readyMs / 1000).toFixed(1)}s`);
  for (const [route, c] of Object.entries(r.routes)) {
    console.log(`${route}: ${c.elements} elements, direct ${pct(c.direct, c.elements)}, inherited ${c.inherited} ${JSON.stringify(c.inheritedByTag)}, untagged ${c.untagged}, invalid src ${c.invalidSrc.length}, instances ${c.instances}, invalid inst ${c.invalidInst.length}`);
    for (const bad of [...c.invalidSrc, ...c.invalidInst].slice(0, 5)) console.log(`  invalid: ${bad}`);
  }
  console.log(`hot reload: ${r.hmr.ok ? 'ok' : 'FAILED'} in ${r.hmr.ms}ms (${r.hmr.detail})`);
}

const outPath = join(repoRoot, 'docs', 'spikes', 's2-results.json');
let previous: FixtureResult[] = [];
try {
  previous = JSON.parse(await readFile(outPath, 'utf8')) as FixtureResult[];
} catch {
  // First run.
}
const merged = [...previous.filter((p) => !results.some((r) => r.fixture === p.fixture && r.bundler === p.bundler && r.tagging === (p.tagging ?? true))), ...results];
await writeFile(outPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`\nWrote ${outPath}`);
process.exit(results.every((r) => !r.error && r.hmr.ok && Object.values(r.routes).every((c) => c.invalidSrc.length === 0 && c.untagged === 0)) ? 0 : 1);
