/** Holders of a session's edit lock: one ask, keep, or undo at a time, so a slow model call can't be overtaken. */
export interface Lockable {
  busy?: boolean;
}

export class SessionBusyError extends Error {
  constructor() {
    super('Another change is still in progress for this session. Wait for it to finish.');
  }
}

/** Run `fn` holding the session's edit lock. The flag is set before the first await and always cleared. */
export async function exclusive<T>(session: Lockable, fn: () => Promise<T>): Promise<T> {
  if (session.busy) throw new SessionBusyError();
  session.busy = true;
  try {
    return await fn();
  } finally {
    session.busy = false;
  }
}
