// packages/web/src/routes/api/rackspaces/+server.ts
//
// POST /api/rackspaces — create a new rackspace owned by the signed-in user.
// GET  /api/rackspaces — list rackspaces the signed-in user is a member of.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createRackspace, listRackspacesForUser } from '$lib/server/rackspaces';

export const POST: RequestHandler = async ({ locals, request, platform }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');

  let body: { name?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body or malformed JSON: fine, fall back to default */
  }
  // Defensive: malformed JSON could yield body.name as number/object/null.
  // Only string-typed names get through; everything else falls back.
  const rawName = typeof body.name === 'string' ? body.name : 'Untitled rackspace';
  const name = rawName.slice(0, 80);
  const rackspace = await createRackspace(userId, name, platform?.env);
  return json({ rackspace });
};

export const GET: RequestHandler = async ({ locals, platform }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');
  const rackspaces = await listRackspacesForUser(userId, platform?.env);
  return json({ rackspaces });
};
