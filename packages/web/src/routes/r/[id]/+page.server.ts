// packages/web/src/routes/r/[id]/+page.server.ts
//
// Resolves a rackspace by id and decides who's allowed in:
//   - authed members → canvas, currentUserId set, inviteCode included
//   - authed non-members → join page
//   - unauthed + valid ?invite=<code> → canvas, currentUserId=null, isAnon=true
//   - unauthed + missing/bad invite → redirect to /sign-in
//
// Invite codes are HMAC-derived from the rackspace id (see lib/server/invites.ts);
// nothing about them is stored, so the server has no per-rackspace state to
// maintain or migrate.

import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getRackspace, isMember, RACKSPACE_MAX_MEMBERS } from '$lib/server/rackspaces';
import { getInviteCode, verifyInviteCode } from '$lib/server/invites';

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const { userId } = locals.auth();
  const rackspace = getRackspace(params.id);
  if (!rackspace) {
    throw error(404, 'Rackspace not found');
  }

  const invite = url.searchParams.get('invite');

  if (!userId) {
    // Anon access requires a valid invite code. Redirect to /sign-in for
    // both missing and invalid codes — don't leak which it was.
    const ok = await verifyInviteCode(rackspace.id, invite);
    if (!ok) {
      throw redirect(303, `/sign-in?redirect_url=${encodeURIComponent(url.pathname + url.search)}`);
    }
    return {
      rackspace: {
        id: rackspace.id,
        name: rackspace.name,
        memberCount: rackspace.memberUserIds.length,
        maxMembers: RACKSPACE_MAX_MEMBERS,
      },
      isMember: true, // anon-via-invite gets canvas access; membership concept stays auth-scoped
      isAnon: true,
      currentUserId: null,
      // Anon shouldn't be able to share THEIR own invite link further; only
      // owner/members get the share-URL surface in the UI.
      inviteCode: null,
    };
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
    isAnon: false,
    currentUserId: userId,
    // Members get the invite code so they can share an anon-access URL.
    // Non-members shouldn't (they don't yet have a relationship to the rack).
    inviteCode: member ? await getInviteCode(rackspace.id) : null,
  };
};
