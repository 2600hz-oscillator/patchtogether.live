// Temporary diagnostic endpoint to debug Workers→Neon HTTP failures.
// Returns:
//   - Whether DATABASE_URL is set, its prefix, and the parsed hostname
//   - Result of a raw fetch() to https://<host>/sql (without the Neon
//     client wrapper), so we can see what CF/Neon actually returns
//   - Result of a `sql\`SELECT 1\`` via the Neon HTTP client
// REMOVE THIS FILE once the issue is diagnosed.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { neon } from '@neondatabase/serverless';

export const GET: RequestHandler = async () => {
  const url = process.env.DATABASE_URL;
  const out: Record<string, unknown> = {
    has_DATABASE_URL: Boolean(url),
    DATABASE_URL_length: url?.length ?? 0,
    DATABASE_URL_prefix: url ? url.slice(0, 20) : null,
  };
  if (!url) return json(out);

  try {
    const u = new URL(url);
    out.parsed_host = u.hostname;
    out.parsed_protocol = u.protocol;
  } catch (e) {
    out.parse_error = String(e);
    return json(out);
  }

  // Test 1: raw fetch with empty body (should be a Neon-shape error, not CF 1003)
  try {
    const u = new URL(url);
    const resp = await fetch(`https://${u.hostname}/sql`, { method: 'POST', body: '{}' });
    const txt = await resp.text();
    out.raw_fetch_status = resp.status;
    out.raw_fetch_body = txt.slice(0, 200);
  } catch (e) {
    out.raw_fetch_error = String(e);
  }

  // Test 2: actual Neon client query
  try {
    const sql = neon(url);
    const rows = await sql`SELECT 1 AS ok`;
    out.neon_client_result = rows;
  } catch (e) {
    out.neon_client_error = String(e);
  }

  return json(out);
};
