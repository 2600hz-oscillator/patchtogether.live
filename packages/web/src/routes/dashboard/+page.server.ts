// packages/web/src/routes/dashboard/+page.server.ts
//
// Lists the signed-in user's rackspaces. Anyone hitting this route without a
// session gets redirected to /sign-in. If the rackspace load fails we let
// SvelteKit show its 500 page — the dashboard is unusable without the rack list.
//
// ⚠ THE SAVED-GROUPS LIBRARY IS GONE, AND SO IS THE DEFENCE AROUND IT. This
// load used to fetch a second, secondary surface — the user's saved GROUP!
// library — inside a `loadSavedGroupsSafe` try/catch that degraded to an empty
// list, because a missing `saved_groups` table hard-500'd the whole dashboard in
// dev on 2026-05-17. The GROUP! module is deleted, the `/api/saved-groups`
// routes and `db/schema/003_saved_groups.sql` with it, so there is no second
// query left to defend. The incident's lesson is not lost: it belongs to
// whatever the next secondary surface is, and it is recorded here rather than in
// a comment above a query that no longer runs.

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
