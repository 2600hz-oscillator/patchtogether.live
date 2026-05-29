// e2e/tests/_drivers.ts
//
// Per-module "minimum-viable driver" registry for the registry-driven
// per-module.spec.ts. Each entry describes what extra wiring the
// module needs to produce a measurable output:
//
//   * `outputPort` — the audio/cv/gate/video output we'll route to a
//     canonical receiver (scope.ch1 for audio/cv/gate, videoOut.in
//     for video / mono-video).
//   * `gatePort` / `pitchPort` — when set, a SEQUENCER is wired in
//     and its `gate` / `pitch` outputs land on these inputs so the
//     module under test actually fires.
//   * `params` — initial knob values to write into the spawned node
//     (e.g. unlocking a `playStop` toggle, opening a filter cutoff so
//     audio reaches the output).
//
// The default driver (returned by `driverFor` when no override is
// registered) picks the first declared output, doesn't wire any
// upstream, and uses the module's defaults. ~60 / 74 modules work
// with the default; the override list below is for the ~14 that
// don't — most need a gate to fire (drum voices, MACROOSCILLATOR's
// trig input) or a pitch to sound (dx7, helm, macrooscillator).
//
// Adding a new module: usually no entry needed (default driver fits).
// When the per-module.spec.ts output-alive check fails for a new
// module, add an override here with the specific port(s) it needs
// driven — same as the SOURCES list pattern in
// e2e/tests/coverage-group-2-sources.spec.ts.

import type { RegistryModule } from './_registry';

export interface ModuleDriver {
  /** Output port to wire into the canonical receiver. Defaults to the
   *  first output in the def when omitted. */
  outputPort?: string;
  /** Input port to receive the upstream sequencer's gate (rising edge
   *  triggers the module). When set, a SEQUENCER is spawned + its
   *  `gate` output wired to this port. */
  gatePort?: string;
  /** Input port to receive the upstream sequencer's pitch (V/oct).
   *  When set, the SEQUENCER's `pitch` output wires to this port. */
  pitchPort?: string;
  /** Knob values to seed when spawning. */
  params?: Record<string, number>;
}

const OVERRIDES: Record<string, ModuleDriver> = {
  // ────────── Audio VCOs ──────────
  // analogVco's sine output rings at C4 from 0V pitch (default tune=0,
  // fine=0). No upstream needed.
  analogVco:    { outputPort: 'sine', params: { tune: 0, fine: 0, pmAmount: 0, fmAmount: 0 } },
  // wavetableVco needs default wavePos to mid for an audible signal.
  wavetableVco: { outputPort: 'audio', params: { tune: 0, fine: 0, wavePos: 0.5, fmAmount: 0, pmAmount: 0 } },
  // WAVVIZ same shape as wavetableVco.
  wavviz:       { outputPort: 'audio', params: { tune: 0, fine: 0, wavePos: 0.5, fmAmount: 0, foldAmount: 0 } },
  // SWOLEVCO primary out, no upstream needed.
  swolevco:     { outputPort: 'out',   params: { tune: 0, fine: 0, timbre: 0.3, symmetry: 0.5, fold: 0, ratio: 0 } },
  // SAMSLOOP needs a sample loaded to sound — defer (covered by samsloop.spec.ts).
  // Stamp the spawn check only.
  samsloop:     { outputPort: 'out_l' },
  // MACROOSCILLATOR — needs trig to ping.
  macrooscillator: {
    outputPort: 'out',
    gatePort: 'trig',
    params: { model: 0, note: 0, harmonics: 0.3, timbre: 0.3, morph: 0.5, level: 0.8 },
  },
  // DX7 — needs gate + pitch to play a voice.
  dx7: {
    outputPort: 'out',
    gatePort: 'gate',
    pitchPort: 'pitch_cv',
    params: { algorithm: 5, voiceCount: 1, level: 0.7, transpose: 0 },
  },
  // HYDROGEN's per-instrument trigs need driving; default driver covers spawn.
  // Output-alive is asserted via the dedicated hydrogen.spec.ts.
  hydrogen:     { outputPort: 'out_l' },
  // HELM is MIDI-driven primarily; pitch_cv + gate are fallbacks.
  // Output-alive is covered by helm.spec.ts; per-module stamper does spawn only.
  helm:         { outputPort: 'out_l' },
  // ────────── Drum voices — gate-only triggered. ──────────
  drummergirl:  { outputPort: 'audio', gatePort: 'gate' },
  meowbox:      { outputPort: 'L',     gatePort: 'gate', pitchPort: 'pitch' },
  // RIOTGIRLS drives the 4-voice DRUMMERGIRL + WT-VCO bank; trig1 fires voice 1.
  riotgirls:    { outputPort: 'outL',  gatePort: 'trig1' },
  // ────────── Modulators that need a clock ──────────
  // BUGGLES self-runs (internal RNG). LFO self-runs at default rate.
  // BUGGLES outputs cv on 'smooth'.
  buggles:      { outputPort: 'smooth' },
  // ────────── Wavetable / cluster modules ──────────
  wavesculpt:   { outputPort: 'L', gatePort: 'gate1' },
  // NIBBLES first output is `pellet` (gate, fires only when the snake
  // eats food — gameplay-conditional, NOT alive on idle). Pin to `snake`,
  // the continuous square-wave audio output that's emitting at the
  // length-derived frequency from cold start (snake length 4 → 110 Hz).
  nibbles:      { outputPort: 'snake' },
};

/** Resolve the canonical driver for a module. Returns the override if
 *  registered, otherwise picks the first declared output as the test
 *  target and supplies no upstream driver. */
export function driverFor(mod: RegistryModule): ModuleDriver {
  const o = OVERRIDES[mod.type];
  if (o) return o;
  // Default: first audio/cv/gate output; fall back to first declared
  // output if the module emits something other than the common types
  // (mono-video / video — handled separately because they need
  // videoOut, not scope).
  const firstNonVideo = mod.outputs.find(
    (p) => p.type === 'audio' || p.type === 'cv' || p.type === 'gate' || p.type === 'pitch',
  );
  const firstAny = mod.outputs[0];
  return { outputPort: firstNonVideo?.id ?? firstAny?.id };
}
