// packages/web/src/lib/audio/modules/moog921b.ts
//
// MOOG 921B OSCILLATOR — Moog System 55/35 clone (batch 1, shipped with the
// 921A driver). The slaved VCO: driven by a 921A's freq_bus / width_bus
// CONTROL INPUTS (it has no 1V/oct jack of its own — the 921A is the master
// driver). Presents FOUR fixed-level simultaneous waveform outs off one
// common core. Its span is the shared core's: a 0.01 Hz floor and a ceiling
// just under Nyquist (23 520 Hz at 48 kHz), NOT the hardware's nominal
// "1 Hz–40 kHz" — 40 kHz needs a sample rate of 81 633 Hz (#1792).
// Shared by SYS55 + SYS35 → categorized under
// Ports → moogafakkin (the shared bucket, mirroring the 921 VCO + 904A).
//
// DSP forks the shared own-code Moog VCO core (the same clean-room
// polyBLEP/polyBLAMP band-limited oscillator + hard/soft sync the 921 VCO
// uses; packages/dsp/src/moog921b.ts + lib/moog-vco-dsp.ts), slaved to the
// bus. AC MODULATE is cap-coupled (a DC-blocking high-pass on the mod input
// before linear FM); DC MODULATE is straight linear FM; SYNC drives a
// hard/soft/off phase reset. Permissive, not a port of any Moog schematic /
// copyleft source.
//
// Inputs:
//   freq_bus (cv): V/oct pitch CV from a 921A's freq_bus (0 = C4).
//   width_bus (cv): 0..1 pulse-width CV from a 921A's width_bus (normals to
//     0.5 / square when unpatched).
//   dc_mod (audio): LINEAR FM, DC-coupled (non-1V/oct). Scaled by modAmount.
//   ac_mod (audio): LINEAR FM, AC-coupled — a DC-blocking HP runs first so a
//     DC offset on the modulator doesn't bend the pitch. Scaled by modAmount.
//   sync (audio): external sync source; rising edges reset/nudge the phase
//     per the SYNC switch.
//
// Outputs (all audio, fixed level):
//   sine, triangle, saw, rect.
//
// Params:
//   fine (linear -12..12, default 0): FREQUENCY pot — 2-octave fine trim.
//   range (discrete -5..5, default 0): RANGE switch — octave footage.
//   modAmount (linear -1..1, default 0): linear-FM depth (DC + AC inputs).
//   syncMode (linear -1..1, default 0): SYNC switch. -1 soft / 0 off / +1 hard.
//   level (linear 0..2, default 1): output gain.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ParamOption } from '$lib/graph/types';
import workletUrl from '@patchtogether.live/dsp/dist/moog921b.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

/**
 * The SYNC switch's three named states (PF-1).
 *
 * ⚠ `syncMode` IS A COMPARATOR, NOT A DIAL, AND IT USED TO BE DECLARED AS ONE.
 * The DSP thresholds it at ±0.5 (`syncModeFromParam`, `lib/moog-vco-dsp.ts:48-52`:
 * `v >= 0.5 → hard`, `v <= -0.5 → soft`, else `off`), so HALF the declared
 * −1..1 travel is one flat `off` state and nothing between the detents exists.
 * It shipped `curve: 'linear'`, which is the inverse of the PF-1 defect: a
 * def-driven face painted a continuous rotary printing `0.00` over a
 * three-position switch, and `options` cannot be declared on a non-discrete
 * curve (`param-vocabulary.test.ts` refuses a def carrying both). The two edits
 * are therefore SEQUENCED and land together — `discrete` first, then the roster.
 *
 * ⚠ CHECKED AGAINST THE CONSUMERS BEFORE CHANGING IT (CLAUDE.md's "before
 * fixing a declaration to satisfy a gate, check the consumer reads it"): the
 * DSP quantizes it already, so no rendered sample moves; no input declares
 * `paramTarget: 'syncMode'`, so no CV bridge reads the curve; and
 * `Moog921bCard.svelte` paints it as an OFF/LO/HI button row rather than a
 * `<Knob>`, so no legacy pixel moves either. What DOES change is that the
 * faceplate's dial now steps to −1 / 0 / +1 instead of stopping anywhere in a
 * band that means the same thing, and the dock paints the three names.
 *
 * Cosmetic by construction: `contract-signature.ts` projects only
 * id/min/max/curve/defaultValue/units, so the ROSTER cannot move
 * `contract-lock.txt`. The `curve` can and does — reviewed in that diff.
 *
 * The card's own private `SYNC_POS` array is gone; it maps this roster instead,
 * so the three names have exactly one copy.
 */
