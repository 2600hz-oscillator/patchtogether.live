// Hocuspocus server — Stage B scaffold.
//
// One process serves all rackspaces. Each rackspace = one Yjs doc keyed by
// `name` in the Hocuspocus protocol; when a client connects with that name,
// Hocuspocus joins/creates the doc and starts replicating updates over the
// WebSocket.
//
// Stage B scope (this slice): in-memory doc storage, no auth (any client
// accepted), no D1 persistence. The server proves the wire works. Auth +
// persistence + per-user layout enforcement land in subsequent slices.

import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';
import { AUTH_REJECTION, verifyToken } from './auth.js';
import { CAPACITY_REJECTION, createSlotTracker } from './capacity.js';
import { isRackspaceMember, loadSnapshot, storeSnapshot } from './db.js';
import { SNAPSHOT_PERSISTENCE_CONFIG } from './snapshot-config.js';

// Port choice: 1235 instead of Hocuspocus's documented default 1234,
// because BitwigStudio (and likely other DAWs) reserve 1234 for OSC.
// Override with PORT=… for prod deploys.
const PORT = Number(process.env.PORT ?? 1235);
const HOST = process.env.HOST ?? '0.0.0.0';

// In-memory slot tracker; one process serves all rackspaces, so a single
// tracker is correct. When the server scales horizontally (post-Stage-B),
// this becomes a Durable Object or Redis-backed counter.
const slots = createSlotTracker();

Server.configure({
  port: PORT,
  address: HOST,

  // Snapshot persistence — see ./snapshot-config.ts for the rationale.
  ...SNAPSHOT_PERSISTENCE_CONFIG,

  // Auth hook runs BEFORE the WS is fully established, so it's the
  // right place to gate auth + capacity: throwing here aborts the
  // handshake and the client gets `onAuthenticationFailed`. Slots
  // acquired here are released in onDisconnect, which still fires for
  // a connection that auth'd but then dropped before fully connecting.
  //
  // Order matters: verify the token first, THEN reserve a slot. If we
  // reserved before verifying, an unauth'd attacker spamming connections
  // would fill the cap and lock out legitimate users.
  async onAuthenticate(data) {
    const auth = await verifyToken(data.token ?? '', data.documentName);
    if (!auth.ok) {
      // eslint-disable-next-line no-console
      console.log(`[hocuspocus] reject (${auth.reason}): doc=${data.documentName} sock=${data.socketId}`);
      // No message arg → `.message` is the empty string. Hocuspocus's
      // hooks() catch handler does `if (error?.message) console.error(…)`
      // — empty message skips that auto-log so we don't get a duplicate
      // of our own line above. `.reason` is what reaches the client via
      // the PermissionDenied wire format.
      const err = new Error() as Error & { reason: string };
      err.reason = auth.reason === 'invalid-format' ? AUTH_REJECTION.invalidFormat : AUTH_REJECTION.unauthorized;
      throw err;
    }

    // Membership check (the B2 promise: now that storage is shared,
    // the WS handshake can verify Clerk users actually belong to the
    // rack — closes the "any authed user can WS into any rack" gap
    // documented in PR-D).
    //
    // Anon visitors skip the lookup: their HMAC invite is itself a
    // sufficient proof of access (it can only be derived with
    // INVITE_SECRET, which only the server holds). We deliberately do
    // NOT additionally check rackspaceExists for them — orphaned
    // snapshot writes are FK-constrained against `racks` so a connect
    // for a non-existent rack id would succeed at WS-handshake time
    // but fail at first persist. That's acceptable noise for the test
    // ergonomics (Playwright tests use ephemeral rack ids without
    // seeding rows) and isn't exploitable.
    if (auth.role === 'member') {
      const allowed = await isRackspaceMember(data.documentName, auth.userId!);
      if (!allowed) {
        // eslint-disable-next-line no-console
        console.log(`[hocuspocus] reject (not-member): doc=${data.documentName} user=${auth.userId}`);
        const err = new Error() as Error & { reason: string };
        err.reason = AUTH_REJECTION.unauthorized;
        throw err;
      }
    }

    if (!slots.acquire(data.documentName, data.socketId)) {
      // eslint-disable-next-line no-console
      console.log(`[hocuspocus] reject (full): doc=${data.documentName} sock=${data.socketId}`);
      const err = new Error() as Error & { reason: string };
      err.reason = CAPACITY_REJECTION.code;
      throw err;
    }
    return {
      // Anything assigned here lands on `connection.context` for later hooks.
      userId: auth.userId,
      role: auth.role,
    };
  },

  async onConnect(data) {
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] connect: doc=${data.documentName} (${slots.size(data.documentName)}/4)`);
  },

  async onDisconnect(data) {
    slots.release(data.documentName, data.socketId);
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] disconnect: doc=${data.documentName} (${slots.size(data.documentName)}/4)`);
  },

  async onLoadDocument(data) {
    // Restore the persisted Yjs state if any. New rackspaces (no snapshot
    // row) get a fresh empty doc that Hocuspocus persists on first store.
    const snapshot = await loadSnapshot(data.documentName);
    if (!snapshot) {
      // eslint-disable-next-line no-console
      console.log(`[hocuspocus] load (fresh): doc=${data.documentName}`);
      return undefined;
    }
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, snapshot);
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] load (restored ${snapshot.byteLength} bytes): doc=${data.documentName}`);
    return ydoc;
  },

  // Hocuspocus debounces this hook per the `debounce`/`maxDebounce` config
  // above (2s normal, 5s cap), and only fires when the doc actually changed.
  // Cheap enough to write the full state every time at our scale; switch to
  // incremental updates if doc sizes grow into megabytes.
  async onStoreDocument(data) {
    const state = Y.encodeStateAsUpdate(data.document);
    await storeSnapshot(data.documentName, state);
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] persist (${state.byteLength} bytes): doc=${data.documentName}`);
  },
});

Server.listen().then(() => {
  // eslint-disable-next-line no-console
  console.log(`[hocuspocus] listening ws://${HOST}:${PORT}`);
});

// Clean shutdown on SIGTERM (Fly.io sends this on deploys).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] received ${sig}, draining…`);
    await Server.destroy();
    process.exit(0);
  });
}
