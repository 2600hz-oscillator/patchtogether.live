// Public health probe — never trips the Clerk handler (carve-out in
// hooks.server.ts) so it works in every environment, including the prod
// project that ships without Clerk env until launch.
//
// Reports presence-only of Clerk env vars; never returns key values. Useful
// for: smoke tests asserting the deploy is sane, ops verifying which Pages
// project has which env scope set, and humans diagnosing auth-route 503s.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

export const GET: RequestHandler = () => {
  const hasSecret = Boolean(privateEnv.CLERK_SECRET_KEY);
  const hasPublishable = Boolean(publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY);
  return json({
    ok: true,
    auth: hasSecret && hasPublishable ? 'configured' : 'missing',
    env: {
      CLERK_SECRET_KEY: hasSecret,
      PUBLIC_CLERK_PUBLISHABLE_KEY: hasPublishable,
    },
  });
};
