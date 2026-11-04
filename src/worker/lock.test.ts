import { expect, test } from 'bun:test';
import { exclusive, SessionBusyError } from './lock';

test('a second change is refused while the first is running, and the lock clears after errors', async () => {
  const session = {};
  let release!: () => void;
  const first = exclusive(session, () => new Promise<string>((resolve) => { release = () => resolve('first'); }));
  await expect(exclusive(session, async () => 'second')).rejects.toBeInstanceOf(SessionBusyError);
  release();
  expect(await first).toBe('first');
  await expect(exclusive(session, async () => { throw new Error('model failed'); })).rejects.toThrow('model failed');
  expect(await exclusive(session, async () => 'after')).toBe('after');
});
