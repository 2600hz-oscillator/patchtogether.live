// packages/web/src/lib/video/vfpga/specs/smpte-bars.ts
//
// smpte-bars — the FIRST bundled VFPGA: a pure pattern GENERATOR that renders
// SMPTE-style colour bars (0 video in → 1 video out). Generic test-pattern
// generator; "SMPTE" names the public ANSI/SMPTE EG 1-1990 test-pattern
// STANDARD (a measurement layout in the public domain), not any trademarked
// product.
//
// Layout (classic 3-band EG 1-1990 75% bars):
//   - TOP band (top ~67% of frame): 7 main bars at 75% amplitude —
//     grey, yellow, cyan, green, magenta, red, blue.
//   - MIDDLE band (~next 8%): the reverse "castellation" row —
//     blue, black, magenta, black, cyan, black, grey.
//   - BOTTOM band (remaining ~25%): the PLUGE row — -I, white(100%), +Q,
//     black, then the sub-black / black / super-black PLUGE triplet, then
//     black.
//
// One CV role: PATTERN SHIFT (uShift) cyclically rotates the 7 top bars left
// (so a slow LFO scrolls the bars — handy as a moving deterministic source for
// downstream effect bring-up). The shift is purely a horizontal column remap;
// at uShift=0 the output is the textbook bars.
//
// Pure GL, deterministic (no uTime in the colour math — the only time-varying
// input is the CV), so its CPU-snapshot preview + a frozen-CV VRT scene are
// pixel-stable.
//
// AUTHORING SURFACES (P1, design §4.2/§5): smpte-bars now carries BOTH a fabric
// (the catalog-goal authoring surface — a 1-tile generator routing the `clb:smpte`
// generator cell to vout1, which P&R lowers into a render pass) AND its original
// hand-authored `effect` (the legacy escape-hatch reference). The fabric path
// wins at runtime (resolveSpecEffect), and because the cell + the legacy effect
// share the EXACT same `SMPTE_FRAG` string, the fabric-routed pass renders
// BYTE-IDENTICAL to the legacy pass — this dogfoods place-and-route on the
// reference VFPGA with no visual change.

import type { VfpgaSpec } from '$lib/video/vfpga/types';
import { SMPTE_FRAG, SMPTE_UNIFORMS } from './smpte-frag';

export const smpteBarsSpec: VfpgaSpec = {
  id: 'smpte-bars',
  name: 'SMPTE bars',
  doc:
    'A pure pattern generator that renders SMPTE-style colour bars (the public ' +
    'SMPTE EG 1-1990 test-pattern layout): a top band of seven 75%-amplitude ' +
    'bars (grey, yellow, cyan, green, magenta, red, blue), a reverse ' +
    'castellation row, and a PLUGE / sub-black row. Zero video inputs, one ' +
    'video output — a deterministic, always-on reference source for bringing up ' +
    'and calibrating downstream video effects.',
  docSlug: 'smpte-bars',
  videoIn: 0,
  videoOut: 1,
  cvRoles: [
    {
      slot: 1,
      label: 'SHIFT',
      uniform: 'uShift',
      doc: 'Cyclically rotates the seven top bars left (0..7 columns); a slow LFO scrolls the bars to make a moving deterministic source.',
    },
  ],
  params: [
    {
      slot: 1,
      label: 'BRIGHT',
      uniform: 'uBrightness',
      min: 0.5,
      max: 1.0,
      defaultValue: 0.5,
      curve: 'linear',
      doc: '0.5 = textbook 75% bars; 1.0 scales the bars to 100% amplitude.',
    },
    {
      slot: 2,
      label: 'SAT',
      uniform: 'uSaturation',
      min: 0,
      max: 1,
      defaultValue: 1,
      curve: 'linear',
      doc: 'Chroma saturation: 0 collapses the bars to greyscale (luma), 1 = full colour.',
    },
  ],
  // FABRIC (the catalog-goal authoring surface; runtime path — design §2/§4.2).
  // A single `clb:smpte` generator tile drives vout1 via an OUT1 IOB-out net.
  // P&R lowers this into ONE pass writing the surface 'output' with the SMPTE
  // generator kernel — byte-identical to the legacy `effect` below (same FRAG).
  fabric: {
    grid: { rows: 1, cols: 1 },
    tiles: [
      // 0-input generator (no `inputs`): renders the SMPTE pattern directly. Its
      // three knobs are BOUND to the host roles (shift→cv1, brightness→p1,
      // saturation→p2) so the factory's role loop sets them live — exactly the
      // pre-bind behaviour (the bind targets are the cell's own uniform names, so
      // the frag + emitted uniform list are unchanged → still byte-identical to
      // the legacy effect, and no static const is emitted).
      {
        id: 'gen',
        type: 'clb',
        config: {
          op: 'smpte',
          bind: [
            { knob: 'shift', to: 'cv', slot: 1, uniform: 'uShift' },
            { knob: 'brightness', to: 'p', slot: 1, uniform: 'uBrightness' },
            { knob: 'saturation', to: 'p', slot: 2, uniform: 'uSaturation' },
          ],
        },
        pos: { row: 0, col: 0 },
      },
      // Fixed fabric-edge OUTPUT block → host vout1.
      { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
    ],
    nets: [{ from: 'gen', to: 'OUT1' }],
    outputs: { vout1: 'o1' },
    budget: { passes: 1 },
  },
  // LEGACY escape-hatch reference (design §4.2): the original hand-authored
  // render graph. Kept first-class as the snapshot-preview/edge-case reference;
  // resolveSpecEffect prefers `fabric` when present, so this is inert at runtime
  // but proves the two surfaces agree (same shared FRAG → identical pass).
  effect: {
    passes: [
      {
        frag: SMPTE_FRAG,
        target: 'output',
        uniforms: [...SMPTE_UNIFORMS],
      },
    ],
    outputs: { vout1: 'output' },
  },
};
