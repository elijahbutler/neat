import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parse } from '@babel/parser';
import MagicString from 'magic-string';
import { buildTaggingBundle, sandboxWrite, type TaggingBundle } from './bundle';

const CONFIG_FILES = ['next.config.ts', 'next.config.mts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'];
const ORIGINAL = '__neatOriginalConfig';

interface Statement {
  type: string;
  start: number;
  end: number;
  declaration?: { start: number };
  expression?: { type: string; start: number; left?: { type: string; object?: { name?: string }; property?: { name?: string } }; right?: { start: number } };
}

type InjectionOptions = TaggingBundle & { root: string; editorOrigin?: string };

function wrapper(kind: 'esm' | 'cjs', opts: InjectionOptions): string {
  // Next compiles TypeScript configs to CommonJS. Keep the absolute path in a variable so compiler aliases cannot rewrite it.
  const url = JSON.stringify(kind === 'cjs' ? opts.withTaggingCjsPath ?? opts.withTaggingPath : opts.withTaggingPath);
  const options = JSON.stringify({ loaderPath: opts.loaderPath, root: opts.root, editorOrigin: opts.editorOrigin });
  const body = `{\n  const neatTaggingPath = ${url};\n  const neatTaggingModule = await import(neatTaggingPath);\n  const { withNeatTagging } = neatTaggingModule.default ?? neatTaggingModule;\n  return withNeatTagging(${ORIGINAL}, ${options})(phase, context);\n}\n`;
  return kind === 'esm'
    ? `\nexport default async function neatTaggedConfig(phase, context) ${body}`
    : `\nmodule.exports = async function neatTaggedConfig(phase, context) ${body}`;
}

/**
 * Rewrites a next.config so its original export is wrapped by withNeatTagging.
 * Only used on a sandbox copy; the customer's repo never sees this change.
 */
export function rewriteNextConfig(source: string, fileName: string, opts: InjectionOptions): string {
  const typescript = /\.m?ts$/.test(fileName);
  const program = parse(source, { sourceType: 'module', plugins: typescript ? ['typescript'] : [] }).program;
  const body = program.body as unknown as Statement[];
  const s = new MagicString(source);
  if (typescript) s.prepend('// @ts-nocheck\n');

  const esm = body.find((n) => n.type === 'ExportDefaultDeclaration');
  if (esm?.declaration) {
    s.overwrite(esm.start, esm.declaration.start, `const ${ORIGINAL} = `);
    s.appendLeft(esm.end, ';');
    s.append(wrapper('esm', typescript && opts.withTaggingCjsPath ? { ...opts, withTaggingPath: opts.withTaggingCjsPath } : opts));
    return s.toString();
  }

  // The last assignment wins: plugin wizards often write `module.exports = withPlugin(module.exports)` after the first.
  const cjs = [...body].reverse().find(
    (n) =>
      n.type === 'ExpressionStatement' &&
      n.expression?.type === 'AssignmentExpression' &&
      n.expression.left?.type === 'MemberExpression' &&
      n.expression.left.object?.name === 'module' &&
      n.expression.left.property?.name === 'exports',
  );
  if (cjs?.expression?.right) {
    s.overwrite(cjs.expression.start, cjs.expression.right.start, `const ${ORIGINAL} = `);
    s.append(wrapper('cjs', opts));
    return s.toString();
  }

  throw new Error(`${fileName} has no default export or module.exports assignment`);
}

export { sandboxWriteTarget, sandboxWrite } from './bundle';

/** Resolve before copying Docker projects, which deliberately omit node_modules.
 * An installed version wins. Otherwise use the minimum version in a conventional
 * numeric dependency range, conservatively selecting legacy behavior for broad ranges.
 * Unknown ranges are rejected rather than silently assuming modern Next support.
 */
export async function resolveNextVersion(projectDir: string): Promise<string> {
  try {
    const path = createRequire(join(projectDir, 'package.json')).resolve('next/package.json');
    const version: unknown = JSON.parse(await readFile(path, 'utf8')).version;
    if (typeof version === 'string') return version;
  } catch { /* A Docker source need not have installed dependencies. */ }
  const pkg = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
  const range: unknown = pkg.dependencies?.next ?? pkg.devDependencies?.next;
  const match = typeof range === 'string' ? /^\s*[~^]?\s*(14|15|16)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?\s*$/.exec(range) : null;
  if (!match) throw new Error('Cannot determine Next version. Install Next in the source repository or specify a numeric Next 14, 15, or 16 dependency range.');
  return `${match[1]}.${Number(match[2]) || 0}.${Number(match[3]) || 0}`;
}

