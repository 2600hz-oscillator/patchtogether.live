// packages/web/src/lib/observability/sentry-config.ts
//
// Shared, side-effect-free helpers for the env-gated Sentry wiring. Both the
// browser init (hooks.client.ts) and the server/Worker init (hooks.server.ts)
// read their DSN + release through here so the gating rule lives in ONE place:
//
//   Sentry is a TOTAL no-op unless PUBLIC_SENTRY_DSN is set.
//
// Absent DSN ⇒ local dev, CI, and prod-pre-DSN are all completely unaffected
// (no SDK init, no network, no overhead). This module imports NOTHING from the
// Sentry SDK on purpose — it's pure config plumbing, safe to import anywhere
// (incl. unit tests) without dragging the SDK into a bundle.

/** The deployed build version, baked by Vite at build time (deploy.yml sets
 *  VITE_APP_VERSION per tier). Used as the Sentry `release` so issues group by
 *  deploy + release-health works. `undefined` locally / when unset. */
export function sentryRelease(): string | undefined {
  // VITE_APP_VERSION is statically inlined into `import.meta.env` at build time
  // (deploy.yml). Read defensively: in the Worker runtime + some test contexts
  // `import.meta.env` may be undefined. `process.env` is a test-only seam
  // (vi.stubEnv writes there; it's empty of VITE_* in the real Worker build, so
  // import.meta.env stays the real path) — keeps this unit-testable without a
  // separate transform.
  const buildEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const procEnv =
    typeof process !== 'undefined'
      ? (process.env as Record<string, string | undefined>)
      : undefined;
  const v = buildEnv?.VITE_APP_VERSION ?? procEnv?.VITE_APP_VERSION;
  return v && v !== 'unknown' ? v : undefined;
}

/** Coarse deploy tier inferred from the release suffix the deploy workflow
 *  appends (`…-prod` / `-dev` / `-autotest` / `-preview`). Tags Sentry events
 *  with `environment` so you can filter prod from dev noise. */
export function sentryEnvironment(): string {
  const rel = sentryRelease();
  if (!rel) return 'local';
  for (const tier of ['prod', 'dev', 'autotest', 'preview']) {
    if (rel.endsWith(`-${tier}`)) return tier;
  }
  return 'unknown';
}

/** Whether Sentry should initialize at all, given the DSN read from the
 *  caller's env source. Centralizes the "absent DSN ⇒ no-op" gate so both
 *  hooks (and the unit test) agree on exactly one predicate. */
export function sentryEnabled(dsn: string | undefined | null): dsn is string {
  return typeof dsn === 'string' && dsn.trim().length > 0;
}
