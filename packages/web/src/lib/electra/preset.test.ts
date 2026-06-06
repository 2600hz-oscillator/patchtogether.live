// packages/web/src/lib/electra/preset.test.ts
//
// Snapshot + structural tests for the pure preset generator. A KNOWN patch →
// expected .epr structure + allocation table. These are the contract the
// feedback pump + inbound dispatch rely on, so they're asserted explicitly
// (not just `toMatchSnapshot`) where the value is load-bearing.
import { describe, it, expect } from 'vitest';
import {
  generatePreset,
  emitPresetJson,
  formatterFor,
  POTS_PER_SET,
  MAX_CONTROLS_PER_PAGE,
  DEVICE_CTRL,
  DEVICE_PLAY,
  PAGE_CONTROL,
  PAGE_MIXMASTER,
  PAGE_SYSTEM,
  type PresetGenInput,
  type GenParamDef,
} from './preset';

// A small known surface: two source modules, mixed curves.
const defs: Record<string, GenParamDef> = {
  'osc1:freq': { id: 'freq', label: 'Freq', min: 20, max: 20000, defaultValue: 440, curve: 'log', units: 'Hz' },
  'osc1:level': { id: 'level', label: 'Lvl', min: 0, max: 1, defaultValue: 0.8, curve: 'linear' },
  'flt1:cutoff': { id: 'cutoff', label: 'Cut', min: 20, max: 20000, defaultValue: 1000, curve: 'log', units: 'Hz' },
  'flt1:mode': { id: 'mode', label: 'Mode', min: 0, max: 3, defaultValue: 0, curve: 'discrete' },
};

function baseInput(over: Partial<PresetGenInput> = {}): PresetGenInput {
  return {
    surfaceBindings: [
      { moduleId: 'osc1', paramId: 'freq' },
      { moduleId: 'osc1', paramId: 'level' },
      { moduleId: 'flt1', paramId: 'cutoff' },
      { moduleId: 'flt1', paramId: 'mode' },
    ],
    moduleLabel: (id) => ({ osc1: 'OSC', flt1: 'FILTER' }[id] ?? id),
    resolveParamDef: (m, p) => defs[`${m}:${p}`] ?? null,
    mixmstrsId: 'mx',
    timelordeId: 'tl',
    ...over,
  };
}

describe('formatterFor', () => {
  it('dB → fmtDb, bpm → fmtBpm, ratio → fmtRatio, else undefined', () => {
    expect(formatterFor({ id: 'x', label: 'x', min: 0, max: 1, defaultValue: 0, curve: 'linear', units: 'dB' })).toBe('fmtDb');
    expect(formatterFor({ id: 'bpm', label: 'b', min: 10, max: 300, defaultValue: 120, curve: 'log', units: 'bpm' })).toBe('fmtBpm');
    expect(formatterFor({ id: 'ch1_ratio', label: 'r', min: 1, max: 10, defaultValue: 2, curve: 'linear' })).toBe('fmtRatio');
    expect(formatterFor({ id: 'level', label: 'l', min: 0, max: 1, defaultValue: 0.8, curve: 'linear' })).toBeUndefined();
  });
});

describe('generatePreset — pages + devices', () => {
  it('emits version 2, three pages, two devices', () => {
    const { preset } = generatePreset(baseInput());
    expect(preset.version).toBe(2);
    expect(preset.name).toBe('patchtogether');
    expect(preset.pages.map((p) => p.id)).toEqual([PAGE_CONTROL, PAGE_MIXMASTER, PAGE_SYSTEM]);
    expect(preset.pages.map((p) => p.name)).toEqual(['CONTROL', 'MIXMSTRS', 'SYSTEM']);
    const ctrl = preset.devices.find((d) => d.id === DEVICE_CTRL)!;
    expect(ctrl).toMatchObject({ name: 'PT-CTRL', port: 2, channel: 1, rate: 33 });
    const play = preset.devices.find((d) => d.id === DEVICE_PLAY)!;
    expect(play).toMatchObject({ name: 'PT-PLAY', port: 1 });
  });
});

