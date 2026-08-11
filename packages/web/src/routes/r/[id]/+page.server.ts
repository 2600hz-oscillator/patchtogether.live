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
import { dbRead } from '$lib/server/db-availability';

export const load: PageServerLoad = async ({ locals, params, url, request }) => {
  const { userId } = locals.auth();
  // Every DB call below goes through dbRead: an UNREACHABLE database degrades
  // to a 503 ("try again shortly") instead of an opaque 500, while a SQLSTATE
  // error (bad query / missing column) still bubbles to a 500 so the live-smoke
  // canary keeps catching schema bugs. See $lib/server/db-availability.
  //
  // Incident: 2026-07-28, Neon compute-quota exhaustion returned HTTP 402 on
  // every tier — including prod — and every rackspace URL served a 500 for ~24h.
  const rackspace = await dbRead('getRackspace', () => getRackspace(params.id));

  // Diagnostic — one JSON line per /r/[id] load so we can grep CF Pages tail.
  // Tracks invite presence + verify outcome + authed-ness. Deliberately NOT
  // logging the bearer token value (length only) or any Clerk user details.
  const invite = url.searchParams.get('invite');
  const hasInvite = !!invite;
  const inviteLen = invite?.length ?? 0;
  const ua = (request.headers.get('user-agent') ?? '').slice(0, 80);
  const logLoad = (verifyOk: boolean | 'skipped', outcome: string) => {
    console.log(JSON.stringify({
      tag: 'invite-load',
      rackspaceId: params.id,
      host: url.host,
      hasInvite,
      inviteLen,
      verifyOk,
      authed: !!userId,
      outcome,
      ua,
    }));
  };

  if (!rackspace) {
    logLoad('skipped', 'not-found');
    throw error(404, 'Rackspace not found');
  }

  if (!userId) {
    // Anon access requires a valid invite code. Redirect to /sign-in for
    // both missing and invalid codes — don't leak which it was.
    const ok = await verifyInviteCode(rackspace.id, invite);
    if (!ok) {
      logLoad(false, 'redirect-sign-in');
      throw redirect(303, `/sign-in?redirect_url=${encodeURIComponent(url.pathname + url.search)}`);
    }
    logLoad(true, 'anon-allowed');
    return {
      rackspace: {
        id: rackspace.id,
        name: rackspace.name,
        ownerUserId: rackspace.ownerUserId,
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

  const member = await dbRead('isMember', () => isMember(rackspace.id, userId));
  logLoad('skipped', member ? 'member' : 'non-member');
  // We surface ONLY the current user's own Clerk userId (`currentUserId`),
  // never another user's. The per-user layout system (Stage B PR B-b)
  // needs a stable per-user key to scope layout state in the Yjs doc.
  // Returning the current user's own id is not a leak — they can read it
  // from their session cookie anyway.
  return {
    rackspace: {
      id: rackspace.id,
      name: rackspace.name,
      ownerUserId: rackspace.ownerUserId,
      memberCount: rackspace.memberUserIds.length,
      maxMembers: RACKSPACE_MAX_MEMBERS,
    },
    isMember: member,
    isAnon: false,
    currentUserId: userId,
    // Members get the invite code so they can share an anon-access URL.
    // Non-members shouldn't (they don't yet have a relationship to the rack).
    // NOT wrapped in dbRead: invite codes are HMAC-derived from the rackspace
    // id (lib/server/invites.ts) with no datastore behind them.
    inviteCode: member ? await getInviteCode(rackspace.id) : null,
  };
};
