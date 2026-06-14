// packages/web/src/lib/graph/performance-bundle.test.ts
//
// Unit tests for the pure PerformanceBundle assembly + validation logic.
// No IndexedDB / DOM needed — these are plain functions over plain objects.

import { describe, it, expect } from 'vitest';
import {
  BUNDLE_VERSION,
  collectAssetRefs,
  collectMidiDevices,
  collectGamepadBindings,
  makePerformanceBundle,
  validateBundle,
  mergeMidiBindings,
  resolveMidiDeviceId,
  BundleParseError,
  type MidiBindingExport,
} from './performance-bundle';
import type { PatchEnvelope } from './persistence';

const envelope: PatchEnvelope = {
  envelopeVersion: 1,
  savedAt: '2026-05-27T00:00:00.000Z',
  moduleSchemas: {},
  update: 'AAAA',
};

describe('collectAssetRefs', () => {
  it('collects VIDEOBOX nodes that have a persisted handleId', () => {
    const nodes = {
      v1: {
        id: 'v1',
        type: 'videobox',
        data: { fileMeta: { handleId: 'h-1', name: 'clip.mp4', size: 1234, duration: 12.5 } },
      },
      // no handleId yet (never picked) → skipped
      v2: { id: 'v2', type: 'videobox', data: { fileMeta: { name: 'x', duration: 0 } } },
      // not a videobox → ignored
      o1: { id: 'o1', type: 'vco', data: {} },
    };
    const refs = collectAssetRefs(nodes);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      handleId: 'h-1',
      role: 'video',
      nodeId: 'v1',
      filename: 'clip.mp4',
      size: 1234,
      duration: 12.5,
    });
  });

  it('returns [] when there are no videobox nodes', () => {
    expect(collectAssetRefs({ a: { id: 'a', type: 'vco' } })).toEqual([]);
  });

  // FIX 2: VIDEOVARISPEED now stamps fileMeta.handleId + registers an export
  // resolver just like VIDEOBOX, so its loaded clip must be collected too —
  // before this it was silently dropped (only `videobox` was matched).
  it('also collects VIDEOVARISPEED nodes with a persisted handleId', () => {
    const nodes = {
      vv: {
        id: 'vv',
        type: 'videovarispeed',
        data: { fileMeta: { handleId: 'h-vv', name: 'clip.mp4', size: 99, duration: 4.2 } },
      },
    };
    const refs = collectAssetRefs(nodes);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ handleId: 'h-vv', role: 'video', nodeId: 'vv', filename: 'clip.mp4' });
  });

  it('collects both VIDEOBOX and VIDEOVARISPEED in one rack', () => {
    const nodes = {
      vb: { id: 'vb', type: 'videobox', data: { fileMeta: { handleId: 'h1', name: 'a.mp4' } } },
      vv: { id: 'vv', type: 'videovarispeed', data: { fileMeta: { handleId: 'h2', name: 'b.mp4' } } },
    };
    expect(collectAssetRefs(nodes).map((r) => r.handleId).sort()).toEqual(['h1', 'h2']);
  });

  it('tolerates missing/undefined node entries', () => {
    expect(collectAssetRefs({ a: undefined })).toEqual([]);
  });
});

describe('collectMidiDevices', () => {
  it('keys MIDI-CV-BUDDY device by NAME via the id resolver + carries the id', () => {
    const nodes = {
      m1: { id: 'm1', type: 'midiCvBuddy', data: { lastDeviceId: 'unstable-id-42' } },
    };
    const out = collectMidiDevices(nodes, (id) =>
      id === 'unstable-id-42' ? { name: 'Launchpad Mini', manufacturer: 'Focusrite' } : null,
    );
    expect(out).toEqual([
      { nodeId: 'm1', deviceName: 'Launchpad Mini', manufacturer: 'Focusrite', deviceId: 'unstable-id-42' },
    ]);
  });

  // FIX 1: MIDI LANE + MIDICLOCK store device on the SAME node.data.lastDeviceId
  // convention but were NEVER collected before (only midiCvBuddy matched), so
  // their device binding silently dropped from saved performances → the user
  // had to re-pick on every load.
  it('also collects MIDI LANE + MIDICLOCK device selections', () => {
    const nodes = {
      lane: { id: 'lane', type: 'midiLane', data: { lastDeviceId: 'id-lane' } },
      clk: { id: 'clk', type: 'midiclock', data: { lastDeviceId: 'id-clk' } },
    };
    const out = collectMidiDevices(nodes, (id) =>
      id === 'id-lane' ? { name: 'Keystep' } : id === 'id-clk' ? { name: 'Beatstep' } : null,
    );
    expect(out).toEqual([
      { nodeId: 'lane', deviceName: 'Keystep', manufacturer: undefined, deviceId: 'id-lane' },
      { nodeId: 'clk', deviceName: 'Beatstep', manufacturer: undefined, deviceId: 'id-clk' },
    ]);
  });

  it('skips a node whose saved id no longer resolves (device absent at save)', () => {
    const nodes = { m1: { id: 'm1', type: 'midiLane', data: { lastDeviceId: 'gone' } } };
    expect(collectMidiDevices(nodes, () => null)).toEqual([]);
  });

  it('skips a node with no saved device', () => {
    const nodes = { m1: { id: 'm1', type: 'midiclock', data: { lastDeviceId: null } } };
    expect(collectMidiDevices(nodes, () => ({ name: 'X' }))).toEqual([]);
  });

  // Regression guard: the registered types are camelCase `midiCvBuddy` /
  // `midiLane` + lowercase `midiclock` — NOT kebab. The old kebab
  // `midi-cv-buddy` literal never matched a real node, so device selections
  // silently vanished. Assert the kebab string is NOT collected.
  it('does NOT match the kebab "midi-cv-buddy" (wrong type — would be vacuous)', () => {
    const nodes = { m1: { id: 'm1', type: 'midi-cv-buddy', data: { lastDeviceId: 'x' } } };
    expect(collectMidiDevices(nodes, () => ({ name: 'X' }))).toEqual([]);
  });
});

