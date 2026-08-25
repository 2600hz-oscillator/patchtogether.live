// packages/web/src/lib/ui/modules/vst-face-model.test.ts
//
// The VST BRIDGE faces' module-local pins — the half of the promotion that no
// registry-driven sweep can see.
//
// TWO THINGS ARE PINNED HERE, and the second is the reason the file exists:
//
//   1. THE FACE SHAPE. Both defs declare `params: []`, so `faces-parity`'s
//      exact-multiset check over `control-*` testids is VACUOUSLY satisfiable —
//      an empty param set equals an empty cell set no matter what the face says.
//      The structural claims (two ranked family keys, one page, no hero, the
//      shared extension) therefore need asserting here or nowhere.
//
//   2. EVERY STRING THE FOUR LAMPS CAN PRODUCE, INCLUDING THE ONES NO RUNNER
//      WILL EVER RENDER. This is the point. `vst-status-model.ts` is where three
//      deleted readout rows went, and they went onto `aria-label`/`title` — a
//      VRT baseline cannot see them, and on a CI runner the bridge never
//      connects, so the ONLY states a browser ever exercises are the dark ones.
//      A wrong sentence in the `connected` branch would ship green forever. The
//      unit lane is the only place these are reachable, so it drives all seven
//      connection states, both mount outcomes, both meter regimes and all three
//      persistence regimes against hand-built snapshots.
//
// ⚠ THE NEGATIVE CONTROLS ARE PERMANENT LEGS, not scaffolding, and each calls
// the SAME predicate the positive leg calls. A lamp test that only ever asserts
// "the detail mentions the failure" passes on a function that returns one
// constant string; the paired assertions below fail on exactly that.

import { describe, expect, it } from 'vitest';
import { vstInstrumentDef, VST_INSTRUMENT_FACE } from '$lib/audio/modules/vst-instrument';
import { vstFxDef, VST_FX_FACE } from '$lib/audio/modules/vst-fx';
import {
  VST_FX_PLUGIN_KINDS,
  VST_INSTRUMENT_PLUGIN_KINDS,
  vstPluginKindsForType,
  vstSendPlanesForType,
} from '$lib/audio/modules/vst-bridge-shared';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import type { VstOwnerSnapshot } from '$lib/audio/vst/bridge-owner';
import type { VstConnectionState } from '$lib/audio/vst/bridge-client';
import {
  VST_LOAD_WARN_PCT,
  vstBridgeDetail,
  vstBridgeLit,
  vstLoadDetail,
  vstLoadLit,
  vstPluginDetail,
  vstPluginLit,
  vstSavedDetail,
  vstSavedLit,
} from './vstBridge/vst-status-model';

const CONNECT = 'vst-connect-{n}';
const DISCONNECT = 'vst-disconnect-{n}';

/** A snapshot at rest — the state EVERY CI runner sees, and the one the VRT
 *  baselines capture. Overridden per case below. */
function snapshot(over: Partial<VstOwnerSnapshot> = {}): VstOwnerSnapshot {
  return {
    state: 'disconnected',
    detail: undefined,
    helper: null,
    plugins: [],
    mounted: null,
    mountError: null,
    editorOpen: false,
    pluginState: null,
    stateSet: null,
    meters: null,
    rtt: null,
    supported: true,
    unmounts: 0,
    ...over,
  };
}

function mounted(over: Record<string, unknown> = {}) {
  return {
    type: 'mounted' as const,
    plugin: {
      id: 'au:aufx:dely:appl',
      name: 'AUDelay',
      manufacturer: 'Apple',
      version: '1.0',
      kind: 'effect' as const,
      format: 'au',
    },
    latencySamples: 512,
    tailSeconds: 2,
    audioInputChannels: 2,
    audioOutputChannels: 2,
    acceptsMidi: false,
    ...over,
  };
}

