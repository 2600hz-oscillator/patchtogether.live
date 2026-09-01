// packages/web/src/lib/ui/modules/audioin-face-model.test.ts
//
// ⚠ THIS FILE EXISTS BECAUSE THE GENERIC GATES PASS ALMOST VACUOUSLY OVER THIS
// FACE — its sibling `audioout-face-model.test.ts` says the same about the same
// shape, one wire later. `audioInDef` declares ONE param, so
// `module-face-lint`'s completeness check, the dock render-plan parity check and
// `faces-parity` each enumerate a single cell: their green runs would look
// nearly identical if everything this promotion actually added were broken.
//
// What only this file can see:
//   * the LANE PICTURE is live rather than a dead static, with a NEGATIVE
//     control (its own twin, `audioOut`, whose glyph is mechanically refused);
//   * `beginAutoAcquire` is the atomic once-per-NODE claim that keeps two
//     mounted surfaces from stopping each other's tracks — asserted from every
//     direction that matters, including the one a state-only guard would fail
//     (a re-mount after a deliberate STOP);
//   * the eight-state machine survives the promotion in FULL, and its state word
//     is on `detail` rather than on a caption — the resting-text half that no
//     rendering gate covers (`face-resting-text-source.test.ts` declares body
//     text its own blind spot);
//   * the picks are DELIBERATELY not undoable, asserted in both directions
//     against a real Y.Doc, with a positive control so "0 undo entries" cannot
//     be a silent harness.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { audioInDef } from '$lib/audio/modules/audioin';
import { audioOutDef } from '$lib/audio/modules/audio-out';
import { getModuleDef } from '$lib/audio/module-registry';
import '$lib/audio/modules';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { loadShellExtension, shellExtensionIds } from '$lib/ui/workflow/shell-extensions';
import { statusLedLabel, statusLedTitle } from '$lib/ui/controls/status-led-model';
import {
  AUDIO_IN_DEVICE_ORIGIN,
  INPUT_DEVICE_KEY,
  MUSIC_MODE_KEY,
  audioInConstraints,
  inputDeviceOptions,
  inputDeviceValue,
  inputMusicMode,
  setInputDevice,
  setInputMusicMode,
} from '$lib/audio/input-device.svelte';
import {
  inputActionDisabled,
  inputActionKind,
  inputActionLabel,
  inputFaultLit,
  inputLiveLit,
  inputPickerValueText,
  inputStatusDetail,
} from '$lib/ui/modules/audioIn/audio-in-status';
import {
  nodeAudioInput,
  type AudioInputState,
  type AudioInputView,
} from '$lib/ui/modules/node-audio-input-registry.svelte';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import type { MinimalDevice } from '$lib/audio/devices';

/** Every state the registry's own union declares. Written out ONCE, from the
 *  type, so a ninth state added to the machine reddens this file rather than
 *  quietly skipping the tables below. */
const ALL_STATES: readonly AudioInputState[] = [
  'idle',
  'requesting',
  'streaming',
  'permission-denied',
  'no-inputs-found',
  'device-in-use',
  'unsupported',
  'error',
];

