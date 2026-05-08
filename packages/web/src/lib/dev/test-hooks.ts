// packages/web/src/lib/dev/test-hooks.ts
//
// Single gate for the dev-only window globals (`__patch`, `__ydoc`,
// `__engine`, `__setLocalCursor`, `__riotgirlsTriggerVoice`, etc.) that
// Playwright drives. Originally gated on `import.meta.env.DEV` only, which
// Vite strips in production builds — that meant the audio-drift / collab
// tests couldn't run against the autotest tier (a prod build).
// VITE_E2E_HOOKS=1 set in the autotest + dev deploy steps re-exposes them
// on those tiers without shipping them to prod.

interface ImportMetaEnvWithHooks {
  DEV?: boolean;
  VITE_E2E_HOOKS?: string;
}

export function testHooksEnabled(): boolean {
  const env = (import.meta as unknown as { env?: ImportMetaEnvWithHooks }).env;
  if (!env) return false;
  if (env.DEV) return true;
  return env.VITE_E2E_HOOKS === '1';
}
