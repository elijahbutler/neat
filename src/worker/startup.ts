/** Startup phases describe completed preparation boundaries, without estimating progress. */
export type PreparationPhase = 'preparing' | 'dependencies' | 'restoring' | 'starting';

export type StartupState =
  | { phase: 'idle' }
  | { phase: PreparationPhase | 'ready'; startedAt: string }
  | { phase: 'failed'; startedAt: string; error: string };
