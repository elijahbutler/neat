import { describe, expect, test } from 'bun:test';
import { parse } from '@babel/parser';
import { INST_ATTR, SRC_ATTR, tagSource } from './tag-source';

const FILE = 'app/page.tsx';

describe('tagSource', () => {
  test('tags host elements with their file, line, and column', () => {
    const src = 'export default function Page() {\n  return <main className="p-4">\n    <h1>Hi</h1>\n  </main>;\n}\n';
    const { code, tagged } = tagSource(src, FILE);
    expect(tagged).toBe(2);
    expect(code).toContain(`<main ${SRC_ATTR}={"app/page.tsx:2:10"} className="p-4">`);
    expect(code).toContain(`<h1 ${SRC_ATTR}={"app/page.tsx:3:5"}>`);
  });

  test('tags component elements with the instance attribute', () => {
    const { code } = tagSource('const a = <Button variant="ghost" />;', FILE);
    expect(code).toBe(`const a = <Button ${INST_ATTR}={"app/page.tsx:1:11"} variant="ghost" />;`);
  });

  test('treats member expressions as components', () => {
    const { code } = tagSource('const a = <motion.div />;', FILE);
    expect(code).toContain(`<motion.div ${INST_ATTR}=`);
  });

  test('skips fragments', () => {
    const src = 'const a = <><Fragment><React.Fragment><p /></React.Fragment></Fragment></>;';
    const { code, tagged } = tagSource(src, FILE);
    expect(tagged).toBe(1);
    expect(code).toContain('<Fragment>');
    expect(code).toContain('<React.Fragment>');
  });

  test('inserts after type arguments', () => {
    const { code } = tagSource('const a = <Select<string> value="x" />;', FILE);
    expect(code).toContain(`<Select<string> ${INST_ATTR}=`);
  });

  test('is idempotent', () => {
    const once = tagSource('const a = <div><Button /></div>;', FILE).code;
    const twice = tagSource(once, FILE);
    expect(twice.tagged).toBe(0);
    expect(twice.code).toBe(once);
  });

  test('keeps line numbers and produces valid TSX', () => {
    const src = 'type P = { a: string };\nexport function C({ a }: P) {\n  return (\n    <section>\n      <span>{a}</span>\n    </section>\n  );\n}\n';
    const { code } = tagSource(src, FILE);
    expect(code.split('\n').length).toBe(src.split('\n').length);
    expect(() => parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })).not.toThrow();
  });

  test('returns a source map when it tags', () => {
    const { map } = tagSource('const a = <div />;', FILE);
    expect(map?.sources).toEqual([FILE]);
  });

  // Review focus 1: a half-typed edit must not crash the dev server.
  test('returns syntax errors unchanged', () => {
    const src = 'export default function Page() { return <div className="a"> }';
    expect(tagSource(src, FILE)).toEqual({ code: src, tagged: 0, map: null });
  });

  test('tags JSX in .js files', () => {
    const { code } = tagSource('export default function Page() { return <main />; }', 'app/page.js');
    expect(code).toContain('data-nl-src={"app/page.js:1:41"}');
  });

  test('leaves files without JSX unchanged', () => {
    const src = 'export const n: number = 1;\n';
    expect(tagSource(src, FILE)).toEqual({ code: src, tagged: 0, map: null });
  });

  test('escapes unusual path characters', () => {
    const { code } = tagSource('const a = <div />;', 'app/"odd"/page.tsx');
    expect(code).toContain(`${SRC_ATTR}={"app/\\"odd\\"/page.tsx:1:11"}`);
  });
});
