import { $ } from 'bun';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROXY_PORT, REGISTRY_HOSTS } from './egress';

/** Directories that never go into a working copy. */
export const COPY_SKIP = /[\\/](node_modules|\.next|\.git|\.neat)([\\/]|$)/;
/** Where a job's working directory and its read-only tools appear inside the job. */
export const JOB_WORKDIR = '/work';
export const JOB_TOOLS = '/tools';

const JOBS_HOME = join(homedir(), '.neat', 'jobs');
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The docker client reads these from its own environment, so a job can't use them as variable names.
const CLIENT_ENV = /^(PATH|HOME|DOCKER_.*)$/;
// Every spelling the package managers read. Yarn 2 and later only reads its own two.
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'YARN_HTTP_PROXY', 'YARN_HTTPS_PROXY'];
const MAX_REFUSED = 50;
// The proxy stops logging after a fixed number of short lines. These are a second bound on what the worker reads.
const PROXY_LOG_LINES = 400;
const PROXY_LOG_BYTES = 256 * 1024;
/** The first engine whose bridge driver has the isolated gateway mode. Older ones may accept the option and ignore it. */
export const MIN_ENGINE_MAJOR = 28;
const GATEWAY_MODE = 'com.docker.network.bridge.gateway_mode_ipv4';

export interface JobStep {
  /** Program and arguments. No shell unless the command names one. */
  command: string[];
  /** The only variables the step sees besides HOME and, for a network step, the proxy address. Nothing is inherited from the worker. */
  env?: Record<string, string>;
  /**
   * Steps have no network unless this is true. True means package registry access and nothing else: the step
   * reaches only the job's allowed hosts on port 443, through a proxy, with no route to the host machine, other
   * containers, or the rest of the internet. Treat whatever runs in such a step as untrusted code.
   */
  network?: boolean;
  /** Wall-clock limit. The step is killed when it passes. */
  timeoutMs: number;
  /** Cap on captured stdout and on captured stderr, each. Defaults to 1 MiB. */
  maxOutputBytes?: number;
  /** When true, a failure or timeout of this step doesn't stop the job. */
  optional?: boolean;
  /**
   * 'previous-failed' runs the step only when the step right before it failed or timed out, for cleaning up after
   * an optional step. Otherwise the step is skipped and its result says so.
   */
  when?: 'previous-failed';
}

export interface JobSpec {
  /** A local directory copied into the fresh working directory, without node_modules, .next, .git and .neat. */
  source?: string;
  /** A local directory every step can read at JOB_TOOLS and none can write. */
  tools?: string;
  /** Run in order in the same working directory (JOB_WORKDIR), each in its own container. */
  steps: JobStep[];
  /** Host names network steps may reach, in place of REGISTRY_HOSTS. For example a team's private registry. */
  allowedHosts?: string[];
  /** Memory limit per step, in docker's format. Defaults to 4g. */
  memory?: string;
  /** CPU limit per step. Defaults to 2. */
  cpus?: number;
}

export interface JobStepResult {
  /** Null when the step never started or was killed before it reported a code. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout or stderr was longer than the cap and the rest was dropped. */
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** True when the step's `when` condition did not hold, so nothing ran. */
  skipped?: boolean;
}

export interface JobResult {
  /** Names this job in logs and in the provider's own labels. */
  id: string;
  /** One entry per step reached, in the spec's order, skipped ones included. Shorter than the spec when a required step failed. */
  steps: JobStepResult[];
  /** The host:port targets network steps asked for and were refused, without repeats. Explains a failed install. */
  refused: string[];
}

/** True for a step that ran and did not exit cleanly. A skipped or missing step did not fail. */
export function failed(result: JobStepResult | undefined): boolean {
  return !!result && !result.skipped && (result.exitCode !== 0 || result.timedOut);
}

/**
 * Copy a repo into a working directory without node_modules, .next, .git and .neat. The source is resolved
 * first, so a trailing slash or a relative path can't shift the part of each path the skip rule looks at.
 */
export async function copyWorkingCopy(source: string, dir: string): Promise<void> {
  const root = resolve(source);
  await cp(root, dir, { recursive: true, filter: (src) => !COPY_SKIP.test(src.slice(root.length)) });
}

