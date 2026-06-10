// packages/web/src/lib/observability/sentry-server.ts
//
// Server/Worker-side Sentry for the Cloudflare Pages runtime — env-gated on
// PUBLIC_SENTRY_DSN (no DSN ⇒ this module never touches the SDK at all).
//
// WHY a hand-built CloudflareClient instead of @sentry/sveltekit's server path:
// @sentry/sveltekit's initCloudflareSentryHandle / sentryHandle pull in
// @sentry/node → @fastify/otel → minimatch, which does NOT bundle for the
// Cloudflare Workers runtime (getsentry/sentry-javascript#16613 — "Could not
// resolve minimatch"). @sentry/cloudflare is the SDK actually built for this
// runtime. Its top-level `init()` is geared toward wrapRequestHandler (it wants
// the Worker execution `ctx` for flush-on-waitUntil and sets up OpenTelemetry),
// and isn't re-exported from the package index. SvelteKit's `handleError` hook
// gives us neither a `ctx` nor a wrapped fetch, so we construct a minimal
// CloudflareClient directly and bind it once — enough to capture + flush the
// uncaught server errors SvelteKit surfaces, with no OTel/Node baggage.
//
// This module is imported ONLY by hooks.server.ts. It is lazy: nothing happens
// until ensureSentry() is first called from a handleError, and that call is
// itself gated on the DSN by the caller.

import {
  CloudflareClient,
  createTransport,
  getCurrentScope,
  getDefaultIntegrations,
  setCurrentClient,
} from '@sentry/cloudflare';
import { createStackParser, nodeStackLineParser } from '@sentry/core';
import type {
  BaseTransportOptions,
  Client,
  Transport,
  TransportMakeRequestResponse,
} from '@sentry/core';
import { sentryEnvironment, sentryRelease } from './sentry-config';

// Bind once per isolate. The CF Workers runtime reuses an isolate across many
// requests, so the client survives between handleError calls; re-initializing
// per error would leak transports.
let client: Client | undefined;

const stackParser = createStackParser(nodeStackLineParser());

// Fetch-based transport factory for the Workers runtime. CloudflareClient wants
// a `(options) => Transport` factory; @sentry/cloudflare's own
// makeCloudflareTransport isn't re-exported from the package index, so we build
// the same shape over the platform `fetch` (the only network primitive on the
// edge). We MUST consume the response body — the CF runtime cancels a fetch
// whose body is never read — and surface the rate-limit headers Sentry uses for
// backoff. Mirrors getsentry/sentry-javascript's documented manual pattern.
function makeFetchTransport(options: BaseTransportOptions): Transport {
  return createTransport(options, async (request) => {
    const response = await fetch(options.url, {
      method: 'POST',
      // request.body is `string | Uint8Array`; both are valid BodyInit at
      // runtime, but the DOM lib types Uint8Array narrower than BodyInit.
      body: request.body as BodyInit,
      headers: options.headers,
    });
    // Drain the body so the Workers runtime doesn't cancel the request.
    await response.text();
    const result: TransportMakeRequestResponse = {
      statusCode: response.status,
      headers: {
        'x-sentry-rate-limits': response.headers.get('X-Sentry-Rate-Limits'),
        'retry-after': response.headers.get('Retry-After'),
      },
    };
    return result;
  });
}

/**
 * Idempotently construct + bind the Cloudflare Sentry client for this isolate.
 * Returns the live client, or undefined if it couldn't be created. The DSN must
 * already be known non-empty by the caller (hooks.server.ts gates on it).
 */
export function ensureSentryServer(dsn: string): Client | undefined {
  if (client) return client;

  const options = {
    dsn,
    release: sentryRelease(),
    environment: sentryEnvironment(),
    // Errors only — no perf spans / OTel tracing on the edge for now.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // skip OTel + the integrations that assume a wrapped fetch/exec-context.
    // We only need error capture from handleError.
    stackParser,
    transport: makeFetchTransport,
    integrations: getDefaultIntegrations({ dsn }).filter(
      (i) =>
        // Drop the request/fetch/http/console/hono integrations that expect a
        // wrapRequestHandler context; keep the pure error-shaping ones.
        ['InboundFilters', 'EventFilters', 'FunctionToString', 'LinkedErrors', 'Dedupe'].includes(
          i.name,
        ),
    ),
  };

  try {
    const c = new CloudflareClient(options as ConstructorParameters<typeof CloudflareClient>[0]);
    setCurrentClient(c);
    c.init();
    client = c;
  } catch {
    // Never let an observability wiring problem take down a request.
    client = undefined;
  }
  return client;
}

/** Capture a server-side error through Sentry if (and only if) a client is
 *  bound. Returns immediately; the transport flushes best-effort. */
export function captureServerError(error: unknown): void {
  const c = client ?? getCurrentScope().getClient();
  if (!c) return;
  c.captureException(error);
}
