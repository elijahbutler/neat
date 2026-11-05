import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractDesignSystem } from '../extract/profile';
import { checkEdit, consumerFiles } from './check';
import { directEdit } from './direct';
import { buildRepoIndex, loadEditProject } from './index';
import type { FileChange } from './operations';

let temp = '';
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); temp = ''; });

const BADGE = `export const kind = 'a';
export function Badge({ children }: { children: string }) {
  return <span className="text-sm">{children}</span>;
}
`;
const CONSUMER = `import { Badge, kind } from '../components/Badge';
const current: 'a' = kind;
export default function Page() {
  return <main><Badge>{current}</Badge><Badge>two</Badge></main>;
}
`;
const OTHER = `import { Badge } from '../../components/Badge';
export default function Other() { return <p><Badge>x</Badge></p>; }
`;

async function load(files: Record<string, string>) {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'neat-shared-')));
  const all = { 'package.json': '{"name":"example","dependencies":{"next":"14.2.35"}}', ...files };
  for (const [file, text] of Object.entries(all)) {
    await mkdir(dirname(join(temp, file)), { recursive: true });
    await writeFile(join(temp, file), text);
  }
  const project = loadEditProject(temp);
  return { project, index: buildRepoIndex(extractDesignSystem(temp, { project }), project, temp) };
}

test('consumers come from the current render graph and leave out the edited file', async () => {
  const { index } = await load({ 'components/Badge.tsx': BADGE, 'app/page.tsx': CONSUMER, 'app/other/page.tsx': OTHER });
  expect(consumerFiles(index, ['components/Badge.tsx'])).toEqual(['app/other/page.tsx', 'app/page.tsx']);
  expect(consumerFiles(index, ['app/page.tsx'])).toEqual([]);
});

test('an edit that breaks a consumer fails the check, and the project is restored', async () => {
  const { project, index } = await load({ 'components/Badge.tsx': BADGE, 'app/page.tsx': CONSUMER, 'app/other/page.tsx': OTHER });
  const change: FileChange = { file: 'components/Badge.tsx', before: BADGE, after: BADGE.replace("= 'a'", "= 'b'") };
  const result = checkEdit(project, temp, index, [change]);
  expect(result.ok).toBe(false);
  expect(result.errors.map((e) => [e.check, e.file, e.line])).toEqual([['typecheck', 'app/page.tsx', 2]]);
  expect(project.getSourceFileOrThrow(join(temp, 'components/Badge.tsx')).getFullText()).toBe(BADGE);
  const harmless: FileChange = { file: 'components/Badge.tsx', before: BADGE, after: BADGE.replace('text-sm', 'text-lg') };
  expect(checkEdit(project, temp, index, [harmless]).ok).toBe(true);
});

test('a consumer that already had an error is not blamed for it', async () => {
  const { project, index } = await load({ 'components/Badge.tsx': BADGE, 'app/page.tsx': `${CONSUMER}const broken: number = 'x';\n` });
  const harmless: FileChange = { file: 'components/Badge.tsx', before: BADGE, after: BADGE.replace('text-sm', 'text-lg') };
  expect(checkEdit(project, temp, index, [harmless]).ok).toBe(true);
});

test('a selection inside a shared definition needs confirmation; a single-use definition does not', async () => {
  const { project, index } = await load({ 'components/Badge.tsx': BADGE, 'app/page.tsx': CONSUMER, 'app/other/page.tsx': OTHER, 'components/Solo.tsx': 'export function Solo() { return <em className="italic">x</em>; }\n' });
  const span = 'components/Badge.tsx:3:10';
  const shared = directEdit(project, temp, index, { tag: span, operations: [{ op: 'replace-class', target: span, from: 'text-sm', to: 'text-lg' }] });
  expect(shared.ok).toBe(false);
  if (shared.ok) throw new Error('unreachable');
  expect(shared.confirm.map((c) => [c.component, c.uses])).toEqual([['Badge', 3]]);
  expect(shared.confirmable?.operations).toHaveLength(1);

  const allowed = directEdit(project, temp, index, { tag: span, operations: [{ op: 'replace-class', target: span, from: 'text-sm', to: 'text-lg' }], allow: [shared.confirm[0]!.allow] });
  expect(allowed.ok).toBe(true);

  const em = 'components/Solo.tsx:1:33';
  const solo = directEdit(project, temp, index, { tag: em, operations: [{ op: 'replace-class', target: em, from: 'italic', to: 'not-italic' }] });
  expect(solo.ok).toBe(true);
});

test('a definition rendered once by a repeated wrapper still needs confirmation', async () => {
  const badge = 'export function Badge() { return <span className="text-sm">Badge</span>; }\n';
  const { project, index } = await load({
    'components/Badge.tsx': badge,
    'components/Wrapper.tsx': "import { Badge } from './Badge'; export function Wrapper() { return <div><Badge /></div>; }\n",
    'app/page.tsx': "import { Wrapper } from '../components/Wrapper'; export default function Page() { return <main><Wrapper /><Wrapper /></main>; }\n",
  });
  const tag = 'components/Badge.tsx:1:34';
  const result = directEdit(project, temp, index, { tag, operations: [{ op: 'replace-class', target: tag, from: 'text-sm', to: 'text-lg' }] });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected confirmation');
  expect(result.confirm.map(c => c.component)).toEqual(['Badge']);
});