describe('the VST BRIDGE faces — shape', () => {
  const CASES = [
    { type: 'vstInstrument', def: vstInstrumentDef, face: VST_INSTRUMENT_FACE },
    { type: 'vstFx', def: vstFxDef, face: VST_FX_FACE },
  ] as const;

  for (const { type, def, face } of CASES) {
    describe(type, () => {
      it('is PROMOTED and its def carries the face object this file pins', () => {
        expect(STRICT_FACES.has(type)).toBe(true);
        // Identity, not deep equality: a copy would let the def and the pinned
        // constant drift into two faces that pass separately.
        expect(def.face).toBe(face);
      });

      it('declares NO params — which is why the face is two family keys', () => {
        // The premise of the whole design. If this ever stops being true the
        // ranking argument in the def's own header is void and the face must be
        // re-derived against the new params rather than extended.
        expect(def.params).toEqual([]);
      });

      it('ranks exactly the two gestures that can be cells, CONNECT first', () => {
        expect(face.order).toEqual([CONNECT, DISCONNECT]);
      });

      it('declares the two control families those keys resolve through', () => {
        expect(def.controlFamilies?.map((f) => f.id)).toEqual(['vst-connect', 'vst-disconnect']);
        // The testid prefixes are what `module-docs-lint`'s card-drift leg
        // greps for in real UI source; both live on the shared VstBridgePanel.
        expect(def.controlFamilies?.map((f) => f.testidPrefix)).toEqual([
          'vst-connect',
          'vst-disconnect',
        ]);
      });

      it('documents BOTH families under their template keys', () => {
        // ⚠ THE KEY IS THE TEMPLATE, NOT THE FAMILY ID. `docs.controls['vst-connect']`
        // resolves to nothing and module-docs-lint reports it as an ORPHAN — which
        // is how this was found. Pinned so the two spellings cannot drift apart
        // again.
        expect(Object.keys(def.docs?.controls ?? {}).sort()).toEqual([CONNECT, DISCONNECT].sort());
      });

      it('is ONE page whose controls are exactly the ranked keys', () => {
        expect(face.pages?.length).toBe(1);
        expect(face.pages?.[0]?.id).toBe('bridge');
        expect(face.pages?.[0]?.controls).toEqual([CONNECT, DISCONNECT]);
      });

      it('declares NO hero — one band of two keys cannot afford to lose either', () => {
        // `heroFacePlan` MOVES a key rather than copying it, so promoting either
        // of these would leave a band whose hint renders nowhere (and promoting
        // both would empty the band). A hero would also suppress the dock glyph,
        // which is this plate's only live picture.
        expect(face.hero).toBeUndefined();
      });

      it('rides the SHARED vstBridge extension and a derived meter glyph', () => {
        expect(face.extension).toBe('vstBridge');
        expect(face.glyph).toBe('meter');
      });

      it('authors NO rear groups — the derived default already names both rails', () => {
        expect(face.rear).toBeUndefined();
      });
    });
  }

  it('both defs share ONE extension id — the surface is literally one component', () => {
    expect(VST_INSTRUMENT_FACE.extension).toBe(VST_FX_FACE.extension);
  });

  it('the two faces are DISTINCT objects with distinct hints', () => {
    // ⚠ A NEGATIVE CONTROL ON THE TEST ABOVE. Sharing an extension is correct;
    // sharing a FACE would not be, because the two modules' bridge hints say
    // different things about what a dead helper costs (an instrument goes
    // silent; an fx insert bypasses locally and keeps the lane flowing). If
    // someone later collapses these into one object to "reduce duplication",
    // this fails and the cvBuddy/cvBuddyMini shared-face pattern has to be
    // adopted deliberately instead of by accident.
    expect(VST_INSTRUMENT_FACE).not.toBe(VST_FX_FACE);
    expect(VST_INSTRUMENT_FACE.pages?.[0]?.hint).not.toBe(VST_FX_FACE.pages?.[0]?.hint);
    expect(VST_FX_FACE.pages?.[0]?.hint).toContain('bypasses locally');
  });
});

