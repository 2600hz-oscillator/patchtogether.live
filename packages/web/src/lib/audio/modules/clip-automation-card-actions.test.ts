// packages/web/src/lib/audio/modules/clip-automation-card-actions.test.ts
//
// Real-@syncedstore/core Y.Doc test for the CARD + MENU automation actions
// (task #183). The card's +AUTO / ARM and the context-menu Assign / Remove live
// inside Svelte components, so — like clip-automation-integration.test.ts mirrors
// the factory deps — this replicates their EXACT Y.Doc writes (the pure shared
// helpers do the real work; only the thin transactional wrapper is inlined) and
// proves the HARD constraints against a real doc:
//
//   • create-automation-clip stamps a `kind:'automation'` clip into the first
//     empty cell of the LAST lane + records the pointer;
//   • assign adds a track via a WHOLE-CLIP PLAIN reassign (no live Y.Array
//     splice → no "Type already integrated" throw);
//   • arm sets arm + recorderId (single-writer, isAutomationRecorder true);
//   • remove drops the track (plain reassign);
//   • every result is a PLAIN shape and nothing throws.

import { describe, it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  CLIP_LANES,
  CLIP_SLOTS,
  clipIndex,
  readClip,
  defaultAutomationClip,
  removeAutomationTrack,
  findAutomationTrack,
  isAutomationRecorder,
  type ClipPlayerData,
  type AutomationTarget,
} from './clip-types';
import { ensureAutomationTrack, plainAutomationClip } from './clip-automation';

interface StoreNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: ClipPlayerData;
}
type Store = { nodes: Record<string, StoreNode> };

const CP = 'clipplayer-1';

function makeDoc() {
  const store = syncedStore<Store>({ nodes: {} });
  const ydoc = getYjsDoc(store);
  ydoc.transact(() => {
    store.nodes[CP] = {
      id: CP, type: 'clipplayer', domain: 'audio',
      position: { x: 0, y: 0 }, params: {},
    };
  });
  return { store, ydoc };
}
/** The live syncedStore + Y.Doc pair (nodes are Partial in the mapped type). */
type Ctx = ReturnType<typeof makeDoc>;

// ── mirrors ClipplayerCard.createAutomationClip ──────────────────────────────
function createAutomationClip(store: Ctx['store'], ydoc: Ctx['ydoc']): void {
  ydoc.transact(() => {
    const node = store.nodes[CP]!;
    if (!node.data) node.data = {};
    const data = node.data;
    const lane = CLIP_LANES - 1;
    let slot = -1;
    for (let s = 0; s < CLIP_SLOTS; s++) {
      if (!(data.clips && data.clips[String(clipIndex(s, lane))])) { slot = s; break; }
    }
    if (slot < 0) return;
    if (!data.clips) data.clips = {};
    data.clips[String(clipIndex(slot, lane))] = defaultAutomationClip();
    if (!data.automation) data.automation = {};
    data.automation.clip = { lane, slot };
  });
}

// ── mirrors makeMidiAssignable.assignAutomation ──────────────────────────────
function assignAutomation(
  store: Ctx['store'],
  ydoc: Ctx['ydoc'],
  target: AutomationTarget,
): void {
  const data = store.nodes[CP]!.data!;
  const ptr = data.automation!.clip!;
  const idx = clipIndex(ptr.slot, ptr.lane);
  const rec = readClip(data, idx);
  if (!rec || rec.kind !== 'automation') return;
  const { rec: next, track } = ensureAutomationTrack(rec, target);
  if (!track) return;
  const plain = plainAutomationClip(next);
  ydoc.transact(() => {
    store.nodes[CP]!.data!.clips![String(idx)] = plain; // WHOLE-CLIP plain reassign
  });
}

// ── mirrors ClipplayerCard.toggleAutoArm (arming) ────────────────────────────
function armAutomation(store: Ctx['store'], ydoc: Ctx['ydoc'], clientId: number): void {
  ydoc.transact(() => {
    const data = store.nodes[CP]!.data!;
    if (!data.automation) data.automation = {};
    data.automation.arm = true;
    data.automation.recorderId = clientId;
  });
}

// ── mirrors makeMidiAssignable.removeAutomation ──────────────────────────────
function removeAutomation(
  store: Ctx['store'],
  ydoc: Ctx['ydoc'],
  target: AutomationTarget,
): void {
  const data = store.nodes[CP]!.data!;
  const ptr = data.automation!.clip!;
  const idx = clipIndex(ptr.slot, ptr.lane);
  const rec = readClip(data, idx);
  if (!rec || rec.kind !== 'automation') return;
  const plain = plainAutomationClip(removeAutomationTrack(rec, target));
  ydoc.transact(() => {
    store.nodes[CP]!.data!.clips![String(idx)] = plain;
  });
}

