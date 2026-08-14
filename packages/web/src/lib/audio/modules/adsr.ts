// packages/web/src/lib/audio/modules/adsr.ts
//
// ADSR — classic attack/decay/sustain/release envelope generator.
//
// Gate-driven unipolar 0..1 envelope. Rising gate opens the attack stage;
// the envelope decays to the sustain level while the gate is held; the
// gate falling triggers the release stage back to 0. All segments are
// LINEAR ramps (Faust stdlib en.adsr — see packages/dsp/src/adsr.dsp).
// All four stage params respond to CV input scaled per the project
// CV-range standard (see docs/adr/004-cv-range-convention.md):
// attack/decay/release use log scaling so cv=±1 multiplies/divides the
// stage time by 100x (two decades either way); sustain uses linear
// because the param is already 0..1 native. An inverted envelope output
// (1 - env) makes ducking / sidechain-style modulation a one-cable patch.
//
// Inputs:
//   gate (gate, edge='gate'): drives the envelope. Rising edge = attack; the
//     level is HELD at sustain while the gate stays high; falling edge =
//     release. Level-sensitive on both edges — the textbook `gate` consumer
//     (see $lib/audio/gate-trigger), never an edge-only trigger.
//   attack (cv, log, paramTarget=attack): scales the attack-time param symmetrically.
//   decay (cv, log, paramTarget=decay): scales the decay-time param symmetrically.
//   sustain (cv, linear, paramTarget=sustain): displaces the sustain level (0..1).
//   release (cv, log, paramTarget=release): scales the release-time param symmetrically.
//
// Outputs:
//   env (cv): the envelope, 0..1.
//   env_inv (cv): 1 - env — the inverted envelope for ducking / sidechain use.
//
// Params (each carries a `format` so the dial shows the unit the value is
// actually in — 5 ms, 220 ms, 1.20 s; see $lib/audio/adsr-stage-format):
//   attack (log 0.001..10s, default 0.005): attack time in seconds.
//   decay (log 0.001..10s, default 0.1): decay time in seconds.
//   sustain (linear 0..1, default 0.7): held level after decay.
//   release (log 0.001..10s, default 0.3): release time in seconds.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import { formatStageTime, formatSustainLevel } from '$lib/audio/adsr-stage-format';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/adsr.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/adsr.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/adsr.worklet.js?url';

const PARAM_PREFIX = '/ADSR';

