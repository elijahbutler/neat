import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedText, copyWorkingCopy, failed, egressNetworkArgs, engineSupportsIsolation, jobNetworkProblem, jobRunArgs, MIN_ENGINE_MAJOR, JOB_TOOLS, JOB_WORKDIR, proxyRunArgs, refusedTargets, type JobRunOptions } from './job';

const opts: JobRunOptions = { image: 'neat-sandbox:dev', name: 'neat-job-abc-0', jobId: 'abc', dir: '/home/w/.neat/jobs/abc', memory: '4g', cpus: 2, user: '501:20' };

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

test('output under the cap is kept whole', async () => {
  expect(await boundedText(streamOf('hello ', 'world'), 64)).toEqual({ text: 'hello world', truncated: false });
  expect(await boundedText(streamOf('12345678'), 8)).toEqual({ text: '12345678', truncated: false });
});

test('output over the cap is cut at the cap and the rest is drained', async () => {
  expect(await boundedText(streamOf('abcdef', 'ghijkl', 'mnopqr'), 8)).toEqual({ text: 'abcdefgh', truncated: true });
  expect(await boundedText(streamOf('x'.repeat(1000)), 0)).toEqual({ text: '', truncated: true });
});

test('a step has limits, no network, no ports, and a non-root user by default', () => {
  const args = jobRunArgs(opts, { command: ['bun', 'x.js'], timeoutMs: 1000 });
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  expect(value('--network')).toBe('none');
  expect(value('--memory')).toBe('4g');
  expect(value('--memory-swap')).toBe('4g');
  expect(value('--cpus')).toBe('2');
  expect(value('--user')).toBe('501:20');
  expect(value('--cap-drop')).toBe('ALL');
  expect(value('--log-driver')).toBe('none');
  expect(args).toContain('neat.job=abc');
  expect(args).not.toContain('-p');
  expect(args).not.toContain('--publish');
  expect(args).not.toContain('-d');
  expect(args.slice(-4)).toEqual([JOB_WORKDIR, 'neat-sandbox:dev', 'bun', 'x.js']);
  expect(args.filter((a) => a === '-v').length).toBe(1);
});

const egress = { network: 'neat-job-abc-net', proxyUrl: 'http://172.30.0.2:3128' };

test('a network step joins the job network with the proxy set, never the default bridge', () => {
  const args = jobRunArgs({ ...opts, tools: '/tmp/tools', egress }, { command: ['bun', 'install'], env: { HTTPS_PROXY: 'http://elsewhere:1' }, network: true, timeoutMs: 1000 });
  expect(args[args.indexOf('--network') + 1]).toBe('neat-job-abc-net');
  expect(args).not.toContain('bridge');
  expect(args).not.toContain('host');
  const env = args.filter((_, i) => args[i - 1] === '-e');
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'YARN_HTTP_PROXY', 'YARN_HTTPS_PROXY']) expect(env).toContain(`${name}=http://172.30.0.2:3128`);
  // The provider's proxy comes after the step's own variable, so it wins.
  expect(env.indexOf('HTTPS_PROXY=http://172.30.0.2:3128')).toBeGreaterThan(env.indexOf('HTTPS_PROXY'));
  expect(args).toContain(`/tmp/tools:${JOB_TOOLS}:ro`);
  expect(args).toContain(`/home/w/.neat/jobs/abc:${JOB_WORKDIR}`);
});

test('a step that did not ask stays off the network even when the job has a proxy', () => {
  const args = jobRunArgs({ ...opts, egress }, { command: ['bun', 'x.js'], timeoutMs: 1000 });
  expect(args[args.indexOf('--network') + 1]).toBe('none');
  expect(args.join(' ')).not.toContain('PROXY');
});

test('a network step with no proxy is refused instead of given open access', () => {
  expect(() => jobRunArgs(opts, { command: ['bun', 'install'], network: true, timeoutMs: 1000 })).toThrow('needs the job proxy');
});

test('the job network is internal with no gateway, and the proxy is the labelled container on the bridge', () => {
  const network = egressNetworkArgs('abc');
  expect(network).toContain('--internal');
  expect(network).toContain('com.docker.network.bridge.gateway_mode_ipv4=isolated');
  expect(network).toContain('--ipv6=false');
  expect(network.slice(-3)).toEqual(['--label', 'neat.job=abc', 'neat-job-abc-net']);

  const proxy = proxyRunArgs({ image: 'neat-sandbox:dev', jobId: 'abc', toolsDir: '/tmp/p', allowedHosts: ['registry.npmjs.org', 'repo.yarnpkg.com'], user: '501:20' });
  const value = (flag: string) => proxy[proxy.indexOf(flag) + 1];
  expect(value('--name')).toBe('neat-job-abc-proxy');
  expect(value('--network')).toBe('bridge');
  expect(proxy).toContain('neat.job=abc');
  expect(proxy).toContain('neat.job.role=proxy');
  expect(proxy).toContain('NEAT_ALLOWED_HOSTS=registry.npmjs.org,repo.yarnpkg.com');
  expect(proxy).toContain('--read-only');
  expect(proxy).not.toContain('-p');
  expect(() => proxyRunArgs({ image: 'i', jobId: 'abc', toolsDir: '/tmp/p', allowedHosts: ['a.test,evil.test'] })).toThrow('Invalid allowed host');
});

