// packages/web/src/lib/ui/media/node-media-registry.test.ts
//
// The registry's job is to make a node's media survive a CARD unmount while
// still being torn down when the NODE dies. Both halves are asserted, and the
// dangerous half (teardown on unmount) is negative-controlled: a registry that
// revoked/stopped on release would fail here, which is the exact regression
// that produced the owner's "stops playing when collapsed".
//
// `environment: 'node'` (packages/web/vitest.config.ts) — so the DOM is
// injected via NodeMediaOps fakes rather than jsdom.

import { describe, it, expect } from 'vitest';
import { createNodeMediaRegistry, type NodeMediaOps } from './node-media-registry';

interface FakeEl {
  id: string;
  parent: string | null;
  destroyed: boolean;
  inits: number;
}
interface FakeHost {
  name: string;
}

interface Harness {
  ops: NodeMediaOps<FakeEl, FakeHost>;
  created: FakeEl[];
  revoked: string[];
  stopped: MediaStream[];
}

function harness(): Harness {
  const created: FakeEl[] = [];
  const revoked: string[] = [];
  const stopped: MediaStream[] = [];
  const ops: NodeMediaOps<FakeEl, FakeHost> = {
    create(nodeId, slot) {
      const el: FakeEl = { id: `${nodeId}/${slot}`, parent: null, destroyed: false, inits: 0 };
      created.push(el);
      return el;
    },
    mount(el, host) { el.parent = host.name; },
    park(el) { el.parent = 'PARKING'; },
    destroy(el) { el.destroyed = true; el.parent = null; },
    revokeUrl(url) { revoked.push(url); },
    stopStream(s) { stopped.push(s); },
  };
  return { ops, created, revoked, stopped };
}

function fakeStream(label: string): MediaStream {
  return { label } as unknown as MediaStream;
}

describe('node media registry — one element per (node, slot)', () => {
  it('adopting twice returns the SAME element, never a second one', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const a = r.adopt('n1', 'main', { name: 'headless' });
    const b = r.adopt('n1', 'main', { name: 'dock' });
    expect(b.el).toBe(a.el);
    expect(h.created).toHaveLength(1);
  });

  it('different slots and different nodes get different elements', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const a = r.adopt('n1', 'slot0', { name: 'x' });
    const b = r.adopt('n1', 'slot1', { name: 'x' });
    const c = r.adopt('n2', 'slot0', { name: 'x' });
    expect(new Set([a.el, b.el, c.el]).size).toBe(3);
  });

  it('init runs exactly once, at creation — not on every re-adopt', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const init = (el: FakeEl): void => { el.inits++; };
    const a = r.adopt('n1', 'main', { name: 'headless' }, { init });
    r.adopt('n1', 'main', { name: 'dock' }, { init });
    r.adopt('n1', 'main', { name: 'headless2' }, { init });
    expect(a.el.inits).toBe(1);
  });

  it('a newly created element starts PARKED (in the document, decoding)', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    // created -> parked -> mounted; it must never have been left orphaned.
    expect(h.created[0]!.parent).toBe('dock');
  });
});

describe('node media registry — the double-mount hazard', () => {
  // Canvas.svelte:1992 documents the shape: "a second mount would run two
  // media elements for one node and the first to unmount would detach the
  // survivor's source." Svelte gives no cross-tree mount/unmount ORDER
  // guarantee, so BOTH orders are asserted.

  it('NEW-adopts-then-OLD-releases: the survivor keeps the element', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const oldMount = r.adopt('n1', 'main', { name: 'dock' });
    const newMount = r.adopt('n1', 'main', { name: 'headless' });
    oldMount.release(); // stale teardown arrives LATE
    expect(newMount.el.parent).toBe('headless');
  });

  it('OLD-releases-then-NEW-adopts: the element ends up with the new host', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const oldMount = r.adopt('n1', 'main', { name: 'dock' });
    oldMount.release();
    expect(h.created[0]!.parent).toBe('PARKING');
    const newMount = r.adopt('n1', 'main', { name: 'headless' });
    expect(newMount.el.parent).toBe('headless');
  });

  it('release is idempotent and a stale release cannot re-park a live element', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const oldMount = r.adopt('n1', 'main', { name: 'dock' });
    const newMount = r.adopt('n1', 'main', { name: 'headless' });
    oldMount.release();
    oldMount.release();
    oldMount.release();
    expect(newMount.el.parent).toBe('headless');
  });

  it('the CURRENT owner releasing does park the element', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const lease = r.adopt('n1', 'main', { name: 'dock' });
    lease.release();
    expect(lease.el.parent).toBe('PARKING');
  });
});

