import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function cliEnvironment({ home, root, providerPort }) {
  // Real credentials, proxy URLs, catalogues, Git configuration, and preload
  // options never reach the CLI or the selected-runtime probe.
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LANG', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) if (process.env[key]) env[key] = process.env[key];
  return Object.assign(env, {
    NEAT_HOME: home, OPENAI_API_KEY: 'acceptance-fake-key', OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
    LLM_EDIT_MODEL: 'acceptance-script', NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GH_CONFIG_DIR: join(root, 'unsigned-github'),
  });
}

export async function runtimeMetadata(env) {
  // Probe the PATH selection before launch. This does not inspect a Next PID.
  const options = { env, timeout: 5000 };
  const version = await execute('node', ['--version'], options);
  const executable = await execute('node', ['--print', 'process.execPath'], options);
  return {
    bun: process.versions.bun, bunNodeCompatibility: process.versions.node,
    node: version.stdout.trim(), nodeExecPath: executable.stdout.trim(),
    nodeProvenance: 'PATH selection before CLI launch',
  };
}

export function cliArguments(repo, port) {
  return ['--no-env-file', 'bin/neat.ts', 'open', repo, '--port', String(port)];
}

export async function removeOwnedRoot(root, owner) {
  assert.equal(owner.current, undefined, 'Cannot remove a root while worker reclamation remains unverified');
  await rm(root, { recursive: true, force: true });
}

// Keep the reference until all process and registry checks succeed. A restart
// failure must remain retryable from the outer finally block.
export async function stopOwnedWorker(owner, { reclaim, verify, timeout = 20000 }) {
  const owned = owner.current;
  if (!owned) return;
  if (owned.proc.exitCode === null && owned.proc.signalCode === null) owned.proc.kill('SIGTERM');
  let timer;
  try {
    const ended = await Promise.race([owned.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); })]);
    if (!ended) { owned.proc.kill('SIGKILL'); await owned.closed; }
  } finally { clearTimeout(timer); }
  await reclaim();
  await verify();
  assert.equal(owner.current, owned, 'Worker ownership did not change during teardown');
  owner.current = undefined;
}
