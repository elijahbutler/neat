import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

/** Bundle only the client editor entry. The local worker serves the resulting assets. */
export async function buildShell() {
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, '../app/editor/standalone.tsx')], target: 'browser', format: 'esm', minify: true, define: { 'process.env.NODE_ENV': JSON.stringify('production') } });
  if (!build.success) throw new AggregateError(build.logs, 'Editor bundling failed');
  const script = build.outputs.find(file => file.path.endsWith('.js'));
  if (!script) throw new Error('Editor bundle is missing.');
  const cssFile = join(import.meta.dir, '../app/globals.css');
  const css = await postcss([tailwind()]).process(await readFile(cssFile, 'utf8'), { from: cssFile });
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Neat Labs editor</title><link rel="stylesheet" href="/editor.css"></head><body><div id="root"></div><script type="module" src="/editor.js"></script></body></html>';
  return new Map<string, { body: string | Blob; type: string }>([
    ['/', { body: html, type: 'text/html; charset=utf-8' }],
    ['/editor', { body: html, type: 'text/html; charset=utf-8' }],
    ['/editor.js', { body: script, type: 'text/javascript; charset=utf-8' }],
    ['/editor.css', { body: css.css, type: 'text/css; charset=utf-8' }],
  ]);
}
