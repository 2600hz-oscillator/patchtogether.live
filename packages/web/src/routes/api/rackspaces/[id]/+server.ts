// packages/web/src/routes/api/rackspaces/[id]/+server.ts
//
// DELETE /api/rackspaces/[id] — owner-only rackspace deletion. The DB
// schema's ON DELETE CASCADE on rack_members + rack_snapshots cleans up
// related rows automatically; the Hocuspocus snapshot for this rack
// vanishes with it.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteRackspace } from '$lib/server/rackspaces';

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');

  const result = await deleteRackspace(params.id, userId);
  switch (result) {
    case 'not-found':
      throw error(404, 'rackspace not found');
    case 'forbidden':
      throw error(403, 'only the owner can delete this rackspace');
    case 'ok':
      return json({ status: 'ok' });
  }
};
