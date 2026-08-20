// packages/web/src/lib/audio/modules/buggles.ts
//
// BUGGLES — chaotic random voltage source. Functional clean-room
// implementation of the Buchla / Make Noise wogglebug archetype:
// an internal "woggle clock" emits triggers at a knob-set rate (with
// optional jitter), and the resulting random voltages spray out across
// five correlated outputs:
//
//   smooth — slowly-shifting random voltage (slewed stepped). Like a
//            slow random LFO; good for warbling pitch / filter modulation.
//   stepped — sample-and-held random voltage that updates on each woggle
//            clock pulse. Brittle, jumpy modulation.
//   clock  — gate output, 5ms pulses on each woggle event. Use as a
//            chaotic clock for sequencers / drum triggers.
//   burst  — clusters of 3-7 closely-spaced triggers fired at probability
//            burst_probability per woggle event.
//   ring   — the smooth voltage ring-modulated against a sine
//            sub-oscillator at rate/4. ⚠ SUB-AUDIO AT EVERY KNOB
//            POSITION — see BUGGLES_RING_* below. It is declared
//            `audio` so it patches into the audio path, and it is a
//            SLOW product there, not a tone.
//
// Inputs:
//   clock_cv      — CV → woggle rate. Sums onto the rate knob value.
//   chaos_cv      — CV → chaos amount. Sums onto the chaos knob value.
//   external_clock — gate input. When patched, replaces the internal
//                   woggle clock (rising edges advance state instead).
//
// CV inputs aren't routed to AudioParams (the rate/chaos values aren't
// AudioParams — they're plain JS shadows read by the setTimeout-driven
// woggle scheduler). Instead, each CV input lands on an AnalyserNode
// tap; on every woggle event we read the latest sample and add it to
// the shadowed knob value.
//
// Knobs:
//   rate              — log-mapped 0.1..50 Hz internal clock rate.
//   chaos             — 0..1 chaos depth. At 0 the stepped output is a
//                       clean S&H of a stable random walk; at 1, each
//                       step is a fresh independent uniform value.
//   smoothness        — 0..1 slew rate on smooth output (higher = slower).
//   burst_probability — 0..1 chance of a burst on each woggle event.
//   level             — 0..1 output scaling for SMOOTH, STEPPED and RING.
//                       ⚠ NOT all five: the CLOCK and BURST gates bypass it
//                       by design, so a gate consumer always sees a clean
//                       0/1 swing. (The header said "ALL five outputs" and
//                       the factory never did — corrected 2026-08-15.)
//
// Implementation: pure-JS ScriptProcessorNode-style via AudioWorklet
// would be the "right" thing to do for sample-accurate behavior, but
// the spec asks for "rich" wogglebug behavior, not sample-accurate
// timing. We implement the woggle clock as a setInterval-driven
// orchestrator that schedules ConstantSource ramps + gate pulses on the
// audio thread. This keeps the DSP simple, sounds correct, and avoids
// shipping a new worklet for what is fundamentally a low-frequency
// random-event generator.
//
// All five outputs are driven from a small set of internal state:
//   * `currentStepped`   — the current S&H value (-1..+1)
//   * `targetStepped`    — the next S&H value (used so we can ramp the
//                          smooth output toward it)
//   * `wogglePeriodS`    — current period in seconds (rate + chaos jitter)
//
// On each woggle event:
//   1. Pick a new `targetStepped` (random in [-1..+1], or correlated
//      walk when chaos is low).
//   2. Step the stepped ConstantSource to targetStepped (no ramp).
//   3. Schedule a linearRampToValueAtTime on the smooth ConstantSource
//      from its current value to targetStepped, over a duration that
//      depends on `smoothness`.
//   4. Pulse the clock gate (fire setValueAtTime(1) → setValueAtTime(0)
//      after 5ms).
//   5. Roll burst_probability; on hit, schedule 3-7 closely-spaced
//      gate pulses on the burst output.
//   6. Pick the next woggle period: base 1/rate + jitter scaled by
//      chaos. Schedule the next woggle via setTimeout.
//
// External clock: when `external_clock` is patched and a rising edge
// arrives (above 0.5), we fire the same woggle-event handler. The
// internal setTimeout is suppressed while external clock is active.

import { createEdgeCounter } from '$lib/audio/edge-detect';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';

/** Pure helpers exposed for unit tests. The actual woggle event
 *  generation runs in the factory (where we have an AudioContext). */
export const bugglesMath = {
  /** Map a 0..1 knob value to 0.1..50 Hz log scale.
   *  rate=0   → 0.1 Hz
   *  rate=0.5 → ~2.24 Hz (log midpoint)
   *  rate=1   → 50 Hz */
  rateKnobToHz(knob: number): number {
    const minHz = 0.1;
    const maxHz = 50;
    const k = Math.max(0, Math.min(1, knob));
    return minHz * Math.pow(maxHz / minHz, k);
  },

  /** Compute the next stepped value, given the previous stepped and a
   *  chaos amount in [0, 1]. At chaos=0 the next value is a small
   *  perturbation of the previous (correlated walk); at chaos=1 it's
   *  a fresh uniform pull. */
  nextStepped(previous: number, chaos: number, rand: () => number): number {
    const fresh = rand() * 2 - 1; // uniform in [-1, +1]
    const c = Math.max(0, Math.min(1, chaos));
    // Linear interpolation between a small perturbation and a fresh value.
    // walk = previous + 0.2 * fresh, clamped — keeps the trajectory bounded.
    const walk = clamp(previous + 0.2 * fresh, -1, 1);
    return walk * (1 - c) + fresh * c;
  },

  /** Compute the next woggle period in seconds. Base = 1/rate; jitter
   *  ranges from 0% (chaos=0) up to ±50% of the base period (chaos=1). */
  nextPeriodS(rateHz: number, chaos: number, rand: () => number): number {
    const base = 1 / Math.max(rateHz, 1e-6);
    const c = Math.max(0, Math.min(1, chaos));
    const jitter = (rand() * 2 - 1) * 0.5 * c; // ±50% × chaos
    return base * (1 + jitter);
  },

  /** Roll burst probability. Returns the burst length
   *  (BUGGLES_BURST_MIN_PULSES..BUGGLES_BURST_MAX_PULSES) on hit, 0 otherwise. */
  rollBurst(probability: number, rand: () => number): number {
    const p = Math.max(0, Math.min(1, probability));
    if (rand() >= p) return 0;
    return (
      BUGGLES_BURST_MIN_PULSES +
      Math.floor(rand() * (BUGGLES_BURST_MAX_PULSES - BUGGLES_BURST_MIN_PULSES + 1))
    );
  },
};

