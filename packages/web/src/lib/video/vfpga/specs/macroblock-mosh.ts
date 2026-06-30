// packages/web/src/lib/video/vfpga/specs/macroblock-mosh.ts
//
// macroblock-mosh — EARLY-HD-era bent VFPGA (design §3.5), the TWO-CLIP DATAMOSH
// flagship (design research 2026-06-30 §4). Bends MPEG/H.264 motion-compensated
// block prediction into the classic I-frame-removal DATAMOSH look: motion vectors
// applied to the wrong reference so the picture melts and smears. The REFERENCE
// FRAME is a register/BRAM frame-store (a real feedback loop, cut at the register's
// `:prev` clocked read); each frame the recirculated reference is warped block-by-
// block by motion-vectors + macroblock-quantized (the `mosh` cell), then mixed with
// the live input and re-stored. GIN1 is a HELD gate that FORCES an I-FRAME — a clean
// reference reload (the codec reset pulse).
//
// MULTI-IO (vfpga two-input flagship): the runner exposes 4 video ins; this bend
// now uses TWO. IIN1 is the IMAGE (clip A — the picture that moshes). IIN2 is the
// MOTION SOURCE (clip B — the `srcB` role): the mosh cell estimates clip B's per-
// block motion (normal flow from B-now vs B-last-frame) and CARRIES it onto image A
// — the canonical datamosh "apply clip B's motion vectors to clip A". A second
// register (`storeB`) holds clip B's previous frame so the cell can see B's motion.
// The block motion is the SUM of a synthetic seeded storm (p2 `mvect`) and the
// transferred clip-B motion (p5 `mvectB`): dial `mvect` to 0 + `mvectB` up for a
// PURE two-clip transfer, or leave IIN2 unpatched (B reads transparent black → zero
// flow) for the original single-source synthetic mosh — byte-for-byte unchanged.
//
// FABRIC (a feedback cycle cut at store:prev, mirroring framestore-howl; storeB is a
// second register feeding only its :prev to the mosh, so it adds no cycle):
//   IIN1 ─────────────────────────────┐
//   store:prev → mosh(+B-motion) ─────┤ mix(live, moshedPrev, t=mosh) → store
//   IIN2 → storeB ─┐                                                  └→ out → OUT1
//   IIN2, storeB:prev ─→ mosh (motion estimate)
// this-frame deps: mosh(store:prev, IIN2, storeB:prev) [store/storeB cut] ;
// mix(IIN1, mosh) ; store(mix) ; out(mix). Acyclic → order mosh → mix → {store, out}.
// `mix` keeps its own FBO (read by both `store` and `out`); `out` is the vout1
// passthru P&R renders into the surface.
//
// CONTROLS: p1 mosh amount (mix blend toward the moshed reference = the P-frame
// strength), p2 synthetic motion-vector gain (the storm), p3 block size, p4
// macroblock quantize, p5 transferred-motion gain (clip B → image A). CIN1 adds onto
// the synthetic motion gain; CIN2 adds onto the transferred-motion gain; GIN1 is a
// HELD gate that forces a clean I-frame.

import type { VfpgaSpec } from '$lib/video/vfpga/types';