/** Read a stream to its end but keep only the first `max` bytes, so a noisy job can't fill the worker's memory. */
export async function boundedText(stream: ReadableStream<Uint8Array>, max: number): Promise<{ text: string; truncated: boolean }> {
  const kept = new Uint8Array(max);
  let size = 0;
  let truncated = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    const room = max - size;
    if (chunk.length > room) truncated = true;
    if (room > 0) {
      kept.set(chunk.subarray(0, room), size);
      size += Math.min(chunk.length, room);
    }
  }
  return { text: new TextDecoder().decode(kept.subarray(0, size)), truncated };
}

export interface JobRunOptions {
  image: string;
  name: string;
  jobId: string;
  dir: string;
  tools?: string;
  memory: string;
  cpus: number;
  /** Run as this user so files written to the mount belong to the worker. Omitted where the platform has no uids. */
  user?: string;
  /** The job's closed network and the proxy on it. Network steps join it; without it they can't run. */
  egress?: { network: string; proxyUrl: string };
}

const networkName = (jobId: string) => `neat-job-${jobId}-net`;
const proxyName = (jobId: string) => `neat-job-${jobId}-proxy`;

/**
 * The `docker run` arguments for one step. Variables are passed by name only, so their values never show up in
 * the process list; the caller puts the values in the docker client's environment. A network step never joins
 * the default bridge: it joins the job's closed network and is told where the proxy is.
 */
export function jobRunArgs(opts: JobRunOptions, step: JobStep): string[] {
  const names = Object.keys(step.env ?? {});
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw new Error(`Invalid job variable name: ${JSON.stringify(name)}`);
    if (CLIENT_ENV.test(name)) throw new Error(`A job can't set ${name}.`);
  }
  if (!step.command.length) throw new Error('A job step needs a command.');
  const { egress } = opts;
  if (step.network && !egress) throw new Error('A network step needs the job proxy.');
  return [
    'run', '--init', '--name', opts.name, '--label', `neat.job=${opts.jobId}`, '--label', 'neat.job.role=step',
    // Swap equal to memory means no swap, so the memory limit is the whole limit.
    '--memory', opts.memory, '--memory-swap', opts.memory, '--cpus', String(opts.cpus), '--pids-limit', '1024',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    // Output goes to the attached client only, so a noisy step can't fill the engine's log files.
    '--log-driver', 'none',
    '--network', step.network && egress ? egress.network : 'none',
    ...(opts.user ? ['--user', opts.user] : []),
    '-e', 'HOME=/tmp', ...names.flatMap((name) => ['-e', name]),
    // Last, so a step can't point itself at a different proxy. The address is not a secret.
    // NODE_USE_ENV_PROXY makes Node's own fetch use the proxy too, which pnpm's installer relies on.
    ...(step.network && egress ? [...PROXY_ENV.flatMap((name) => ['-e', `${name}=${egress.proxyUrl}`]), '-e', 'NODE_USE_ENV_PROXY=1'] : []),
    '-v', `${opts.dir}:${JOB_WORKDIR}`, ...(opts.tools ? ['-v', `${opts.tools}:${JOB_TOOLS}:ro`] : []),
    '-w', JOB_WORKDIR, opts.image, ...step.command,
  ];
}

/** The network a job's steps use: internal, so no route out, and with no gateway address, so no route to the host. */
export function egressNetworkArgs(jobId: string): string[] {
  // IPv6 is switched off outright: the isolated mode above covers IPv4 only, and an IPv6 gateway would reach the host too.
  return ['network', 'create', '--internal', '--ipv6=false', '-o', `${GATEWAY_MODE}=isolated`, '--label', `neat.job=${jobId}`, networkName(jobId)];
}

/** True only for an engine version new enough to have the isolated gateway mode. Anything unreadable is false. */
export function engineSupportsIsolation(version: string): boolean {
  const major = /^(\d+)\.\d+/.exec(version.trim());
  return major !== null && Number(major[1]) >= MIN_ENGINE_MAJOR;
}

/**
 * Read back what `docker network inspect` says about a job network and return what is wrong with it, or null
 * when it is closed the way a job needs: internal, the isolated mode recorded, and no gateway address handed
 * out. The create command succeeding is not proof, so a job runs only when this returns null.
 */
