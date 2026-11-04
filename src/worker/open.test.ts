import { expect, test } from 'bun:test';
import { parseOpenArgs, validateNextApp } from './open';
import { resolve } from 'node:path';
test('open defaults and explicit options', () => {
  expect(parseOpenArgs(['.'])).toEqual({ repo: resolve('.'), app: '.', port: 4317, docker: false });
  expect(parseOpenArgs(['.', '--app', 'apps/web', '--port', '4400'])).toEqual({ repo: resolve('.'), app: 'apps/web', port: 4400, docker: false });
  expect(parseOpenArgs(['.', '--docker']).docker).toBe(true);
});
test('invalid and missing arguments fail clearly', () => {
  for (const args of [[], ['.', '--unknown'], ['.', '--port'], ['.', '--port', 'no'], ['.', '--port', '3000.5'], ['.', '--app', '../outside'], ['.', '--app', '/tmp']]) expect(() => parseOpenArgs(args)).toThrow();
});
test('validates an actual App Router fixture', async () => {
  expect(await validateNextApp(resolve('fixtures/orbit-studio'))).toBe(resolve('fixtures/orbit-studio'));
});
