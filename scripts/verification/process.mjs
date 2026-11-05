import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

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