export const macroblockMoshSpec: VfpgaSpec = {
  id: 'macroblock-mosh',
  name: 'macroblock-mosh',
  doc:
    'An early-HD circuit-bent VFPGA that datamoshes the picture — MPEG/H.264 ' +
    'motion-compensated block prediction applied to the wrong reference, the ' +
    'classic I-frame-removal mosh. A register frame-store holds the reference; each ' +
    'frame the previous frame is read back, warped block-by-block by motion-vectors ' +
    '(the P-frame smear), macroblock-quantized (the DCT-block look), and re-mixed ' +
    'with the live input before being re-stored. The block motion combines a ' +
    'synthetic seeded storm (p2) with TRANSFERRED motion from a SECOND clip: patch a ' +
    'motion source to IIN2 and the bend estimates that clip’s per-block motion and ' +
    'carries it onto the picture (the canonical two-clip datamosh — clip B’s motion ' +
    'vectors on clip A). p1 sets the mosh amount (P-frame vs live), p2 the synthetic ' +
    'motion gain, p3 the block size, p4 the quantize, p5 the transferred-motion gain ' +
    '(0 + IIN2 unpatched = the original single-source mosh). CIN1/CIN2 add onto the ' +
    'two motion gains; GIN1 is a held gate that forces a clean I-frame (a reference ' +
    'reload). Every synthetic motion-vector is deterministic (frame + block + seed ' +
    'hashed) and the transferred motion is a deterministic normal-flow estimate, so ' +
    'the bend is reproducible. Both register frame-store ping-pong FBOs are render-' +
    'local GPU state, swapped in place (no leak, no Y.Doc writes).',
  docSlug: 'macroblock-mosh',
  videoIn: 2,
  videoOut: 1,
  cvRoles: [
    { slot: 1, label: 'MVECT', uniform: 'uMoshMvect', doc: 'Adds onto the synthetic motion-vector gain (patch an LFO to drift the mosh storm).' },
    { slot: 2, label: 'MXFER', uniform: 'uMoshMvectB', doc: 'Adds onto the transferred-motion gain (modulate how much of clip B’s motion lands on the picture).' },
  ],
  gateRoles: [
    { slot: 1, label: 'I-FRAME', heldUniform: 'uMoshIframe', doc: 'A HELD gate: while high, force a clean I-frame (the reference reloads from live).' },
  ],
  params: [
    { slot: 1, label: 'mosh', uniform: 'uMixT', min: 0, max: 1, defaultValue: 0.85, curve: 'linear', doc: 'Blend toward the moshed reference (the P-frame strength / mosh amount).' },
    { slot: 2, label: 'mvect', uniform: 'uMoshMvect', min: 0, max: 0.3, defaultValue: 0.05, curve: 'linear', doc: 'Synthetic motion-vector gain — the seeded block displacement (a storm runs away).' },
    { slot: 3, label: 'block', uniform: 'uMoshBlock', min: 4, max: 64, defaultValue: 16, curve: 'linear', units: 'px', doc: 'Macroblock size in pixels (the block-grid quantum).' },
    { slot: 4, label: 'quant', uniform: 'uMoshQuant', min: 0, max: 1, defaultValue: 0.3, curve: 'linear', doc: 'Per-block colour quantize (the DCT-block posterize look).' },
    { slot: 5, label: 'mxfer', uniform: 'uMoshMvectB', min: 0, max: 0.3, defaultValue: 0.0, curve: 'linear', doc: 'Transferred-motion gain — carry clip B’s (IIN2) per-block motion onto the picture (two-clip datamosh).' },
  ],
  fabric: {
    // 5 placed compute tiles: mix@0, mosh@1, store@2, out@3, storeB@4 (cols:5). The
    // grid is floorplan metadata only (no effect on the compiled passes).
    grid: { rows: 1, cols: 5 },
    tiles: [
      // MOSH the recirculated previous frame: block motion-vector warp (synthetic +
      // transferred from clip B) + macroblock quantize. mvect/mvectB/block/quant are
      // param-bound; CIN1/CIN2 add onto the two motion gains; GIN1's held I-FRAME
      // forces a clean reload (this tile outputs black → mix reads live). Inputs:
      // a = the recirculated reference (store:prev), b = clip B now (IIN2),
      // bprev = clip B last frame (storeB:prev).
      {
        id: 'mosh',
        type: 'clb',
        config: {
          op: 'mosh',
          bind: [
            { knob: 'mvect', to: 'p', slot: 2, uniform: 'uMoshMvect' },
            { knob: 'mvectB', to: 'p', slot: 5, uniform: 'uMoshMvectB' },
            { knob: 'block', to: 'p', slot: 3, uniform: 'uMoshBlock' },
            { knob: 'quant', to: 'p', slot: 4, uniform: 'uMoshQuant' },
            { knob: 'iframe', to: 'gate', slot: 1, uniform: 'uMoshIframe' },
          ],
        },
        pos: { row: 0, col: 1 },
        inputs: ['a', 'b', 'bprev'],
      },
      // MIX the live input with the moshed reference (the mosh amount = P-frame
      // strength). On a forced I-frame the moshed reference is black → 100% live.
      {
        id: 'mix',
        type: 'clb',
        config: {
          op: 'mix',
          bind: [{ knob: 't', to: 'p', slot: 1, uniform: 'uMixT' }],
        },
        pos: { row: 0, col: 0 },
        inputs: ['a', 'b'],
      },
      // The REFERENCE frame-store: a register (ping-pong) capturing the composite.
      { id: 'store', type: 'reg', config: { op: 'reg' }, pos: { row: 0, col: 2 }, inputs: ['a'] },
      // The vout1 driver — a passthru so `mix` keeps its own FBO for `store`.
      { id: 'out', type: 'clb', config: { op: 'passthru' }, pos: { row: 0, col: 3 }, inputs: ['a'] },
      { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
      // The clip-B MOTION-SOURCE frame-store: a register capturing IIN2 so the mosh
      // cell can read clip B's PREVIOUS frame (storeB:prev) and estimate its motion.
      // Feeds only its :prev to the mosh, so it adds no combinational cycle.
      { id: 'storeB', type: 'reg', config: { op: 'reg' }, pos: { row: 0, col: 4 }, inputs: ['a'] },
    ],
    nets: [
      { from: 'store:prev', to: 'mosh:a' }, // read LAST frame = the reference (cut)
      { from: 'IIN2', to: 'mosh:b' }, // clip B now (the motion source)
      { from: 'storeB:prev', to: 'mosh:bprev' }, // clip B last frame (cut)
      { from: 'IIN2', to: 'storeB:a' }, // capture clip B into its frame-store
      { from: 'IIN1', to: 'mix:a' }, // live input (the image)
      { from: 'mosh', to: 'mix:b' }, // the moshed reference
      { from: 'mix', to: 'store:a' }, // re-store the composite reference
      { from: 'mix', to: 'out:a' }, // feed the output passthru
      { from: 'out', to: 'OUT1' }, // output the moshed picture
    ],
    outputs: { vout1: 'o1' },
    budget: { passes: 5 },
  },
};