/** The rolled cluster length is uniform on [MIN, MAX]. Exported because the
 *  faceplate's BURST readout has to know the distribution to print a rate, and
 *  a second copy of "3..7" in the face model is how the two drift. */
export const BUGGLES_BURST_MIN_PULSES = 3;
export const BUGGLES_BURST_MAX_PULSES = 7;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Tiny seeded PRNG so tests can control randomness without monkey-
 *  patching Math.random. Same algorithm as noise.ts for consistency. */
export function bugglesPrng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Delay before the FIRST woggle fires after the node is built, in ms. Kept
 *  short so a player sees movement immediately at the lowest rates — and
 *  exported because it is the margin an offline render has to finish inside
 *  before the scheduler starts writing into the buffer (see the ART's
 *  `real-factory-silence` legs). */
export const BUGGLES_FIRST_WOGGLE_MS = 50;
/** Gate width of the CLOCK pulse, in ms. */
export const BUGGLES_CLOCK_PULSE_MS = 5;
/** Spacing between BURST pulses, in ms. */
export const BUGGLES_BURST_GAP_MS = 18;
/** Width of each BURST pulse, in ms. */
export const BUGGLES_BURST_PULSE_MS = 4;

const CLOCK_PULSE_MS = BUGGLES_CLOCK_PULSE_MS;
const BURST_GAP_MS = BUGGLES_BURST_GAP_MS;
const BURST_PULSE_MS = BUGGLES_BURST_PULSE_MS;

// ── BURST TRUNCATION: the cluster is CUT by the next woggle event ────────────
//
// ⚠ NOT A DEFECT, BUT IT IS THE READOUT. `fireWoggleEvent` calls
// `burstSrc.offset.cancelScheduledValues(now)` on EVERY event, so a cluster
// still in flight is cut off by the next tick. A rolled cluster of L occupies
// (L-1) x BURST_GAP_MS + BURST_PULSE_MS ms, and the woggle period is 1/rateHz —
// so above roughly RATE 0.78 the jack stops delivering what was rolled.
// Measured over the travel (delivered pulses of a rolled L):
//
//   rate 0.4 (1.20 Hz,  832.6 ms):  L=3 -> 3   L=5 -> 5   L=7 -> 7
//   rate 0.6 (4.16 Hz,  240.2 ms):  L=3 -> 3   L=5 -> 5   L=7 -> 7
//   rate 0.8 (14.4 Hz,   69.3 ms):  L=3 -> 3   L=5 -> 4   L=7 -> 4
//   rate 0.9 (26.9 Hz,   37.2 ms):  L=3 -> 2   L=5 -> 2   L=7 -> 2
//   rate 1.0 (50.0 Hz,   20.0 ms):  L=3 -> 1   L=5 -> 1   L=7 -> 1
//
// At the top of RATE, "a cluster of 3-7" delivers exactly ONE pulse and BURST
// is a copy of CLOCK. E[delivered] falls 5.00 -> 3.80 -> 2.00 -> 1.00, so the
// naive `p x rate x 5` a reader would write is 5x wrong there — which is
// precisely why the BURST readout is derived. `buggles-face-model.ts` owns the
// arithmetic and `buggles-face-model.test.ts` negative-controls it on RATE.

// ── The EXTERNAL-CLOCK poller, and the relation the two numbers must satisfy ──
//
// ⚠ THESE TWO ARE ONE FACT, NOT TWO SETTINGS. `external_clock` is detected on
// the MAIN THREAD: a `setInterval` wakes every BUGGLES_EXT_POLL_MS and reads the
// tap's AnalyserNode ring. A poll can only see the samples that are IN the ring,
// so the ring must be at least as long as the gap between polls — otherwise the
// detector inspects a window and then SLEEPS THROUGH the rest of the timeline,
// and every rising edge that lands in the gap is gone.
//
// MEASURED, and it is why this pair is now derived rather than typed apart. The
// shipped values were `fftSize = 32` (0.667 ms @ 48 kHz) against a 33 ms poll —
// a 2.0 % duty cycle on the detector. Modelling the shipped algorithm sample by
// sample over a 5 ms gate train gave a capture ratio of 16.7 % (1 edge in 6),
// FLAT across 1 / 2 / 4 / 8 / 16 Hz clocks, because the answer is geometric:
// (pulseWidth + bufferWidth) / pollInterval = (5 + 0.667) / 33. Five of every
// six external clock pulses were silently dropped at every tempo.
//
// The fix is NOT "a bigger fftSize" — a whole-buffer rescan of a 2048-sample
// ring against a 33 ms tick OVER-counts instead (measured 143.8-150.0 %: the
// ~9.7 ms overlap re-presents an edge on two consecutive polls, the
// NUMPAD+/ATLANTIS-CATALYST bug class). It is `$lib/audio/edge-detect`
// `createEdgeCounter`, which scans only the `ceil(elapsed × sampleRate)` samples
// that ARRIVED since the previous poll: measured 100.0 % at every rate above.
// CLAUDE.md requires that seam for exactly this reason; this module predates it.
//
// ⚠ THE CEILING THIS LEAVES, stated rather than discovered later: one poll fires
// at most one woggle event, so external clocks faster than 1 / POLL_MS ≈ 30 Hz
// COALESCE. That is a property of a main-thread poller, not of the detector, and
// every clock source in this rack is far below it (a sequencer at 240 bpm is
// 4 Hz). `buggles.test.ts` pins both the relation and the ceiling.
export const BUGGLES_EXT_POLL_MS = 33;
/** ≥ `BUGGLES_EXT_POLL_MS × sampleRate` at 48 kHz (1584 samples) — asserted,
 *  not assumed, in `buggles.test.ts`. 2048 is the repo's analyser convention. */