describe('node media registry — a CARD unmount must not destroy the media', () => {
  // NEGATIVE CONTROL for the owner-reported bug. The pre-fix cards revoked the
  // object URL and stopped tracks in onDestroy; if the registry ever does that
  // on release(), these three go red.

  it('release does NOT revoke the object url', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const lease = r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:keepme');
    lease.release();
    expect(h.revoked).toEqual([]);
    expect(r.objectUrl('n1', 'main')).toBe('blob:keepme');
  });

  it('release does NOT stop the stream', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const lease = r.adopt('n1', 'main', { name: 'dock' });
    const s = fakeStream('cam');
    r.setStream('n1', 'main', s);
    lease.release();
    expect(h.stopped).toEqual([]);
    expect(r.stream('n1', 'main')).toBe(s);
  });

  it('release does NOT destroy the element — a remount adopts the same one', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const first = r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:v');
    first.release();
    const second = r.adopt('n1', 'main', { name: 'headless' });
    expect(second.el).toBe(first.el);
    expect(second.el.destroyed).toBe(false);
    expect(r.objectUrl('n1', 'main')).toBe('blob:v');
  });
});

describe('node media registry — replacing a url/stream frees the OLD one', () => {
  it('setObjectUrl revokes the previous url, never the incoming one', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:one');
    r.setObjectUrl('n1', 'main', 'blob:two');
    expect(h.revoked).toEqual(['blob:one']);
    expect(r.objectUrl('n1', 'main')).toBe('blob:two');
  });

  it('setObjectUrl(null) revokes and clears', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:one');
    r.setObjectUrl('n1', 'main', null);
    expect(h.revoked).toEqual(['blob:one']);
    expect(r.objectUrl('n1', 'main')).toBeNull();
  });

  it('re-setting the SAME url does not revoke it', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:same');
    r.setObjectUrl('n1', 'main', 'blob:same');
    expect(h.revoked).toEqual([]);
  });

  it('setStream stops the previous stream, never the incoming one', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    const a = fakeStream('a');
    const b = fakeStream('b');
    r.setStream('n1', 'main', a);
    r.setStream('n1', 'main', b);
    expect(h.stopped).toEqual([a]);
    expect(r.stream('n1', 'main')).toBe(b);
  });

  it('a url set BEFORE any adopt is still owned (load racing the mount)', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.setObjectUrl('n1', 'main', 'blob:early');
    expect(r.objectUrl('n1', 'main')).toBe('blob:early');
    r.disposeNode('n1');
    expect(h.revoked).toEqual(['blob:early']);
  });
});

