// packages/web/src/lib/multiplayer/local-replica.test.ts
//
// The local rackspace replica, tested against REAL Y.Docs + the REAL
// syncedStore bundle (createPatch) over fake-indexeddb — no mocked Yjs, no
// mocked y-indexeddb (house rule: yjs-save-load-real-ydoc). Covers the
// four edge cases the design names: replica-vs-server reconciliation,
// multi-tab, the corrupt-replica escape hatch, and the disabled path.

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import {
  REPLICA_DB_PREFIX,
  attachLocalReplica,
  clearLocalReplica,
  isReplicaSupported,
  replicaDbName,
} from './local-replica';
import { createPatch } from '../graph/store';

let rackCounter = 0;
/** Unique rack id per test — fake-indexeddb state is process-global. */
function freshRackId(): string {
  rackCounter += 1;
  return `rack-replica-test-${rackCounter}`;
}

function edit(doc: Y.Doc, key: string, value: string): void {
  doc.transact(() => {
    doc.getMap('nodes').set(key, value);
  });
}

function nodesOf(doc: Y.Doc): Record<string, unknown> {
  return Object.fromEntries(doc.getMap('nodes').entries());
}

/** Let pending IndexedDB requests drain (fake-indexeddb completes them on
 *  timers/microtasks; a couple of macrotasks is plenty). */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

/** Raw-IDB helper: inject a garbage row into a replica's updates store —
 *  the corruption class the escape hatch defends against. */
