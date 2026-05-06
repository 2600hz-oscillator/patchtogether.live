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
  // Don't leak Clerk user IDs to the client. The page only needs id/name +
  // capacity + membership state. If a future feature actually needs to
  // distinguish "you are the owner" vs "you are a member" we'll surface a
  // boolean flag (`isOwner`) instead of the raw userId.
  return {
    rackspace: {
      id: rackspace.id,
      name: rackspace.name,
      memberCount: rackspace.memberUserIds.length,
      maxMembers: RACKSPACE_MAX_MEMBERS,
    },
    isMember: member,
  };
};