export function jobNetworkProblem(inspectJson: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(inspectJson);
  } catch {
    return 'its description could not be read';
  }
  const network = (Array.isArray(value) ? value[0] : value) as { Internal?: unknown; Driver?: unknown; EnableIPv6?: unknown; Options?: Record<string, unknown> | null; IPAM?: { Config?: { Gateway?: unknown }[] | null } | null } | null;
  if (!network || typeof network !== 'object') return 'its description could not be read';
  if (network.Driver !== 'bridge') return 'it is not a bridge network';
  if (network.Internal !== true) return 'it is not internal';
  if (network.EnableIPv6 !== false) return 'IPv6 is not switched off';
  if (network.Options?.[GATEWAY_MODE] !== 'isolated') return 'the isolated gateway mode was not applied';
  const config = network.IPAM?.Config;
  if (!Array.isArray(config) || !config.length) return 'it has no address range';
  if (config.some((range) => range.Gateway)) return 'it has a gateway address, which reaches the host';
  return null;
}

/** The `docker run` arguments for a job's proxy. It starts on the default bridge and is then joined to the job's network. */
export function proxyRunArgs(opts: { image: string; jobId: string; toolsDir: string; allowedHosts: readonly string[]; user?: string }): string[] {
  for (const host of opts.allowedHosts) {
    if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error(`Invalid allowed host: ${JSON.stringify(host)}`);
  }
  return [
    'run', '-d', '--init', '--name', proxyName(opts.jobId), '--label', `neat.job=${opts.jobId}`, '--label', 'neat.job.role=proxy',
    '--network', 'bridge', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '256',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp',
    ...(opts.user ? ['--user', opts.user] : []),
    '-e', 'HOME=/tmp', '-e', `NEAT_ALLOWED_HOSTS=${opts.allowedHosts.join(',')}`,
    '-v', `${opts.toolsDir}:${JOB_TOOLS}:ro`, opts.image, 'bun', `${JOB_TOOLS}/proxy.js`,
  ];
}

/** The targets the proxy refused, read from its log. Capped, since the step chooses what it asks for. */
export function refusedTargets(proxyLog: string): string[] {
  const targets = new Set<string>();
  for (const line of proxyLog.split('\n')) {
    const match = /^refused (\S{1,300}) /.exec(line);
    if (match && targets.size < MAX_REFUSED) targets.add(match[1]!);
  }
  return [...targets];
}

/** What the docker client itself needs to find the daemon. Job variables are added on top of this, nothing else. */
function clientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && CLIENT_ENV.test(name)) env[name] = value;
  }
  return env;
}

async function docker(args: string[], what: string): Promise<string> {
  const out = await $`docker ${args}`.quiet().nothrow();
  if (out.exitCode !== 0) throw new Error(`${what}: ${out.stderr.toString().trim()}`);
  return out.stdout.toString().trim();
}

/** The end of the proxy's log, never more than a fixed size however much the step made the proxy write. */
async function proxyLog(proxy: string): Promise<string> {
  const proc = Bun.spawn(['docker', 'logs', '--tail', String(PROXY_LOG_LINES), proxy], { env: clientEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const [out] = await Promise.all([boundedText(proc.stdout, PROXY_LOG_BYTES), proc.exited]);
  return out.text;
}

/**
 * Create the job's closed network and start its proxy. The proxy is the only container on both that network and
 * the default bridge, so it is the only way out, and it refuses everything but the allowed hosts.
 */
async function startEgress(image: string, jobId: string, toolsDir: string, allowedHosts: readonly string[], user?: string): Promise<{ network: string; proxyUrl: string }> {
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'proxy-entry.ts')], target: 'bun', outdir: toolsDir, naming: 'proxy.js' });
  if (!build.success) throw new AggregateError(build.logs, 'Building the job proxy failed');
  const network = networkName(jobId);
  const proxy = proxyName(jobId);
  // An older engine may take the gateway option without acting on it, so ask the engine first and check after.
  const version = await docker(['version', '--format', '{{.Server.Version}}'], 'Could not read the Docker Engine version');
  if (!engineSupportsIsolation(version)) throw new Error(`Network steps need Docker Engine ${MIN_ENGINE_MAJOR} or newer to keep them off the host. This engine reports ${JSON.stringify(version.slice(0, 40))}.`);
  await docker(egressNetworkArgs(jobId), 'Could not create the job network');
  const problem = jobNetworkProblem(await docker(['network', 'inspect', network], 'Could not inspect the job network'));
  if (problem) throw new Error(`The job network is not closed, so the job will not run: ${problem}.`);
  await docker(proxyRunArgs({ image, jobId, toolsDir, allowedHosts, user }), 'Could not start the job proxy');
  await docker(['network', 'connect', network, proxy], 'Could not join the job proxy to the job network');
  const address = await docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, proxy], 'Could not read the job proxy address');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw new Error('The job proxy has no address on the job network.');
  for (let waited = 0; ; waited += 100) {
    if ((await proxyLog(proxy)).includes('listening')) break;
    if (waited >= 15_000) throw new Error('The job proxy did not start listening.');
    await Bun.sleep(100);
  }
  return { network, proxyUrl: `http://${address}:${PROXY_PORT}` };
}

