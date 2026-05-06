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
  }
}

export {};
