// packages/web/src/routes/api/saved-groups/+server.ts
//
// POST /api/saved-groups
//   Body: { label: string, payload: SavedGroupPayload }
//   Saves a group snippet under the signed-in user's library.
//   401 unauthenticated, 400 bad shape, 409 per-user cap reached,
//   413 payload exceeds size cap.
//
// GET  /api/saved-groups
//   Returns the signed-in user's library, newest first.
//   401 unauthenticated.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  saveGroup,
  listSavedGroupsForUser,
  SAVED_GROUP_LABEL_MAX,
  SAVED_GROUP_MAX_PAYLOAD_BYTES,
  SAVED_GROUP_MAX_PER_USER,
  type SavedGroupPayload,
} from '$lib/server/saved-groups';

interface SaveBody {
  label?: unknown;
  payload?: unknown;
}

function validatePayload(value: unknown): SavedGroupPayload | string {
  if (!value || typeof value !== 'object') return 'payload must be an object';
  const p = value as Partial<SavedGroupPayload>;
  if (typeof p.label !== 'string' || p.label.length === 0) {
    return 'payload.label must be a non-empty string';
  }
  if (!Array.isArray(p.exposedPorts)) return 'payload.exposedPorts must be an array';
  if (!Array.isArray(p.children)) return 'payload.children must be an array';
  if (!Array.isArray(p.internalEdges)) return 'payload.internalEdges must be an array';
  for (const c of p.children) {
    if (!c || typeof c !== 'object') return 'every child must be an object';
    const node = c as { id?: unknown; type?: unknown; domain?: unknown };
    if (typeof node.id !== 'string' || typeof node.type !== 'string' || typeof node.domain !== 'string') {
      return 'each child needs string id + type + domain';
    }
  }
  return value as SavedGroupPayload;
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');

  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    throw error(400, 'invalid JSON body');
  }

  if (typeof body.label !== 'string') {
    throw error(400, 'label must be a string');
  }
  const label = body.label.trim();
  if (label.length === 0) throw error(400, 'label is required');
  if (label.length > SAVED_GROUP_LABEL_MAX) {
    throw error(400, `label exceeds ${SAVED_GROUP_LABEL_MAX} characters`);
  }

  const validated = validatePayload(body.payload);
  if (typeof validated === 'string') {
    throw error(400, validated);
  }

  const serialized = JSON.stringify(validated);
  if (serialized.length > SAVED_GROUP_MAX_PAYLOAD_BYTES) {
    const actualKB = Math.ceil(serialized.length / 1024);
    const capMB = Math.round((SAVED_GROUP_MAX_PAYLOAD_BYTES / (1024 * 1024)) * 10) / 10;
    throw error(
      413,
      `Group too large (${actualKB} KB exceeds the ${capMB} MB cap). Try removing modules that carry large data (SAMSLOOP/CLOUDSEED instances with loaded samples).`,
    );
  }

  const result = await saveGroup(userId, label, validated);
  if (result.status === 'cap-reached') {
    throw error(409, {
      message: `saved-group cap reached (${result.count}/${SAVED_GROUP_MAX_PER_USER}); delete one to save a new group`,
    } as App.Error);
  }
  return json({ savedGroup: result.savedGroup });
};

export const GET: RequestHandler = async ({ locals }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');
  const savedGroups = await listSavedGroupsForUser(userId);
  return json({ savedGroups });
};