describe('generatePreset — CONTROL page', () => {
  it('lays out surface bindings as faders/lists in first-seen order, grouped', () => {
    const { preset, allocations } = generatePreset(baseInput());
    const page1 = preset.controls.filter((c) => c.pageId === PAGE_CONTROL);
    expect(page1.map((c) => c.name)).toEqual(['OSC Freq', 'OSC Lvl', 'FILTER Cut', 'FILTER Mode']);
    // freq/cutoff are faders; mode (discrete) is a list with an overlay.
    expect(page1[0]!.type).toBe('fader');
    expect(page1[3]!.type).toBe('list');
    expect(page1[3]!.values[0]!.overlayId).toBeDefined();
    // pots assigned 1..4 in control set 1.
    expect(page1.map((c) => c.potId)).toEqual([1, 2, 3, 4]);
    expect(page1.every((c) => c.controlSetId === 1)).toBe(true);
    // Two visual groups, one per source module.
    const g = preset.groups.filter((x) => x.pageId === PAGE_CONTROL);
    expect(g.map((x) => x.name)).toEqual(['OSC', 'FILTER']);
    expect(g[0]).toMatchObject({ from: 1, to: 2 });
    expect(g[1]).toMatchObject({ from: 3, to: 4 });
    // Allocation keys = moduleId:paramId (the SAME key MIDI uses).
    const ctrlAllocs = allocations.filter((a) => a.pageId === PAGE_CONTROL);
    expect(ctrlAllocs.map((a) => a.key)).toEqual([
      'osc1:freq', 'osc1:level', 'flt1:cutoff', 'flt1:mode',
    ]);
    expect(ctrlAllocs.every((a) => a.role === 'rw')).toBe(true);
    // Curve is carried through for value↔CC scaling.
    expect(ctrlAllocs[0]!.curve).toBe('log');
    expect(ctrlAllocs[3]!.curve).toBe('discrete');
  });

  it('caps the CONTROL page at 36 controls (3 sets × 12)', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ moduleId: `m${i}`, paramId: 'p' }));
    const input = baseInput({
      surfaceBindings: many,
      resolveParamDef: () => ({ id: 'p', label: 'P', min: 0, max: 1, defaultValue: 0, curve: 'linear' }),
      moduleLabel: (id) => id,
    });
    const { preset } = generatePreset(input);
    const page1 = preset.controls.filter((c) => c.pageId === PAGE_CONTROL);
    expect(page1.length).toBe(MAX_CONTROLS_PER_PAGE);
    // Spills into control sets 1..3.
    expect(new Set(page1.map((c) => c.controlSetId))).toEqual(new Set([1, 2, 3]));
    expect(page1[POTS_PER_SET]!.controlSetId).toBe(2);
    expect(page1[POTS_PER_SET]!.potId).toBe(1);
  });

  it('skips bindings whose ParamDef cannot resolve', () => {
    const input = baseInput({ resolveParamDef: () => null });
    const { preset } = generatePreset(input);
    expect(preset.controls.filter((c) => c.pageId === PAGE_CONTROL)).toHaveLength(0);
  });
});

describe('generatePreset — control bounds (render placement)', () => {
  it('every control gets an on-screen bounds + visible:true (else the device draws nothing)', () => {
    const { preset } = generatePreset(baseInput());
    expect(preset.controls.length).toBeGreaterThan(0);
    for (const c of preset.controls) {
      expect(Array.isArray(c.bounds), `${c.name} has bounds`).toBe(true);
      expect(c.bounds).toHaveLength(4);
      const [x, y, w, h] = c.bounds!;
      expect(w).toBe(146);
      expect(h).toBe(56);
      expect(x).toBeGreaterThanOrEqual(20);
      expect(x + w).toBeLessThanOrEqual(1024);
      expect(y + h).toBeLessThanOrEqual(600);
      expect(c.visible).toBe(true);
    }
  });

  it('places potId/controlSetId on the canonical FW-3.0.5 grid', () => {
    const { preset } = generatePreset(baseInput());
    const at = (page: number, cs: number, pot: number) =>
      preset.controls.find((c) => c.pageId === page && c.controlSetId === cs && c.potId === pot);
    expect(at(1, 1, 1)?.bounds).toEqual([20, 28, 146, 56]); // top-left cell
    const p7 = at(1, 1, 7);
    if (p7) expect(p7.bounds).toEqual([20, 118, 146, 56]); // 2nd row of top band
    for (const g of preset.groups) expect(g.bounds).toHaveLength(4);
  });
});

