import { $ } from 'bun';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesignSystemProfile } from '../extract/types';
import type { JobStep, JobStepResult, SandboxProvider } from './docker';
import { failed, JOB_TOOLS, JOB_WORKDIR } from './job';

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

/** A checkout on this machine, or a commit to fetch. The token is only ever used for the fetch. */
export type RepoSource = { path: string; sha?: string } | { url: string; sha: string; token?: string };

export interface ExtractJobResult {
  /** The profile, with `commit` set to the requested sha (null for a local path with no sha). */
  profile: DesignSystemProfile;
  /** Null when the repo has no lockfile, in which case nothing was installed. */
  manager: PackageManager | null;
  /**
   * False when the profile was extracted from the repo's own files only: no lockfile, or the install failed or
   * timed out and what it left was removed. The profile's last warning then says which.
   */
  dependenciesInstalled: boolean;
  install: JobStepResult | null;
  extract: JobStepResult;
  /** The job that ran it, for logs. */
  jobId: string;
  /** Hosts the install asked for that are not on the allowlist. A likely reason when install failed. */
  refused: string[];
}

export interface ExtractJobOptions {
  installTimeoutMs?: number;
  extractTimeoutMs?: number;
  memory?: string;
  cpus?: number;
}

const SHA = /^[0-9a-f]{40}$/;
const PROFILE_BYTES = 64 * 1024 * 1024;
// First match wins when a repo has more than one lockfile.
const LOCKFILES: [string, PackageManager][] = [
  ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'],
];

/** The package manager a repo uses, judged by the lockfile among the file names in its root. */
export function detectPackageManager(rootFiles: string[]): PackageManager | null {
  const names = new Set(rootFiles);
  return LOCKFILES.find(([file]) => names.has(file))?.[1] ?? null;
}

/**
 * The install command for a manager, pinned to the lockfile and with lifecycle scripts off. Yarn 2 and later
 * (marked by .yarnrc.yml) has different flags from Yarn 1. pnpm and modern Yarn come from corepack.
 *
 * The flags close the common ways a repo runs its own code during install. They do not close all of them: a
 * packageManager URL for corepack, Yarn plugins and manager config files remain. So install is treated as running
 * the repo's code, and what contains it is the job's network and limits, not these flags.
 */
export function installCommand(manager: PackageManager, rootFiles: string[] = []): string[] {
  switch (manager) {
    case 'bun': return ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'];
    case 'pnpm': return ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'];
    case 'npm': return ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
    case 'yarn':
      return rootFiles.includes('.yarnrc.yml')
        ? ['corepack', 'yarn', 'install', '--immutable', '--mode=skip-build']
        : ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'];
  }
}

/** The install step: registry access only, scripts off by flag and by variable, and no other variables. */
export function installStep(manager: PackageManager, rootFiles: string[], timeoutMs: number): JobStep {
  return {
    command: installCommand(manager, rootFiles),
    env: {
      CI: '1',
      npm_config_ignore_scripts: 'true',
      YARN_ENABLE_SCRIPTS: 'false',
      YARN_IGNORE_PATH: '1',
      // Yarn 2 and later defaults to Plug'n'Play, which writes no node_modules for extraction to read types from.
      YARN_NODE_LINKER: 'node-modules',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    },
    network: true,
    timeoutMs,
    // Extraction still runs when this fails; REMOVE_PARTIAL_INSTALL and the profile's warnings cover that case.
    optional: true,
  };
}

/**
 * Runs only after a failed or timed-out install: remove every node_modules it left, at any depth. A half
 * installed tree would give extraction some library types and not others with nothing to show for it, so the
 * profile is taken from the repo's own files instead and says so.
 */
export const REMOVE_PARTIAL_INSTALL: JobStep = {
  command: ['find', '.', '-name', 'node_modules', '-prune', '-exec', 'rm', '-rf', '{}', '+'],
  when: 'previous-failed',
  timeoutMs: 120_000,
};

/**
 * The warning for a profile extracted without dependencies, or null when they were installed. It gives the
 * exit code or the timeout and nothing from the install's own output, which the repo controls.
 */
export function missingDependencies(manager: PackageManager | null, install: JobStepResult | null): string | null {
  const effect = 'so types from libraries could not be resolved';
  if (!manager) return `Dependencies were not installed because the repo has no lockfile, ${effect}.`;
  if (!install) return `Dependencies were not installed because the ${manager} install did not run, ${effect}.`;
  if (install.timedOut) return `Dependencies were not installed because the ${manager} install timed out, ${effect}.`;
  if (install.exitCode !== 0) return `Dependencies were not installed because the ${manager} install failed with exit code ${install.exitCode ?? 'unknown'}, ${effect}.`;
  return null;
}

/** The extraction step: no network, no variables, profile on stdout. */
export function extractStep(sha: string | null, timeoutMs: number): JobStep {
  return { command: ['bun', `${JOB_TOOLS}/extract.js`, JOB_WORKDIR, ...(sha ? [sha] : [])], timeoutMs, maxOutputBytes: PROFILE_BYTES };
}

