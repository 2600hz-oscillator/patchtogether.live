// packages/web/src/lib/audio/modules/drummergirl.ts
//
// DRUMMERGIRL — gate-triggered all-in-one synth drum voice. One module,
// one voice — fire a gate, hear a drum hit shaped by pitch / tone /
// shape / volume / decay. Stands alone in the palette for plain
// drum-machine / percussion-voice use. Faust-compiled DSP (packages/dsp/src/
// drummergirl.dsp): a pitched body oscillator + a noise/transient
// shaper crossfaded by `shape`, with `tone` modulating the body
// timbre, gain-shaped by an internal AD envelope set by `decay`.
//
// Inputs:
//   gate (gate): rising edge fires one drum hit.
//   pitch (cv, linear, paramTarget=pitch): displaces the pitch knob (±36 semi).
//   tone (cv, linear, paramTarget=tone): displaces tone (body timbre).
//   shape (cv, linear, paramTarget=shape): displaces the body/noise crossfade.
//   volume (cv, linear, paramTarget=volume): displaces the per-hit gain (0..2).
//   decay (cv, log, paramTarget=decay): scales the envelope decay symmetrically.
//
// Outputs:
//   audio (audio): the drum hit waveform.
//
// Params:
//   pitch (linear -36..36 semi, default 0): body-oscillator transposition.
//   tone (linear 0..1, default 0.3): body-timbre macro.
//   shape (linear 0..1, default 0.3): crossfade body ↔ noise/transient.
//   volume (linear 0..2, default 1.0): per-hit output gain.
//   decay (log 0.001..0.5 s, default 0.15): AD envelope decay.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/drummergirl.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/drummergirl.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/drummergirl.worklet.js?url';

const PARAM_PREFIX = '/DRUMMERGIRL';

