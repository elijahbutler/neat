import { isAbsolute, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = fileURLToPath(new URL('../../', import.meta.url));

export const help = `Usage: NEAT_BROWSER_DRIVER=/absolute/path/to/playwright/index.mjs bun scripts/verify-editor.mjs [options]

Creates a disposable Next.js fixture and isolated NEAT_HOME, then drives the real CLI.
Install fixture dependencies first with bun run fixtures:install. Installs nothing.

  --port 4460                 Editor port, at least 4460
  --provider-port 4462        Local scripted model endpoint, at least 4460
  --evidence /external/dir    New directory outside this checkout, retained after cleanup
  --browser-executable /file  Chromium executable for an external Playwright installation
  --headed                    Show the browser
  --timeout 120000            Per-operation deadline in milliseconds
  --help                      Show this help

The preview uses the production allocator. Its assigned loopback URL is discovered
from the owned session. No existing instance is attached, stopped, or changed.
Evidence: report.json, checkout.diff, worker.log, browser.json, trace.zip, final.png, failure.png
on failure, delivery.patch, passes/, and delivery.bundle. No pushes or live models.
Coverage gaps: live model quality, earlier dependent undo, external-file conflicts,
workspace apps, other fixture layouts, native platforms, and concurrent workers.
`;

export function parseOptions(args, env = process.env) {
  const options = { port: 4460, providerPort: 4462, evidence: null, executable: null, headed: false, timeout: 120000 };
  const keys = new Map([['--port', 'port'], ['--provider-port', 'providerPort'], ['--evidence', 'evidence'], ['--browser-executable', 'executable'], ['--timeout', 'timeout']]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--headed') { options.headed = true; continue; }
    const key = keys.get(args[i]);
    if (!key) throw new Error(`Unknown option: ${args[i]}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${args[i - 1]} needs a value`);
    if (['port', 'providerPort', 'timeout'].includes(key)) {
      if (!/^\d+$/.test(value)) throw new Error(`${args[i - 1]} needs an integer`);
      options[key] = Number(value);
    } else options[key] = resolve(value);
  }
  for (const port of [options.port, options.providerPort]) {
    if (port < 4460 || port > 65535) throw new Error('Editor and provider ports must be between 4460 and 65535');
  }
  if (options.port === options.providerPort) throw new Error('Editor and provider ports must differ');
  if (options.timeout < 1000 || options.timeout > 600000) throw new Error('--timeout must be between 1000 and 600000');
  if (options.evidence && isInside(repository, options.evidence)) throw new Error('Evidence must be outside this checkout');
  const driver = env.NEAT_BROWSER_DRIVER;
  if (!driver || !isAbsolute(driver)) throw new Error('NEAT_BROWSER_DRIVER must be an absolute path to an external Playwright module');
  if (isInside(repository, driver)) throw new Error('NEAT_BROWSER_DRIVER must be installed outside this checkout');
  return { ...options, driver };
}

export function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}
