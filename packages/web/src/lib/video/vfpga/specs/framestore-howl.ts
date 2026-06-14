// packages/web/src/lib/video/vfpga/specs/framestore-howl.ts
//
// framestore-howl — the FEEDBACK FLAGSHIP bent VFPGA (design §3.3). Bends a
// digital FRAME-STORE write/read into video HOWL-AROUND: the buffer-recirculation
// feedback bend. A register tile IS the frame store; reading it via `:prev`
// (last frame), warping that recirculated picture (zoom / rotate / hue-spin /
// decay), and re-mixing it with the live input each frame is the howl loop. This
// is the catalog's "register = feedback" demonstration.
//
// FABRIC (a real feedback cycle, cut at the register's :prev clocked read):
//   IIN1 ──────────────┐
//   store:prev → warp ─┤ mix(live, warpedPrev, t=feedback) → store (frame store)
//                                                          └→ out (passthru) → OUT1
// this-frame deps: warp(store:prev) [cut] ; mix(IIN1, warp) ; store(mix) ;
// out(mix). Acyclic → order warp → mix → {store, out}. NOTE the dedicated `out`
// passthru: P&R renders the vout1 tile straight into the surface 'output' and
// drops its own FBO, so the vout1 tile must have NO other consumer. `mix` keeps
// its own FBO (read by both `store` and `out`); `out` is the one that targets the
// surface. The register's ping-pong front/back FBOs are allocated ONCE in the
// factory and SWAPPED in place at end of frame (the clock edge) — no per-frame
// allocation, no FBO leak (the leak audit the plan flags: state is render-local
// GPU FBOs, never the Y.Doc).
//
// CONTROLS: p1 feedback gain (mix blend toward the recirculated frame), p2 zoom
// (the howl motion; a small constant rotation rides along for a spiral), p3 hue-
// shift per frame (rainbow howl), p4 decay (the warp gain — <1 trails fade, →1
// runaway). CIN1 adds onto the zoom CV; GIN1 is a HELD gate that CLEARS the store.

import type { VfpgaSpec } from '$lib/video/vfpga/types';

export const framestoreHowlSpec: VfpgaSpec = {
  id: 'framestore-howl',
  name: 'framestore-howl',
  doc:
    'The feedback flagship: a frame-store / howl-around circuit-bent VFPGA. A ' +
    'register tile holds the frame store; each frame the previous frame is read ' +
    'back, warped (zoomed, rotated, hue-spun, decayed) and re-mixed with the live ' +
    'input, then re-stored — the classic video howl-around / buffer-recirculation ' +
    'bend. Feedback gain past ~1 with decay near 1 gives runaway trails; the zoom ' +
    'drives a tunnel/spiral howl and the per-frame hue-shift a rainbow howl. CIN1 ' +
    'adds onto the zoom; GIN1 is a held gate that clears the store. The register ' +
    'ping-pong FBOs are render-local GPU state, swapped in place (no leak, no ' +
    'Y.Doc writes).',
  docSlug: 'framestore-howl',
  videoIn: 1,
  videoOut: 1,
  cvRoles: [
    { slot: 1, label: 'ZOOM', uniform: 'uWarpZoom', doc: 'Adds onto the per-frame zoom (patch an LFO to breathe the howl).' },
  ],
  gateRoles: [
    { slot: 1, label: 'CLEAR', heldUniform: 'uWarpClear', doc: 'A HELD gate: while high, the frame store is wiped to black (clear the howl).' },
  ],
  params: [
    { slot: 1, label: 'feedback', uniform: 'uMixT', min: 0, max: 1, defaultValue: 0.6, curve: 'linear', doc: 'Blend toward the recirculated frame (the feedback amount).' },
    { slot: 2, label: 'zoom', uniform: 'uWarpZoom', min: 0.9, max: 1.1, defaultValue: 1.02, curve: 'linear', doc: 'Per-frame zoom about centre (>1 tunnel-in howl, <1 tunnel-out).' },
    { slot: 3, label: 'hue', uniform: 'uWarpHue', min: 0, max: 0.1, defaultValue: 0.01, curve: 'linear', doc: 'Per-frame hue rotation (rainbow howl).' },
    { slot: 4, label: 'decay', uniform: 'uWarpGain', min: 0.8, max: 1.0, defaultValue: 0.96, curve: 'linear', doc: 'Per-frame feedback decay (<1 trails fade, →1 runaway).' },
  ],
  fabric: {
    grid: { rows: 1, cols: 3 },
    tiles: [
      // WARP the recirculated previous frame (zoom/rot/hue/decay). rot is a small
      // static const so the howl spirals; zoom/hue/gain are param-bound; CIN1 adds
      // onto zoom and GIN1's held CLEAR wipes the recirculation.
      {
        id: 'warp',
        type: 'clb',
        config: {
          op: 'warp',
          consts: { rot: 0.02 },
          bind: [
            { knob: 'zoom', to: 'p', slot: 2, uniform: 'uWarpZoom' },
            { knob: 'hue', to: 'p', slot: 3, uniform: 'uWarpHue' },
            { knob: 'gain', to: 'p', slot: 4, uniform: 'uWarpGain' },
            { knob: 'clear', to: 'gate', slot: 1, uniform: 'uWarpClear' },
          ],
        },
        pos: { row: 0, col: 1 },
        inputs: ['a'],
      },
      // MIX the live input with the warped previous frame (feedback amount).
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
      // The FRAME STORE: a register (ping-pong) capturing the composited frame.
      { id: 'store', type: 'reg', config: { op: 'reg' }, pos: { row: 0, col: 2 }, inputs: ['a'] },
      // The vout1 driver — a passthru so `mix` keeps its own FBO for `store`.
      { id: 'out', type: 'clb', config: { op: 'passthru' }, pos: { row: 0, col: 3 }, inputs: ['a'] },
      { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
    ],
    nets: [
      { from: 'store:prev', to: 'warp:a' }, // read LAST frame (cuts the cycle)
      { from: 'IIN1', to: 'mix:a' }, // live input
      { from: 'warp', to: 'mix:b' }, // warped recirculated frame
      { from: 'mix', to: 'store:a' }, // re-store the composite
      { from: 'mix', to: 'out:a' }, // feed the output passthru
      { from: 'out', to: 'OUT1' }, // output the composite
    ],
    outputs: { vout1: 'o1' },
    budget: { passes: 4 },
  },
};
