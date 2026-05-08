// packages/web/src/lib/server/feedback.test.ts
//
// Unit test for recordFeedback. Mocks the Neon HTTP client tagged template
// so we exercise the parameter-binding path without needing a live DB.
//
// The "round-trips through DB" assertion lives in the E2E suite where an
// actual Postgres backend (Neon dev branch / local PG) is available; this
// unit test pins down the SQL-binding shape so a regression in column
// ordering or jsonb cast is caught before E2E runs.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CapturedQuery {
  strings: TemplateStringsArray;
  values: unknown[];
}
const captured: CapturedQuery[] = [];
const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => {
  captured.push({ strings, values });
  return Promise.resolve([{ id: 7 }]);
};

vi.mock('./db', () => ({
  sql: () => sqlTag,
}));

const { recordFeedback } = await import('./feedback');

describe('recordFeedback', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('binds user_id, rack_id, kind, suggestion, and patch_json (jsonb-cast string)', async () => {
    const patch = { hello: 'world' };
    const out = await recordFeedback('user_xyz', 'r_abc', 'suggestion', 'looks good', patch);
    expect(out).toEqual({ id: 7 });
    expect(captured).toHaveLength(1);
    const q = captured[0];
    expect(q.values).toEqual([
      'user_xyz',
      'r_abc',
      'suggestion',
      'looks good',
      JSON.stringify(patch),
    ]);
    // The query must hit the feedback table and return the new id.
    const flat = q.strings.join('?');
    expect(flat).toMatch(/INSERT INTO feedback/i);
    expect(flat).toMatch(/RETURNING id/i);
    // patch_json placeholder is jsonb-cast — keeps the column's jsonb type.
    expect(flat).toMatch(/::jsonb/);
  });

  it('passes null patch_json when caller omits it', async () => {
    await recordFeedback('user_a', null, 'bug', 'broken', null);
    expect(captured[0].values).toEqual(['user_a', null, 'bug', 'broken', null]);
  });

});