export const drummergirlDef: AudioModuleDef = {
  type: 'drummergirl',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'drummergirl',
  category: 'sources',
  // `volume` (0-2.0) and `decay` (0.001-0.5s, log) params are backfilled from
  // factory defaults on load, so no migration callback (or version bump) is needed.
  inputs: [
    { id: 'gate',   type: 'gate', edge: 'gate' },
    // CV scaling per docs/adr/004-cv-range-convention.md.
    // pitch: linear (-36..+36 semi; cv=±1 sweeps ±36 semi from knob center).
    // tone/shape: linear (already 0..1 native).
    // volume: linear (0..2; cv=±1 sweeps ±1.0 from knob).
    // decay: log (0.001..0.5s).
    { id: 'pitch',  type: 'cv', paramTarget: 'pitch',  cvScale: { mode: 'linear' } },
    { id: 'tone',   type: 'cv', paramTarget: 'tone',   cvScale: { mode: 'linear' } },
    { id: 'shape',  type: 'cv', paramTarget: 'shape',  cvScale: { mode: 'linear' } },
    { id: 'volume', type: 'cv', paramTarget: 'volume', cvScale: { mode: 'linear' } },
    { id: 'decay',  type: 'cv', paramTarget: 'decay',  cvScale: { mode: 'log' } },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'pitch',  label: 'Pitch',  defaultValue: 0,    min: -36,    max: 36,  curve: 'linear', units: 'semi' },
    { id: 'tone',   label: 'Tone',   defaultValue: 0.3,  min: 0,      max: 1,   curve: 'linear' },
    { id: 'shape',  label: 'Shape',  defaultValue: 0.3,  min: 0,      max: 1,   curve: 'linear' },
    { id: 'volume', label: 'Volume', defaultValue: 1.0,  min: 0,      max: 2.0, curve: 'linear' },
    { id: 'decay',  label: 'Decay',  defaultValue: 0.15, min: 0.001,  max: 0.5, curve: 'log',    units: 's' },
  ],

  // ⚠ NO HERO PICTURE AND NO AUDITION PAD IN THIS PR, AND BOTH ARE STRUCTURAL
  // RATHER THAN ARBITRARY. They are ONE decision, because a hero `panel` needs
  // a sixth rankable key to exist:
  //
  //   * `module-face-lint` refuses a PANEL cell SELECTED at a lane tier ("a
  //     380px panel in a 46px knob column"), and the 'full' lane cap is SIX.
  //     drummergirl has FIVE params, so a picture at rank 6 is selected into
  //     the plate and is illegal — the only legal ranking puts an audition at
  //     6 and the picture at 7.
  //   * The audition itself must be a HELD gate, not a one-shot: `en.adsr` is
  //     LEVEL-sensitive here (it holds at `sustainOf(shape)` while the gate is
  //     high and releases only when the gate reaches 0), and the shared
  //     `TRIGGER_PULSE_S` is 5 ms — which releases the envelope ~4 ms into a
  //     150 ms decay and would audition a ~40 ms blip rather than the 186 ms
  //     hit any sequencer produces.
  //   * Shipping THAT needs a factory `manualGate` seam, a
  //     `manual-strike-wiring` roster line, AND a card pad to satisfy the
  //     control-family testid grep — and the card pad moves drummergirl's
  //     REQUIRED `vrt-strict` baseline on BOTH platforms, which cannot be
  //     regenerated locally.
  //
  // So the pair is deferred to its own PR rather than half-landed here. The
  // face below carries its whole thesis without them: the five derived
  // readouts and the 16-row preset roster ARE the unbundling of `shape`.

  // ── FACE — RACKLINE UI curation + the PF-20 faceplate structure. UI metadata,
  // NOT the I/O contract (see ModuleFace in $lib/graph/types).
  //
  // THE FACE HAS EXACTLY ONE JOB: UNBUNDLE `shape`.
  // drummergirl is not a drum machine — it is ONE sine, ONE noise source, ONE
  // amplitude ADSR and ONE pitch ADSR (`process(gate) = mixed(gate) * env(gate)
  // * volumeKnob`, drummergirl.dsp:84). Four of its five knobs do one thing
  // each. The fifth, SHAPE, indexes five 16-entry tables through a linear
  // crossfade between two neighbouring presets (:27-45, :48-57), so ONE fader
  // moves FIVE independent quantities at once: the amp envelope's attack,
  // sustain and release, plus the pitch sweep's DEPTH *and* its DURATION. No
  // surface in the rack says so.
  //
  // AND THE HEADLINE FACT: AT THE SHIPPED DEFAULT THE PITCH SWEEP IS ZERO.
  // shape 0.30 → shapeIdx 4.5 → seg 4 / seg2 5 / frac 0.5, and `sweepAt` is
  // 0.0 at BOTH 4 and 5 (:44), so line :69 multiplies by zero. Index 6 is 0.0
  // too — the default sits in the middle of a THREE-WIDE dead zone, so nudging
  // the fader either way does not wake the sweep up. The module's most
  // characteristic behaviour is off out of the box and nothing tells you. The
  // hero prints it as `0 st`, and the preset roster shows three adjacent rows
  // reading `0 st` so it needs no sentence at all.
  //
  // RANKING. The five params in the order a player reaches for them: shape =
  // the identity; tone = the single largest timbral lever, the sine ↔ noise
  // crossfade at :74; pitch = the register; decay = the tail; volume = the
  // trim. All five reach every lane tier's plate, so ranks 1-5 only decide the
  // mini/compact tile.
  //
  // TWO BANDS, AND THE REASON IS STRUCTURAL. `face.hero` PROMOTES (does not
  // copy) SHAPE out of whichever band declares it, and `heroFacePlan` DROPS a
  // band the promotion empties — taking its `hint` with it, which then fails
  // the annotation-reachability clause. So SHAPE is declared in the band it
  // genuinely belongs to — it *is* the amp envelope's A, S and R (:77, :79,
  // :80) — which keeps [decay, volume] behind after the split.
  //
  // glyph 'scope': the module has a primary audio output, so `glyphBinding`
  // resolves it to the live trace (the kickdrum precedent for a struck voice).
  // 'envelope' would NOT work — `env-params` requires params literally named
  // attack/decay/sustain/release and this def has only `decay`, so it would
  // silently fall through to a dead `static` trace.
  face: {
    order: [
      // The five params, in the order a player reaches for them. There is no
      // rank 6: this face declares no non-param control (see the note above).
      'shape', 'tone', 'pitch', 'decay', 'volume',
    ],
    pages: [
      {
        id: 'source',
        label: '1 · source — sine ↔ noise',
        hint:
          'TONE is a straight crossfade and the only thing that changes what the voice is made of: ' +
          '1 is a pure sine, 0 is pure noise, and the shipped 0.30 is 70 percent noise. PITCH tunes ' +
          'the sine alone, in semitones from C2 (65.4 Hz) — the noise has no pitch to tune.',
        controls: ['tone', 'pitch'],
      },
      {
        // ⚠ THE PROMOTED KEYS ARE DECLARED HERE AND THEY MUST BE: `face.hero`
        // can only MOVE a key some band already claims, and a promoted key left
        // off the pages falls into the defensive `__unpaged` band instead.
        // After the split this band renders [decay, volume].
        id: 'amp',
        label: '2 · amp envelope · level',
        hint:
          'SHAPE sets this envelope’s attack, sustain and release; the DECAY knob replaces the ' +
          'preset decay for the AMPLITUDE only. The pitch sweep keeps its own decay, from SHAPE — ' +
          'so turning DECAY never moves the sweep, in either depth or duration.',
        controls: ['shape', 'decay', 'volume'],
      },
    ],
    glyph: 'scope',

    // ⚠ `title` AND `hint` ARE BOTH ANNOTATION AND BOTH GATED — `facePageHeader`
    // returns null with the switch off, title included. At rest this faceplate
    // paints its NAME (the dock title bar), its bands and its numbers, and
    // nothing else. Everything prose below is opt-in, which is exactly why it
    // can afford to be this technical.
    title: 'Voice',
    hint:
      'One sine and one noise source, crossfaded by TONE, through one amplitude envelope. SHAPE is ' +
      'not a knob — it is a morph across 16 percussion presets that moves the attack, the sustain, ' +
      'the release, the pitch sweep’s DEPTH and the pitch sweep’s DURATION, all at once. At the ' +
      'shipped 0.30 that sweep is zero, and it is zero for three presets either side.',

    // THE HERO. SHAPE is PROMOTED out of band 2, not copied (heroFacePlan
    // removes it, so the param multiset faces-parity asserts is unchanged), and
    // it leads because it IS the module. With no `cell` the shell keeps its
    // plain `scope` glyph band at the dock.
    hero: {
      control: 'shape',
    },
  },

  docs: {
    explanation:
      "A one-shot synth drum voice: fire a gate and it plays a single percussion hit. Mental model — a pitched body oscillator crossfaded against a noise/transient layer, gain-shaped by an internal attack/decay envelope, so one module covers everything from a tuned tom or kick to a noisy snare or hat. There is no separate trigger and tone path to wire: pitch, tone, shape, level, and decay are all on the faceplate (and CV-modulatable), and the gate edge is the only thing you have to patch.",
    inputs: {
      gate: "A rising edge fires one drum hit and restarts the internal amplitude envelope — patch a sequencer gate, a clock, or any pulse here. It is a GATE, not a pure one-shot: the envelope is a real ADSR that holds at the shape's sustain level while the level stays high and only releases on the falling edge. Nine of the sixteen shapes sustain at zero, so for those the hit length really is Decay's alone and the gate's width does not matter; the other seven (sustain 0.02–0.5) will hold the body under a held gate, so on those shapes gate LENGTH is audible as well. Drive it from short pulses for consistent one-shots.",
      pitch: "CV that adds to the Pitch fader (bipolar, ±1 sweeps the full ±36-semitone range from the knob's center), so an LFO or sequencer can re-tune the body per hit; sampled at the gate edge that fires the note.",
      tone: "CV that adds to the Tone fader, brightening or darkening the body timbre as it moves.",
      shape: "CV that adds to the Shape fader, sliding the hit between its pitched-body and noise/transient extremes for accents or fills.",
      volume: "CV that adds to the Volume fader (±1 sweeps ±1.0 of gain), for per-hit accent/velocity dynamics.",
      decay: "CV that scales the envelope Decay time (logarithmic), shortening or lengthening the tail of each hit.",
    },
    outputs: {
      audio: "The mono drum-hit waveform — the body oscillator and noise layer summed and shaped by the amplitude envelope. Patch into a mixer, a bus, or further FX.",
    },
    controls: {
      pitch: "Tunes the body oscillator in semitones (-36 to +36 from its base), turning the same voice into a deep kick, a mid tom, or a high blip; the Pitch CV input adds on top of this.",
      tone: "The body-timbre macro (0..1): shifts the oscillator's brightness/character from dark and round toward bright and edgy.",
      shape: "Crossfades the hit between its pitched body and its noise/transient layer (0 = mostly body, 1 = mostly noise) — low for toms/kicks, high for snares/hats.",
      volume: "Per-hit output gain from silence to 2x, used to set the voice's level in a kit or to drive accents.",
      decay: "Sets the attack/decay envelope's decay time (1 ms to 0.5 s, log-tapered), so the hit goes from a tight click to a long boom; the Decay CV input scales this.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'drummergirl', wasmUrl, metaUrl, workletUrl }, node);
    // Single audio-rate input (gate). Use a 1-channel merger with silence so
    // the worklet stays active even with nothing patched in.
    const merger = ctx.createChannelMerger(1);
    merger.connect(f);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of drummergirlDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pPitch  = params.get(`${PARAM_PREFIX}/pitch`);
    const pTone   = params.get(`${PARAM_PREFIX}/tone`);
    const pShape  = params.get(`${PARAM_PREFIX}/shape`);
    const pVolume = params.get(`${PARAM_PREFIX}/volume`);
    const pDecay  = params.get(`${PARAM_PREFIX}/decay`);

    return {
      domain: 'audio',
      inputs: new Map([
        ['gate',   { node: merger, input: 0 }],
        ['pitch',  { node: f, input: 0, param: pPitch! }],
        ['tone',   { node: f, input: 0, param: pTone! }],
        ['shape',  { node: f, input: 0, param: pShape! }],
        ['volume', { node: f, input: 0, param: pVolume! }],
        ['decay',  { node: f, input: 0, param: pDecay! }],
      ]),
      outputs: new Map([['audio', { node: f, output: 0 }]]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        merger.disconnect();
        f.disconnect();
      },
    };
  },
};
