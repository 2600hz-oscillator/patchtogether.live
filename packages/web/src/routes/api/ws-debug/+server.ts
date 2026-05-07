// Temporary diagnostic for the multiplayer WS URL bake-in.
// Reports what the bundle has VITE_SERVER_WS_URL resolved to, plus the
// runtime env var (which is irrelevant for VITE_* but useful to diff).
// REMOVE once verified.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as privateEnv } from '$env/dynamic/private';

export const GET: RequestHandler = () => {
  // Build-time bake — same expression as provider.ts uses.
  const baked =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_SERVER_WS_URL ?? null;

  return json({
    build_time_VITE_SERVER_WS_URL: baked,
    runtime_VITE_SERVER_WS_URL_present: Boolean(privateEnv.VITE_SERVER_WS_URL),
    runtime_DATABASE_URL_present: Boolean(privateEnv.DATABASE_URL),
  });
};
