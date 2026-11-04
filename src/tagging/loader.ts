import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { tagSource } from './tag-source';

export interface TagLoaderOptions {
  /** Absolute project root. Tags use paths relative to it. */
  root: string;
}

/** The subset of the webpack loader API that Turbopack and webpack both provide. */
export interface LoaderContext {
  resourcePath: string;
  getOptions(): TagLoaderOptions;
  callback(error: Error | null, content?: string, sourceMap?: unknown): void;
}

/** Project-relative path with forward slashes, or null for files we must not tag. */
export function toProjectPath(root: string, file: string): string | null {
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts.includes('node_modules')) return null;
  return parts.join('/');
}

const realRoots = new Map<string, string>();

/** Bundlers pass real file paths, so compare against the root's real path (symlinked tmp dirs on macOS). */
function realRoot(root: string): string {
  let real = realRoots.get(root);
  if (real === undefined) {
    try {
      real = realpathSync(root);
    } catch {
      real = root;
    }
    realRoots.set(root, real);
  }
  return real;
}

export default function neatTagLoader(this: LoaderContext, source: string, inputMap?: unknown): void {
  const path = toProjectPath(realRoot(this.getOptions().root), this.resourcePath);
  if (!path) {
    this.callback(null, source, inputMap);
    return;
  }
  const { code, map } = tagSource(source, path);
  this.callback(null, code, map ?? inputMap);
}
