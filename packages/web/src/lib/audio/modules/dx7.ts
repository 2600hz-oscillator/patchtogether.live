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
//   algorithm   — 1..32 (DX7 algorithm; quantized; editable at any time. The
//                 host still applies it by re-sending the WHOLE patch, which
//                 resets every voice — a held note hard-retriggers and a
//                 releasing tail is cut. Same for a preset change. The worklet
//                 now also accepts a non-destructive `{type:'algorithm'}`
//                 message; routing this knob onto it is the host half of the
//                 operator-view work and is NOT done here yet.)
//                 NOT an AudioParam on the worklet — host bridge sends a
//                 fresh patch message via port.postMessage when the knob
//                 moves. The setParam handler MUST check this branch
//                 before the AudioParam-lookup early-out (regression PR
//                 fix/dx7-algorithm-switching).
//   voiceCount  — 1..5 (poly limit). AudioParam.
//   level       — master output level. AudioParam.
//   transpose   — ±24 semitones. AudioParam.
//
// Patch selection (data-side, not AudioParam):
//   node.data.preset  — name of bundled patch (DX7_BUILTIN_BANK).
//   node.data.userPatches — array of DX7Voice loaded from SYX. Lives in
//                           node.data, so it rides the Y.Doc out to every
//                           rack-mate AND is persisted by Hocuspocus snapshots
//                           and the .imp.json export envelope. See
//                           .myrobots/plans/rackspace-persistence.md.
//
// On preset change, the host sends a `{type:'patch', voice}` message to the
// worklet which rebuilds its internal patch state. That message is the
// DESTRUCTIVE one and is correct for a preset LOAD; the worklet also speaks
// `voice` / `opParam` / `algorithm` / `feedback`, which mutate the patch in
// place without touching a sounding voice (see the protocol block in
// packages/dsp/src/dx7.ts). Live operator editing rides those.
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
//   voiceCount (discrete 1..5, default 5): polyphony cap.
//   level (linear 0..2, default 0.7): output level.
//   transpose (linear -24..24 st, default 0): global transposition.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { DX7Voice } from '$lib/audio/dx7-syx';
import { DX7_BUILTIN_BANK, findBuiltinPatch } from '$lib/audio/dx7-banks';
import { patch as livePatch } from '$lib/graph/store';
import workletUrl from '@patchtogether.live/dsp/dist/dx7.js?url';

const POLL_MS = 100;