describe('the shared plugin roster — ONE source for card and face', () => {
  it('resolves each module type to its own kinds', () => {
    expect(vstPluginKindsForType('vstInstrument')).toBe(VST_INSTRUMENT_PLUGIN_KINDS);
    expect(vstPluginKindsForType('vstFx')).toBe(VST_FX_PLUGIN_KINDS);
  });

  it('an instrument card never lists a pure EFFECT, and vice versa', () => {
    expect(VST_INSTRUMENT_PLUGIN_KINDS).toContain('instrument');
    expect(VST_INSTRUMENT_PLUGIN_KINDS).not.toContain('effect');
    expect(VST_FX_PLUGIN_KINDS).toContain('effect');
    expect(VST_FX_PLUGIN_KINDS).not.toContain('instrument');
    // `musicEffect` is legitimately on BOTH — an arpeggiator takes MIDI and can
    // sit in either chain — so its presence is the control that proves the two
    // rosters are not merely each other's complement.
    expect(VST_INSTRUMENT_PLUGIN_KINDS).toContain('musicEffect');
    expect(VST_FX_PLUGIN_KINDS).toContain('musicEffect');
  });

  it('an UNKNOWN type lists NOTHING rather than guessing', () => {
    // A caller that resolved the wrong node must show an empty picker, never
    // another module's plugins.
    expect(vstPluginKindsForType('tidyVco')).toEqual([]);
    expect(vstPluginKindsForType(undefined)).toEqual([]);
  });

  it('only the FX card sends audio planes', () => {
    // ⚠ NOT COSMETIC. An instrument transport that sent audio planes would push
    // silence into a synth's input bus every quantum.
    expect(vstSendPlanesForType('vstFx')).toBe(true);
    expect(vstSendPlanesForType('vstInstrument')).toBe(false);
    expect(vstSendPlanesForType(undefined)).toBe(false);
  });
});

describe('the BRIDGE lamp — every connection state, painted or not', () => {
  it('is LIT only when connected', () => {
    expect(vstBridgeLit(snapshot({ state: 'connected' }))).toBe(true);
    for (const s of ['idle', 'connecting', 'disconnected', 'busy', 'evicted', 'stopped'] as const) {
      expect(vstBridgeLit(snapshot({ state: s })), `state '${s}' must not light BRIDGE`).toBe(false);
    }
  });

  it('names the RECOVERABLE failures specifically — the two that most need it', () => {
    // Both are fixed by pressing the CONNECT the plate already offers, so a bare
    // dark lamp would read as "broken" instead of "press the button".
    expect(vstBridgeDetail(snapshot({ state: 'busy' }))).toContain('16');
    expect(vstBridgeDetail(snapshot({ state: 'evicted' }))).toContain('another tab');
    expect(vstBridgeDetail(snapshot({ state: 'evicted' }))).toContain('connect');
  });

  it('distinguishes "stopped here" from "the helper did not answer"', () => {
    // ⚠ THE NEGATIVE CONTROL ON THE NARROWING. Both render the SAME dark lamp,
    // which is the ruling's accepted trade — so the sentences must differ, or
    // the mitigation the model's own header claims does not exist.
    const stopped = vstBridgeDetail(snapshot({ state: 'stopped' }));
    const gone = vstBridgeDetail(snapshot({ state: 'disconnected' }));
    expect(stopped).not.toBe(gone);
    expect(stopped).toContain('stopped');
    expect(gone).toContain('did not answer');
  });

  it('reports the helper NAME and the round trip once connected', () => {
    // Unreachable on any runner — this branch exists only here.
    const s = snapshot({
      state: 'connected',
      helper: { type: 'helperInfo', protocolVersion: 1, name: 'vst-bridge', version: '2.1', rate: 48000, maxBlockFrames: 512, formats: ['au'] },
      rtt: 18.25,
    });
    const d = vstBridgeDetail(s);
    expect(d).toContain('vst-bridge');
    expect(d).toContain('2.1');
    expect(d).toContain('18.3 ms');
  });

  it('omits the round trip when there is none, rather than printing null', () => {
    const d = vstBridgeDetail(snapshot({ state: 'connected', rtt: null }));
    expect(d).toContain('connected');
    expect(d).not.toContain('round trip');
    expect(d).not.toContain('null');
  });

  it('UNSUPPORTED wins over the connection state', () => {
    // `supported: false` means no Worker/SAB at all, so whatever the state
    // machine says is beside the point.
    const d = vstBridgeDetail(snapshot({ supported: false, state: 'connecting' }));
    expect(d).toContain('SharedArrayBuffer');
  });

  it('produces a DISTINCT sentence for every state (no constant-string pass)', () => {
    // ⚠ THE PERMANENT NEGATIVE CONTROL. Every assertion above would pass on a
    // function that returned one string for everything. This one cannot.
    const states: VstConnectionState[] = [
      'idle', 'connecting', 'connected', 'disconnected', 'busy', 'evicted', 'stopped', 'unsupported',
    ];
    const seen = states.map((s) => vstBridgeDetail(snapshot({ state: s })));
    // 'idle'/'stopped' say the same thing by design (both are "you stopped it"),
    // and 'unsupported' matches the !supported branch — so assert on the shape
    // that matters: MOST states differ, and no two ADJACENT meanings collide.
    expect(new Set(seen).size).toBeGreaterThan(4);
    expect(vstBridgeDetail(snapshot({ state: 'busy' })))
      .not.toBe(vstBridgeDetail(snapshot({ state: 'evicted' })));
  });
});

