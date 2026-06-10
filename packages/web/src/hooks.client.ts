// packages/web/src/hooks.client.ts
//
// Browser-side error tracking via Sentry — FULLY ENV-GATED on PUBLIC_SENTRY_DSN.
// With the DSN unset (local dev, CI, prod-before-provisioning) this is a TOTAL
// no-op: Sentry.init() is never called and handleError falls through to the
// plain console path, so nothing changes for anyone who hasn't provisioned a
// Sentry account.
//
// Why @sentry/svelte (not the @sentry/sveltekit server entry): this app is
// fully client-rendered (svelte.config.js excludes every route from CF
// Functions), and @sentry/sveltekit's SERVER path pulls in @sentry/node →
// @fastify/otel → minimatch, which does NOT bundle for the Cloudflare Workers
// runtime (getsentry/sentry-javascript#16613). The browser SDK (@sentry/svelte,
// which @sentry/sveltekit re-exports) is pure browser code and builds fine; the
// Worker/server side is handled separately by @sentry/cloudflare in
// hooks.server.ts. Importing @sentry/svelte directly keeps the SvelteKit
// server entry out of the client bundle entirely.

import * as Sentry from '@sentry/svelte';
import { handleErrorWithSentry } from '@sentry/sveltekit';
import { env as publicEnv } from '$env/dynamic/public';
import { sentryEnabled, sentryEnvironment, sentryRelease } from '$lib/observability/sentry-config';

const dsn = publicEnv.PUBLIC_SENTRY_DSN;

if (sentryEnabled(dsn)) {
  Sentry.init({
    dsn,
    release: sentryRelease(),
    environment: sentryEnvironment(),
    // Errors-first: keep the wire footprint tiny until we decide we want perf
    // tracing / session replay. Both default to off (0 / no integration) so an
    // active DSN doesn't suddenly start streaming spans + replays.
    tracesSampleRate: 0,
    // No PII by default — the canvas can carry user-authored patch content.
    sendDefaultPii: false,
  });
}

// handleError runs for every uncaught client-side error SvelteKit catches.
// handleErrorWithSentry forwards to Sentry IFF init ran (no-op otherwise) and
// still returns the default shape, so the app's error UX is unchanged when
// Sentry is off.
export const handleError = handleErrorWithSentry();
