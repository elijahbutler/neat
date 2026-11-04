#!/usr/bin/env bun
import * as fs from 'fs/promises';
import * as path from 'path';
import { extractDesignSystem } from '../src/extract/profile.ts';
import { formatProfileSummary } from '../src/extract/summary.ts';
import { buildContext, buildRepoIndex, loadEditProject, resolveSelection } from '../src/edit/index.ts';
import { applyEdits } from '../src/edit/operations.ts';
import { checkEdit } from '../src/edit/check.ts';
import { SANDBOX_IMAGE, dockerProvider } from '../src/sandbox/docker.ts';
import { dockerJobsAvailable, redact, runExtractJob } from '../src/sandbox/extract-job.ts';

function printHelp(): void {
  console.log(`
Neat Labs CLI: design system extraction and the edit pipeline

Usage:
  neat <command> [options]
  bun run neat <command> [options]

Commands:
  open <dir> [--app subdir] [--port port] [--docker]  Open the local editor
  extract [dir] [--out file]   Extract a Next.js repo's design system profile (components, tokens, usage, facts)
  context <dir> <tag> [--route /path] [--budget chars]
                               Print the edit agent's context packet for a source tag such as app/page.tsx:12:7
  edit <dir> <ops.json> [--write]
                               Apply edit operations (JSON array, "-" for stdin), check them, and print the diff
  extract-job <dir-or-https-url> [--sha commit] [--out file]
                               Install and extract inside sandbox containers (needs Docker and the sandbox image).
                               A URL needs --sha. For a private repo, put a short-lived token in NEAT_GIT_TOKEN

The component library and its MCP server moved to https://github.com/elijahbutler/neat-labs.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'open': {
      const { parseOpenArgs, validateNextApp } = await import('../src/worker/open');
      const options = parseOpenArgs(args.slice(1));
      try { options.repo = await validateNextApp(options.repo, options.app); }
      catch { throw new Error('Cannot open repository. Check the directory, package.json, and supported Next.js version. [OPEN_VALIDATION_FAILED]'); }
      const { startWorker } = await import('../src/worker/server');
      try { await startWorker(options); }
      catch { throw new Error('Cannot prepare editor session. [OPEN_PREPARATION_FAILED]'); }
      break;
    }
    case 'extract': {
      const targetDir = args[1] && !args[1].startsWith('-') ? path.resolve(args[1]) : process.cwd();
      const profile = extractDesignSystem(targetDir);
      const outIndex = args.indexOf('--out');
      const outFile = outIndex !== -1 ? args[outIndex + 1] : undefined;
      if (outFile) {
        await fs.writeFile(path.resolve(outFile), `${JSON.stringify(profile, null, 2)}\n`);
        console.log(`✓ Wrote ${outFile}`);
      } else {
        console.log(formatProfileSummary(profile));
      }
      break;
    }
    case 'context':
    case 'edit': {
      const [, dirArg, input] = args;
      if (!dirArg || !input) throw new Error(`Usage: neat ${command} <dir> <${command === 'edit' ? 'ops.json' : 'tag'}>`);
      const root = await fs.realpath(path.resolve(dirArg));
      const project = loadEditProject(root);
      const index = buildRepoIndex(extractDesignSystem(root, { project }), project, root);
      const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
      if (command === 'context') {
        const selection = resolveSelection(project, root, index, input);
        if (!selection) throw new Error(`No JSX element starts at ${input}.`);
        const budget = flag('--budget');
        console.log(JSON.stringify(buildContext(index, project, root, flag('--route') ?? '/', selection, budget ? Number(budget) : undefined), null, 2));
        break;
      }
      const opsPath = path.resolve(input);
      if (input !== '-' && !(await fs.stat(opsPath).catch(() => null))) throw new Error(`No operations file at ${opsPath}. Pass a JSON array of edit operations, or "-" to read it from stdin.`);
      const ops: unknown = JSON.parse(input === '-' ? await new Response(Bun.stdin.stream()).text() : await fs.readFile(opsPath, 'utf8'));
      // No selection on the command line: the operations file is the whole request.
      const result = applyEdits(project, root, index, ops, null);
      if (!result.ok) {
        console.log(JSON.stringify({ errors: result.errors }, null, 2));
        process.exitCode = 1;
        break;
      }
      const check = checkEdit(project, root, index, result.changes);
      for (const change of result.changes) {
        const tmp = await fs.mkdtemp(path.join((await import('os')).tmpdir(), 'neat-edit-'));
        await fs.writeFile(path.join(tmp, 'after'), change.after);
        const diff = await Bun.$`diff -u --label a/${change.file} --label b/${change.file} ${path.join(root, change.file)} ${path.join(tmp, 'after')}`.nothrow().text();
        await fs.rm(tmp, { recursive: true });
        console.log(diff);
      }
      for (const sub of result.substitutions) console.log(`token: ${sub.from} → ${sub.to}`);
      for (const error of check.errors) console.log(`✗ ${error.check} ${error.file}:${error.line} ${error.message}`);
      console.log(check.ok ? `✓ Checks passed (still to run in a sandbox: ${check.pending.join(', ')})` : '✗ Checks failed');
      if (!check.ok) process.exitCode = 1;
      else if (args.includes('--write')) {
        for (const change of result.changes) await fs.writeFile(path.join(root, change.file), change.after);
        console.log(`✓ Wrote ${result.changes.length} file(s)`);
      }
      break;
    }
    case 'extract-job': {
      const target = args[1];
      if (!target || target.startsWith('-')) throw new Error('Usage: neat extract-job <dir-or-https-url> [--sha commit] [--out file]');
      const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
      const sha = flag('--sha');
      const token = process.env.NEAT_GIT_TOKEN || undefined;
      const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
      if (isUrl && !sha) throw new Error('A repository URL needs --sha with the full commit sha.');
      if (!(await dockerJobsAvailable(SANDBOX_IMAGE))) throw new Error(`Docker is not running or the ${SANDBOX_IMAGE} image is missing. Build it with: docker build -t ${SANDBOX_IMAGE} sandbox`);
      const started = performance.now();
      const result = await runExtractJob(dockerProvider, isUrl && sha ? { url: target, sha, token } : { path: path.resolve(target), sha }).catch((err: unknown) => {
        // Nothing from the job should carry the token, but an error is the last place to let one through.
        throw new Error(redact(err instanceof Error ? err.message : String(err), [token]));
      });
      const { install, manager, profile } = result;
      if (!manager || !install) console.error('Install: no lockfile, nothing installed');
      else if (install.exitCode === 0) console.error(`Install: ${manager} ok in ${install.durationMs} ms`);
      else console.error(`Install: ${manager} ${install.timedOut ? 'timed out' : `failed with exit code ${install.exitCode}`}\n${install.stderr.slice(-2000)}`);
      if (result.refused.length) console.error(`Refused by the job proxy (not on the allowlist): ${result.refused.join(', ')}`);
      console.error(`Extract: ${result.extract.durationMs} ms. Total: ${Math.round(performance.now() - started)} ms`);
      const outFile = flag('--out');
      if (outFile) {
        await fs.writeFile(path.resolve(outFile), `${JSON.stringify(profile, null, 2)}\n`);
        console.log(`✓ Wrote ${outFile}`);
      } else {
        console.log(formatProfileSummary(profile));
      }
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
