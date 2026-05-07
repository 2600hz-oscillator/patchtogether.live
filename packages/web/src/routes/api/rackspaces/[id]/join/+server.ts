// packages/web/src/routes/api/rackspaces/[id]/join/+server.ts
//
// POST /api/rackspaces/[id]/join — visitor lands on a /r/[id] share URL,
// they're authenticated, and they click "Join". Adds their userId to the
// rackspace's member list (capacity-checked at 4).

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { joinRackspace } from '$lib/server/rackspaces';

export const POST: RequestHandler = async ({ locals, params, platform }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');

  const result = await joinRackspace(params.id, userId, platform?.env);
  switch (result.status) {
    case 'not-found':
      throw error(404, 'rackspace not found');
    case 'full':
      throw error(409, {
        message: 'rackspace is full (4 members max)',
      } as App.Error);
    case 'ok':
    case 'already-member':
      return json({ status: result.status, rackspace: result.rackspace });
  }
};