test('the working copy leaves out node_modules, .git, .next and .neat, with or without a trailing slash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neat-copy-test-'));
  try {
    const source = join(root, 'repo');
    for (const dir of ['node_modules/pkg', '.git', '.next/cache', '.neat', 'packages/a/node_modules/dep', 'src/app']) await mkdir(join(source, dir), { recursive: true });
    for (const file of ['node_modules/pkg/index.js', '.git/config', '.next/cache/x', '.neat/tag.cjs', 'packages/a/node_modules/dep/index.js', 'src/app/page.tsx', 'package.json']) await writeFile(join(source, file), 'x');
    for (const [name, given] of [['plain', source], ['slash', `${source}/`], ['slashes', `${source}//`], ['dotted', `${source}/src/..`]] as const) {
      const dir = join(root, `out-${name}`);
      await copyWorkingCopy(given, dir);
      const copied = (await readdir(dir, { recursive: true })).sort();
      expect([name, copied]).toEqual([name, ['package.json', 'packages', 'packages/a', 'src', 'src/app', 'src/app/page.tsx']]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a step failed only when it ran and did not exit cleanly', () => {
  const ran = { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 1 };
  expect(failed(ran)).toBe(false);
  expect(failed({ ...ran, exitCode: 1 })).toBe(true);
  expect(failed({ ...ran, exitCode: null, timedOut: true })).toBe(true);
  expect(failed({ ...ran, exitCode: null, skipped: true })).toBe(false);
  expect(failed(undefined)).toBe(false);
});

test('only an engine new enough for the isolated gateway mode is accepted', () => {
  for (const version of ['28.0.0', '28.5.1', '29.8.2', ' 28.1.0-rc.1\n', '100.0.1']) expect([version, engineSupportsIsolation(version)]).toEqual([version, true]);
  for (const version of ['27.5.1', '26.1.4', '20.10.24', '19.03.15', '2.8.0', '', 'unknown', 'v28.0.0', '28', '-28.0.0', 'Error: 28.0.0']) expect([version, engineSupportsIsolation(version)]).toEqual([version, false]);
  expect(MIN_ENGINE_MAJOR).toBe(28);
});

test('a job network passes only when the engine reports it internal, isolated, and without a gateway', () => {
  const good = { Driver: 'bridge', Internal: true, EnableIPv6: false, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' }, IPAM: { Config: [{ Subnet: '172.26.0.0/16' }] } };
  const check = (change: object) => jobNetworkProblem(JSON.stringify([{ ...good, ...change }]));
  expect(check({})).toBeNull();
  // What an engine that ignored the option would report: created fine, but with a gateway and no mode.
  expect(check({ Options: {}, IPAM: { Config: [{ Subnet: '172.25.0.0/16', Gateway: '172.25.0.1' }] } })).toBe('the isolated gateway mode was not applied');
  expect(check({ Options: null })).toBe('the isolated gateway mode was not applied');
  expect(check({ Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'nat' } })).toBe('the isolated gateway mode was not applied');
  expect(check({ EnableIPv6: true })).toBe('IPv6 is not switched off');
  expect(check({ EnableIPv6: undefined })).toBe('IPv6 is not switched off');
  expect(check({ IPAM: { Config: [{ Subnet: '172.25.0.0/16', Gateway: '172.25.0.1' }] } })).toBe('it has a gateway address, which reaches the host');
  expect(check({ IPAM: { Config: [] } })).toBe('it has no address range');
  expect(check({ IPAM: null })).toBe('it has no address range');
  expect(check({ Internal: false })).toBe('it is not internal');
  expect(check({ Internal: 'true' })).toBe('it is not internal');
  expect(check({ Driver: 'host' })).toBe('it is not a bridge network');
  for (const unreadable of ['', '[]', 'null', 'not json', '"text"']) expect([unreadable, jobNetworkProblem(unreadable)]).toEqual([unreadable, 'its description could not be read']);
});

test('refused targets are read from the proxy log once each', () => {
  const log = ['listening 3128', 'allowed registry.npmjs.org:443', 'refused example.com:443 host is not on the allowlist', 'refused example.com:443 host is not on the allowlist', 'refused http://x.test/ only CONNECT is allowed', 'noise'].join('\n');
  expect(refusedTargets(log)).toEqual(['example.com:443', 'http://x.test/']);
  expect(refusedTargets(Array.from({ length: 200 }, (_, i) => `refused h${i}.test:443 host is not on the allowlist`).join('\n'))).toHaveLength(50);
});

test('variables are passed by name, so values stay out of the command line', () => {
  const args = jobRunArgs(opts, { command: ['env'], env: { CI: '1', REGISTRY_KEY: 'hunter2' }, timeoutMs: 1000 });
  expect(args.filter((_, i) => args[i - 1] === '-e')).toEqual(['HOME=/tmp', 'CI', 'REGISTRY_KEY']);
  expect(args.join(' ')).not.toContain('hunter2');
});

test('bad variable names and an empty command are refused', () => {
  expect(() => jobRunArgs(opts, { command: ['env'], env: { 'A=B': '1' }, timeoutMs: 1 })).toThrow('Invalid job variable name');
  expect(() => jobRunArgs(opts, { command: ['env'], env: { DOCKER_HOST: 'tcp://x' }, timeoutMs: 1 })).toThrow("can't set DOCKER_HOST");
  expect(() => jobRunArgs(opts, { command: ['env'], env: { PATH: '/x' }, timeoutMs: 1 })).toThrow("can't set PATH");
  expect(() => jobRunArgs(opts, { command: [], timeoutMs: 1 })).toThrow('needs a command');
});
