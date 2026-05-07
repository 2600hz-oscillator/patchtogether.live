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

// Port choice: 1235 instead of Hocuspocus's documented default 1234,
// because BitwigStudio (and likely other DAWs) reserve 1234 for OSC.
// Override with PORT=… for prod deploys.
const PORT = Number(process.env.PORT ?? 1235);
const HOST = process.env.HOST ?? '0.0.0.0';

Server.configure({
  port: PORT,
  address: HOST,

  // Auth hook. STAGE-B-PR-A: accept everything (closed-loop testing only).
  // STAGE-B-PR-B will: verify Clerk session via @clerk/backend, look up
  // rackspace_members, reject non-members, populate context.userId.
  async onAuthenticate(data) {
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] auth (stub-accept): doc=${data.documentName} token=${data.token ? data.token.slice(0, 8) + '…' : '<none>'}`);
    return {
      // Anything assigned here lands on `connection.context` for later hooks.
      userId: 'stub-user',
      role: 'performer' as const,
    };
  },

  async onConnect(data) {
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] connect: doc=${data.documentName}`);
  },

  async onDisconnect(data) {
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] disconnect: doc=${data.documentName}`);
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
