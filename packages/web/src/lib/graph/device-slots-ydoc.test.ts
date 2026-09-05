// packages/web/src/lib/graph/device-slots-ydoc.test.ts
//
// NATIVE-SHELL P1 — the device-slot layer against REAL syncedStore-backed
// Y.Docs, the REAL reconciler, and the REAL envelope loader.
//
// The claim P1 makes is mechanical: a hardware session hangs off a node id, so
// a workflow that does not destroy the id does not destroy the session. That
// claim is only worth anything if it is asserted against the machinery that
// actually destroys ids — `loadEnvelopeIntoStore`'s clear pass and the
// reconciler's `identityChanged` — rather than against a re-derivation of them.
// So this file runs both, with a recording engine standing in for the device
// layer, and asserts the ENGINE CALL SEQUENCE.
//
// ⚠ WHAT THIS FILE CANNOT SEE, stated up front because the interruption matrix
// requires it: a recording engine is not a camera. `removeNode` not being
// called proves the reconciler never asked the device layer to let go; it does
// NOT prove a MediaStream kept producing frames. That is a receiver-side
// question and it belongs to the e2e (`device-slot-continuity.spec.ts`), which
// counts advancing camera pixels across a real load. Neither instrument
// subsumes the other and neither is the whole row.

import { describe, it, expect, beforeAll } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import type { ModuleNode, Edge } from './types';
import { PatchEngine, type DomainEngine } from '$lib/audio/engine';
import { attachReconciler } from '$lib/audio/reconciler';
import { createSnapshotBus } from './snapshot';
import {
  DEVICE_SLOTS,
  RESERVED_DEVICE_SLOT_IDS,
  isDeviceSlotId,
  planDeviceSlotIdentityRepairs,
  planDeviceSlotSpawns,
} from './device-slots';
import { planPinnedIdentityRepairs } from './workflow-pins';
import { makeEnvelope, loadEnvelopeIntoStore } from './persistence';
import { DEFAULT_VIDEO_OUT_ID } from './channel-columns';
import { registerVideoModule, type VideoModuleDef } from '$lib/video/module-registry';

// The loader DROPS a node whose type resolves in no registry, and the registries
// are glob-derived at app boot — so without this every incoming node in this
// file would be dropped and every load assertion would pass for the wrong
// reason (the slot surviving because nothing arrived rather than because the
// clear pass skipped it). Registering stub defs is the same move
// present-restore-roundtrip.test.ts makes for exactly this reason.
const throwingFactory = (): never => {
  throw new Error('factory must not be called from a persistence test');
};
const stubDef = (type: string): VideoModuleDef =>
  ({
    type,
    domain: 'video',
    label: type.toUpperCase(),
    category: 'source',
    inputs: [],
    outputs: [],
    params: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: throwingFactory as any,
  }) as VideoModuleDef;

beforeAll(() => {
  for (const type of ['cameraInput', 'videoOut', 'lines']) {
    registerVideoModule(stubDef(type));
  }
});

type PatchStore = { nodes: Record<string, ModuleNode>; edges: Record<string, Edge> };

interface Peer {
  patch: ReturnType<typeof syncedStore<PatchStore>>;
  doc: Y.Doc;
}

function makePeer(): Peer {
  const patch = syncedStore<PatchStore>({ nodes: {}, edges: {} });
  return { patch, doc: getYjsDoc(patch) };
}

function converge(a: Peer, b: Peer): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
}

function liveNodes(peer: Peer): ModuleNode[] {
  return Object.values(peer.patch.nodes).filter((n): n is ModuleNode => !!n);
}

const SPAWN_ORIGIN = 'workflow-pin-spawn';

/** Run the slot ensure EXACTLY as Canvas.svelte's $effect does: plan against
 *  the current nodes, then transact the repairs AND the spawns (with the
 *  in-transact re-check) under the non-undoable origin. */
