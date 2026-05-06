// packages/web/src/routes/+layout.server.ts
//
// Hands Clerk's auth state (userId, sessionId, etc.) to the client so
// <ClerkProvider> can render the right UI without a round-trip.

import type { LayoutServerLoad } from './$types';
import { buildClerkProps } from 'svelte-clerk/server';

export const load: LayoutServerLoad = ({ locals }) => {
  return {
    ...buildClerkProps(locals.auth()),
  };
};
