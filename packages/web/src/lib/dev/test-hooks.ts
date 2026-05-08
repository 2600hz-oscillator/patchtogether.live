// packages/web/src/lib/dev/test-hooks.ts
//
// Single gate for the dev-only window globals (`__patch`, `__ydoc`,
// `__engine`, `__riotgirlsTriggerVoice`, `__drumseqzCellAt`,
// `__drumseqzSetCell`, etc.) that Playwright drives.
// Originally gated on `import.meta.env.DEV` only, which Vite strips in
// production builds — so the autotest tier (a prod build) couldn't use them.
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
