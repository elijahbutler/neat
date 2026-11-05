// A dedicated process pins its working directory in the kernel. All file operations use a validated basename.
import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isExportName, MAX_SERIES_BYTES } from './delivery';

async function main() {
  const [mode, name, device, inode, root] = process.argv.slice(2);
  if ((mode !== 'read' && mode !== 'write') || !name || !isExportName(name) || !device || !inode || !root) throw new Error('Invalid operation');
  process.chdir(root);
  const current = statSync('.', { bigint: true });
  if (String(current.dev) !== device || String(current.ino) !== inode) throw new Error('Directory changed');
  // The parent may now replace the directory's path. Relative operations still use this original directory.
  process.stdout.write('READY\n');
  const input = new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
  if (input.length > MAX_SERIES_BYTES) throw new Error('Too large');
  if (mode === 'write') {
    const fd = openSync(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, input); fsyncSync(fd); }
    catch (error) { unlinkSync(name); throw error; }
    finally { closeSync(fd); }
  } else {
    const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_SERIES_BYTES) throw new Error('Not an export');
      const bytes = readFileSync(fd);
      if (bytes.length > MAX_SERIES_BYTES) throw new Error('Too large');
      process.stdout.write(bytes);
    } finally { closeSync(fd); }
  }
}

if (import.meta.main) {
  try { await main(); } catch { process.exitCode = 1; }
}