describe('resolveMidiDeviceId (load-side re-bind)', () => {
  const connected = [
    { id: 'live-1', name: 'Keystep' },
    { id: 'live-2', name: 'Launchpad Mini' },
  ];

  it('matches by exact id first (same machine)', () => {
    expect(resolveMidiDeviceId({ deviceId: 'live-2', deviceName: 'Keystep' }, connected)).toBe('live-2');
  });

  it('falls back to NAME when the saved id is absent (cross-machine)', () => {
    // Saved id regenerated → not in `connected`; name still matches.
    expect(resolveMidiDeviceId({ deviceId: 'stale-id', deviceName: 'Launchpad Mini' }, connected)).toBe('live-2');
  });

  it('resolves by name when no id was saved', () => {
    expect(resolveMidiDeviceId({ deviceName: 'Keystep' }, connected)).toBe('live-1');
  });

  it('returns null when the device is not connected', () => {
    expect(resolveMidiDeviceId({ deviceId: 'x', deviceName: 'Not Plugged In' }, connected)).toBeNull();
  });

  it('returns null against an empty input list', () => {
    expect(resolveMidiDeviceId({ deviceId: 'live-1', deviceName: 'Keystep' }, [])).toBeNull();
  });
});

describe('collectGamepadBindings', () => {
  it('keys gamepad mapping by gamepad.id resolved from the slot', () => {
    const nodes = { g1: { id: 'g1', type: 'gamepad', params: { padIndex: 2 } } };
    const out = collectGamepadBindings(nodes, (slot) =>
      slot === 2 ? 'Xbox 360 Controller (id)' : null,
    );
    expect(out).toEqual([{ nodeId: 'g1', gamepadId: 'Xbox 360 Controller (id)', padIndex: 2 }]);
  });

  it('records the slot with empty gamepadId when no pad is connected', () => {
    const nodes = { g1: { id: 'g1', type: 'gamepad', params: { padIndex: 1 } } };
    expect(collectGamepadBindings(nodes, () => null)).toEqual([
      { nodeId: 'g1', gamepadId: '', padIndex: 1 },
    ]);
  });

  it('clamps padIndex to 0..3', () => {
    const nodes = { g1: { id: 'g1', type: 'gamepad', params: { padIndex: 99 } } };
    expect(collectGamepadBindings(nodes, () => null)[0]!.padIndex).toBe(3);
  });
});

describe('makePerformanceBundle', () => {
  it('wraps the envelope + collects all four metadata classes', () => {
    const nodes = {
      v1: {
        id: 'v1',
        type: 'videobox',
        data: { fileMeta: { handleId: 'h-1', name: 'a.mp4', size: 5, duration: 3 } },
      },
      m1: { id: 'm1', type: 'midiCvBuddy', data: { lastDeviceId: 'dev' } },
      g1: { id: 'g1', type: 'gamepad', params: { padIndex: 0 } },
    };
    const bundle = makePerformanceBundle({
      envelope,
      nodes,
      midiBindings: [{ key: 'm1:cv', channel: 0, cc: 1, learnedAt: 1 }],
      resolveMidiDevice: () => ({ name: 'Keystep' }),
      resolveGamepad: () => 'pad-0',
    });
    expect(bundle.bundleVersion).toBe(BUNDLE_VERSION);
    expect(bundle.patch).toBe(envelope);
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.midiBindings).toHaveLength(1);
    expect(bundle.midiDevices).toEqual([{ nodeId: 'm1', deviceName: 'Keystep', manufacturer: undefined, deviceId: 'dev' }]);
    expect(bundle.gamepadBindings).toEqual([{ nodeId: 'g1', gamepadId: 'pad-0', padIndex: 0 }]);
    expect(typeof bundle.savedAt).toBe('string');
  });
});