describe('generatePreset — MIXMASTER page', () => {
  it('emits 29 writable controls + a 5-meter read-only row', () => {
    const { preset, allocations } = generatePreset(baseInput());
    const mixAll = allocations.filter((a) => a.pageId === PAGE_MIXMASTER);
    const rw = mixAll.filter((a) => a.role === 'rw');
    const meters = mixAll.filter((a) => a.role === 'meter');
    expect(rw.length).toBe(29); // 4 vol + 4 s1 + 4 s2 + 4 lo + 4 mid + 4 hi + 4 comp + master
    expect(meters.length).toBe(5); // 4 channels + master
    // Meter controls are read-only thin vfaders.
    const meterControls = preset.controls.filter((c) => c.pageId === PAGE_MIXMASTER && c.readOnly);
    expect(meterControls.every((c) => c.type === 'vfader' && c.variant === 'thin')).toBe(true);
    // Meter keys + master key shape.
    expect(meters.map((a) => a.key)).toEqual([
      'mx:meter:1', 'mx:meter:2', 'mx:meter:3', 'mx:meter:4', 'mx:meter:master',
    ]);
    // EQ controls carry the fmtDb formatter.
    const lo = preset.controls.find((c) => c.name === 'Lo1')!;
    expect(lo.values[0]!.formatter).toBe('fmtDb');
  });

  it('omits MixMaster controls when no mixer is present (page shell only)', () => {
    const { preset } = generatePreset(baseInput({ mixmstrsId: null }));
    expect(preset.controls.filter((c) => c.pageId === PAGE_MIXMASTER)).toHaveLength(0);
    expect(preset.pages.find((p) => p.id === PAGE_MIXMASTER)).toBeDefined();
  });
});

describe('generatePreset — SYSTEM page', () => {
  it('BPM encoder (log, fmtBpm), TAP pad (note on PLAY), SRC banner, swing/mute', () => {
    const { preset, allocations } = generatePreset(baseInput());
    const sys = allocations.filter((a) => a.pageId === PAGE_SYSTEM);
    const byKey = Object.fromEntries(sys.map((a) => [a.key.split(':')[1], a]));
    // BPM: writable cc7 on CTRL, log curve, 10..300.
    expect(byKey['bpm']).toMatchObject({ role: 'rw', messageType: 'cc7', deviceId: DEVICE_CTRL, curve: 'log', min: 10, max: 300 });
    const bpmCtl = preset.controls.find((c) => c.pageId === PAGE_SYSTEM && c.name === 'BPM')!;
    expect(bpmCtl.values[0]!.formatter).toBe('fmtBpm');
    // TAP: momentary note on PLAY, role tap (NOT a param).
    expect(byKey['tap']).toMatchObject({ role: 'tap', messageType: 'note', deviceId: DEVICE_PLAY });
    const tapCtl = preset.controls.find((c) => c.pageId === PAGE_SYSTEM && c.name === 'TAP')!;
    expect(tapCtl.type).toBe('pad');
    expect(tapCtl.mode).toBe('momentary');
    // SRC banner: read-only list with INT/EXT overlay, role banner.
    expect(byKey['source']!.role).toBe('banner');
    // swing/source/mute present.
    expect(byKey['swingAmount']!.role).toBe('rw');
    expect(byKey['swingSource']).toMatchObject({ role: 'rw', curve: 'discrete' });
    expect(byKey['muteOutputs']!.role).toBe('rw');
  });
});

describe('allocation table — deterministic + collision-free', () => {
  it('CC numbers are unique within a device + notes are a separate stream', () => {
    const { allocations } = generatePreset(baseInput());
    const cc7 = allocations.filter((a) => a.messageType === 'cc7').map((a) => a.number);
    expect(new Set(cc7).size).toBe(cc7.length); // no CC collisions
    const notes = allocations.filter((a) => a.messageType === 'note').map((a) => a.number);
    expect(notes).toEqual([0]); // single tap note, from the note stream
  });

  it('is stable across regenerations (same input → same table)', () => {
    const a = generatePreset(baseInput()).allocations;
    const b = generatePreset(baseInput()).allocations;
    expect(a).toEqual(b);
  });
});

describe('emitPresetJson', () => {
  it('produces compact 7-bit-clean JSON', () => {
    const { preset } = generatePreset(baseInput());
    const json = emitPresetJson(preset);
    expect(json).not.toContain('\n'); // minified
    expect(JSON.parse(json).version).toBe(2); // valid JSON round-trips
    // Every byte is printable 7-bit ASCII.
    for (let i = 0; i < json.length; i++) {
      const c = json.charCodeAt(i);
      expect(c).toBeGreaterThanOrEqual(0x20);
      expect(c).toBeLessThanOrEqual(0x7e);
    }
  });

  it('full preset matches the committed snapshot', () => {
    const { preset, allocations } = generatePreset(baseInput());
    expect({ preset, allocations }).toMatchSnapshot();
  });
});