export const MOOG921B_SYNC_OPTIONS: readonly ParamOption[] = [
  { value: -1, label: 'LO', title: 'soft sync — a rising edge nudges the phase only past the half-cycle' },
  { value: 0, label: 'OFF', title: 'the sync input is ignored' },
  { value: 1, label: 'HI', title: 'hard sync — every rising edge resets the phase to 0' },
];

export const moog921bDef: AudioModuleDef = {
  type: 'moog921b',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '921b osc',
  category: 'sources',

  // Chain-role (Design-D declarative override): a DECLARED source. Its audio
  // inputs (dc_mod / ac_mod / sync) are MODULATION, not a signal-chain insert,
  // so the workflow column classifier treats it as a head-eligible SOURCE, not FX.
  chainWiring: { role: 'source' },

  inputs: [
    // freq_bus + width_bus are audio-rate CONTROL INPUTS from the 921A (the
    // worklet reads them per-sample), not CV→AudioParam routings — no cvScale
    // (PASSTHROUGH_BY_DESIGN). They have no paramTarget (no matching knob —
    // they ARE the slave pitch/width, supplied by the master driver).
    { id: 'freq_bus',  type: 'cv' },
    { id: 'width_bus', type: 'cv' },
    // DC + AC MODULATE — audio-rate linear-FM inputs.
    { id: 'dc_mod', type: 'audio' },
    { id: 'ac_mod', type: 'audio' },
    { id: 'sync',   type: 'audio' },
  ],
  outputs: [
    { id: 'sine',     type: 'audio' },
    { id: 'triangle', type: 'audio' },
    { id: 'saw',      type: 'audio' },
    { id: 'rect',     type: 'audio' },
  ],
  params: [
    { id: 'fine',      label: 'Freq',  defaultValue: 0, min: -12, max: 12, curve: 'linear', units: 'st' },
    { id: 'range',     label: 'Range', defaultValue: 0, min: -5,  max: 5,  curve: 'discrete', units: 'oct' },
    { id: 'modAmount', label: 'FM',    defaultValue: 0, min: -1,  max: 1,  curve: 'linear' },
    { id: 'syncMode',  label: 'Sync',  defaultValue: 0, min: -1,  max: 1,  curve: 'discrete', options: MOOG921B_SYNC_OPTIONS },
    { id: 'level',     label: 'Level', defaultValue: 1, min: 0,   max: 2,  curve: 'linear' },
  ],

  // THE FACE — the 921A's other half. Every design note about the PAIR lives on
  // `moog921aDef.face` and in `$lib/ui/modules/moog921-face-model`; this comment
  // carries only what is different here, because a second copy of the argument
  // is how the pair would drift.
  //
  // ── THE RANK IS PITCH AUTHORITY, THEN WHAT IS ALIVE AT SPAWN ───────────────
  //
  //   1 RANGE  ±5 octaves = ±6000 cents, the largest reach on the module and
  //            the reason a bank of 921Bs exists at all (stack one an octave
  //            over its siblings off the shared bus).
  //   2 FREQ   ±12 semitones = ±1200 cents, 5× less. The detune.
  //   3 LEVEL  unconditional — it scales ALL FOUR taps, ships at unity, and is
  //            the only control here that is audible with nothing patched.
  //   4 FM     ⚠ INERT AT SPAWN: `modAmount` defaults to 0, so BOTH linear-FM
  //            jacks are bit-exactly silent as delivered. It ranks on reach,
  //            not on liveness, and the `fm` readout prints `off` to say so.
  //   5 SYNC   DOUBLY inert: it defaults to `OFF`, and even at either extreme
  //            it does nothing without a source on the sync input.
  //
  // Tier ladder: mini = RANGE; compact = RANGE + FREQ beside the trace; plate
  // and dock = all five plus the hero.
  //
  // ── NO PAGES ───────────────────────────────────────────────────────────────
  // Five controls, one of which the hero promotes. Splitting the remaining four
  // into `tune` / `modulation` / `out` bands would buy ~243 px of headers on a
  // dock that folds at 720p for one, two and one cell — and the three ideas are
  // already named by the readouts (`offset` / `fm` + `sync` / `out`).
  face: {
    order: ['range', 'fine', 'level', 'modAmount', 'syncMode'],

    // ⚠ IT RESOLVES, AND IT RESOLVES TO ONE TAP OF FOUR — SAY WHICH.
    // `primaryAudioOutPortId` takes the FIRST `type: 'audio'` output, and this
    // def declares sine, triangle, saw, rect in that order, so `glyphBinding`
    // returns `{ kind: 'live-audio', portId: 'sine' }` and the trace is THE SINE
    // TAP ONLY. The other three are not drawn and a narrow rect or a bright saw
    // will not change this picture (#1692's finding is a glyph that resolves to
    // nothing; the sibling failure is a glyph that resolves to the wrong thing,
    // which is only visible if someone states which thing). The 921A, whose
    // outputs are both `cv`, correctly declares `glyph: 'none'`. Asserted for
    // both modules, with a negative control, in moog921-face-model.test.ts.
    //
    // ⚠ THIS IS A FREE-RUNNING VOICE — it sounds the instant it spawns, with no
    // gate and no note to wait for — so its lane tile EXERCISES #1420's
    // pre-frame audio freeze rather than being indifferent to it, like
    // analogVco and macrooscillator and unlike most of the roster. See the
    // roster note in e2e/vrt/_shell-faces.
    glyph: 'scope',

    // THE HERO: the coarse octave dial, plus the five numbers this module
    // publishes that none of its knobs can print. Each is negative-controlled
    // PERMANENTLY on the input a knob readback is blind to
    // (moog921-face-model.test.ts), and the five have DISJOINT reach — `pitch`
    // and `offset` move on RANGE+FREQ, `out` on LEVEL alone, `fm` on FM alone,
    // `sync` on SYNC alone — so each is the others' control on every run:
    //
    //   pitch   what it sings with the bus AT REST: 261.626 · 2^(range + fine/12).
    //           A join over TWO dials plus the C4 reference; neither dial prints it.
    //   offset  the same thing in the unit that ADDS to the 921A's `bus` volts.
    //           ⚠ THIS IS THE PAIRING SEAM. A `FaceReadoutValue` receives a param
    //           reader and nothing else, so this face is STRUCTURALLY unable to
    //           see `freq_bus` — it cannot print the played pitch at all. It
    //           prints its own term; the driver prints the other; they add.
    //   out     LEVEL is a 0..2 LINEAR multiplier, so its readback says `1.00`
    //           where the answer is `+0.0 dB` and `2.00` where it is `+6.0 dB`.
    //   fm      the ±Hz a full-scale modulator buys. `off` at the shipped depth.
    //   sync    the comparator's state through the DSP's own ±0.5 thresholds.
    hero: {
      control: 'range',
    },
  },

  docs: {
    explanation:
      "A clean-room recreation of the Moog 921B Oscillator — the slaved (sound-making) half of the System 55/35 two-part oscillator. It has NO 1V/oct jack of its own: its pitch comes from a 921A driver's FREQ BUS, so several 921Bs sharing one 921A play in unison and you tune the whole bank from the driver. Off one core it presents four fixed-level simultaneous waveform outputs — sine, triangle, saw, rectangular — clamped to 0.01 Hz at the bottom and to just under Nyquist at the top (23 520 Hz at a 48 kHz sample rate, 21 609 Hz at 44.1 kHz), with two linear-FM inputs (a DC-coupled and an AC/cap-coupled one) and a hard/soft sync input. The FREQ (fine) and RANGE (octave footage) knobs offset its pitch relative to the bus, so each 921B in a bank can be detuned or octave-shifted off the shared pitch. Mental model: a 921 VCO whose pitch is fed by the bus instead of a knob, built for stacked unison/detune voices. WHAT IT SINGS IS A SUM OF TWO PANELS AND NEITHER ONE CAN SHOW YOU THE ANSWER: 261.626 Hz x 2^(bus volts + range + fine/12), where the bus volts come from the 921A's FREQUENCY pot times its RANGE compass and this module contributes only the offset. Its faceplate prints that offset in octaves and the pitch it would sing with the bus at rest; the driver's faceplate prints the volts it is sending; the two terms add. Everything else on this panel is asleep as delivered — FM ships at 0, so both linear-FM jacks are silent until it is raised, and SYNC ships OFF — which is why the faceplate prints their state rather than their dial position.",
    inputs: {
      freq_bus:
        "1V/oct pitch CV from a 921A driver's freq bus (0 = C4) — this is how the 921B gets its pitch. Patch the driver's FREQ BUS output here; the FREQ + RANGE knobs offset on top of it.",
      width_bus:
        "Pulse-width CV from a 921A driver's width bus; sets the rectangular output's duty cycle (the sine, triangle and saw taps ignore it). It normals to 0.5 — a 50% square — and the normal is decided by the VALUE on the cable rather than by whether a cable is there: anything at or below 0.02 is treated as 'nothing patched'. So a fully patched driver sitting at its WIDTH minimum gets the same 50% square as no cable at all, and the duty jumps straight from 50% to 2% just above that. See issue #1791.",
      dc_mod:
        "DC-coupled linear FM input: added to the frequency in Hz and scaled by the FM knob. Because it is DC-coupled, a steady offset here shifts the pitch (good for envelope-to-pitch), and audio here gives linear FM.",
      ac_mod:
        "AC-coupled (cap-coupled) linear FM input: a DC-blocking high-pass runs first, so a DC offset on the modulator does NOT bend the pitch — only its alternating content modulates. Scaled by the FM knob; use it for vibrato/FM that won't drift the tuning.",
      sync:
        "External sync source: each rising edge resets (hard) or nudges (soft) the oscillator's phase per the SYNC switch, locking it to the incoming signal for hard-sync sweeps.",
    },
    outputs: {
      sine: "The pure sine tap (fixed level), the fundamental with no harmonics. It is also the tap the faceplate's live glyph traces — the shell binds to the FIRST audio output a module declares, so the little waveform on the tile is the sine and never the saw, triangle or rect.",
      triangle: "The triangle tap (fixed level) — soft and hollow, gentler than the saw.",
      saw: "The band-limited sawtooth tap (fixed level) — the brightest, all-harmonics waveform.",
      rect: "The rectangular / pulse tap (fixed level); its duty cycle follows the width bus (50% when unpatched).",
    },
    controls: {
      fine: "FREQ — a ±12-semitone (2-octave) fine tuning offset applied on top of the bus pitch, for detuning this 921B against others in the bank. ±1200 cents, five times less reach than RANGE.",
      range: "RANGE — octave footage, a discrete ±5-octave coarse offset on top of the bus pitch, to stack a 921B an octave (or several) above/below its siblings. ±6000 cents: the largest authority on the module, which is why the faceplate promotes it. RANGE and FREQ land in the SAME exponent as the pitch bus, so the pitch this module sings is 261.626 Hz x 2^(bus volts + range + fine/12) — the faceplate's `pitch` readout is that expression with the bus at rest, and `offset` is the term this module contributes to it.",
      modAmount: "FM — linear-FM depth, ±1, shared by both the DC and AC modulate inputs. At the shipped 0 BOTH FM jacks are bit-exactly silent, so patching one changes nothing until this is turned up; the faceplate's `fm` readout prints `off` there and the ±Hz swing a full-scale modulator buys otherwise.",
      syncMode: "SYNC switch: LO = soft sync (a gentle phase nudge), OFF = the sync input is ignored, HI = hard sync (a full phase reset on each rising edge of the sync input). It is a three-position switch rather than a dial — the DSP compares against ±0.5, so there is nothing between the detents.",
      level: "Output gain on every waveform tap, 0 to 2 (1 = unity) — the 921B's built-in VCA. It is a LINEAR multiplier, so its own value reads 1.00 at unity where the faceplate\'s `out` readout says 0.0 dB, and 2.00 at the top where that is +6.0 dB.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'moog921b', {
      numberOfInputs: 5,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // 921 VCO / 904A / analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);
    silence.connect(workletNode, 0, 2);
    silence.connect(workletNode, 0, 3);
    silence.connect(workletNode, 0, 4);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog921bDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['freq_bus',  { node: workletNode, input: 0 }],
        ['width_bus', { node: workletNode, input: 1 }],
        ['dc_mod',    { node: workletNode, input: 2 }],
        ['ac_mod',    { node: workletNode, input: 3 }],
        ['sync',      { node: workletNode, input: 4 }],
      ]),
      outputs: new Map([
        ['sine',     { node: workletNode, output: 0 }],
        ['triangle', { node: workletNode, output: 1 }],
        ['saw',      { node: workletNode, output: 2 }],
        ['rect',     { node: workletNode, output: 3 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
