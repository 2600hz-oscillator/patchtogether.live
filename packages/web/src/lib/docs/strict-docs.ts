// packages/web/src/lib/docs/strict-docs.ts
//
// The RATCHET set for the living-docs system: module types that have been
// PROMOTED to the full documentation bar. For a module in this set the
// module-docs lint enforces COMPLETENESS — every port, every param, and every
// declared control family MUST carry an authored `docs` entry (the
// deny(missing_docs) guarantee at the I/O surface), so adding a new port to a
// strict module fails CI until it is documented.
//
// Modules NOT in this set are checked only for CONSISTENCY (no orphaned doc
// keys) — they degrade gracefully while the ratchet rolls out. Promote a module
// here once its `docs` are authored + verified. The set only grows:
//  - batches of ~5 as background work,
//  - every NEW module ships into it,
//  - any module incidentally touched for a fix is brought up + added (the
//    boy-scout rule — see CLAUDE.md "Living docs: document on touch").
//
// See .myrobots/plans/living-docs-drift-2026-06-24.md.

export const STRICT_DOCS: ReadonlySet<string> = new Set<string>([
  // Pilot wave (2026-06-24): a spread across a synth utility, a modulator, a
  // dynamic-control sequencer, a video mixer, and a stereo effect.
  'adsr',
  'lfo',
  'sequencer',
  'fader',
  'cocoadelay',
  // Batch 1 — foundational modules (2026-06-25): the bread-and-butter audio
  // chain — oscillator, amplifier, mixer, noise source, filter — each now
  // carrying authored co-located docs. (lfo + cocoadelay, the batch's other two
  // members, were already promoted in the pilot above.)
  'analogVco',
  'vca',
  'mixer',
  'noise',
  'filter',
  // Batch 2 (2026-06-25): the synth voices — macro/wavetable/FM oscillators and
  // the MI modal/physical-modeling resonators.
  'macrooscillator',
  'cube',
  'wavecel',
  'dx7',
  'helm',
  'rings',
  'elements',
  'wavetableVco',
  'swolevco',
  // Batch 3 — CV utilities & modulation shapers (2026-06-26): the bread-and-
  // butter CV toolbox — attenuverters, polarizers, slew + switch, sample &
  // hold / quantizer, fixed-gain trim, and the two quad-VCA/mix utilities.
  'polarizer',
  'depolarizer',
  'scaler',
  'attenumix',
  'veils',
  'unityscalemathematik',
  'sampleHold',
  'slewSwitch',
  // Batch 4 — effects (2026-06-26): the wet-FX cluster — the basic reverb &
  // delay, the granular CLOUDS, the SHIMMERSHINE/AQUATANK reverb-resonators,
  // the destructive CHARLOTTE'S ECHOS multi-tap delay, the DESTROY bitcrusher,
  // the WARPS meta-modulator, and the RINGBACK stereo crush.
  'reverb',
  'delay',
  'clouds',
  'charlottesEchos',
  'shimmershine',
  'aquaTank',
  'destroy',
  'warps',
  'ringback',
]);