describe('validateBundle', () => {
  const good = {
    bundleVersion: BUNDLE_VERSION,
    savedAt: '2026-05-27T00:00:00.000Z',
    patch: envelope,
    assets: [],
    midiBindings: [],
    midiDevices: [],
    gamepadBindings: [],
  };

  it('accepts a well-formed bundle', () => {
    expect(() => validateBundle(good)).not.toThrow();
  });

  it('normalizes missing arrays to []', () => {
    const b = validateBundle({ bundleVersion: BUNDLE_VERSION, savedAt: 'x', patch: envelope });
    expect(b.assets).toEqual([]);
    expect(b.midiBindings).toEqual([]);
    expect(b.midiDevices).toEqual([]);
    expect(b.gamepadBindings).toEqual([]);
  });

  it('rejects a wrong version', () => {
    expect(() => validateBundle({ ...good, bundleVersion: 99 })).toThrow(BundleParseError);
  });

  it('rejects a missing patch', () => {
    expect(() => validateBundle({ bundleVersion: BUNDLE_VERSION, savedAt: 'x' })).toThrow(
      BundleParseError,
    );
  });

  it('rejects non-objects', () => {
    expect(() => validateBundle(null)).toThrow(BundleParseError);
    expect(() => validateBundle('nope')).toThrow(BundleParseError);
  });
});

describe('mergeMidiBindings', () => {
  it('bundle wins per key, other keys preserved', () => {
    const existing: MidiBindingExport[] = [
      { key: 'other:p', channel: 1, cc: 1, learnedAt: 1 },
      { key: 'm1:cv', channel: 0, cc: 5, learnedAt: 1 },
    ];
    const incoming: MidiBindingExport[] = [{ key: 'm1:cv', channel: 2, cc: 9, learnedAt: 2 }];
    const merged = mergeMidiBindings(existing, incoming);
    const byKey = Object.fromEntries(merged.map((b) => [b.key, b]));
    expect(byKey['other:p']).toEqual({ key: 'other:p', channel: 1, cc: 1, learnedAt: 1 });
    expect(byKey['m1:cv']).toEqual({ key: 'm1:cv', channel: 2, cc: 9, learnedAt: 2 });
    expect(merged).toHaveLength(2);
  });

  it('ignores malformed entries', () => {
    const merged = mergeMidiBindings(
      [{ key: 'a', channel: 0, cc: 0, learnedAt: 0 }],
      [{ key: undefined as unknown as string, channel: 0, cc: 0, learnedAt: 0 }],
    );
    expect(merged).toHaveLength(1);
  });

  it('merges a mixed CC + NOTE set, one record per key', () => {
    const existing: MidiBindingExport[] = [
      { kind: 'cc', key: 'knob:cutoff', channel: 0, cc: 7, learnedAt: 1 },
      { kind: 'note', key: 'btn:play', channel: 1, note: 60, learnedAt: 1 },
    ];
    const incoming: MidiBindingExport[] = [
      // Same key as the existing CC, but now a NOTE — collision: one per key,
      // bundle wins.
      { kind: 'note', key: 'knob:cutoff', channel: 2, note: 48, learnedAt: 2 },
      { kind: 'note', key: 'gate:trig', channel: 3, note: 36, learnedAt: 2 },
    ];
    const merged = mergeMidiBindings(existing, incoming);
    const byKey = Object.fromEntries(merged.map((b) => [b.key, b]));
    expect(merged).toHaveLength(3);
    // Collision resolved to the incoming NOTE record (not both CC + NOTE).
    expect(byKey['knob:cutoff']).toEqual({ kind: 'note', key: 'knob:cutoff', channel: 2, note: 48, learnedAt: 2 });
    expect(byKey['btn:play']).toMatchObject({ kind: 'note', note: 60 });
    expect(byKey['gate:trig']).toMatchObject({ kind: 'note', note: 36 });
  });

  it('preserves a NOTE binding round-tripping through a bundle', () => {
    const noteRecord: MidiBindingExport = { kind: 'note', key: 'b:g', channel: 4, note: 41, learnedAt: 9 };
    const merged = mergeMidiBindings([], [noteRecord]);
    expect(merged).toEqual([noteRecord]);
  });
});