describe('the PLUGIN lamp — where the latency readout and the mount error went', () => {
  it('is LIT only while something is mounted', () => {
    expect(vstPluginLit(snapshot({ mounted: mounted() }))).toBe(true);
    expect(vstPluginLit(snapshot())).toBe(false);
  });

  it('carries the plugin identity AND its latency in samples', () => {
    const d = vstPluginDetail(snapshot({ mounted: mounted() }));
    expect(d).toContain('AUDelay');
    expect(d).toContain('Apple');
    expect(d).toContain('512');
  });

  it('a MOUNT ERROR outranks everything and names the plugin that failed', () => {
    const d = vstPluginDetail(snapshot({
      state: 'connected',
      mountError: { type: 'mountError', pluginId: 'au:aumu:bad', message: 'component not found' },
    }));
    expect(d).toContain('au:aumu:bad');
    expect(d).toContain('component not found');
  });

  it('distinguishes "nothing mounted, bridge up" from "nothing mounted, bridge down"', () => {
    // ⚠ THE NEGATIVE CONTROL. Both are an unlit PLUGIN lamp, and they mean
    // opposite things: connected-and-empty is a bit-transparent passthrough that
    // is working as designed; disconnected-and-empty is a card that has not
    // reached the helper at all.
    const up = vstPluginDetail(snapshot({ state: 'connected' }));
    const down = vstPluginDetail(snapshot({ state: 'disconnected' }));
    expect(up).not.toBe(down);
    expect(up).toContain('bit-transparently');
    expect(down).toContain('not connected');
  });
});

describe('the LOAD lamp — where the meter row went', () => {
  const meters = (loadPct: number) => ({
    type: 'meters' as const,
    inputRMS: [-12.4, -13.1],
    outputRMS: [-6.2, -6.9],
    renderErrors: 0,
    droppedBlocks: 0,
    midiQueued: 0,
    loadPct,
  });

  it('lights only at or above the warn threshold', () => {
    expect(vstLoadLit(snapshot({ meters: meters(VST_LOAD_WARN_PCT) }))).toBe(true);
    expect(vstLoadLit(snapshot({ meters: meters(VST_LOAD_WARN_PCT - 1) }))).toBe(false);
    // No meters at all is not a warning — it is silence.
    expect(vstLoadLit(snapshot({ meters: null }))).toBe(false);
  });

  it('carries both levels and the load percentage', () => {
    const d = vstLoadDetail(snapshot({ meters: meters(42) }));
    expect(d).toContain('-12 dBFS');
    expect(d).toContain('-6 dBFS');
    expect(d).toContain('42%');
  });

  it('says SILENT rather than printing the −120 floor as a number', () => {
    const d = vstLoadDetail(snapshot({
      meters: { ...meters(0), inputRMS: [-140, -140], outputRMS: [] },
    }));
    expect(d).toContain('input silent');
    expect(d).toContain('output silent');
    expect(d).not.toContain('-140');
  });

  it('has a sentence for "no meters yet" that is not the zero-load sentence', () => {
    // ⚠ NEGATIVE CONTROL: "the helper has not reported" and "the helper reports
    // 0%" are different facts, and only one of them means the link is up.
    expect(vstLoadDetail(snapshot({ meters: null }))).not.toBe(
      vstLoadDetail(snapshot({ meters: meters(0) })),
    );
  });
});