export const adsrDef: AudioModuleDef = {
  type: 'adsr',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'adsr',
  category: 'modulation',
  inputs: [
    // edge: 'gate' — DECLARED, not inferred. This port is LEVEL-SENSITIVE on
    // both edges (rising = attack, held = sustain hold, falling = release), the
    // textbook `gate` consumer of $lib/audio/gate-trigger's vocabulary, and its
    // own doc has said so in prose since day one. Without the declaration the
    // rear card renders no ▬ glyph and no edge legend on this module's ONLY
    // input band — the one hole a patcher has to get right.
    { id: 'gate',    type: 'gate', edge: 'gate' },
    // CV inputs route to the corresponding AudioParam, with engine-level
    // scaling (cvScale) so a -1..+1 LFO sweeps each param's full natural
    // range centered on the user's knob position. See
    // docs/adr/004-cv-range-convention.md. Without scaling, an LFO would
    // touch only ~10% of attack/decay/release (0.001-10s log range).
    //
    // attack/decay/release use log scaling: knob × (max/min)^(cv/2) so cv=±1
    // multiplies the time constant by sqrt(10000) = 100× — symmetrical in
    // log space. Default knob 0.005s × 100 = 0.5s; cv=-1 → 0.005/100 = 50µs
    // (clamped to 1ms = the param's min). Plenty of motion for either way.
    //
    // sustain is unipolar 0..1 — linear scaling sweeps the full range.
    { id: 'attack',  type: 'cv', paramTarget: 'attack',  cvScale: { mode: 'log' } },
    { id: 'decay',   type: 'cv', paramTarget: 'decay',   cvScale: { mode: 'log' } },
    { id: 'sustain', type: 'cv', paramTarget: 'sustain', cvScale: { mode: 'linear' } },
    { id: 'release', type: 'cv', paramTarget: 'release', cvScale: { mode: 'log' } },
  ],
  outputs: [
    { id: 'env',     type: 'cv' },
    // Inverted envelope: 1 - env. Standard Eurorack semantic for unipolar
    // envelopes — ducking, reverse-modulation, "sidechain"-style ADSR.
    // Implemented as ConstantSource(+1) + GainNode(-1)·env, summed.
    { id: 'env_inv', type: 'cv' },
  ],
  // `format` (PF-3) earns each dial a PERSISTENT readout, which is what the
  // dock mock's stage strip shows (8 ms / 220 ms / 0.62 / 480 ms). It is not
  // decoration: KnobConic's fallback formatter bottoms out at two decimals, so
  // a LOG 0.001..10 s time prints its own DEFAULT (0.005) as "0.01 s" and
  // collapses the entire 1–9 ms decade — the difference between a click and a
  // pluck, and a third of the dial's travel — onto "0.00 s"/"0.01 s". The law
  // lives in ONE pure place ($lib/audio/adsr-stage-format), unit-tested there.
  // Cosmetic exactly like `label`: `format` is a FUNCTION, so it is
  // structurally unserializable and can never reach the contract projection.
  params: [
    { id: 'attack',  label: 'A', defaultValue: 0.005, min: 0.001, max: 10, curve: 'log', units: 's', format: formatStageTime },
    { id: 'decay',   label: 'D', defaultValue: 0.1,   min: 0.001, max: 10, curve: 'log', units: 's', format: formatStageTime },
    { id: 'sustain', label: 'S', defaultValue: 0.7,   min: 0,     max: 1,  curve: 'linear',          format: formatSustainLevel },
    { id: 'release', label: 'R', defaultValue: 0.3,   min: 0.001, max: 10, curve: 'log', units: 's', format: formatStageTime },
  ],

  // UI CURATION (RACKLINE face) — a DESIGNED rework, not a transcription of the
  // old card. Dock spec: the gallery mock's `adsr` faceplate — one big live
  // contour over four stage controls, no tab rail, no sidebar ("the deliberate
  // minimal end of the kit; one clear job"). The 'envelope' glyph carries the
  // module's identity at every tier that has room for it.
  //
  // `order` IS A PRIORITY RANKING; `pages` IS FUNCTION ORDER. They answer
  // different questions and are ALLOWED to disagree — do not "fix" one to match
  // the other. `order` decides what the tiers showing a SUBSET show (mini 1 /
  // compact 2 beside a glyph / plate up to 6); `pages` decides the reading
  // order of the tier that shows EVERYTHING.
  //
  // WHY RELEASE OUTRANKS ATTACK — the one non-obvious call, and it is
  // structural rather than a preference:
  //   * RELEASE is the ONLY stage that applies unconditionally. Its own doc
  //     says so: "it applies even when the gate drops mid-attack". Every other
  //     stage can be skipped outright by the gate that drives it.
  //   * Under the rack's CANONICAL TRIGGER the attack is already over.
  //     TRIGGER_PULSE_S ($lib/audio/gate-trigger) is 0.005 s — EXACTLY this
  //     module's attack default — so a trigger-driven note peaks at the instant
  //     the gate falls, decay never runs, and the whole audible envelope IS the
  //     release.
  //   * DECAY ranks LAST because it is the most conditional of the four:
  //     `sustain` defaults to 0.7, so decay travels only 0.3 of the range, and
  //     at sustain 1.0 it does nothing at all.
  //   ⚠ TASTE CALL. The counter — "attack is the most-played envelope control"
  //     — is real for a swell-oriented amp EG driven by HELD gates, and it is
  //     what this face shipped with. The revert is ONE line: swap 'release' and
  //     'attack' in `order`. Nothing else in the file moves.
  //
  // The tier ladder, read back as a sentence: mini = RELEASE + the contour;
  // compact = RELEASE + ATTACK + the contour; the full-in-lane tier shows all
  // four stages and NO glyph (4 cells ⇒ 2 plate rows ⇒ laneBodyPlan's
  // `glyph = hasGlyph && rows <= 1` drops it in-lane — priced in; the dock hero
  // still carries it); the dock shows everything.
  face: {
    order: ['release', 'attack', 'sustain', 'decay'],
    pages: [
      // ONE page — the mock's single stage strip. Controls stay in canonical
      // A/D/S/R order, DELIBERATELY not `face.order`: a page shows all four at
      // once, and the only sane order for all four is the order they run in.
      // The LABEL carries what the mock put in a sub-tag the shell has no slot
      // for — that a gate DRIVES these four, in this sequence. The old label
      // ('stages') only restated the page id.
      {
        id: 'stages',
        label: 'gate → attack · decay · sustain · release',
        controls: ['attack', 'decay', 'sustain', 'release'],
      },
    ],
    glyph: 'envelope',
    // REAR CARD curation (rear-card-model) — the flip-side jack field.
    //  * The leading band is this module's DRIVE input, and an envelope is not
    //    a voice: it is labeled 'gate' so the field reads gate → stages →
    //    outputs, which is exactly the signal path.
    //  * The 'stages' band is PINNED (a curated group whose id matches the page
    //    id claims that page's slot, and its label wins) for one reason: the
    //    band label otherwise INHERITS the dock page label, and "gate → attack ·
    //    decay · sustain · release" is right on the front — where the gate is a
    //    real input — and wrong on the rear, where it would head a band that
    //    holds four CV holes and no gate. Same four holes, canonical A/D/S/R
    //    order, split into two clusters by CV LAW — the one thing the rear can
    //    teach that the front cannot. The param labels are single letters
    //    (A/D/S/R), so the cluster headers are
    //    also what tells you WHICH of the four holes is a level: ATTACK/DECAY/
    //    RELEASE are log-scaled TIME jacks (±1 V = ×100 / ÷100 of the knob
    //    time), SUSTAIN is a linear LEVEL displacement (±0.5 of the 0..1 span).
    //  * No `~` ticks: the gate drives the Faust worklet's audio input, and the
    //    four CVs land on smoothed AudioParams — nothing here is an audio-rate
    //    modulation destination (contrast tidyVco's per-sample filter CVs).
    rear: {
      groups: [
        { id: 'voice', label: 'gate', ports: ['gate'] },
        { id: 'stages', label: 'stage cv', ports: ['attack', 'decay', 'sustain', 'release'] },
      ],
      clusters: [
        { group: 'stages', label: 'times', ports: ['attack', 'decay', 'release'] },
        { group: 'stages', label: 'level', ports: ['sustain'] },
      ],
    },
  },

  docs: {
    explanation: "A classic gate-driven envelope generator: a held gate ramps the level from 0 up to peak (1.0) over the attack time, falls to the sustain level over the decay time, holds there for as long as the gate stays high, then fades back to zero over the release time when the gate drops. All the timed stages are straight linear ramps, and if the gate falls early (mid-attack or mid-decay) the level freezes where it is and the release fades from there. It outputs a unipolar 0..1 control signal (env) plus its inverse (env_inv = 1 - env) for ducking; patch either into any CV input (a VCA's gain, a filter's cutoff) to shape that destination over the life of each note.",
    inputs: {
      gate: "The note signal that drives the whole envelope: a rising edge (gate goes high) starts the attack stage, the level then decays to and holds at the sustain level WHILE the gate stays high (this input is level-sensitive, not just edge-triggered), and the falling edge (gate goes low) starts the release stage back to 0 — from wherever the level currently is, even mid-attack. Re-gating is a hard retrigger: a new rising edge snaps the output back to 0 and ramps the attack again from zero, it does NOT continue from the level it was at.",
      attack: "CV that modulates the attack time: a -1..+1 signal scales it symmetrically in log time around your set value — ±1 multiplies or divides the time by 100x (two decades either way, clamped to the 1 ms..10 s range) — so an LFO here sweeps the attack from snap to swell centered on the control.",
      decay: "CV that modulates the decay time the same way — a -1..+1 signal scales it symmetrically in log time (±1 = 100x faster or slower, two decades either way) around your set value, clamped to 1 ms..10 s.",
      sustain: "CV that displaces the sustain level — linear, since the param is already a native 0..1 level: ±1 pushes the held level up or down by up to half the range (±0.5) around your set value, clamped to 0..1.",
      release: "CV that modulates the release time — a -1..+1 signal scales it symmetrically in log time (±1 = 100x faster or slower, two decades either way) around your set value, clamped to 1 ms..10 s.",
    },
    outputs: {
      env: "The envelope itself as a unipolar 0..1 control signal — 0 at rest, ramping linearly to 1 at the attack peak, holding at the sustain level while gated, then fading to 0 on release. Patch into a VCA gain, filter cutoff, or any CV destination to shape it over each note.",
      env_inv: "The inverted envelope, 1 - env: it sits at 1 at rest and dips toward 0 as the envelope rises (full env peak = 0 out). Patch into a VCA or filter to duck / reverse-modulate that destination on every note, sidechain-style.",
    },
    controls: {
      attack: "How long the envelope takes to ramp from 0 to its peak (1.0) after the gate goes high — 1 ms up to 10 s on a log-scaled control, so most of the travel lives in the short, snappy times. The first stage of the contour: short reads as a click or pluck, long as a slow swell.",
      decay: "How long the envelope takes to fall from the peak down to the sustain level once the attack finishes — 1 ms to 10 s, log-scaled. Has no audible effect if sustain is at 1.0 (there is nothing to decay to).",
      sustain: "The level the envelope holds for as long as the gate stays high, after attack and decay complete — 0 (no hold, decays all the way to silence) up to 1.0 (holds at full peak). A level, not a time — the only linear control of the four stages.",
      release: "How long the envelope takes to fade from wherever it currently is back to 0 once the gate goes low — 1 ms to 10 s, log-scaled. The note's tail; it applies even when the gate drops mid-attack.",
    },
  },
  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'adsr', wasmUrl, metaUrl, workletUrl }, node);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of adsrDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pAttack  = params.get(`${PARAM_PREFIX}/attack`);
    const pDecay   = params.get(`${PARAM_PREFIX}/decay`);
    const pSustain = params.get(`${PARAM_PREFIX}/sustain`);
    const pRelease = params.get(`${PARAM_PREFIX}/release`);

    // ----- env_inv: 1 - env -----
    // Build (one + neg(env)) via two GainNodes sharing a sum bus.
    //   one    = ConstantSource(+1) → invBus (gain 1)
    //   negEnv = env (Faust output) → GainNode(-1) → invBus (gain 1)
    //   invBus output = 1 + (-env) = 1 - env  (clamped to 0..1 since env ∈ [0, 1])
    //
    // The ConstantSource lives for the lifetime of the module. invBus's
    // output is registered as the env_inv source.
    const oneSrc = ctx.createConstantSource();
    oneSrc.offset.value = 1;
    oneSrc.start();
    const invBus = ctx.createGain();
    invBus.gain.value = 1;
    const negEnv = ctx.createGain();
    negEnv.gain.value = -1;
    oneSrc.connect(invBus);
    f.connect(negEnv);
    negEnv.connect(invBus);

    return {
      domain: 'audio',
      inputs: new Map([
        ['gate',    { node: f, input: 0 }],
        // CV → AudioParam routing. The engine recognizes `param` and uses
        // sout.node.connect(param) instead of node-to-node.
        ['attack',  { node: f, input: 0, param: pAttack! }],
        ['decay',   { node: f, input: 0, param: pDecay! }],
        ['sustain', { node: f, input: 0, param: pSustain! }],
        ['release', { node: f, input: 0, param: pRelease! }],
      ]),
      outputs: new Map([
        ['env',     { node: f,      output: 0 }],
        ['env_inv', { node: invBus, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { oneSrc.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        oneSrc.disconnect();
        invBus.disconnect();
        negEnv.disconnect();
        f.disconnect();
      },
    };
  },
};
