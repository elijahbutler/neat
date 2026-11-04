import type { NextConfig } from 'next';

export default function config(phase: string): NextConfig {
  return { poweredByHeader: false, env: { BUILD_PHASE: phase } };
}
