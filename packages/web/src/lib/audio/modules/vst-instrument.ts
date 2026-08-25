// packages/web/src/lib/audio/modules/vst-instrument.ts
//
// VST INSTRUMENT — mounts one of the user's installed instrument plugins
// (AU builds — Serum, the Arturia collection, Apple's DLS synth, …) through
// the vst-bridge native helper (repo: patchtogether.nativeapps;
// ws://127.0.0.1:9309/ws) and plays it from the rack's own note sources.
//
// The def is SHAPED LIKE tidyVco on purpose (poly + mono-fallback pitch/gate
// + vel in, stereo out, no audio inputs): lane membership, audio autowiring
// and clip-CV delivery all come from these port shapes via planColumnWiring
// / resolveClipWiring — no chainWiring override, no wiring code. Dropped
// into a channel lane it bins as a chain SOURCE and the lane's clip player
// wires pitch{n} → poly, gate{n} → gate, vel{n} → vel automatically.
//
// CV→MIDI conversion runs PER SAMPLE in the shared 'vst-bridge' worklet
// (packages/dsp/src/vst-bridge.ts; pure core: lib/vst-bridge-core.ts):
// 0.0 pitch CV = C4 = MIDI 60, gate threshold 0.5, NoteOff carries the
// SOUNDING note, tied/legato steps emit off+on at the same sample, velocity
// unpatched = 100. Events ride a third SAB ring, stamped on the same sample
// clock as the outgoing clock blocks, so the bridge lands each note at the
// exact sample its gate crossed.
//
// Transport/session model, per-card connection, parked-instance reattach:
// see vst-bridge-shared.ts and $lib/audio/vst/bridge-owner.ts.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleFace } from '$lib/graph/types';
import { createVstHandle } from './vst-bridge-shared';

/**
 * THE FACE — and it is the thinnest in the fleet, which is the honest outcome
 * rather than a gap.
 *
 * WHAT THIS MODULE IS FOR, MUSICALLY: it makes a plugin you already own behave
 * like a module you patched. The one thing it does that no sibling does is
 * borrow a voice from OUTSIDE the browser and give it rack citizenship — poly CV
 * in, stereo audio out, sample-accurate MIDI in between. The verb a player
 * performs is MOUNT: choose an instrument and hand it the lane's notes.
 *
 * ⚠ THE RANKING IS FORCED BY THE CONTRACT, NOT CHOSEN. `params: []` — this def
 * declares no ParamDef at all, so there is no scalar to rank. The whole surface
 * is a control plane, and exactly two of its gestures are expressible as generic
 * cells (see the `vstInstrument` entry in `shell-cells.ts` for the two gate
 * mechanics that decide the other five, and `VstBridgeFaceBody.svelte` for the
 * long form).
 *
 * THE TIER LADDER, READ BACK AS A SENTENCE: at every tier from mini upward the
 * player gets CONNECT, because a card that never connects is silent and nothing
 * else on the plate can change that; compact adds DISCONNECT, the gesture that
 * frees a plugin slot when the helper's sixteen are full; and the dock adds the
 * plugin surface itself, which is where a plugin is actually chosen. That is a
 * genuine priority ordering rather than a declaration order — CONNECT outranks
 * DISCONNECT because one of them is the precondition for every other affordance
 * this module has, and the other is a housekeeping gesture.
 *
 * ONE PAGE, and it earns its header on the "1 control that is the module's
 * identity" clause: `bridge` is the only idea here. A second page would be a
 * header over nothing — the plugin controls are not `order` keys, they are the
 * extension body's own surface, so there is no second group of keys to name.
 *
 * ⚠ NO HERO. `heroFacePlan` MOVES a key out of its band, and this face has ONE
 * band holding exactly two keys — promoting either would leave a band whose hint
 * renders nowhere, and promoting both would empty the band entirely. A hero also
 * SUPPRESSES the shell glyph at the dock, and the glyph is the only live picture
 * this plate has.
 *
 * ⚠ GLYPH `'meter'`, matching es9 and derived rather than decorative: the def
 * has an audio out (`out_l`), so `glyphBinding` resolves a real analyser tap. On
 * a runner with no helper the plugin returns digital silence, so it draws the
 * same flat centreline every other faced module's live glyph draws — which is
 * what keeps the VRT scene a function of the code rather than of the machine.
 *
 * ⚠ NO `rear.groups`. The derived default is already right: the input rail is
 * the four note inputs (poly / pitch / gate / vel) and the output rail is the
 * stereo pair. Authoring a group here would restate the cable domains, which the
 * rear-card rules name as the thing NOT to author.
 */
export const VST_INSTRUMENT_FACE: ModuleFace = {
  glyph: 'meter',
  // The plugin surface — picker, its text filter, mount/swap/unmount and the
  // native-editor toggle — is a module-owned `fullViewBody`, shared with vstFx.
  extension: 'vstBridge',
  order: ['vst-connect-{n}', 'vst-disconnect-{n}'],
  pages: [
    {
      id: 'bridge',
      label: 'bridge',
      hint:
        'The session with the vst-bridge helper app, which hosts your plugin through CoreAudio and '
        + 'serves it over a localhost WebSocket. It is not a browser permission: the app has to be '
        + 'running on this machine, and the plugin has to be installed on it. Until it answers, this '
        + 'card is silent and harmless. The session belongs to the node and is keyed by its id, so '
        + 'collapsing this pane does not drop it and a page reload re-adopts the running plugin.',
      controls: ['vst-connect-{n}', 'vst-disconnect-{n}'],
    },
  ],
};

