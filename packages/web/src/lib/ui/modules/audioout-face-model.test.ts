// packages/web/src/lib/ui/modules/audioout-face-model.test.ts
//
// ⚠ THIS FILE EXISTS BECAUSE THE GENERIC GATES PASS ALMOST VACUOUSLY OVER THIS
// FACE. `audioOutDef` declares ONE param, so `module-face-lint`'s completeness
// check, the dock render-plan parity check and `faces-parity` each enumerate a
// single cell — their green runs would look nearly identical if everything this
// promotion actually added were broken. That is `blind-gates.md`'s question
// ("would its green run look any different if the answer were 'everything'?")
// answered in the affirmative, so the real coverage is written here.
//
// What only this file can see:
//   * the METER reads the PER-CHANNEL taps, never the mono one — and the two
//     states where that distinction is the whole point are PERMANENT NEGATIVE
//     CONTROLS (§ "the mono key is blind", below);
//   * the two DEAD PICKER states are distinguishable, which the card could not
//     do on either its disabled attribute or its notice;
//   * the device pick is DELIBERATELY not undoable — asserted in BOTH
//     directions against a real Y.Doc, so neither half can flip silently;
//   * the lane picture's refusal is MECHANICAL, with a positive control proving
//     the helper can return non-null.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { audioOutDef } from '$lib/audio/modules/audio-out';
import { analogVcoDef } from '$lib/audio/modules/analog-vco';
import { getModuleDef } from '$lib/audio/module-registry';
import '$lib/audio/modules';
import { primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { loadShellExtension, shellExtensionIds } from '$lib/ui/workflow/shell-extensions';
import {
  AUDIO_OUT_METER_FLOOR_DB,
  AUDIO_OUT_METER_KEYS,
  ceilingFraction,
  meterFraction,
  meterValueText,
  peakDbOf,
  readTerminalLevels,
} from '$lib/ui/modules/audioOut/audio-out-meter';
import {
  PICKER_TEXT,
  outputDeviceLabelFrom,
  outputDeviceValueFrom,
  pickerBlockFrom,
  pickerValueTextFrom,
} from '$lib/audio/output-device-model';
import { AUDIO_OUT_SINK_ORIGIN, setOutputDevice } from '$lib/audio/output-device.svelte';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { setNodeParam } from '$lib/graph/mutate';
import type { ModuleNode } from '$lib/graph/types';
import type { MinimalDevice } from '$lib/audio/devices';

const SR = 48000;

/** A buffer whose PEAK is exactly `amp`. */
function toneAt(amp: number, n = 256): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * i) / n);
  return out;
}

/** A `read` that answers the PER-CHANNEL keys and RECORDS what it was asked
 *  for — so "the meter reads the right keys" is a measurement rather than a
 *  claim about source someone remembered to write. */
function stereoRead(left: Float32Array, right: Float32Array) {
  const asked: string[] = [];
  const read = (key: string): unknown => {
    asked.push(key);
    if (key === 'outputSnapshotL') return { samples: left, sampleRate: SR };
    if (key === 'outputSnapshotR') return { samples: right, sampleRate: SR };
    // The mono key is the DOWNMIX, and answering it here is what makes the
    // negative control below meaningful: a body that regressed to it would get
    // a plausible-looking number.
    if (key === 'outputSnapshot') {
      const n = Math.max(left.length, right.length);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) mono[i] = ((left[i] ?? 0) + (right[i] ?? 0)) / 2;
      return { samples: mono, sampleRate: SR };
    }
    return undefined;
  };
  return { read, asked };
}

