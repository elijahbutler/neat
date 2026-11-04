import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, realpath, rename, rm, unlink } from 'node:fs/promises';


export interface TaggingBundle {
  loaderPath: string;
  withTaggingPath: string;
  loaderEsmPath?: string;
  withTaggingCjsPath?: string;
}

/** Produce standalone Node bundles, without relying on the host app's module type. */
export async function buildTaggingBundle(outDir: string, legacyLayout?: string | string[], rootDir?: string): Promise<Required<TaggingBundle>> {
  for (const format of ['cjs', 'esm'] as const) {
    const ext = format === 'cjs' ? 'cjs' : 'mjs';
    for (const [entry, name] of [['loader.ts', 'neat-tag-loader'], ['with-tagging.ts', 'with-tagging']] as const) {
      const result = await Bun.build({ entrypoints: [join(import.meta.dir, entry)], target: 'node', format,
        define: { NEAT_LEGACY_LAYOUT: JSON.stringify(typeof legacyLayout === 'string' ? [legacyLayout] : legacyLayout ?? []) }, naming: `${name}.${ext}`, external: ['next'] });
      if (!result.success) throw new AggregateError(result.logs, 'Building the tagging bundle failed');
      await mkdir(rootDir ?? outDir, { recursive: true });
      for (const output of result.outputs) await sandboxWrite(rootDir ?? outDir, join(outDir, `${name}.${ext}`), await output.text());
    }
  }
  return { loaderPath: join(outDir, 'neat-tag-loader.cjs'), loaderEsmPath: join(outDir, 'neat-tag-loader.mjs'),
    withTaggingPath: join(outDir, 'with-tagging.mjs'), withTaggingCjsPath: join(outDir, 'with-tagging.cjs') };
}

/** Materialize readable symlinks before writing, including symlinked parent directories.
 * Never write through a link into the source checkout. Call before every generated write.
 */
export async function sandboxWriteTarget(rootDir: string, target: string): Promise<string> {
  const root = await realpath(rootDir);
  const rel = relative(resolve(rootDir), resolve(target));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Unsafe sandbox write: ${target}`);
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    try {
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info?.isSymbolicLink()) {
        const source = await realpath(current);
        const temp = await mkdtemp(join(dirname(current), '.neat-materialize-'));
        try {
          await cp(source, join(temp, 'content'), { recursive: true, verbatimSymlinks: true });
          await unlink(current);
          await rename(join(temp, 'content'), current);
        } finally { await rm(temp, { recursive: true, force: true }); }
      } else if (!info) {
        // Missing parents are created only after all their ancestors have been checked.
        if (current !== join(root, rel)) await mkdir(current);
      }
      const actual = await realpath(current).catch(() => current);
      const inside = relative(root, actual);
      if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Path escapes sandbox');
    } catch (cause) { throw new Error(`Cannot safely write sandbox file ${target}`, { cause }); }
  }
  return join(root, rel);
}


/** Replace the destination itself. Never open it for a write, even if it becomes a symlink. */
export async function sandboxWrite(rootDir: string, target: string, contents: string): Promise<void> {
  const path = await sandboxWriteTarget(rootDir, target);
  const parent = dirname(path);
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const identity = await directory.stat();
  // Linux directory descriptors keep all writes pinned even if an ancestor is renamed.
  const base = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : parent;
  const temp = join(base, `.neat-write-${crypto.randomUUID()}`);
  try {
    const checked = await lstat(parent);
    if (await realpath(parent) !== parent || checked.ino !== identity.ino || checked.dev !== identity.dev) throw new Error('Sandbox parent directory changed');
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(contents); } finally { await file.close(); }
    const current = await realpath(parent);
    const currentInfo = await lstat(parent);
    if (current !== parent || currentInfo.ino !== identity.ino || currentInfo.dev !== identity.dev) throw new Error('Sandbox parent directory changed');
    await rename(temp, join(base, path.split('/').at(-1)!));
  } finally {
    try { await rm(temp, { force: true }); } finally { await directory.close(); }
  }
}
