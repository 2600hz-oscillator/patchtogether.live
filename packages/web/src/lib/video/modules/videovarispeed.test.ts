// packages/web/src/lib/video/modules/videovarispeed.test.ts
//
// Locks down VIDEOVARISPEED's module-def shape. Mirrors videobox.test.ts —
// no factory/runtime execution (those need WebGL + a real <video> element;
// covered in e2e).

import { describe, expect, it } from 'vitest';
import { videoVarispeedDef, VIDEOVARISPEED_MAX_SLOT_BYTES } from './videovarispeed';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
import { ASSET_SLOT_NOTES, slotForVOct } from '$lib/video/asset-select';
import { midiToVOct } from '$lib/audio/note-entry';
// Side-effect import auto-registers every video def (including ours).
import '$lib/video/modules';

describe('videoVarispeedDef — module def shape', () => {
  it('registers under type "videovarispeed" with the right metadata', () => {
    expect(videoVarispeedDef.type).toBe('videovarispeed');
    expect(videoVarispeedDef.domain).toBe('video');
    expect(videoVarispeedDef.label).toBe('videovarispeed');
    expect(videoVarispeedDef.category).toBe('sources');
  });

  it('declares the transport gate inputs (start/pause/reset/loop) as rising-edge gates', () => {
    const gateIds = ['cv_start', 'cv_pause', 'cv_reset', 'cv_loop_toggle'];
    for (const gid of gateIds) {
      const inp = videoVarispeedDef.inputs.find((p) => p.id === gid)!;
      expect(inp, `${gid} present`).toBeDefined();
      expect(inp.type, `${gid} is a gate`).toBe('gate');
      expect(inp.paramTarget, `${gid} paramTarget`).toBe(gid);
    }
  });

  it('declares speed/start/end CV inputs (bipolar) with matching paramTargets', () => {
    for (const cid of ['speedCv', 'startCv', 'endCv']) {
      const inp = videoVarispeedDef.inputs.find((p) => p.id === cid)!;
      expect(inp, `${cid} present`).toBeDefined();
      expect(inp.type, `${cid} is cv`).toBe('cv');
      expect(inp.paramTarget, `${cid} paramTarget`).toBe(cid);
    }
  });

  it('every CV/gate input has a paramTarget that exists in params', () => {
    const paramIds = new Set(videoVarispeedDef.params.map((p) => p.id));
    for (const port of videoVarispeedDef.inputs) {
      if (port.type === 'cv' || port.type === 'gate') {
        expect(port.paramTarget, `${port.id} has paramTarget`).toBeDefined();
        expect(paramIds.has(port.paramTarget!), `${port.id} → ${port.paramTarget} exists`).toBe(true);
      }
    }
  });

  it('declares one video output + stereo audio outputs', () => {
    const outs = videoVarispeedDef.outputs.map((o) => ({ id: o.id, type: o.type }));
    expect(outs).toEqual([
      { id: 'video',   type: 'video' },
      { id: 'audio_l', type: 'audio' },
      { id: 'audio_r', type: 'audio' },
    ]);
  });

  it('exposes transport user params with the right ranges/defaults', () => {
    // Speed knob: normalized 0..1, default 0.5 (= +1× per the piecewise map).
    const speed = videoVarispeedDef.params.find((p) => p.id === 'speed')!;
    expect(speed.min).toBe(0);
    expect(speed.max).toBe(1);
    expect(speed.defaultValue).toBe(0.5);

    // START default 0 (beginning), END default 1 (full duration).
    const start = videoVarispeedDef.params.find((p) => p.id === 'start')!;
    expect(start.defaultValue).toBe(0);
    const end = videoVarispeedDef.params.find((p) => p.id === 'end')!;
    expect(end.defaultValue).toBe(1);

    // Bipolar CV params.
    for (const cid of ['speedCv', 'startCv', 'endCv']) {
      const cv = videoVarispeedDef.params.find((p) => p.id === cid)!;
      expect(cv.min, `${cid} min`).toBe(-1);
      expect(cv.max, `${cid} max`).toBe(1);
      expect(cv.curve).toBe('linear');
    }
  });

  it('every default value is within the declared min/max range', () => {
    for (const p of videoVarispeedDef.params) {
      expect(p.defaultValue, `${p.id} ≥ min`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} ≤ max`).toBeLessThanOrEqual(p.max);
    }
  });

  it('appears in the global video registry list (auto-registered via barrel import)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('videovarispeed');
    expect(getVideoModuleDef('videovarispeed')).toBe(videoVarispeedDef);
  });

  it('has a factory function (not invoked under node — see e2e)', () => {
    expect(typeof videoVarispeedDef.factory).toBe('function');
  });
});

describe('videoVarispeedDef — 7-slot asset selector ports', () => {
  it('declares asset_pitch (pitch, NO cvScale — raw V/oct passthrough)', () => {
    const ap = videoVarispeedDef.inputs.find((p) => p.id === 'asset_pitch')!;
    expect(ap, 'asset_pitch present').toBeDefined();
    expect(ap.type).toBe('pitch');
    expect(ap.paramTarget).toBe('asset_pitch');
    expect(ap.cvScale).toBeUndefined();
  });

  it('declares asset_gate (gate) routed to a synthetic param', () => {
    const ag = videoVarispeedDef.inputs.find((p) => p.id === 'asset_gate')!;
    expect(ag, 'asset_gate present').toBeDefined();
    expect(ag.type).toBe('gate');
    expect(ag.paramTarget).toBe('asset_gate');
  });

  it('both asset params exist with linear curve so bridge values arrive raw', () => {
    for (const pid of ['asset_pitch', 'asset_gate']) {
      const p = videoVarispeedDef.params.find((x) => x.id === pid)!;
      expect(p, `${pid} param`).toBeDefined();
      expect(p.curve).toBe('linear');
    }
  });

  it('every cv/gate/pitch input still has a paramTarget that exists in params', () => {
    const paramIds = new Set(videoVarispeedDef.params.map((p) => p.id));
    for (const port of videoVarispeedDef.inputs) {
      if (port.type === 'cv' || port.type === 'gate' || port.type === 'pitch') {
        expect(port.paramTarget, `${port.id} has paramTarget`).toBeDefined();
        expect(paramIds.has(port.paramTarget!), `${port.id} → ${port.paramTarget}`).toBe(true);
      }
    }
  });

  it('exports a documented per-slot size cap (100 MB)', () => {
    expect(VIDEOVARISPEED_MAX_SLOT_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('videoVarispeedDef — asset_gate slot-select decision (mapping)', () => {
  // The card runs slotForVOct(readParam('asset_pitch')) on each asset_gate
  // rising edge. These assertions lock down the same decision the card makes:
  // each default-clip row note maps to its slot; black keys map to null.
  it('the 7 default-clip rows (C3..B3) map to slots 0..6 via V/oct', () => {
    ASSET_SLOT_NOTES.forEach((midi, i) => {
      expect(slotForVOct(midiToVOct(midi)), `note ${midi} → slot ${i}`).toBe(i);
    });
  });

  it('a black-key V/oct (C#4) maps to null (the gate event is ignored)', () => {
    expect(slotForVOct(midiToVOct(61))).toBeNull();
  });
});