describe('audioOut face — the DECLARATION is a claim about the module', () => {
  it('ranks the one param it has, as a FADER', () => {
    expect(audioOutDef.params.map((p) => p.id)).toEqual(['master']);
    expect(audioOutDef.face?.order).toEqual(['master']);
    // ⚠ UNDECLARED THIS SILENTLY BECOMES A DIAL. `'fader'` and `'hue'` are the
    // two primitives the shell cannot infer — `0..1 linear` is the same shape
    // as any other continuous scalar — and the card has always drawn a
    // NeonFader here. `noise` carries this declaration for the same reason.
    expect(audioOutDef.face?.paramCells).toEqual({ master: 'fader' });
  });

  it('promotes the fader into the HERO, so the dock renders no band of one', () => {
    // ⚠ THIS IS THE LEG THAT CAUGHT THE FIRST DRAFT. Without a hero the single
    // ranked key stays in the page-less `__all` band, and the dock paints ONE
    // labelled section band containing one fader — a labelled void, which is
    // what `heroFacePlan`'s band-drop exists to remove. `noise` (one param,
    // also a fader) declares a hero for the same reason, and the VRT roster's
    // `pages: 0` is only true WITH it.
    expect(audioOutDef.face?.hero).toEqual({ control: 'master' });
    // `hero.control`, never `hero.cell`: a `hero.cell` suppresses the shell
    // glyph at the dock and there is no glyph here to suppress. The BODY takes
    // the hero picture's place; the hero control sits beside it.
    expect(audioOutDef.face?.hero?.cell).toBeUndefined();
    expect(audioOutDef.face?.pages).toBeUndefined();
    expect(audioOutDef.face?.tabbed).toBeUndefined();
  });

  it('is PROMOTED, and the def this file asserts about is the one the registry renders', () => {
    // An authored face outside STRICT_FACES ships as a no-op.
    expect(STRICT_FACES.has('audioOut')).toBe(true);
    // Anchored: a rename would otherwise leave every leg here testing a def
    // nothing mounts.
    expect(getModuleDef('audioOut')).toBe(audioOutDef);
  });
});

describe('audioOut face — the LANE PICTURE is refused MECHANICALLY', () => {
  it('declares glyph none, and the reason is `outputs: []` rather than taste', () => {
    expect(audioOutDef.face?.glyph).toBe('none');
    // THE MECHANISM. `primaryAudioOutPortId` finds the first `audio` OUTPUT
    // port; a terminal sink has none, so every live-glyph literal falls to
    // `{kind:'static'}` and the dead-glyph clause catches it. This is what
    // protects an author who never read the argument — so it is pinned, because
    // the day someone gives audioOut a thru output the protection vanishes
    // silently.
    expect(audioOutDef.outputs).toEqual([]);
    expect(primaryAudioOutPortId(audioOutDef)).toBeNull();
  });

  it('POSITIVE CONTROL: the same helper DOES resolve a port on a module that has one', () => {
    // Without this, "returns null" is satisfied by a helper that returns null
    // for everything — which is the shape that makes a mechanical refusal
    // indistinguishable from a broken probe.
    expect(primaryAudioOutPortId(analogVcoDef)).not.toBeNull();
  });
});

describe('audioOut face — the BESPOKE SURFACE', () => {
  it('declares the extension, and the extension actually resolves a fullViewBody', async () => {
    // An id the glob did not discover resolves `null` and the render degrades
    // SILENTLY to the generic shell — which, on a face with one cell, is a
    // faceplate with a fader on it and no meter and no picker. Only a test
    // separates "mounted" from "silently absent".
    const id = audioOutDef.face?.extension;
    expect(id).toBe('audioOut');
    expect(shellExtensionIds()).toContain('audioOut');
    const ext = await loadShellExtension(id!);
    expect(ext, 'the declared extension id must resolve to a discovered module').not.toBeNull();
    expect(typeof ext?.fullViewBody, 'the fullViewBody slot must be filled').toBe('function');
    // NO GLYPH SLOT: there is no live glyph to mount (see the block above), so a
    // component here would be one nothing ever renders.
    expect(ext?.glyph).toBeUndefined();
  });
});

