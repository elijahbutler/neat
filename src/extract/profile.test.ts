import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDesignSystem } from './profile';
import { formatProfileSummary } from './summary';

let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'neat-profile-'));
  await mkdir(join(root, 'components'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'bare', dependencies: { react: '19.0.0' } }));
  await writeFile(join(root, 'components', 'hello.tsx'), "import type { ReactNode } from 'react';\nexport function Hello({ children }: { children: ReactNode }) { return <p>{children}</p>; }\n");
  await writeFile(join(root, 'styles.css'), ':root { --background: #fff; }\n');
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('extractDesignSystem', () => {
  // Review focus 4: no node_modules must not throw.
  test('works without installed dependencies and says what is missing', () => {
    const profile = extractDesignSystem(root, { commit: 'abc123' });
    expect(profile.commit).toBe('abc123');
    expect(profile.uiLibraries).toEqual([]);
    expect(profile.components.map((c) => c.name)).toEqual(['Hello']);
    expect(profile.tokens.colors.bg?.value).toBe('#fff');
    expect(profile.warnings).toEqual([
      'No next dependency in package.json. V1 supports Next.js App Router only.',
      'No app/ directory found. V1 supports the App Router only.',
      'node_modules is missing, so types from libraries could not be resolved. Install dependencies first.',
    ]);
  });

  test('summarizes for the CLI', () => {
    const text = formatProfileSummary(extractDesignSystem(root));
    expect(text).toContain('bare');
    expect(text).toContain('1 components');
    expect(text).toContain('color.bg: --background');
  });
});
