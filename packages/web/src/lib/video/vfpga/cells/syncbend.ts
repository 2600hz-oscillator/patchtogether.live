// packages/web/src/lib/video/vfpga/cells/syncbend.ts
//
// CLB cell `syncBend(a, hjit, vroll, crush, tear)` — composite H/V SYNC
// corruption (the sync-bender bend, design §3.1). Models a bent CVBS sync
// separator: it MIS-ROUTES the horizontal/vertical line-lock so the picture
// rolls, tears, shears, and slips. Pure per-pixel UV remap of input `a` (no
// frame memory of its own — the drifting line-lock rides `uTime` + the seeded
// hash), so it composes anywhere in a fabric.
//
// The four bends (all DETERMINISTIC, seeded by frame-index + uv + uSeed so VRT
// stays reproducible; a GIN reseed trigger advances uSeed to roll a fresh tear):
//   - hjit  H-PHASE JITTER : a per-line horizontal offset (line slip) — the lost-
//           H-sync wobble. Each scanline samples at a hash-jittered x.
//   - vroll V-ROLL         : a continuous vertical scroll (lost V-sync → the
//           picture rolls up the screen) driven by uTime.
//   - crush SYNC-CRUSH     : loss of lock → a global shear (rows above a moving
//           break line shift sideways — the torn-frame look).
//   - tear  TEAR PROBABILITY: per-line probability of a hard horizontal RIP (a
//           big random x-jump on the unlucky lines).
//
// One input (a), four knobs + the shared seed. CV roll-speed binds onto vroll;
// a tear-burst gate binds onto uSeed (re-rolls the tear pattern).

import { type VfpgaCell } from './types';
import { BEND_SEED_GLSL, BEND_SEED_UNIFORM } from './bend-seed';

export const syncBendCell: VfpgaCell = {
  type: 'clb',
  op: 'syncBend',
  inputs: ['a'],
  knobs: [
    { name: 'hjit', uniform: 'uHJitter', defaultValue: 0.02, label: 'H-JIT', doc: 'Per-line horizontal phase jitter (line slip).' },
    { name: 'vroll', uniform: 'uVRoll', defaultValue: 0.0, label: 'V-ROLL', doc: 'Vertical roll rate (lost V-sync → picture scrolls).' },
    { name: 'crush', uniform: 'uSyncCrush', defaultValue: 0.0, label: 'CRUSH', doc: 'Sync-tip crush → torn-frame shear above a moving break line.' },
    { name: 'tear', uniform: 'uTearProb', defaultValue: 0.0, label: 'TEAR', doc: 'Per-line probability of a hard horizontal rip.' },
    { name: 'seed', uniform: BEND_SEED_UNIFORM, defaultValue: 0, label: 'SEED', doc: 'Re-rollable seed (a reseed gate advances it) for the tear/jitter pattern.' },
  ],
  doc: 'Composite H/V sync corruption: roll / tear / shear / line-slip (sync-bender).',
  kernel({ uTexFor, uniformFor }) {
    const a = uTexFor('a');
    const hjit = uniformFor('hjit');
    const vroll = uniformFor('vroll');
    const crush = uniformFor('crush');
    const tear = uniformFor('tear');
    const seed = uniformFor('seed');
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${a};
uniform vec2 uResolution;
uniform float uTime;
uniform float ${hjit};
uniform float ${vroll};
uniform float ${crush};
uniform float ${tear};
uniform float ${seed};
${BEND_SEED_GLSL}
void main() {
  float seedOff = ${seed} * 0.013;
  // line index (0..rows) — the unit the sync separator locks per scanline.
  float rows = max(uResolution.y, 1.0);
  float line = floor(vUv.y * rows);
  // V-ROLL: lost vertical lock → the whole frame scrolls (wrapped).
  float y = fract(vUv.y + uTime * ${vroll});
  float lineR = floor(y * rows);
  // H-PHASE JITTER: a per-line horizontal offset (hash by line+seed).
  float jit = (bendHash(vec2(lineR, seedOff)) - 0.5) * 2.0 * ${hjit};
  // SYNC-CRUSH: a moving break line; rows above it shear sideways (torn frame).
  float breakY = fract(uTime * 0.13 + bendHash(vec2(7.0, seedOff)));
  float shear = (y > breakY ? 1.0 : 0.0) * ${crush} * 0.25;
  // TEAR: unlucky lines get a hard random horizontal rip.
  float roll = bendHash(vec2(lineR + 0.5, seedOff + 1.7));
  float rip = roll < ${tear} ? (bendHash(vec2(lineR, seedOff + 9.1)) - 0.5) : 0.0;
  float x = fract(vUv.x + jit + shear + rip);
  outColor = texture(${a}, vec2(x, y));
}`;
  },
};
