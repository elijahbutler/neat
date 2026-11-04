import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextConfig } from 'next';

type Rules = NonNullable<NonNullable<NextConfig['turbopack']>['rules']>;
type RuleCollection = Rules[string];

export interface TaggingOptions {
  loaderPath: string;
  root: string;
}

export interface ConfigContext {
  defaultConfig: NextConfig;
}

export type NextConfigInput = NextConfig | ((phase: string, ctx: ConfigContext) => NextConfig | Promise<NextConfig>);

function isLoaderItem(item: unknown): boolean {
  return typeof item === 'string' || (typeof item === 'object' && item !== null && 'loader' in item);
}

function appendRule(existing: RuleCollection | undefined, rule: RuleCollection): RuleCollection {
  if (existing === undefined) return rule;
  if (!Array.isArray(existing)) return [existing, rule] as RuleCollection;
  // A list of loaders is shorthand for one rule; wrap it so both rules keep their meaning.
  const prior = existing.every(isLoaderItem) ? [{ loaders: existing }] : existing;
  return [...prior, rule] as RuleCollection;
}

/** The host the local sandbox serves previews on. See dockerProvider in src/sandbox/docker.ts. */
const PREVIEW_HOST = '127.0.0.1';

/** Adds the source-tagging loader to a resolved Next config. Development builds only. */
export function addTagging(config: NextConfig, { loaderPath, root }: TaggingOptions): NextConfig {
  let major = 16, minor = 0;
  try {
    const version: unknown = JSON.parse(readFileSync(createRequire(join(root, 'package.json')).resolve('next/package.json'), 'utf8')).version;
    if (typeof version === 'string') [major = 16, minor = 0] = version.split('.').map(Number);
  } catch { /* Unit callers may not have an installed Next package. */ }
  const modernTurbo = major > 15 || (major === 15 && minor >= 3);
  const loader = { loader: loaderPath, options: { root } };
  const rule = major >= 16
    ? { loaders: [loader], condition: { all: ['development' as const, { not: 'foreign' as const }] } }
    : { loaders: [loader] };
  const legacyTurbo = (config.experimental as { turbo?: { rules?: Rules } } | undefined)?.turbo;
  const rules: Rules = { ...(modernTurbo ? config.turbopack?.rules : legacyTurbo?.rules) };
  // create-next-app --js puts JSX in .js files. The loader returns files without JSX unchanged.
  for (const glob of ['*.tsx', '*.jsx', '*.js', '*.mjs', '*.cjs']) rules[glob] = appendRule(rules[glob], rule);

  const experimental = { ...config.experimental, turbo: { ...legacyTurbo, rules } };
  const userWebpack = config.webpack;
  return {
    ...config,
    // The preview is opened at 127.0.0.1. Next's dev server refuses its hot-reload socket to any host not listed
    // here, and then an edit doesn't show until the page is reloaded.
    allowedDevOrigins: [...new Set([...(config.allowedDevOrigins ?? []), PREVIEW_HOST])],
    ...(modernTurbo ? { turbopack: { ...config.turbopack, rules } }
      : { experimental }),
    webpack(webpackConfig, context) {
      const result = userWebpack ? userWebpack(webpackConfig, context) : webpackConfig;
      if (context.dev) {
        result.module.rules.push(
          { test: /\.(jsx?|tsx|mjs|cjs)$/, exclude: /node_modules/, enforce: 'pre', use: [loader] },
        );
      }
      return result;
    },
  };
}

export function withNeatTagging(input: NextConfigInput, opts: TaggingOptions) {
  return async (phase: string, ctx: ConfigContext): Promise<NextConfig> => {
    const config = typeof input === 'function' ? await input(phase, ctx) : input;
    return addTagging(config, opts);
  };
}
