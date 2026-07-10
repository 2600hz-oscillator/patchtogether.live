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
import {
  isRackspaceMember,
  persistenceMode,
  rackspaceExists,
  shouldFailFast,
} from './db.js';
import {
  appendJournalUpdate,
  compactJournal,
  latestJournalSeq,
  loadJournalUpdates,
} from './journal.js';
import { createSnapshotStore } from './snapshot-store.js';
import { checkRackAccess } from './rack-access.js';
import { SNAPSHOT_PERSISTENCE_CONFIG } from './snapshot-config.js';
import { createHeartbeatExtension } from './heartbeat.js';
import { createIntrospectionExtension } from './http-introspection.js';
import { startReaper, type LiveConnectionSource } from './reaper.js';
import { RELAY_BOOT_ID } from './boot-id.js';
import {
  getUncaughtExceptionCount,
  getUnhandledRejectionCount,
  installRelayProcessGuards,
} from './relay-error-handlers.js';
import { createRackAccountant, readRackMemThresholds } from './rack-accounting.js';

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
//
// Phase 2c: each handler now emits a single-line, machine-parseable tagged log
// (`event=relay_uncaught_exception` / `event=relay_unhandled_rejection`, with the
// error msg/stack + the relay boot_id) so log-based alerting (PR #74) can page on
// any occurrence, and bumps a per-process counter surfaced on /metrics. The
// stays-up semantics are unchanged. See ./relay-error-handlers.ts.
installRelayProcessGuards();

// In-memory slot tracker; one process serves all rackspaces, so a single
// tracker is correct. When the server scales horizontally (post-Stage-B),
// this becomes a Durable Object or Redis-backed counter.
const slots = createSlotTracker();

// Per-rack memory accounting: attributes doc memory to individual racks so
// the pre-OOM alarm names the offender (the process-RSS alarm alone says
// "the relay is big", not WHICH rack). Fed from the onLoadDocument /
// onChange / onStoreDocument hooks below; the roll-up is surfaced on
// /metrics and folded into `alert_state` so the existing Better Stack
// keyword monitors catch a runaway rack. See ./rack-accounting.ts.
const rackAccountant = createRackAccountant({
  thresholds: readRackMemThresholds(),
  // eslint-disable-next-line no-console
  log: (level, msg) => console[level === 'error' ? 'error' : 'warn'](msg),
  bootId: RELAY_BOOT_ID,
});

// Snapshot blob storage behind the backend-picking abstraction: R2 when the
// four R2_* env vars are set (blobs in object storage — the correct shape at
// the ~25MB/rack ceiling), else the existing Postgres/memory path from
// db.ts. See ./snapshot-store.ts for the fallback/migration semantics.
const snapshots = createSnapshotStore();

