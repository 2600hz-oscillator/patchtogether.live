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
import { isRackspaceMember, loadSnapshot, rackspaceExists, storeSnapshot } from './db.js';
import { checkRackAccess } from './rack-access.js';
import { SNAPSHOT_PERSISTENCE_CONFIG } from './snapshot-config.js';
import { createHeartbeatExtension } from './heartbeat.js';
import { createIntrospectionExtension } from './http-introspection.js';
import { startReaper, type LiveConnectionSource } from './reaper.js';

// Port choice: 1235 instead of Hocuspocus's documented default 1234,
// because BitwigStudio (and likely other DAWs) reserve 1234 for OSC.
// Override with PORT=… for prod deploys.
const PORT = Number(process.env.PORT ?? 1235);
const HOST = process.env.HOST ?? '0.0.0.0';

// Last-resort guard: the relay serves EVERY rack from one long-lived process,
// so a single unhandled promise rejection bringing the process down (node's
// default since v15) takes every connected rack with it — that's the
// tab-switch 500 the operator hit (a transient pg auth timeout in the
// debounced onStoreDocument went unhandled, node exited 1, the Fly machine
// rebooted, in-flight WS/HTTP got connection-reset). The specific path is
// fixed at the source (db.ts swallows transient persist errors + a pool
// 'error' listener), but a long-running collab server must never crash on a
// background async failure. Log loudly + stay up; Fly health checks + the
// reaper keep the process honest.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[hocuspocus] unhandledRejection (relay stays up):', reason);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[hocuspocus] uncaughtException (relay stays up):', err);
});

// In-memory slot tracker; one process serves all rackspaces, so a single
// tracker is correct. When the server scales horizontally (post-Stage-B),
// this becomes a Durable Object or Redis-backed counter.
const slots = createSlotTracker();

// HTTP introspection (/health + /metrics + memory-alarm log lines) needs
// to read live conn/room counts from the Hocuspocus instance, but the
// instance isn't constructed until after `Server.configure(…)` runs. We
// build the extension with a lazy proxy that resolves to the real instance
// the moment `extensions:` is evaluated (after the Server singleton is
// already set up). The Hocuspocus `Server` export IS the singleton; it
// has the count methods we need.
const introspection = createIntrospectionExtension({
  getConnectionsCount: () => Server.getConnectionsCount(),
  getDocumentsCount: () => Server.getDocumentsCount(),
});

const hocuspocus = Server.configure({
  port: PORT,
  address: HOST,

  // Heartbeat extension: per-doc Awareness broadcast at 1 Hz steady-state /
  // 8 Hz burst on connect. Clients use these for clock-sync (Phase 0 of the
  // shared-state-sync plan).
  // HTTP introspection: /health + /metrics + 30-s memory alarm log lines.
  // See ./http-introspection.ts for the rationale (relay OOM that went
  // unalerted is the urgency; this slice surfaces the warning early).
  extensions: [createHeartbeatExtension(), introspection],

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

    // Post-auth access gate (see ./rack-access.ts):
    //   - clerk users: must be a member of the rack (closes the PR-D
    //     "any authed user can WS any rack" gap)
    //   - anon HMAC-invite users: in PROD, the rack must actually exist
    //     (prevents empty-Yjs-doc memory pressure from attackers churning
    //     valid invites for bogus rack ids). DEV/TEST bypass so Playwright
    //     @collab specs can connect with ephemeral rack ids.
    const decision = await checkRackAccess(auth, data.documentName, {
      isRackspaceMember,
      rackspaceExists,
    });
    if (decision !== 'ok') {
      // eslint-disable-next-line no-console
      console.log(
        `[hocuspocus] reject (${decision}): doc=${data.documentName}` +
          (auth.userId ? ` user=${auth.userId}` : ''),
      );
      const err = new Error() as Error & { reason: string };
      err.reason = AUTH_REJECTION.unauthorized;
      throw err;
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

// Periodic slot-leak reaper: reconciles the in-memory slot tracker against
// Hocuspocus's live connections so a socket that died without a clean close
// (crashed tab, network drop, machine killed mid-connection) can't leave a
// ghost slot that eventually pins a rack at 4/4 → reject(full). See
// ./reaper.ts. `hocuspocus.documents` is the live Map<name, Document>.
const reaper = startReaper(slots, hocuspocus as unknown as LiveConnectionSource, {
  // eslint-disable-next-line no-console
  log: (msg) => console.log(msg),
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
    reaper.stop();
    await Server.destroy();
    process.exit(0);
  });
}
