// packages/web/src/lib/build-info.ts
//
// The "live build" stamp surfaced on the /docs pages. Answers the "is prod
// current?" question at a glance — the health endpoint's version alone
// (1.x.x) doesn't reveal the underlying git SHA or when the build shipped.
//
// All three fields are baked into the client bundle by Vite at BUILD time from
// env vars the deploy workflow sets (deploy.yml / daily-prod-deploy.yml →
// `task build` env):
//   VITE_APP_VERSION — deployed web build version, e.g. `1.1.0-prod`
//   VITE_BUILD_SHA   — short git SHA of the deployed commit, e.g. `a1b2c3d`
//   VITE_BUILD_TIME  — ISO-8601 UTC build/deploy timestamp
// The two build-stamp vars are UNSET on a local build, so the const falls back
// to a "local dev" shape and a plain local `task build` stays byte-identical
// (no CI-only values leak in — additive env vars only).
//
// Read via the defensive `import.meta.env` cast used elsewhere in the app
// (lib/dev/test-hooks.ts, lib/observability/sentry-config.ts): under
// svelte-check `import.meta.env` is not globally typed, and in some runtimes it
// can be undefined, so we narrow it through a local interface.

/** The three build-stamp vars Vite inlines at build time. All optional — the
 *  two build vars are absent on a local build, where the fallbacks kick in. */
interface ImportMetaEnvBuildInfo {
  VITE_APP_VERSION?: string;
  VITE_BUILD_SHA?: string;
  VITE_BUILD_TIME?: string;
}

function buildEnv(): ImportMetaEnvBuildInfo {
  return (import.meta as unknown as { env?: ImportMetaEnvBuildInfo }).env ?? {};
}

export interface BuildInfo {
  /** Deployed web build version, e.g. `1.1.0-prod`. `dev` on a local build. */
  version: string;
  /** Short git SHA of the deployed commit. `local` on a local build. */
  sha: string;
  /** ISO-8601 UTC build/deploy timestamp. Empty string on a local build. */
  time: string;
}

/** The live build stamp, resolved at build time. On a local (non-CI) build the
 *  stamp vars are unset, so this reads `{version:'dev', sha:'local', time:''}`. */
export const BUILD_INFO: BuildInfo = {
  version: buildEnv().VITE_APP_VERSION || 'dev',
  sha: buildEnv().VITE_BUILD_SHA || 'local',
  time: buildEnv().VITE_BUILD_TIME || '',
};

/** Format an ISO-8601 timestamp as `YYYY-MM-DD HH:MM UTC`, or '' when empty /
 *  unparseable. Deterministic (UTC, no locale) so the stamp reads identically
 *  in every viewer's timezone. */
export function formatBuildTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/** One-line human summary of the live build, e.g.
 *  `v1.1.0-prod · a1b2c3d · deployed 2026-07-01 04:00 UTC`. Collapses to
 *  `local dev build` when the CI stamp is absent (sha === 'local' or no time). */
export function formatBuildInfo(info: BuildInfo = BUILD_INFO): string {
  if (info.sha === 'local' || !info.time) return 'local dev build';
  const parts = [`v${info.version}`, info.sha];
  const when = formatBuildTime(info.time);
  if (when) parts.push(`deployed ${when}`);
  return parts.join(' · ');
}
