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
import type { ModuleFace } from '$lib/graph/types';
import { createVstHandle } from './vst-bridge-shared';

/**
 * THE FACE — the same shape as `vstInstrument`'s, for the same forced reason,
 * and the two were authored together because the surface is literally one
 * component.
 *
 * WHAT THIS MODULE IS FOR, MUSICALLY: it puts a plugin you already own INSIDE
 * the lane, as an insert. The one thing it does that no sibling does is process
 * with code that is not in the browser at all — and the price is a real round
 * trip, so it FEELS like patching through outboard gear on a send rather than
 * like an internal effect. The verb a player performs is MOUNT: choose an
 * effect and the chain runs through it.
 *
 * ⚠ THE RANKING IS FORCED BY THE CONTRACT, NOT CHOSEN. `params: []`. See the
 * `vstFx` entry in `shell-cells.ts` for the two gate mechanics that keep the
 * picker, its filter and the mount gestures off the ranked list, and
 * `VstBridgeFaceBody.svelte` for the long form.
 *
 * THE TIER LADDER, READ BACK AS A SENTENCE: every tier gets CONNECT, because
 * with the session down this insert is a local bypass and the plugin is not in
 * the path at all; compact adds DISCONNECT, which is how you free one of the
 * helper's sixteen instances; the dock adds the plugin surface, where an effect
 * is actually chosen. ⚠ THE FIRST CLAUSE IS WORTH SAYING PRECISELY, because it
 * differs from the instrument's in a way that matters to a player: a
 * disconnected `vstFx` does NOT go silent — the worklet bypasses locally, so a
 * missing helper can never mute a lane. What it does is stop being an effect.
 *
 * ONE PAGE (`bridge`), the module's only idea — the plugin controls are not
 * `order` keys, so there is no second group of keys a second page could name.
 *
 * ⚠ NO HERO, for the mechanical reason: one band, two keys, and `heroFacePlan`
 * MOVES rather than copies — promoting either would leave the band's hint
 * rendering nowhere, and a hero also suppresses the dock glyph.
 *
 * ⚠ GLYPH `'meter'` — derived from the real `out_l` audio out. With no helper
 * the local bypass passes whatever the lane feeds it, and in a fresh VRT scene
 * nothing is patched in, so the tap reads digital silence and draws the same
 * flat centreline as every other faced module.
 *
 * ⚠ NO `rear.groups`. Stereo in, stereo out; the derived default names both
 * rails correctly and an authored group would only restate the cable domain.
 */
export const VST_FX_FACE: ModuleFace = {
  glyph: 'meter',
  // The plugin surface — picker, its text filter, mount/swap/unmount and the
  // native-editor toggle — is a module-owned `fullViewBody`, shared with
  // vstInstrument exactly as `VstBridgePanel` is shared by the two cards.
  extension: 'vstBridge',
  order: ['vst-connect-{n}', 'vst-disconnect-{n}'],
  pages: [
    {
      id: 'bridge',
      label: 'bridge',
      hint:
        'The session with the vst-bridge helper app, which hosts your plugin through CoreAudio and '
        + 'serves it over a localhost WebSocket. It is not a browser permission: the app has to be '
        + 'running on this machine, and the plugin has to be installed on it. With the session down '
        + 'the insert bypasses locally — a missing helper never mutes the lane, it just stops being '
        + 'an effect. The session belongs to the node and is keyed by its id, so collapsing this pane '
        + 'does not drop it and a page reload re-adopts the running plugin.',
      controls: ['vst-connect-{n}', 'vst-disconnect-{n}'],
    },
  ],
};

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

  face: VST_FX_FACE,

  // ⚠ TWO FAMILIES FOR TWO GESTURES — the same declaration vstInstrument makes,
  // and the same reason: `resolveFaceControl` resolves a face key to a PARAM id,
  // a family TEMPLATE or a legend STATIC, and these are none of the first. Both
  // testids live on the shared `VstBridgePanel`, which is what
  // `module-docs-lint`'s card-drift leg reads.
  controlFamilies: [
    { id: 'vst-connect', label: 'Connect', kind: 'other', testidPrefix: 'vst-connect' },
    { id: 'vst-disconnect', label: 'Disconnect', kind: 'other', testidPrefix: 'vst-disconnect' },
  ],

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
    controls: {
      'vst-connect-{n}':
        "Opens this card's own session with the vst-bridge helper — one WebSocket, one plugin "
        + 'instance, keyed by this node id. It also RESTARTS a live session at the engine\'s current '
        + 'sample rate, which is the recovery path when another browser tab has claimed this card\'s '
        + 'instance. The engine already connects on its own when the node is created, so this is for '
        + 'the case where the helper was not running yet, or where you disconnected on purpose. Until '
        + 'it succeeds the insert bypasses locally, so the lane keeps flowing either way.',
      'vst-disconnect-{n}':
        'Drops the session without deleting the node — the helper PARKS this plugin instance rather '
        + 'than destroying it (about 90 seconds), so a reconnect re-adopts the same plugin with its '
        + 'state intact. The insert falls back to a local bypass, so the lane keeps its audio; you '
        + 'lose the effect, not the signal. Use it to hand one of the helper\'s sixteen concurrent '
        + 'instances to another card.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // The 'vst-bridge' literal lives HERE (typed — only the real name
    // compiles) so this def's source names its worklet: mono-normal-scan
    // attributes the worklet's in_r→in_l mono normal to this module by
    // finding the processor name in the def file.
    return createVstHandle(ctx, node, 'fx', 'vst-bridge');
  },
};
