// packages/web/src/routes/api/rackspaces/[id]/leave/+server.ts
//
// POST /api/rackspaces/[id]/leave — a non-owner member removes themselves
// from a rackspace they joined, freeing a slot (the 4/4 cap is owner + 3).
// This is the only way a guest can get a joined rack off their dashboard;
// owners must DELETE the rackspace instead (see ../+server.ts) — leaving an
// owned rack would leave it ownerless, so we reject that with a 409.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { leaveRackspace } from '$lib/server/rackspaces';

export const POST: RequestHandler = async ({ locals, params }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');

  const result = await leaveRackspace(params.id, userId);
  switch (result) {
    case 'not-found':
      throw error(404, 'rackspace not found');
    case 'not-member':
      throw error(403, 'you are not a member of this rackspace');
    case 'is-owner':
      throw error(409, {
        message: 'owners must delete the rackspace, not leave it',
      } as App.Error);
    case 'ok':
      return json({ status: 'ok' });
  }
};