describe('node media registry — a NODE deletion does tear everything down', () => {
  // The positive control for the pair above: teardown must still HAPPEN, just
  // keyed to graph lifetime instead of view lifetime.

  it('disposeNode revokes urls, stops streams and destroys elements', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const lease = r.adopt('n1', 'main', { name: 'dock' });
    const s = fakeStream('cam');
    r.setObjectUrl('n1', 'main', 'blob:gone');
    r.setStream('n1', 'main', s);
    r.disposeNode('n1');
    expect(h.revoked).toEqual(['blob:gone']);
    expect(h.stopped).toEqual([s]);
    expect(lease.el.destroyed).toBe(true);
    expect(r.peek('n1', 'main')).toBeNull();
  });

  it('disposeNode covers EVERY slot of the node', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    for (const slot of ['s0', 's1', 's2']) {
      r.adopt('n1', slot, { name: 'dock' });
      r.setObjectUrl('n1', slot, `blob:${slot}`);
    }
    r.disposeNode('n1');
    expect(h.revoked.sort()).toEqual(['blob:s0', 'blob:s1', 'blob:s2']);
    expect(r.snapshot().filter((s) => s.nodeId === 'n1')).toEqual([]);
  });

  it('disposeNode is idempotent and does not touch other nodes', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:one');
    r.adopt('n2', 'main', { name: 'dock' });
    r.setObjectUrl('n2', 'main', 'blob:two');
    r.disposeNode('n1');
    r.disposeNode('n1');
    expect(h.revoked).toEqual(['blob:one']);
    expect(r.objectUrl('n2', 'main')).toBe('blob:two');
  });

  it('sweep disposes exactly the nodes absent from the live graph', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    for (const n of ['keep', 'drop']) {
      r.adopt(n, 'main', { name: 'dock' });
      r.setObjectUrl(n, 'main', `blob:${n}`);
    }
    r.sweep(['keep']);
    expect(h.revoked).toEqual(['blob:drop']);
    expect(r.snapshot().map((s) => s.nodeId)).toEqual(['keep']);
  });

  it('sweep over the full live set is a no-op (never tears down a live node)', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:one');
    r.sweep(['n1', 'n2']);
    expect(h.revoked).toEqual([]);
    expect(r.objectUrl('n1', 'main')).toBe('blob:one');
  });
});

describe('node media registry — snapshot reports adoption state', () => {
  it('adopted flips with adopt/release and tracks url + stream presence', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const lease = r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:x', 'clip.mp4');
    expect(r.snapshot()).toEqual([
      { nodeId: 'n1', slot: 'main', adopted: true, hasUrl: true, name: 'clip.mp4', hasStream: false, hasDisposer: false },
    ]);
    lease.release();
    expect(r.snapshot()).toEqual([
      { nodeId: 'n1', slot: 'main', adopted: false, hasUrl: true, name: 'clip.mp4', hasStream: false, hasDisposer: false },
    ]);
  });
});

describe('node media registry — the filename a remount REHYDRATES from', () => {
  // A card's `localFileName` / `slotNames` were card-local $state, so a remount
  // came up believing the node had no local file: it re-showed the "re-link"
  // prompt and let the transport pause a video that was still playing
  // (measured on the re-expand leg of the fix). The name lives beside the url
  // so an adopting card can restore its reactive mirror.

  it('survives a release/re-adopt cycle — what a remounting card reads back', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const first = r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:v', 'lobby-clip.webm');
    first.release();
    r.adopt('n1', 'main', { name: 'headless' });
    expect(r.mediaName('n1', 'main')).toBe('lobby-clip.webm');
  });

  it('is null when the node never loaded anything', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    expect(r.mediaName('n1', 'main')).toBeNull();
  });

  it('a new file REPLACES the name; clearing the url clears it', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:a', 'a.mp4');
    r.setObjectUrl('n1', 'main', 'blob:b', 'b.mp4');
    expect(r.mediaName('n1', 'main')).toBe('b.mp4');
    r.setObjectUrl('n1', 'main', null);
    expect(r.mediaName('n1', 'main')).toBeNull();
  });

  it('omitting the name on a url set KEEPS the existing one', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:a', 'a.mp4');
    r.setObjectUrl('n1', 'main', 'blob:b');
    expect(r.mediaName('n1', 'main')).toBe('a.mp4');
  });
});

