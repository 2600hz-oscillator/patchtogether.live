// packages/web/src/hooks.server.ts
//
// COOP/COEP headers required for SharedArrayBuffer (Faust may use it).
// Setting via hooks.server.ts so they apply in both dev and production
// (Vite's server.headers config doesn't propagate through SvelteKit's adapter
// response wrapping). In Phase 2 the production adapter also gets a `_headers`
// file as a belt-and-suspenders measure.

import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return response;
};
