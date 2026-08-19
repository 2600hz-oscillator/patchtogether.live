// packages/web/src/lib/video/modules/4plexvid.test.ts
//
// Locks down 4PLEXVID's module-def shape + exercises the factory's
// gate -> selector-advance plumbing with a fake GL context (no real
// WebGL needed — mirrors videobox.test.ts). The GL-side per-output
// passthrough render is covered by e2e/tests/4plexvid.spec.ts.

import { describe, expect, it } from 'vitest';
import { fourPlexVidDef, plexSelIndex } from './4plexvid';
import type { VideoEngineContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
import { patch } from '$lib/graph/store';
// Side-effect import auto-registers every video def (including ours).
import '$lib/video/modules';

describe('fourPlexVidDef — module def shape', () => {
  it('appears in the global video registry list (auto-registered via barrel import)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('4plexvid');
    expect(getVideoModuleDef('4plexvid')).toBe(fourPlexVidDef);
  });
});

// ---------------------------------------------------------------------------
// Factory gate -> selector-advance plumbing (fake GL — no real WebGL).
// ---------------------------------------------------------------------------

function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub,
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    texImage2D: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    NEAREST: 0, CLAMP_TO_EDGE: 0,
  } as unknown as WebGL2RenderingContext;
}

function makeCtx(): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
  };
}

function spawn(params: Record<string, number> = {}) {
  const node = { id: 'plex', type: '4plexvid', domain: 'video', params, position: { x: 0, y: 0 } } as ModuleNode;
  return fourPlexVidDef.factory(makeCtx(), node);
}

/** A gate pulse = rising edge (1) then falling edge (0). */
function pulse(h: ReturnType<typeof spawn>, gateId: string) {
  h.setParam(gateId, 1);
  h.setParam(gateId, 0);
}

