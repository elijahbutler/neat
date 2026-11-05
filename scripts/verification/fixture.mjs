import { cp, lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repository } from './options.mjs';

const execute = promisify(execFile);
export const originalHeading = 'A page for browser acceptance';
export const editedHeading = 'A kept browser edit';
export const sharedFile = 'components/AcceptanceBadge.tsx';
export const sharedSource = 'export function AcceptanceBadge() {\n  return <h2 className="text-lg">Shared acceptance label</h2>;\n}\n';

export function gitEnvironment(env = process.env) {
  const clean = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LANG', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) if (env[key]) clean[key] = env[key];
  return { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
}

export async function git(cwd, ...args) {
  return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd, env: gitEnvironment(), maxBuffer: 16 * 1024 * 1024,
  })).stdout.trim();
}

export async function checkoutDiff() {
  let patch = await git(repository, 'diff', '--binary', 'HEAD');
  const newFiles = (await git(repository, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  for (const file of newFiles) {
    const result = await execute('git', ['diff', '--no-index', '--binary', '--', '/dev/null', file], { cwd: repository, env: gitEnvironment(), maxBuffer: 16 * 1024 * 1024 }).catch(error => {
      if (error.code === 1) return { stdout: error.stdout };
      throw error;
    });
    patch += '\n' + result.stdout;
  }
  return patch + '\n';
}

export async function snapshot(repo) {
  const index = await git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  const untracked = {};
  for (const file of (await git(repo, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean).sort()) {
    const target = join(repo, file);
    const info = await lstat(target);
    const bytes = info.isSymbolicLink() ? await readlink(target) : await readFile(target);
    untracked[file] = createHash('sha256').update(bytes).digest('hex');
  }
  return {
    head: await git(repo, 'rev-parse', 'HEAD'),
    branch: await git(repo, 'symbolic-ref', '--short', 'HEAD'),
    status: await git(repo, 'status', '--porcelain=v1', '--untracked-files=all'),
    index: createHash('sha256').update(await readFile(index)).digest('hex'),
    untracked,
    staged: await git(repo, 'diff', '--cached', '--binary'),
    working: await git(repo, 'diff', '--binary'),
  };
}

export async function prepareFixture(root) {
  const repo = join(root, 'fixture');
  const prefix = 'fixtures/orbit-studio/';
  await mkdir(repo);
  const files = (await git(repository, 'ls-files', prefix)).split('\n').filter(Boolean);
  for (const file of files) {
    const target = join(repo, file.slice(prefix.length));
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repository, file), target);
  }
  const dependencies = join(repository, prefix, 'node_modules');
  await readFile(join(dependencies, 'next/package.json')).catch(() => { throw new Error('Prepare fixture dependencies with bun run fixtures:install'); });
  // Copy files, including package-manager links within node_modules. Never link the
  // fixture root to dependencies outside the Next.js filesystem root.
  if (process.platform === 'linux') {
    await execute('cp', ['-a', '--reflink=auto', '--', dependencies, join(repo, 'node_modules')]);
  } else await cp(dependencies, join(repo, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: 2 });
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n.next/\nnext-env.d.ts\n*.tsbuildinfo\n');
  await writeFile(join(repo, 'app/page.tsx'), `import { AcceptanceBadge } from '@/components/AcceptanceBadge';
export default function Page() {
  return <main className="p-6">
    <h1 className="acceptance-heading text-3xl">${originalHeading}</h1>
    <p>Hover here while the heading stays selected.</p>
    <AcceptanceBadge />
  </main>;
}
`);
  await writeFile(join(repo, sharedFile), sharedSource);
  await writeFile(join(repo, 'app/about/page.tsx'), "import { AcceptanceBadge } from '@/components/AcceptanceBadge';\nexport default function About() { return <main><AcceptanceBadge /></main>; }\n");
  await writeFile(join(repo, 'app/globals.css'), (await readFile(join(repo, 'app/globals.css'), 'utf8')) + '\n.acceptance-heading { padding: 17px; }\n');
  await git(repo, 'init', '-b', 'acceptance-input');
  await git(repo, 'config', 'user.name', 'Browser acceptance');
  await git(repo, 'config', 'user.email', 'acceptance@example.test');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'Create browser acceptance fixture');
  // Deliberate staged, unstaged, and untracked input must survive the whole run.
  await writeFile(join(repo, 'input-state.txt'), 'staged input\n');
  await git(repo, 'add', 'input-state.txt');
  await writeFile(join(repo, 'input-state.txt'), 'unstaged input\n');
  await writeFile(join(repo, 'untracked-input.txt'), 'untracked input\n');
  return repo;
}

export function sharedTag() {
  const offset = sharedSource.indexOf('<h2');
  const lines = sharedSource.slice(0, offset).split('\n');
  return `${sharedFile}:${lines.length}:${lines.at(-1).length + 1}`;
}