/** Replace every occurrence of each secret, and any user:password part of a URL, so text is safe to log. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.replaceAll(secret, '[redacted]');
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[redacted]@');
}

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

/**
 * Fetch one commit into `dir`, shallow, and leave only its files. The token travels as a request header set
 * through git's environment, so it is not in the command line, the URL, or .git/config, and .git is removed at
 * the end anyway. The worker's own git config and credential helpers are switched off for the fetch.
 */
export async function fetchCommit(url: string, sha: string, dir: string, token?: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error('The commit must be a full 40 character sha.');
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new Error('Pass the token separately, not inside the repository URL.');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    // Scoped to the repository's host, so a redirect elsewhere doesn't carry the header.
    env.GIT_CONFIG_KEY_0 = `http.${parsed.origin}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basicAuth(token)}`;
  }
  const git = async (args: string[]) => {
    const out = await $`git ${args}`.cwd(dir).env(env).quiet().nothrow();
    if (out.exitCode === 0) return;
    const detail = redact(out.stderr.toString().trim(), token ? [token, basicAuth(token)] : []);
    throw new Error(`git ${args[0]} failed for ${redact(url, [token])} at ${sha}: ${detail}`);
  };
  await git(['init', '-q']);
  await git(['fetch', '-q', '--depth', '1', '--no-tags', '--no-recurse-submodules', url, sha]);
  await git(['checkout', '-q', '--detach', 'FETCH_HEAD']);
  await rm(join(dir, '.git'), { recursive: true, force: true });
}

/** Bundle the extraction entry into one file a job container can run with nothing else installed. */
async function buildExtractTool(outDir: string): Promise<void> {
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'extract-entry.ts')], target: 'bun', outdir: outDir, naming: 'extract.js' });
  if (!build.success) throw new AggregateError(build.logs, 'Building the extraction bundle failed');
}

/** Check that job output is a profile before trusting its shape. Its content is still the repo's own data. */
function parseProfile(stdout: string): DesignSystemProfile {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('The extraction job did not print a JSON profile.');
  }
  const profile = value as Partial<DesignSystemProfile> | null;
  if (!profile || profile.schemaVersion !== 1 || !Array.isArray(profile.components) || !Array.isArray(profile.warnings) || !profile.tokens || !profile.usage) {
    throw new Error('The extraction job printed JSON that is not a version 1 profile.');
  }
  return profile as DesignSystemProfile;
}

/**
 * Install a repo's dependencies and extract its design system profile, all inside job containers. Install can
 * reach the package registries and nothing else; extraction has no network. Neither step sees the token or any
 * worker variable.
 */
export async function runExtractJob(provider: SandboxProvider, source: RepoSource, opts: ExtractJobOptions = {}): Promise<ExtractJobResult> {
  const scratch = await mkdtemp(join(tmpdir(), 'neat-extract-'));
  try {
    const tools = join(scratch, 'tools');
    await buildExtractTool(tools);
    let repo: string;
    if ('url' in source) {
      if (!source.url.startsWith('https://')) throw new Error('Only https repository URLs are supported.');
      repo = join(scratch, 'repo');
      await mkdir(repo);
      await fetchCommit(source.url, source.sha, repo, source.token);
    } else {
      if (source.sha && !SHA.test(source.sha)) throw new Error('The commit must be a full 40 character sha.');
      repo = await realpath(source.path);
    }
    const sha = source.sha ?? null;
    const rootFiles = readdirSync(repo);
    const manager = detectPackageManager(rootFiles);
    const steps = [...(manager ? [installStep(manager, rootFiles, opts.installTimeoutMs ?? 300_000), REMOVE_PARTIAL_INSTALL] : []), extractStep(sha, opts.extractTimeoutMs ?? 300_000)];
    const job = await provider.runJob({ source: repo, tools, steps, memory: opts.memory, cpus: opts.cpus });
    const install = manager ? (job.steps[0] ?? null) : null;
    if (manager && failed(job.steps[1])) throw new Error('A failed install could not be cleaned up, so extraction did not run.');
    const extract = job.steps[manager ? 2 : 0];
    if (!extract) throw new Error('The extraction step did not run.');
    if (extract.timedOut) throw new Error('Extraction timed out.');
    if (extract.exitCode !== 0) throw new Error(`Extraction failed with exit code ${extract.exitCode}: ${extract.stderr.slice(-2000)}`);
    if (extract.truncated) throw new Error('The profile is larger than the job output limit.');
    const profile = parseProfile(extract.stdout);
    const missing = missingDependencies(manager, install);
    // The sha comes from the caller, not from what the container printed. The raw stdout is dropped because it is the profile.
    return {
      profile: { ...profile, commit: sha, warnings: missing ? [...profile.warnings, missing] : profile.warnings },
      dependenciesInstalled: !missing,
      manager,
      install,
      extract: { ...extract, stdout: '' },
      jobId: job.id,
      refused: job.refused,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** True when Docker answers and the sandbox image exists, so callers and tests can skip cleanly otherwise. */
export async function dockerJobsAvailable(image: string): Promise<boolean> {
  return (await $`docker image inspect ${image}`.quiet().nothrow()).exitCode === 0;
}
