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
import { CAPACITY_REJECTION, createSlotTracker } from './capacity';

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

  // Auth hook runs BEFORE the WS is fully established, so it's the
  // right place to gate capacity: throwing here aborts the handshake
  // and the client gets `onAuthenticationFailed`. Slots acquired here
  // are released in onDisconnect, which still fires for a connection
  // that auth'd but then dropped before fully connecting.
  //
  // STAGE-B-PR-A: token verification stub-accepts. STAGE-B-PR-D will:
  // verify Clerk session via @clerk/backend OR a valid invite-code
  // token from PR-B-c, then populate context.userId for later hooks.
  async onAuthenticate(data) {
    if (!slots.acquire(data.documentName, data.socketId)) {
      // eslint-disable-next-line no-console
      console.log(`[hocuspocus] reject (full): doc=${data.documentName} sock=${data.socketId}`);
      // Hocuspocus's auth-rejection wire format pulls `error.reason`
      // (NOT `error.message`) and writes it as the PermissionDenied
      // payload — so the rejection string the client sees is whatever
      // we set here. The provider's onAuthenticationFailed handler
      // matches against CAPACITY_REJECTION_CODE to route the user to
      // the /full page.
      // No message arg → `.message` is the empty string. Hocuspocus's
      // hooks() catch handler does `if (error?.message) console.error(…)`
      // — empty message skips that auto-log so we don't get a duplicate
      // of our own `reject (full)` line above.
      const err = new Error() as Error & { reason: string };
      err.reason = CAPACITY_REJECTION.code;
      throw err;
    }
    return {
      // Anything assigned here lands on `connection.context` for later hooks.
      // PR-D will populate userId from the Clerk JWT or an anon invite code
      // and use it for membership checks.
      userId: 'stub-user',
      role: 'performer' as const,
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
    // STAGE-B-PR-C will: load Y.encodeStateAsUpdate snapshot from D1 here.
    // For now: return undefined so Hocuspocus creates a fresh doc in-memory.
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] load (in-memory): doc=${data.documentName}`);
    return undefined;
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
