// packages/web/src/lib/video/vfpga/specs/macroblock-mosh.ts
//
// macroblock-mosh — EARLY-HD-era bent VFPGA (design §3.5). Bends MPEG/H.264
// motion-compensated block prediction into the classic I-frame-removal DATAMOSH
// look: P-frames applied to the wrong reference so the picture melts and smears.
// The REFERENCE FRAME is a register/BRAM frame-store (a real feedback loop, cut at
// the register's `:prev` clocked read); each frame the recirculated reference is
// warped block-by-block by pseudo motion-vectors + macroblock-quantized (the
// `mosh` cell), then mixed with the live input and re-stored. GIN1 is a HELD gate
// that FORCES an I-FRAME — a clean reference reload (the codec reset pulse).
//
// FABRIC (a feedback cycle cut at store:prev, mirroring framestore-howl):
//   IIN1 ─────────────────┐
//   store:prev → mosh ────┤ mix(live, moshedPrev, t=moshAmount) → store (ref store)
//                                                                └→ out (passthru) → OUT1
// this-frame deps: mosh(store:prev) [cut] ; mix(IIN1, mosh) ; store(mix) ; out(mix).
// Acyclic → order mosh → mix → {store, out}. `mix` keeps its own FBO (read by both
// `store` and `out`); `out` is the vout1 passthru P&R renders into the surface.
//
// CONTROLS: p1 mosh amount (mix blend toward the moshed reference = the P-frame
// strength), p2 motion-vector gain (the block UV displacement / storm), p3 block
// size, p4 macroblock quantize. CIN1 adds onto the motion-vector gain; GIN1 is a
// HELD gate that forces a clean I-frame.

import type { VfpgaSpec } from '$lib/video/vfpga/types';

export const macroblockMoshSpec: VfpgaSpec = {
  id: 'macroblock-mosh',
  name: 'macroblock-mosh',
  doc:
    'An early-HD circuit-bent VFPGA that datamoshes the picture — MPEG/H.264 ' +
    'motion-compensated block prediction applied to the wrong reference, the ' +
    'classic I-frame-removal mosh. A register frame-store holds the reference; ' +
    'each frame the previous frame is read back, warped block-by-block by seeded ' +
    'pseudo motion-vectors (the P-frame smear), macroblock-quantized (the DCT-block ' +
    'look), and re-mixed with the live input before being re-stored. p1 sets the ' +
    'mosh amount (how much P-frame vs live), p2 the motion-vector gain (a storm ' +
    'runs away), p3 the block size, p4 the quantize. CIN1 adds onto the motion ' +
    'gain; GIN1 is a held gate that forces a clean I-frame (a reference reload). ' +
    'Every "random" motion-vector is deterministic (frame + block + seed hashed) ' +
    'so the bend is reproducible. The reference frame-store ping-pong FBOs are ' +
    'render-local GPU state, swapped in place (no leak, no Y.Doc writes).',
  docSlug: 'macroblock-mosh',
  videoIn: 1,
  videoOut: 1,
  cvRoles: [
    { slot: 1, label: 'MVECT', uniform: 'uMoshMvect', doc: 'Adds onto the motion-vector gain (patch an LFO to drift the mosh).' },
  ],
  gateRoles: [
    { slot: 1, label: 'I-FRAME', heldUniform: 'uMoshIframe', doc: 'A HELD gate: while high, force a clean I-frame (the reference reloads from live).' },
  ],
  params: [
    { slot: 1, label: 'mosh', uniform: 'uMixT', min: 0, max: 1, defaultValue: 0.85, curve: 'linear', doc: 'Blend toward the moshed reference (the P-frame strength / mosh amount).' },
    { slot: 2, label: 'mvect', uniform: 'uMoshMvect', min: 0, max: 0.3, defaultValue: 0.05, curve: 'linear', doc: 'Motion-vector gain — the block UV displacement (a storm runs away).' },
    { slot: 3, label: 'block', uniform: 'uMoshBlock', min: 4, max: 64, defaultValue: 16, curve: 'linear', units: 'px', doc: 'Macroblock size in pixels (the block-grid quantum).' },
    { slot: 4, label: 'quant', uniform: 'uMoshQuant', min: 0, max: 1, defaultValue: 0.3, curve: 'linear', doc: 'Per-block colour quantize (the DCT-block posterize look).' },
  ],
  fabric: {
    grid: { rows: 1, cols: 4 },
    tiles: [
      // MOSH the recirculated previous frame: block motion-vector warp + macroblock
      // quantize. mvect/block/quant are param-bound; CIN1 adds onto mvect; GIN1's
      // held I-FRAME forces a clean reload (this tile outputs black → mix reads live).
      {
        id: 'mosh',
        type: 'clb',
        config: {
          op: 'mosh',
          bind: [
            { knob: 'mvect', to: 'p', slot: 2, uniform: 'uMoshMvect' },
            { knob: 'block', to: 'p', slot: 3, uniform: 'uMoshBlock' },
            { knob: 'quant', to: 'p', slot: 4, uniform: 'uMoshQuant' },
            { knob: 'iframe', to: 'gate', slot: 1, uniform: 'uMoshIframe' },
          ],
        },
        pos: { row: 0, col: 1 },
        inputs: ['a'],
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
    ],
    nets: [
      { from: 'store:prev', to: 'mosh:a' }, // read LAST frame = the reference (cut)
      { from: 'IIN1', to: 'mix:a' }, // live input
      { from: 'mosh', to: 'mix:b' }, // the moshed reference
      { from: 'mix', to: 'store:a' }, // re-store the composite reference
      { from: 'mix', to: 'out:a' }, // feed the output passthru
      { from: 'out', to: 'OUT1' }, // output the moshed picture
    ],
    outputs: { vout1: 'o1' },
    budget: { passes: 4 },
  },
};
