// packages/web/src/lib/server/feedback.ts
//
// Feedback data layer — Neon HTTP API. One row per submission.
//
// kind ∈ {'suggestion', 'bug'} qualifies the message; the column stays
// named `suggestion` because it's the message body either way.
//
// patch_json is optional jsonb — captured client-side so we can reproduce
// what the user was looking at when they hit submit. Stored as-is; we
// don't validate its shape (the patch envelope format evolves and we
// want forward-compat for old submissions).
//
// Single-statement INSERT keeps us inside the HTTP API's no-multi-stmt
// constraint (see ./db.ts).

import { sql } from './db.js';

export type FeedbackKind = 'suggestion' | 'bug';

export const FEEDBACK_MAX_LENGTH = 512;

export async function recordFeedback(
  userId: string,
  rackId: string | null,
  kind: FeedbackKind,
  message: string,
  patchJson: unknown,
): Promise<{ id: number }> {
  // Postgres jsonb: pass null when caller didn't include a snapshot;
  // otherwise stringify to JSON text and let pg coerce on insert. We
  // can't use the pg jsonb literal directly through the HTTP tagged
  // template (it always type-infers from the JS value), so go through
  // text + ::jsonb cast on the column.
  const patchText = patchJson === undefined || patchJson === null
    ? null
    : JSON.stringify(patchJson);

  const rows = (await sql()`
    INSERT INTO feedback (user_id, rack_id, kind, suggestion, patch_json)
    VALUES (
      ${userId},
      ${rackId},
      ${kind},
      ${message},
      ${patchText}::jsonb
    )
    RETURNING id
  `) as Array<{ id: number | string }>;

  // Neon's HTTP client returns BIGINT as a string in some versions and
  // number in others. Normalize.
  const raw = rows[0].id;
  return { id: typeof raw === 'string' ? Number(raw) : raw };
}
