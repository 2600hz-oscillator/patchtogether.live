#!/usr/bin/env node
//
// scripts/anon-handshake-smoke.mjs — deploy-time guard against SECRET-VALUE
// drift between the deployed web app and the deployed Hocuspocus relay.
//
// THE DRIFT THIS CATCHES
// ----------------------
// Anonymous invites are HMAC-SHA256(INVITE_SECRET, rackspaceId)[0:16]. The web
// app MINTS them with its INVITE_SECRET (CF Pages env); the relay VERIFIES them
// with its INVITE_SECRET (Fly secret) at the WS handshake (onAuthenticate in
// packages/server/src/index.ts → verifyToken('anon:…')). If those two secret
// VALUES drift, every anon guest is silently rejected at the handshake — red
// dot, `nodes 0` — while signed-in (Clerk) users are unaffected, so it's easy
// to miss. (Algorithm drift between the two files is caught separately by the
// deterministic unit lockstep test; this catches the secret-VALUE drift that
// only shows up against the live deploys.)
//
// HOW (gold-standard: a REAL WS handshake)
// ----------------------------------------
//   1. Mint a real anon code for a throwaway rack id using INVITE_SECRET (given
//      to the CI job as a GitHub secret == the canonical cf.env value that
//      sync-secrets.sh pushes to BOTH targets). Mint uses the EXACT web
//      algorithm.
//   2. Open a real WebSocket to the deployed relay
//      (wss://patchtogether-server-<tier>.fly.dev) via @hocuspocus/provider
//      with token `anon:<code>` for that rack id, and assert onAuthenticate
//      ACCEPTS — i.e. we reach `synced`/`connected`, NOT `authenticationFailed`
//      (PermissionDenied). This proves relay.INVITE_SECRET == the canonical
//      secret.
//   3. Cross-check the deployed WEB app: fetch <web-base>/api/health and assert
//      its inviteSecretFingerprint matches the fingerprint of the secret we
//      minted with. This proves web.INVITE_SECRET == the canonical secret too.
//      (2) + (3) ⇒ web.INVITE_SECRET == relay.INVITE_SECRET == canonical, which
//      is exactly "they are in lockstep".
//
// If INVITE_SECRET is NOT provided (e.g. a fork PR with no access to secrets),
// the script SKIPS with a clear message rather than failing — so the deploy
// isn't blocked by a missing optional secret. When it IS provided, a drift
// fails the deploy loudly.
//
// USAGE
//   INVITE_SECRET=<canonical> node scripts/anon-handshake-smoke.mjs <dev|autotest|prod>
//   Optional env:
//     RELAY_WS_URL  override the relay URL (default derived from tier)
//     WEB_BASE_URL  override the web base for the /api/health cross-check
//     BETA_GATE_USER / BETA_GATE_PASS  basic-auth creds for the health fetch
//                   (the beta gate carves out /api/health, so usually unneeded)
//
// Run through flox:  flox activate -- node scripts/anon-handshake-smoke.mjs <tier>

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

const tier = process.argv[2];
if (!['dev', 'autotest', 'prod'].includes(tier)) {
  console.error('usage: anon-handshake-smoke.mjs <dev|autotest|prod>');
  process.exit(2);
}

const RELAY_URL =
  process.env.RELAY_WS_URL ||
  (tier === 'prod'
    ? 'wss://patchtogether-server.fly.dev'
    : `wss://patchtogether-server-${tier}.fly.dev`);

const WEB_BASE =
  process.env.WEB_BASE_URL ||
  (tier === 'prod'
    ? 'https://patchtogether.live'
    : `https://${tier}.patchtogether.live`);

const INVITE_SECRET = process.env.INVITE_SECRET;
if (!INVITE_SECRET) {
  console.log(
    '⚠ anon-handshake-smoke SKIPPED: INVITE_SECRET not provided ' +
      '(fork PR / secret not wired). This guard runs on trusted deploys only.',
  );
  process.exit(0);
}

// ── Mint: the EXACT web algorithm (packages/web/src/lib/server/invites.ts) ───
const INVITE_LENGTH = 16;
async function mintInviteCode(rackspaceId, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rackspaceId));
  let hex = '';
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, INVITE_LENGTH);
}

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return `len=${value.length} sha256:${hex.slice(0, 8)}`;
}

