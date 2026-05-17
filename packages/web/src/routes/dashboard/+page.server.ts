// packages/web/src/routes/dashboard/+page.server.ts
//
// Lists the signed-in user's rackspaces and their saved-groups library.
// Anyone hitting this route without a session gets redirected to /sign-in.
//
// Rackspaces is the dashboard's primary surface — if that load fails we
// let SvelteKit show its 500 page (the dashboard is unusable without
// the rack list). Saved groups are secondary library content: we degrade
// to an empty list on any failure so a missing `saved_groups` table
// (e.g. before the migration lands in an env) or a transient Neon error
// can't take down the page. Incident reference: dev hard-500 on
// 2026-05-17 from the `saved_groups` table not yet existing in the dev
// Neon branch.
//
// The UI already renders an empty-state for `savedGroups.length === 0`,
// so degradation is silent to users with no saved groups and reduces a
// 500 to "library temporarily empty" for users who do.

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listRackspacesForUser } from '$lib/server/rackspaces';
import { listSavedGroupsForUser, type SavedGroup } from '$lib/server/saved-groups';

export const load: PageServerLoad = async ({ locals }) => {
  const { userId } = locals.auth();
  if (!userId) {
    throw redirect(303, '/sign-in?redirect_url=/dashboard');
  }
  const [rackspaces, savedGroups] = await Promise.all([
    listRackspacesForUser(userId),
    loadSavedGroupsSafe(userId),
  ]);
  return { rackspaces, savedGroups, userId };
};

async function loadSavedGroupsSafe(userId: string): Promise<SavedGroup[]> {
  try {
    return await listSavedGroupsForUser(userId);
  } catch (err) {
    const e = err as { message?: string; code?: string } | undefined;
    // Single-line JSON keeps this greppable in Cloudflare Workers logs
    // (no structured logger in the project yet — see grep for existing
    // `console.warn` patterns).
    console.warn(
      `[dashboard] saved-groups load failed; returning empty list ${JSON.stringify({
        userId,
        message: e?.message ?? String(err),
        code: e?.code,
        timestamp: new Date().toISOString(),
      })}`,
    );
    return [];
  }
}
