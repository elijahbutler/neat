import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Project, ts } from 'ts-morph';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.neat', 'dist', 'out', 'coverage', '.turbo', '.vercel']);
const SOURCE = /\.(tsx?|jsx?|mts)$/;
// Config files and Next's instrumentation hooks (including the editor bridge in sandbox copies) aren't UI.
const CONFIG = /^((next|postcss|tailwind|eslint)\.config|instrumentation(-client)?)\./;

export function isProjectFile(path: string): boolean {
  return !path.split(/[\\/]/).includes('node_modules');
}

/** Project-relative path with forward slashes, or null outside the root / in node_modules. */
export function projectPath(root: string, file: string): string | null {
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !isProjectFile(rel)) return null;
  return rel.split(sep).join('/');
}

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(path);
      } else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts') && !CONFIG.test(entry.name)) {
        out.push(path);
      }
    }
  };
  visit(root);
  return out.sort();
}

/** Project-relative paths of stylesheets outside skipped directories. */
export function listCssFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(path);
      } else if (entry.name.endsWith('.css')) {
        out.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  visit(root);
  return out.sort();
}

/** A ts-morph project over the repo's own source files, using its tsconfig when present. */
export function loadProject(root: string): Project {
  const tsconfig = join(root, 'tsconfig.json');
  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, strict: true } });
  for (const file of listSourceFiles(root)) project.addSourceFileAtPath(file);
  return project;
}
