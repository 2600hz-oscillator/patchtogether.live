// packages/web/src/lib/audio/modules/cofefve.ts
//
// COFEFVE DELAY — a clean-room, OWN-CODE analog BBD/tape-style stereo delay.
// The per-sample DSP is packages/dsp/src/cofefve.ts (wrapping the own-code
// packages/dsp/src/lib/analog-delay-core.ts); NO GPL delay source was read
// while writing it. It REPLACES the retired COCOA DELAY and keeps the same
// I/O + UX surface so the module slots in where a tape/BBD echo is wanted.
//
// Ports:
//   in L / in R  — stereo audio in
//   out L / out R— stereo audio out
//   clock        — gate/clock CV; when patched + tempo-sync != Off, the
//                  delay time locks to the measured pulse period × division.
//   CV inputs    — time, feedback, mix(=wet), drive(=gain), lfoAmt, drift,
//                  pan, duck — the musical continuous params, per the
//                  per-param-CV convention other modules use.
//
// Tempo sync (two pieces):
//   • clockSource (dropdown): SYSTEM (TIMELORDE) vs MIDI (MIDICLOCK). These
//     route to GENUINELY different tempo references:
//       - System → the rack's TIMELORDE `bpm` (read off the live patch graph,
//         same as CLOCKED RUNNER does).
//       - MIDI   → the shared MIDI-clock source (0xF8 @ 24 PPQN → derived BPM).
//     The worklet can't read those singletons (AudioWorkletGlobalScope), so a
//     main-thread loop resolves the chosen source's seconds-per-beat and
//     bridges it via the `syncPeriod` AudioParam.
//   • tempoSync (dropdown): Off → free-running ms (the TIME knob); otherwise
//     a musical division of that beat (1/4, 1/8, dotted, triplet …).
//   • A PATCHED `clock` gate input STILL overrides both sources — the DSP
//     measures the pulse period and uses it directly.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { getMidiClockSource } from '$lib/midi/midi-clock-source';
import workletUrl from '@patchtogether.live/dsp/dist/cofefve.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
/** clockSource dropdown indices (must match COFEFVE_CLOCK_SOURCE_OPTIONS). */
const CLOCK_SOURCE_SYSTEM = 0;
const CLOCK_SOURCE_MIDI = 1;

/** Read the rack's TIMELORDE bpm off the live patch graph (mirrors
 *  CLOCKED RUNNER). Returns the default 120 when no TIMELORDE is present. */
export function readTimelordeBpm(nodes: Record<string, { type?: string; params?: Record<string, unknown> } | undefined>): number {
  for (const n of Object.values(nodes)) {
    if (n?.type === 'timelorde') {
      const bpm = n.params?.['bpm'];
      if (typeof bpm === 'number' && bpm > 0) return bpm;
    }
  }
  return 120;
}

/** Resolve seconds-per-beat for the chosen clockSource. MIDI returns null
 *  when no live MIDI clock is being received (caller leaves syncPeriod=0 so
 *  the worklet falls back to the free-running knob until clock arrives). */
export function resolveSyncPeriodS(
  clockSource: number,
  nodes: Record<string, { type?: string; params?: Record<string, unknown> } | undefined>,
  midiBeatPeriodS: number | null,
): number {
  if (clockSource === CLOCK_SOURCE_MIDI) {
    return midiBeatPeriodS !== null && midiBeatPeriodS > 0 ? midiBeatPeriodS : 0;
  }
  // System (default / index 0): TIMELORDE.
  return 60 / readTimelordeBpm(nodes);
}

