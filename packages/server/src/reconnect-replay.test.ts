// packages/server/src/reconnect-replay.test.ts
//
// PROOF that client-side "unacked update replay" needs NO new code — the
// y-protocols sync handshake + Hocuspocus's own ack loop already provide
// it. This test exists because the durability plan (stack study §7/§8)
// called for building replay; the audit found the provider stack already
// guarantees it, and per the reconcile discipline the claim is pinned by a
// test instead of taken on faith.
//
// What the current stack (server 2.15 + provider 4.x — the exact pair
// deployed) already guarantees, verified here over REAL WebSockets with
// REAL Y.Docs:
//
//   1. On EVERY (re)connect the provider runs startSync() → SyncStep1
//      carrying the client's state vector; the server replies with its
//      missing diff AND requests the client's — the client's SyncStep2
//      reply contains every local update the server has never seen. The
//      Y.Doc itself is the outbox: an update made while offline, or sent
//      but lost mid-flight before the server processed it, is
//      indistinguishable at the CRDT level and both are replayed. There
//      is no separate retry queue to build (or to lose).
//   2. Hocuspocus additionally ACKs each applied update with a SyncStatus
//      message (server MessageReceiver → writeSyncStatus(true); provider
//      applySyncStatusMessage → decrementUnsyncedChanges). The provider's
//      `unsyncedChanges` counter is therefore a true unacked-update
//      gauge, and `synced` only flips true when it drains to zero.
//
// What is NOT covered by the protocol — and is deliberately out of scope
// here — is the tab closing BEFORE a reconnect: pending updates die with
// the in-memory Y.Doc. That's the local-replica story (y-indexeddb, PR
// R3), not a wire-protocol gap.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { Hocuspocus } from '@hocuspocus/server';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';

const RACK = 'rack-reconnect-replay';

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

interface Client {
  doc: Y.Doc;
  socket: HocuspocusProviderWebsocket;
  provider: HocuspocusProvider;
}

function makeClient(url: string, name: string): Client {
  const doc = new Y.Doc();
  // Explicit websocketProvider so Node gets the `ws` polyfill; the web app
  // takes the url shorthand instead, but both paths construct the same
  // HocuspocusProviderWebsocket underneath.
  const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name, document: doc });
  // With an explicit websocketProvider the provider does NOT self-attach
  // (manageSocket=false) — attach explicitly. (The web app's url-shorthand
  // path attaches automatically; same machinery underneath.)
  provider.attach();
  return { doc, socket, provider };
}

function edit(doc: Y.Doc, key: string, value: string): void {
  doc.transact(() => {
    doc.getMap('nodes').set(key, value);
  });
}

function nodesOf(doc: Y.Doc): Record<string, unknown> {
  return Object.fromEntries(doc.getMap('nodes').entries());
}

const WAIT = { timeout: 10_000, interval: 25 };

describe('reconnect replay — the y-sync handshake IS the unacked-update replay', () => {
  let server: Hocuspocus;
  let url = '';
  let a: Client;
  let b: Client;

  beforeAll(async () => {
    const port = await freePort();
    // Bare relay: no auth hooks, no persistence — pure wire semantics.
    // (The real relay's hooks gate WHO connects; they don't alter the
    // y-sync exchange this test pins.)
    server = new Hocuspocus({ port, address: '127.0.0.1', quiet: true });
    await server.listen();
    url = `ws://127.0.0.1:${port}`;
    a = makeClient(url, RACK);
    b = makeClient(url, RACK);
    await vi.waitFor(() => {
      expect(a.provider.synced).toBe(true);
      expect(b.provider.synced).toBe(true);
    }, WAIT);
  }, 20_000);

  afterAll(async () => {
    for (const c of [a, b]) {
      try {
        c.provider.destroy();
        c.socket.destroy();
      } catch {
        /* teardown best-effort */
      }
    }
    await server.destroy();
  });

  it(
    'replays offline/unacked local edits on reconnect (and merges server-side edits back)',
    async () => {
      // Baseline: a live edit from A reaches B through the relay.
      edit(a.doc, 'osc-1', 'sine');
      await vi.waitFor(() => {
        expect(nodesOf(b.doc)['osc-1']).toBe('sine');
      }, WAIT);

      // A drops its WebSocket (real socket close, not a mock). Wait for
      // the close to COMPLETE before proceeding — a real network drop
      // always finishes closing before any reconnect attempt, and calling
      // connect() while the close is still in flight wedges the v4
      // socket's state machine (verified by probe; our app never does
      // that — reconnects are backoff- or navigation-driven).
      a.socket.disconnect();
      await vi.waitFor(() => {
        expect(a.socket.status).toBe('disconnected');
      }, WAIT);

      // Edits made while DISCONNECTED — never sent anywhere. The provider
      // counts them as unsynced (no SyncStatus ack can arrive).
      edit(a.doc, 'vcf-1', 'lowpass');
      edit(a.doc, 'osc-1', 'saw'); // an overwrite, not just an add
      expect(a.provider.hasUnsyncedChanges).toBe(true);

      // Concurrent server-side truth moves on: B keeps editing.
      edit(b.doc, 'lfo-1', 'triangle');

      // Sanity: nothing leaked to B while A was down.
      expect(nodesOf(b.doc)['vcf-1']).toBeUndefined();

      // Reconnect. startSync()'s state-vector exchange replays A's two
      // pending updates and pulls down B's concurrent edit — no
      // application code involved.
      a.socket.connect();
      await vi.waitFor(() => {
        expect(nodesOf(b.doc)).toMatchObject({ 'osc-1': 'saw', 'vcf-1': 'lowpass' });
        expect(nodesOf(a.doc)).toMatchObject({ 'lfo-1': 'triangle' });
      }, WAIT);

      // The relay's authoritative doc converged too.
      const serverDoc = server.documents.get(RACK);
      expect(serverDoc).toBeDefined();
      expect(nodesOf(serverDoc!)).toEqual({
        'osc-1': 'saw',
        'vcf-1': 'lowpass',
        'lfo-1': 'triangle',
      });

      // And the unacked gauge drains: every replayed update got its
      // SyncStatus ack, so the provider reports fully synced again.
      await vi.waitFor(() => {
        expect(a.provider.hasUnsyncedChanges).toBe(false);
        expect(a.provider.synced).toBe(true);
      }, WAIT);
    },
    30_000,
  );
});