// HTTP introspection (/health + /metrics + memory-alarm log lines) needs
// to read live conn/room counts from the Hocuspocus instance, but the
// instance isn't constructed until after `Server.configure(…)` runs. We
// build the extension with a lazy proxy that resolves to the real instance
// the moment `extensions:` is evaluated (after the Server singleton is
// already set up). The Hocuspocus `Server` export IS the singleton; it
// has the count methods we need.
const introspection = createIntrospectionExtension(
  {
    getConnectionsCount: () => Server.getConnectionsCount(),
    getDocumentsCount: () => Server.getDocumentsCount(),
    // Snapshot-store mode ('r2' | 'postgres' | 'memory') — reflects the
    // blob backend the abstraction resolved at boot, not just db.ts.
    getPersistenceMode: () => snapshots.mode(),
    // Phase 2c: surface the process-level error counters on /metrics so a
    // log-alert can be paired with a scrape-side count of how many times the
    // relay caught (and stayed up through) an uncaught exception / unhandled
    // rejection since boot. See ./relay-error-handlers.ts.
    getUncaughtExceptions: getUncaughtExceptionCount,
    getUnhandledRejections: getUnhandledRejectionCount,
    // Per-rack memory roll-up (largest rack, over-threshold counts, worst
    // level) for /metrics + the alert_state fold. See ./rack-accounting.ts.
    getRackMemSummary: () => rackAccountant.summary(),
  },
  // Reuse the single process-wide boot id so the boot_id on /health + /metrics
  // matches the boot_id stamped on the tagged error log lines for correlation.
  { bootId: RELAY_BOOT_ID },
);

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
    // Restore the persisted Yjs state if any, then REPLAY the per-update
    // journal on top — rows newer than the snapshot are edits a crash
    // stranded between snapshot debounces; rows the snapshot already
    // contains re-apply as no-ops (Yjs updates are idempotent). New
    // rackspaces (no snapshot row + no journal) get a fresh empty doc.
    const snapshot = await snapshots.load(data.documentName);
    const journal = await loadJournalUpdates(data.documentName);
    if (!snapshot && journal.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[hocuspocus] load (fresh): doc=${data.documentName}`);
      return undefined;
    }
    const ydoc = new Y.Doc();
<<<<<<< HEAD
    if (snapshot) Y.applyUpdate(ydoc, snapshot);
    let replayed = 0;
    for (const entry of journal) {
      try {
        Y.applyUpdate(ydoc, entry.update);
        replayed += 1;
      } catch (err) {
        // One corrupt row must not sink the whole doc — skip it, keep the
        // snapshot + remaining rows. (Corruption here would mean a torn
        // bytea write; never observed, but the load path must be total.)
        // eslint-disable-next-line no-console
        console.error(
          `[hocuspocus] journal replay skipped corrupt row seq=${entry.seq}: doc=${data.documentName} ` +
            `${(err as Error).message}`,
        );
      }
    }
=======
    Y.applyUpdate(ydoc, snapshot);
    // Seed the per-rack accounting with the restored size so an already-huge
    // rack alarms at load, not only on its first store.
    rackAccountant.recordSnapshot(data.documentName, snapshot.byteLength);
>>>>>>> origin/main
    // eslint-disable-next-line no-console
    console.log(
      `[hocuspocus] load (restored ${snapshot?.byteLength ?? 0} bytes + ${replayed} journal rows): ` +
        `doc=${data.documentName}`,
    );
    return ydoc;
  },

<<<<<<< HEAD
  // Fires once per incremental Yjs update applied to a loaded doc. Append
  // it to the crash journal — fire-and-forget so a slow/failed insert can
  // neither backpressure the update fan-out nor crash the relay
  // (appendJournalUpdate swallows internally). See ./journal.ts.
  async onChange(data) {
    void appendJournalUpdate(data.documentName, data.update);
=======
  // Fires once per Yjs update applied to a loaded doc. Cheap (byte-length
  // bookkeeping only) — the accounting model treats incremental updates as
  // churn on top of the last full snapshot encode. See ./rack-accounting.ts.
  async onChange(data) {
    rackAccountant.recordUpdate(data.documentName, data.update.byteLength);
  },

  // Doc evicted from memory (last client left + Hocuspocus unloaded it):
  // its RAM is freed, so stop attributing it.
  async afterUnloadDocument(data) {
    rackAccountant.evict(data.documentName);
>>>>>>> origin/main
  },

  // Hocuspocus debounces this hook per the `debounce`/`maxDebounce` config
  // above (2s normal, 5s cap), and only fires when the doc actually changed.
  // Cheap enough to write the full state every time at our scale; switch to
  // incremental updates if doc sizes grow into megabytes.
  async onStoreDocument(data) {
    // Compaction watermark BEFORE the encode: a journal row visible now
    // was applied to the doc before its onChange fired, i.e. before this
    // encode — so the snapshot provably contains every row <= watermark.
    // (Fire-and-forget appends can only make us miss rows → under-delete
    // → idempotent replay later. Safe direction.)
    const watermark = await latestJournalSeq(data.documentName);
    const state = Y.encodeStateAsUpdate(data.document);
<<<<<<< HEAD
    const durable = await snapshots.store(data.documentName, state);
=======
    await storeSnapshot(data.documentName, state);
    // Full-state encode = exact current size; resets this rack's churn.
    rackAccountant.recordSnapshot(data.documentName, state.byteLength);
>>>>>>> origin/main
    // eslint-disable-next-line no-console
    console.log(`[hocuspocus] persist (${state.byteLength} bytes): doc=${data.documentName}`);
    // Compact ONLY when the snapshot really landed — after a swallowed
    // persist failure the journal rows are the sole copy of those edits.
    if (durable && watermark !== null) {
      const removed = await compactJournal(data.documentName, watermark);
      if (removed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[hocuspocus] journal compacted (${removed} rows <= seq ${watermark}): doc=${data.documentName}`,
        );
      }
    }
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

// ── Prod persistence fail-fast guard (Phase 2a / FW1) ───────────────────────
//
// A prod relay that boots into the in-memory snapshot store (no DATABASE_URL)
// serves racks whose state silently vanishes on the next deploy/restart. That
// looks healthy — clients connect + sync — but every edit is durably lost.
// Refuse to start in that configuration so a misconfigured deploy FAILS LOUD
// (and Fly health checks flag the crash-loop) instead of quietly serving a
// non-persistent rack. The in-memory fallback (PR #310) stays fully intact for
// local dev + the @collab e2e suite, which do NOT set NODE_ENV=production, so
// shouldFailFast() returns false there. ALLOW_MEMORY_STORE=1 is the escape
// hatch for a deliberate ephemeral prod-memory run. See db.ts:shouldFailFast.
if (shouldFailFast()) {
  // eslint-disable-next-line no-console
  console.error(
    'event=relay_no_database_url level=fatal ' +
      'msg="NODE_ENV=production but DATABASE_URL is unset — refusing to boot the ' +
      'relay into the in-memory snapshot store (rack state would be silently lost ' +
      'on restart). Set DATABASE_URL (flyctl postgres attach) for a persistent ' +
      'deploy, or set ALLOW_MEMORY_STORE=1 to allow a deliberate ephemeral run." ' +
      `persist=${persistenceMode()}`,
  );
  process.exit(1);
}

Server.listen().then(() => {
  // eslint-disable-next-line no-console
  console.log(`[hocuspocus] listening ws://${HOST}:${PORT} (persist=${persistenceMode()})`);
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
