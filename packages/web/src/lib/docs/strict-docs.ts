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
  // Batch 5 — Moog System 35/55 signal-processing cluster (2026-06-26): the
  // classic Moog filtering & processing chain — the 902 VCA, the 904A low-pass
  // and 904B high-pass transistor-ladder filters, the 904C filter coupler
  // (VC band-pass / notch), the 905 spring reverb, the 907A and 914 fixed
  // filter banks (graphic-EQ-style spectral shapers), and the 923 noise +
  // filter utility. Every one of these is a `card:`-override module (its card
  // name doesn't match the conventional `<type>Card`), so — like cocoadelay —
  // they stay OFF the INTERACTIVE_DOC_MODULES allowlist (the doc route's
  // defLite can't resolve an override card → static face fallback). Documented
  // (STRICT) without being live-card-interactive.
  'moog902',
  'moog904a',
  'moog904b',
  'moog904c',
  'moog905',
  'moog907a',
  'moog914',
  'moog923',
  // Batch 6 — Moog System 55/35 sources & utility cluster (2026-06-26): the
  // IIIc oscillator front-end + the passive console panels — the 921 VCO (the
  // standalone oscillator), the 921A driver + 921B slave (the master/slave
  // oscillator pair), the 903A random-signal/noise source, the 956 ribbon
  // controller (a manual pitch+gate source), the 961 interface (trigger/gate
  // format converter), the 962 sequential switch (gate-advanced selector), and
  // the passive 994 dual multiples + 995 attenuators. The override-card members
  // (903a / 956 / 961 / 962 / 994 / cp3) stay OFF INTERACTIVE_DOC_MODULES (the
  // doc route's defLite can't resolve a `card:` override → static face); the
  // convention-card members (921a / 921b / 921Vco / 995) ARE interactive.
  'moog921Vco',
  'moog921a',
  'moog921b',
  'moog903a',
  'moog956',
  'moog961',
  'moog962',
  'moog994',
  'moog995',
  // Batch 7 — Moog System 35/55 modulation & routing (2026-06-26): the cluster
  // that completes the Moog System rollout — the 911 contour generator (EG), the
  // 911A dual trigger delay, the 912 envelope follower, the 960 sequential
  // controller (3×8 analog step sequencer), the 984 4×4 matrix mixer, the 992 CV
  // panel (4→1 summer with an inverting channel), the 993 trigger & envelope
  // panel, and the CP3 console mixer. The convention-card members (moog911 /
  // moog984 — pure Knob + PatchPanel via MoogPanel) ARE interactive; the
  // override-card members (911a / 912 / 960 / 992 / 993 / cp3) stay STATIC (the
  // doc route's defLite can't resolve a `card:` override → static face fallback).
  'moog911',
  'moog911a',
  'moog912',
  'moog960',
  'moog984',
  'moog992',
  'moog993',
  'moogCp3',
]);