function viewOf(state: AudioInputState, over: Partial<AudioInputView> = {}): AudioInputView {
  return {
    state,
    errorMsg: null,
    liveChannels: state === 'streaming' ? 2 : 0,
    deviceId: null,
    streaming: state === 'streaming',
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────────────
describe('audioIn face — the promotion itself', () => {
  it('the def in the REGISTRY declares the face (not just this import)', () => {
    const live = getModuleDef('audioIn');
    expect(live, 'audioIn must be registered').toBeTruthy();
    expect(live!.face, 'the registered def is what the shell reads').toBeTruthy();
    expect(live!.face).toBe(audioInDef.face);
  });

  it('is PROMOTED, and the two rosters agree', () => {
    expect(STRICT_FACES.has('audioIn')).toBe(true);
    expect(audioInDef.face).toBeTruthy();
  });

  it('ranks exactly the one param it has, as a FADER, with the fader as hero', () => {
    const face = audioInDef.face!;
    expect(face.order).toEqual(['gain']);
    // A level is a THROW. Undeclared it silently becomes a dial, and every gate
    // in the tree passes a knob that moves the same value.
    expect(face.paramCells).toEqual({ gain: 'fader' });
    expect(face.hero).toEqual({ control: 'gain' });
    // NOT `hero.cell` — that suppresses the shell glyph at the dock, and this
    // face has a real one.
    expect(face.hero && 'cell' in face.hero).toBe(false);
    expect(face.pages, 'one ranked key cannot fill two bands').toBeUndefined();
  });

  it('declares the extension whose directory really exists', async () => {
    expect(audioInDef.face!.extension).toBe('audioIn');
    expect(shellExtensionIds()).toContain('audioIn');
    const ext = await loadShellExtension('audioIn');
    expect(ext, 'the id must resolve to a real slot map').toBeTruthy();
    // BOTH slots. `fullViewBody` alone is the shipped `cameraInput` regression:
    // its lane tile could neither pick a device nor START one — and here ENABLE
    // is the only route to a first getUserMedia grant.
    expect(ext!.fullViewBody, 'the dock + the 🎧 tray').toBeTruthy();
    expect(ext!.tileBody, 'the LANE — the only route to a first permission grant').toBeTruthy();
    // No module-specific glyph: the shell's own live meter is the picture.
    expect(ext!.glyph).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('audioIn face — the LANE PICTURE is live, and its twin proves the test can fail', () => {
  it('resolves a LIVE audio glyph bound to the first audio output', () => {
    expect(primaryAudioOutPortId(audioInDef)).toBe('audio_l_out');
    const b = glyphBinding(audioInDef);
    expect(b.kind, 'a capture binder that cannot show its own signal is a dead tile').toBe(
      'live-audio',
    );
    expect(b).toEqual({ kind: 'live-audio', portId: 'audio_l_out' });
  });

  it('NEGATIVE CONTROL: audioOut — the same helper, the same declared glyph kind — is refused', () => {
    // Without this leg, "glyphBinding returned live-audio" is satisfied by a
    // resolver that returns live-audio for everything. audioOut declares
    // `outputs: []`, so the id is null and every live literal falls to static —
    // which is exactly why its own face declares `glyph: 'none'`.
    expect(primaryAudioOutPortId(audioOutDef)).toBeNull();
    const asIfMetered = { ...audioOutDef, face: { ...audioOutDef.face!, glyph: 'meter' as const } };
    expect(glyphBinding(asIfMetered).kind).toBe('static');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('audioIn — the auto-acquire claim (the IRREVERSIBLE hazard of a second surface)', () => {
  const NID = 'audioin-auto-node';
  const engine = { get: () => null } as unknown as Parameters<typeof nodeAudioInput.adopt>[1];

  beforeEach(() => {
    nodeAudioInput.sweep([]); // drop every entry — the graph-lifetime teardown
  });
  afterEach(() => {
    nodeAudioInput.sweep([]);
  });

  it('an un-adopted node cannot claim anything', () => {
    // The order matters: `adopt` is what creates the entry, and `request()`
    // returns IDLE without one. A claim on an unknown id would be a caller
    // believing it had permission to open a device for a node that does not
    // exist here.
    expect(nodeAudioInput.beginAutoAcquire(NID)).toBe(false);
  });

  it('exactly ONE of two mounted surfaces gets the claim', () => {
    nodeAudioInput.adopt(NID, engine);
    // The lane tile and the dock full view are both mounted — the ordinary state
    // when a player expands the module. `request()` calls `#releaseTracks`
    // FIRST, so two acquires would stop each other's tracks, and
    // `MediaStreamTrack.stop()` cannot be undone.
    expect(nodeAudioInput.beginAutoAcquire(NID)).toBe(true);
    expect(nodeAudioInput.beginAutoAcquire(NID)).toBe(false);
  });

  it('a claim is refused while the node is NOT idle', () => {
    nodeAudioInput.adopt(NID, engine);
    nodeAudioInput.setStatus(NID, 'streaming', null);
    expect(
      nodeAudioInput.beginAutoAcquire(NID),
      'a live capture must never be interrupted by a surface merely mounting',
    ).toBe(false);
  });

  it('THE CASE A STATE-ONLY GUARD FAILS: a re-mount after a deliberate STOP', () => {
    // `stop(id)` is the player's own control and returns the entry to `idle`. A
    // guard that read only the state would therefore re-acquire on the next
    // expand, and the STOP button would be un-obeyable — the module would
    // re-open a microphone the player had just closed. That is why the claim is
    // once-per-NODE and lives on the entry.
    nodeAudioInput.adopt(NID, engine);
    expect(nodeAudioInput.beginAutoAcquire(NID)).toBe(true);
    nodeAudioInput.stop(NID);
    expect(nodeAudioInput.view(NID).state).toBe('idle');
    expect(nodeAudioInput.beginAutoAcquire(NID)).toBe(false);
  });

  it('the claim is swept with the NODE, so a re-added node starts fresh', () => {
    nodeAudioInput.adopt(NID, engine);
    expect(nodeAudioInput.beginAutoAcquire(NID)).toBe(true);
    nodeAudioInput.sweep([]); // the node left the graph
    nodeAudioInput.adopt(NID, engine);
    expect(nodeAudioInput.beginAutoAcquire(NID)).toBe(true);
  });

  it('the registry still exposes NO card-lifecycle teardown — the #1590 structural guard', () => {
    // The registry's own header names this absence as the guard. Asserted here
    // as well as in its own file, because this promotion is what added a second
    // and third mount site to tempt one into existence.
    for (const forbidden of ['dispose', 'teardown', 'onCardUnmount', 'unmount', 'release']) {
      expect(
        (nodeAudioInput as unknown as Record<string, unknown>)[forbidden],
        `\`${forbidden}\` must not exist: a surface unmount must never be able to stop the tracks`,
      ).toBeUndefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('audioIn face — the eight-state machine survives, on `detail` not on a caption', () => {
  it('every state has a real sentence', () => {
    for (const s of ALL_STATES) {
      const detail = inputStatusDetail(viewOf(s));
      expect(detail.length, `${s} must announce something`).toBeGreaterThan(10);
    }
  });

  it('the eight sentences are DISTINCT — the card had eight labels and lost none', () => {
    const said = ALL_STATES.map((s) => inputStatusDetail(viewOf(s)));
    expect(new Set(said).size).toBe(ALL_STATES.length);
  });

  it('the STEREO/MONO badge is deleted from the face and folded into the sentence', () => {
    // The card painted `stereo` / `mono` as a text node beside its LED. Gone —
    // but the FACT is not: a player who wants it hovers the lamp.
    const stereo = inputStatusDetail(viewOf('streaming', { liveChannels: 2 }));
    const mono = inputStatusDetail(viewOf('streaming', { liveChannels: 1 }));
    expect(stereo).not.toBe(mono);
    expect(stereo).toMatch(/stereo/i);
    expect(mono).toMatch(/mono/i);
  });

  it('a real error message is carried verbatim rather than replaced by a generic line', () => {
    const v = viewOf('error', { errorMsg: 'NotReadableError: Could not start audio source' });
    expect(inputStatusDetail(v)).toBe('NotReadableError: Could not start audio source');
  });

  it('LIVE lights only while streaming; FAULT only for a REASON (never at idle)', () => {
    for (const s of ALL_STATES) {
      expect(inputLiveLit(viewOf(s)), `LIVE @ ${s}`).toBe(s === 'streaming');
    }
    expect(inputFaultLit(viewOf('idle')), 'a red lamp for "not switched on yet" cries wolf').toBe(
      false,
    );
    expect(inputFaultLit(viewOf('requesting'))).toBe(false);
    expect(inputFaultLit(viewOf('streaming'))).toBe(false);
    for (const s of ['permission-denied', 'no-inputs-found', 'device-in-use', 'unsupported', 'error'] as const) {
      expect(inputFaultLit(viewOf(s)), `FAULT @ ${s}`).toBe(true);
    }
  });

  it('TWO lamps are needed, and this is the pair that proves it', () => {
    // `StatusLed`'s caption is STATIC by contract, so a single lamp cannot
    // separate "not running because nobody asked" from "not running because the
    // browser refused" — and those are the two states a player has to tell apart
    // before they can act.
    const idle = { live: inputLiveLit(viewOf('idle')), fault: inputFaultLit(viewOf('idle')) };
    const denied = {
      live: inputLiveLit(viewOf('permission-denied')),
      fault: inputFaultLit(viewOf('permission-denied')),
    };
    expect(idle).not.toEqual(denied);
  });

  it('the STATE WORD reaches aria/title ONLY — the deleted readout, negative-controlled', () => {
    // The resting-text ruling permits a control CAPTION and refuses a state
    // word. `StatusLed`'s caption is a literal at the call site; the sentence
    // goes to `aria-label`/`title` through the model below. This asserts the
    // split at the seam, which is the half `face-resting-text-source.test.ts`
    // says it cannot see.
    const detail = inputStatusDetail(viewOf('permission-denied'));
    const label = statusLedLabel({ caption: 'FAULT', lit: true, detail });
    const title = statusLedTitle({ caption: 'FAULT', lit: true, detail });
    expect(label).toContain(detail);
    expect(title).toBe(detail);
    // The CAPTION is identical lit and unlit — that is what makes it a caption
    // and not a state word wearing one.
    expect(statusLedLabel({ caption: 'FAULT', lit: true }).startsWith('FAULT ')).toBe(true);
    expect(statusLedLabel({ caption: 'FAULT', lit: false }).startsWith('FAULT ')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('audioIn face — the ACTION is reachable in every state that needs one', () => {
  it('maps each state to the gesture the card offered', () => {
    expect(inputActionKind(viewOf('idle'))).toBe('enable');
    expect(inputActionKind(viewOf('no-inputs-found'))).toBe('enable');
    expect(inputActionKind(viewOf('permission-denied'))).toBe('retry-permission');
    expect(inputActionKind(viewOf('device-in-use'))).toBe('retry');
    expect(inputActionKind(viewOf('error'))).toBe('retry');
    expect(inputActionKind(viewOf('streaming'))).toBe('stop');
    // Nothing to press mid-request (pressing would tear down the attempt), and
    // nothing to press on a browser with no getUserMedia at all.
    expect(inputActionKind(viewOf('requesting'))).toBeNull();
    expect(inputActionKind(viewOf('unsupported'))).toBeNull();
  });

  it('ENABLE exists in the compact tier too — the cameraInput regression, refused', () => {
    // cameraInput shipped its acquire in `fullViewBody` alone and the lane tile
    // could not START a camera. Here that would be worse: no card is mounted
    // anywhere after promotion, so a missing tile gesture means no first
    // permission grant is reachable without expanding the module.
    for (const compact of [true, false]) {
      expect(inputActionLabel('enable', compact).length).toBeGreaterThan(0);
      expect(inputActionLabel('retry-permission', compact).length).toBeGreaterThan(0);
      expect(inputActionLabel('stop', compact)).toBe('STOP');
    }
    // The compact captions are SHORTER, not absent — the 192 px tile.
    expect(inputActionLabel('enable', true).length).toBeLessThan(
      inputActionLabel('enable', false).length,
    );
  });

  it('the picker announces WHY it is empty, unpainted', () => {
    const v = viewOf('idle');
    expect(inputPickerValueText(v, 0, null)).toMatch(/no audio inputs/i);
    expect(inputPickerValueText(v, 2, null)).toMatch(/pick one/i);
    expect(inputPickerValueText(viewOf('streaming'), 2, 'ES-9')).toMatch(/capturing from ES-9/i);
  });

  // ── AN EMPTY ROSTER MUST NEVER DISABLE **STOP** ───────────────────────────
  //
  // The shipped guard was `action === null || options.length === 0`, and one
  // button serves ENABLE / RETRY / STOP — so an emptied roster took away the
  // only control that CLOSES a live microphone. The legacy card never did it:
  // `AudioinCard` gated `audioin-enable` on the roster and gave
  // `audioin-disable` no `disabled` attribute at all.
  //
  // The e2e arm drives the reachable version of this — a STREAMING node whose
  // roster is emptied by a `devicechange` whose `enumerateDevices()` rejects —
  // in `e2e/tests/audio-in.spec.ts`. This is the exhaustive table under it.
  it('STOP survives an EMPTY roster; ENABLE and RETRY do not', () => {
    // The half that was always right: nothing to open ⇒ no acquire gesture.
    expect(inputActionDisabled('enable', 0), 'ENABLE with nothing to open').toBe(true);
    expect(inputActionDisabled('retry', 0), 'RETRY with nothing to open').toBe(true);
    expect(inputActionDisabled('retry-permission', 0)).toBe(true);
    // The half that shipped wrong. A live capture is live whatever the roster
    // says, and the microphone indicator is lit while it is.
    expect(
      inputActionDisabled('stop', 0),
      'a live microphone with an emptied roster must still be switch-off-able',
    ).toBe(false);
    // Nothing to press mid-request or on a browser with no getUserMedia.
    expect(inputActionDisabled(null, 0)).toBe(true);
    expect(inputActionDisabled(null, 3)).toBe(true);
    // With devices present every gesture is live.
    for (const k of ['enable', 'retry', 'retry-permission', 'stop'] as const) {
      expect(inputActionDisabled(k, 3), `${k} with a populated roster`).toBe(false);
    }
  });

  // POSITIVE CONTROL for the table above: the exact predicate that shipped,
  // written out here, is what the fix had to stop being. If someone reverts
  // `inputActionDisabled` to it, the test above goes red — and this asserts
  // that the two really do differ on the state that matters, so the guard is
  // not vacuous.
  it('POSITIVE CONTROL: the SHIPPED predicate disagrees, and only about STOP', () => {
    const shipped = (a: ReturnType<typeof inputActionKind>, n: number) => a === null || n === 0;
    const kinds = ['enable', 'retry', 'retry-permission', 'stop', null] as const;
    const differ = kinds.filter((k) => shipped(k, 0) !== inputActionDisabled(k, 0));
    expect(differ, 'the fix must change STOP@empty-roster and nothing else').toEqual(['stop']);
    for (const k of kinds) {
      expect(shipped(k, 3), `${k} with devices`).toBe(inputActionDisabled(k, 3));
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('audioIn — the device roster and the constraints it builds', () => {
  const devices: MinimalDevice[] = [
    { deviceId: 'default', label: '', kind: 'audioinput' },
    { deviceId: 'es9', label: 'ES-9', kind: 'audioinput' },
  ];

  it('renders the browser pre-permission fallback as INPUT, not "Device"', () => {
    const opts = inputDeviceOptions(devices);
    expect(opts).toEqual([
      { value: 'default', label: 'Input #1' },
      { value: 'es9', label: 'ES-9' },
    ]);
  });

  it('asks for a stereo pair, and honours the saved device EXACTLY', () => {
    const node = { data: { [INPUT_DEVICE_KEY]: 'es9' } } as unknown as ModuleNode;
    const c = audioInConstraints(node, devices) as { audio: MediaTrackConstraints };
    expect(c.audio.channelCount).toBe(2);
    expect(c.audio.deviceId).toEqual({ exact: 'es9' });
    // ⚠ Chrome caps this device at TWO channels (measured against a real ES-9:
    // getCapabilities().channelCount → {max: 2}; channelCount:{exact:4} throws
    // OverconstrainedError). Nothing here may ask for more.
    expect(JSON.stringify(c)).not.toMatch(/channelCount":\s*[3-9]/);
  });

  it('falls back to the roster default when nothing is saved', () => {
    const c = audioInConstraints(undefined, devices) as { audio: MediaTrackConstraints };
    // `default` is the browser pseudo-id for "follow the OS default", so it is
    // expressed as NO deviceId constraint rather than an exact match on a
    // pseudo-id.
    expect(c.audio.deviceId).toBeUndefined();
  });

  it('music mode forces the capture DSP off, and only when asked', () => {
    const plain = audioInConstraints(undefined, devices) as { audio: MediaTrackConstraints };
    expect(plain.audio.autoGainControl).toBeUndefined();
    const node = { data: { [MUSIC_MODE_KEY]: true } } as unknown as ModuleNode;
    const music = audioInConstraints(node, devices) as { audio: MediaTrackConstraints };
    expect(music.audio.echoCancellation).toBe(false);
    expect(music.audio.noiseSuppression).toBe(false);
    expect(music.audio.autoGainControl).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('audioIn — the picks are DELIBERATELY NOT UNDOABLE (both directions)', () => {
  const NID = 'audioin-face-model-node';

  function makeNode(): void {
    ydoc.transact(() => {
      patch.nodes[NID] = {
        id: NID,
        type: 'audioIn',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: { gain: 1 },
        data: {},
      } as ModuleNode;
    }, LOCAL_ORIGIN);
    undoManager.clear();
    undoManager.stopCapturing();
  }

  beforeEach(() => {
    for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    undoManager.clear();
    undoManager.stopCapturing();
  });
  afterEach(() => {
    for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    undoManager.clear();
  });

  it('writes the device key, and Cmd-Z does NOT see it', () => {
    makeNode();
    setInputDevice(NID, 'es9');
    expect(inputDeviceValue(patch.nodes[NID] as ModuleNode)).toBe('es9');
    expect(
      undoManager.undoStack.length,
      'undo walks the PATCH. Re-opening a different physical input is not a patch edit — and a ' +
        're-acquire stops the outgoing tracks FIRST, which is irreversible.',
    ).toBe(0);
  });

  it('music mode is on the same non-tracked origin', () => {
    makeNode();
    setInputMusicMode(NID, true);
    expect(inputMusicMode(patch.nodes[NID] as ModuleNode)).toBe(true);
    expect(undoManager.undoStack.length).toBe(0);
  });

  it('POSITIVE CONTROL: a param edit on the SAME node in the SAME suite IS undoable', () => {
    // Without this leg, "0 undo entries" is satisfied by an UndoManager that is
    // simply not recording in this file — the shape that makes a deliberate
    // non-tracked origin indistinguishable from a broken harness.
    makeNode();
    setNodeParam(NID, 'gain', 0.25);
    expect(patch.nodes[NID]!.params.gain).toBe(0.25);
    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(patch.nodes[NID]!.params.gain).toBe(1);
  });

  it('the origin is a NAMED symbol, not LOCAL_ORIGIN by accident', () => {
    expect(typeof AUDIO_IN_DEVICE_ORIGIN).toBe('symbol');
    expect(AUDIO_IN_DEVICE_ORIGIN).not.toBe(LOCAL_ORIGIN);
  });

  it('OFF deletes the music-mode key rather than storing `false`', () => {
    makeNode();
    setInputMusicMode(NID, true);
    setInputMusicMode(NID, false);
    expect(patch.nodes[NID]!.data![MUSIC_MODE_KEY]).toBeUndefined();
  });
});
