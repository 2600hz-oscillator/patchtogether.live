// packages/web/src/routes/api/feedback/+server.ts
//
// POST /api/feedback — record a user feedback submission.
// Body shape:
//   {
//     kind: 'suggestion' | 'bug',
//     message: string (1..512),
//     rackId?: string | null,
//     patchJson?: unknown,
//   }
//
// Constraints:
//   - Auth: required (Clerk userId from locals.auth())
//   - kind: required, must be 'suggestion' or 'bug'
//   - message: 1..512 chars after trim
//   - rackId: optional; if provided, must be a string (FK validity is
//     enforced by the DB — invalid ids ON DELETE SET NULL ⇒ but we don't
//     verify membership, deliberately. Any authed user can attach any
//     rackId to feedback; worst case is a row pointing at a rack they
//     don't own, which is fine for our reporting use case.)
//   - patchJson: optional; capped at 64 KB (JSON.stringify length)

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recordFeedback, FEEDBACK_MAX_LENGTH, type FeedbackKind } from '$lib/server/feedback';

const MAX_PATCH_JSON_BYTES = 64 * 1024;

interface FeedbackBody {
  kind?: unknown;
  message?: unknown;
  rackId?: unknown;
  patchJson?: unknown;
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const { userId } = locals.auth();
  if (!userId) throw error(401, 'unauthorized');

  let body: FeedbackBody;
  try {
    body = (await request.json()) as FeedbackBody;
  } catch {
    throw error(400, 'invalid JSON body');
  }

  // kind: required, enum-checked.
  if (body.kind !== 'suggestion' && body.kind !== 'bug') {
    throw error(400, "kind must be 'suggestion' or 'bug'");
  }
  const kind = body.kind as FeedbackKind;

  // message: required string, 1..MAX after trim.
  if (typeof body.message !== 'string') {
    throw error(400, 'message must be a string');
  }
  const message = body.message.trim();
  if (message.length === 0) {
    throw error(400, 'message is required');
  }
  if (message.length > FEEDBACK_MAX_LENGTH) {
    throw error(400, `message exceeds ${FEEDBACK_MAX_LENGTH} characters`);
  }

  // rackId: optional string or null.
  let rackId: string | null = null;
  if (body.rackId !== undefined && body.rackId !== null) {
    if (typeof body.rackId !== 'string') {
      throw error(400, 'rackId must be a string when provided');
    }
    rackId = body.rackId;
  }

  // patchJson: optional unknown JSON value, capped at MAX_PATCH_JSON_BYTES.
  let patchJson: unknown = null;
  if (body.patchJson !== undefined && body.patchJson !== null) {
    let serialized: string;
    try {
      serialized = JSON.stringify(body.patchJson);
    } catch {
      throw error(400, 'patchJson is not serializable');
    }
    if (serialized.length > MAX_PATCH_JSON_BYTES) {
      throw error(413, `patchJson exceeds ${MAX_PATCH_JSON_BYTES} bytes`);
    }
    patchJson = body.patchJson;
  }

  const result = await recordFeedback(userId, rackId, kind, message, patchJson);
  return json({ id: result.id });
};
