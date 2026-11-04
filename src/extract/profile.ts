import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Project } from 'ts-morph';
import { extractComponents } from './components';
import { buildFacts } from './facts';
import { listCssFiles, loadProject } from './project';
import { findToken, hexColors, parseArbitrary } from './token-match';
import { extractTokens } from './tokens';
import type { DesignSystemProfile, TokenBypass, TokenProfile } from './types';
import { extractUsage } from './usage';

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// Libraries the edit agent should reuse when a repo already has them. Extend as the agent learns more.
const UI_LIBRARIES = [
  '@dnd-kit/core', '@radix-ui/react-dialog', '@tanstack/react-table', 'class-variance-authority', 'clsx', 'cmdk',
  'date-fns', 'framer-motion', 'lucide-react', 'motion', 'recharts', 'sonner', 'tailwind-merge',
];

function readPackage(root: string): PackageJson {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return {};
  }
}

/** Note on each bypass the token it duplicates, so the agent can say "use --main-color here". */
function linkBypasses(bypasses: TokenBypass[], tokens: TokenProfile): void {
  for (const bypass of bypasses) {
    const parsed = bypass.kind === 'arbitrary-class' ? parseArbitrary(bypass.value) : null;
    const candidates = parsed ? [findToken(tokens, parsed.value, parsed.family)] : hexColors(bypass.value).map((hex) => findToken(tokens, hex, 'color'));
    const token = candidates.find((t) => t !== null);
    if (token) bypass.token = token.name;
  }
}

/** Reads a repo at its current state and returns its design system profile. */
export function extractDesignSystem(root: string, opts: { commit?: string | null; project?: Project } = {}): DesignSystemProfile {
  const pkg = readPackage(root);
  const dep = (name: string) => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;

  const warnings: string[] = [];
  if (!dep('next')) warnings.push('No next dependency in package.json. V1 supports Next.js App Router only.');
  if (!existsSync(join(root, 'app')) && !existsSync(join(root, 'src', 'app'))) warnings.push('No app/ directory found. V1 supports the App Router only.');
  if (!existsSync(join(root, 'node_modules'))) warnings.push('node_modules is missing, so types from libraries could not be resolved. Install dependencies first.');

  // Pass the edit pipeline's project to avoid loading the repo twice, which doubles memory on real repos.
  const project = opts.project ?? loadProject(root);
  const components = extractComponents(project, root);
  const usage = extractUsage(project, root, components);
  const tokens = extractTokens(root, listCssFiles(root));
  linkBypasses(usage.bypasses, tokens);
  return {
    schemaVersion: 1,
    project: pkg.name ?? basename(root),
    commit: opts.commit ?? null,
    framework: { next: dep('next'), react: dep('react'), tailwind: dep('tailwindcss') },
    uiLibraries: UI_LIBRARIES.filter((name) => dep(name) !== null),
    components,
    tokens,
    usage,
    facts: buildFacts(components, usage),
    warnings,
  };
}