function runSlotEnsure(peer: Peer): number {
  const nodes = liveNodes(peer);
  const missing = planDeviceSlotSpawns(nodes);
  const repairs = planDeviceSlotIdentityRepairs(nodes);
  if (missing.length === 0 && repairs.length === 0) return 0;
  let wrote = 0;
  peer.doc.transact(() => {
    for (const r of repairs) {
      const node = peer.patch.nodes[r.id];
      if (!node) continue;
      if (r.fields.includes('type')) node.type = r.type;
      if (r.fields.includes('domain')) node.domain = r.domain as ModuleNode['domain'];
      if (r.fields.includes('pinned') || r.fields.includes('hiddenCard')) {
        if (!node.data) node.data = {};
        const d = node.data as Record<string, unknown>;
        if (r.fields.includes('pinned')) d.pinned = r.pinned;
        if (r.fields.includes('hiddenCard')) d.hiddenCard = r.hiddenCard;
      }
      wrote++;
    }
    for (const spec of missing) {
      if (peer.patch.nodes[spec.id]) continue; // in-transact re-check
      const data: Record<string, unknown> = { name: spec.slot };
      if (spec.pinned) data.pinned = true;
      if (spec.hiddenCard) data.hiddenCard = true;
      peer.patch.nodes[spec.id] = {
        id: spec.id,
        type: spec.type,
        domain: spec.domain,
        position: { x: 24, y: 24 },
        params: {},
        data,
      } as ModuleNode;
      wrote++;
    }
  }, SPAWN_ORIGIN);
  return wrote;
}

/** A HOSTILE PEER's write. No API a normal collaborator lacks — a plain field
 *  write in an ordinary transaction, which is what a malicious or simply buggy
 *  client emits. The rackspace cap is 4 and anonymous invitees are allowed, so
 *  this is a reachable state, not a thought experiment. */
function hostileWrite(peer: Peer, id: string, fields: Partial<ModuleNode>): void {
  peer.doc.transact(() => {
    const node = peer.patch.nodes[id];
    if (!node) return;
    if (fields.type !== undefined) node.type = fields.type;
    if (fields.domain !== undefined) node.domain = fields.domain;
    if (fields.data !== undefined) node.data = fields.data as ModuleNode['data'];
  });
}

/** Clear, exactly as Canvas.clearPatch does it (pinned survive by flag,
 *  reserved slots survive by ID). */
function runClear(peer: Peer): void {
  peer.doc.transact(() => {
    for (const id of Object.keys(peer.patch.edges)) delete peer.patch.edges[id];
    for (const id of Object.keys(peer.patch.nodes)) {
      if ((peer.patch.nodes[id]?.data as { pinned?: boolean } | undefined)?.pinned === true) continue;
      if (isDeviceSlotId(id)) continue;
      delete peer.patch.nodes[id];
    }
  });
}

class SessionEngine implements DomainEngine {
  domain = 'video' as const;
  ops: string[] = [];
  /** Node ids the "device layer" currently holds a session for. */
  live = new Set<string>();
  async addNode(n: ModuleNode): Promise<void> {
    this.ops.push(`addNode ${n.id}:${n.type}`);
    this.live.add(n.id);
  }
  removeNode(id: string): void {
    this.ops.push(`removeNode ${id}`);
    this.live.delete(id);
  }
  addEdge(e: Edge): void {
    this.ops.push(`addEdge ${e.id}`);
  }
  removeEdge(id: string): void {
    this.ops.push(`removeEdge ${id}`);
  }
  setParam(): void {}
  readParam(): undefined {
    return undefined;
  }
  read(): unknown {
    return undefined;
  }
  dispose(): void {}
}

/** Drain the reconciler to QUIESCENCE — observable state, never a magic turn
 *  count (`addNode` is async and the reconciler chains through `inFlight`). */
