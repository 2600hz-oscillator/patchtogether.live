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
// trig input) or a pitch to sound (dx7, macrooscillator).
//
// Adding a new module: usually no entry needed (default driver fits).
// When the per-module.spec.ts output-alive check fails for a new
// module, add an override here with the specific port(s) it needs
// driven — same as the SOURCES list pattern in
// e2e/tests/coverage-group-2-sources.spec.ts.
//
// SYSTEMIC GAP this map guards against: a gate/envelope-triggered AUDIO
// voice (drum hit, 303) with NO override gets the DEFAULT driver — its
// first audio/cv/gate/pitch output wired to a scope, NO upstream
// sequencer — so its gate never fires, it stays silent, and the alive
// smoke fails peak=0. This bit TREE.oh.VOX (#446) and the retired chowkick (#462).
//
// AUDIT (2026-05-30): replicated per-module.spec.ts's EXACT enrolment
// filter — a module gets a driven output-alive test iff `hasAudioOutput`
// && NOT on the spec's SKIP_OUTPUT_ALIVE list && it has NO `audio`-typed
// input (audio-input "effects" are auto-skipped) — against the emitted
// manifest (e2e/.generated/registry-manifest.json). Exactly 11 modules
// are enrolled+driven, and all 11 pass at --workers=4:
//   • 8 already have overrides below: buggles, drummergirl,
//     dx7, macrooscillator, meowbox, nibbles, treeohvox, wavesculpt.
//   • 1 self-runs on the DEFAULT driver (no override needed, correctly):
//       - noise → first output `white` (continuous white noise).
//
// NO module had the latent gap, so this audit added NO new entries
// (needless overrides are churn).
//
// NOT enrolled (correctly out of scope for the AUDIO-alive check):
//   • CV-only modules (`hasAudioOutput=false`): self-clocked CV/gate
//     sources (MACSEQ / MARBLES /
//     LFO) and CV math (analogLogicMaths — outputs min/max/diff/sum/
//     product, all `cv`). The spec never enrols them for the audio-alive
//     check; CV/gate alive checks are a deferred slice (per-module.spec
//     header).
//   • Audio-input processors (filter / reverb / RINGS / ELEMENTS / …) —
//     auto-skipped by the spec's hasAudioInput branch.
// The lesson is productized in the `module-pr-checklist` repo skill:
// every NEW gate/envelope-triggered AUDIO-output module MUST add an entry
// here or its output-alive smoke is silently peak=0.

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
  // SWOLEVCO primary out, no upstream needed.
  swolevco:     { outputPort: 'out',   params: { tune: 0, fine: 0, timbre: 0.3, symmetry: 0.5, fold: 0, ratio: 0 } },
  // MOOG 921B — slave VCO. With freq_bus unpatched the worklet defaults to
  // 0 V/oct → C4 and width_bus normals to 0.5 (square), so all four waveform
  // jacks ring at default fine=0 / range=0 / level=1 with NO upstream driver
  // (it can self-stand without a 921A). Pin the canonical out to `sine` (the
  // alive smoke + behavioral observed tap); the audio-typed dc_mod / ac_mod /
  // sync inputs are OPTIONAL modulation, so it's listed in the spec's
  // NOT_EFFECT_DESPITE_AUDIO_INPUT set (like moog921Vco) to take the normal
  // outputs-emit path.
  moog921b:     { outputPort: 'sine',  params: { fine: 0, range: 0, modAmount: 0, syncMode: 0, level: 1 } },
  // MOOG 921A — CV-only oscillator DRIVER (no audio ports). Its freq_bus /
  // width_bus outputs are STEADY DC at defaults (frequency=0 → 0 V; width=0.5),
  // which the AC-coupled SCOPE analyser can't read as a peak — so the per-port
  // driver in _per-port-drivers.ts wires a moving BUGGLES CV into freq_cv +
  // width_cv to make BOTH bus outputs AC. The canonical out is freq_bus.
  moog921a:     { outputPort: 'freq_bus' },
  // MOOG 904B — 24 dB/oct ladder HPF (effect: audio in → high-pass out). Needs
  // an upstream source; the per-port driver wires an ANALOGVCO saw into `audio`
  // with a low cutoff so the saw passes. Canonical out is `audio`.
  moog904b:     { outputPort: 'audio' },
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
  // ────────── Drum voices — gate-only triggered. ──────────
  drummergirl:  { outputPort: 'audio', gatePort: 'gate' },
  meowbox:      { outputPort: 'L',     gatePort: 'gate', pitchPort: 'pitch' },
  // KICK DRUM — layered stereo kick voice; trigger_in (edge:'trigger') strikes
  // it. Gate-only (accent/pitch/choke are optional CV). Silent with no strike,
  // so the sequencer gate train is required for the outputs-emit dim.
  kickdrum:     { outputPort: 'audio_l', gatePort: 'trigger_in' },
  // SNARE DRUM — deep stereo snare voice + two-hand drumroll; trigger_in
  // (edge:'trigger') strikes a single hit (gate_in runs the roll). Silent with
  // no strike, so the sequencer gate train into trigger_in is required for the
  // outputs-emit + behavioral dims. audio_l is the signature output.
  snaredrum:    { outputPort: 'audio_l', gatePort: 'trigger_in' },
  // TREE.oh.VOX — TB-303 voice. pitch/gate ride on dedicated audio-rate
  // node ports (pitch_in / gate_in), NOT AudioParams, so the sequencer
  // gate must be wired to gate_in for the amp envelope to open. Without
  // it the voice is silent (peak=0) even though the DSP is sound — the
  // ART baseline drives the voice offline via renderVoiceSequence(),
  // bypassing the live gate path, which is why it passed while this smoke
  // failed. Open the cutoff + lengthen decay so a gated note clears the
  // 0.005 peak floor inside the 800 ms drive window.
  treeohvox:    {
    outputPort: 'audio_out',
    gatePort: 'gate_in',
    pitchPort: 'pitch_in',
    params: { cutoff: 2500, resonance: 0.5, envelope: 0.7, decay: 800, accent: 0.5 },
  },
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
  // BLUEBOX — DTMF dialer. Each of its 12 keys is push-to-talk: silent
  // until a key is held, either via pointerdown on the card OR a gate
  // ≥0.5 into the matching `gate_<name>` input. The default driver wires
  // no upstream gate, so `out` stays at peak=0 and the alive smoke fails
  // (same gate-only class as treeohvox). Wire the sequencer
  // gate into `gate_1` so the '1' key (697 + 1209 Hz) holds and `out`
  // sounds inside the drive window.
  bluebox:      { outputPort: 'out', gatePort: 'gate_1' },
  // MOOG960 — Sequential Controller. Auto-runs on spawn (moog960.ts calls
  // startTransport() unconditionally), so the row CV outputs emit fine. But
  // clock_out is a narrow ~10ms pulse per column advance, and at the 2Hz
  // default `rate` that's one blip every 500ms — the AC-scope capture frames
  // in the per-port emit sweep fall between pulses intermittently (peak=0
  // flake; same narrow-gate class as buggles.clock). FIX, not skip: seed
  // rate=20 (the def max) so clock_out pulses every ~50ms (10× denser) and is
  // reliably caught. No START gate driver — the module already runs, and a
  // gate would just re-zero it every rising edge. outputPort stays row1 for
  // the whole-module shape check.
  moog960:      { outputPort: 'row1', params: { rate: 20 } },
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