const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * ⚠ THE DOCK CLIPS THREE OF THESE ROSTERS, AND NO CAPTION CHOICE CAN FIX IT.
 * Recorded here, at the declaration, because the obvious repair is to shorten
 * the names and the obvious repair makes it WORSE.
 *
 * MEASURED on the real dock faceplate (`.seg` clientWidth vs scrollWidth, VRT
 * viewport, fonts pinned): `.segmented` sizes to max-content — the sum over
 * captions of (text width + 18 px padding/border) plus 4 px gaps — but `.seg`
 * is `flex: 1`, i.e. flex-BASIS 0, so the buttons then split that width
 * EQUALLY. Every caption gets exactly the MEAN of its roster's caption widths,
 * so ANY caption wider than the mean ellipsizes and the margin is zero BY
 * CONSTRUCTION. Shipped today:
 *
 *   clk src     System 41 px, MIDI 26 → 24 each  → `SYS…`
 *   pan mode    Static 41, Ping-Pong 60, Circular 55 → clips
 *   filt mode   1/2/4-pole 41/42/43, State-var 60  → clips
 *
 * Two repairs were tried and MEASURED, and both failed for the same reason.
 * Shortening `System` to `SYS` (22 px) NARROWED THE WHOLE GROUP and clipped
 * `MIDI` harder than before. Equalising every roster by CHARACTER COUNT
 * (`SYST`/`MIDI`, `STAT`/`PING`/`CIRC`, `1-P`/`2-P`/`4-P`/`SVF`) still clipped
 * the widest of each set by 1–3 px, because equal characters are not equal
 * pixels — `STAT` renders 29 px against `PING`'s 28. Hunting a caption set that
 * measures identically is calibrating against one renderer, which is the thing
 * CLAUDE.md's frame-count rule exists to forbid: it would pass on darwin and
 * clip somewhere else on linux.
 *
 * So the full names stay. The defect is in `Segmented.svelte`, it is ALREADY
 * LIVE on three other shipped faces — cloudseed `pre`/`post`, warrensspectrum
 * `LIVE`/`FREEZE`, tidyVco `-1`/`0`/`+1`, every roster whose captions differ in
 * width — and the fix is one line: `flex: 1 1 auto`, so a button keeps its
 * content width and shares only the surplus. It is provably a NO-OP for an
 * equal-width roster (filter's `LP`/`HP`/`BP`) and it does not move the GROUP's
 * width at all, only the boundaries inside it, so nothing reflows. It is not
 * taken here because it repaints those three modules' dock baselines: a
 * shared-primitive look change wants its own PR and an owner preview, not a
 * ride on a face. Filed with these numbers.
 *
 * ⚠ AND NONE OF IT IS VISIBLE TO `faces-parity`, which reads `textContent`:
 * the DOM says `Ping-Pong` while the panel paints `PING-P…`. Every gate was
 * green. Only capturing the dock and looking at it found this — which is the
 * transferable half.
 */

/**
 * A `ParamDef.options` roster built from a label array — index → detent.
 *
 * The four dropdowns below are ALREADY enumerated as label arrays (the legacy
 * card renders `<option>`s from them), so the face's named detents are DERIVED
 * from the same arrays rather than re-typed beside them. ONE roster, three
 * surfaces: the card's `<option>` text, the dock button's caption, and its
 * hover `title`. A state therefore cannot be named two ways by two surfaces —
 * the divergence `card-range-source`'s filter-MODES clause exists for, one
 * field over.
 *
 * `title` is set even though it equals `label`, so the full name survives the
 * ellipsis the dock currently applies to the widest caption in each roster
 * (see the note above): a hover always reads the whole word.
 *
 * `options` is UI VOCABULARY, not contract (see ParamOption): naming a value
 * cannot move contract-lock.
 */
function detents(
  labels: readonly string[],
): readonly { value: number; label: string; title: string }[] {
  return labels.map((title, value) => ({ value, label: title, title }));
}

/** Tempo-sync dropdown options (index → label). Index 0 = Off (free ms);
 *  the rest map 1:1 onto SYNC_BEATS in the worklet core. */
export const COFEFVE_TEMPO_SYNC_OPTIONS: readonly string[] = [
  'Off',
  '1', '1/2D', '1/2', '1/2T', '1/4D', '1/4', '1/4T',
  '1/8D', '1/8', '1/8T', '1/16D', '1/16', '1/16T',
  '1/32D', '1/32', '1/32T', '1/64D', '1/64', '1/64T',
];

/** Clock-source dropdown (index → label). */
export const COFEFVE_CLOCK_SOURCE_OPTIONS: readonly string[] = ['System', 'MIDI'];

/** Pan-mode dropdown (index → label). */
export const COFEFVE_PAN_MODE_OPTIONS: readonly string[] = ['Static', 'Ping-Pong', 'Circular'];

/** Filter-mode dropdown (index → label). */
export const COFEFVE_FILTER_MODE_OPTIONS: readonly string[] = ['1-pole', '2-pole', '4-pole', 'State-var'];

export const cofefveDelayDef: AudioModuleDef = {
  type: 'cofefve',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'cofefve delay',
  category: 'effects',
  stereoPairs: [['inL', 'inR'], ['outL', 'outR']],

  inputs: [
    { id: 'inL', type: 'audio' },
    { id: 'inR', type: 'audio' },
    // External clock for tempo sync (TIMELORDE or MIDICLOCK).
    { id: 'clock', type: 'gate', edge: 'trigger' },
    // Per-param CV (range standard per docs/adr/004-cv-range-convention.md).
    { id: 'time_cv',     type: 'cv', paramTarget: 'delayTime', cvScale: { mode: 'log' } },
    { id: 'feedback_cv', type: 'cv', paramTarget: 'feedback',  cvScale: { mode: 'linear' } },
    { id: 'mix_cv',      type: 'cv', paramTarget: 'wetVolume', cvScale: { mode: 'linear' } },
    { id: 'drive_cv',    type: 'cv', paramTarget: 'driveGain', cvScale: { mode: 'linear' } },
    { id: 'lfo_cv',      type: 'cv', paramTarget: 'lfoAmount', cvScale: { mode: 'linear' } },
    { id: 'drift_cv',    type: 'cv', paramTarget: 'driftAmount', cvScale: { mode: 'linear' } },
    { id: 'pan_cv',      type: 'cv', paramTarget: 'pan',       cvScale: { mode: 'linear' } },
    { id: 'duck_cv',     type: 'cv', paramTarget: 'duckAmount', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'outL', type: 'audio' },
    { id: 'outR', type: 'audio' },
  ],
  params: [
    // DELAY / TIME
    { id: 'delayTime',   label: 'Time',     defaultValue: 0.2,  min: 0.001, max: 2.0,  curve: 'log',      units: 's' },
    { id: 'tempoSync',   label: 'Sync',     defaultValue: 0,    min: 0,     max: 19,   curve: 'discrete',
      options: detents(COFEFVE_TEMPO_SYNC_OPTIONS) },
    { id: 'clockSource', label: 'Clk Src',  defaultValue: 0,    min: 0,     max: 1,    curve: 'discrete',
      options: detents(COFEFVE_CLOCK_SOURCE_OPTIONS) },
    //
    // ⚠ `syncPeriod` USED TO BE DECLARED HERE AND IS NOT A PARAM. It is the
    // seconds-per-beat the main thread BRIDGES into the worklet (the factory's
    // 16 ms `setInterval` below), because AudioWorkletGlobalScope cannot read
    // the TIMELORDE / MIDI-clock singletons. It is still an AudioParam — the
    // worklet declares its OWN `parameterDescriptors` (packages/dsp/src/
    // cofefve.ts) and the bridge writes it through `params.get('syncPeriod')`,
    // which reads that map, not this list — so removing it here changes no
    // audio and no wiring.
    //
    // Declaring it as a user PARAM was the defect. This list is the module's
    // CONTROL surface: it feeds the card, the auto-exposed group bar, MIDI
    // learn, automation lanes, the push card, and — the reason it surfaced —
    // the faceplate, which is COMPLETE by construction (module-face-lint) and
    // whose parity gate asserts exactly one operable cell per param. So
    // promoting this module to a face would have painted a 0..30 s dial that
    // the host silently overwrites 62 times a second: a control that cannot
    // hold a value, on a faceplate whose whole argument is that a control
    // which does nothing must say so. The def's own comment already said "not
    // user-facing"; the declaration now agrees with it.
    // LFO
    { id: 'lfoAmount',    label: 'LFO Amt',  defaultValue: 0.0,  min: 0.0,   max: 0.5,  curve: 'linear' },
    { id: 'lfoFrequency', label: 'LFO Freq', defaultValue: 2.0,  min: 0.1,   max: 10.0, curve: 'log',   units: 'hz' },
    // DRIFT
    { id: 'driftAmount', label: 'Drift Amt', defaultValue: 0.001, min: 0.0,  max: 0.05, curve: 'linear' },
    { id: 'driftSpeed',  label: 'Drift Spd', defaultValue: 1.0,   min: 0.1,  max: 10.0, curve: 'log' },
    // FEEDBACK
    { id: 'feedback',     label: 'Feedback', defaultValue: 0.5,  min: -1.0,  max: 1.0,  curve: 'linear' },
    { id: 'stereoOffset', label: 'Stereo',   defaultValue: 0.0,  min: -0.5,  max: 0.5,  curve: 'linear' },
    { id: 'pan',          label: 'Pan',      defaultValue: 0.0,  min: -Math.PI * 0.5, max: Math.PI * 0.5, curve: 'linear' },
    { id: 'panMode',      label: 'Pan Mode', defaultValue: 0,    min: 0,     max: 2,    curve: 'discrete',
      options: detents(COFEFVE_PAN_MODE_OPTIONS) },
    // DUCKING
    { id: 'duckAmount',  label: 'Duck Amt', defaultValue: 0.0,  min: 0.0,   max: 10.0, curve: 'linear' },
    { id: 'duckAttack',  label: 'Attack',   defaultValue: 10.0, min: 0.1,   max: 100.0, curve: 'log' },
    { id: 'duckRelease', label: 'Release',  defaultValue: 10.0, min: 0.1,   max: 100.0, curve: 'log' },
    // FILTER (in feedback path)
    { id: 'filterMode', label: 'Filt Mode', defaultValue: 0,    min: 0,     max: 3,    curve: 'discrete',
      options: detents(COFEFVE_FILTER_MODE_OPTIONS) },
    { id: 'lowCut',     label: 'Low Cut',   defaultValue: 0.75, min: 0.01,  max: 1.0,  curve: 'linear' },
    { id: 'highCut',    label: 'High Cut',  defaultValue: 0.001, min: 0.001, max: 0.99, curve: 'linear' },
    // DRIVE
    { id: 'driveGain',       label: 'Gain',  defaultValue: 0.1,  min: 0.0,   max: 10.0, curve: 'linear' },
    { id: 'driveMix',        label: 'D.Mix', defaultValue: 1.0,  min: 0.0,   max: 1.0,  curve: 'linear' },
    { id: 'driveCutoff',     label: 'D.Filt',defaultValue: 1.0,  min: 0.01,  max: 1.0,  curve: 'linear' },
    { id: 'driveIterations', label: 'Iters', defaultValue: 1,    min: 1,     max: 16,   curve: 'discrete' },
    // DRY / WET
    { id: 'dryVolume', label: 'Dry', defaultValue: 1.0, min: 0.0, max: 2.0, curve: 'linear' },
    { id: 'wetVolume', label: 'Wet', defaultValue: 0.5, min: 0.0, max: 2.0, curve: 'linear' },
  ],

  /** The hero picture — the echo train. See `face.hero` + shell-cells. */
  controlFamilies: [
    {
      id: 'cofefve-echo',
      label: 'Echo train',
      kind: 'cell' as const,
      testidPrefix: 'cofefve-echo',
    },
  ],

  docs: {
    explanation: "A clean-room, own-code analog BBD/tape-style stereo delay (the replacement for the retired Cocoa Delay — its own DSP, no GPL lineage). Audio is written into a 10-second stereo delay line and read back at a fractional, modulated position with 4-point Catmull-Rom cubic interpolation. The read time is the base delay (free-running TIME, or a musical division of a clock beat when SYNC is on), warped per-sample by a WOW sine LFO and a slow random FLUTTER drift, with bipolar feedback feeding the echoes back through an in-loop multi-mode TONE filter and a stateful tanh DRIVE saturator; a STEREO offset skews the L/R read times to widen the image, PAN modes spread the wet signal, DUCKING sidechains the wet level off the dry input, and DRY/WET set the final mix. Mental model: one tape/bucket-brigade echo where almost every knob is also voltage-controllable, and where a patched CLK pulse or the rack/MIDI tempo can lock the delay to the beat. The read pointer eases toward its target so TIME changes glide like a tape motor rather than clicking.",
    inputs: {
      inL: "Left audio into the delay — together with inR this is the dry signal that is written to the delay line, tapped through the wet path, and summed back into the output.",
      inR: "Right audio into the delay; an independent channel that normals to inL when left unpatched (a mono source into inL alone feeds both channels). Patch both inL and inR for a true stereo input, or use the module's stereo auto-wire.",
      clock: "External clock/trigger: when SYNC is on, the delay measures the samples between rising edges (level crossing up through ~0.5) of pulses here and locks the delay time to that measured period times the chosen division — it takes two rising edges to establish a period, so the lock engages on the second pulse. A patched clock ALWAYS wins over both the rack SYSTEM tempo and MIDI clock; when SYNC is Off this input has no audible effect and TIME is free-running.",
      time_cv: "CV modulation of the TIME knob (delayTime), summed into it with a log-scaled response so a -1..+1 CV sweeps the base delay across its full log range; sweeping it gives classic tape pitch-bend / smear on the echoes.",
      feedback_cv: "CV modulation of FEEDBACK, summed into the knob (linear). Pushes the regeneration amount up or down per-sample; since feedback is bipolar (-1..+1), CV can drive it negative to flip the polarity of each repeat.",
      mix_cv: "CV modulation of the WET output level (targets wetVolume, linear). Use it to fade the echoes in and out under control voltage; the dry level is unaffected.",
      drive_cv: "CV modulation of the in-loop saturation amount (targets driveGain, linear). Raises or lowers how hard the feedback path is pushed into the stateful tanh saturator per-sample.",
      lfo_cv: "CV modulation of the LFO (WOW) AMOUNT (lfoAmount, linear) — the depth with which the internal time LFO wobbles the delay read position. It does not change the LFO rate, only how much it warps the time.",
      drift_cv: "CV modulation of DRIFT (FLUTTER) AMOUNT (driftAmount, linear), the depth of the slow random tape-drift walk applied to the read time. More CV = more wow/flutter wander.",
      pan_cv: "CV modulation of the PAN angle (pan, linear). Its audible effect depends on PAN MODE: it rotates the static placement, biases the ping-pong, or drives the circular wet-image rotation.",
      duck_cv: "CV modulation of DUCK AMOUNT (duckAmount, linear) — how strongly the wet level is pulled down by the envelope follower riding the dry input. More CV = the echoes get out of the way harder when dry signal is present.",
    },
    outputs: {
      outL: "Left of the stereo output: dry × DRY level + ducked/panned wet × WET level, the left half of the combined dry+echo signal.",
      outR: "Right of the stereo output: dry × DRY level + ducked/panned wet × WET level, the right half of the combined dry+echo signal.",
    },
    controls: {
      delayTime: "TIME — the base delay length in seconds (0.001–2.0 s, log). Used directly when SYNC is Off; when SYNC is on it is only the fallback if no clock/tempo is available. WOW, FLUTTER and STEREO offset all warp this value before the line is read, and the read pointer eases toward it so changes glide.",
      tempoSync: "SYNC — Off (index 0) means TIME is free-running; any other setting locks the delay to a musical division of one beat (1, dotted/triplet variants… down to 1/64T). The beat comes from a patched clock pulse, else the chosen CLK SRC tempo. Two consequences worth stating: while SYNC is on, TIME is BYPASSED (it is only the fallback when no beat is available at all), and SYNC is the ENABLER for CLK SRC — which is bit-exactly inaudible while SYNC is Off.",
      clockSource: "CLK SRC — a two-state latching choice of which tempo reference SYNC follows when no clock cable is patched: SYSTEM reads the rack's TIMELORDE BPM, MIDI follows incoming MIDI clock (0xF8). Choosing MIDI is what first requests browser MIDI access; SYSTEM never prompts. A patched CLK input overrides either. ⚠ IT DOES NOTHING WHILE SYNC IS OFF, which is how it ships: with SYNC at Off the delay is free-running and no tempo reference is consulted at all, so moving this control is bit-exactly inaudible until SYNC leaves Off.",
      lfoAmount: "WOW (LFO AMOUNT) — depth of the internal sine LFO that warps the delay read time (0–0.5). At 0 the LFO does nothing; higher values give pitch wobble / chorus-like movement on the echoes.",
      lfoFrequency: "WOW RATE (LFO FREQUENCY) — rate of the time-warp LFO (0.1–10 Hz, log). Sets how fast the delay-time wobble cycles. ⚠ IT DOES NOTHING AT THE SHIPPED DEFAULT: the LFO's contribution is depth × sin(phase) and WOW ships at depth 0, so the whole 0.1–10 Hz sweep is bit-exactly inaudible until WOW AMOUNT leaves 0. Raise WOW AMOUNT first.",
      driftAmount: "FLUTTER (DRIFT AMOUNT) — depth of a slow random walk on the delay time (0–0.05), the tape wow/flutter character. Higher = more wandering, less stable pitch on the echoes. The walk is a fixed-seed PRNG so renders are deterministic.",
      driftSpeed: "FLUTTER SPEED (DRIFT SPEED) — how quickly the random drift walk picks new targets (0.1–10, log). Faster gives jittery flutter, slower gives long lazy pitch drift.",
      feedback: "FEEDBACK — bipolar regeneration amount (-1..+1, default 0.5). Higher magnitude = more/longer repeats; negative values invert the polarity of each fed-back repeat for a hollower tone. Internally clamped just below unity so the loop stays stable.",
      stereoOffset: "STEREO — skews the left and right read times apart (-0.5..+0.5) by shortening one channel's delay and lengthening the other, widening the stereo image of the echoes. The skew is symmetric about the base delay (left reads at 1-offset, right at 1+offset), so the two channels end up 2 × |offset| × TIME apart and the effect is exactly mirrored about zero. 0 keeps both channels at the same delay (L and R identical) — which also makes PING-PONG a no-op on a mono source, since there is then nothing to swap.",
      pan: "PAN — wet-image rotation angle (-π/2..+π/2). What it does depends on PAN MODE: static placement, ping-pong bias, or the amount of circular rotation applied to the wet signal.",
      panMode: "PAN MODE — Static (a fixed rotation by PAN), Ping-Pong (crosses the feedback so repeats bounce side to side), or Circular (continuously rotates the wet stereo image at a rate set by PAN). ⚠ THE THREE MODES HAVE DIFFERENT PREREQUISITES, and at the shipped defaults none of them is audible. STATIC and CIRCULAR both rotate by an angle built from PAN, so at PAN 0 both are the identity — CIRCULAR additionally advances at a rate proportional to |PAN|, so at 0 it does not even turn. PING-PONG instead SWAPS the two channels' feedback, which is a no-op whenever the two channels carry the same signal: it needs a genuine left/right difference, which means either a true stereo source or a non-zero STEREO offset — and it is entirely independent of PAN.",
      duckAmount: "DUCK AMOUNT — how strongly the wet level is ducked by an envelope follower on the dry input sum (0–10). At 0 there is no ducking; higher values make the echoes recede whenever dry signal is playing.",
      duckAttack: "DUCK ATTACK — how fast the ducking envelope clamps the wet down when dry signal arrives (0.1–100 ms, log). ⚠ IT DOES NOTHING AT THE SHIPPED DEFAULT: the wet gain is 1/(1 + DUCK AMOUNT × envelope), so at DUCK AMOUNT 0 the gain is exactly 1 whatever the envelope does. Raise DUCK AMOUNT first.",
      duckRelease: "DUCK RELEASE — how fast the wet level recovers after the dry signal falls away (0.1–100 ms, log). ⚠ Inert at the shipped default for the same reason as DUCK ATTACK: DUCK AMOUNT 0 multiplies the envelope out of the wet gain entirely.",
      filterMode: "FILTER MODE — the topology of the in-feedback-loop tone filter: 1-pole, 2-pole, 4-pole (cascaded one-poles), or State-variable. Steeper poles darken the repeats more; the state-variable mode adds a mild resonant character.",
      lowCut: "LOW CUT — the in-loop low-pass cutoff applied to each repeat (0.01–1.0, normalized; default 0.75, where 1.0 is wide open). Lower values darken successive echoes as they regenerate. (Despite the 'low cut' label it is the LP stage in the loop, matching the classic tape-echo tone control.)",
      highCut: "HIGH CUT — the in-loop high-pass cutoff applied to each repeat (0.001–0.99, normalized; default 0.001 ≈ off). Raising it thins out the lows of successive echoes. (Label/role: this is the HP stage in the loop.)",
      driveGain: "DRIVE GAIN — how hard the feedback path is pushed into the stateful tanh saturator (0–10). 0 bypasses drive entirely (an exact early return, not an approximation); higher adds progressively dirtier saturation that builds up over repeats. It is the ENABLER for DRIVE MIX and DRIVE ITERATIONS, which are near-inert until it is raised. ⚠ It ships at 0.1 — neither the exact bypass nor an audible drive, but a sliver of saturation that is 1 % of the control's travel. Whether that is the intended default is an open question for the module's owner; it is recorded here rather than changed, because changing it changes the module's shipped sound.",
      driveMix: "DRIVE MIX — wet/dry blend across the saturator (0–1), how much of the saturated signal replaces the clean one inside the loop. ⚠ NEARLY INERT AT THE SHIPPED DEFAULT: DRIVE GAIN ships at 0.1 of 10, so the saturator runs at tanh(x × 1.1) — barely a curve — and sweeping this control the whole way moves the output by well under a percent. Raise DRIVE GAIN first.",
      driveCutoff: "DRIVE FILTER — post-saturator low-pass cutoff (0.01–1.0, normalized; default 1.0 = open) that tames the harshness the drive adds.",
      driveIterations: "DRIVE ITERATIONS — how many times the saturate-then-filter stage runs in series per sample (1–16). More iterations stack more saturation and filtering for a thicker, more compressed drive. ⚠ Nearly inert at the shipped DRIVE GAIN of 0.1, for the same reason as DRIVE MIX: stacking sixteen almost-linear stages is still almost linear. Raise DRIVE GAIN first.",
      dryVolume: "DRY — level of the unprocessed input passed straight to the output (0–2.0, default 1.0). Set to 0 for a fully wet send/return.",
      wetVolume: "WET — level of the delayed/echo signal in the output (0–2.0, default 0.5), the amount ducking pulls down and what mix_cv modulates. Together with DRY it is the only gain stage on the module and nothing after it limits: at 2.0 the module measures 1.240 peak on a -6 dBFS input, i.e. past full scale on its own.",
      'cofefve-echo-{n}':
        "ECHO TRAIN — the faceplate's hero picture, not a control: the dry hit followed by the repeats the current settings will actually produce, spaced at the EFFECTIVE delay (TIME, or the SYNC division when SYNC is on), each one shorter than the last by the feedback loop's gain, and split into a left and a right stem when STEREO skews the two channels apart. The WOW ripple over the train is drawn only when WOW AMOUNT is above 0 — at the shipped default it is greyed, so the picture says the motion section is off instead of drawing a still train that looks like a working one. The window button under it switches the time axis between 2 s and 8 s.",
    },
  },
  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // THE PROBLEM THIS FACE EXISTS FOR, in one sentence: SEVEN of this
  // module's twenty-three controls do nothing at the factory default — FIVE of
  // them bit-exactly and two within a percent of it — because each is the dependent half of
  // an ENABLER PAIR whose enabler ships closed — and the panel has no way to
  // say so. A new user turns a knob, hears nothing, and concludes the module is
  // broken. The measurements (max|Δ| against the shipped render, the REAL
  // worklet, 48 kHz, C4 saw into both inputs) are NOT repeated in this comment:
  // every one of them is re-derived from the shipping DSP on every run by
  // cofefve-face-model.test.ts, so a comment here could go stale while the gate
  // stayed green — the drift this repo keeps re-learning.
  //
  // ⚠ 1 · IT IS A DEFAULTS-AND-LEGIBILITY PROBLEM, NOT A DSP BUG — with ONE
  // question referred to the owner. Four of the five pairs are the ordinary,
  // correct convention: a depth control at zero silences its rate control
  // (WOW), a feature switched off silences its shaping controls (DUCK), a
  // free-running delay consults no tempo reference (SYNC → CLK SRC), a centred
  // image does not rotate (PAN → the STATIC/CIRCULAR modes). Shipping those
  // enablers at zero is right; shipping them SILENTLY is what this face fixes.
  // The fifth is different and is NOT fixed here: DRIVE GAIN ships at 0.1 of
  // 10, which is neither the DSP's own exact bypass (`driveGain <= 0` is an
  // early return) nor an audible drive — see its `docs.controls` entry. Moving
  // it changes the module's shipped sound and re-pins its ART baseline, so it
  // is recorded for the owner rather than changed in a face PR.
  //
  // ⚠ 2 · AND THE SPEC'S PAN STORY WAS WRONG, which is worth stating because
  // the error was in the INSTRUMENT, not the analysis. Measured with an
  // identical signal in both inputs, PAN MODE moves nothing at any setting of
  // anything except PAN — from which it follows that PAN is its enabler. It is
  // not. PING-PONG swaps the two channels' FEEDBACK, and a swap of two equal
  // things is the identity, so a probe that feeds L and R the same waveform is
  // structurally blind to the one mode that does not need PAN at all. Feed the
  // two inputs DIFFERENT waveforms, or skew them with STEREO, and PING-PONG
  // wakes at PAN 0. So PAN MODE has TWO enablers with different jurisdictions
  // (STEREO/a stereo source for PING-PONG, PAN for CIRCULAR), both of which
  // rank above it here, and the sidebar names them separately.
  //
  // ⚠ 3 · THE RANKING RULE. A DEPENDENT NEVER OUTRANKS ITS ENABLER — that is
  // the property that makes every PREFIX of the ranking usable, because no
  // tier can ever show you a control whose enabler it does not also show. The
  // stronger form (a dependent is ADJACENT to its enabler) holds for every pair
  // but one: the six-cell lane plate is TIME / FEEDBACK / WET / DRY / SYNC /
  // DRIVE, the six controls this instrument is actually played with, which
  // displaces CLK SRC to rank 10. Putting a bit-exactly inert CLK SRC into a
  // 192 px lane tile to preserve adjacency would be the exact defect this face
  // exists to prevent, so adjacency yields to the lane.
  //
  // ⚠ 4 · WHERE THE FACTS LIVE, and the correction that decided it. `face.hint`
  // and `face.title` do not paint at rest — that much was known going in. BAND
  // HINTS DO NOT EITHER: `bandHeaderPlan` blanks every one of them unless
  // ANNOTATION MODE is on, by the same owner directive that gated the page
  // header ("no text on the module… the type/description text needs to go
  // away"). Verified by capturing the dock and looking at it, which is the only
  // way this is visible — the declaration is present, the lint's reachability
  // clause is green, and the rendered panel shows six bare band labels.
  //
  // So NOTHING load-bearing is in a hint. The three surfaces that paint
  // unconditionally carry the whole argument, and each states it at a different
  // grain: the HERO counts what is asleep, the HERO PICTURE greys the WOW
  // ripple and captions the count beside it, and the SIDEBAR names all five
  // pairs with their live enabler values. The band hints are a fourth tier for
  // a player who turns annotations on — the mechanism ("the wet gain is
  // 1/(1 + DUCK × envelope)") rather than the state.
  //
  // ⚠ 5 · SIX BANDS, deliberately one under DOCK_TAB_MIN_BANDS. A seventh flips
  // the dock to a tab rail, which kills PF-21 row packing and takes the band
  // hints with it even in annotation mode.
  face: {
    // Ranks 1-6 are the lane plate (faceTierCap('full')); 7-23 the dock tail;
    // 24 the hero picture, whose first legal rank is 7 (module-face-lint
    // refuses a PANEL cell selected at a lane tier).
    order: [
      // ── the lane: what a delay is played with ──
      'delayTime', 'feedback', 'wetVolume', 'dryVolume',
      'tempoSync',                                   // ENABLER → clockSource
      'driveGain',                                   // ENABLER → driveMix, driveIterations
      // ── the dock tail: every enabler immediately above its dependents ──
      'driveMix', 'driveIterations', 'driveCutoff',
      'clockSource',                                 // dependent of tempoSync (rank 5)
      'lfoAmount', 'lfoFrequency',                   // ENABLER → its rate
      'driftAmount', 'driftSpeed',
      'stereoOffset', 'pan', 'panMode',              // TWO enablers, then the dependent
      'duckAmount', 'duckAttack', 'duckRelease',     // ENABLER → its two shapers
      'lowCut', 'highCut', 'filterMode',
      'cofefve-echo-{n}',                            // the hero picture
    ],

    pages: [
      {
        id: 'time',
        label: 'time',
        hint:
          'SYNC replaces TIME rather than trimming it, and CLK SRC only picks which tempo ' +
          'SYNC follows — so at the shipped SYNC=Off, CLK SRC is inaudible.',
        controls: ['delayTime', 'tempoSync', 'clockSource', 'feedback', 'cofefve-echo-{n}'],
      },
      {
        id: 'drive',
        label: 'drive',
        hint:
          'in the feedback loop, so it compounds over repeats. GAIN ships at 0.1 of 10 — ' +
          'MIX and ITERATIONS have almost no authority until you raise it.',
        controls: ['driveGain', 'driveMix', 'driveIterations', 'driveCutoff'],
      },
      {
        id: 'tone',
        label: 'tone',
        hint:
          'also in the loop, so each repeat is darker than the last. Both cutoffs ship at an ' +
          'END of their range, which leaves MODE — a change of slope — almost nothing to act on.',
        controls: ['lowCut', 'highCut', 'filterMode'],
      },
      {
        id: 'motion',
        label: 'motion',
        hint:
          'WOW is a sine on the read time, FLUTTER a slow random walk. RATE is inaudible until ' +
          'AMOUNT leaves 0, because the LFO contributes amount × sin(phase).',
        controls: ['lfoAmount', 'lfoFrequency', 'driftAmount', 'driftSpeed'],
      },
      {
        id: 'stereo',
        label: 'stereo',
        hint:
          'STEREO skews the two read times apart; PAN rotates the wet image. PING-PONG needs a ' +
          'left/right DIFFERENCE (STEREO, or a stereo source) — CIRCULAR needs PAN. Not the LFO.',
        controls: ['stereoOffset', 'pan', 'panMode'],
      },
      {
        id: 'output',
        label: 'duck + output',
        hint:
          'the wet gain is 1/(1 + DUCK × envelope), so at DUCK 0 the gain is exactly 1 and ' +
          'ATTACK and RELEASE cannot be heard. DRY and WET both reach past full scale.',
        controls: ['duckAmount', 'duckAttack', 'duckRelease', 'dryVolume', 'wetVolume'],
        clusters: [{ label: 'ducking', controls: ['duckAmount', 'duckAttack', 'duckRelease'] }],
      },
    ],

    glyph: 'scope',

    // THE HERO. The picture is the echo train the CURRENT settings produce; the
    // promoted control is TIME, which is the one thing that moves it most.
    //
    // The three readouts are DERIVED, never a knob relabelled, and each is
    // blind in a different direction from the dial nearest it:
    //   `waiting` counts the controls that currently do nothing. No param
    //             readback can express it — it is a function of five enablers
    //             at once, and it must NOT move when a dependent moves.
    //   `spacing` is the EFFECTIVE echo period. A `delayTime` readback is
    //             flatly wrong while SYNC is on, because SYNC bypasses TIME.
    //   `repeats` is the loop-gain bound on how many echoes survive. A
    //             `feedback` readback prints -0.50 and +0.50 as different
    //             numbers when the tail they produce is identical, and it is
    //             blind to nothing else — which is exactly the negative
    //             control the model test runs in both directions.
    hero: {
      cell: 'cofefve-echo-{n}',
      control: 'delayTime',
    },

    title: 'Analog delay',
    hint:
      'A tape/BBD echo whose enablers all ship closed. Seven controls do nothing until you open ' +
      'the one ranked above them.',
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'cofefve', {
      numberOfInputs: 3, // L, R, clock
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Keep the node alive when nothing is patched in. Pinned to input 0 (audio
    // L) and input 2 (clock) ONLY — NEVER input 1. A ConstantSource on input 1
    // makes Chrome hand the processor a (silent) channel for it forever, which
    // defeats the DSP's `inputs[1]?.[0] ?? inputs[0]?.[0]` mono normal and
    // renders an unpatched inR as digital silence, contradicting inR's own doc
    // ("normals to inL when left unpatched"). Enforced by
    // mono-normal-not-defeated.test.ts.
    const silenceL = ctx.createConstantSource();
    const silenceClk = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceClk.offset.value = 0;
    silenceL.start();
    silenceClk.start();
    silenceL.connect(workletNode, 0, 0);
    silenceClk.connect(workletNode, 0, 2);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of cofefveDelayDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // --- sync-period bridge ---------------------------------------------
    // The worklet can't read TIMELORDE / the MIDI-clock singleton (it's in
    // AudioWorkletGlobalScope). Resolve the chosen clockSource's beat period
    // on the main thread and feed it to the worklet via the `syncPeriod`
    // AudioParam. ~60 Hz is plenty (tempo changes are gestural); a patched
    // `clock` gate still overrides this inside the DSP.
    //
    // The MIDI clock source is constructed here (cheap, no I/O) but we ONLY
    // READ it (getBeatPeriodS) when the user has actually selected MIDI as the
    // clockSource. Reading is what triggers navigator.requestMIDIAccess(), so
    // spawning a COFEFVE DELAY on the default System clock must NOT touch the
    // MIDI source — that would pop the browser permission prompt unprompted.
    const syncPeriodParam = params.get('syncPeriod');
    const nodeId = node.id;
    const midiClock = getMidiClockSource();
    let syncTimer: ReturnType<typeof setInterval> | null = null;
    function pushSyncPeriod(): void {
      if (!syncPeriodParam) return;
      const live = livePatch.nodes[nodeId];
      const clockSource = Math.round(
        (typeof live?.params?.['clockSource'] === 'number'
          ? (live.params['clockSource'] as number)
          : (node.params?.['clockSource'] as number | undefined)) ?? 0,
      );
      // Only read the MIDI tempo (and thus request MIDI access) when MIDI is
      // the selected clock. System keeps null and never prompts.
      const midiBeatPeriodS =
        clockSource === CLOCK_SOURCE_MIDI ? midiClock.getBeatPeriodS() : null;
      const period = resolveSyncPeriodS(
        clockSource,
        livePatch.nodes,
        midiBeatPeriodS,
      );
      syncPeriodParam.setValueAtTime(period, ctx.currentTime);
    }
    pushSyncPeriod();
    syncTimer = setInterval(pushSyncPeriod, 16);

    return {
      domain: 'audio',
      inputs: new Map([
        ['inL',         { node: workletNode, input: 0 }],
        ['inR',         { node: workletNode, input: 1 }],
        ['clock',       { node: workletNode, input: 2 }],
        ['time_cv',     { node: workletNode, input: 0, param: params.get('delayTime')! }],
        ['feedback_cv', { node: workletNode, input: 0, param: params.get('feedback')! }],
        ['mix_cv',      { node: workletNode, input: 0, param: params.get('wetVolume')! }],
        ['drive_cv',    { node: workletNode, input: 0, param: params.get('driveGain')! }],
        ['lfo_cv',      { node: workletNode, input: 0, param: params.get('lfoAmount')! }],
        ['drift_cv',    { node: workletNode, input: 0, param: params.get('driftAmount')! }],
        ['pan_cv',      { node: workletNode, input: 0, param: params.get('pan')! }],
        ['duck_cv',     { node: workletNode, input: 0, param: params.get('duckAmount')! }],
      ]),
      outputs: new Map([
        ['outL', { node: workletNode, output: 0 }],
        ['outR', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        if (syncTimer !== null) clearInterval(syncTimer);
        try { silenceL.stop(); } catch { /* */ }
        try { silenceClk.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceClk.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
