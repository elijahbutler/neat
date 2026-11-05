import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseOptions, repository } from './verification/options.mjs';
import { git, gitEnvironment, snapshot } from './verification/fixture.mjs';
import { cliArguments, cliEnvironment, requireIsolatedBun, runtimeMetadata, removeOwnedRoot, stopOwnedWorker } from './verification/process.mjs';
import { poll } from './verification/browser.mjs';

const driver = join(tmpdir(), 'browser-driver', 'index.mjs');

test('acceptance polling propagates cancellation even when a read throws', async () => {
  const abort = new AbortController();
  const observations: string[] = [];
  const result = poll('cancelled preparation', async () => {
    observations.push('preparing');
    abort.abort(new Error('Acceptance interrupted'));
    throw new Error('Transient read failure');
  }, () => false, 500, abort.signal);
  await expect(result).rejects.toThrow('Acceptance interrupted');
  expect(observations).toEqual(['preparing']);
  expect(await poll('ready preparation', async () => 'ready', value => value === 'ready', 1000)).toBe('ready');
});

describe('browser acceptance command', () => {
  test('parses a dedicated run without inheriting model or port environment settings', () => {
    const options = parseOptions([
      '--port', '4470', '--provider-port', '4472', '--timeout', '60000',
      '--evidence', join(tmpdir(), 'acceptance-evidence'), '--headed',
      '--browser-executable', join(tmpdir(), 'browser', 'chrome'),
    ], { NEAT_BROWSER_DRIVER: driver, OPENAI_API_KEY: 'must-not-be-returned', PORT: '4400' });
    expect(options).toEqual({
      port: 4470, providerPort: 4472, timeout: 60000, headed: true,
      evidence: join(tmpdir(), 'acceptance-evidence'), executable: join(tmpdir(), 'browser', 'chrome'), driver,
    });
  });

  test('rejects protected or colliding ports while accepting a dedicated pair', () => {
    for (const port of ['3000', '4100', '4317', '4400', '4459', '65536', '4460garbage']) {
      expect(() => parseOptions(['--port', port], { NEAT_BROWSER_DRIVER: driver })).toThrow();
    }
    expect(() => parseOptions(['--provider-port', '4460'], { NEAT_BROWSER_DRIVER: driver })).toThrow('must differ');
    expect(parseOptions(['--port', '4480', '--provider-port', '4482'], { NEAT_BROWSER_DRIVER: driver }).port).toBe(4480);
  });

  test('requires the browser installation and evidence to stay outside the checkout', () => {
    expect(() => parseOptions([], {})).toThrow('absolute path');
    expect(() => parseOptions([], { NEAT_BROWSER_DRIVER: 'relative-driver.mjs' })).toThrow('absolute path');
    expect(() => parseOptions([], { NEAT_BROWSER_DRIVER: join(repository, 'node_modules/driver.mjs') })).toThrow('outside this checkout');
    expect(() => parseOptions(['--evidence', join(repository, 'evidence')], { NEAT_BROWSER_DRIVER: driver })).toThrow('outside this checkout');
    expect(parseOptions([], { NEAT_BROWSER_DRIVER: driver }).driver).toBe(driver);
  });

  test('rejects removed allocator overrides and missing option values', () => {
    expect(() => parseOptions(['--preview-port', '4471'], { NEAT_BROWSER_DRIVER: driver })).toThrow('Unknown option');
    expect(() => parseOptions(['--evidence'], { NEAT_BROWSER_DRIVER: driver })).toThrow('needs a value');
    expect(() => parseOptions(['--timeout', '0'], { NEAT_BROWSER_DRIVER: driver })).toThrow('between 1000 and 600000');
    expect(parseOptions(['--timeout', '30000'], { NEAT_BROWSER_DRIVER: driver }).timeout).toBe(30000);
  });
});