describe('clip-automation card/menu actions (real Y.Doc)', () => {
  const A: AutomationTarget = { nodeId: 'vco-1', paramId: 'freq' };
  const B: AutomationTarget = { nodeId: 'vcf-1', paramId: 'cutoff' };

  it('+AUTO stamps a kind:automation clip in the last lane + records the pointer', () => {
    const { store, ydoc } = makeDoc();
    expect(() => createAutomationClip(store, ydoc)).not.toThrow();

    const data = store.nodes[CP]!.data!;
    expect(data.automation?.clip).toEqual({ lane: CLIP_LANES - 1, slot: 0 });
    const idx = clipIndex(0, CLIP_LANES - 1);
    const rec = readClip(data, idx);
    expect(rec?.kind).toBe('automation');
    expect(rec && rec.kind === 'automation' ? rec.tracks : null).toEqual([]);
  });

  it('+AUTO picks the LOWEST empty slot when the last lane is partly full', () => {
    const { store, ydoc } = makeDoc();
    // Pre-fill slot 0 of the last lane with a note clip.
    ydoc.transact(() => {
      const node = store.nodes[CP]!;
      node.data = { clips: { [String(clipIndex(0, CLIP_LANES - 1))]: { kind: 'note', steps: [], lengthSteps: 16, root: 48, loop: true } } };
    });
    createAutomationClip(store, ydoc);
    expect(store.nodes[CP]!.data!.automation?.clip).toEqual({ lane: CLIP_LANES - 1, slot: 1 });
  });

  it('assign adds a plain track; assigning a 2nd param appends (both plain, no throw)', () => {
    const { store, ydoc } = makeDoc();
    createAutomationClip(store, ydoc);

    expect(() => assignAutomation(store, ydoc, A)).not.toThrow();
    let rec = readClip(store.nodes[CP]!.data, clipIndex(0, CLIP_LANES - 1));
    expect(rec?.kind).toBe('automation');
    expect(rec && rec.kind === 'automation' ? rec.tracks.length : 0).toBe(1);
    expect(findAutomationTrack(rec as never, A)).toBeTruthy();

    // Re-assigning the SAME param is idempotent (reuses the existing track).
    assignAutomation(store, ydoc, A);
    rec = readClip(store.nodes[CP]!.data, clipIndex(0, CLIP_LANES - 1));
    expect(rec && rec.kind === 'automation' ? rec.tracks.length : 0).toBe(1);

    // A DIFFERENT param appends a second track.
    assignAutomation(store, ydoc, B);
    rec = readClip(store.nodes[CP]!.data, clipIndex(0, CLIP_LANES - 1));
    expect(rec && rec.kind === 'automation' ? rec.tracks.length : 0).toBe(2);
    // The committed clip is a PLAIN shape (tracks/events are plain arrays/objects).
    const plain = rec && rec.kind === 'automation' ? rec : null;
    expect(Array.isArray(plain?.tracks)).toBe(true);
    expect(plain?.tracks.every((t) => typeof t.target.nodeId === 'string' && Array.isArray(t.events))).toBe(true);
  });

  it('arm sets arm + recorderId (single-writer gate true)', () => {
    const { store, ydoc } = makeDoc();
    createAutomationClip(store, ydoc);
    assignAutomation(store, ydoc, A);

    armAutomation(store, ydoc, ydoc.clientID);

    const data = store.nodes[CP]!.data!;
    expect(data.automation?.arm).toBe(true);
    expect(data.automation?.recorderId).toBe(ydoc.clientID);
    expect(isAutomationRecorder(data, ydoc.clientID)).toBe(true);
    expect(isAutomationRecorder(data, ydoc.clientID + 1)).toBe(false); // only the arming client
  });

  it('remove drops only that param’s track (plain reassign, no throw)', () => {
    const { store, ydoc } = makeDoc();
    createAutomationClip(store, ydoc);
    assignAutomation(store, ydoc, A);
    assignAutomation(store, ydoc, B);

    expect(() => removeAutomation(store, ydoc, A)).not.toThrow();

    const rec = readClip(store.nodes[CP]!.data, clipIndex(0, CLIP_LANES - 1));
    expect(rec && rec.kind === 'automation' ? rec.tracks.length : 0).toBe(1);
    expect(findAutomationTrack(rec as never, A)).toBeUndefined(); // A gone
    expect(findAutomationTrack(rec as never, B)).toBeTruthy(); // B kept
  });

  it('the whole create→assign→arm→remove cycle never throws (re-integration safe)', () => {
    const { store, ydoc } = makeDoc();
    expect(() => {
      createAutomationClip(store, ydoc);
      assignAutomation(store, ydoc, A);
      assignAutomation(store, ydoc, B);
      armAutomation(store, ydoc, ydoc.clientID);
      removeAutomation(store, ydoc, A);
      removeAutomation(store, ydoc, B);
    }).not.toThrow();
    const rec = readClip(store.nodes[CP]!.data, clipIndex(0, CLIP_LANES - 1));
    expect(rec && rec.kind === 'automation' ? rec.tracks.length : 0).toBe(0);
  });
});
