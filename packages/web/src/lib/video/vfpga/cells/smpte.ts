// packages/web/src/lib/video/vfpga/cells/smpte.ts
//
// CLB generator cell `smpte` — renders the SMPTE-bars test pattern (the
// authenticity dogfood for the fabric → place-and-route path, design §4.2/§5 P1).
// ZERO inputs (a pure pattern generator), three host-bound knobs (shift /
// brightness / saturation). The kernel is the SHARED `SMPTE_FRAG` string the
// legacy hand-authored `effect` also uses, so a fabric routing this cell to vout1
// produces a pass that renders BYTE-IDENTICAL to the legacy path.
//
// The three knob uniforms map 1:1 onto the spec's CV role (uShift) + param slots
// (uBrightness, uSaturation); the host's setAllUniforms writes them BY NAME from
// the spec's cvRoles/params — identical to the legacy effect — so this generator
// needs no new factory uniform plumbing. P&R simply lists these uniforms on the
// emitted pass (cell.knobs → pass.uniforms) so the host knows to set them.

import { type VfpgaCell } from './types';
import {
  SMPTE_FRAG,
  SMPTE_UNIFORM_SHIFT,
  SMPTE_UNIFORM_BRIGHTNESS,
  SMPTE_UNIFORM_SATURATION,
} from '$lib/video/vfpga/specs/smpte-frag';

export const smpteCell: VfpgaCell = {
  type: 'clb',
  op: 'smpte',
  inputs: [], // a pure generator — no sampled inputs
  knobs: [
    {
      name: 'shift',
      uniform: SMPTE_UNIFORM_SHIFT,
      defaultValue: 0,
      label: 'SHIFT',
      doc: 'Cyclically rotates the seven top bars left (0..7 columns).',
    },
    {
      name: 'brightness',
      uniform: SMPTE_UNIFORM_BRIGHTNESS,
      defaultValue: 0.5,
      label: 'BRIGHT',
      doc: '0.5 = textbook 75% bars; 1.0 scales the bars to 100% amplitude.',
    },
    {
      name: 'saturation',
      uniform: SMPTE_UNIFORM_SATURATION,
      defaultValue: 1,
      label: 'SAT',
      doc: 'Chroma saturation: 0 collapses the bars to greyscale (luma), 1 = full colour.',
    },
  ],
  doc: 'SMPTE colour-bars test-pattern generator (0 inputs → 1 output).',
  // The kernel is the SHARED, fixed SMPTE_FRAG (single source of truth with the
  // legacy effect). It declares its own `uShift`/`uBrightness`/`uSaturation`
  // uniforms — which match the knob uniforms above — so the host sets them by
  // name; uniformFor()/uTexFor() are unused (no inputs, fixed uniform names).
  kernel() {
    return SMPTE_FRAG;
  },
};