describe('the PERSISTENCE sentence — folded INTO the PLUGIN lamp, not its own', () => {
  // ⚠ THIS WAS A FOURTH LAMP AND THE DOCK WIDTH GATE PRICED IT OUT: 44 CSS px
  // of empty plate against a 40 px ceiling (content 486, body 530), because a
  // lamp's dot and its flex gaps are chrome `contentW` cannot see. The
  // predicate survives because the sentence needs it; the picture did not earn
  // its width on a two-cell face. These pins are what keep the FOLD honest —
  // the information has to still be reachable, or the width fix deleted a
  // finding instead of relocating it.
  it('lights only when the state blob itself travels', () => {
    expect(vstSavedLit({ stateBytes: 2048, stateB64: 'AAAA' })).toBe(true);
    expect(vstSavedLit({ stateBytes: 900_000 })).toBe(false);
    expect(vstSavedLit(undefined)).toBe(false);
  });

  it('the TOO-LARGE case explains the consequence, not just the size', () => {
    // ⚠ THIS IS THE ONE THAT MATTERS. `stateBytes` with no `stateB64` means the
    // plugin comes back EMPTY on the next load — a real consequence a player
    // must be able to discover, so the sentence says so rather than reporting a
    // number and leaving them to infer it.
    const d = vstSavedDetail({ pluginId: 'x', stateBytes: 900_000 });
    expect(d).toContain('too large');
    expect(d).toContain('save presets inside the plugin');
  });

  it('the three regimes produce three different sentences', () => {
    // ⚠ PERMANENT NEGATIVE CONTROL over the same predicate the fold calls.
    const none = vstSavedDetail(undefined);
    const saved = vstSavedDetail({ pluginId: 'x', stateBytes: 2048, stateB64: 'AAAA' });
    const huge = vstSavedDetail({ pluginId: 'x', stateBytes: 900_000 });
    expect(new Set([none, saved, huge]).size).toBe(3);
    expect(saved).toContain('2.0 KB');
  });

  it('the PLUGIN lamp CARRIES it — the fold relocated the finding, not deleted it', () => {
    // ⚠ THE INVERSE ASSERTION THE RELOCATION OWES. "Moved" and "dropped" look
    // identical from a green run, so this asserts the too-large warning is
    // REACHABLE on the surviving lamp rather than merely absent from the plate.
    const d = vstPluginDetail(
      snapshot({ state: 'connected', mounted: mounted() }),
      { pluginId: 'x', stateBytes: 900_000 },
    );
    expect(d).toContain('AUDelay');
    expect(d).toContain('too large');
    expect(d).toContain('save presets inside the plugin');
  });

  it('the PLUGIN lamp says something DIFFERENT when the state DOES travel', () => {
    // The other direction of the same control: if the fold hard-coded the
    // warning, this would be identical to the case above.
    const saved = vstPluginDetail(
      snapshot({ state: 'connected', mounted: mounted() }),
      { pluginId: 'x', stateBytes: 2048, stateB64: 'AAAA' },
    );
    const huge = vstPluginDetail(
      snapshot({ state: 'connected', mounted: mounted() }),
      { pluginId: 'x', stateBytes: 900_000 },
    );
    expect(saved).not.toBe(huge);
    expect(saved).toContain('travels with the patch');
  });

  it('an UNMOUNTED plugin lamp never mentions persistence at all', () => {
    // Nothing is mounted, so there is no plugin whose state could travel —
    // appending a persistence clause there would be a sentence about nothing.
    const d = vstPluginDetail(snapshot({ state: 'connected' }), { pluginId: 'x', stateBytes: 900_000 });
    expect(d).toContain('bit-transparently');
    expect(d).not.toContain('too large');
  });
});
