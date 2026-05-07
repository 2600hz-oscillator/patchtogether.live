// packages/web/src/routes/r/[id]/+page.server.ts
//
// Resolves a rackspace by id, checks the visitor's membership, and either
// renders the canvas (members) or a "join" prompt (non-members with capacity).

import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getRackspace, isMember, RACKSPACE_MAX_MEMBERS } from '$lib/server/rackspaces';

export const load: PageServerLoad = ({ locals, params, url }) => {
  const { userId } = locals.auth();
  if (!userId) {
    throw redirect(303, `/sign-in?redirect_url=${encodeURIComponent(url.pathname)}`);
  }

  const rackspace = getRackspace(params.id);
  if (!rackspace) {
    throw error(404, 'Rackspace not found');
  }

  const member = isMember(rackspace.id, userId);
  // We surface ONLY the current user's own Clerk userId (`currentUserId`),
  // never another user's. The per-user layout system (Stage B PR B-b)
  // needs a stable per-user key to scope layout state in the Yjs doc.
  // Returning the current user's own id is not a leak — they can read it
  // from their session cookie anyway.
  return {
    rackspace: {
      id: rackspace.id,
      name: rackspace.name,
      memberCount: rackspace.memberUserIds.length,
      maxMembers: RACKSPACE_MAX_MEMBERS,
    },
    isMember: member,
    currentUserId: userId,
  };
};