describe('browser acceptance isolation', () => {
  test('refuses runtimes that cannot guarantee dotenv isolation before launching a worker', () => {
    for (const version of ['1.2.14', '1.3.12', '0.9.0', '1.4.0-canary', 'invalid', '']) {
      expect(() => requireIsolatedBun(version)).toThrow('requires stable Bun 1.3.13 or newer');
    }
    for (const version of ['1.3.13', '1.4.4', '2.0.0']) expect(() => requireIsolatedBun(version)).not.toThrow();
  });

  test('runtime metadata probes the PATH-selected Node with the sanitized CLI environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neat-runtime-test-'));
    const node = join(root, 'node'), marker = join(root, 'preload-ran'), observed = join(root, 'environment.json');
    const preload = join(root, 'preload.mjs');
    const inherited = {
      PATH: root, NODE_OPTIONS: `--require=${preload}`, NODE_PRELOAD: preload, BUN_OPTIONS: `--preload=${preload}`,
      LLM_API_KEY: 'host-secret', OPENAI_API_KEY: 'host-openai-secret', OPENAI_BASE_URL: 'https://invalid.example.test',
    };
    const original = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
    try {
      await writeFile(preload, `await Bun.write(${JSON.stringify(marker)}, 'host preload executed');\n`);
      // Emulate Node's --require behavior while keeping this test on Bun.
      await writeFile(node, `#!${process.execPath} --no-env-file
if (process.env.NODE_OPTIONS) await import(process.env.NODE_OPTIONS.slice('--require='.length));
await Bun.write(${JSON.stringify(observed)}, JSON.stringify({
  nodeOptions: process.env.NODE_OPTIONS ?? null, nodePreload: process.env.NODE_PRELOAD ?? null,
  bunOptions: process.env.BUN_OPTIONS ?? null, key: process.env.LLM_API_KEY ?? null,
  openaiKey: process.env.OPENAI_API_KEY ?? null, base: process.env.OPENAI_BASE_URL ?? null,
}));
if (process.argv[2] === '--version') process.stdout.write('v24.22.2\\n');
else if (process.argv[2] === '--print' && process.argv[3] === 'process.execPath') process.stdout.write(${JSON.stringify(node)} + '\\n');
else process.exit(2);
`, { mode: 0o700 });
      const control = Bun.spawn([node, '--version'], {
        env: { PATH: root, NODE_OPTIONS: `--require=${preload}` }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(await new Response(control.stdout).text()).toBe('v24.22.2\n');
      expect(await control.exited).toBe(0);
      expect(await readFile(marker, 'utf8')).toBe('host preload executed');
      await rm(marker);
      Object.assign(process.env, inherited);
      const runtime = await runtimeMetadata(cliEnvironment({ home: join(root, 'state'), root, providerPort: 4472 }));
      expect(runtime.node).toBe('v24.22.2');
      expect(runtime.nodeExecPath).toBe(node);
      expect(runtime.bunNodeCompatibility).toBe(process.versions.node);
      expect(runtime.nodeProvenance).toBe('PATH selection before CLI launch');
      expect(JSON.parse(await readFile(observed, 'utf8'))).toEqual({
        nodeOptions: null, nodePreload: null, bunOptions: null, key: null,
        openaiKey: 'acceptance-fake-key', base: 'http://127.0.0.1:4472/v1',
      });
      expect(await readFile(marker, 'utf8').catch(error => error.code)).toBe('ENOENT');
    } finally {
      for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  });

  test('CLI invocation prevents Bun from loading credentials from a repository env file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neat-env-test-'));
    try {
      await writeFile(join(root, '.env'), 'LLM_API_KEY=dummy-dotenv-key\nLLM_BASE_URL=https://invalid.example.test\n');
      const probe = 'process.stdout.write(JSON.stringify({key:process.env.LLM_API_KEY??null,base:process.env.LLM_BASE_URL??null,fake:process.env.OPENAI_API_KEY}))';
      const readEnv = async (args: string[]) => {
        const child = Bun.spawn([process.execPath, ...args, '--eval', probe], {
          cwd: root, env: { ...gitEnvironment(), OPENAI_API_KEY: 'fake-script-key' }, stdout: 'pipe', stderr: 'pipe',
        });
        const output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        return JSON.parse(output);
      };
      expect(await readEnv([])).toEqual({ key: 'dummy-dotenv-key', base: 'https://invalid.example.test', fake: 'fake-script-key' });
      expect(await readEnv(cliArguments('/fixture', 4460).slice(0, 1))).toEqual({ key: null, base: null, fake: 'fake-script-key' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('Git ignores inherited repository, worktree, and index overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neat-git-test-'));
    const original = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map(key => [key, process.env[key]]));
    try {
      const intended = join(root, 'intended'), other = join(root, 'other');
      await mkdir(intended); await mkdir(other);
      await git(intended, 'init', '-b', 'intended'); await git(other, 'init', '-b', 'other');
      await writeFile(join(intended, 'chosen.txt'), 'intended bytes\n');
      await writeFile(join(other, 'chosen.txt'), 'other bytes\n');
      const externalIndex = join(root, 'other-index');
      await writeFile(externalIndex, 'sentinel bytes');
      Object.assign(process.env, { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: externalIndex, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' });
      await git(intended, 'add', 'chosen.txt');
      expect(await git(intended, 'show', ':chosen.txt')).toBe('intended bytes');
      expect(await git(other, 'ls-files')).toBe('');
      expect(await readFile(externalIndex, 'utf8')).toBe('sentinel bytes');
      expect(await readFile(join(other, 'chosen.txt'), 'utf8')).toBe('other bytes\n');
    } finally {
      for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  });

  test('snapshot detects changed untracked bytes when status, HEAD, and index do not change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neat-snapshot-test-'));
    try {
      await git(root, 'init', '-b', 'input');
      await git(root, 'config', 'user.name', 'Acceptance test');
      await git(root, 'config', 'user.email', 'acceptance@example.test');
      await writeFile(join(root, 'tracked.txt'), 'base\n');
      await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Fixture');
      await writeFile(join(root, 'untracked-input.txt'), 'before\n');
      const before = await snapshot(root);
      await writeFile(join(root, 'untracked-input.txt'), 'after\n');
      const after = await snapshot(root);
      expect(after.status).toBe('?? untracked-input.txt');
      expect(after.status).toBe(before.status);
      expect(after.index).toBe(before.index);
      expect(after.untracked).not.toEqual(before.untracked);
      expect(after.untracked['untracked-input.txt']).toBe('7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('failed reclamation retains worker ownership so final teardown retries it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neat-cleanup-test-'));
    await writeFile(join(root, 'owned.txt'), 'retain until reclaimed');
    const proc = spawn(process.execPath, ['--no-env-file', '--eval', 'setInterval(()=>{},1000)'], { stdio: 'ignore', env: gitEnvironment() });
    const owned = { proc, closed: new Promise<void>((resolve, reject) => { proc.once('close', () => resolve()); proc.once('error', reject); }) };
    const owner: { current: typeof owned | undefined } = { current: owned };
    const outcomes: string[] = [];
    try {
      await expect(stopOwnedWorker(owner, { reclaim: async () => { outcomes.push('refused'); throw new Error('Ownership check failed'); }, verify: async () => {} })).rejects.toThrow('Ownership check failed');
      expect(owner.current).toBe(owned);
      await expect(removeOwnedRoot(root, owner)).rejects.toThrow('worker reclamation remains unverified');
      expect(await readFile(join(root, 'owned.txt'), 'utf8')).toBe('retain until reclaimed');
      await stopOwnedWorker(owner, { reclaim: async () => { outcomes.push('reclaimed'); }, verify: async () => { outcomes.push('verified'); } });
      expect(outcomes).toEqual(['refused', 'reclaimed', 'verified']);
      expect(owner.current).toBeUndefined();
      await removeOwnedRoot(root, owner);
      expect(await readFile(join(root, 'owned.txt'), 'utf8').catch(error => error.code)).toBe('ENOENT');
    } finally { proc.kill('SIGKILL'); await owned.closed; await rm(root, { recursive: true, force: true }); }
  });
});
