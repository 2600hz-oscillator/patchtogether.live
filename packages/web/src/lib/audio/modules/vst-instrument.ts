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
import { createVstHandle } from './vst-bridge-shared';

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
    controls: {},
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    return createVstHandle(ctx, node, 'instrument');
  },
};
