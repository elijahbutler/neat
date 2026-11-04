import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTags, findTagForText, listStaticRoutes, parseTagLocation } from './coverage';

const files: Record<string, string[]> = {
  'app/page.tsx': ['export default function P() {', '  return <main>', '    <h1>Hello</h1>', '    <Card />', '  </main>;', '}'],
};
const read = (file: string, line: number) => files[file]?.[line - 1];

describe('parseTagLocation', () => {
  test('splits path, line, and column', () => {
    expect(parseTagLocation('app/a:b/page.tsx:12:5')).toEqual({ file: 'app/a:b/page.tsx', line: 12, column: 5 });
    expect(parseTagLocation('nonsense')).toBeNull();
  });
});

describe('checkTags', () => {
  test('counts direct, inherited, and invalid tags', () => {
    const html = `<html><body data-nl-src="app/layout.tsx:1:1">
      <main data-nl-src="app/page.tsx:2:10">
        <h1 data-nl-src="app/page.tsx:3:5">Hello</h1>
        <p data-nl-src="app/page.tsx:3:5">wrong line</p>
        <a href="/">from a library</a>
        <div data-nl-inst="app/page.tsx:4:5" data-nl-src="components/card.tsx:1:1"></div>
      </main>
      <script>ignored()</script>
    </body></html>`;
    const report = checkTags(html, read);
    expect(report.elements).toBe(5);
    expect(report.direct).toBe(4);
    expect(report.inherited).toBe(1);
    expect(report.inheritedByTag).toEqual({ a: 1 });
    expect(report.untagged).toBe(0);
    expect(report.invalidSrc).toEqual(['p -> app/page.tsx:3:5', 'div -> components/card.tsx:1:1']);
    expect(report.instances).toBe(1);
    expect(report.invalidInst).toEqual([]);
  });

  test('reports elements with no tagged ancestor', () => {
    const report = checkTags('<html><body><div><span>x</span></div></body></html>', read);
    expect(report.untagged).toBe(2);
  });
});

describe('findTagForText', () => {
  test('returns the nearest tag for the element holding the text', () => {
    const html = '<body data-nl-src="l:1:1"><main data-nl-src="p:2:3"><h1 data-nl-src="p:9:5">Hello there</h1></main></body>';
    expect(findTagForText(html, 'Hello')).toBe('p:9:5');
    expect(findTagForText(html, 'absent')).toBeUndefined();
  });
});

describe('listStaticRoutes', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'neat-routes-'));
    for (const path of ['page.tsx', 'about/page.tsx', '(marketing)/pricing/page.tsx', 'work/[slug]/page.tsx', '_private/page.tsx', '@modal/page.tsx', 'api/route.ts']) {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await writeFile(join(dir, path), '');
    }
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test('skips dynamic, private, parallel, and non-page files', async () => {
    expect(await listStaticRoutes(dir)).toEqual(['/', '/about', '/pricing']);
  });
});