describe('audioOut meter — the mono key is BLIND, and these are the permanent controls', () => {
  it('reads the PER-CHANNEL keys and never the mono downmix', () => {
    const { read, asked } = stereoRead(toneAt(0.5), toneAt(0.5));
    readTerminalLevels(read);
    expect([...new Set(asked)].sort()).toEqual([...AUDIO_OUT_METER_KEYS].sort());
    expect(asked, 'the mono downmix must never be read by the meter').not.toContain(
      'outputSnapshot',
    );
  });

  it('STATE 2 — mono into L only: L moves, R sits at the floor', () => {
    const { read } = stereoRead(toneAt(0.5), new Float32Array(256));
    const lv = readTerminalLevels(read)!;
    expect(lv.l).toBeGreaterThan(AUDIO_OUT_METER_FLOOR_DB + 20);
    expect(lv.r).toBe(AUDIO_OUT_METER_FLOOR_DB);
    expect(meterValueText(lv)).toMatch(/^left -?\d+\.\d dBFS, right silent/);

    // ⚠ THE CONTROL. The mono downmix of this exact stimulus reads HALF LEVEL —
    // measured in `audio-out.ts`'s own header — which is indistinguishable from
    // a quieter signal in BOTH channels. A meter built on it could not have
    // failed this test, which is why the test drives the read function rather
    // than the numbers.
    const mono = peakDbOf(
      (read('outputSnapshot') as { samples: Float32Array }).samples,
    );
    expect(
      mono,
      'the mono tap reads ~6 dB low for a one-sided signal — it cannot say WHICH side',
    ).toBeLessThan(lv.l - 5);
  });

  it('STATE 3 — an ANTI-PHASE pair: BOTH bars move, where the mono tap reads silence', () => {
    const a = toneAt(0.5);
    const b = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) b[i] = -a[i]!;
    const { read } = stereoRead(a, b);
    const lv = readTerminalLevels(read)!;
    expect(lv.l).toBeGreaterThan(AUDIO_OUT_METER_FLOOR_DB + 20);
    expect(lv.r).toBeGreaterThan(AUDIO_OUT_METER_FLOOR_DB + 20);
    expect(meterValueText(lv)).not.toBe('silent');

    // ⚠ THE SHARPER HALF OF THE SAME CONTROL: on this stimulus the mono tap
    // reads EXACTLY ZERO. "Perfectly silent" and "perfectly cancelling" are the
    // same number there, and they are the two states a player most needs
    // separated. A regression to the mono key turns this face's picture into a
    // flat line on a rack that is making noise.
    const mono = peakDbOf((read('outputSnapshot') as { samples: Float32Array }).samples);
    expect(mono, 'the mono tap cancels to the floor on an anti-phase pair').toBe(
      AUDIO_OUT_METER_FLOOR_DB,
    );
  });

  it('STATE 1 — nothing patched: both at the floor, and the text says silent', () => {
    const { read } = stereoRead(new Float32Array(256), new Float32Array(256));
    const lv = readTerminalLevels(read)!;
    expect(lv.l).toBe(AUDIO_OUT_METER_FLOOR_DB);
    expect(lv.r).toBe(AUDIO_OUT_METER_FLOOR_DB);
    expect(lv.limiting).toBe(false);
    expect(meterValueText(lv)).toBe('silent');
    expect(meterFraction(lv.l)).toBe(0);
  });

  it('STATE 4 — at the ceiling: the bars pin and the text says limiting', () => {
    // The tap is measured AFTER the brickwall, so the terminal peak cannot
    // EXCEED the ceiling; sitting ON it is what limiting looks like from here.
    const hot = toneAt(1.0);
    const { read } = stereoRead(hot, hot);
    const lv = readTerminalLevels(read)!;
    expect(lv.limiting).toBe(true);
    expect(meterValueText(lv)).toMatch(/, limiting$/);
    expect(meterFraction(lv.l)).toBeGreaterThan(ceilingFraction());
  });

  it('an engine that answers only the MONO key yields NO reading — the body draws idle', () => {
    // "Found nothing" and "the body failed to mount" must not be the same
    // picture, and `null` is what the body branches on to draw the idle field.
    const monoOnly = (key: string): unknown =>
      key === 'outputSnapshot' ? { samples: toneAt(0.5), sampleRate: SR } : undefined;
    expect(readTerminalLevels(monoOnly)).toBeNull();
    expect(meterValueText(null)).toBe('output level unavailable');
  });

  it('the ceiling mark is inside the bar and above every tick — the picture is readable', () => {
    const ceil = ceilingFraction();
    expect(ceil).toBeGreaterThan(0);
    expect(ceil).toBeLessThan(1);
    for (const db of [-24, -12, -6]) expect(meterFraction(db)).toBeLessThan(ceil);
  });
});

