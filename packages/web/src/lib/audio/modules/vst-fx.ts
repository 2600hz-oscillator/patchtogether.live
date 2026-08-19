// packages/web/src/lib/audio/modules/vst-fx.ts
//
// VST FX — mounts one of the user's installed effect plugins (AU builds)
// through the vst-bridge native helper (patchtogether.nativeapps;
// ws://127.0.0.1:9309/ws) as a stereo insert.
//
// The def is SHAPED LIKE clouds on purpose: stereo audio in + stereo audio
// out, stereoPairs on both sides, NO chainWiring — planColumnWiring infers
// role 'both' and slots the card into a channel lane as an FX insert with
// zero wiring code.
//
// The audio path is 100% wet by design (plugins carry their own mix knobs).
// With the helper CONNECTED but nothing mounted, the bridge echoes input
// back bit-transparently — the lane keeps flowing through an empty card,
// at the transport round trip (~15-25 ms, the external-hardware-send feel).
// With the transport DOWN, the worklet bypasses locally so a missing helper
// can never mute a lane.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { createVstHandle } from './vst-bridge-shared';

export const vstFxDef: AudioModuleDef = {
  type: 'vstFx',
  palette: { top: 'Audio modules', sub: 'I/O' },
  domain: 'audio',
  label: 'vst fx',
  category: 'effects',
  size: '3u',
  hp: 2,
  // NO maxInstances: one plugin per card, up to the helper's 16-instance cap.
  stereoPairs: [['in_l', 'in_r'], ['out_l', 'out_r']],

  // LITERAL port arrays on purpose (the docs-site manifest extractor is a
  // regex over source — see es9.ts). The stereo-in/stereo-out shape with no
  // chainWiring is what makes lane drops wire this as an FX INSERT.
  inputs: [
    { id: 'in_l', type: 'audio' },
    { id: 'in_r', type: 'audio' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [],

  docs: {
    explanation:
      "Runs one of YOUR installed effect plugins — the AU builds of your VSTs (delays, reverbs, compressors, Apple's AUDelay, …) — as a stereo insert, through the vst-bridge native helper app (macOS, ws://127.0.0.1:9309). Drop it in a channel lane and it slots into the chain like any internal effect: stereo in, stereo out, auto-wired. Pick a plugin on the card, mount it, and OPEN EDITOR raises the plugin's own native window on your machine. The path is 100% wet (use the plugin's own mix control); while nothing is mounted the bridge passes audio through bit-transparently, and if the helper is not running at all the card bypasses locally — a missing helper never mutes the lane. Latency is the transport round trip (~15-25 ms added — the feel of patching through external hardware on a send; the card shows the measured rtt plus the plugin's own reported latency). One card = one plugin instance (helper cap 16); a page refresh re-adopts the running instance, so the plugin and its state survive reloads. Requires the vst-bridge helper running locally (Chromium/Firefox; the card shows status). In a shared patch, the effect renders only on the machine running the helper with the plugin installed.",
    inputs: {
      in_l:
        'Stereo insert input, left — sent to the mounted plugin as its input bus (bit-transparent echo when nothing is mounted; local bypass when the helper is unreachable).',
      in_r:
        'Stereo insert input, right (stereo-paired with in_l, so patching only the left side normals both).',
    },
    outputs: {
      out_l:
        "The plugin's processed return, left — each returned block carries the sampleTime of the input block that produced it, so the card places it on its own timeline.",
      out_r:
        "The plugin's processed return, right (stereo-paired with out_l).",
    },
    controls: {},
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // The 'vst-bridge' literal lives HERE (typed — only the real name
    // compiles) so this def's source names its worklet: mono-normal-scan
    // attributes the worklet's in_r→in_l mono normal to this module by
    // finding the processor name in the def file.
    return createVstHandle(ctx, node, 'fx', 'vst-bridge');
  },
};
