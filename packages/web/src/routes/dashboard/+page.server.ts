// packages/web/src/routes/dashboard/+page.server.ts
//
// Lists the signed-in user's rackspaces and their saved-groups library.
// Anyone hitting this route without a session gets redirected to /sign-in.

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listRackspacesForUser } from '$lib/server/rackspaces';
import { listSavedGroupsForUser } from '$lib/server/saved-groups';

export const load: PageServerLoad = async ({ locals }) => {
  const { userId } = locals.auth();
  if (!userId) {
    throw redirect(303, '/sign-in?redirect_url=/dashboard');
  }
  const [rackspaces, savedGroups] = await Promise.all([
    listRackspacesForUser(userId),
    listSavedGroupsForUser(userId),
  ]);
  return { rackspaces, savedGroups, userId };
};
