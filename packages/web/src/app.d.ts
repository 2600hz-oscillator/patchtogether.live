// app.d.ts — SvelteKit's type augmentations.
//
// Clerk's locals.auth() returns a discriminated union covering session-token,
// machine-to-machine, and oauth-token requests. svelte-clerk only ever issues
// session tokens, so SessionAuthObject is the right narrow type — gives us
// `userId: string | null` without any-casts in every loader.

import type { SessionAuthObject } from '@clerk/backend';

declare global {
  /** Product version string (e.g. `"1.1.0"`), inlined at build time from the
   *  ROOT package.json by Vite's `define` (see packages/web/vite.config.ts).
   *  Rendered in the topbar brand heading. Always defined in a Vite/Vitest
   *  build — never `undefined` at runtime. */
  const __APP_VERSION__: string;

  namespace App {
    interface Locals {
      auth: () => SessionAuthObject;
      /** Per-request correlation id, set by the requestIdAndLog handle in
       *  hooks.server.ts and echoed as the `x-request-id` response header.
       *  Lets a Better Stack Logs query stitch a browser report to its server
       *  access-log line. */
      requestId: string;
    }
    // No bespoke platform.env bindings yet — DATABASE_URL is read directly
    // from process.env (shimmed by nodejs_compat on Workers). If we wire
    // Hyperdrive later (needs Fly Postgres with TLS), bring back a typed
    // HYPERDRIVE binding here.
    interface Platform {
      /** Cloudflare Pages Functions execution context. adapter-cloudflare
       *  exposes `context.waitUntil` — used by requestIdAndLog to fire-and-
       *  forget the Better Stack access-log ship without blocking/delaying the
       *  response (and without the isolate tearing down mid-POST). Optional:
       *  undefined in dev / non-CF runtimes, where the ship is skipped. */
      context?: {
        waitUntil(promise: Promise<unknown>): void;
      };
    }
  }
}

export {};
