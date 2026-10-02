// Def-shape and contract gates for ptzcam. The protocol lives in
// ptz-sysex.test.ts, the planner in ptz-control.test.ts; the live chain is
// e2e/tests/ptzcam.spec.ts.
import { describe, expect, it } from 'vitest';
import { ptzcamDef } from './ptzcam';

describe('ptzcam def shape', () => {
  it('is an audio-domain MIDI sink with a factory', () => {
    expect(ptzcamDef.type).toBe('ptzcam');
    expect(ptzcamDef.domain).toBe('audio');
    expect(ptzcamDef.palette).toEqual({ top: 'MIDI', sub: 'MIDI' });
    expect(typeof ptzcamDef.factory).toBe('function');
  });

  it('label is lowercase (card CSS uppercases for display)', () => {
    expect(ptzcamDef.label).toBe(ptzcamDef.label.toLowerCase());
  });

  it('a small instance cap — one module per camera, two cameras on stage, slack for spares', () => {
    expect(ptzcamDef.maxInstances).toBe(4);
  });

  it('declares size on the def, not in rack-sizes', () => {
    expect(ptzcamDef.size).toBe('2u');
    expect(ptzcamDef.hp).toBe(2);
  });

  it('has exactly three cv inputs and no outputs', () => {
    expect(ptzcamDef.inputs.map((p) => [p.id, p.type])).toEqual([
      ['pan_cv', 'cv'],
      ['tilt_cv', 'cv'],
      ['zoom_cv', 'cv'],
    ]);
    expect(ptzcamDef.outputs).toEqual([]);
  });

  it('cv inputs deliberately carry no paramTarget or cvScale (main-thread consumer)', () => {
    // The CV is sampled by the factory and summed with the knob in JS — an
    // AudioParam landing pad would make the summed value unreadable headless.
    // The three ports are enrolled in PASSTHROUGH_BY_DESIGN instead; if a
    // paramTarget appears here, that enrolment and this rationale are stale.
    for (const port of ptzcamDef.inputs) {
      expect(port.paramTarget).toBeUndefined();
      expect(port.cvScale).toBeUndefined();
    }
  });

  it('params are the four knobs with in-range defaults', () => {
    expect(ptzcamDef.params.map((p) => p.id)).toEqual(['pan', 'tilt', 'zoom', 'slew']);
    for (const p of ptzcamDef.params) {
      expect(p.defaultValue).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue).toBeLessThanOrEqual(p.max);
      expect(p.curve).toBe('linear');
    }
    const byId = Object.fromEntries(ptzcamDef.params.map((p) => [p.id, p]));
    expect([byId.pan!.min, byId.pan!.max, byId.pan!.defaultValue]).toEqual([-1, 1, 0]);
    expect([byId.tilt!.min, byId.tilt!.max, byId.tilt!.defaultValue]).toEqual([-1, 1, 0]);
    expect([byId.zoom!.min, byId.zoom!.max, byId.zoom!.defaultValue]).toEqual([0, 1, 0]);
  });

  it('docs cover every port and every control', () => {
    const docs = ptzcamDef.docs!;
    expect(docs.explanation!.length).toBeGreaterThan(400);
    for (const port of ptzcamDef.inputs) {
      expect(docs.inputs?.[port.id], `docs.inputs.${port.id}`).toBeTruthy();
    }
    for (const p of ptzcamDef.params) {
      expect(docs.controls?.[p.id], `docs.controls.${p.id}`).toBeTruthy();
    }
  });
});

// ── THE DESKTOP PICK (hardware splash → rig store → ptz-midi `@auto`) ───────
//
// The splash's PTZ row writes `rig.ptz.deviceId` — a PT-PTZ port NAME. A
// ptzcam whose own picker is on `@auto` (selector null, the default every new
// module has) resolves that port first under the native shell and the first
// PT-PTZ pair otherwise; the browser (no splash, no pick) keeps its one rule.
// Driven through `connectPtzMidi(request)` with a fake access so the real
// resolve → caps-request path runs, not just the pure chooser.
import { afterEach, vi } from 'vitest';
import {
  acquirePtzBinding,
  connectPtzMidi,
  preferredPtzAutoPort,
  __resetPtzMidiForTest,
  type PtzMidiAccessLike,
} from '$lib/audio/ptz-midi';
import { RigBindingStore, emptyRigBindings, setRigBindingsForTests } from '$lib/graph/device-slot-bindings';
import { setNativeAvailableForTests } from '$lib/platform/native';

