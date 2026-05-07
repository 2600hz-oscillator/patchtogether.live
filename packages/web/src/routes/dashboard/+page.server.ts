// packages/web/src/routes/dashboard/+page.server.ts
//
// Lists the signed-in user's rackspaces. Anyone hitting this route without
// a session gets redirected to /sign-in.

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listRackspacesForUser } from '$lib/server/rackspaces';

export const load: PageServerLoad = async ({ locals }) => {
  const { userId } = locals.auth();
  if (!userId) {
    throw redirect(303, '/sign-in?redirect_url=/dashboard');
  }
  const rackspaces = await listRackspacesForUser(userId);
  return { rackspaces, userId };
};