export const vstInstrumentDef: AudioModuleDef = {
  type: 'vstInstrument',
  palette: { top: 'Audio modules', sub: 'I/O' },
  domain: 'audio',
  label: 'vst instrument',
  category: 'sources',
  size: '3u',
  hp: 2,
  // NO maxInstances: multiple VST cards at once is the whole point (the
  // helper caps at 16 concurrent plugin instances and answers 'busy' above).
  stereoPairs: [['out_l', 'out_r']],

  // LITERAL port arrays on purpose (the docs-site manifest extractor is a
  // regex over source — see es9.ts). Shapes are load-bearing for the lane
  // wiring: poly (polyPitchGate) + gate → resolveClipWiring mode 'poly';
  // `vel` id + cv type + no paramTarget → isVelCvInput → clip vel{n};
  // NO audio inputs → binned as a chain SOURCE. Do not add chainWiring.
  inputs: [
    { id: 'poly', type: 'polyPitchGate' },
    { id: 'pitch', type: 'cv' },
    { id: 'gate', type: 'gate', edge: 'gate' },
    { id: 'vel', type: 'cv' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [],

  face: VST_INSTRUMENT_FACE,

  // ⚠ TWO FAMILIES FOR TWO GESTURES, because `resolveFaceControl` resolves a
  // face key to a PARAM id, a family TEMPLATE (`<id>-{n}`) or a legend STATIC,
  // and CONNECT/DISCONNECT are none of the first. They are real affordances the
  // module owns — `VstBridgePanel` has had both buttons since it shipped — and
  // `module-docs-lint`'s card-drift leg requires each declared `testidPrefix` to
  // appear in real UI source. CONNECT already carried its testid; DISCONNECT
  // grows one in this same diff. Adding the testid is the honest fix; dropping
  // the family would be fixing a declaration to satisfy a gate.
  controlFamilies: [
    { id: 'vst-connect', label: 'Connect', kind: 'other', testidPrefix: 'vst-connect' },
    { id: 'vst-disconnect', label: 'Disconnect', kind: 'other', testidPrefix: 'vst-disconnect' },
  ],

  docs: {
    explanation:
      "Plays one of YOUR installed instrument plugins — the AU builds of your VSTs (Arturia, Serum, Apple's built-in DLS synth, …) — as a first-class rack voice, through the vst-bridge native helper app (macOS, ws://127.0.0.1:9309). Drop it in a channel lane and it behaves exactly like an internal instrument: the lane's clip player auto-wires its pitch, gate and velocity outputs here, the card's stereo output auto-wires into the lane chain, and the worklet converts poly CV to sample-accurate MIDI (0.0 pitch CV = C4 = MIDI 60, 1.0 = one octave; gate threshold 0.5; tied steps become legato NoteOff+NoteOn pairs; velocity 0..1 maps to MIDI 1..127, default 100 when vel is unpatched). Pick a plugin on the card, mount it, and OPEN EDITOR raises the plugin's own native window on your machine. One card = one plugin instance (the helper caps at 16); a page refresh re-adopts the running instance, so the plugin and its state survive reloads. Requires the vst-bridge helper running locally (Chromium/Firefox; the card shows status) — without it the card sits silent and harmless. In a shared patch, audio renders only on the machine running the helper with the plugin installed; collaborators see the card but hear this voice only through your machine's contribution.",
    inputs: {
      poly:
        "The rack's 32-channel poly note bus (16 voice pairs: even channels pitch V/oct, odd channels gate 0|1). Auto-wired from the lane clip player's pitch{n}. Each voice pair runs its own gate→NoteOn/NoteOff state machine in the worklet, so chords land as concurrent MIDI notes with per-voice NoteOffs.",
      pitch:
        'Mono V/oct pitch (0.0 = C4), used with the gate input only when the poly bus is unpatched — the hand-patch fallback for driving the plugin from a mono sequencer or LFO.',
      gate:
        "Mono note gate (level-sensitive, threshold 0.5): rising edge = NoteOn sampling the pitch input at that instant, falling edge = NoteOff of the sounding note. Auto-wired from the clip player's gate{n} alongside the poly bus (the lane rule); the poly bus takes precedence whenever it is patched.",
      vel:
        'Velocity CV 0..1 → MIDI velocity 1..127, sampled at each gate rise (a NoteOn is never emitted at velocity 0 — the wire floor is 1). Unpatched, notes send velocity 100. Auto-wired from the clip player’s vel{n}.',
    },
    outputs: {
      out_l:
        "The plugin's audio return, left — placed on the card's own timeline by the bridge (each returned block carries the sampleTime of the clock block that pulled it). Auto-wires into the channel lane chain.",
      out_r:
        "The plugin's audio return, right (stereo-paired with out_l, so patching only the left side normals both).",
    },
    controls: {
      'vst-connect':
        "Opens this card's own session with the vst-bridge helper — one WebSocket, one plugin "
        + 'instance, keyed by this node id. It also RESTARTS a live session at the engine\'s current '
        + 'sample rate, which is the recovery path when another browser tab has claimed this card\'s '
        + 'instance: press it and the instance comes back here. The engine already connects on its '
        + 'own when the node is created, so this is for the case where the helper was not running '
        + 'yet, or where you disconnected on purpose.',
      'vst-disconnect':
        'Drops the session without deleting the node — the helper PARKS this plugin instance rather '
        + 'than destroying it (about 90 seconds), so a reconnect re-adopts the same plugin with its '
        + 'state intact. Use it to hand one of the helper\'s sixteen concurrent instances to another '
        + 'card, or to silence this voice without losing the patch.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // The 'vst-bridge' literal lives HERE (typed — only the real name
    // compiles) so this def's source names its worklet (see vst-fx.ts).
    return createVstHandle(ctx, node, 'instrument', 'vst-bridge');
  },
};