export const BUGGLES_EXT_FFT_SIZE = 2048;
/** The sample rate the poll/ring relation is asserted at. Not a DSP constant —
 *  the relation must hold at the rate the browser actually runs. */
export const BUGGLES_EXT_ASSERT_SAMPLE_RATE = 48000;

// ── The RING carrier, and the claim it does NOT support ──────────────────────
//
// ⚠ RING IS SUB-AUDIO AT EVERY KNOB POSITION, AND THE DOCS USED TO SAY THE
// OPPOSITE. `subOsc.frequency = rateKnobToHz(rate) / BUGGLES_RING_DIVISOR`, and
// `rateKnobToHz` tops out at 50 Hz, so the carrier's CEILING is 12.5 Hz — below
// the ~20 Hz floor of hearing. Read off the REAL OscillatorNode this factory
// constructs (an intercepted `ctx.createOscillator` in an OfflineAudioContext),
// across the whole travel:
//
//   rate 0     → woggle  0.1000 Hz → carrier  0.02500 Hz
//   rate 0.25  → woggle  0.4729 Hz → carrier  0.11822 Hz
//   rate 0.4 ▲ → woggle  1.2011 Hz → carrier  0.30028 Hz   (the shipped default)
//   rate 0.5   → woggle  2.2361 Hz → carrier  0.55902 Hz
//   rate 0.75  → woggle 10.5737 Hz → carrier  2.64343 Hz
//   rate 1     → woggle 50.0000 Hz → carrier 12.50000 Hz   (the ceiling)
//
// Four places said "audio-rate … patchable straight into the audio path" and one
// said "fast enough to be audible-rate"; all five were the #1701 class — a false
// VALUE, not a false structure, so `contract-lock` (which pins `ring` as
// `type: 'audio'`, correctly) and `module-docs-lint` (which checks the doc
// EXISTS) were both blind. So was the one ART leg named for RING: it builds a
// **200 Hz** oscillator to mirror the construction, 667× above the real one, and
// is therefore invariant to the exact dimension that was wrong.
//
// The DSP is UNCHANGED — a saved rack with a RING cable must keep sounding as it
// does. What changed is the claim. `buggles.test.ts` asserts the ceiling against
// BUGGLES_AUDIBILITY_FLOOR_HZ over the whole travel, so making RING audible now
// requires editing the prose in the same diff.
export const BUGGLES_RING_DIVISOR = 4;
/** The bottom of human hearing, in Hz. A POLICY threshold on a measured
 *  quantity (not a population count): the line the RING carrier is asserted to
 *  stay below at every knob position. */
export const BUGGLES_AUDIBILITY_FLOOR_HZ = 20;

/**
 * ONE ROW PER JACK on the faceplate's output table: the port id, and the
 * DERIVED number that row prints.
 *
 * ⚠ USED ONLY TO GENERATE `face.sidebar`, never `outputs`. The `outputs` roster
 * stays a LITERAL on purpose — the module-manifest docs parser reads the def's
 * SOURCE and a `.map()` there leaves it with an empty match (the ninelives
 * finding). So this is a second declaration of the port ids, and it is ANCHORED
 * rather than trusted: `buggles-face-model.test.ts` asserts it EQUALS the
 * declared `outputs` roster in BOTH directions and in order, so a row can never
 * name a port that does not exist and a jack can never go missing a row.
 */
export const BUGGLES_OUTPUT_READOUTS: readonly {
  readonly port: string;
  readonly valueId: string;
}[] = [
  { port: 'smooth', valueId: 'buggles-smooth-glide' },
  { port: 'stepped', valueId: 'buggles-stepped-hold' },
  { port: 'clock', valueId: 'buggles-woggle-hz' },
  { port: 'burst', valueId: 'buggles-burst-rate' },
  { port: 'ring', valueId: 'buggles-ring-hz' },
];

