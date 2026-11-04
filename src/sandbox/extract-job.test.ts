import { $ } from 'bun';
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeReport } from './egress-probe';
import { dockerProvider, SANDBOX_IMAGE, type JobSpec, type SandboxProvider } from './docker';
import { detectPackageManager, dockerJobsAvailable, extractStep, fetchCommit, installCommand, installStep, missingDependencies, redact, REMOVE_PARTIAL_INSTALL, runExtractJob, type PackageManager } from './extract-job';
import { egressNetworkArgs, engineSupportsIsolation, jobNetworkProblem, JOB_TOOLS, JOB_WORKDIR } from './job';

const TOKEN = 'ghs_Zq3vN8tokenForTestsOnly0000000000000000';
const TOKEN_BASE64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const scratch = await mkdtemp(join(tmpdir(), 'neat-extract-test-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('package manager detection', () => {
  test('reads the manager from the lockfile', () => {
    expect(detectPackageManager(['package.json', 'bun.lock'])).toBe('bun');
    expect(detectPackageManager(['bun.lockb'])).toBe('bun');
    expect(detectPackageManager(['pnpm-lock.yaml', 'package.json'])).toBe('pnpm');
    expect(detectPackageManager(['yarn.lock'])).toBe('yarn');
    expect(detectPackageManager(['package-lock.json'])).toBe('npm');
    expect(detectPackageManager(['npm-shrinkwrap.json'])).toBe('npm');
  });

  test('no lockfile means no manager, and bun wins over a stale second lockfile', () => {
    expect(detectPackageManager(['package.json', 'README.md'])).toBeNull();
    expect(detectPackageManager(['package-lock.json', 'bun.lock'])).toBe('bun');
  });
});

