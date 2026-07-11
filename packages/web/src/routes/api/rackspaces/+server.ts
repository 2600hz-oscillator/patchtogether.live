// packages/web/src/routes/api/rackspaces/+server.ts
//
// POST /api/rackspaces — create a new rackspace owned by the signed-in user.
//   Body: { name?: string, mode?: 'dawless' | 'workflow' } — mode defaults
//   to 'dawless'; both dashboard create cards hit this same endpoint.
// GET  /api/rackspaces — list rackspaces the signed-in user is a member of.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  createRackspace,
  listRackspacesForUser,
  RACKSPACE_MAX_OWNED,
} from '$lib/server/rackspaces';
import type { RackMode } from '$lib/graph/rack-mode';

export const POST: RequestHandler = async ({ locals, request }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');

  let body: { name?: unknown; mode?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body or malformed JSON: fine, fall back to default */
  }
  const rawName = typeof body.name === 'string' ? body.name : 'Untitled rackspace';
  const name = rawName.slice(0, 80);
  // Mode: absent → 'dawless'. A PRESENT-but-invalid value is a 400 (don't
  // silently create the wrong kind of rack for a typo'd client).
  let mode: RackMode = 'dawless';
  if (body.mode !== undefined) {
    if (body.mode !== 'dawless' && body.mode !== 'workflow') {
      throw error(400, "mode must be 'dawless' or 'workflow'");
    }
    mode = body.mode;
  }
  const result = await createRackspace(userId, name, mode);
  if (result.status === 'cap-reached') {
    throw error(409, {
      message: `rackspace limit reached (${result.ownedCount}/${RACKSPACE_MAX_OWNED}); delete one to create a new rackspace`,
    } as App.Error);
  }
  return json({ rackspace: result.rackspace });
};

export const GET: RequestHandler = async ({ locals }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');
  const rackspaces = await listRackspacesForUser(userId);
  return json({ rackspaces });
};
