/** Manual local acceptance check: bun src/tagging/verify-dev.ts. No production build. */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareTaggedProject } from './inject';
import { parseTagLocation } from './coverage';

const root = join(import.meta.dir, '../..');
const dir = await mkdtemp(join(import.meta.dir, '.verify-'));
try {
  await cp(join(root, 'fixtures/orbit-studio'), dir, { recursive: true, mode: 2,
    filter: path => !path.includes('/.next') && !path.includes('/.git') });
  await prepareTaggedProject(dir, '// Verification bridge.');
  for (const [bundler, port] of [['--turbopack', 48761], ['--webpack', 48762]] as const) {
    const proc = Bun.spawn(['node', join(dir, 'node_modules/next/dist/bin/next'), 'dev', bundler, '-p', String(port), '-H', '127.0.0.1'],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    try {
      let html = '';
      const deadline = Date.now() + 55000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(10000) });
          if (response.ok) { html = await response.text(); break; }
        } catch {}
        await Bun.sleep(250);
      }
      const tag = html.match(/<h1[^>]*data-nl-src="([^"]+)"/)?.[1];
      const location = tag && parseTagLocation(tag);
      if (!location) throw new Error(`${bundler}: no tagged h1 in rendered HTML`);
      const line = (await readFile(join(dir, location.file), 'utf8')).split('\n')[location.line - 1];
      if (line?.slice(location.column - 1, location.column + 2) !== '<h1') throw new Error(`${bundler}: incorrect source location ${tag}`);
      console.log(`${bundler}: HTTP 200; h1 resolves to ${tag}`);
    } finally {
      proc.kill('SIGTERM');
      await proc.exited;
      console.log(await stdout, await stderr);
    }
    await rm(join(dir, '.next'), { recursive: true, force: true });
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