export const bugglesDef: AudioModuleDef = {
  type: 'buggles',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'buggles',
  category: 'modulation',

  inputs: [
    // No paramTarget — these are sampled into the JS shadow each woggle
    // event rather than routed onto an AudioParam. Engine still treats
    // them as cv inputs (cable colour, type-check), just connects them
    // node→node into the analyser tap.
    { id: 'clock_cv',       type: 'cv' },
    { id: 'chaos_cv',       type: 'cv' },
    { id: 'external_clock', type: 'gate', edge: 'trigger' },
  ],
  outputs: [
    { id: 'smooth', type: 'cv' },
    { id: 'stepped', type: 'cv' },
    { id: 'clock',  type: 'gate', edge: 'trigger' },
    { id: 'burst',  type: 'gate', edge: 'trigger' },
    { id: 'ring',   type: 'audio' },
  ],
  params: [
    // rate is exposed in normalised 0..1 knob units; the factory log-maps
    // it to Hz internally. This keeps the AudioParam sum (knob + CV)
    // mathematically meaningful (CV in cv range adds to knob range).
    { id: 'rate',              label: 'Rate',   defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    { id: 'chaos',             label: 'Chaos',  defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
    { id: 'smoothness',        label: 'Smooth', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'burst_probability', label: 'Burst',  defaultValue: 0.2, min: 0, max: 1, curve: 'linear' },
    { id: 'level',             label: 'Level',  defaultValue: 0.7, min: 0, max: 1, curve: 'linear' },
  ],

  // ── THE FACEPLATE (PF-20, queue Q13) ────────────────────────────────────────
  //
  // WHAT THIS MODULE IS FOR. BUGGLES is the rack's CHAOS DISTRIBUTOR. Every
  // other random source here hands you one stream and leaves you to split it:
  // `noise` is a spectrum, `sample-and-hold` is one S&H, `marbles` is a
  // QUANTISED random SEQUENCER you steer with a bias and can loop. This one
  // rolls ONE random decision per woggle tick and sprays FIVE CORRELATED VIEWS
  // of that same decision at once — the slewed voltage, the hard-stepped
  // voltage, the tick itself as a gate, an occasional probabilistic ratchet of
  // that tick, and the slewed voltage ring-modulated. The verb is *set the tick
  // and let it spray*: you patch RATE and CHAOS, take four or five cables out of
  // one module, and the whole patch drifts TOGETHER because it all came from the
  // same roll. It is not a random SEQUENCE (that is marbles); it is a random
  // FIELD.
  face: {
    // THE RANKING, and it would be wrong for a different module. Ranks 1-6 are
    // the whole lane budget (`faceTierCap`) and this module has five params, so
    // the plate and the dock both show everything — the ranking's authority is
    // MINI (1) and COMPACT (3, because this face declares no glyph).
    //
    //   1 RATE — the identity, and the only control that reaches ALL FIVE
    //     JACKS. Measured, per jack, across its travel: SMOOTH's glide 2895 ->
    //     79 ms (36.5x, at a FIXED smoothness), STEPPED's hold 1/rate, CLOCK's
    //     period 10 s -> 20 ms, BURST's delivered cluster 5.00 -> 1.00 pulses,
    //     RING's carrier 0.025 -> 12.5 Hz. Nothing else on the module touches
    //     more than two.
    //   2 CHAOS — the second identity, and the thing that makes this a
    //     WOGGLEbug rather than a slow LFO: it is the only control that changes
    //     the CHARACTER of the randomness instead of its speed. At 0 the
    //     stepped output is a bounded +/-0.2 walk on a metronomic period; at 1
    //     every step is a fresh independent uniform and the period jitters
    //     +/-50%. Measured >= 4x the per-step variance (the ART divergence leg).
    //     Ranked below RATE because it is MODAL: at RATE 0 nothing happens
    //     whatever CHAOS says, while at CHAOS 0 the module still runs.
    //   3 SMOOTHNESS — reaches two jacks (SMOOTH, and RING through it) and is
    //     UNCONDITIONALLY applicable, which is what puts it above BURST. It is
    //     also the shape control on the module's most-patched output: SMOOTH is
    //     what the per-port driver registry wires by default
    //     (`_drivers.ts` `buggles: { outputPort: 'smooth' }`) and what both
    //     CV-source drivers take. Travel: 10 ms -> 1675 ms at the shipped rate.
    //   4 BURST PROBABILITY — the third idea (probabilistic ratcheting), but
    //     ENABLER-GATED in two ways at once, which is why it is not rank 3: it
    //     changes exactly ONE jack, and that jack is silent until a cable lands
    //     in it. It is also the only STOCHASTIC control — at the shipped 0.2,
    //     four woggle events in five produce nothing at all on BURST.
    //   5 LEVEL — the output trim. It is unconditionally applicable, which is
    //     usually an argument for ranking a trim HIGHER (the wavetableVco FINE
    //     case), and it is beaten here by a measured fact specific to this
    //     module: LEVEL scales SMOOTH, STEPPED and RING and DOES NOT REACH
    //     CLOCK OR BURST — the two gate jacks bypass it by design so a gate
    //     consumer sees a clean 0/1 swing. So on the patch this module exists
    //     for (BUGGLES as a chaotic clock) LEVEL is bit-exactly inert, and it
    //     is the one control that changes no timing and no character on the
    //     patches where it does anything. Last is the honest rank.
    //
    // Read back as a sentence: MINI gives you the TICK; COMPACT adds how random
    // it is and how lazily SMOOTH follows it; the plate and the dock give you
    // all five, plus the hero row and the per-jack table.
    order: ['rate', 'chaos', 'smoothness', 'burst_probability', 'level'],

    // TWO BANDS, split by what the control DECIDES rather than by knob type:
    // `the roll` is the event (when it happens, how random it is) and
    // `the jacks` is what leaves the holes once it has happened. That is the
    // module's own structure — `fireWoggleEvent` picks a value and a period
    // from RATE + CHAOS, then SMOOTHNESS / BURST / LEVEL decide only how that
    // one decision is presented at each output.
    //
    // ⚠ `order` AND `pages` AGREE HERE, and that is stated rather than dressed
    // up as a designed tension: priority and signal order genuinely coincide on
    // a module whose signal order IS "the clock, then the outputs". The
    // promotion also moves the Push 2 card GENERIC -> FACE with the encoders in
    // the same positions, and `push-card-schema.test.ts` records that, because
    // "the card did not move" and "nobody looked" must not be one green.
    pages: [
      { id: 'roll', label: 'the roll', controls: ['rate', 'chaos'] },
      { id: 'jacks', label: 'the jacks', controls: ['smoothness', 'burst_probability', 'level'] },
    ],

    // ⚠ NO GLYPH, AND THAT IS A MEASUREMENT RATHER THAN AN OMISSION — the
    // ninelives hazard, answered for a module that has the opposite port shape.
    //
    // `glyphBinding` resolves the tap from the def alone, and for ANY glyph
    // other than 'none' (or 'envelope'/'algorithm', which this module has no
    // params for) the `if (audioOut) return live-audio` short-circuit fires
    // first. `primaryAudioOutPortId` is "the FIRST declared `audio` output", and
    // exactly one of these five jacks is typed `audio`: RING. So a glyph here
    // would paint RING and call it BUGGLES — one of five outputs, and the one
    // the player is least likely to be using.
    //
    // And it could not even paint that. The shell's tap is
    // GLYPH_TAP_FFT_SIZE = 2048 samples ~ 42.7 ms; RING's carrier at the shipped
    // RATE is 0.30028 Hz, a period of 3.330 s. The window is 1.3% of ONE CYCLE.
    // Even at the top of the dial (12.5 Hz, 80 ms) it is 53% of a cycle — so the
    // BEST CASE across the entire travel is half a period of a sine whose
    // amplitude is an unrelated random voltage. The picture is a line that
    // creeps, at every knob position, and it would resolve LIVE — so no gate
    // would flag a static fallback and nothing would look wrong.
    //
    // Both halves are permanent legs of `buggles-face-model.test.ts`, including
    // the negative control that a 'scope' glyph on THIS def WOULD resolve
    // `{ kind: 'live-audio', portId: 'ring' }`, so the 'none' is a decision.
    // It also buys a cell: `faceTierCap` gives compact 2 WITH a glyph and 3
    // without, so declining the picture is what puts SMOOTHNESS on the tile.
    glyph: 'none',

    // THE HERO. RATE is promoted out of `the roll`, not copied — `heroFacePlan`
    // REMOVES it and the band survives on CHAOS, so the multiset faces-parity
    // asserts is unchanged and `pages` stays 2 for the VRT roster.
    //
    // ⚠ ALL THREE READOUTS ARE DERIVED, and each is blind in a DIFFERENT
    // direction from the dial nearest it:
    //   woggle  RATE is a normalised 0..1 dial over a LOG map spanning 500x.
    //           It reads `0.40`; the clock is 1.20 Hz. No control on this
    //           module prints a frequency at all.
    //   glide   THE KICK-DRUM TAIL SHAPE. The nearest knob is SMOOTH and it
    //           does move when you turn SMOOTH — and it is BLIND TO RATE, which
    //           changes the answer 36.5x (2895 ms at RATE 0.2, 79 ms at RATE
    //           0.8, with the SMOOTH dial bit-identical at both).
    //   burst   RATE, BURST and a TRUNCATION term no naive formula has: the
    //           cluster is cut by the next woggle event, so the obvious
    //           `p x rate x 5` says 250/s at RATE 1 where the real answer is
    //           50/s. See the BURST TRUNCATION block above.
    //
    // ⚠ `glide` reads 843 ms at spawn and the sidebar's `stepped` row reads
    // 833 ms beside it, which looks like one number printed twice. It is not:
    // `slewS = 0.01 + smoothness * 2 * period`, so SMOOTH 0.5 is EXACTLY the
    // setting where the glide is ONE WOGGLE PERIOD plus the 10 ms floor —
    // SMOOTH is perpetually chasing, arriving 10 ms after the next value has
    // already been rolled. Asserted at every rate in the face-model test, with
    // the control that the identity breaks anywhere else on the SMOOTH dial,
    // so the coincidence is a documented property rather than something a
    // future reader "fixes".
    hero: {
      control: 'rate',
    },


    // No `title`, no `hint`, no band hints — owner ruling 2026-08-11
    // (marbles / resofilter): plain labels and values on the face; the
    // explanation lives in `docs`, one right-click away.

    // REAR CARD. Re-derived on paper, and the DERIVED answer SPLITS THE TWO CV
    // SIBLINGS: `chaos_cv`'s stem is `chaos`, which IS a param, so it lands in
    // the `roll` page band — while `clock_cv`'s stem is `clock`, which is an
    // OUTPUT id and not a param, so it is an orphan and falls to the leading
    // band with `external_clock`. Two jacks that are the same kind of thing, on
    // two different bands, for a reason that is an artefact of naming.
    //
    // The curated group puts all three back together and names them for what
    // they actually ARE, which is the one fact a patcher needs here: NONE of
    // them is a `paramTarget`. There is no AudioParam behind any of these
    // holes — the woggle scheduler SAMPLES each one (the two CVs once per
    // woggle event, the clock once per 33 ms poll) and adds it to a plain JS
    // shadow. That is why `cv-scale-registry` exempts `clock_cv`/`chaos_cv`,
    // and it is the difference between "this CV displaces a knob smoothly" and
    // "this CV is read at the instant the dice are rolled".
    //
    // `signal` claims the LEADING slot and does not collide with either page id
    // (`roll` / `jacks`). No `audioRate` list: nothing here is read per sample.
    rear: {
      groups: [
        { id: 'signal', label: 'sampled, not routed', ports: ['clock_cv', 'chaos_cv', 'external_clock'] },
      ],
    },
  },

  docs: {
    explanation:
      "A chaotic random-voltage source in the Buchla / Make Noise wogglebug tradition. One roll of the dice, five correlated views of it. An internal 'woggle clock' fires at the Rate you set (with Chaos adding timing jitter), and each tick rolls a fresh random voltage that sprays out across five outputs at once: a slowly-slewing SMOOTH voltage, a jumpy sample-and-held STEPPED voltage, a CLOCK gate pulsing on every woggle event, an occasional BURST of clustered triggers, and a RING output that ring-modulates the smooth voltage against a sub-oscillator. Patch SMOOTH into pitch or filter CV for warbling drift, STEPPED for brittle melodic randomness, CLOCK to clock a sequencer, and BURST for stuttered fills — and because all five come from the same roll, everything you patch drifts together. RING is the odd one out: it is typed as audio so it reaches the audio path, but its carrier is a quarter of the woggle rate and therefore SUB-AUDIO at every knob position (0.025 Hz at the bottom of Rate, 12.5 Hz at the top), so it is a slow shuddering product to modulate with, not a tone to listen to. You can also feed it an external clock to lock the chaos to your tempo.",
    inputs: {
      clock_cv: "CV that sums onto the Rate knob, speeding up or slowing the internal woggle clock (sampled at each woggle event rather than continuously).",
      chaos_cv: "CV that sums onto the Chaos knob, modulating how random/jittery the voltages and timing get.",
      external_clock: "External clock input: when patched, its rising edges replace the internal woggle clock — each pulse fires one woggle event (new random voltages + a CLOCK/BURST output), so the chaos locks to your tempo. The internal clock resumes about a second after the pulses stop.",
    },
    outputs: {
      smooth: "A slowly-shifting random voltage: it slews toward each new random target instead of jumping, so it behaves like a lazy random LFO — good for warbling pitch, filter, or pan modulation. The Smooth control sets how lazily it glides.",
      stepped: "A sample-and-held random voltage that hard-jumps to a fresh value on every woggle event — brittle, steppy modulation for random melodies or jumpy timbres.",
      clock: "A gate output that pulses (~5 ms) on every woggle event — a chaotic clock you can use to trigger sequencers, envelopes, or drums; its rate and jitter follow Rate + Chaos.",
      burst: "A gate output that, with probability set by the Burst control, fires a cluster of 3–7 closely-spaced trigger pulses on a woggle event — for ratchets, stutters, and fills.",
      ring: "The SMOOTH voltage ring-modulated against a sine sub-oscillator running at a quarter of the woggle rate. It is typed as audio so it patches into the audio path, but the carrier is SUB-AUDIO everywhere on the dial — 0.025 Hz at the bottom of Rate, 0.30 Hz where the module spawns, 12.5 Hz flat out — so what comes out is a slow shuddering product, not a tone. Use it as a modulation source with more life than SMOOTH alone, or as the input to something that can hear it; do not expect a Buchla 'complex random' timbre straight into the speakers.",
    },
    controls: {
      rate: "Internal woggle-clock speed (0..1, log-mapped to roughly 0.1–50 Hz): how often new random voltages are rolled. The Clock CV input adds to this.",
      chaos: "Chaos depth (0..1): at 0 the stepped output is a clean S&H of a stable random walk and timing is steady; turning it up makes each step a fresh independent value and adds up to ±50% jitter to the woggle period.",
      smoothness: "How lazily the SMOOTH output glides toward each new target (0..1): low is almost a step, high stretches the slew to about twice the woggle period for very gentle drift.",
      burst_probability: "Chance (0..1) that a given woggle event fires a BURST cluster instead of a single pulse — 0 never bursts, 1 bursts every event.",
      level: "Output scaling (0..1) applied to the SMOOTH, STEPPED, and RING outputs (the CLOCK and BURST gates keep a clean 0/1 swing regardless).",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Per-instance PRNG seeded from the node id so two BUGGLES on the
    // same canvas produce different sequences (and a single BUGGLES is
    // reproducible across reloads when the patch is saved/loaded with
    // the same id).
    let seed = 0;
    for (let i = 0; i < node.id.length; i++) {
      seed = ((seed << 5) - seed + node.id.charCodeAt(i)) | 0;
    }
    if (seed === 0) seed = 1;
    const rand = bugglesPrng(seed);

    // ---------------- Internal state (param shadows) ----------------
    //
    // We shadow the knob values in plain JS so the woggle scheduler
    // (which runs off setTimeout, NOT on the audio thread) can read them
    // without going through the AudioParam. The setParam handler keeps
    // both the AudioParam and the shadow in sync.
    let rateKnob = (node.params ?? {}).rate ?? 0.4;
    let chaos = (node.params ?? {}).chaos ?? 0.3;
    let smoothness = (node.params ?? {}).smoothness ?? 0.5;
    let burstProb = (node.params ?? {}).burst_probability ?? 0.2;
    let level = (node.params ?? {}).level ?? 0.7;

    // ---------------- ConstantSource outputs ----------------
    //
    // smooth + stepped are CV outputs driven by ConstantSourceNodes.
    // We mutate their .offset.value (or schedule ramps) on each woggle
    // event. clock + burst are gate outputs driven the same way (just
    // with very short pulse widths).
    const steppedSrc = ctx.createConstantSource();
    steppedSrc.offset.value = 0;
    steppedSrc.start();

    const smoothSrc = ctx.createConstantSource();
    smoothSrc.offset.value = 0;
    smoothSrc.start();

    const clockSrc = ctx.createConstantSource();
    clockSrc.offset.value = 0;
    clockSrc.start();

    const burstSrc = ctx.createConstantSource();
    burstSrc.offset.value = 0;
    burstSrc.start();

    // Per-output gain stages so LEVEL scales every output uniformly.
    // Gates (clock, burst) bypass LEVEL — gate consumers expect a
    // clean 0/1 swing regardless of the level knob.
    const steppedGain = ctx.createGain();
    steppedGain.gain.value = level;
    const smoothGain = ctx.createGain();
    smoothGain.gain.value = level;
    steppedSrc.connect(steppedGain);
    smoothSrc.connect(smoothGain);

    // ---------------- Ring output ----------------
    //
    // ring = smooth × suboscillator. The suboscillator is a sine at
    // rate/BUGGLES_RING_DIVISOR — SUB-AUDIO across the entire knob
    // travel (0.025 Hz .. 12.5 Hz; see the BUGGLES_RING_* block above,
    // which carries the measurement). Implemented via an
    // OscillatorNode + GainNode multiplier (the audio×param trick:
    // gain.value = 0; smooth → gain.gain; oscillator → gain input).
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    // Initial frequency from the rate knob; updated as rate changes.
    subOsc.frequency.value = bugglesMath.rateKnobToHz(rateKnob) / BUGGLES_RING_DIVISOR;
    subOsc.start();

    const ringMul = ctx.createGain();
    ringMul.gain.value = 0; // pure multiplier (zero intrinsic gain)
    subOsc.connect(ringMul);          // audio path
    smoothSrc.connect(ringMul.gain);  // modulator path

    // Output stage for ring — apply LEVEL.
    const ringGain = ctx.createGain();
    ringGain.gain.value = level;
    ringMul.connect(ringGain);

    // ---------------- CV input taps ----------------
    //
    // clock_cv and chaos_cv each route into an AnalyserNode (shared
    // pattern with the engine's per-param tap). The woggle scheduler
    // samples the latest value on each event and adds it to the
    // shadowed knob to produce the effective rate / chaos.
    const clockCvAnalyser = ctx.createAnalyser();
    clockCvAnalyser.fftSize = 32;
    clockCvAnalyser.smoothingTimeConstant = 0;
    const clockCvBuf = new Float32Array(32);
    function readClockCv(): number {
      clockCvAnalyser.getFloatTimeDomainData(clockCvBuf);
      return clockCvBuf[clockCvBuf.length - 1] ?? 0;
    }

    const chaosCvAnalyser = ctx.createAnalyser();
    chaosCvAnalyser.fftSize = 32;
    chaosCvAnalyser.smoothingTimeConstant = 0;
    const chaosCvBuf = new Float32Array(32);
    function readChaosCv(): number {
      chaosCvAnalyser.getFloatTimeDomainData(chaosCvBuf);
      return chaosCvBuf[chaosCvBuf.length - 1] ?? 0;
    }

    function effectiveRateKnob(): number {
      return clamp(rateKnob + readClockCv(), 0, 1);
    }
    function effectiveChaos(): number {
      return clamp(chaos + readChaosCv(), 0, 1);
    }

    // ---------------- External-clock detection ----------------
    //
    // When external_clock is patched, an AnalyserNode taps the incoming
    // gate and the scheduler's setInterval asks the SHARED windowed
    // edge counter how many rising edges arrived since the last poll.
    // Any edge fires a woggle event and suppresses the internal
    // scheduler until the gate input goes quiet (no edges for 1 second).
    //
    // ⚠ `createEdgeCounter`, NOT a hand-rolled buffer scan. See the
    // BUGGLES_EXT_* block at the top of this file for the measurement:
    // the hand-rolled version this replaced captured 16.7 % of the
    // pulses the user sent, at every clock rate.
    const extClockAnalyser = ctx.createAnalyser();
    extClockAnalyser.fftSize = BUGGLES_EXT_FFT_SIZE;
    extClockAnalyser.smoothingTimeConstant = 0;
    const extEdges = createEdgeCounter({ ctx, analyser: extClockAnalyser });
    // -Infinity so externalClockActive() returns false until a real edge
    // arrives. (Initial 0 made the helper return true for the first
    // second, which suppressed the internal scheduler reschedule and
    // froze every output at its first-event value.)
    let lastExtEdgeT = -Infinity;
    function checkExternalClock(): boolean {
      // ⚠ ONE woggle event per POLL, not per edge — see the coalescing
      // ceiling in the BUGGLES_EXT_* block. Below ~30 Hz (every clock in
      // this rack) a poll sees at most one edge, so this IS per-pulse.
      const edges = extEdges.poll(ctx.currentTime);
      if (edges > 0) lastExtEdgeT = ctx.currentTime;
      return edges > 0;
    }
    function externalClockActive(): boolean {
      // Consider external clock "active" if we've seen any edge in the
      // last 1 second. Drops back to internal after a 1s gap.
      return ctx.currentTime - lastExtEdgeT < 1;
    }

    // ---------------- Woggle event handler ----------------
    //
    // Runs on every internal-clock tick (or external rising edge).
    // Updates internal state, schedules ramps + gate pulses, picks
    // the next internal period.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let extClockPoller: ReturnType<typeof setInterval> | null = null;

    function fireWoggleEvent(): void {
      const now = ctx.currentTime;
      const effRate = effectiveRateKnob();
      const effChaos = effectiveChaos();
      const rateHz = bugglesMath.rateKnobToHz(effRate);

      // 1. Pick next stepped value.
      const previous = steppedSrc.offset.value;
      const next = bugglesMath.nextStepped(previous, effChaos, rand);

      // 2. Hard step on stepped output.
      steppedSrc.offset.cancelScheduledValues(now);
      steppedSrc.offset.setValueAtTime(next, now);

      // 3. Smooth ramp toward `next`. Smoothness 0 = ~10ms ramp (almost
      //    a step); smoothness 1 = ~2× the woggle period (very lazy).
      const periodS = 1 / Math.max(rateHz, 1e-6);
      const slewS = 0.01 + smoothness * 2 * periodS;
      smoothSrc.offset.cancelScheduledValues(now);
      smoothSrc.offset.setValueAtTime(smoothSrc.offset.value, now);
      smoothSrc.offset.linearRampToValueAtTime(next, now + slewS);

      // 4. Clock gate: 1 for CLOCK_PULSE_MS, then back to 0.
      clockSrc.offset.cancelScheduledValues(now);
      clockSrc.offset.setValueAtTime(1, now);
      clockSrc.offset.setValueAtTime(0, now + CLOCK_PULSE_MS / 1000);

      // 5. Burst roll. On hit, schedule 3..7 closely-spaced 4ms pulses
      //    on the burst output, separated by BURST_GAP_MS.
      const burstLen = bugglesMath.rollBurst(burstProb, rand);
      burstSrc.offset.cancelScheduledValues(now);
      burstSrc.offset.setValueAtTime(0, now);
      for (let i = 0; i < burstLen; i++) {
        const t0 = now + (i * BURST_GAP_MS) / 1000;
        const t1 = t0 + BURST_PULSE_MS / 1000;
        burstSrc.offset.setValueAtTime(1, t0);
        burstSrc.offset.setValueAtTime(0, t1);
      }

      // 6. Update sub-osc frequency to track the new rate (smoothly).
      subOsc.frequency.cancelScheduledValues(now);
      subOsc.frequency.linearRampToValueAtTime(rateHz / BUGGLES_RING_DIVISOR, now + 0.05);

      // 7. Schedule next internal woggle (if external clock isn't active).
      if (!externalClockActive()) {
        const nextPeriodS = bugglesMath.nextPeriodS(rateHz, effChaos, rand);
        timer = setTimeout(fireWoggleEvent, nextPeriodS * 1000);
      }
    }

    // Kick off the internal scheduler. First woggle fires immediately so
    // the user sees movement on the smooth/stepped outputs without
    // waiting up to 10 seconds at the lowest rate.
    timer = setTimeout(fireWoggleEvent, BUGGLES_FIRST_WOGGLE_MS);

    // External-clock polling. If a rising edge arrives, fire a woggle
    // event AND clear the internal timer so we don't get double-triggers.
    extClockPoller = setInterval(() => {
      if (checkExternalClock()) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        fireWoggleEvent();
      } else if (!externalClockActive() && timer === null) {
        // External clock dropped out — restart internal scheduler.
        const nextPeriodS = bugglesMath.nextPeriodS(
          bugglesMath.rateKnobToHz(effectiveRateKnob()),
          effectiveChaos(),
          rand,
        );
        timer = setTimeout(fireWoggleEvent, nextPeriodS * 1000);
      }
    }, BUGGLES_EXT_POLL_MS);

    return {
      domain: 'audio',
      inputs: new Map([
        // CV inputs feed into AnalyserNodes that the woggle scheduler
        // samples per event (NOT routed to AudioParams — see top-of-file
        // comment). external_clock feeds its own analyser for rising-
        // edge detection on each scheduler tick.
        ['clock_cv',       { node: clockCvAnalyser, input: 0 }],
        ['chaos_cv',       { node: chaosCvAnalyser, input: 0 }],
        ['external_clock', { node: extClockAnalyser, input: 0 }],
      ]),
      outputs: new Map([
        ['smooth',  { node: smoothGain,  output: 0 }],
        ['stepped', { node: steppedGain, output: 0 }],
        ['clock',   { node: clockSrc,    output: 0 }],
        ['burst',   { node: burstSrc,    output: 0 }],
        ['ring',    { node: ringGain,    output: 0 }],
      ]),
      setParam(paramId, value) {
        switch (paramId) {
          case 'rate':              rateKnob = value; return;
          case 'chaos':             chaos = value; return;
          case 'smoothness':        smoothness = value; return;
          case 'burst_probability': burstProb = value; return;
          case 'level':
            level = value;
            steppedGain.gain.setValueAtTime(value, ctx.currentTime);
            smoothGain.gain.setValueAtTime(value, ctx.currentTime);
            ringGain.gain.setValueAtTime(value, ctx.currentTime);
            return;
        }
      },
      readParam(paramId) {
        switch (paramId) {
          case 'rate':              return rateKnob;
          case 'chaos':             return chaos;
          case 'smoothness':        return smoothness;
          case 'burst_probability': return burstProb;
          case 'level':             return level;
        }
        return undefined;
      },
      dispose() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (extClockPoller !== null) {
          clearInterval(extClockPoller);
          extClockPoller = null;
        }
        try { steppedSrc.stop(); } catch { /* */ }
        try { smoothSrc.stop();  } catch { /* */ }
        try { clockSrc.stop();   } catch { /* */ }
        try { burstSrc.stop();   } catch { /* */ }
        try { subOsc.stop();     } catch { /* */ }
        steppedSrc.disconnect();
        smoothSrc.disconnect();
        clockSrc.disconnect();
        burstSrc.disconnect();
        subOsc.disconnect();
        ringMul.disconnect();
        ringGain.disconnect();
        steppedGain.disconnect();
        smoothGain.disconnect();
        extClockAnalyser.disconnect();
        clockCvAnalyser.disconnect();
        chaosCvAnalyser.disconnect();
      },
    };
  },
};
