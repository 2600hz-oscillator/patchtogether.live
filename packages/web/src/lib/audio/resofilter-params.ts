// packages/web/src/lib/audio/resofilter-params.ts
//
// RESOFILTER's FOUR PARAM DECLARATIONS, in one def-free module.
//
// WHY THEY MOVED OUT OF THE DEF. Two reasons, and the second is the one that
// forced it:
//
//  1. The `ringback-crush-model` rule — the ranges live in ONE place that the
//     def, the card and the face model all import, so no surface can restate a
//     number the others own. (The card was restating six of them until
//     2026-08-11; that is the backdraft divergence class, invisible to every
//     gate we own because they all read the DEF.)
//
//  2. ⚠ A MODULE DEF CANNOT BE IMPORTED BY AN E2E SPEC, and the face model has
//     to be. `modules/resofilter.ts` opens with
//     `import workletUrl from '@patchtogether.live/dsp/dist/resofilter.js?url'`
//     — a VITE import with no meaning to Playwright's Node loader, which fails
//     the whole spec file with *"does not provide an export named 'default'"*
//     before a single test is collected. So anything a spec imports from
//     `packages/web` must be def-free, which is why `noise-face-model` and
//     `strict-faces` are and why `cofefve-face-model` (which imports its def)
//     has no e2e reading it. Keeping the numbers here lets
//     `resofilter-face.spec.ts` compute its expectations from the SAME model
//     the panel prints, instead of re-typing them — and a re-typed expectation
//     is a test that agrees with itself.
//
// The mode roster is DERIVED from the two shipping name tables rather than
// typed a third time. Relative path to the DSP lib, not the package alias, for
// the reason `warrensspectrum.ts` and `cofefve-face-model.ts` already state:
// worktrees may not symlink the workspace package under node_modules and the
// path-alias rules don't reliably resolve TS source out of it.

import type { ParamDef } from '$lib/graph/types';
import {
  RESOFILTER_MAX_MODE,
  RESOFILTER_MODE_NAMES,
  RESOFILTER_MODE_SHORT,
} from '../../../../dsp/src/lib/resofilter-dsp';

/**
 * The MODE roster: the short tag is the `.seg` caption, the long name the hover
 * title.
 *
 * ⚠ THREE OF THESE FIVE CAPTIONS CLIP AT THE DOCK, AND THAT IS SHIPPED
 * DELIBERATELY BECAUSE EVERY ALTERNATIVE A FACE CAN REACH IS WORSE. Measured on
 * the rendered dock at a 1280 px viewport: the MODE cell is 182.5 px, `.seg` is
 * `flex: 1 1 0%`, so five buttons split it into 31 px each — 15.0 px of content
 * box after 8 px of padding a side. At the button's own computed font
 * (`700 10px system-ui`, `letter-spacing: 0.6px`) the captions lay out at
 * LP 14.13 · HP 16.02 · BP 15.11 · NT 15.72 px, so HP, NT and AP paint as
 * `H…`, `N…`, `A…` while LP and BP fit. The deficit is 0.1–0.4 px: ONE more
 * pixel of button width would fit all five.
 *
 * WITHOUT `options` the control is a rotary printing `0.00`…`4.00`, which is
 * what this declaration exists to remove. As `paramCells: 'grid'` the roster
 * hides behind a chip. The actual fix — `.seg { flex: 1 1 auto }` — repaints
 * the dock baseline of every module with a Segmented (cloudseed,
 * warrensspectrum, tidyVco, cofefve, filter) and is an owner-preview PR, not a
 * rider on a face MR. The SHIPPED `filter` dock renders `LP · H… · B…` from
 * three two-letter captions on `main` today, so this is the platform's state
 * rather than a regression introduced here.
 *
 * ⚠ AND BOTH OBVIOUS INSTRUMENTS CALL IT CLEAN. `scrollWidth === clientWidth`
 * for all five (a single-line ellipsis leaves no overflow), and a canvas
 * `measureText` at the computed font returns 12.92 / 14.80 / 13.91 / 14.52 px
 * — every one UNDER the 15.0 px box — because `measureText` DROPS
 * `letter-spacing`, and 0.6 px × 2 characters is exactly the 1.2 px gap between
 * it and a Range measurement. `faces-parity` is blind for a third, independent
 * reason: it reads `textContent`, which an ellipsis does not touch. A 3×
 * screenshot of the cell is what found this.
 *
 * ⚠ `options` IS NOT A CONTRACT CHANGE, despite the batch-4 spec calling it one
 * and pricing it at "+5 contract-lock lines". `contract-signature.ts` projects
 * id/min/max/curve/default/units and nothing else, so naming a value moves ZERO
 * lines — measured: `contract-lock.txt` is byte-identical across the commit
 * that added this. `filter.ts` says the same thing about its own roster.
 */
export const RESOFILTER_MODE_OPTIONS = RESOFILTER_MODE_SHORT.map((label, value) => ({
  value,
  label,
  title: RESOFILTER_MODE_NAMES[value] as string,
}));

/**
 * The four declared params, in DECLARATION ORDER — which is load-bearing
 * independently of `face.order`: the Push 2 card and the auto-expose bar rank
 * off it (see push-card-config.ts's warning about a new param walking onto a
 * generic card).
 */
export const RESOFILTER_PARAMS: readonly ParamDef[] = [
  // Cutoff — log fader 20 Hz .. 20 kHz, default 1 kHz (Resonarium's
  // MultiFilterParams default per Parameters.cpp line 165).
  { id: 'cutoff', label: 'Cutoff', defaultValue: 1000, min: 20, max: 20000, curve: 'log', units: 'Hz' },
  // Resonance — the worklet maps this 0..1 to k = 2 − 2·res, clamped above 0 so
  // a1 = 1/(1 + g·(g + k)) stays well-defined. Default 0.3 per the brief
  // (upstream defaults nearer 0.7 / √2, which is too peaky for a stock rack).
  //
  // ⚠ THE TOP 0.15 % OF THIS SCALE IS A PLATEAU. `resToK` floors k at 0.003, so
  // every value from resonance 0.9985 to 1.0 is the identical filter, and at
  // that floor the gain at cutoff is +50.46 dB with nothing here limiting it.
  { id: 'resonance', label: 'Reso', defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
  // Mode — discrete picker over the five SVF taps. N = 5 → max = N − 1 = 4.
  // `Math.round` at the worklet, so the LP/HP boundary sits AT 0.5.
  { id: 'mode', label: 'Mode', defaultValue: 0, min: 0, max: RESOFILTER_MAX_MODE, curve: 'discrete',
    options: RESOFILTER_MODE_OPTIONS },
  // Mix — 0 = full dry (BIT-EXACT bypass, measured in all five modes), 1 = full
  // wet. Defaults fully wet since resofilter is a filter, not a parallel effect.
  { id: 'mix', label: 'Mix', defaultValue: 1, min: 0, max: 1, curve: 'linear' },
];

/** One param by id. Throws rather than returning undefined: every caller here
 *  is asking about a param this module declares, so a miss is a typo. */
export function resofilterParam(id: string): ParamDef {
  const p = RESOFILTER_PARAMS.find((q) => q.id === id);
  if (!p) throw new Error(`resofilterParam: '${id}' is not a declared resofilter param`);
  return p;
}
