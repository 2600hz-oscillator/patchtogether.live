// packages/web/src/routes/api/test/seed-rackspace/+server.ts
//
// POST /api/test/seed-rackspace — create a fresh rackspace with a synthetic
// owner (no Clerk session required) so e2e specs can navigate to /r/[id]
// without going through the sign-in flow.
//
// HARD GATED on RACKSPACE_SEED_ENABLED === '1'. This env var is set in:
//   - the SvelteKit dev server (.env via NODE_ENV=development fallback)
//   - the autotest tier deploy (.github/workflows/deploy.yml — alongside
//     VITE_E2E_HOOKS=1)
// It is NEVER set on dev.patchtogether.live or prod.patchtogether.live, so
// the route 404s there. The reason this is a separate env var (not piggy-
// backed on NODE_ENV) is that NODE_ENV='development' is also true in some
// preview-build flows we DO ship to public URLs (vite preview etc.).
//
// Body shape:
//   {
//     name?: string,                  // defaults to 'Test rackspace <id>'
//     ownerUserId?: string,           // defaults to 'test_seed_<uuid>'
//     envelope?: PatchEnvelope        // optional: pre-populate the patch
//   }
//
// Response:
//   { id: string, inviteCode: string }
//
// The inviteCode is the same HMAC-derived bearer token /r/[id]/+page.server.ts
// expects in the ?invite=<code> query string for anon access — handing it
// back lets the spec build a URL that the unauthed Playwright context can
// navigate to without touching Clerk.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { seedRackspaceForTest } from '$lib/server/rackspaces';
import { getInviteCode } from '$lib/server/invites';

interface SeedBody {
  name?: unknown;
  ownerUserId?: unknown;
  envelope?: unknown;
}

interface EnvelopeShape {
  envelopeVersion?: unknown;
  update?: unknown;
}

function isEnvelope(v: unknown): v is EnvelopeShape & { update: string } {
  if (!v || typeof v !== 'object') return false;
  const e = v as EnvelopeShape;
  return typeof e.update === 'string';
}

function base64ToBytes(b64: string): Uint8Array {
  // atob is global on both Node 18+ and Cloudflare Workers. We deliberately
  // don't import a base64 lib — keeps this route Worker-safe.
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function isSeedEnabled(): boolean {
  // Explicit opt-in always wins (CI/autotest tier sets this in deploy.yml).
  if (env.RACKSPACE_SEED_ENABLED === '1') return true;
  // Vite dev server sets NODE_ENV=development unconditionally; local
  // contributors then don't need to fiddle with .env to run e2e specs.
  // CF Pages prod/preview builds DO NOT set NODE_ENV=development, so this
  // branch is unreachable from any deployed environment.
  if (env.NODE_ENV === 'development') return true;
  return false;
}

export const POST: RequestHandler = async ({ request }) => {
  if (!isSeedEnabled()) {
    // 404 (not 403) so a probe from prod looks like a missing route, not a
    // disabled-but-present endpoint that someone could try to brute-force
    // a credential against. There IS no credential — the gate is binary on
    // env vars — but symmetric 404s avoid leaking the shape.
    throw error(404, 'not found');
  }

  let body: SeedBody = {};
  try {
    body = (await request.json()) as SeedBody;
  } catch {
    // Empty body is fine — caller wants the defaults.
  }

  const name = typeof body.name === 'string' ? body.name.slice(0, 80) : `Test rackspace ${Date.now()}`;
  // Synthetic owner namespaced with `test_seed_` so anything that scans the
  // racks table can filter these out. `crypto.randomUUID()` is global on
  // Workers + Node 19+.
  const ownerUserId = typeof body.ownerUserId === 'string'
    ? body.ownerUserId
    : `test_seed_${crypto.randomUUID()}`;

  let snapshot: Uint8Array | null = null;
  if (body.envelope !== undefined && body.envelope !== null) {
    if (!isEnvelope(body.envelope)) {
      throw error(400, 'envelope.update must be a base64 string');
    }
    try {
      snapshot = base64ToBytes(body.envelope.update);
    } catch (e) {
      throw error(400, `failed to decode envelope.update: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const rack = await seedRackspaceForTest({ ownerUserId, name, snapshot });
  const inviteCode = await getInviteCode(rack.id);

  return json({ id: rack.id, inviteCode });
};
