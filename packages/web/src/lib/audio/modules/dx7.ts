// packages/web/src/lib/audio/modules/dx7.ts
//
// DX7-style FM synth module. Pure-TypeScript 6-op AudioWorklet (no Plaits
// dependency). See packages/dsp/src/dx7.ts for the worklet, and
// packages/web/src/lib/audio/dx7-syx.ts for the SYX bank parser.
//
// I/O:
//   inputs:
//     poly      — polyPitchGate (16 lanes of pitch+gate = 32 channels; this
//                 module reads the first `voiceCount` ≤ 5). Preferred.
//     pitch_cv  — mono V/oct (legacy single-voice use).
//     gate      — mono gate  (legacy single-voice use).
//   outputs:
//     out       — mono audio.
//
// Params:
//   algorithm   — 1..32 (DX7 algorithm; quantized; editable at any time).
//                 NOT an AudioParam on the worklet — the host bridge posts the
//                 NON-DESTRUCTIVE `{type:'algorithm'}` message when the knob
//                 moves, so turning it re-wires the routing on the next render
//                 block without disturbing a note you are holding. The
//                 setParam handler MUST check this branch before the
//                 AudioParam-lookup early-out (regression PR
//                 fix/dx7-algorithm-switching).
//   feedback    — 0..7 (the algorithm's single feedback-loop depth). Also NOT
//                 an AudioParam — same incremental-message treatment, same
//                 before-the-early-out requirement.
//   voiceCount  — 1..5 (poly limit). AudioParam.
//   level       — master output level. AudioParam.
//   transpose   — ±24 semitones. AudioParam.
//
// ==========================================================================
// THE AUTHORITY SPLIT — memorize this, it is the whole state design
// ==========================================================================
//   node.params.algorithm / node.params.feedback  are AUTHORITATIVE.
//   node.data.voice (the EDIT BUFFER) is authoritative for the other 78
//     operator values. Its OWN `algorithm`/`feedback` fields are a STAMP
//     SOURCE — read once when a preset is loaded, NEVER at send time.
//
// That "never at send time" is not a style rule. `sendVoice` injects the two
// PARAMS into the outgoing payload; posting `voice.feedback` instead would
// mean a rack-mate's operator tweak (which travels as a voiceRev bump, i.e. a
// whole-voice re-send) silently reverted YOUR feedback knob to whatever the
// stamped voice happened to store. Same bug class as reading the preset name
// instead of the params.
//
// The trade this buys, stated plainly: the operator values get no MIDI-learn,
// no CV, no automation lane and no per-value undo granularity. Operator
// editing is patch DESIGN, not performance.
//
// Data-side state (all Yjs-synced, all persisted by Hocuspocus snapshots and
// the .imp.json export envelope):
//   node.data.preset      — the ORIGIN voice name (a display label).
//   node.data.userPatches — DX7Voice[] imported from .syx cartridges.
//   node.data.voice       — the working EDIT BUFFER (plain JS, deep-unwrapped).
//   node.data.opOn        — boolean[6] operator mutes (edit-buffer only:
//                           SYX param 155 is not in a stored voice).
//   node.data.voiceRev    — monotonic revision, bumped by every panel edit.
//                           Still written and reported (`read('voiceRev')`),
//                           but NO LONGER the poll's change test: the rev is
//                           persisted per patch, so two patches can alias on
//                           (preset, voiceRev) with different buffers. The
//                           poll compares `dx7VoiceSignature` (content).
//
// The write side of all of that is `selectDx7Preset` in
// $lib/ui/modules/dx7-patch-actions.ts (ONE mutateNode transaction, so undo
// is one step and collab is one message). This file only READS it.
//
// WHICH MESSAGE THE POLL SENDS, and why the distinction is audible:
//   the preset NAME changed   → `{type:'patch'}`  — DESTRUCTIVE. Correct: the
//        player deliberately swapped the whole sound, so stale voice state
//        would sound wrong.
//   only the CONTENT changed  → `{type:'voice'}`  — NON-DESTRUCTIVE. This is
//        an operator edit (LOCAL OR REMOTE) or a same-name patch load.
//        `{type:'patch'}` here would mean a rack-mate nudging one operator
//        HARD-RETRIGGERS every note YOU are holding and chops every tail that
//        is ringing out (measured — see the protocol block in
//        packages/dsp/src/dx7.ts and dx7-messages.test.ts).
// Re-selecting the CURRENTLY loaded name is a revert: the buffer returns to
// the pristine voice while the name stands still, so it re-applies without
// stopping your notes (and an already-pristine buffer is a genuine no-op).
//
// Inputs:
//   poly (polyPitchGate): polyphonic pitch+gate (preferred — the cable carries
//     16 lanes; this module plays up to 5 of them).
//   pitch_cv (cv): mono V/oct (legacy single-voice route).
//   gate (gate): mono gate (legacy single-voice route).
//
// Outputs:
//   out (audio): mono mixed voice bus.
//
// Params:
//   algorithm (discrete 1..32, default 5): DX7 algorithm index (live-editable).
//   feedback (discrete 0..7, default 4): the algorithm's feedback-loop depth.
//   voiceCount (discrete 1..5, default 5): polyphony cap.
//   level (linear 0..2, default 0.7): output level.
//   transpose (linear -24..24 st, default 0): global transposition.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { DX7Voice } from '$lib/audio/dx7-syx';
import { DX7_BUILTIN_BANK, findBuiltinPatch } from '$lib/audio/dx7-banks';
import { deepUnwrapVoice } from '$lib/audio/dx7-voice-edit';
import { patch as livePatch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import workletUrl from '@patchtogether.live/dsp/dist/dx7.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const POLL_MS = 100;

// Track of which AudioContexts already have the worklet module loaded.
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Default preset for fresh modules. */
export const DX7_DEFAULT_PRESET = 'E.PIANO 1';

/**
 * Transaction origin for the boot-time param hydration (see
 * `hydrateParamsOnce`). Anything OTHER than `LOCAL_ORIGIN` is untracked by the
 * UndoManager, which is the point: a migration write must not land on the
 * user's Cmd-Z stack as though they had turned a knob. Exported so a test can
 * assert the write is genuinely non-undoable rather than trusting the string.
 */
export const DX7_MIGRATION_ORIGIN = 'dx7-param-hydration';

/**
 * The exact per-operator payload `sendVoice` posts across the worklet
 * boundary — ONE builder for both the outgoing message and the content
 * signature below, so a field added to the wire format cannot silently
 * escape the change detection (the drift a duplicated field list invites).
 *
 * Hand-built plain objects: `postMessage` structured-clones, and a Yjs proxy
 * throws "could not be cloned" (see the sendVoice doc block); primitives are
 * forced to plain numbers/booleans either way.
 */
function dx7WireOperators(voice: DX7Voice): Array<{
  r: [number, number, number, number];
  l: [number, number, number, number];
  ratio: number;
  detune: number;
  detuneFactor: number;
  level: number;
  fixedMode: boolean;
  velocitySens: number;
  fixedHz: number | undefined;
}> {
  return voice.operators.map((o) => ({
    r: [Number(o.r[0]), Number(o.r[1]), Number(o.r[2]), Number(o.r[3])] as [number, number, number, number],
    l: [Number(o.l[0]), Number(o.l[1]), Number(o.l[2]), Number(o.l[3])] as [number, number, number, number],
    ratio: Number(o.ratio),
    detune: Number(o.detune),
    detuneFactor: Number(o.detuneFactor),
    level: Number(o.level),
    fixedMode: Boolean(o.fixedMode),
    velocitySens: Number(o.velocitySens),
    // FIXED-mode frequency in Hz. Absent on patches saved before the
    // fixed-frequency fix — the worklet falls back to deriving it from
    // `ratio`, so send `undefined` rather than a bogus number.
    fixedHz: typeof o.fixedHz === 'number' ? Number(o.fixedHz) : undefined,
  }));
}

/**
 * CONTENT signature of a resolved edit buffer — what the factory's poll
 * compares to decide whether to re-send the voice to the worklet.
 *
 * ⚠ A CONTENT SIGNATURE, NOT `voiceRev`, and the difference is the samsloop
 * load-silence class (the warrensspectrum `wsBandsRev` fix, ported): the rev
 * counter is PERSISTED per patch, so two patches can both hold
 * `preset: 'E.PIANO 1', voiceRev: 3` with DIFFERENT edit buffers — loading
 * one over the other at a reused node id moved the voice while the
 * (name, rev) pair stood still, and the worklet kept playing the previous
 * patch's sound. Content cannot alias: identical strings mean identical wire
 * payloads, and re-sending an identical payload is a no-op anyway.
 *
 * Signs exactly what `sendVoice` posts FROM THE VOICE (name, operators,
 * transpose — via the shared `dx7WireOperators` builder). `algorithm` and
 * `feedback` are deliberately absent: they are params (the authority split at
 * the top of this file), the reconciler diffs params on every load, and
 * `setParam` posts its own incremental messages.
 *
 * Six operators, ~a dozen numbers each — built in microseconds, safe on the
 * 100 ms poll (the warrensspectrum precedent). `voiceRev` STAYS as a key (the
 * panels still bump it; `read('voiceRev')` still reports it) but nothing here
 * depends on it for change detection any more.
 *
 * Pure + exported so a unit test can pin the properties (distinct buffers
 * differ; a structural clone signs identically) without an AudioContext.
 */
export function dx7VoiceSignature(voice: DX7Voice): string {
  return JSON.stringify({
    name: String(voice.name ?? ''),
    transpose: Number(voice.transpose),
    operators: dx7WireOperators(voice),
  });
}

export const dx7Def: AudioModuleDef = {
  type: 'dx7',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'dx7',
  category: 'sources',

  inputs: [
    // poly: 10-channel polyPitchGate; lane i drives voice i.
    { id: 'poly',     type: 'polyPitchGate' },
    // mono fallbacks for legacy single-voice patching:
    { id: 'pitch_cv', type: 'cv' },
    // gate is LEVEL-SENSITIVE (declared edge: 'gate'): the worklet triggers a
    // note-on on the rising edge, holds the note while the level stays high
    // (and tracks pitch_cv for glides), and releases on the falling edge.
    { id: 'gate',     type: 'gate', edge: 'gate' },
  ],
  outputs: [
    { id: 'out', type: 'audio' },
  ],

  params: [
    { id: 'algorithm',  label: 'Algorithm',   defaultValue: 5,   min: 1,   max: 32, curve: 'discrete' },
    // FEEDBACK — the one continuous timbral control an FM player RIDES, which
    // is why it is a real ParamDef (MIDI-learn, automation, motorized
    // readback) while the other 78 operator values live in node.data.voice.
    // Default 4 = E.PIANO 1's stored value (dx7-banks.ts), so a fresh spawn is
    // bit-identical to the pre-param behaviour of loading the default preset.
    // NOT switch-shaped (0..1 discrete default 0), so `looksLikeSwitch` does
    // not claim it and no ACKNOWLEDGED_LATCHING entry is needed.
    { id: 'feedback',   label: 'Feedback',    defaultValue: 4,   min: 0,   max: 7,  curve: 'discrete' },
    { id: 'voiceCount', label: 'Voices',      defaultValue: 5,   min: 1,   max: 5,  curve: 'discrete' },
    { id: 'level',      label: 'Level',       defaultValue: 0.7, min: 0,   max: 2,  curve: 'linear' },
    { id: 'transpose',  label: 'Transpose',   defaultValue: 0,   min: -24, max: 24, curve: 'linear', units: 'st' },
    // Per-voice master OUTPUT-VCA ADSR (per-voice-ADSR feature) — a player-dialable
    // amplitude swell/long-release on top of the SYX operator EGs. The attack /
    // decay / sustain defaults are pass-through (instant open, sustain 1); the
    // RELEASE default (0.005 s time constant ⇒ the VCA closes in ~60 ms) is NOT —
    // it caps the patch's own operator tail. Documented as such in `docs.controls`;
    // changing the default would be an I/O-contract change (contract-lock).
    { id: 'attack',  label: 'Atk', defaultValue: 0.001, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'decay',   label: 'Dec', defaultValue: 0.1,   min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'sustain', label: 'Sus', defaultValue: 1,     min: 0,     max: 1, curve: 'linear' },
    { id: 'release', label: 'Rel', defaultValue: 0.005, min: 0.001, max: 5, curve: 'log', units: 's' },
  ],

  // ── RACKLINE face (P1 total-rework — UI curation only, NOT the I/O
  // contract; see ModuleFace in $lib/graph/types). Designed from what this
  // module ACTUALLY is: a PATCH-DRIVEN instrument. Every operator ratio,
  // level, 4-rate/4-level EG and the feedback depth are BAKED INTO THE LOADED
  // VOICE (a built-in patch or an imported .syx cartridge) — the panel's only
  // live timbral controls are which voice is loaded and which of the 32
  // algorithms wires its six operators. So the hero is the mock's hero:
  //   mini    (1) the PRESET selector — the one control that swaps the whole
  //               sound, next to a live trace of the FM timbre it produces.
  //   compact (2 cells + glyph) + FEEDBACK — the one continuous timbral
  //               control an FM player rides. (Rejected: ALGORITHM here. It
  //               would spend both compact cells on discrete selectors on a
  //               synth, and the glyph already carries the identity.)
  //   plate   (6 whole plate cells — laneBodyPlan's no-clip cap) adds
  //               algorithm, level, transpose and RELEASE: the master VCA's
  //               release is a CEILING on every patch's own tail (its 0.005 s
  //               default closes the VCA in well under 0.1 s), so it is the
  //               "why don't my bells ring" control. voiceCount is the one
  //               that drops out.
  //   ranks 7+ voiceCount, the rest of the master ADSR, and the .syx import —
  //               reachable in the dock faceplate, which renders EVERY control.
  // Pages are the dock's section bands, lowercase. The cartridge loader sits
  // WITH the selector — they are the same job, "get a voice in" — which is why
  // there is no longer a one-control 'cartridge' band. ALGORITHM moves onto
  // the 'operators' band beside FEEDBACK: the two of them ARE the wiring, and
  // dx7 PR 6 hangs the operator map + detail panel on that same band.
  // glyph 'scope' = a live trace of the played FM waveform (PR 4 replaces it
  // with the data-derived algorithm map).
  face: {
    order: [
      // the hero ladder (mini = 1 / compact = 2 cells + glyph / plate = 6)
      'dx7-preset-select-{n}',
      'feedback',
      'algorithm',
      'level',
      'transpose',
      'release',
      // dock tail — polyphony, the rest of the master envelope, then the import
      'voiceCount',
      'attack',
      'decay',
      'sustain',
      // PANELS — dock-only by the face-lint rule (PF-14). They rank BELOW the
      // lane budget deliberately: the six operators are patch DESIGN, so they
      // belong in the dock and nowhere else.
      'dx7-operator-map-{n}',
      'dx7-op-detail-{n}',
      'dx7-syx-input-{n}',
    ],
    pages: [
      // ⚠ THE PAGE ID IS 'patch', NOT 'voice', AND THAT IS LOAD-BEARING.
      // `rearFieldPlan` gives a curated rear group whose id is 'voice' or
      // 'signal' the LEADING band slot, and then walks `face.pages` claiming a
      // curated group with each page's id — so a page id that collides with
      // the leading group's id renders that band TWICE and the rear-derivation
      // totality gate goes red (`hole count 7 ≠ declared port count 4`; found
      // exactly that way). This module's rear curation already owns
      // `{ id: 'voice', label: 'note source' }`, so the page keeps a distinct
      // id and carries the user-facing word in its LABEL, which is the only
      // half anybody reads.
      { id: 'patch', label: 'voice', controls: ['dx7-preset-select-{n}', 'dx7-syx-input-{n}'] },
      // ONE band for the whole wiring + operator editor. `.page-controls` is
      // flex-wrap at a 10px column gap; at the 900px faceplate floor the usable
      // width is ~856px, so this lays out as row 1 = [ALG chip ~90][FEEDBACK
      // ~56][MAP 280] ≈ 446px, row 2 = [DETAIL 560]. Map and detail land on
      // ADJACENT ROWS — both visible at once, no tab switch. (Do NOT promise
      // side-by-side: 90+56+280+560 = 986 > 856.)
      { id: 'operators', label: 'algorithm · operators',
        controls: ['algorithm', 'feedback', 'dx7-operator-map-{n}', 'dx7-op-detail-{n}'] },
      { id: 'performance', label: 'performance', controls: ['voiceCount', 'transpose', 'level'] },
      { id: 'ampenv', label: 'master adsr', controls: ['attack', 'decay', 'sustain', 'release'] },
    ],
    // The face glyph is the ALGORITHM DIAGRAM, not a scope trace (dx7 PR 4).
    // A 40px trace of an FM patch looks the same for every voice and flatlines
    // whenever nothing is gated — which is most of the time you are looking at
    // a rack — whereas the routing shape identifies the patch at a glance and
    // is the only thing that shows which operators are carriers.
    glyph: 'algorithm',
    // The SHELL EXTENSION (#1512): the algorithm diagram is a bespoke dx7
    // component, so it plugs into the shell through the extension seam —
    // `$lib/ui/modules/dx7/shell-extension.ts` exports it at the `glyph`
    // slot and ModuleShell resolves it lazily from this id. Without this
    // declaration the 'algorithm' glyph has no picture (shell-extensions
    // lint enforces the pairing).
    extension: 'dx7',
    // ALGORITHM is a PICTURE-STATE param (PF-15): 32 wiring topologies whose
    // only readable presentation is the chart itself. `'grid'` gives it the
    // chip + portaled diagram picker, which is TIER-INDEPENDENT — the grid is
    // portaled out of the tile, so the full 32-cell chart is as reachable from
    // a 46px lane column as from the dock faceplate. No new param and no new
    // control family, so contract-lock does not move.
    paramCells: { algorithm: 'grid' },
    // REAR CARD curation (rear-card-model). This module has NO per-param CV
    // jacks — its three inputs are all note sources — so the derivation would
    // give one generic 'voice' band. The curation names that band by FUNCTION
    // and splits the legacy mono pair (PITCH CV + GATE, read only when POLY is
    // unpatched, and only ever on lane 1) into its own cluster so the rear
    // reads "poly bus, with a mono fallback" at a glance.
    // NO `audioRate` ticks: the worklet samples poly/pitch/gate ONCE per render
    // block (the first frame of each block is the note decision), so none of
    // these inputs is an audio-rate consumer.
    rear: {
      groups: [{ id: 'voice', label: 'note source', ports: ['poly', 'pitch_cv', 'gate'] }],
      clusters: [{ group: 'voice', label: 'mono (legacy)', ports: ['pitch_cv', 'gate'] }],
    },
  },

  docs: {
    explanation:
      "A 6-operator FM synthesizer modeled on the Yamaha DX7. Each of its six operators is a sine oscillator with its own frequency ratio (or a fixed frequency in Hz, where the coarse setting picks a decade — 1, 10, 100 or 1000 Hz — and the fine setting sweeps up to just under the next one, ignoring the played note entirely) and its own 4-rate/4-level DX7 envelope. That envelope is the DX7's own shape, not an ADSR: it idles at L4, climbs to L1 at rate R1, falls to L2 then to L3, and HOLDS at L3 for as long as the gate is high — so L3 is the sustain level and L4 is both where the envelope starts and where the release lands. Release times and decay times are linear in decibels, so a rate of 99 crosses the whole range in about 6 ms while a rate of 0 takes over five minutes, and an attack is roughly eight times faster than a decay set to the same number. Instead of filtering a rich waveform, operators modulate each other's phase — one of 32 fixed ALGORITHM wiring diagrams decides which operators are CARRIERS (summed to the output) and which are MODULATORS bending a carrier faster than you can hear, which is what sculpts FM's metallic, bell-like and electric-piano timbres. Every algorithm also carries exactly ONE feedback loop, whose depth is the FEEDBACK knob (loading a voice stamps that voice's stored depth onto it), and WHERE that loop sits is part of the algorithm: it is operator 6 feeding back into itself in most of them, but operator 2, 3, 4 or 5 in others, and in algorithms 4 and 6 it is a loop wrapping a whole stack (operator 4 back into 6, operator 5 back into 6) rather than a self-loop. That placement is often the only difference between two otherwise identically-wired algorithms — 1 and 2, or 26 and 27, route the same and sound different for exactly this reason. This is a PATCH-DRIVEN instrument: the ratios, levels, envelopes, feedback and stored transpose all come from the loaded voice — nine built-in patches written to evoke the classic factory sounds (E.PIANO 1, TUB BELLS, BRASS 1 …; they are original patches, not Yamaha's data), plus every voice of any .syx cartridge you import. The panel's live controls are therefore which voice is loaded, which algorithm wires it, how hard its feedback loop is driven, how it plays (polyphony, transpose, level) and a per-voice master ADSR layered over the patch's own operator envelopes. ALGORITHM and FEEDBACK are the two the engine applies incrementally — ride them under a held chord and nothing is retriggered or cut; loading a different VOICE is the destructive one. It plays up to 5 voices from the POLY bus — the first VOICES of that cable's 16 lanes — or monophonically from the PITCH CV + GATE pair. What a cartridge actually drives here: each operator's four envelope rates and levels, its frequency ratio (or fixed-frequency mode), its detune and its output level, plus the voice's algorithm, feedback depth and stored transpose. What it does NOT: the LFO and the pitch envelope are unpacked into the parsed voice but never sent to the engine, per-operator velocity sensitivity is sent and then ignored (nothing upstream carries velocity — the poly cable is pitch and gate only), and keyboard level scaling, rate scaling, amp-mod sensitivity and oscillator sync are not unpacked from the cartridge bytes at all.",
    inputs: {
      poly: "The polyphonic note source and the preferred way to play this synth: the 16-lane polyPitchGate cable (32 channels — a pitch and a gate per lane; patch POLYSEQZ, MIDI LANE, or another poly source here). DX7 has five voice slots, so only the first VOICES lanes are read and anything on lanes 6-16 is ignored. A rising gate on a lane triggers a fresh note-on at that lane's pitch, the falling gate releases it, and while a lane's gate stays high its pitch keeps being tracked so the note glides. A lane keeps its own voice for as long as its note lasts; when every voice slot is still busy a new note steals the oldest. Pitch and gate are sampled once per render block, so block-quantized sequencer writes land exactly.",
      pitch_cv: "Mono V/oct pitch for single-voice playing — read only when nothing is patched into POLY, and only for the first lane, so this route is monophonic. 0 V is middle C (C4) and 1 V is an octave; TRANSPOSE and the loaded patch's own stored transpose add on top.",
      gate: "Mono note-on/off gate for the single-voice (PITCH CV) route — level-sensitive, not edge-only: crossing above half a volt triggers a note-on, the note is held for as long as the level stays high (tracking PITCH CV, so it glides), and the falling edge releases it. Read only when nothing is patched into POLY; patch a keyboard or envelope gate here.",
    },
    outputs: {
      out: "Mono audio: every active voice's carrier operators summed, each voice scaled by its own master ADSR, then the whole bus scaled by LEVEL and by a fixed headroom trim of 0.4 so five voices sounding at once stay clear of clipping. Patch it into a VCA, filter, mixer, or straight to the output.",
    },
    controls: {
      // ⚠ THE LAST SENTENCES OF `algorithm` DESCRIBE THE HOST PATH, NOT THE
      // ENGINE'S CAPABILITY — keep them moving with the code. PR 1 added the
      // non-destructive `{type:'algorithm'}` message to the worklet but left
      // `setParam('algorithm')` on `sendPatch()`, so the doc it authored said
      // the knob retriggers held notes, which was TRUE at that commit. PR 5
      // (this one) rewired the knob onto the incremental message, so that
      // sentence became false and is re-authored here, in the SAME diff as the
      // rewiring. Docs never run ahead of behaviour, and never lag it either.
      //
      // What is STILL true, and is why the preset selector below keeps the
      // retrigger wording: a preset LOAD is deliberately destructive
      // (`{type:'patch'}`), and applyPatch zeroes `lastGate`, so a still-high
      // gate reads as a fresh rising edge on the very next block — a RETRIGGER,
      // not silence. Measured, not assumed — see dx7-messages.test.ts.
      //
      // MERGE NOTE (PR 0 ← main): the "AND which operator carries the feedback
      // loop" clause is PR 0's, and it is TRUE — the corrected table gives each
      // algorithm its own feedback operator instead of hardcoding op6.
      algorithm: "Which of the 32 DX7 algorithms wires the six operators together (1–32) — each one fixes both the carrier/modulator routing AND which operator carries the feedback loop, from the deep single-carrier stacks (16–18) through the classic 3-carrier electric-piano layouts (5) to the fully parallel additive organ (32, where all six operators are carriers). It is the biggest single shaper of a patch's character. Loading a preset stamps that voice's own stored algorithm onto this control; turning the knob afterwards overrides it, and the override is what the engine plays. Changing it is NON-DESTRUCTIVE — the engine re-binds its routing at the start of the next render block, so a note you are holding morphs into the new wiring instead of being cut off or re-attacked, and a tail that is ringing out keeps ringing. Sweep it while a chord is held; that is the point.",
      feedback: "How hard the algorithm's single feedback loop is driven, 0 to 7 — the one continuous timbral control an FM player rides, which is why it is a knob here while the operators' 78 values live in the loaded voice. WHERE the loop sits is fixed by the ALGORITHM (operator 6 into itself in most of them, but 2, 3, 4 or 5 in others, and in algorithms 4 and 6 a loop wrapping a whole stack) — this only sets its depth. Feeding an operator its own output enriches it toward a sawtooth and then, at the top of the range, into noise: on a modulator it is the fastest route from a clean bell to a metallic crash or a breath/hiss layer, and on a carrier it is the classic DX7 brass edge. 0 disables the loop entirely. Loading a preset stamps that voice's own stored depth here; turning the knob afterwards overrides it. Like ALGORITHM it is applied incrementally, so riding it under a held chord neither retriggers nor cuts anything.",
      voiceCount: "How many of the POLY cable's lanes are read, 1 to 5 — the cable itself carries 16, but DX7 has five voice slots and never looks past lane 5. Lanes above the setting are ignored, so 1 gives a strictly monophonic instrument (the same first lane the mono PITCH CV + GATE pair drives) and 5 lets full chords through. Five voice slots exist either way; a note arriving while all of them are still busy steals the oldest.",
      level: "Master output gain for the whole synth, 0 to 2 (0.7 default); it scales the summed voice bus feeding OUT. The fixed 0.4 headroom trim is applied on top of it either way, so LEVEL 1 is the knob's own unity rather than unity gain end to end.",
      transpose: "Global pitch offset in semitones (-24 to +24) added to every voice on top of the loaded patch's own stored transpose (BASS 1, for instance, already sits an octave down). It is continuous rather than stepped, so fractional settings detune the whole instrument. It is re-applied while a gate is held — turning it retunes sounding notes live — but a note already released keeps the pitch it ended on.",
      attack: "Master output-VCA attack, per voice, layered on top of the patch's own operator envelopes: a linear ramp to full level taking this long, 0.001 to 5 s. At the 0.001 s default the master VCA is open instantly, so you hear the patch's own attack; raise it for a swell. Retrigger is click-safe — a re-gated voice ramps up from wherever it was instead of resetting to zero.",
      decay: "Master-VCA decay: once the attack has reached full level, the master envelope slides exponentially toward SUSTAIN with this time constant (about 99 % of the way in five times the setting). With SUSTAIN at its default of 1 there is nothing to slide toward and this has no effect — lower SUSTAIN first to hear it.",
      sustain: "Master-VCA sustain level (0 to 1) — the level a held note settles at after attack and decay, kept until the gate falls. At the default of 1 the master VCA simply stays open, so the patch's own operator envelopes are what you hear.",
      release: "Master-VCA release after the gate falls: an exponential fade with this time constant. It acts as a CEILING on the patch's own tail — at the 0.005 s default the master VCA closes in well under a tenth of a second, cutting the long releases stored in bell and pad voices, so raise it (a second or more) when you want those tails to ring. The voice slot is freed only once both this envelope and the operator envelopes have faded out.",
      // Card controls with no param/family of their own — each declared as a
      // single-member control family below and keyed here as `<familyId>-{n}`.
      "dx7-preset-select-{n}": "The voice selector, and the single control that defines the sound: pick one of the nine built-in patches (E.PIANO 1, BASS 1, HARMONICA, STRINGS 1, MARIMBA, TUB BELLS, BRASS 1, CALLIOPE, WIRE LEAD) or, once you have imported a cartridge, any voice from it. Choosing a voice STAMPS it — its six operators, their envelopes and its stored transpose become the working voice, and its stored algorithm and feedback depth are written onto the ALGORITHM and FEEDBACK knobs, which jump to the patch's own values. The whole stamp is one edit, so a single undo puts the previous voice back. Unlike those two knobs, a voice load is DESTRUCTIVE: it re-sends the whole patch and resets every note, so one you are holding re-attacks from the start of its envelope and one already ringing out its release is cut short. Treat it as a between-notes control. Picking the voice that is already loaded is the REVERT — it restamps the pristine patch over your operator edits without stopping anything that is sounding.",
      "dx7-operator-map-{n}": "Operator map — the algorithm's wiring diagram, live. Each of the six tiles is one operator, placed exactly where the current ALGORITHM puts it: modulators above, carriers along the bottom. A horizontal CARRIER RAIL runs under the bottom row and every carrier drops onto it, which is what makes the output sum literal — the operators touching that rail are the ones you actually hear; everything above is bending a phase. Tile colour repeats the same information (carriers warm, modulators cool, an operator that is both purple) but the rail is the primary cue, so the map still reads correctly with any colour vision. Each tile also shows its resolved frequency (`×3.06`, or `FIX 220 Hz` for a fixed-frequency operator), a miniature of its envelope scaled by its output level — so a quiet operator draws a short curve and six tiles can be compared at a glance — and an ON/OFF dot. Clicking a tile selects it for the detail panel; clicking the dot mutes that operator without changing the selection, which is the fastest way to hear what one operator is contributing. Muting is per-rack state and is shared with everyone in the rackspace; which operator you have SELECTED is yours alone, so a collaborator editing OP 5 never yanks your panel.",
      "dx7-op-detail-{n}": "Operator detail — everything about the one operator selected in the map, in three rows. PITCH sets COARSE (0-31), FINE (0-99) and DETUNE (-7…+7) and prints the RESOLVED frequency they produce, because on this synth the raw bytes mean nothing on their own — coarse 1 / fine 0 is ×1.00, and the same coarse in fixed mode is a decade in Hz instead. ENVELOPE is the operator's own 4-rate/4-level DX7 curve, dragged directly: vertical is LEVEL, horizontal is the RATE of the segment arriving at that point, so dragging a point RIGHT makes that segment SLOWER. The other five operators' envelopes are ghosted behind the one you are editing, which is the only place you can compare envelopes across operators while changing one. The eight R/L numbers read out underneath, and COPY EG stamps this operator's envelope onto another. OUTPUT LEVEL is the operator's contribution, shown as both the raw 0-99 byte and its level in dB. The header carries the patch-safety cluster: a dirty marker (✱) once you have changed anything, REVERT to throw the edits away and reload the stored voice, STORE to save the edit buffer under a new 10-character name (an edited voice exists ONLY in the edit buffer until you store it — loading another preset discards it), and INIT for a bare single-carrier sine, which with operator muting is the canonical way to learn what FM actually does.",
      "dx7-syx-input-{n}": "Load .syx bank — import a real Yamaha DX7 cartridge dump. It accepts the standard 4104-byte 32-voice SysEx bank, a bare 4096-byte payload, or a single 128-byte packed voice; a bank's 32 voices are APPENDED to the selector (never replacing what is already there, so several cartridges can be stacked) and the first voice of the new bank is selected for you. A status line reports how many voices loaded plus a count of any warnings — a bad header byte or a checksum mismatch is warned about, not rejected; only a file whose SIZE matches none of the three shapes is refused outright. Imported voices ride in the module\'s data, so they are saved with the rack and reach everyone in the rackspace.",
    },
  },

  controlFamilies: [
    // Single static/dynamic card controls (a dropdown + a file button) with no
    // backing param. Declared as one-member families so the docs gate can key
    // authored prose to them; the testidPrefix is grep-verified against the card.
    { id: 'dx7-preset-select', label: 'Preset / voice selector', kind: 'other', testidPrefix: 'dx7-preset-select' },
    { id: 'dx7-syx-input',     label: 'Load .syx bank',          kind: 'other', testidPrefix: 'dx7-syx-input' },
    // The operator view (PR 6). `kind: 'cell'` for the map because it is a
    // grid of six addressable operator tiles; the detail panel is a bespoke
    // composite, so 'other'.
    { id: 'dx7-operator-map', label: 'Operator map', kind: 'cell',  testidPrefix: 'dx7-op-tile' },
    { id: 'dx7-op-detail',    label: 'Operator detail', kind: 'other', testidPrefix: 'dx7-op-detail' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = createWorkletNode(node, ctx, 'dx7', {
      // 3 inputs: poly (the 32-channel polyPitchGate cable) + pitch_cv (mono)
      // + gate (mono). Mono inputs are 1 channel each; the poly cable is
      // POLY_CHANNEL_PAIRS(16) × (pitch, gate) = 32 channels, of which this
      // worklet only ever reads the first 5 lanes (channels 0..9).
      // Web Audio honors per-input channelCount via the source's connection
      // shape (the engine connects the multi-channel source to input 0). The
      // worklet reads inputs[0][channel] for each lane, so no special config
      // needed here — channelCountMode on AudioWorkletNode defaults to
      // 'max' which lets multi-channel sources pass through cleanly.
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    } as AudioWorkletNodeOptions);

    // Apply initial param values. `algorithm` and `feedback` are NOT
    // AudioParams (they ride the message port) — skipping them here keeps this
    // loop honest rather than relying on `params.get()` quietly returning
    // undefined for two of the nine ids.
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of dx7Def.params) {
      if (def.id === 'algorithm' || def.id === 'feedback') continue; // applied via messages
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // ---------------- LIVE NODE READERS ----------------
    //
    // Deliberately duplicated from $lib/ui/modules/dx7-patch-actions.ts rather
    // than imported: that file lives under lib/ui and imports this one for
    // DX7_DEFAULT_PRESET, so importing it back would close an audio→ui→audio
    // cycle and drag the UI barrel into every ART/registry import of this def.
    // The duplication is four one-line readers, and dx7.test.ts's
    // "the factory and dx7EditVoice resolve the SAME buffer" case cross-checks
    // the two views on the same node — a duplicated reader that nothing
    // compares is exactly how two implementations drift apart, so the
    // two-sided contract gets a gate rather than a promise.
    function readUserPatches(): DX7Voice[] {
      const live = livePatch.nodes[node.id];
      const arr = (live?.data as Record<string, unknown> | undefined)?.userPatches;
      return Array.isArray(arr) ? (arr as DX7Voice[]) : [];
    }
    function readPresetName(): string {
      const live = livePatch.nodes[node.id];
      const p = (live?.data as Record<string, unknown> | undefined)?.preset;
      return typeof p === 'string' && p.length > 0 ? p : DX7_DEFAULT_PRESET;
    }
    /** The monotonic edit-buffer revision. MUST tolerate `undefined` — every
     *  rack saved before this PR has no `voiceRev` at all, and treating that
     *  as a change would re-send the whole patch on every 100 ms tick. */
    function readVoiceRev(): number {
      const live = livePatch.nodes[node.id];
      const v = (live?.data as Record<string, unknown> | undefined)?.voiceRev;
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    }
    function readLiveParam(id: string): number | undefined {
      const live = livePatch.nodes[node.id];
      const v = live?.params?.[id];
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    }

    function findPatch(name: string): DX7Voice {
      const user = readUserPatches();
      return (
        user.find((p) => p.name === name) ??
        findBuiltinPatch(name) ??
        DX7_BUILTIN_BANK[0]!
      );
    }

    /**
     * THE EDIT BUFFER — `data.voice`, or the origin preset when absent.
     *
     * THE MIGRATION IS THIS ONE `??`. Every rack saved before this PR has a
     * `data.preset` name and NO `data.voice`, so a factory that read
     * `data.voice` straight would boot every existing rack into an undefined
     * patch. Resolving on READ (rather than migrating on write) means opening
     * a saved rack never rewrites it, so the migration cannot corrupt
     * anything; the buffer reaches disk only when the user actually stamps a
     * preset. `deepUnwrapVoice` is mandatory either way — both sources can be
     * Yjs proxies.
     */
    function readVoice(): DX7Voice {
      const live = livePatch.nodes[node.id];
      const stored = (live?.data as Record<string, unknown> | undefined)?.voice;
      if (stored != null && typeof stored === 'object') return deepUnwrapVoice(stored);
      return deepUnwrapVoice(findPatch(readPresetName()));
    }

    const clampAlgo = (v: number): number => Math.max(1, Math.min(32, Math.round(v)));
    const clampFeedback = (v: number): number => Math.max(0, Math.min(7, Math.round(v)));

    let currentPresetName = readPresetName();
    let currentVoiceRev = readVoiceRev();
    // THE HOST SHADOWS. `algorithm` and `feedback` are NOT AudioParams, so
    // `params.get(id)` is undefined for both and `readParam` has nothing to
    // return without these. Deleting them breaks the motorized knob readback
    // AND the shell's param-cell drive, which both poll
    // readParam. They are updated on setParam AND on the stamp (via the poll,
    // which reads the params the stamp wrote). dx7.test.ts pins this.
    let currentAlgo = clampAlgo(node.params?.algorithm ?? findPatch(currentPresetName).algorithm);
    let currentFeedback = clampFeedback(
      node.params?.feedback ?? findPatch(currentPresetName).feedback,
    );

    /**
     * Post a whole voice.
     *
     * `kind: 'patch'` is the DESTRUCTIVE preset-LOAD message (it resets every
     * voice); `kind: 'voice'` is the identical payload applied WITHOUT a
     * reset, which is what a voiceRev bump — local or remote — must use.
     *
     * ⚠ `algorithm` AND `feedback` COME FROM THE PARAMS, NOT FROM THE VOICE.
     * The voice's own fields are a stamp source only (see the authority split
     * at the top of this file). Posting `voice.feedback` here is the shipped
     * bug this PR closes: every voiceRev bump would overwrite the player's
     * feedback knob with whatever the stamped patch stored.
     *
     * BUG-FIX (PR fix/dx7-syx-bank-loading): SYX-loaded voices live in the
     * SyncedStore (Yjs Y.Doc), so `node.data.userPatches[i]` is a Yjs PROXY —
     * the operators are Y.Map proxies and `op.r`/`op.l` are Y.Array proxies.
     * `port.postMessage` structured-clones, which throws "[object Array] could
     * not be cloned" on those, so the worklet never saw the new patch and kept
     * playing whatever it last received. We hand-build the payload (rather
     * than JSON-roundtripping the voice) so we stay explicit about which
     * fields cross the boundary and primitive arrays are forced to plain
     * Array<number>.
     */
    function sendVoice(voice: DX7Voice, kind: 'patch' | 'voice'): void {
      workletNode.port.postMessage({
        type: kind,
        voice: {
          name: String(voice.name ?? ''),
          algorithm: currentAlgo,
          feedback: currentFeedback,
          // The shared wire builder — also what dx7VoiceSignature signs, so
          // the poll's change detection and this payload cannot drift apart.
          operators: dx7WireOperators(voice),
          transpose: Number(voice.transpose),
        },
      });
    }

    // Initial send — the DESTRUCTIVE one, because a fresh node has no voices
    // to disturb. Uses the resolved edit buffer, so a rack saved with operator
    // edits boots into THOSE and not into the pristine preset.
    const bootVoice = readVoice();
    sendVoice(bootVoice, 'patch');
    let currentVoiceSig = dx7VoiceSignature(bootVoice);

    /**
     * HYDRATE the two authoritative params from the loaded voice when the
     * saved rack has no value for them — required, or every rack saved before
     * this PR boots WRONG.
     *
     * An old node carries `data.preset = 'BASS 1'` with no `params.feedback`
     * and often no `params.algorithm`. Without this the FEEDBACK cell would
     * render the def default (4) while the engine played BASS 1's stored 7 —
     * a control lying about its own value, the exact divergence class
     * CLAUDE.md's card-vs-def rule exists for.
     *
     * Deliberately NOT undoable (a non-tracked origin): this is a migration
     * write, and it must not sit on the user's Cmd-Z stack pretending to be an
     * edit. It is also deferred to the first poll tick rather than run inline,
     * so it never writes to the Y.Doc from inside the reconciler pass that is
     * currently constructing this node. Once written the key exists, so it
     * happens exactly once per node, ever.
     */
    function hydrateParamsOnce(): void {
      const needAlgo = readLiveParam('algorithm') === undefined;
      const needFb = readLiveParam('feedback') === undefined;
      if (!needAlgo && !needFb) return;
      const v = readVoice();
      mutateNode(
        node.id,
        (live) => {
          if (needAlgo && live.params.algorithm === undefined) {
            live.params.algorithm = clampAlgo(v.algorithm);
          }
          if (needFb && live.params.feedback === undefined) {
            live.params.feedback = clampFeedback(v.feedback);
          }
        },
        { origin: DX7_MIGRATION_ORIGIN },
      );
    }

    // Poll the EDIT-BUFFER CONTENT (and the preset name). Yjs syncs node.data
    // from remote collaborators and from local Card/shell edits alike, so one
    // poll captures both — but WHICH message it sends is not the same for the
    // two cases, and the difference is audible. See the header block.
    //
    // ⚠ The change test is `dx7VoiceSignature` (content), NOT `voiceRev` —
    // the rev is persisted per patch, so a same-session load of a patch that
    // happens to hold the same (preset, voiceRev) pair with a DIFFERENT edit
    // buffer used to alias to "no change" and the worklet kept playing the
    // previous patch's voice (the warrensspectrum `wsBandsRev` fix, ported —
    // see the dx7VoiceSignature doc block).
    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    function pollVoiceRev(): void {
      if (!alive) return;
      hydrateParamsOnce();
      const name = readPresetName();
      // The rev stays as the `read('voiceRev')` host shadow — tracked every
      // tick so the readback stays honest, but no longer the change test.
      currentVoiceRev = readVoiceRev();
      const voice = readVoice();
      const sig = dx7VoiceSignature(voice);
      const nameChanged = name !== currentPresetName;
      const sigChanged = sig !== currentVoiceSig;
      if (nameChanged || sigChanged) {
        currentPresetName = name;
        currentVoiceSig = sig;
        // Adopt whatever the stamp wrote onto the params BEFORE sending, so
        // the outgoing payload carries the new voice's algorithm/feedback even
        // if the reconciler has not delivered its setParam calls yet. This is
        // also the "update the host shadow on the stamp" half of keeping
        // readParam honest. Turning a knob updates them through setParam and
        // lands here as a no-op.
        const a = readLiveParam('algorithm');
        if (a !== undefined) currentAlgo = clampAlgo(a);
        const f = readLiveParam('feedback');
        if (f !== undefined) currentFeedback = clampFeedback(f);
        // A NAME change is a deliberate voice swap → destructive.
        // A content-only change is an operator edit (LOCAL OR REMOTE) or a
        // same-name patch load → must not stop a rack-mate's — or your own —
        // sounding notes.
        sendVoice(voice, nameChanged ? 'patch' : 'voice');
      }
      pollTimer = setTimeout(pollVoiceRev, POLL_MS);
    }
    pollTimer = setTimeout(pollVoiceRev, POLL_MS);

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['poly',     { node: workletNode, input: 0 }],
        ['pitch_cv', { node: workletNode, input: 1 }],
        ['gate',     { node: workletNode, input: 2 }],
      ]),
      outputs: new Map([['out', { node: workletNode, output: 0 }]]),
      setParam(paramId, value) {
        // BUG-FIX (PR fix/dx7-algorithm-switching): `algorithm` is NOT an
        // AudioParam on the worklet — only voiceCount / level / transpose and
        // the master-ADSR four are. Neither is `feedback`. BOTH branches MUST
        // run BEFORE the `if (!p) return` early-out: `params.get()` is
        // undefined for them, so an early-out first would make moving either
        // knob silently no-op (the exact visible bug that regression fixed).
        if (paramId === 'algorithm') {
          const a = clampAlgo(value);
          if (a !== currentAlgo) {
            currentAlgo = a;
            // The INCREMENTAL, NON-DESTRUCTIVE message (PR 1's protocol).
            // process() re-reads `this.patch.algorithm` at the top of every
            // block, so the routing graph re-binds within ~3 ms with no voice
            // state touched — a held note morphs into the new wiring instead
            // of hard-retriggering the way the old whole-patch re-send did.
            workletNode.port.postMessage({ type: 'algorithm', value: a });
          }
          return;
        }
        if (paramId === 'feedback') {
          const f = clampFeedback(value);
          if (f !== currentFeedback) {
            currentFeedback = f;
            // Sent as the RAW 0..7 byte; the worklet owns the ÷7
            // normalization, exactly as applyPatch does. Non-destructive.
            workletNode.port.postMessage({ type: 'feedback', value: f });
          }
          return;
        }
        const p = params.get(paramId);
        if (!p) return;
        p.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        // Neither 'algorithm' nor 'feedback' has an AudioParam (see setParam)
        // — return the host shadow so the Knob's motorized live-read and the
        // shell's param cell can render the value the engine is actually
        // running. Without these, both read `undefined` and the control goes
        // dead. dx7.test.ts pins it.
        if (paramId === 'algorithm') return currentAlgo;
        if (paramId === 'feedback') return currentFeedback;
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'preset') return currentPresetName;
        if (key === 'algorithm') return currentAlgo;
        if (key === 'feedback') return currentFeedback;
        if (key === 'voiceRev') return currentVoiceRev;
        return undefined;
      },
      dispose() {
        alive = false;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        try { workletNode.port.close(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};