describe('audioOut picker — the TWO DEAD CAUSES the card could not tell apart', () => {
  const one: MinimalDevice[] = [{ deviceId: 'default', label: '', kind: 'audiooutput' }];

  it('STATE 5 — setSinkId unsupported: disabled, and it says which browser fact caused it', () => {
    const block = pickerBlockFrom(false, one.length);
    expect(block).toBe('unsupported');
    expect(pickerValueTextFrom(block, 'Default')).toBe(PICKER_TEXT.unsupported);
  });

  it('STATE 6 — supported but ZERO devices enumerated: disabled, and it says THAT instead', () => {
    const block = pickerBlockFrom(true, 0);
    expect(block).toBe('no-devices');
    expect(pickerValueTextFrom(block, 'Default')).toBe(PICKER_TEXT.noDevices);
  });

  it('the two dead states are DISTINGUISHABLE — which is the whole defect', () => {
    // On the card both produced a greyed `(no outputs)`; only one of them
    // produced any explanation, and it was the one that could not be reached by
    // the other cause. This is the assertion that would have been red.
    expect(PICKER_TEXT.unsupported).not.toBe(PICKER_TEXT.noDevices);
    expect(pickerBlockFrom(false, 0)).not.toBe(pickerBlockFrom(true, 0));
    // …and unsupported WINS when both hold: a browser that cannot do this at
    // all is not a hardware-hunting problem.
    expect(pickerBlockFrom(false, 0)).toBe('unsupported');
  });

  it('a live picker is not blocked, and names the device rather than a state word', () => {
    expect(pickerBlockFrom(true, one.length)).toBeNull();
    expect(pickerValueTextFrom(null, 'Studio Monitors')).toBe('Studio Monitors');
  });

  it('the saved id wins over the browser default, and an empty save falls back', () => {
    const devices: MinimalDevice[] = [
      { deviceId: 'default', label: '', kind: 'audiooutput' },
      { deviceId: 'usb-es9', label: 'ES-9', kind: 'audiooutput' },
    ];
    expect(outputDeviceValueFrom('usb-es9', devices)).toBe('usb-es9');
    expect(outputDeviceValueFrom(undefined, devices)).toBe('default');
    // ⚠ AND THE LABEL NAMES A DIRECTION. Pre-permission the browser empties
    // `label`, and this helper used to render `Input #1` for an OUTPUT device —
    // on a fresh rack that was every entry in this picker.
    expect(outputDeviceLabelFrom('usb-es9', devices)).toBe('ES-9');
    expect(
      outputDeviceLabelFrom(
        'x',
        [{ deviceId: 'x', label: '', kind: 'audiooutput' }],
      ),
    ).toBe('Output #1');
  });
});

describe('audioOut picker — the pick is DELIBERATELY NOT UNDOABLE (both directions)', () => {
  const NID = 'audioout-face-model-node';

  function makeNode(): void {
    ydoc.transact(() => {
      patch.nodes[NID] = {
        id: NID,
        type: 'audioOut',
        domain: 'audio',
        position: { x: 0, y: 0 },
        params: { master: 0.7 },
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

  it('writes the key, and Cmd-Z does NOT see it', () => {
    makeNode();
    setOutputDevice(NID, 'usb-es9');
    // The write LANDED — this is not "non-undoable because nothing happened".
    expect(patch.nodes[NID]!.data!['outputDeviceId']).toBe('usb-es9');
    expect(
      undoManager.undoStack.length,
      'a device pick must not land on the patch undo stack: undo walks the PATCH, and which ' +
        'speakers the browser is talking to is a per-machine routing fact, not a patch edit',
    ).toBe(0);
  });

  it('POSITIVE CONTROL: a param edit on the SAME node in the SAME suite IS undoable', () => {
    // Without this leg, "0 undo entries" is satisfied by an UndoManager that is
    // simply not recording anything in this test file — the exact shape that
    // makes a deliberate non-tracked origin indistinguishable from a broken
    // harness.
    makeNode();
    setNodeParam(NID, 'master', 0.25);
    expect(patch.nodes[NID]!.params.master).toBe(0.25);
    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(patch.nodes[NID]!.params.master).toBe(0.7);
  });

  it('the origin is a NAMED symbol, not LOCAL_ORIGIN by accident', () => {
    // The old card write was a bare proxy assignment — untransacted, origin-less
    // and therefore ACCIDENTALLY non-undoable. This asserts the decision is a
    // decision: a distinct, named, non-tracked origin.
    expect(typeof AUDIO_OUT_SINK_ORIGIN).toBe('symbol');
    expect(AUDIO_OUT_SINK_ORIGIN).not.toBe(LOCAL_ORIGIN);
  });

  it('clearing the pick DELETES the key rather than storing an empty string', () => {
    makeNode();
    setOutputDevice(NID, 'usb-es9');
    setOutputDevice(NID, '');
    expect(patch.nodes[NID]!.data!['outputDeviceId']).toBeUndefined();
  });
});