async function corruptReplica(rackId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(replicaDbName(rackId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('updates', 'readwrite');
      tx.objectStore('updates').add(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x99]));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

describe('replicaDbName', () => {
  it('is versioned + rack-scoped', () => {
    expect(replicaDbName('abc')).toBe(`${REPLICA_DB_PREFIX}abc`);
    expect(isReplicaSupported()).toBe(true); // fake-indexeddb is installed
  });
});

describe('attachLocalReplica — seed across sessions', () => {
  it("first visit is 'fresh'; a reload seeds the new doc with the prior session's edits", async () => {
    const rackId = freshRackId();

    // Session 1: fresh attach, edits, unmount (destroy KEEPS data).
    const doc1 = new Y.Doc();
    const replica1 = attachLocalReplica(rackId, doc1);
    expect(await replica1.whenSeeded).toBe('fresh');
    edit(doc1, 'osc-1', 'sine');
    edit(doc1, 'vcf-1', 'lowpass');
    await settle();
    await replica1.destroy();
    doc1.destroy();

    // Session 2 (reload): bindRackspace hands out a FRESH doc; the replica
    // seeds it locally with no relay involved.
    const doc2 = new Y.Doc();
    const replica2 = attachLocalReplica(rackId, doc2);
    expect(await replica2.whenSeeded).toBe('seeded');
    await vi.waitFor(() => {
      expect(nodesOf(doc2)).toEqual({ 'osc-1': 'sine', 'vcf-1': 'lowpass' });
    });
    await replica2.destroy();
    doc2.destroy();
  });

  it('replicas are isolated per rack id', async () => {
    const rackA = freshRackId();
    const rackB = freshRackId();
    const docA = new Y.Doc();
    const replicaA = attachLocalReplica(rackA, docA);
    await replicaA.whenSeeded;
    edit(docA, 'leak', 'nope');
    await settle();
    await replicaA.destroy();
    docA.destroy();

    const docB = new Y.Doc();
    const replicaB = attachLocalReplica(rackB, docB);
    expect(await replicaB.whenSeeded).toBe('fresh');
    expect(nodesOf(docB)).toEqual({});
    await replicaB.destroy();
    docB.destroy();
  });

  it('seeds through the REAL syncedStore bundle (createPatch) and the proxy sees it', async () => {
    const rackId = freshRackId();

    // Prior session wrote through a raw doc.
    const prior = new Y.Doc();
    const replicaPrior = attachLocalReplica(rackId, prior);
    await replicaPrior.whenSeeded;
    edit(prior, 'node-1', 'macroosc');
    await settle();
    await replicaPrior.destroy();
    prior.destroy();

    // This session uses the real store bundle the rack page binds.
    const { patch, ydoc } = createPatch();
    const replica = attachLocalReplica(rackId, ydoc);
    expect(await replica.whenSeeded).toBe('seeded');
    await vi.waitFor(() => {
      expect((patch.nodes as Record<string, unknown>)['node-1']).toBe('macroosc');
    });
    await replica.destroy();
    ydoc.destroy();
  });
});

describe('attachLocalReplica — replica staleness vs server truth', () => {
  it('offline-ahead replica + server-ahead doc converge via the standard state-vector exchange', async () => {
    const rackId = freshRackId();

    // Yesterday: client synced up to {osc-1:sine}, then edited OFFLINE
    // (vcf-1) — the tab closed before any reconnect. Everything lives
    // only in the replica.
    const yesterday = new Y.Doc();
    const replicaY = attachLocalReplica(rackId, yesterday);
    await replicaY.whenSeeded;
    edit(yesterday, 'osc-1', 'sine');
    // Snapshot the SYNCED point BEFORE the offline edit — this is what the
    // server actually received.
    const serverStateYesterday = Y.encodeStateAsUpdate(yesterday);
    edit(yesterday, 'vcf-1', 'lowpass'); // offline — never reached the server
    await settle();
    await replicaY.destroy();
    yesterday.destroy();

    // Server truth: has the synced part, PLUS a collaborator's newer edit.
    const server = new Y.Doc();
    Y.applyUpdate(server, serverStateYesterday);
    edit(server, 'lfo-1', 'triangle'); // collaborator moved on

    // Today: reload → seed from replica (stale AND locally-ahead at once).
    const today = new Y.Doc();
    const replicaT = attachLocalReplica(rackId, today);
    expect(await replicaT.whenSeeded).toBe('seeded');
    await vi.waitFor(() => {
      expect(nodesOf(today)['vcf-1']).toBe('lowpass');
    });

    // Provider connects → y-sync state-vector exchange, both directions
    // (this is byte-for-byte what SyncStep1/SyncStep2 carry).
    const toServer = Y.encodeStateAsUpdate(today, Y.encodeStateVector(server));
    const toClient = Y.encodeStateAsUpdate(server, Y.encodeStateVector(today));
    Y.applyUpdate(server, toServer);
    Y.applyUpdate(today, toClient);

    // Convergence: offline edit REPLAYED to server, server edit pulled in.
    expect(nodesOf(server)).toEqual(nodesOf(today));
    expect(nodesOf(today)).toMatchObject({ 'osc-1': 'sine', 'lfo-1': 'triangle' });
    expect(nodesOf(today)['vcf-1']).toBe('lowpass');

    await replicaT.destroy();
    today.destroy();
    server.destroy();
  });

  it('a REAL collaborative delete stays deleted after re-seeding (tombstones persist)', async () => {
    const rackId = freshRackId();

    const doc1 = new Y.Doc();
    const replica1 = attachLocalReplica(rackId, doc1);
    await replica1.whenSeeded;
    edit(doc1, 'osc-1', 'sine');
    // The delete happens as a genuine CRDT op (what a collaborator's
    // delete looks like after sync) — replica persists the tombstone.
    doc1.transact(() => {
      doc1.getMap('nodes').delete('osc-1');
    });
    await settle();
    await replica1.destroy();
    doc1.destroy();

    const doc2 = new Y.Doc();
    const replica2 = attachLocalReplica(rackId, doc2);
    await replica2.whenSeeded;
    await settle();
    expect(nodesOf(doc2)).toEqual({}); // no resurrection
    await replica2.destroy();
    doc2.destroy();
  });
});

describe('attachLocalReplica — multi-tab', () => {
  it('two concurrent tabs write to one store; the next load sees both (no corruption)', async () => {
    const rackId = freshRackId();

    const tabA = new Y.Doc();
    const tabB = new Y.Doc();
    const replicaA = attachLocalReplica(rackId, tabA);
    const replicaB = attachLocalReplica(rackId, tabB);
    await replicaA.whenSeeded;
    await replicaB.whenSeeded;

    edit(tabA, 'from-tab-a', 'yes');
    edit(tabB, 'from-tab-b', 'also');
    await settle();

    // No live cross-tab bus (when online the relay is the bus) — but both
    // tabs' updates landed in the same store...
    await replicaA.destroy();
    await replicaB.destroy();
    tabA.destroy();
    tabB.destroy();

    // ...so the next session converges both.
    const merged = new Y.Doc();
    const replicaM = attachLocalReplica(rackId, merged);
    expect(await replicaM.whenSeeded).toBe('seeded');
    await vi.waitFor(() => {
      expect(nodesOf(merged)).toEqual({ 'from-tab-a': 'yes', 'from-tab-b': 'also' });
    });
    await replicaM.destroy();
    merged.destroy();
  });
});

describe('attachLocalReplica — corrupt-replica escape hatch', () => {
  it('a garbage row → clear + start fresh (relay refetch is the recovery)', async () => {
    const rackId = freshRackId();

    // Healthy session first.
    const doc1 = new Y.Doc();
    const replica1 = attachLocalReplica(rackId, doc1);
    await replica1.whenSeeded;
    edit(doc1, 'osc-1', 'sine');
    await settle();
    await replica1.destroy();
    doc1.destroy();

    // Disk rot / torn write.
    await corruptReplica(rackId);

    // Next mount detects it BEFORE y-indexeddb attaches (whose load path
    // would otherwise hang forever), wipes, and continues replica-less
    // until the relay refills the doc.
    const doc2 = new Y.Doc();
    const replica2 = attachLocalReplica(rackId, doc2, { log: () => {} });
    expect(await replica2.whenSeeded).toBe('cleared-corrupt');
    expect(nodesOf(doc2)).toEqual({}); // nothing from the corrupt store leaked

    // Persistence WORKS again post-clear: this session's edits survive.
    edit(doc2, 'rebuilt', 'yes');
    await settle();
    await replica2.destroy();
    doc2.destroy();

    const doc3 = new Y.Doc();
    const replica3 = attachLocalReplica(rackId, doc3);
    expect(await replica3.whenSeeded).toBe('seeded');
    await vi.waitFor(() => {
      expect(nodesOf(doc3)).toEqual({ rebuilt: 'yes' });
    });
    await replica3.destroy();
    doc3.destroy();
  });
});

describe('clearLocalReplica', () => {
  it('wipes a rack replica (the auth-rejection / support path)', async () => {
    const rackId = freshRackId();
    const doc1 = new Y.Doc();
    const replica1 = attachLocalReplica(rackId, doc1);
    await replica1.whenSeeded;
    edit(doc1, 'secret', 'patch');
    await settle();
    await replica1.destroy();
    doc1.destroy();

    await clearLocalReplica(rackId);

    const doc2 = new Y.Doc();
    const replica2 = attachLocalReplica(rackId, doc2);
    expect(await replica2.whenSeeded).toBe('fresh');
    expect(nodesOf(doc2)).toEqual({});
    await replica2.destroy();
    doc2.destroy();
  });

  it('is safe when no replica exists', async () => {
    await expect(clearLocalReplica(freshRackId())).resolves.toBeUndefined();
  });
});

describe('attachLocalReplica — disabled/edge paths', () => {
  it("no indexedDB global → 'disabled' no-op handle (SSR / hardened modes)", async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error — simulating an environment without IndexedDB
    delete globalThis.indexedDB;
    try {
      const doc = new Y.Doc();
      const replica = attachLocalReplica(freshRackId(), doc);
      expect(await replica.whenSeeded).toBe('disabled');
      await replica.destroy();
      doc.destroy();
    } finally {
      globalThis.indexedDB = original;
    }
  });

  it('destroy() is idempotent and safe before seeding finishes', async () => {
    const doc = new Y.Doc();
    const replica = attachLocalReplica(freshRackId(), doc);
    await replica.destroy(); // possibly before whenSeeded settled
    await replica.destroy();
    doc.destroy();
  });
});
