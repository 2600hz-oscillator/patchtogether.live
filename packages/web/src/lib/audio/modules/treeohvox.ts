// packages/web/src/lib/audio/modules/treeohvox.ts
//
// TREE.oh.VOX — TB-303 voice slice. Web Audio factory + module def.
// The audio worklet (packages/dsp/src/treeohvox.ts) owns all DSP; this
// file wires the 10 input ports + 1 output + 6 AudioParams.
//
// Algorithmic source: Robin Schmidt's Open303 (MIT,
// https://github.com/RobinSchmidt/Open303). License is MIT — fully
// compatible with this repo's AGPL-3 (one-way MIT → AGPL relicense, per
// the relicense memo from PR Resume 2026-05-19).
//
// The voice slice ports rosic::TeeBeeFilter (TB_303 mode), rosic::Decay-
// Envelope, a simplified AR rosic::AnalogEnvelope, and the BlendOscillator
// (replaced with polyBLEP saw — see the lib's header for the rationale).
// The full 404 module — sequencer, transpose, slide, waveform-switch,
// accent/slide step buttons, TD-3 smiley — is a follow-up task.
//
// Input port layout (audio-rate node connections):
//   pitch_in    → input 0  (V/oct, summed into voice's pitch)
//   gate_in     → input 1  (0/1 GATE: rising edge = note on, falling = note off)
//   accent_in   → input 2  (0/1, latched at the gate edge to flag accent)
//   tune_cv     → input 3  (CV → tune AudioParam)
//   cutoff_cv   → input 4  (CV → cutoff AudioParam)
//   res_cv      → input 5  (CV → resonance AudioParam)
//   env_cv      → input 6  (CV → envelope AudioParam)
//   decay_cv    → input 7  (CV → decay AudioParam)
//   accent_cv   → input 8  (CV → accent AudioParam)
//
// Output port layout:
//   audio_out   → output 0 (mono)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/treeohvox.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
// The canonical gate levels/edges, never re-derived here — see
// $lib/audio/gate-trigger for why the numbers live in one place.
import { closeGate, openGate } from '$lib/audio/gate-trigger';
const PROCESSOR_NAME = 'treeohvox';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const treeohvoxDef: AudioModuleDef = {
  type: 'treeohvox',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'tree.oh.vox',
  category: 'sources',
  ossAttribution: { author: 'Robin Schmidt (Open303, MIT)' },

  inputs: [
    // Audio-rate node ports — pitch / gate / accent ride on dedicated
    // input slots so the worklet can read them without going through an
    // AudioParam (an AudioParam would smooth across the gate edge and
    // smear retriggers).
    { id: 'pitch_in',  type: 'pitch' },
    // BOTH are level-sensitive, so both declare `edge: 'gate'`:
    //   gate_in   — the rising edge starts the note, the FALLING EDGE ENDS IT.
    //               The falling edge used to be unread, so gate length was
    //               ignored outright (a 10 ms gate and a 1 s gate rendered
    //               byte-identical audio). It is a gate, and now it behaves
    //               like one.
    //   accent_in — read as a LEVEL at the moment gate_in rises, not as an
    //               edge of its own.
    { id: 'gate_in',   type: 'gate', edge: 'gate' },
    { id: 'accent_in', type: 'gate', edge: 'gate' },
    // CV inputs targeting AudioParams. Linear cvScale = sum-into-param;
    // matches the rest of the rack's convention for knob CV.
    { id: 'tune_cv',     type: 'cv', paramTarget: 'tune',      cvScale: { mode: 'linear' } },
    { id: 'cutoff_cv',   type: 'cv', paramTarget: 'cutoff',    cvScale: { mode: 'linear' } },
    { id: 'res_cv',      type: 'cv', paramTarget: 'resonance', cvScale: { mode: 'linear' } },
    { id: 'env_cv',      type: 'cv', paramTarget: 'envelope',  cvScale: { mode: 'linear' } },
    { id: 'decay_cv',    type: 'cv', paramTarget: 'decay',     cvScale: { mode: 'linear' } },
    { id: 'accent_cv',   type: 'cv', paramTarget: 'accent',    cvScale: { mode: 'linear' } },
    { id: 'waveform_cv', type: 'cv', paramTarget: 'waveform',  cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio_out', type: 'audio' },
  ],
  params: [
    // TUNE — ±12 semitones from V/oct input. Default 0.
    { id: 'tune',      label: 'Tune',     defaultValue: 0,    min: -12,  max: 12,    curve: 'linear', units: 'st' },
    // CUTOFF — 40 Hz .. 6 kHz log taper, default 1 kHz (Open303 default).
    // The aggressive 6 kHz ceiling is the 303 character; modern filters
    // push to 20 kHz but the 303 polynomial approx + post chain assume
    // a much lower top end.
    // ⚠ THESE TWO NUMBERS ARE NOT FREE-TYPED. They must equal
    // TB303_CUTOFF_FLOOR_HZ / TB303_CUTOFF_CEILING_HZ in
    // packages/dsp/src/lib/treeohvox-dsp.ts — the ladder clamps to the floor,
    // so a def offering travel below it is a DEAD CONTROL (it was: the ladder
    // clamped at 200 Hz while the knob started at 40, and the bottom ~25 % of
    // the travel was bit-exactly dead). treeohvox-range-source.test.ts joins
    // the def, the AudioParam descriptor and the DSP constant.
    { id: 'cutoff',    label: 'Cutoff',   defaultValue: 1000, min: 40,   max: 6000,  curve: 'log',    units: 'Hz' },
    // RESONANCE — 0..1 raw; the worklet skews it exponentially to match
    // Open303's resonanceSkewed math.
    { id: 'resonance', label: 'Reso',     defaultValue: 0.5,  min: 0,    max: 1,     curve: 'linear' },
    // ENVELOPE — env-mod depth on cutoff. 0..1 maps to 0..100% in
    // Open303's calculateEnvModScalerAndOffset terms.
    { id: 'envelope',  label: 'EnvMod',   defaultValue: 0.5,  min: 0,    max: 1,     curve: 'linear' },
    // DECAY — filter envelope decay time. 200 ms .. 2 s is the canonical
    // 303 range (Open303 normalDecay default is 1 s; Devil Fish mod
    // extends to 3 s — we cap at 3 s so DECAY can sweep into doom-y
    // sustained territory without losing the 303 feel).
    { id: 'decay',     label: 'Decay',    defaultValue: 600,  min: 50,   max: 3000,  curve: 'log',    units: 'ms' },
    // ACCENT — accent-amount. 0 = identical to non-accent; 1 = full
    // boost on both amp peak + filter env contribution. Default 0.5
    // — the brief specifies this as a tasteful starting position; 303
    // hardware accent is a single boolean on/off, this knob makes the
    // depth controllable.
    { id: 'accent',    label: 'Accent',   defaultValue: 0.5,  min: 0,    max: 1,     curve: 'linear' },
    // WAVEFORM — morphs the BlendOscillator: 0 = saw (classic 303), 1 = square.
    // Open303's BlendOscillator crossfades SAW303↔SQR303; default 0 keeps the
    // canonical saw voice (and existing ART baselines) unchanged.
    { id: 'waveform',  label: 'Wave',     defaultValue: 0,    min: 0,    max: 1,     curve: 'linear' },
  ],

  // ── THE AUDITION (one member). MEASURED, not assumed: with nothing patched
  // and every one of the twenty-five pressables on the card clicked, `audio_out`
  // peaked at exactly 0.000e+0 over 145 frames, while the SAME analyser read
  // 3.390e-1 the moment a sequencer gate reached `gate_in` (#1658). This is the
  // rings/sixstrum class — a voice with no internal exciter and no surface that
  // can excite it — and this family is the fix.
  //
  // ⚠ TO WHOEVER AUTHORS THE FACEPLATE (queue Q3). This pad reaches the dock
  // ONLY because treeohvox has no curated `face` yet: with none, the dock
  // full-view renders the legacy card (measured — `dock-full-view` contains one
  // `.mod-card`). The moment a `face` lands, the dock renders THAT instead and
  // this pad disappears from the dock unless the face ranks a gate cell of its
  // own — a `kind: 'action'`, `mode: 'gate'` entry in shell-cells.ts calling
  // `setManualGate`, exactly like meowbox's. THAT IS THE SIXSTRUM DEFECT
  // VERBATIM: its card's STRUM button always worked while `?shell=1` offered
  // twenty controls over an instrument that could not be sounded, because the
  // face was authored without the audition. `e2e/tests/treeohvox-strike.spec.ts`
  // asserts the dock surface can sound the voice, so it goes RED if the face
  // lands without one — do not "fix" that by re-pointing the test at the card.
  controlFamilies: [
    { id: 'treeohvox-gate', label: 'Gate — hold to sound the voice', kind: 'other', testidPrefix: 'treeohvox-gate' },
  ],

  docs: {
    explanation:
      "A TB-303 acid-bass voice in one card: a band-limited saw↔square oscillator into the classic 303 ladder-style resonant low-pass, with the cutoff swept by a snappy decay envelope. It's a port of Robin Schmidt's Open303, so the squelch, the resonance scream, and the accent boost behave like the real 303 voice. Play it from a pitch + gate source (a sequencer, keyboard, or MIDI lane): the gate's rising edge starts the note and its falling edge ends it (so gate length is note length), and the dedicated ACCENT gate latches an accent on that note for the louder, brighter, more resonant 303 accent character. This card is the VOICE only — the full 303 sequencer/slide/transpose lives in the planned 404 module.",
    inputs: {
      pitch_in: "1V/oct pitch input — patch a sequencer or keyboard pitch CV here to set the note; the Tune knob adds a ±12-semitone offset on top.",
      gate_in: "The note gate, and it is a GATE, not a trigger: the rising edge starts the note (amplitude + filter envelopes) and the FALLING edge ends it, so how long you hold the gate is how long the note lasts. Patch a sequencer/clock gate here. If you hold the gate longer than the 303's fixed VCA decay (~1.2 s) the note fades out under you anyway — that is the hardware's behaviour. Retriggering while a note is still sounding glides into the new note instead of cutting it, so overlapping steps stay click-free.",
      accent_in: "The accent gate, latched at the moment the note gate fires: when it's high on a note, that note gets the 303 accent — louder, with extra filter-envelope drive for the signature accented squelch. Drive it from a sequencer's accent lane.",
      tune_cv: "CV that adds to the Tune knob, shifting pitch in semitones (on top of the 1V/oct input).",
      cutoff_cv: "CV that adds to the Cutoff knob — the classic patch point for an LFO or envelope filter-sweep.",
      res_cv: "CV that adds to the Resonance knob, pushing the filter toward self-oscillating scream.",
      env_cv: "CV that adds to the EnvMod knob, controlling how hard the envelope drives the cutoff.",
      decay_cv: "CV that adds to the Decay knob, lengthening or shortening the filter-envelope sweep.",
      accent_cv: "CV that adds to the Accent knob, scaling how strong an accented note's boost is.",
      waveform_cv: "CV that adds to the Wave knob, morphing the oscillator between saw and square.",
    },
    outputs: {
      audio_out: "The mono 303 voice — oscillator through the resonant filter and amp envelope. Patch into a distortion/overdrive for a dirtier acid line, or straight to a mixer.",
    },
    controls: {
      tune: "Coarse tune in semitones (-12 to +12), added to the 1V/oct pitch input — for transposing the line or tuning to a track.",
      cutoff: "The filter corner frequency (40 Hz–6 kHz, log): the main timbre control. The 303 deliberately tops out around 6 kHz for its dark, focused voice; the filter envelope sweeps up from wherever you set this. The WHOLE travel is live — the bottom of the knob really does reach a 40 Hz corner, which with EnvMod low is a near-sub-audible thump.",
      resonance: "Filter resonance/emphasis (0..1): low for a round bass, high for the whistling 303 squelch that nearly self-oscillates.",
      envelope: "Env-mod depth (0..1): how far the filter envelope pushes the cutoff up on each note — 0 is a static filter, high values give the dramatic per-note sweep.",
      decay: "FILTER-envelope decay time (50 ms–3 s, log) — how fast the cutoff falls back after each note: short for tight blips, long for slow sweeps; the canonical 303 range sits around 200 ms–2 s, extended here into doom-y territory. Like the hardware DECAY knob it shapes the TIMBRE, not the note's length — the note lasts as long as you hold the GATE.",
      accent: "Accent amount (0..1): how much louder and brighter an accented note (one whose ACCENT gate is high) gets — 0 makes accents identical to normal notes, 1 is the full 303 accent boost.",
      waveform: "Morphs the oscillator from saw (0, the classic 303 voice) to square (1) and every blend between. The morph is monotone — the fundamental only ever gets stronger as you turn it up — so there is no dead spot or octave jump anywhere in the travel.",
      'treeohvox-gate-{n}': "HOLD to play a note with nothing patched in — it is exactly the GATE input held high, so the note starts when you press, lasts as long as you hold, and ends when you let go, and a real patched gate keeps working alongside it. Without a gate source this voice makes no sound at all, so this is how you hear what the seven knobs are doing before you patch anything. The pitch is whatever PITCH is fed (0 V, i.e. the base note, when nothing is patched), offset by TUNE.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 9 input slots: 3 audio-rate (pitch/gate/accent) + 6 CV-into-param.
    // The CV inputs are wired to AudioParams, but the AudioWorkletNode
    // still needs a numberOfInputs count that covers the audio-rate
    // signals. Web Audio routes the CV connections through the
    // AudioParam regardless of the input count; pitch/gate/accent need
    // genuine input slots since the worklet's process() reads
    // inputs[0..2].
    const workletNode = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      outputChannelCount: [1],
    });

    // Silence-pump on the audio inputs so the worklet keeps decoding
    // (matches the videobox fix from PR #301). Without this an unpatched
    // TREE.oh.VOX wouldn't render reliably on Safari — process() is
    // skipped when an input has no source and outputs are unconnected.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);
    silence.connect(workletNode, 0, 2);

    // ── THE MANUAL GATE. A dedicated ConstantSource summed into the SAME
    // worklet input a cable feeds (input 1 = `gate_in`): Web Audio sums
    // connections and the processor edge-detects the 0.5 crossing per sample
    // (packages/dsp/src/treeohvox.ts), so this works ALONGSIDE a patched
    // sequencer rather than instead of it. It writes nothing to the graph — no
    // param moves, nothing persists, nothing syncs, nothing lands on the undo
    // stack — which is exactly why the observable is the audition ledger and
    // `readParam` is structurally blind to it.
    //
    // ⚠ A SEPARATE SOURCE FROM `silence`, deliberately. `silence` fans out to
    // inputs 0/1/2 to keep the worklet decoding; driving ITS offset would also
    // drive PITCH and ACCENT, so every audition would transpose the voice and
    // latch an accent.
    const gateCs = ctx.createConstantSource();
    gateCs.offset.value = 0;
    gateCs.start();
    gateCs.connect(workletNode, 0, 1);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of treeohvoxDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['pitch_in',  { node: workletNode, input: 0 }],
        ['gate_in',   { node: workletNode, input: 1 }],
        ['accent_in', { node: workletNode, input: 2 }],
        // CV-into-AudioParam ports use `input: 0` as a placeholder; the
        // engine uses the `param` field to do the real wiring via
        // `source.connect(param)`, never `source.connect(node, 0, n)`.
        // This mirrors the resofilter factory exactly.
        ['tune_cv',     { node: workletNode, input: 0, param: params.get('tune')! }],
        ['cutoff_cv',   { node: workletNode, input: 0, param: params.get('cutoff')! }],
        ['res_cv',      { node: workletNode, input: 0, param: params.get('resonance')! }],
        ['env_cv',      { node: workletNode, input: 0, param: params.get('envelope')! }],
        ['decay_cv',    { node: workletNode, input: 0, param: params.get('decay')! }],
        ['accent_cv',   { node: workletNode, input: 0, param: params.get('accent')! }],
        ['waveform_cv', { node: workletNode, input: 0, param: params.get('waveform')! }],
      ]),
      outputs: new Map([
        ['audio_out', { node: workletNode, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      // The AUDITION seam — the shared karplus/meowbox `read(key)` idiom.
      //
      // ⚠ `manualGate` ONLY, and the OMISSION of `manualTrigger` is
      // load-bearing. `resolveManualStrike` and `resolveManualGate` are two
      // separate read keys precisely so a handle implementing one does not
      // silently answer the other (ui/modules/manual-strike-actions.ts). THE
      // SHAPE IS THE DEF'S, NOT A PREFERENCE: `gate_in` declares `edge: 'gate'`
      // and the processor acts on BOTH edges — rising starts the note, FALLING
      // ends it, so gate length IS note length. The shared one-shot is a 5 ms
      // pulse (TRIGGER_PULSE_S), which would end every auditioned note 5 ms
      // after it began. A caller asking for `manualTrigger` here gets
      // `undefined` and the ledger records `delivered: false` — the honest
      // answer, and distinguishable from a press that never happened.
      read(key: string): unknown {
        if (key === 'manualGate') {
          return (high: boolean) => {
            try {
              if (high) openGate(gateCs, ctx.currentTime);
              else closeGate(gateCs, ctx.currentTime);
            } catch { /* the context went away with the node */ }
          };
        }
        return undefined;
      },
      dispose() {
        // ⚠ CLOSE THE GATE BEFORE STOPPING ITS SOURCE. A node deleted mid-hold
        // is one of the release edges the pad itself can never see (its button
        // unmounts with the card), and a gate left open is a note that never
        // ends — see ui/modules/manual-gate-latch.ts.
        try { closeGate(gateCs, ctx.currentTime); } catch { /* */ }
        try { silence.stop(); } catch { /* */ }
        try { silence.disconnect(); } catch { /* */ }
        try { gateCs.stop(); } catch { /* */ }
        try { gateCs.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
