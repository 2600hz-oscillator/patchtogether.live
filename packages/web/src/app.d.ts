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
    // No bespoke platform.env bindings yet — DATABASE_URL is read directly
    // from process.env (shimmed by nodejs_compat on Workers). If we wire
    // Hyperdrive later (needs Fly Postgres with TLS), bring back a typed
    // HYPERDRIVE binding here.
  }
}

export {};