describe('job steps', () => {
  test('every install command pins the lockfile and turns scripts off', () => {
    expect(installCommand('bun')).toEqual(['bun', 'install', '--frozen-lockfile', '--ignore-scripts']);
    expect(installCommand('pnpm')).toEqual(['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile']);
    expect(installCommand('npm')).toEqual(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(installCommand('yarn', ['yarn.lock'])).toEqual(['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive']);
    expect(installCommand('yarn', ['yarn.lock', '.yarnrc.yml'])).toEqual(['corepack', 'yarn', 'install', '--immutable', '--mode=skip-build']);
  });

  test('install has the network and may fail; extraction has neither network nor variables', () => {
    const install = installStep('npm', [], 1000);
    expect(install.network).toBe(true);
    expect(install.optional).toBe(true);
    expect(install.env).toMatchObject({ npm_config_ignore_scripts: 'true', YARN_ENABLE_SCRIPTS: 'false', YARN_IGNORE_PATH: '1' });

    const sha = 'a'.repeat(40);
    const extract = extractStep(sha, 1000);
    expect(extract.command).toEqual(['bun', `${JOB_TOOLS}/extract.js`, JOB_WORKDIR, sha]);
    expect(extract.network).toBeUndefined();
    expect(extract.env).toBeUndefined();
    expect(extract.optional).toBeUndefined();
  });

  test('Yarn 2 and later is told to write node_modules, since its default writes none', () => {
    expect(installStep('yarn', ['yarn.lock', '.yarnrc.yml'], 1000).env).toMatchObject({ YARN_NODE_LINKER: 'node-modules' });
  });

  test('the missing-dependencies warning names the cause and nothing from the install output', () => {
    const ran = { exitCode: 0, stdout: 'out', stderr: 'err', truncated: false, timedOut: false, durationMs: 1 };
    expect(missingDependencies('bun', ran)).toBeNull();
    expect(missingDependencies('pnpm', { ...ran, exitCode: 2 })).toBe('Dependencies were not installed because the pnpm install failed with exit code 2, so types from libraries could not be resolved.');
    expect(missingDependencies('yarn', { ...ran, exitCode: null, timedOut: true })).toBe('Dependencies were not installed because the yarn install timed out, so types from libraries could not be resolved.');
    expect(missingDependencies('npm', { ...ran, exitCode: null })).toContain('failed with exit code unknown');
    expect(missingDependencies('npm', null)).toContain('did not run');
    expect(missingDependencies(null, null)).toBe('Dependencies were not installed because the repo has no lockfile, so types from libraries could not be resolved.');
  });
});

describe('token handling', () => {
  test('redact removes the token, its encoded form, and credentials inside URLs', () => {
    const text = `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/a/b/': header ${TOKEN_BASE64} rejected, token ${TOKEN}`;
    const out = redact(text, [TOKEN, TOKEN_BASE64, undefined]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(TOKEN_BASE64);
    expect(out).toContain('https://[redacted]@github.com/a/b/');
    expect(redact('https://user:pw@host/x', [])).toBe('https://[redacted]@host/x');
    expect(redact('nothing secret', [])).toBe('nothing secret');
  });

  test('a token inside the URL is refused without echoing it', async () => {
    const error = await fetchCommit(`https://x:${TOKEN}@github.com/a/b.git`, 'a'.repeat(40), scratch).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  test('short or malformed shas are refused before git runs', async () => {
    await expect(fetchCommit('https://github.com/a/b.git', 'main', scratch)).rejects.toThrow('40 character sha');
    await expect(fetchCommit('https://github.com/a/b.git', '--upload-pack=x', scratch)).rejects.toThrow('40 character sha');
  });

  test('fetching one commit leaves its files and no git state, token or otherwise', async () => {
    const origin = join(scratch, 'origin');
    await mkdir(origin);
    const git = (args: string[]) => $`git ${args}`.cwd(origin).env({ PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }).quiet();
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    const commit = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m'];
    await writeFile(join(origin, 'page.tsx'), 'export default function Page() { return null; }\n');
    await git(['add', '-A']);
    await git([...commit, 'first']);
    const first = (await git(['rev-parse', 'HEAD'])).text().trim();
    await writeFile(join(origin, 'later.txt'), 'added after the commit we want\n');
    await git(['add', '-A']);
    await git([...commit, 'second']);

    const dir = join(scratch, 'checkout');
    await mkdir(dir);
    await fetchCommit(`file://${origin}`, first, dir, TOKEN);
    expect(existsSync(join(dir, 'page.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'later.txt'))).toBe(false);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    const everything = (await $`grep -rIl -e ${TOKEN} -e ${TOKEN_BASE64} ${dir}`.quiet().nothrow()).text();
    expect(everything).toBe('');
  });

  test('a failed fetch reports the repository and sha but never the token', async () => {
    const dir = join(scratch, 'failed');
    await mkdir(dir);
    const error = await fetchCommit(`file://${join(scratch, 'no-such-repo')}`, 'b'.repeat(40), dir, TOKEN).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('git fetch failed');
    expect(message).toContain('b'.repeat(40));
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(TOKEN_BASE64);
  });

  test('the job spec built for a provider carries no token and no worker variables', async () => {
    const repo = join(scratch, 'local');
    await mkdir(repo);
    await writeFile(join(repo, 'package-lock.json'), '{}');
    const specs: JobSpec[] = [];
    const provider: SandboxProvider = {
      ...dockerProvider,
      runJob: async (spec) => {
        specs.push(spec);
        const step = { exitCode: 0, stderr: '', truncated: false, timedOut: false, durationMs: 1 };
        const profile = { schemaVersion: 1, project: 'x', commit: 'printed-by-the-container', components: [], warnings: [], tokens: {}, usage: {} };
        return { id: 'fake', refused: ['example.com:443'], steps: [{ ...step, exitCode: 1, stdout: '', stderr: 'SECRET-LOOKING-INSTALL-OUTPUT' }, { ...step, stdout: '' }, { ...step, stdout: JSON.stringify(profile) }] };
      },
    };
    const sha = 'c'.repeat(40);
    const result = await runExtractJob(provider, { path: repo, sha });
    expect(result.manager).toBe('npm');
    expect(result.install?.exitCode).toBe(1);
    expect(result.refused).toEqual(['example.com:443']);
    // The caller's sha wins over whatever the container printed.
    expect(result.profile.commit).toBe(sha);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.steps.map((s) => s.command[0])).toEqual(['npm', 'find', 'bun']);
    expect(specs[0]!.steps.map((s) => s.network ?? false)).toEqual([true, false, false]);
    // Cleaning up is tied to the install failing, and is not optional: extraction must not see a partial tree.
    expect(specs[0]!.steps[1]).toMatchObject({ when: 'previous-failed', command: ['find', '.', '-name', 'node_modules', '-prune', '-exec', 'rm', '-rf', '{}', '+'] });
    expect(specs[0]!.steps[1]!.optional).toBeUndefined();
    expect(JSON.stringify(specs)).not.toContain(TOKEN);
    expect(Object.keys(specs[0]!.steps[0]!.env ?? {}).sort()).toEqual(['CI', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'YARN_ENABLE_SCRIPTS', 'YARN_IGNORE_PATH', 'YARN_NODE_LINKER', 'npm_config_ignore_scripts']);

    // The failed install shows on the result and in the profile, by exit code and without the install's output.
    expect(result.dependenciesInstalled).toBe(false);
    expect(result.profile.warnings).toEqual(['Dependencies were not installed because the npm install failed with exit code 1, so types from libraries could not be resolved.']);
    expect(JSON.stringify(result.profile)).not.toContain('SECRET-LOOKING-INSTALL-OUTPUT');

    // A cleanup that fails stops the job before extraction, so no profile comes back from a partial tree.
    const step = { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    await expect(runExtractJob({ ...provider, runJob: async () => ({ id: 'fake', refused: [], steps: [{ ...step, exitCode: 1 }, { ...step, exitCode: 1 }] }) }, { path: repo })).rejects.toThrow('could not be cleaned up');

    await expect(runExtractJob(provider, { url: 'git@github.com:a/b.git', sha })).rejects.toThrow('Only https');
    await expect(runExtractJob({ ...provider, runJob: async () => ({ id: 'fake', refused: [], steps: [{ exitCode: 0, stdout: 'not json', stderr: '', truncated: false, timedOut: false, durationMs: 1 }] }) }, { path: join(scratch, 'origin') })).rejects.toThrow('did not print a JSON profile');
  });
});

// Needs Docker and the sandbox image (docker build -t neat-sandbox:dev sandbox). Skipped when either is missing.
// These start real containers and reach the package registry, so they run only when asked: bun run test:docker
const docker = process.env.NEAT_DOCKER_TESTS === '1' && (await dockerJobsAvailable(SANDBOX_IMAGE));

describe.skipIf(!docker)('in a real container', () => {
  /** Containers and networks carrying one job's label. Other jobs running on this machine don't count. */
  const leftovers = async (jobId: string) => {
    const containers = await $`docker ps -aq --filter label=neat.job=${jobId}`.quiet().nothrow().text();
    const networks = await $`docker network ls -q --filter label=neat.job=${jobId}`.quiet().nothrow().text();
    return (containers + networks).trim();
  };

  test('orbit-studio installs through the proxy and extracts to its golden profile', async () => {
    const sha = 'd'.repeat(40);
    const started = performance.now();
    const result = await runExtractJob(dockerProvider, { path: join(import.meta.dir, '..', '..', 'fixtures', 'orbit-studio'), sha });
    const wallMs = Math.round(performance.now() - started);

    expect(result.manager).toBe('bun');
    expect(result.install?.exitCode).toBe(0);
    expect(result.refused).toEqual([]);
    const golden: unknown = JSON.parse(readFileSync(join(import.meta.dir, '..', 'extract', '__golden__', 'orbit-studio.json'), 'utf8'));
    expect(result.profile).toEqual({ ...(golden as typeof result.profile), commit: sha });
    console.log(`extract job: ${wallMs} ms wall (install ${result.install?.durationMs} ms, extract ${result.extract.durationMs} ms), ${result.profile.components.length} components, ${result.profile.tokens.variables.length} token variables`);
    // Nothing of this job's is left: no step, no proxy, no network.
    expect(await leftovers(result.jobId)).toBe('');
  }, 600_000);

  test('a step is cut off from the network and from worker variables, killed at its time limit, and capped', async () => {
    process.env.NEAT_TEST_WORKER_SECRET = 'must-not-leak';
    try {
      const job = await dockerProvider.runJob({
        steps: [
          { command: ['sh', '-c', 'env; id -u; ls /sys/class/net; touch /work/made-by-job'], env: { ONLY_THIS: 'yes' }, timeoutMs: 60_000, optional: true },
          { command: ['sh', '-c', 'head -c 100000 /dev/zero | tr "\\0" x'], maxOutputBytes: 1000, timeoutMs: 60_000, optional: true },
          { command: ['sleep', '120'], timeoutMs: 2000, optional: true },
          { command: ['sh', '-c', 'exit 7'], timeoutMs: 60_000 },
          { command: ['echo', 'never runs'], timeoutMs: 60_000 },
        ],
      });
      const [env, big, slow, failed] = job.steps;
      expect(job.steps).toHaveLength(4);
      expect(env!.exitCode).toBe(0);
      expect(env!.stdout).toContain('ONLY_THIS=yes');
      expect(env!.stdout).not.toContain('NEAT_TEST_WORKER_SECRET');
      expect(env!.stdout).not.toContain('PROXY');
      expect(env!.stdout).not.toContain('eth0');
      expect(env!.stdout).toContain('lo');
      if (typeof process.getuid === 'function') expect(env!.stdout).toContain(`\n${process.getuid()}\n`);
      expect(big).toMatchObject({ exitCode: 0, truncated: true });
      expect(big!.stdout.length).toBe(1000);
      expect(slow).toMatchObject({ exitCode: null, timedOut: true });
      expect(slow!.durationMs).toBeLessThan(30_000);
      expect(failed).toMatchObject({ exitCode: 7, timedOut: false });
      expect(job.refused).toEqual([]);
      expect(await leftovers(job.id)).toBe('');
    } finally {
      delete process.env.NEAT_TEST_WORKER_SECRET;
    }
  }, 120_000);

  test('a network step reaches the registry through the proxy and nothing else, by any route', async () => {
    const tag = randomUUID().slice(0, 8);
    const target = `neat-test-target-${tag}`;
    const probeDir = join(scratch, `probe-${tag}`);
    await mkdir(probeDir);
    await copyFile(join(import.meta.dir, 'egress-probe.ts'), join(probeDir, 'probe.ts'));
    // Something on this machine that only Docker's host name could reach.
    const hostServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('host') });
    try {
      // A neighbour on the default bridge, like another project's container. This test's own; removed below.
      await $`docker run -d --name ${target} --label neat.test=${tag} ${SANDBOX_IMAGE} bun -e ${"Bun.serve({ port: 8080, hostname: '0.0.0.0', fetch: () => new Response('target') })"}`.quiet();
      const targetIp = (await $`docker inspect -f ${'{{.NetworkSettings.Networks.bridge.IPAddress}}'} ${target}`.quiet().text()).trim();
      const gateway = (await $`docker network inspect bridge -f ${'{{(index .IPAM.Config 0).Gateway}}'}`.quiet().text()).trim();
      // Empty on an engine that has no host.docker.internal, where there is nothing to check for it.
      const hostIp = (await $`docker run --rm ${SANDBOX_IMAGE} getent hosts host.docker.internal`.quiet().nothrow().text()).trim().split(/\s+/)[0] ?? '';
      const hostTargets = hostIp ? [`${hostIp}:${hostServer.port}`, `host.docker.internal:${hostServer.port}`] : [];
      const inward = [`${targetIp}:8080`, `${gateway}:${hostServer.port}`, `${gateway}:111`, ...hostTargets];
      const env = {
        PROBE_DIRECT: [...inward, '1.1.1.1:443', '104.16.0.35:443'].join(','),
        PROBE_TUNNEL: ['registry.npmjs.org:443', 'example.com:443', 'registry.npmjs.org:80', 'host.docker.internal:443', '169.254.169.254:80', ...inward].join(','),
        // A tunnel to the registry whose TLS hello names the registry, names another site on the same CDN, or names none.
        PROBE_HANDSHAKE: 'registry.npmjs.org|registry.npmjs.org,registry.npmjs.org|www.cloudflare.com,registry.npmjs.org|',
        PROBE_FETCH: 'https://registry.npmjs.org/clsx/2.1.1,https://example.com/',
        PROBE_DNS: 'example.com,registry.npmjs.org',
      };

      // First show the probe can see these things at all: from the default bridge, where previews run, it can.
      let control: ProbeReport | undefined;
      for (let attempt = 0; attempt < 20 && control?.direct[`${targetIp}:8080`] !== 'connected'; attempt++) {
        const out = await $`docker run --rm -e PROBE_DIRECT=${env.PROBE_DIRECT} -e PROBE_HANDSHAKE=${env.PROBE_HANDSHAKE} -v ${probeDir}:/tools:ro ${SANDBOX_IMAGE} bun /tools/probe.ts`.quiet().text();
        control = JSON.parse(out) as ProbeReport;
      }
      expect(control?.direct[`${targetIp}:8080`]).toBe('connected');
      expect(control?.direct['1.1.1.1:443']).toBe('connected');
      for (const hostTarget of hostTargets) expect([hostTarget, control?.direct[hostTarget]]).toEqual([hostTarget, 'connected']);
      // With no proxy in the way, the registry's address does answer a hello for another site. That is the gap.
      expect(control?.handshake['registry.npmjs.org|www.cloudflare.com']).toBe('handshake');

      const job = await dockerProvider.runJob({ source: probeDir, steps: [{ command: ['bun', 'probe.ts'], env, network: true, timeoutMs: 180_000 }] });
      expect(job.steps[0]?.exitCode).toBe(0);
      const report = JSON.parse(job.steps[0]!.stdout) as ProbeReport;

      // The registry works, by an ordinary fetch that picks the proxy up from the environment.
      expect(report.fetched['https://registry.npmjs.org/clsx/2.1.1']).toBe('200');
      // Bun hands back the proxy's own refusal as the response, so this is 403 or a failure, never the page.
      expect(['403', 'failed']).toContain(report.fetched['https://example.com/']!);
      expect(report.tunnel['registry.npmjs.org:443']).toStartWith('200');
      // Asking the proxy for anything else is refused.
      for (const [asked, answer] of Object.entries(report.tunnel)) {
        if (asked !== 'registry.npmjs.org:443') expect([asked, answer.slice(0, 3)]).toEqual([asked, '403']);
      }
      // Going around the proxy reaches nothing: not the neighbour, the gateway, the host, or the internet.
      for (const [asked, answer] of Object.entries(report.direct)) expect([asked, answer]).not.toEqual([asked, 'connected']);
      expect(Object.keys(report.direct)).toHaveLength(inward.length + 2);
      // Names don't resolve inside the step either, so DNS is not a way out.
      for (const answer of Object.values(report.dns)) expect(answer).not.toMatch(/^\d/);
      // Inside an allowed tunnel, only a hello that names the tunnel's own host goes through.
      expect(report.handshake).toEqual({
        'registry.npmjs.org|registry.npmjs.org': 'handshake',
        'registry.npmjs.org|www.cloudflare.com': 'closed',
        'registry.npmjs.org|': 'closed',
      });
      expect(job.refused).toContain('example.com:443');
      // The two bad hellos were logged as refusals against the tunnel they were sent through.
      expect(job.refused).toContain('registry.npmjs.org:443');
      expect(await leftovers(job.id)).toBe('');

      // A step that asks far more often than the log holds still gets a short list back, and the job still ends.
      const noisy = await dockerProvider.runJob({
        source: probeDir,
        steps: [{ command: ['bun', 'probe.ts'], env: { PROBE_TUNNEL: Array.from({ length: 600 }, (_, i) => `h${i}.example.test:443`).join(',') }, network: true, timeoutMs: 180_000 }],
      });
      expect(noisy.steps[0]?.exitCode).toBe(0);
      expect(noisy.refused).toHaveLength(50);
      expect(noisy.refused[0]).toBe('h0.example.test:443');

      // A listed name that resolves inward is still refused, and a custom list replaces the default one.
      const custom = await dockerProvider.runJob({
        source: probeDir,
        allowedHosts: ['host.docker.internal'],
        steps: [{ command: ['bun', 'probe.ts'], env: { PROBE_TUNNEL: 'host.docker.internal:443,registry.npmjs.org:443' }, network: true, timeoutMs: 120_000 }],
      });
      const customReport = JSON.parse(custom.steps[0]!.stdout) as ProbeReport;
      expect(customReport.tunnel['host.docker.internal:443']).toBe(hostIp ? '403 host resolves to a private address' : '403 host did not resolve');
      expect(customReport.tunnel['registry.npmjs.org:443']).toBe('403 host is not on the allowlist');
      expect(await leftovers(custom.id)).toBe('');
    } finally {
      await $`docker rm -f ${target}`.quiet().nothrow();
      await hostServer.stop(true);
    }
  }, 300_000);

  test('the read-back tells a closed job network from a plain internal one', async () => {
    const tag = randomUUID().slice(0, 8);
    const inspect = async (name: string) => (await $`docker network inspect ${name}`.quiet().text()).trim();
    try {
      // Created exactly as a job does, and then as an engine that ignored the gateway option would leave it.
      await $`docker ${egressNetworkArgs(`test${tag}`)}`.quiet();
      await $`docker network create --internal --label neat.test=${tag} neat-test-plain-${tag}`.quiet();
      expect(jobNetworkProblem(await inspect(`neat-job-test${tag}-net`))).toBeNull();
      expect(jobNetworkProblem(await inspect(`neat-test-plain-${tag}`))).toBe('the isolated gateway mode was not applied');
      expect(jobNetworkProblem(await inspect('bridge'))).toBe('it is not internal');
      expect(engineSupportsIsolation((await $`docker version --format ${'{{.Server.Version}}'}`.quiet().text()).trim())).toBe(true);
    } finally {
      await $`docker network rm neat-job-test${tag}-net neat-test-plain-${tag}`.quiet().nothrow();
    }
  }, 60_000);

  test('a cleanup step runs only after the step before it failed', async () => {
    const leave = 'mkdir -p node_modules/half packages/a/node_modules/half src && touch src/kept';
    const cleanup = { ...REMOVE_PARTIAL_INSTALL };
    const list = { command: ['sh', '-c', 'find . -mindepth 1 | sort'], timeoutMs: 30_000 };
    const afterFailure = await dockerProvider.runJob({ steps: [{ command: ['sh', '-c', `${leave}; exit 3`], timeoutMs: 30_000, optional: true }, cleanup, list] });
    expect(afterFailure.steps.map((s) => [s.exitCode, s.skipped ?? false])).toEqual([[3, false], [0, false], [0, false]]);
    expect(afterFailure.steps[2]?.stdout.trim().split('\n')).toEqual(['./packages', './packages/a', './src', './src/kept']);

    const afterTimeout = await dockerProvider.runJob({ steps: [{ command: ['sh', '-c', `${leave}; sleep 60`], timeoutMs: 3000, optional: true }, cleanup, list] });
    expect(afterTimeout.steps[0]).toMatchObject({ timedOut: true });
    expect(afterTimeout.steps[2]?.stdout).not.toContain('node_modules');

    const afterSuccess = await dockerProvider.runJob({ steps: [{ command: ['sh', '-c', leave], timeoutMs: 30_000, optional: true }, cleanup, list] });
    expect(afterSuccess.steps.map((s) => [s.exitCode, s.skipped ?? false])).toEqual([[0, false], [null, true], [0, false]]);
    expect(afterSuccess.steps[2]?.stdout).toContain('./node_modules/half');
  }, 120_000);

  test('a lockfile that cannot install gives a profile that says dependencies are missing', async () => {
    const repo = join(scratch, 'cannot-install');
    await mkdir(join(repo, 'app'), { recursive: true });
    await writeFile(join(repo, 'app', 'page.tsx'), 'export default function Page() {\n  return <main className="p-4">hi</main>;\n}\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'cannot-install', dependencies: { clsx: '2.1.1', 'neat-labs-no-such-package-c04': '1.0.0' } }));
    // The lockfile points at a package the registry does not have, so the install starts and then fails.
    const lock = { name: 'cannot-install', lockfileVersion: 3, requires: true, packages: {
      '': { name: 'cannot-install', dependencies: { clsx: '2.1.1', 'neat-labs-no-such-package-c04': '1.0.0' } },
      'node_modules/clsx': { version: '2.1.1', resolved: 'https://registry.npmjs.org/clsx/-/clsx-2.1.1.tgz', integrity: 'sha512-eYm0QWBtUrBWZWG0d386OGAw16Z995PiOVo2B7bjWSbHedGl5e0ZWaq65kOGgUSNesEIDkB9ISbTg/JK9dhCZA==' },
      'node_modules/neat-labs-no-such-package-c04': { version: '1.0.0', resolved: 'https://registry.npmjs.org/neat-labs-no-such-package-c04/-/neat-labs-no-such-package-c04-1.0.0.tgz', integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
    } };
    await writeFile(join(repo, 'package-lock.json'), JSON.stringify(lock));
    const result = await runExtractJob(dockerProvider, { path: repo });
    expect(result.manager).toBe('npm');
    expect(result.install?.exitCode).not.toBe(0);
    expect(result.dependenciesInstalled).toBe(false);
    expect(result.profile.project).toBe('cannot-install');
    expect(result.profile.components.map((c) => c.name)).toEqual(['Page']);
    // The profile's own check saw no node_modules, and the job added why.
    expect(result.profile.warnings.some((w) => w.startsWith('node_modules is missing'))).toBe(true);
    expect(result.profile.warnings.at(-1)).toBe(`Dependencies were not installed because the npm install failed with exit code ${result.install?.exitCode}, so types from libraries could not be resolved.`);
    expect(await leftovers(result.jobId)).toBe('');
  }, 300_000);

  // Each manager makes its own lockfile, then installs from it with the real install step. The package has every
  // lifecycle script set to leave a marker, so a marker means scripts ran.
  const lifecycle = { preinstall: 'touch /work/marker', postinstall: 'touch /work/marker', prepare: 'touch /work/marker' };
  const smokePackage = { name: 'smoke', private: true, scripts: lifecycle, dependencies: { clsx: '2.1.1' } };
  const managers: [string, PackageManager, string[], Record<string, string>][] = [
    ['bun', 'bun', ['bun', 'install', '--lockfile-only', '--ignore-scripts'], {}],
    ['npm', 'npm', ['npm', 'install', '--package-lock-only', '--ignore-scripts'], {}],
    ['pnpm', 'pnpm', ['corepack', 'pnpm', 'install', '--lockfile-only', '--ignore-scripts'], {}],
    ['yarn 1', 'yarn', ['yarn', 'install', '--ignore-scripts', '--non-interactive'], {}],
    // corepack downloads this Yarn from repo.yarnpkg.com, which is why that host is on the list.
    // The repo leaves the linker at Yarn's default, Plug'n'Play, so the lockfile step writes no node_modules.
    ['yarn 4', 'yarn', ['corepack', 'yarn', 'install', '--mode=skip-build'], { '.yarnrc.yml': 'enableImmutableInstalls: false\n', 'package.json': JSON.stringify({ ...smokePackage, packageManager: 'yarn@4.5.3' }) }],
  ];

  test.each(managers)('%s installs a dependency through the proxy without running scripts', async (label, manager, makeLockfile, files) => {
    const src = join(scratch, `manager-${label.replace(/\W/g, '')}`);
    await mkdir(src);
    await writeFile(join(src, 'package.json'), JSON.stringify(smokePackage));
    for (const [name, content] of Object.entries(files)) await writeFile(join(src, name), content);
    const rootFiles = Object.keys(files);
    // The lockfile is made the way the repo's own settings say, without the linker the job forces later.
    const { YARN_NODE_LINKER: _forced, ...repoEnv } = installStep(manager, rootFiles, 180_000).env ?? {};
    const job = await dockerProvider.runJob({
      source: src,
      steps: [
        { ...installStep(manager, rootFiles, 180_000), env: repoEnv, command: makeLockfile, optional: false },
        { command: ['sh', '-c', 'ls -a; rm -rf node_modules marker'], timeoutMs: 30_000 },
        { ...installStep(manager, rootFiles, 180_000), optional: false },
        { command: ['sh', '-c', 'test -f node_modules/clsx/package.json && if [ -e marker ]; then echo scripts-ran; else echo no-scripts; fi'], timeoutMs: 30_000 },
      ],
    });
    expect(job.steps.map((s) => [s.exitCode, s.exitCode === 0 ? '' : s.stderr.slice(-500)])).toEqual([[0, ''], [0, ''], [0, ''], [0, '']]);
    expect(job.steps[3]?.stdout.trim()).toBe('no-scripts');
    if (label === 'yarn 4') {
      // Left to itself this Yarn wrote Plug'n'Play files and no node_modules. The forced linker is what made
      // the frozen install above produce node_modules/clsx from that same lockfile.
      const afterLockfile = job.steps[1]!.stdout.split('\n');
      expect(afterLockfile).toContain('.pnp.cjs');
      expect(afterLockfile).not.toContain('node_modules');
    }
    expect(job.refused).toEqual([]);
    expect(await leftovers(job.id)).toBe('');
  }, 600_000);
});