/** Rewrites the project's next.config (or creates one) to load the tagging loader. Returns the file name. */
export async function injectTagging(projectDir: string, bundle: TaggingBundle, editorOrigin?: string): Promise<string> {
  // Bundlers report real paths (/private/var/... on macOS), so the root must be the real path too.
  const opts = { ...bundle, root: await realpath(projectDir), editorOrigin };
  const existing = CONFIG_FILES.find((f) => existsSync(join(projectDir, f)));
  const file = existing ?? 'next.config.mjs';
  const source = existing ? await readFile(join(projectDir, existing), 'utf8') : 'export default {};\n';
  const originalPath = existing ? await realpath(join(projectDir, file)) : null;
  const configPath = join(opts.root, file);
  let rewritten: string;
  if (originalPath && originalPath !== configPath) {
    // Keep imports relative to the original module, including configs outside the repo.
    const cjs = file.endsWith('.cjs') || !parse(source, { sourceType: 'unambiguous', plugins: /\.m?ts$/.test(file) ? ['typescript'] : [] }).program.body.some(node => node.type === 'ExportDefaultDeclaration');
    rewritten = cjs
      ? `const ${ORIGINAL} = require(${JSON.stringify(originalPath)});` + wrapper('cjs', opts)
      : `import ${ORIGINAL} from ${JSON.stringify(originalPath)};` + wrapper('esm', opts);
  } else rewritten = rewriteNextConfig(source, file, opts);
  await sandboxWrite(projectDir, join(projectDir, file), rewritten);
  return file;
}

export const TAGGING_RUNTIME_PATHS = [
  '.neat/neat-tag-loader.cjs', '.neat/neat-tag-loader.mjs',
  '.neat/with-tagging.cjs', '.neat/with-tagging.mjs', '.neat/selection-bridge.js',
] as const;

export interface PreparedTagging {
  /** Includes modified tracked files. Git excludes alone cannot hide tracked changes. */
  injectedPaths: string[];
  configPath: string;
}

/** Prepare an isolated checkout. Call exactly once, after its base commit is recorded. */
export async function prepareTaggedProject(projectDir: string, bridge: string, nextVersion?: string, editorOrigin?: string): Promise<PreparedTagging> {
  const version = nextVersion ?? await resolveNextVersion(projectDir);
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const legacy = major < 15 || (major === 15 && minor < 3);
  const prefix = existsSync(join(projectDir, 'app')) ? '' : 'src/';
  const layouts: string[] = [];
  async function discover(path: string): Promise<void> {
    const layout = ['tsx', 'jsx', 'js', 'ts'].map(ext => `${path}/layout.${ext}`).find(file => existsSync(join(projectDir, file)));
    if (layout) { layouts.push(layout); return; }
    for (const entry of await readdir(join(projectDir, path), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('@') && !entry.name.startsWith('.')) await discover(`${path}/${entry.name}`);
    }
  }
  if (legacy) await discover(`${prefix}app`);
  if (legacy && !layouts.length) throw new Error('No App Router root layout found for the Next <15.3 bridge fallback');
  const bundle = await buildTaggingBundle(join(projectDir, '.neat'), legacy ? layouts : undefined, projectDir);
  const configPath = await injectTagging(projectDir, bundle, editorOrigin);
  const clientDir = existsSync(join(projectDir, 'app')) ? projectDir : join(projectDir, 'src');
  const client = ['ts', 'js', 'mjs'].map(ext => join(clientDir, `instrumentation-client.${ext}`)).find(existsSync)
    ?? join(clientDir, 'instrumentation-client.js');
  const bridgePath = join(projectDir, '.neat', 'selection-bridge.js');
  await sandboxWrite(projectDir, bridgePath, bridge);
  const importPath = relative(dirname(client), bridgePath).replaceAll('\\', '/');
  const previous = existsSync(client) ? await readFile(client, 'utf8') : '';
  // A dynamic import runs after the user's module body, unlike a hoisted static import.
  await sandboxWrite(projectDir, client, `${previous}\nvoid import(${JSON.stringify('./' + importPath)});\n`);
  const injectedPaths = ['.neat/', ...TAGGING_RUNTIME_PATHS, configPath, relative(projectDir, client)];
  // Next's default instrumentation discovery uses .ts and .js, so expose an .mjs module through a .js shim.
  if (client.endsWith('.mjs')) {
    const shim = join(clientDir, 'instrumentation-client.js');
    await sandboxWrite(projectDir, shim, `export * from './instrumentation-client.mjs';\nimport './instrumentation-client.mjs';\n`);
    injectedPaths.push(relative(projectDir, shim));
  }
  if (legacy) {
    const appDir = join(clientDir, 'app');
    const entry = join(appDir, 'neat-client.js');
    await sandboxWrite(projectDir, entry, `'use client';\nimport ${JSON.stringify('../' + (client.endsWith('.mjs') ? 'instrumentation-client.js' : client.split('/').at(-1)))};\n`);
    injectedPaths.push(relative(projectDir, entry));
  }
  return { configPath, injectedPaths };
}
