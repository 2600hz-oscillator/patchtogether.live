// app.d.ts — SvelteKit's type augmentations.
//
// Clerk's locals.auth() returns a discriminated union covering session-token,
// machine-to-machine, and oauth-token requests. svelte-clerk only ever issues
// session tokens, so SessionAuthObject is the right narrow type — gives us
// `userId: string | null` without any-casts in every loader.

import type { SessionAuthObject } from '@clerk/backend';

declare global {
  namespace App {
    interface Locals {
      auth: () => SessionAuthObject;
    }
    interface Platform {
      env?: {
        // Cloudflare Hyperdrive binding for the patchtogether Postgres on Fly.
        // Available on Workers / Pages runtime; undefined under `vite dev`
        // (which falls back to process.env.DATABASE_URL — see lib/server/db.ts).
        HYPERDRIVE?: { connectionString: string };
      };
    }
  }
}

export {};
