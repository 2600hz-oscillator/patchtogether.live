// packages/web/src/routes/api/saved-groups/[id]/+server.ts
//
// GET    /api/saved-groups/[id] — fetch a single saved group owned by the
//                                 signed-in user. 404 when missing OR when
//                                 the requester is not the owner (we don't
//                                 leak ownership across users).
// DELETE /api/saved-groups/[id] — owner-only delete; 404 on missing/other-owner.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSavedGroupForUser, deleteSavedGroupForUser } from '$lib/server/saved-groups';

export const GET: RequestHandler = async ({ locals, params }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');
  const sg = await getSavedGroupForUser(params.id, userId);
  if (!sg) throw error(404, 'saved group not found');
  return json({ savedGroup: sg });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');
  const result = await deleteSavedGroupForUser(params.id, userId);
  if (result === 'not-found') throw error(404, 'saved group not found');
  return json({ status: 'ok' });
};