async function runStep(opts: JobRunOptions, step: JobStep): Promise<JobStepResult> {
  const args = jobRunArgs(opts, step);
  const max = step.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const started = performance.now();
  const proc = Bun.spawn(['docker', ...args], { env: { ...clientEnv(), ...step.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Kill the container, then the client in case the container never got as far as starting.
    void $`docker kill ${opts.name}`.quiet().nothrow().then(() => proc.kill());
  }, step.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([boundedText(proc.stdout, max), boundedText(proc.stderr, max), proc.exited]);
    return {
      exitCode: timedOut ? null : exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
    await $`docker rm -f ${opts.name}`.quiet().nothrow();
  }
}

/**
 * Run a job's steps on local Docker. The containers, the job's network and proxy, and the working directory are
 * gone when this returns or throws.
 */
export async function runDockerJob(image: string, spec: JobSpec): Promise<JobResult> {
  const jobId = randomUUID().slice(0, 12);
  const dir = join(JOBS_HOME, jobId);
  const proxyTools = join(JOBS_HOME, `${jobId}-proxy`);
  const user = typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
  const wantsNetwork = spec.steps.some((step) => step.network);
  const steps: JobStepResult[] = [];
  try {
    await mkdir(dir, { recursive: true });
    if (spec.source) await copyWorkingCopy(spec.source, dir);
    const egress = wantsNetwork ? await startEgress(image, jobId, proxyTools, spec.allowedHosts ?? REGISTRY_HOSTS, user) : undefined;
    for (const [i, step] of spec.steps.entries()) {
      if (step.when === 'previous-failed' && !failed(steps.at(-1))) {
        steps.push({ exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 0, skipped: true });
        continue;
      }
      const result = await runStep({ image, name: `neat-job-${jobId}-${i}`, jobId, dir, tools: spec.tools, memory: spec.memory ?? '4g', cpus: spec.cpus ?? 2, user, egress }, step);
      steps.push(result);
      if (failed(result) && !step.optional) break;
    }
    const refused = egress ? refusedTargets(await proxyLog(proxyName(jobId))) : [];
    return { id: jobId, steps, refused };
  } finally {
    if (wantsNetwork) {
      // Both names are this job's own, so this never touches another job's proxy or network.
      await $`docker rm -f ${proxyName(jobId)}`.quiet().nothrow();
      await $`docker network rm ${networkName(jobId)}`.quiet().nothrow();
      await rm(proxyTools, { recursive: true, force: true });
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Remove every job container, job network and job directory on this machine, for example after the worker
 * restarts. Only things labelled neat.job are touched. Jobs still running in another process are removed too.
 */
export async function removeAllJobs(): Promise<void> {
  const containers = (await $`docker ps -aq --filter label=neat.job`.quiet().nothrow().text()).split('\n').filter(Boolean);
  if (containers.length) await $`docker rm -f ${containers}`.quiet().nothrow();
  const networks = (await $`docker network ls -q --filter label=neat.job`.quiet().nothrow().text()).split('\n').filter(Boolean);
  if (networks.length) await $`docker network rm ${networks}`.quiet().nothrow();
  await rm(JOBS_HOME, { recursive: true, force: true });
}
