// Development convenience entry for the same standalone local editor as `neat open`.
import { join } from 'node:path';
import { parseOpenArgs, validateNextApp } from '../src/worker/open';
import { startWorker } from '../src/worker/server';

const args = process.argv.slice(2);
const options = parseOpenArgs(args.length ? args : [join(import.meta.dir, '../fixtures/orbit-studio')]);
options.repo = await validateNextApp(options.repo, options.app);
await startWorker(options);