describe('fourPlexVidDef.factory — gate advances the matching selector', () => {
  it('defaults every selector to 0 (in1)', () => {
    const h = spawn();
    for (const s of ['sel1', 'sel2', 'sel3', 'sel4']) expect(h.readParam(s)).toBe(0);
  });

  it('a gate rising edge rotates only its own output selector', () => {
    const h = spawn();
    pulse(h, 'gate1');
    expect(h.readParam('sel1')).toBe(1);
    // The other selectors are untouched — independent per-output routing.
    expect(h.readParam('sel2')).toBe(0);
    expect(h.readParam('sel3')).toBe(0);
    expect(h.readParam('sel4')).toBe(0);
  });

  it('four pulses wrap the selector full circle (1->2->3->0)', () => {
    const h = spawn();
    pulse(h, 'gate2'); expect(h.readParam('sel2')).toBe(1);
    pulse(h, 'gate2'); expect(h.readParam('sel2')).toBe(2);
    pulse(h, 'gate2'); expect(h.readParam('sel2')).toBe(3);
    pulse(h, 'gate2'); expect(h.readParam('sel2')).toBe(0); // wrapped
  });

  it('a held-high gate advances exactly once (edge-triggered, not level)', () => {
    const h = spawn();
    h.setParam('gate3', 1);
    h.setParam('gate3', 1);
    h.setParam('gate3', 1);
    expect(h.readParam('sel3')).toBe(1); // one advance, not three
  });

  it('honors a persisted selector starting value', () => {
    const h = spawn({ sel4: 2 });
    expect(h.readParam('sel4')).toBe(2);
    pulse(h, 'gate4');
    expect(h.readParam('sel4')).toBe(3);
    pulse(h, 'gate4');
    expect(h.readParam('sel4')).toBe(0); // wrap from 3
  });

  it('a directly-set selector value persists + is the base for the next advance', () => {
    const h = spawn();
    h.setParam('sel1', 2); // UI knob set
    expect(h.readParam('sel1')).toBe(2);
    pulse(h, 'gate1');
    expect(h.readParam('sel1')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// #1959 — THE CARD/ENGINE DIVERGENCE, AND THE NaN SELECTOR
//
// ⚠ EVERY ASSERTION IN THE BLOCK ABOVE GOES THROUGH `readParam`, AND THAT IS
// THE COPY THAT WAS ALWAYS RIGHT. `spawn()` does not even keep the node, so the
// suite was structurally incapable of seeing the defect it sits next to: the
// factory takes `{ ...DEFAULTS, ...node.params }` — a FRESH OBJECT — and the
// gate path mutates only that. The card reads `node.params[...]` and passes no
// `readLive`, so it renders the value the router left behind.
//
// The legs below HOLD THE NODE OBJECT. That is the whole difference, and it is
// why they are a separate block with its own spawn helper rather than more
// cases in the one above.
// ---------------------------------------------------------------------------

/**
 * Spawn against a REAL node in the live patch store, and hand back that node.
 *
 * ⚠ IT HAS TO BE THE STORE, NOT THE OBJECT THE FACTORY IS HANDED, AND FINDING
 * THAT OUT IS PART OF THE FIX. The video engine hands `factory` a node off the
 * reconciled PatchSnapshot, so writing to that object would reach a snapshot
 * and nothing else — which is exactly why `drumseqz`'s transport reflect reads
 * `livePatch.nodes[nodeId]` rather than its own argument. The first draft of
 * these legs asserted on the handed object and failed against a correct fix,
 * which is the useful kind of failure: it says the seam is the STORE.
 */
const HELD_ID = 'plex-held';
function spawnHoldingNode(params: Record<string, number> = {}) {
  patch.nodes[HELD_ID] = {
    id: HELD_ID, type: '4plexvid', domain: 'video',
    position: { x: 0, y: 0 }, params: { ...params },
  } as unknown as ModuleNode;
  const node = patch.nodes[HELD_ID] as ModuleNode;
  return { node, handle: fourPlexVidDef.factory(makeCtx(), node) };
}

/** The params the CARD would render — read back off the live store by id. */
function storedParams(): Record<string, number> {
  return (patch.nodes[HELD_ID] as ModuleNode).params as Record<string, number>;
}

describe('#1959 — the gate-advanced selector reaches the STORE, not just the copy', () => {
  it('two rising edges leave the router AND the node agreeing on IN 3', async () => {
    // The exact measurement from the spec's ATTACK 5, now as a permanent leg.
    // Before the fix this read `readParam = 2` / `node.params.sel1 = undefined`
    // — the card showing IN 1 while OUT 1 carried IN 3, permanently.
    const { handle } = spawnHoldingNode();
    const h = await handle;
    pulse(h, 'gate1');
    pulse(h, 'gate1');
    expect(h.readParam('sel1'), 'the router advanced twice').toBe(2);
    expect(
      storedParams().sel1,
      'and the NODE says so too — this is what the card renders and what persists',
    ).toBe(2);
  });

  it('reflects only the gate\'s OWN selector — the other three never appear in the node', async () => {
    // The discriminating leg: a fix that wrote all four back on every edge
    // would pass the test above and be a different bug.
    const { handle } = spawnHoldingNode();
    const h = await handle;
    pulse(h, 'gate2');
    expect(storedParams().sel2).toBe(1);
    for (const other of ['sel1', 'sel3', 'sel4']) {
      expect(storedParams()[other], other).toBeUndefined();
    }
  });

  it('NEGATIVE CONTROL — a gate that does NOT cross the rise threshold writes nothing', async () => {
    // Proves the leg above is watching the EDGE and not merely "setParam was
    // called": without this, a reflect on every gate write would look identical.
    const { handle } = spawnHoldingNode();
    const h = await handle;
    h.setParam('gate1', 0.5); // below GATE_RISE — no edge
    expect(storedParams().sel1).toBeUndefined();
    expect(h.readParam('sel1')).toBe(0);
  });

  it('the two sides agree across a WRAP, not just a first advance', async () => {
    const { handle } = spawnHoldingNode({ sel4: 3 });
    const h = await handle;
    pulse(h, 'gate4');
    expect(h.readParam('sel4')).toBe(0);
    expect(storedParams().sel4).toBe(0);
  });
});

describe('#1959 — a NON-FINITE persisted selector recovers instead of blacking an output', () => {
  it('resolves NaN and ±Infinity to IN 1 at load', async () => {
    // Measured before the fix: `readParam('sel1')` returned NaN, because every
    // arm of `((round(raw) % 4) + 4) % 4` is NaN-preserving. `INPUT_IDS[NaN]`
    // is undefined, so the shader took its `uHas < 0.5` BLACK branch on that
    // output for the life of the patch, with no gate able to walk it back.
    const h = await spawn({ sel1: NaN, sel2: Infinity, sel3: -Infinity });
    expect(h.readParam('sel1')).toBe(0);
    expect(h.readParam('sel2')).toBe(0);
    expect(h.readParam('sel3')).toBe(0);
  });

  it('a non-finite selector can still be ADVANCED afterwards — the recovery is real', async () => {
    // The leg that distinguishes "sanitised" from "merely reported as 0". A
    // NaN left in the working copy would make `advanceSelector(NaN)` NaN again.
    const h = await spawn({ sel1: NaN });
    pulse(h, 'gate1');
    expect(h.readParam('sel1')).toBe(1);
  });

  it('sanitises a non-finite value written LIVE, not only one that was persisted', async () => {
    const h = await spawn();
    h.setParam('sel1', Number.NaN);
    expect(h.readParam('sel1')).toBe(0);
    h.setParam('sel2', Infinity);
    expect(h.readParam('sel2')).toBe(0);
  });

  it('NEGATIVE CONTROL — ordinary out-of-range values still WRAP rather than clamping to 0', () => {
    // Guards against "fix it by zeroing anything unusual": the modulo wrap is
    // the shipped behaviour for finite input and must survive the NaN guard.
    expect(plexSelIndex(7)).toBe(3);
    expect(plexSelIndex(-1)).toBe(3);
    expect(plexSelIndex(4)).toBe(0);
    expect(plexSelIndex(2.4)).toBe(2);
    expect(plexSelIndex(2.6)).toBe(3);
  });
});