async function flushReconciler(engine: SessionEngine): Promise<void> {
  let last = -1;
  for (let i = 0; i < 200 && engine.ops.length !== last; i++) {
    last = engine.ops.length;
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
}

/** Attach the real reconciler to a peer with a recording video engine. */
function attach(peer: Peer): { eng: SessionEngine; detach: () => void } {
  const bus = createSnapshotBus({ patch: peer.patch as never, ydoc: peer.doc });
  const pe = new PatchEngine();
  const eng = new SessionEngine();
  pe.registerDomain(eng);
  const handle = attachReconciler(pe, { bus });
  return { eng, detach: () => handle.dispose() };
}

const slotIds = () => DEVICE_SLOTS.map((s) => s.id).sort();

describe('the slot ensure on real Y.Docs', () => {
  it('spawns all eight once, then is idempotent', () => {
    const a = makePeer();
    expect(runSlotEnsure(a)).toBe(8);
    expect(Object.keys(a.patch.nodes).sort()).toEqual(slotIds());
    expect(runSlotEnsure(a)).toBe(0);
  });

  it('two peers racing the ensure CONVERGE to one node per slot', () => {
    const a = makePeer();
    const b = makePeer();
    runSlotEnsure(a);
    runSlotEnsure(b);
    converge(a, b);
    // Deterministic ids → the Y.Map keys collide → exactly ONE entry each.
    expect(Object.keys(a.patch.nodes).sort()).toEqual(slotIds());
    expect(Object.keys(b.patch.nodes).sort()).toEqual(Object.keys(a.patch.nodes).sort());
    expect(runSlotEnsure(a)).toBe(0);
    expect(runSlotEnsure(b)).toBe(0);
  });

  it('a PEER Clear arriving over sync cannot remove a slot', () => {
    const a = makePeer();
    const b = makePeer();
    runSlotEnsure(a);
    // An ordinary user module the Clear is entitled to take.
    a.doc.transact(() => {
      a.patch.nodes['lfo-1'] = {
        id: 'lfo-1', type: 'lfo', domain: 'audio',
        position: { x: 0, y: 0 }, params: {}, data: {},
      } as ModuleNode;
    });
    converge(a, b);
    runClear(b); // the PEER clears
    converge(a, b);
    expect(a.patch.nodes['lfo-1']).toBeUndefined(); // content went
    expect(Object.keys(a.patch.nodes).sort()).toEqual(slotIds()); // slots stayed
  });
});

describe('hostile peer vs. a reserved slot', () => {
  it('A PEER CANNOT DROP A CAMERA SESSION: it comes back, at the SAME id', async () => {
    const a = makePeer();
    const { eng, detach } = attach(a);
    try {
      runSlotEnsure(a);
      await flushReconciler(eng);
      expect(eng.live.has('slot:cam1')).toBe(true);

      // THE ATTACK: a collaborator retypes the session holder.
      const beforeAttack = eng.ops.length;
      hostileWrite(a, 'slot:cam1', { type: 'lines' });
      await flushReconciler(eng);
      // identityChanged fires and the session IS torn down. Yjs has no
      // conditional insert, so this interval is unavoidable — what the repair
      // buys is that it is TRANSIENT, not that it is impossible. Do not
      // restate this as "structurally impossible".
      expect(eng.ops.slice(beforeAttack)).toContain('removeNode slot:cam1');

      // THE REPAIR: canonicalised in place on the next snapshot.
      const beforeRepair = eng.ops.length;
      runSlotEnsure(a);
      await flushReconciler(eng);
      expect(eng.live.has('slot:cam1')).toBe(true);
      // Back as the RIGHT module at the SAME reserved id — a session that came
      // back at a fresh id would not be a fix, because the id IS the key the
      // media registries and the present bindings index by.
      expect(eng.ops.slice(beforeRepair)).toContain('addNode slot:cam1:cameraInput');
    } finally {
      detach();
    }
  });

  // ⚠ The one-field attack that makes the rack's master video sink vanish from
  // the purple zone with no delete, no error and nothing in the console.
  it('THE VANISHING-SINK ATTACK: a peer pinning an output slot is repaired', () => {
    const a = makePeer();
    runSlotEnsure(a);
    hostileWrite(a, DEFAULT_VIDEO_OUT_ID, { data: { pinned: true } as never });
    const repairs = planDeviceSlotIdentityRepairs(liveNodes(a));
    expect(repairs.map((r) => r.slot)).toEqual(['output1']);
    runSlotEnsure(a);
    expect(
      (a.patch.nodes[DEFAULT_VIDEO_OUT_ID]!.data as Record<string, unknown>).pinned,
    ).toBe(false);
  });

  // POSITIVE CONTROL. Without this the case above proves nothing: it has to be
  // shown that the mechanism ALREADY IN THE TREE cannot see this attack, so the
  // new repair is doing real work rather than duplicating an existing guard.
  it('POSITIVE CONTROL: the pinned-singleton repair is BLIND to it', () => {
    const a = makePeer();
    runSlotEnsure(a);
    hostileWrite(a, DEFAULT_VIDEO_OUT_ID, { data: { pinned: true } as never });
    // planPinnedIdentityRepairs only defends `pinned-*` ids, and it only ever
    // SETS `pinned` — it has no vocabulary for "this node must NOT be pinned".
    expect(planPinnedIdentityRepairs(liveNodes(a))).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE LOAD PATH — the real loader, the real reconciler.
//
// This is the row the phase is actually about. `loadEnvelopeIntoStore` clears
// `patch.nodes` unconditionally, and deleting a node id is what retires the
// node-keyed registry entry that owns the resource. So the assertion is not
// "the node still exists" (presence) but "the reconciler never asked the device
// layer to let go" (liveness, as far as a graph-level instrument can see it).
//
// ⚠ WHICH MECHANISM SAVES THE SLOT DEPENDS ON THE ENVELOPE, and the negative
// control is what showed it. Disabling the clear-pass skip and re-running BOTH
// instruments reddens them on DIFFERENT assertions:
//
//   * envelope CONTAINS a node at the slot id, same type — the delete and the
//     re-add land in ONE transaction, the snapshot bus emits one snapshot per
//     transaction (#2321), so the reconciler sees an unchanged node and emits
//     no `removeNode` at all. The skip is NOT what saves the session here.
//   * envelope does NOT contain the slot — an old patch, a foreign patch, a
//     patch saved from a rack that predates slots. Delete with no re-add, and
//     the id is simply gone: the e2e's camera dies and this file's assertions
//     see a real `removeNode slot:cam1`. The skip is the ONLY thing that saves
//     it, which is why the loads below deliberately carry NO slot nodes.
//
// The rig binding is saved by the carry-across in both cases — that is the
// assertion the e2e reddens on, since a stripped-then-re-added node arrives
// with no `deviceId`.
//
// Do not "simplify" these loads to an envelope that happens to contain the
// slots: that would move every case into the first bucket and this file would
// pass without the skip existing.
// ───────────────────────────────────────────────────────────────────────────

/** Build an envelope from a throwaway doc holding `nodes`. */
function envelopeOf(nodes: ModuleNode[]): ReturnType<typeof makeEnvelope> {
  const store = syncedStore<PatchStore>({ nodes: {}, edges: {} });
  const doc = getYjsDoc(store);
  doc.transact(() => {
    for (const n of nodes) store.nodes[n.id] = n;
  });
  return makeEnvelope(doc);
}

const otherPatch = (): ModuleNode[] => [
  {
    id: 'lines-xyz', type: 'lines', domain: 'video',
    position: { x: 10, y: 10 }, params: {}, data: {},
  } as ModuleNode,
];

describe('patch load — the device-slot survival contract', () => {
  it('a DIFFERENT patch replaces the content and leaves every slot id standing', () => {
    const a = makePeer();
    runSlotEnsure(a);
    a.doc.transact(() => {
      a.patch.nodes['lfo-1'] = {
        id: 'lfo-1', type: 'lfo', domain: 'audio',
        position: { x: 0, y: 0 }, params: {}, data: {},
      } as ModuleNode;
    });

    loadEnvelopeIntoStore(envelopeOf(otherPatch()), a.doc, a.patch as never);

    expect(a.patch.nodes['lfo-1']).toBeUndefined(); // the old content went
    expect(a.patch.nodes['lines-xyz']).toBeDefined(); // the new content arrived
    for (const id of RESERVED_DEVICE_SLOT_IDS) {
      expect(a.patch.nodes[id], `slot ${id} must survive the load`).toBeDefined();
    }
  });

  it('THE RECONCILER NEVER TEARS DOWN A SLOT ACROSS A LOAD', async () => {
    const a = makePeer();
    const { eng, detach } = attach(a);
    try {
      runSlotEnsure(a);
      await flushReconciler(eng);
      expect(eng.live.has('slot:cam1')).toBe(true);
      expect(eng.live.has(DEFAULT_VIDEO_OUT_ID)).toBe(true);

      const before = eng.ops.length;
      loadEnvelopeIntoStore(envelopeOf(otherPatch()), a.doc, a.patch as never);
      await flushReconciler(eng);

      const after = eng.ops.slice(before);
      // The negative assertion IS the contract. Not "a slot node exists
      // afterwards" — a node re-added at the same id would satisfy that while
      // the camera light blinked.
      for (const id of RESERVED_DEVICE_SLOT_IDS) {
        expect(after, `slot ${id} must not be torn down`).not.toContain(`removeNode ${id}`);
        expect(eng.live.has(id)).toBe(true);
      }
      // POSITIVE CONTROL for the instrument itself: the same load DID tear the
      // ordinary content down, so a `removeNode` genuinely would have been
      // observed had one been emitted for a slot.
      expect(after.some((op) => op.startsWith('addNode lines-xyz'))).toBe(true);
    } finally {
      detach();
    }
  });

  it('POSITIVE CONTROL: an UNRESERVED id in the same rack IS torn down by the load', async () => {
    const a = makePeer();
    const { eng, detach } = attach(a);
    try {
      // A camera at an ordinary id — today's dynamic workflow camera. Same
      // type, same registries, same everything except the reservation.
      a.doc.transact(() => {
        a.patch.nodes['wfcam-deadbeef'] = {
          id: 'wfcam-deadbeef', type: 'cameraInput', domain: 'video',
          position: { x: 0, y: 0 }, params: {}, data: { hiddenCard: true },
        } as ModuleNode;
      });
      await flushReconciler(eng);
      expect(eng.live.has('wfcam-deadbeef')).toBe(true);

      const before = eng.ops.length;
      loadEnvelopeIntoStore(envelopeOf(otherPatch()), a.doc, a.patch as never);
      await flushReconciler(eng);

      // This is the interruption P1 exists to remove, still happening to a
      // camera that is not in a slot. It is what "device access breaks" looks
      // like at the graph tap.
      expect(eng.ops.slice(before)).toContain('removeNode wfcam-deadbeef');
      expect(eng.live.has('wfcam-deadbeef')).toBe(false);
    } finally {
      detach();
    }
  });

  it("keeps THIS machine's camera binding and refuses the envelope's", () => {
    const a = makePeer();
    runSlotEnsure(a);
    // The operator picked a camera; the card wrote it to node.data.
    a.doc.transact(() => {
      (a.patch.nodes['slot:cam1']!.data as Record<string, unknown>).deviceId = 'MY-CAMERA';
    });

    // A patch shared by a collaborator, carrying THEIR hardware at the same slot.
    const incoming = envelopeOf([
      {
        id: 'slot:cam1', type: 'cameraInput', domain: 'video',
        position: { x: 0, y: 0 }, params: { gain: 1.5 },
        data: { deviceId: 'THEIR-CAMERA', name: 'STAGE LEFT' },
      } as ModuleNode,
    ]);
    loadEnvelopeIntoStore(incoming, a.doc, a.patch as never);

    const data = a.patch.nodes['slot:cam1']!.data as Record<string, unknown>;
    // The binding is a RIG property: machine-local, and meaningless anywhere
    // else. Their device id must never take effect here.
    expect(data.deviceId).toBe('MY-CAMERA');
    // Patch CONTENT is theirs, as it should be — that is what loading is.
    expect(data.name).toBe('STAGE LEFT');
    expect(a.patch.nodes['slot:cam1']!.params).toEqual({ gain: 1.5 });
  });

  it('COERCES a foreign type at a slot id rather than letting it retype the node', async () => {
    const a = makePeer();
    const { eng, detach } = attach(a);
    try {
      runSlotEnsure(a);
      await flushReconciler(eng);

      // A hand-edited / version-skewed envelope. The contract-lock cannot see
      // envelope DATA, so this is the reachable path to a type change at a
      // reused id — and a type change at a reused id is EXACTLY the remove+add
      // teardown the layer exists to prevent, fired by the layer's own merge.
      const before = eng.ops.length;
      const result = loadEnvelopeIntoStore(
        envelopeOf([
          {
            id: 'slot:cam1', type: 'lines', domain: 'video',
            position: { x: 0, y: 0 }, params: { hue: 9 }, data: {},
          } as ModuleNode,
        ]),
        a.doc,
        a.patch as never,
      );
      await flushReconciler(eng);

      expect(a.patch.nodes['slot:cam1']!.type).toBe('cameraInput');
      expect(a.patch.nodes['slot:cam1']!.params).toEqual({}); // foreign params dropped
      expect(eng.ops.slice(before)).not.toContain('removeNode slot:cam1');
      // The user is TOLD, through the ordinary load-diagnostics notice — the
      // loader must not silently rewrite someone's file.
      expect(result.diagnostics.some((d) => d.nodeId === 'slot:cam1')).toBe(true);
    } finally {
      detach();
    }
  });

  it('an OLD envelope with no slots at all leaves the live slots untouched', () => {
    const a = makePeer();
    runSlotEnsure(a);
    a.doc.transact(() => {
      (a.patch.nodes['slot:cam2']!.data as Record<string, unknown>).deviceId = 'MY-CAMERA';
    });
    loadEnvelopeIntoStore(envelopeOf(otherPatch()), a.doc, a.patch as never);
    expect(
      (a.patch.nodes['slot:cam2']!.data as Record<string, unknown>).deviceId,
    ).toBe('MY-CAMERA');
  });
});