describe('ptz-midi — the desktop pick', () => {
  function twoCameras() {
    const sent = new Map<string, number>();
    const port = (id: string, name: string, state = 'connected') => ({ id, name, state });
    const out = (id: string, name: string, state = 'connected') => ({
      id,
      name,
      state,
      send: () => void sent.set(name, (sent.get(name) ?? 0) + 1),
    });
    const access: PtzMidiAccessLike = {
      inputs: new Map([
        ['i1', { ...port('i1', 'PT-PTZ-CAM1'), onmidimessage: null }],
        ['i2', { ...port('i2', 'PT-PTZ-CAM2'), onmidimessage: null }],
        ['i3', { ...port('i3', 'Other MIDI'), onmidimessage: null }],
      ]) as unknown as PtzMidiAccessLike['inputs'],
      outputs: new Map([
        ['o1', out('o1', 'PT-PTZ-CAM1')],
        ['o2', out('o2', 'PT-PTZ-CAM2')],
        ['o3', out('o3', 'Other MIDI')],
      ]),
      onstatechange: null,
    };
    return { access, sent };
  }

  async function shellRig() {
    const store = new RigBindingStore({ load: emptyRigBindings, save: () => {}, subscribe: () => () => {} });
    setRigBindingsForTests(store);
    setNativeAvailableForTests(true);
    await store.whenReady();
    return store;
  }

  afterEach(() => {
    __resetPtzMidiForTest();
    setRigBindingsForTests(null);
    setNativeAvailableForTests(null);
    vi.useRealTimers();
  });

  it('preferredPtzAutoPort — a live pick wins; otherwise the first PT-PTZ name; never a non-PTZ name', () => {
    const live = ['PT-PTZ-CAM1', 'PT-PTZ-CAM2'];
    expect(preferredPtzAutoPort(live, 'PT-PTZ-CAM2')).toBe('PT-PTZ-CAM2');
    expect(preferredPtzAutoPort(live, 'PT-PTZ-GONE')).toBe('PT-PTZ-CAM1');
    expect(preferredPtzAutoPort(live, null)).toBe('PT-PTZ-CAM1');
    expect(preferredPtzAutoPort(['Other MIDI'], null)).toBeNull();
    expect(preferredPtzAutoPort([], 'PT-PTZ-CAM1')).toBeNull();
  });

  it('under the shell an @auto binding resolves the PICKED camera (the second — the browser rule takes the first) and re-resolves when the pick changes', async () => {
    const store = await shellRig();
    const { access, sent } = twoCameras();
    store.setPtz({ deviceId: 'PT-PTZ-CAM2' });
    await connectPtzMidi(async () => access);
    const b = acquirePtzBinding(null);
    expect(b.status().portName).toBe('PT-PTZ-CAM2');
    expect(b.status().kind, 'the caps handshake went to the picked port').toBe('binding');
    expect(sent.get('PT-PTZ-CAM2')).toBe(1);
    expect(sent.get('PT-PTZ-CAM1')).toBeUndefined();
    // the splash changes the pick → the rig subscription re-resolves @auto
    store.setPtz({ deviceId: 'PT-PTZ-CAM1' });
    expect(b.status().portName).toBe('PT-PTZ-CAM1');
    expect(sent.get('PT-PTZ-CAM1')).toBe(1);
    // clearing the pick ("— none —") falls back to the first PT-PTZ pair
    store.setPtz({ deviceId: 'PT-PTZ-CAM2' });
    store.setPtz(null);
    expect(b.status().portName).toBe('PT-PTZ-CAM1');
    b.release();
  });

  it('under the shell an ABSENT pick falls back to the first PT-PTZ pair; an explicit selector is exact regardless', async () => {
    const store = await shellRig();
    const { access } = twoCameras();
    store.setPtz({ deviceId: 'PT-PTZ-ON-ANOTHER-MACHINE' });
    await connectPtzMidi(async () => access);
    const auto = acquirePtzBinding(null);
    expect(auto.status().portName).toBe('PT-PTZ-CAM1');
    const explicit = acquirePtzBinding('PT-PTZ-CAM2');
    expect(explicit.status().portName).toBe('PT-PTZ-CAM2');
    auto.release();
    explicit.release();
  });

  it('NEGATIVE CONTROL — in the browser the pick is NOT consulted: @auto is the first PT-PTZ pair', async () => {
    const store = await shellRig();
    setNativeAvailableForTests(false);
    const { access } = twoCameras();
    store.setPtz({ deviceId: 'PT-PTZ-CAM2' });
    await connectPtzMidi(async () => access);
    const b = acquirePtzBinding(null);
    expect(b.status().portName).toBe('PT-PTZ-CAM1');
    b.release();
  });
});