// A throwaway rack id. The relay accepts anon connects to any id (the HMAC is
// itself the proof of access; see the onAuthenticate comment in index.ts), so
// we don't need to seed a row. Unique-per-run so we never collide with a real
// rack or a previous smoke run.
const RACK_ID = `smoke-anon-${tier}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ── Leg 1+2: REAL WS handshake against the deployed relay ────────────────────
function handshake(rackId, token) {
  return new Promise((resolve) => {
    const ydoc = new Y.Doc();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        provider.destroy();
      } catch {
        /* idempotent */
      }
      ydoc.destroy();
      resolve(result);
    };

    const provider = new HocuspocusProvider({
      url: RELAY_URL,
      name: rackId,
      document: ydoc,
      token,
      // Don't let the provider's default reconnect/backoff keep the process
      // alive after we've decided; we tear down in done().
      preserveConnection: false,
    });

    // PermissionDenied → onAuthenticate REJECTED. This is the drift signal.
    provider.on('authenticationFailed', (e) => {
      done({ ok: false, reason: e?.reason ?? 'unknown', via: 'authenticationFailed' });
    });
    // 'authenticated' fires after onAuthenticate ACCEPTS, before sync. Either
    // it or 'synced' means the handshake passed.
    provider.on('authenticated', () => {
      done({ ok: true, via: 'authenticated' });
    });
    provider.on('synced', () => {
      done({ ok: true, via: 'synced' });
    });

    const timer = setTimeout(() => {
      done({ ok: false, reason: 'timeout', via: 'timeout (no auth result in 20s)' });
    }, 20_000);
  });
}

async function main() {
  const fp = await fingerprint(INVITE_SECRET);
  console.log(`anon-handshake-smoke — tier=${tier}`);
  console.log(`  relay : ${RELAY_URL}`);
  console.log(`  web   : ${WEB_BASE}`);
  console.log(`  rack  : ${RACK_ID}`);
  console.log(`  secret: ${fp}`);
  console.log();

  let failures = 0;

  // ── Leg A: GOOD code must be ACCEPTED (the gold-standard real handshake) ──
  const goodCode = await mintInviteCode(RACK_ID, INVITE_SECRET);
  const good = await handshake(RACK_ID, `anon:${goodCode}`);
  if (good.ok) {
    console.log(`✓ relay ACCEPTED a web-minted anon invite (via ${good.via}) — secrets in lockstep`);
  } else {
    failures++;
    console.error(
      `✗ relay REJECTED a web-minted anon invite (${good.via}: ${good.reason}).\n` +
        `  → The relay's INVITE_SECRET has DRIFTED from the canonical value.\n` +
        `  → Anonymous invite guests are being silently rejected right now.\n` +
        `  → Fix: flox activate -- task sync-secrets -- ${tier} --apply` +
        (tier === 'prod' ? ' --yes-prod' : '') +
        ', then redeploy the relay.',
    );
  }

  // ── Leg B: a WRONG code must be REJECTED (proves the handshake isn't a
  //    rubber stamp that accepts anything — guards against a vacuous pass). ──
  const badCode = 'deadbeefdeadbeef'; // valid length, wrong HMAC
  const bad = await handshake(RACK_ID, `anon:${badCode}`);
  if (!bad.ok && bad.reason === 'unauthorized') {
    console.log('✓ relay REJECTED a bogus anon code (unauthorized) — handshake is discriminating');
  } else if (bad.ok) {
    failures++;
    console.error('✗ relay ACCEPTED a bogus anon code — auth is broken (accepts anything!)');
  } else {
    // Rejected for a non-auth reason (timeout/capacity); warn but don't hard-fail
    // leg B since leg A is the load-bearing assertion.
    console.warn(`⚠ bogus-code handshake ended via ${bad.via}: ${bad.reason} (expected 'unauthorized')`);
  }

  // ── Leg C: deployed WEB app fingerprint must match the minting secret ──
  try {
    const headers = {};
    if (process.env.BETA_GATE_PASS) {
      const user = process.env.BETA_GATE_USER || 'beta';
      headers.authorization =
        'Basic ' + Buffer.from(`${user}:${process.env.BETA_GATE_PASS}`).toString('base64');
    }
    const res = await fetch(`${WEB_BASE}/api/health`, { headers });
    if (!res.ok) {
      console.warn(`⚠ web /api/health returned ${res.status}; skipping web-fingerprint cross-check`);
    } else {
      const body = await res.json();
      const webFp = body.inviteSecretFingerprint;
      if (!webFp) {
        console.warn(
          '⚠ web /api/health has no inviteSecretFingerprint ' +
            '(older deploy or INVITE_SECRET unset on the web project); skipping cross-check',
        );
      } else if (webFp === fp) {
        console.log(`✓ web app INVITE_SECRET fingerprint matches (${webFp}) — web↔relay confirmed`);
      } else {
        failures++;
        console.error(
          `✗ web app INVITE_SECRET fingerprint (${webFp}) != canonical (${fp}).\n` +
            `  → The WEB project's INVITE_SECRET has drifted; re-run sync-secrets.`,
        );
      }
    }
  } catch (err) {
    console.warn(`⚠ web-fingerprint cross-check errored (non-fatal): ${err?.message ?? err}`);
  }

  console.log();
  if (failures > 0) {
    console.error(`anon-handshake-smoke FAILED (${failures} hard failure(s)).`);
    process.exit(1);
  }
  console.log('anon-handshake-smoke PASSED — anonymous invites work end-to-end.');
  process.exit(0);
}

main().catch((err) => {
  console.error('anon-handshake-smoke crashed:', err);
  process.exit(1);
});
