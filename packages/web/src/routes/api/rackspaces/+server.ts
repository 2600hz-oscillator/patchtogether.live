// packages/web/src/routes/api/rackspaces/+server.ts
//
// POST /api/rackspaces — create a new rackspace owned by the signed-in user.
// GET  /api/rackspaces — list rackspaces the signed-in user is a member of.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createRackspace, listRackspacesForUser } from '$lib/server/rackspaces';

export const POST: RequestHandler = async ({ locals, request }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');

  let body: { name?: string } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body fine */
  }
  const name = (body.name ?? 'Untitled rackspace').slice(0, 80);
  const rackspace = createRackspace(userId, name);
  return json({ rackspace });
};

export const GET: RequestHandler = ({ locals }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');
  const rackspaces = listRackspacesForUser(userId);
  return json({ rackspaces });
};
