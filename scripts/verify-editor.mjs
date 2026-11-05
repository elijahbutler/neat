#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { help, isInside, parseOptions, repository } from './verification/options.mjs';
import { checkoutDiff, git, prepareFixture, snapshot } from './verification/fixture.mjs';
import { startScriptedProvider } from './verification/provider.mjs';
import { exerciseEditor, exerciseWorkspaceRecovery, poll } from './verification/browser.mjs';
import { cliArguments, removeOwnedRoot, stopOwnedWorker } from './verification/process.mjs';

if (process.argv.includes('--help')) {
  process.stdout.write(help);
} else {
  try { await main(parseOptions(process.argv.slice(2))); }
  catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}

async function main(options) {
  if (!process.versions.bun) throw new Error('Run this command with Bun');
  if (process.platform === 'win32') throw new Error('This runner requires a Unix host');
  const driverPath = await realpath(options.driver);
  if (isInside(await realpath(repository), driverPath)) throw new Error('Browser driver resolves inside this checkout');
  const driver = await import(pathToFileURL(driverPath).href);
  const chromium = driver.chromium ?? driver.default?.chromium;
  if (!chromium || typeof chromium.launch !== 'function') throw new Error('NEAT_BROWSER_DRIVER must export Playwright chromium');
  if (options.evidence) {
    const parent = await realpath(dirname(options.evidence));
    if (isInside(await realpath(repository), parent)) throw new Error('Evidence parent resolves inside this checkout');
  }
  const evidence = options.evidence ?? await mkdtemp(join(tmpdir(), 'neat-browser-evidence-'));
  if (options.evidence) await mkdir(evidence, { mode: 0o700 });
  const report = { status: 'running', started: new Date().toISOString(), checkpoints: [], gaps: [
    'Live model output quality and external model services', 'Earlier-step dependency conflicts and external-file tampering',
    'Workspace apps, other fixture layouts, native platforms, and concurrent workers',
    'Full accessibility audit',
  ], coverage: Object.fromEntries([
    'selection', 'text', 'propertyAndPendingUndo', 'reloadDuringInspection', 'keptUndo', 'reloadBeforeReply', 'reloadAfterReply',
    'timeline', 'sharedConfirmation', 'routeNavigation', 'restart', 'delivery', 'artifactIntegrity', 'workspaceRecovery',
  ].map(phase => [phase, false])), provider: 'scripted HTTP through production adapter', cleanup: 'pending' };
  const events = [];
  const root = await mkdtemp(join(tmpdir(), 'neat-browser-run-'));
  const home = join(root, 'state');
  await mkdir(home);
  let repo, before, provider, browser, context, page;
  const owner = { current: undefined };
  let workerOutput = '';
  const log = createWriteStream(join(evidence, 'worker.log'), { mode: 0o600 });
  const abort = new AbortController();
  const onSignal = () => {
    abort.abort(new Error('Browser acceptance interrupted'));
    void browser?.close().catch(() => undefined);
    owner.current?.proc.kill('SIGTERM');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const save = () => writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const checkpoint = async (name, phase) => {
    abort.signal.throwIfAborted();
    assert.ok(Object.hasOwn(report.coverage, phase), `Known coverage phase: ${phase}`);
    report.coverage[phase] = true;
    report.checkpoints.push({ phase, name, at: new Date().toISOString() });
    await save();
    console.log(`Passed: ${name}`);
  };
  const stop = async () => {
    if (!owner.current) return;
    // The production recovery function checks process identity and worktree
    // ownership. Pass only this run's registry, including after a failed launch.
    await stopOwnedWorker(owner, {
      reclaim: async () => { const { reclaimSessions } = await import('../src/sandbox/worktree.ts'); await reclaimSessions(join(home, 'sessions')); },
      verify: async () => {
        const records = await readdir(join(home, 'sessions/.registry')).catch(() => []);
        assert.equal(records.length, 0, 'All owned session records were reclaimed');
        if (repo) assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 1, 'Only the fixture input worktree remains');
      },
    });
  };
  const launch = async () => {
    abort.signal.throwIfAborted();
    // Start from a small allowlist. Real model credentials, model proxy URLs,
    // catalogues, Git configuration, and preload options never reach the CLI.
    const env = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LANG', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, {
      NEAT_HOME: home, OPENAI_API_KEY: 'acceptance-fake-key', OPENAI_BASE_URL: `http://127.0.0.1:${options.providerPort}/v1`,
      LLM_EDIT_MODEL: 'acceptance-script', NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GH_CONFIG_DIR: join(root, 'unsigned-github'),
    });
    workerOutput = '';
    const args = cliArguments(repo, options.port);
    const proc = spawn(process.execPath, args, { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise((resolve, reject) => { proc.once('close', resolve); proc.once('error', reject); });
    owner.current = { proc, closed };
    report.launches ??= [];
    report.launches.push({ command: [process.execPath, ...args], cwd: repository, pid: proc.pid });
    for (const stream of [proc.stdout, proc.stderr]) stream.on('data', data => { workerOutput += data.toString(); log.write(data); });
    const state = await poll('owned CLI startup', () => ({
      aborted: abort.signal.aborted,
      exited: proc.exitCode !== null || proc.signalCode !== null,
      origin: /Editor: (http:\/\/127\.0\.0\.1:\d+)\/editor/.exec(workerOutput)?.[1],
    }), state => state.aborted || state.exited || Boolean(state.origin), options.timeout, abort.signal);
    abort.signal.throwIfAborted();
    if (state.exited) throw new Error(`CLI exited ${proc.exitCode ?? proc.signalCode}: ${workerOutput.slice(-3000)}`);
    const origin = state.origin;
    assert.equal(origin, `http://127.0.0.1:${options.port}`, 'Requested editor port was free');
    await page.goto(`${origin}/editor`);
    const startup = await (await fetch(`${origin}/api/editor/startup`, { signal: AbortSignal.timeout(options.timeout) })).json();
    report.launches.at(-1).startup = startup;
    const progress = page.getByRole('status').filter({ hasText: /Preparing your preview|Preparing project dependencies|Restoring your saved pass|Starting your app|Connecting to your preview/ }).first();
    if (await progress.isVisible()) {
      report.launches.at(-1).startupVisible = await progress.innerText();
      await page.screenshot({ path: join(evidence, `startup-${report.launches.length}.png`), fullPage: true });
    }
    const prepared = await poll('owned CLI session preparation', async () => {
      abort.signal.throwIfAborted();
      if (proc.exitCode !== null || proc.signalCode !== null) return { exited: true, sessions: [] };
      const response = await fetch(`${origin}/api/editor/sessions`, { signal: AbortSignal.timeout(options.timeout) });
      assert.equal(response.status, 200);
      return { exited: false, sessions: (await response.json()).sessions };
    }, state => state.exited || state.sessions.length === 1, options.timeout, abort.signal);
    abort.signal.throwIfAborted();
    assert.equal(prepared.exited, false, 'Owned CLI stayed alive through preparation');
    const { sessions } = prepared;
    assert.equal(sessions.length, 1, 'This CLI owns exactly one session');
    const session = sessions[0];
    assert.equal(resolve(session.fixture), repo, 'Session belongs to the disposable fixture');
    const preview = new URL(session.previewUrl);
    assert.equal(preview.hostname, '127.0.0.1');
    assert.equal(preview.protocol, 'http:');
    report.previewUrl = preview.origin;
    report.sessionId = session.id;
    report.passId = session.pass?.id;
    const record = JSON.parse(await readFile(join(home, 'sessions/.registry', `${session.id}.json`), 'utf8'));
    report.launches.at(-1).previewProcess = record.preview;
    return origin;
  };
  try {
    console.log(`Evidence: ${evidence}`);
    report.source = { head: await git(repository, 'rev-parse', 'HEAD'), status: await git(repository, 'status', '--porcelain=v1'), runtime: { bun: process.versions.bun, node: process.versions.node }, runnerArguments: process.argv.slice(2), runnerPid: process.pid };
    const diff = await checkoutDiff();
    await writeFile(join(evidence, 'checkout.diff'), diff, { mode: 0o600 });
    report.source.diffSha256 = createHash('sha256').update(diff).digest('hex');
    repo = await prepareFixture(root);
    before = await snapshot(repo);
    report.inputBefore = before;
    provider = startScriptedProvider(options.providerPort);
    browser = await chromium.launch({ headless: !options.headed, ...(options.executable ? { executablePath: options.executable } : {}) });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
    await context.addInitScript(() => {
      // Observe the real bridge handshake without creating a selection or
      // changing the application. Frame source and origin must both match.
      window.__neatAcceptanceReadyCount = 0;
      window.addEventListener('message', event => {
        const frame = document.querySelector('iframe');
        if (event.data?.type === 'neat:ready' && frame && event.source === frame.contentWindow && event.origin === new URL(frame.src).origin) window.__neatAcceptanceReadyCount++;
      });
    });
    // Browser requests stay on loopback. The CLI environment points its only
    // model adapter at our scripted provider and leaves the catalogue unset.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', '[::1]'].includes(url.hostname) || ['data:', 'blob:', 'about:'].includes(url.protocol) ? route.continue() : route.abort('blockedbyclient');
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    page.setDefaultTimeout(options.timeout);
    page.setDefaultNavigationTimeout(options.timeout);
    page.on('pageerror', error => events.push({ kind: 'pageerror', message: error.message }));
    page.on('console', message => { if (message.type() === 'error') events.push({ kind: 'console', message: message.text() }); });
    const origin = await launch();
    await exerciseEditor({ page, origin, evidence, timeout: options.timeout, provider, checkpoint, restart: async () => {
      const pass = report.passId, previous = report.sessionId;
      await stop();
      await launch();
      assert.equal(report.passId, pass, 'Same durable pass restored after restart');
      assert.notEqual(report.sessionId, previous, 'Restart created a new preview session');
    } });
    const branch = 'neat/browser-acceptance';
    const deliveredTree = await git(repo, 'rev-parse', `${branch}^{tree}`);
    const patchRepo = join(root, 'patch-checkout');
    await git(repo, 'worktree', 'add', '--detach', patchRepo, before.head);
    try {
      await git(patchRepo, 'am', '-3', join(evidence, 'delivery.patch'));
      assert.equal(await git(patchRepo, 'rev-parse', 'HEAD^{tree}'), deliveredTree, 'Downloaded patch reproduces delivered branch tree');
      const files = (await git(repo, 'diff', '--name-only', before.head, branch)).split('\n');
      assert.deepEqual(files.sort(), ['app/page.tsx', 'components/AcceptanceBadge.tsx'], 'Delivery contains only the intended edits');
      await git(repo, 'bundle', 'create', join(evidence, 'delivery.bundle'), branch);
    } finally { await git(repo, 'worktree', 'remove', '--force', patchRepo); }
    report.deliveredTree = deliveredTree;
    report.inputAfter = await snapshot(repo);
    assert.deepEqual(report.inputAfter, before, 'Input HEAD, branch, status, index, and dirty bytes remain intact');
    await checkpoint('downloaded patch matches local branch, input HEAD/index/working tree intact', 'artifactIntegrity');
    const retried = await exerciseWorkspaceRecovery({ page, origin, evidence, timeout: options.timeout, stopPreview: async () => {
      const { processIdentity } = await import('../src/sandbox/worktree.ts');
      const preview = report.launches.at(-1).previewProcess;
      assert.equal(await processIdentity(preview.pid), preview.start, 'Failure probe targets the owned preview process');
      process.kill(-preview.pid, 'SIGTERM');
      await poll('owned preview stopped', async () => (await (await fetch(`${origin}/api/editor/sessions/${report.sessionId}`)).json()).state, state => state === 'failed', options.timeout, abort.signal);
      const { logs } = await (await fetch(`${origin}/api/editor/sessions/${report.sessionId}/logs`)).json();
      assert.ok(logs.trim(), 'Owned preview retained startup logs');
      return { sessionId: report.sessionId, logs };
    } });
    const retryRecord = JSON.parse(await readFile(join(home, 'sessions/.registry', `${retried.id}.json`), 'utf8'));
    report.previewRetry = { sessionId: retried.id, passId: retried.pass?.id, process: retryRecord.preview };
    assert.equal(retried.pass?.id, report.passId, 'Retry resumes the same kept pass');
    await checkpoint('native Reload preserves query and fragment, failed preview logs display, and Try again restores saved work', 'workspaceRecovery');
    assert.deepEqual(events.filter(event => event.kind === 'pageerror'), [], 'No uncaught browser errors');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack ?? error.message;
    if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => undefined);
  } finally {
    const cleanupErrors = [];
    const attempt = async action => { try { await action(); } catch (error) { cleanupErrors.push(error.stack ?? error.message); } };
    await attempt(async () => { if (context) await context.tracing.stop({ path: join(evidence, 'trace.zip') }); });
    await attempt(async () => { if (browser) await browser.close(); });
    await attempt(stop);
    await attempt(async () => { if (provider) await provider.close(); });
    await attempt(async () => {
      if (before) {
        report.inputAfterCleanup = await snapshot(repo);
        assert.deepEqual(report.inputAfterCleanup, before, 'Input remains intact after teardown');
      }
      const passes = join(home, 'passes');
      if (await readdir(passes).then(() => true, () => false)) await cp(passes, join(evidence, 'passes'), { recursive: true });
    });
    report.providerCalls = provider?.calls ?? [];
    await writeFile(join(evidence, 'browser.json'), JSON.stringify(events, null, 2) + '\n', { mode: 0o600 });
    await new Promise(resolve => log.end(resolve));
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // A failed ownership check leaves the disposable root for diagnosis instead
    // of deleting live processes' files. It never broadens cleanup to other runs.
    if (!cleanupErrors.length) await attempt(() => removeOwnedRoot(root, owner));
    report.cleanup = cleanupErrors.length ? { status: 'failed', errors: cleanupErrors, retainedRoot: root } : 'complete';
    if (cleanupErrors.length || abort.signal.aborted) report.status = 'failed';
    report.finished = new Date().toISOString();
    await save();
  }
  console.log(`Acceptance ${report.status}. Evidence: ${evidence}`);
  if (report.status !== 'passed') throw new Error(report.error ?? 'Acceptance teardown failed. See report.json');
}
