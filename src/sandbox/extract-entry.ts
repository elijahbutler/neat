// Runs inside a job container: read the repo at argv[2] and print its design system profile as JSON on stdout.
import { extractDesignSystem } from '../extract/profile';

const [root, commit] = process.argv.slice(2);
if (!root) throw new Error('Usage: extract.js <repo dir> [commit]');
process.stdout.write(JSON.stringify(extractDesignSystem(root, { commit: commit || null })));