// Track of which AudioContexts already have the worklet module loaded.
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Default preset for fresh modules. */
export const DX7_DEFAULT_PRESET = 'E.PIANO 1';

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
  //   compact (2 cells + glyph) + algorithm — the mock's "preset + glowing ALG
  //               readout" hero band, exactly.
  //   full    (6 whole plate cells — laneBodyPlan's no-clip cap) + level,
  //               transpose, voiceCount (the performance set) + release: the
  //               master VCA's release is a CEILING on every patch's own tail
  //               (its 0.005 s default closes the VCA in well under 0.1 s), so
  //               it is the master-ADSR control a player actually reaches for.
  //   ranks 7+ the rest of the master ADSR + the .syx import action —
  //               reachable in the dock faceplate, which renders EVERY control.
  // Pages are the dock's section bands, lowercase: what the sound IS (patch),
  // how it PLAYS (performance), the master amplitude envelope, then the
  // cartridge loader. glyph 'scope' = a live trace of the played FM waveform
  // (an FM voice's identity is its harmonic shape, and it comes from the
  // PATCH, not from a knob — so the param-derived dual wave has nothing to
  // draw here; the analyser trace on OUT is the honest identity display).
  face: {
    order: [
      // the hero ladder (mini = 1 / compact = 2 cells + glyph / plate = 6)
      'dx7-preset-select-{n}',
      'algorithm',
      'level',
      'transpose',
      'voiceCount',
      'release',
      // dock tail — the rest of the master envelope, then the import action
      'attack',
      'decay',
      'sustain',
      'dx7-syx-input-{n}',
    ],
    pages: [
      { id: 'patch', label: 'patch', controls: ['dx7-preset-select-{n}', 'algorithm'] },
      { id: 'performance', label: 'performance', controls: ['voiceCount', 'transpose', 'level'] },
      { id: 'ampenv', label: 'master adsr', controls: ['attack', 'decay', 'sustain', 'release'] },
      { id: 'cartridge', label: 'cartridge', controls: ['dx7-syx-input-{n}'] },
    ],
    glyph: 'scope',
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
      "A 6-operator FM synthesizer modeled on the Yamaha DX7. Each of its six operators is a sine oscillator with its own frequency ratio (or a fixed frequency) and its own 4-rate/4-level DX7 envelope; instead of filtering a rich waveform, operators modulate each other's phase — one of 32 fixed ALGORITHM wiring diagrams decides which operators are CARRIERS (summed to the output) and which are MODULATORS bending a carrier faster than you can hear, which is what sculpts FM's metallic, bell-like and electric-piano timbres. Every algorithm also carries exactly ONE feedback loop, at the depth stored in the patch, and WHERE that loop sits is part of the algorithm: it is operator 6 feeding back into itself in most of them, but operator 2, 3, 4 or 5 in others, and in algorithms 4 and 6 it is a loop wrapping a whole stack (operator 4 back into 6, operator 5 back into 6) rather than a self-loop. That placement is often the only difference between two otherwise identically-wired algorithms — 1 and 2, or 26 and 27, route the same and sound different for exactly this reason. This is a PATCH-DRIVEN instrument: the ratios, levels, envelopes, feedback and stored transpose all come from the loaded voice — nine built-in patches written to evoke the classic factory sounds (E.PIANO 1, TUB BELLS, BRASS 1 …; they are original patches, not Yamaha's data), plus every voice of any .syx cartridge you import. The panel's live controls are therefore which voice is loaded, which algorithm wires it, how it plays (polyphony, transpose, level) and a per-voice master ADSR layered over the patch's own operator envelopes. It plays up to 5 voices from the POLY bus — the first VOICES of that cable's 16 lanes — or monophonically from the PITCH CV + GATE pair. What a cartridge actually drives here: each operator's four envelope rates and levels, its frequency ratio (or fixed-frequency mode), its detune and its output level, plus the voice's algorithm, feedback depth and stored transpose. What it does NOT: the LFO and the pitch envelope are unpacked into the parsed voice but never sent to the engine, per-operator velocity sensitivity is sent and then ignored (nothing upstream carries velocity — the poly cable is pitch and gate only), and keyboard level scaling, rate scaling, amp-mod sensitivity and oscillator sync are not unpacked from the cartridge bytes at all.",
    inputs: {
      poly: "The polyphonic note source and the preferred way to play this synth: the 16-lane polyPitchGate cable (32 channels — a pitch and a gate per lane; patch POLYSEQZ, MIDI LANE, or another poly source here). DX7 has five voice slots, so only the first VOICES lanes are read and anything on lanes 6-16 is ignored. A rising gate on a lane triggers a fresh note-on at that lane's pitch, the falling gate releases it, and while a lane's gate stays high its pitch keeps being tracked so the note glides. A lane keeps its own voice for as long as its note lasts; when every voice slot is still busy a new note steals the oldest. Pitch and gate are sampled once per render block, so block-quantized sequencer writes land exactly.",
      pitch_cv: "Mono V/oct pitch for single-voice playing — read only when nothing is patched into POLY, and only for the first lane, so this route is monophonic. 0 V is middle C (C4) and 1 V is an octave; TRANSPOSE and the loaded patch's own stored transpose add on top.",
      gate: "Mono note-on/off gate for the single-voice (PITCH CV) route — level-sensitive, not edge-only: crossing above half a volt triggers a note-on, the note is held for as long as the level stays high (tracking PITCH CV, so it glides), and the falling edge releases it. Read only when nothing is patched into POLY; patch a keyboard or envelope gate here.",
    },
    outputs: {
      out: "Mono audio: every active voice's carrier operators summed, each voice scaled by its own master ADSR, then the whole bus scaled by LEVEL and by a fixed headroom trim of 0.4 so five voices sounding at once stay clear of clipping. Patch it into a VCA, filter, mixer, or straight to the output.",
    },
    controls: {
      // ⚠ THE LAST SENTENCE OF `algorithm` DESCRIBES THE HOST PATH, NOT THE
      // ENGINE'S CAPABILITY, AND PR 5 OF THE DX7 OPERATOR-VIEW PROGRAM MUST
      // RE-AUTHOR IT IN THAT SAME PR. The worklet already accepts a
      // non-destructive `{type:'algorithm'}` message (added in PR 1, see the
      // protocol block in packages/dsp/src/dx7.ts), but `setParam('algorithm')`
      // below still calls sendPatch() — a whole-patch re-send that resets every
      // voice. When PR 5 routes the knob onto the incremental message, "turning
      // it re-sends the whole patch … a note you are holding is retriggered"
      // becomes FALSE and the sentence must change with the code.
      //
      // The audible consequence is a RETRIGGER, not silence: applyPatch zeroes
      // `lastGate`, so the still-high gate reads as a fresh rising edge on the
      // very next block. Measured, not assumed — see dx7-messages.test.ts.
      //
      // MERGE NOTE (PR 0 ← main): the "AND which operator carries the feedback
      // loop" clause is PR 0's, and it is now TRUE — the corrected table gives
      // each algorithm its own feedback operator instead of hardcoding op6. The
      // retrigger wording and this comment are PR 1's. Both are kept; neither
      // side's correction is dropped.
      algorithm: "Which of the 32 DX7 algorithms wires the six operators together (1–32) — each one fixes both the carrier/modulator routing AND which operator carries the feedback loop, from the deep single-carrier stacks (16–18) through the classic 3-carrier electric-piano layouts (5) to the fully parallel additive organ (32, where all six operators are carriers). It is the biggest single shaper of a patch's character. Loading a preset adopts that voice's own stored algorithm and the readout follows it; turning the knob overrides it. Changing it re-sends the whole patch to the engine, which resets every voice: a note you are holding does not morph into the new routing but is RETRIGGERED — you hear a click and a fresh attack — and a note already ringing out its release is cut short. Treat it as a between-notes control.",
      voiceCount: "How many of the POLY cable's lanes are read, 1 to 5 — the cable itself carries 16, but DX7 has five voice slots and never looks past lane 5. Lanes above the setting are ignored, so 1 gives a strictly monophonic instrument (the same first lane the mono PITCH CV + GATE pair drives) and 5 lets full chords through. Five voice slots exist either way; a note arriving while all of them are still busy steals the oldest.",
      level: "Master output gain for the whole synth, 0 to 2 (0.7 default); it scales the summed voice bus feeding OUT. The fixed 0.4 headroom trim is applied on top of it either way, so LEVEL 1 is the knob's own unity rather than unity gain end to end.",
      transpose: "Global pitch offset in semitones (-24 to +24) added to every voice on top of the loaded patch's own stored transpose (BASS 1, for instance, already sits an octave down). It is continuous rather than stepped, so fractional settings detune the whole instrument. It is re-applied while a gate is held — turning it retunes sounding notes live — but a note already released keeps the pitch it ended on.",
      attack: "Master output-VCA attack, per voice, layered on top of the patch's own operator envelopes: a linear ramp to full level taking this long, 0.001 to 5 s. At the 0.001 s default the master VCA is open instantly, so you hear the patch's own attack; raise it for a swell. Retrigger is click-safe — a re-gated voice ramps up from wherever it was instead of resetting to zero.",
      decay: "Master-VCA decay: once the attack has reached full level, the master envelope slides exponentially toward SUSTAIN with this time constant (about 99 % of the way in five times the setting). With SUSTAIN at its default of 1 there is nothing to slide toward and this has no effect — lower SUSTAIN first to hear it.",
      sustain: "Master-VCA sustain level (0 to 1) — the level a held note settles at after attack and decay, kept until the gate falls. At the default of 1 the master VCA simply stays open, so the patch's own operator envelopes are what you hear.",
      release: "Master-VCA release after the gate falls: an exponential fade with this time constant. It acts as a CEILING on the patch's own tail — at the 0.005 s default the master VCA closes in well under a tenth of a second, cutting the long releases stored in bell and pad voices, so raise it (a second or more) when you want those tails to ring. The voice slot is freed only once both this envelope and the operator envelopes have faded out.",
      // Card controls with no param/family of their own — each declared as a
      // single-member control family below and keyed here as `<familyId>-{n}`.
      "dx7-preset-select-{n}": "The voice selector, and the single control that defines the sound: pick one of the nine built-in patches (E.PIANO 1, BASS 1, HARMONICA, STRINGS 1, MARIMBA, TUB BELLS, BRASS 1, CALLIOPE, WIRE LEAD) or, once you have imported a cartridge, any voice from it. Choosing a voice loads its six operators, their envelopes, its feedback depth, its stored transpose and its stored algorithm — so the ALGORITHM readout jumps to the patch's own value. Loading a voice re-sends the whole patch to the engine, which resets every voice: a note you are holding re-attacks from the start of its envelope, and a note already ringing out its release is cut short. Treat it as a between-notes control.",
      "dx7-syx-input-{n}": "Load .syx bank — import a real Yamaha DX7 cartridge dump. It accepts the standard 4104-byte 32-voice SysEx bank, a bare 4096-byte payload, or a single 128-byte packed voice; a bank's 32 voices are APPENDED to the selector (never replacing what is already there, so several cartridges can be stacked) and the first voice of the new bank is selected for you. A status line reports how many voices loaded plus a count of any warnings — a bad header byte or a checksum mismatch is warned about, not rejected; only a file whose SIZE matches none of the three shapes is refused outright. Imported voices ride in the module's data, so they are saved with the rack and reach everyone in the rackspace.",
    },
  },

  controlFamilies: [
    // Single static/dynamic card controls (a dropdown + a file button) with no
    // backing param. Declared as one-member families so the docs gate can key
    // authored prose to them; the testidPrefix is grep-verified against the card.
    { id: 'dx7-preset-select', label: 'Preset / voice selector', kind: 'other', testidPrefix: 'dx7-preset-select' },
    { id: 'dx7-syx-input',     label: 'Load .syx bank',          kind: 'other', testidPrefix: 'dx7-syx-input' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'dx7', {
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

    // Apply initial param values.
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of dx7Def.params) {
      if (def.id === 'algorithm') continue; // applied via patch message
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // Track currently-applied preset name + algorithm. We poll
    // livePatch.nodes[id].data.preset so Card-driven preset changes flow
    // through to the worklet without a custom engine API.
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

    let currentPresetName = readPresetName();
    let currentAlgo = (node.params?.algorithm ?? 5) as number;

    function findPatch(name: string): DX7Voice {
      const user = readUserPatches();
      return (
        user.find((p) => p.name === name) ??
        findBuiltinPatch(name) ??
        DX7_BUILTIN_BANK[0]!
      );
    }

    function sendPatch(voice: DX7Voice, algoOverride?: number): void {
      const a = algoOverride ?? voice.algorithm;
      // BUG-FIX (PR fix/dx7-syx-bank-loading): SYX-loaded voices live in the
      // SyncedStore (Yjs Y.Doc). Reading `node.data.userPatches[i]` returns
      // a Yjs PROXY (not a plain object): the operators are Y.Map proxies
      // and `op.r`/`op.l` are Y.Array proxies. Passing those through
      // `port.postMessage` triggers structuredClone, which throws
      // "[object Array] could not be cloned" on Yjs proxies — so the
      // worklet never sees the new patch and keeps playing whatever it last
      // received (the bundled E.PIANO 1 sent on factory init).
      //
      // Fix: deep-unwrap to plain JS before posting. We hand-build the
      // payload (rather than JSON-roundtrip the whole voice) so we stay
      // explicit about which fields cross the boundary, and so primitive
      // arrays (`r`, `l`) are forced to plain Array<number>.
      const ops = voice.operators.map((o) => ({
        r: [Number(o.r[0]), Number(o.r[1]), Number(o.r[2]), Number(o.r[3])] as [number, number, number, number],
        l: [Number(o.l[0]), Number(o.l[1]), Number(o.l[2]), Number(o.l[3])] as [number, number, number, number],
        ratio: Number(o.ratio),
        detune: Number(o.detune),
        detuneFactor: Number(o.detuneFactor),
        level: Number(o.level),
        fixedMode: Boolean(o.fixedMode),
        velocitySens: Number(o.velocitySens),
      }));
      workletNode.port.postMessage({
        type: 'patch',
        voice: {
          name: String(voice.name ?? ''),
          algorithm: a,
          feedback: Number(voice.feedback),
          operators: ops,
          transpose: Number(voice.transpose),
        },
      });
    }

    // Initial patch send.
    {
      const v = findPatch(currentPresetName);
      // If the saved patch had an algorithm value, prefer it; otherwise use
      // the preset's stored algorithm.
      const initialAlgo =
        node.params?.algorithm !== undefined ? (node.params.algorithm as number) : v.algorithm;
      currentAlgo = Math.max(1, Math.min(32, Math.round(initialAlgo)));
      sendPatch(v, currentAlgo);
      // Note: 'algorithm' is host-tracked, not an AudioParam. The Card's
      // motorized live-read goes through readParam('algorithm') below which
      // returns `currentAlgo`.
    }

    // Poll for preset changes. Yjs syncs node.data updates from remote
    // collaborators (and local Card edits), so this captures both.
    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    function pollPresetChange(): void {
      if (!alive) return;
      const name = readPresetName();
      if (name !== currentPresetName) {
        currentPresetName = name;
        const v = findPatch(name);
        // Adopt the patch's algorithm on preset change. We deliberately do
        // NOT write back to node.params.algorithm — that would loop through
        // Yjs and conflict with the Card→engine knob path. The Card's
        // motorized live-read picks up the change via readParam('algorithm').
        currentAlgo = v.algorithm;
        sendPatch(v, currentAlgo);
      }
      pollTimer = setTimeout(pollPresetChange, POLL_MS);
    }
    pollTimer = setTimeout(pollPresetChange, POLL_MS);

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
        // AudioParam on the worklet — only `voiceCount`, `level`, and
        // `transpose` are. Algorithm changes flow through the patch-message
        // channel (worklet.port.postMessage) instead. So we MUST handle
        // 'algorithm' BEFORE the `if (!p) return` early-out — otherwise
        // moving the algo knob silently no-ops (the visible bug fixed here).
        if (paramId === 'algorithm') {
          const a = Math.max(1, Math.min(32, Math.round(value)));
          if (a !== currentAlgo) {
            currentAlgo = a;
            // Re-send current preset with overridden algorithm. The worklet
            // re-binds its routing graph from `this.patch.algorithm` on the
            // next render block, so this takes effect within ~3ms.
            const base = findPatch(currentPresetName);
            sendPatch(base, a);
          }
          return;
        }
        const p = params.get(paramId);
        if (!p) return;
        p.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        // 'algorithm' has no AudioParam (see setParam comment) — return the
        // host-tracked value so the Knob's motorized live-read can render
        // the current algo.
        if (paramId === 'algorithm') return currentAlgo;
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'preset') return currentPresetName;
        if (key === 'algorithm') return currentAlgo;
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