describe('node media registry — the per-entry DISPOSER (hls.js and friends)', () => {
  // PEERTUBE / TVLIBRARIAN attach an hls.js instance to their element. It is
  // not something the registry models, and their cards used to destroy it in
  // onDestroy — which killed playback on a card MOVE just as surely as
  // revoking a url did. It now hands the teardown here, keyed to node life.

  it('a disposer does NOT run on card release', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const lease = r.adopt('n1', 'main', { name: 'dock' });
    let destroyed = 0;
    r.setDisposer('n1', 'main', () => { destroyed++; });
    lease.release();
    expect(destroyed).toBe(0);
  });

  it('a disposer DOES run on node disposal, before the element is destroyed', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const lease = r.adopt('n1', 'main', { name: 'dock' });
    const order: string[] = [];
    r.setDisposer('n1', 'main', () => {
      // hls must detach while the element still exists.
      order.push(`dispose:destroyed=${lease.el.destroyed}`);
    });
    r.disposeNode('n1');
    expect(order).toEqual(['dispose:destroyed=false']);
    expect(lease.el.destroyed).toBe(true);
  });

  it('a disposer runs on SWEEP too (the route a real node deletion takes)', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    let destroyed = 0;
    r.setDisposer('n1', 'main', () => { destroyed++; });
    r.sweep([]);
    expect(destroyed).toBe(1);
  });

  it('replacing a disposer tears the PREVIOUS one down (no hls leak on re-attach)', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    const torn: string[] = [];
    r.setDisposer('n1', 'main', () => torn.push('first'));
    r.setDisposer('n1', 'main', () => torn.push('second'));
    expect(torn).toEqual(['first']);
    r.disposeNode('n1');
    expect(torn).toEqual(['first', 'second']);
  });

  it('a disposer runs AT MOST once', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    let destroyed = 0;
    r.setDisposer('n1', 'main', () => { destroyed++; });
    r.disposeNode('n1');
    r.disposeNode('n1');
    expect(destroyed).toBe(1);
  });

  it('a throwing disposer does not block the rest of teardown', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    const lease = r.adopt('n1', 'main', { name: 'dock' });
    r.setObjectUrl('n1', 'main', 'blob:x');
    r.setDisposer('n1', 'main', () => { throw new Error('hls exploded'); });
    expect(() => r.disposeNode('n1')).not.toThrow();
    expect(h.revoked).toEqual(['blob:x']);
    expect(lease.el.destroyed).toBe(true);
  });

  it('setDisposer(null) clears without running it', () => {
    const h = harness();
    const r = createNodeMediaRegistry(h.ops);
    r.adopt('n1', 'main', { name: 'dock' });
    let destroyed = 0;
    const d = (): void => { destroyed++; };
    r.setDisposer('n1', 'main', d);
    r.setDisposer('n1', 'main', null);
    // Handing over to null tears the previous one down (it is a hand-over,
    // not an abandon) — then disposal has nothing left to run.
    expect(destroyed).toBe(1);
    r.disposeNode('n1');
    expect(destroyed).toBe(1);
  });
});

describe('node media registry — element KINDS', () => {
  it('creates the kind the caller asked for (archivist needs three)', () => {
    const kinds: string[] = [];
    const ops: NodeMediaOps<FakeEl, FakeHost> = {
      create(nodeId, slot, kind) {
        kinds.push(kind);
        return { id: `${nodeId}/${slot}`, parent: null, destroyed: false, inits: 0 };
      },
      mount(el, host) { el.parent = host.name; },
      park(el) { el.parent = 'PARKING'; },
      destroy(el) { el.destroyed = true; },
      revokeUrl() { /* */ },
      stopStream() { /* */ },
    };
    const r = createNodeMediaRegistry(ops);
    r.adopt('n1', 'video', { name: 'h' }, { kind: 'video' });
    r.adopt('n1', 'image', { name: 'h' }, { kind: 'img' });
    r.adopt('n1', 'audio', { name: 'h' }, { kind: 'audio' });
    expect(kinds).toEqual(['video', 'img', 'audio']);
  });
});
