// packages/web/src/lib/video/modules/toybox.test.ts
//
// Def-shape coverage for the TOYBOX module (the 6-input modulation section).
// The GL render pipeline is exercised by E2E/VRT (jsdom can't render shaders);
// here we pin the port surface — that the 6 generic modulation input ports exist
// (type `modsignal`, so they accept cv/gate/audio) with the neutral linear hint
// + no paramTarget (routing is dynamic, handled in setParam) — so a regression
// that drops a port or re-narrows the type fails a fast unit test. Also covers
// the schemaVersion-2 migration that strips dropped cv7/cv8 routes (the 8→6
// non-destructive load).

import { describe, it, expect } from 'vitest';
import { toyboxDef, migrateToyboxData } from './toybox';
import { CV_PORT_IDS } from '$lib/video/toybox-cv-routes';

describe('toyboxDef shape', () => {
  it('is a video-source module with one video output', () => {
    expect(toyboxDef.type).toBe('toybox');
    expect(toyboxDef.domain).toBe('video');
    expect(toyboxDef.outputs).toHaveLength(1);
    expect(toyboxDef.outputs[0]!.id).toBe('out');
    expect(toyboxDef.outputs[0]!.type).toBe('video');
  });

  it('declares 8 inputs: 6 generic modulation ports (cv1..cv6) THEN 2 video ports (inA/inB)', () => {
    const ids = toyboxDef.inputs.map((p) => p.id);
    // cv1..cv6 first (order matters: the card + CV routing read ports by id at
    // a stable index), inA/inB appended LAST.
    expect(ids).toEqual([...CV_PORT_IDS, 'inA', 'inB']);
    expect(toyboxDef.inputs).toHaveLength(8);
  });

  it('the 6 cv ports are type `modsignal` (cv/gate/audio) with a linear hint + NO paramTarget', () => {
    const cvPorts = toyboxDef.inputs.filter((p) => p.id !== 'inA' && p.id !== 'inB');
    expect(cvPorts).toHaveLength(6);
    for (const port of cvPorts) {
      // modsignal: accepts cv, gate, OR audio (canConnect scopes audio→non-audio
      // to this type only). The port IDs stay cv1..cv6.
      expect(port.type).toBe('modsignal');
      // Neutral-linear hint: the cv-bridge degrades to raw passthrough (no
      // param named 'cvN' to resolve), so TOYBOX shapes the value in setParam.
      expect(port.cvScale).toEqual({ mode: 'linear' });
      // Dynamic routing → no static paramTarget.
      expect(port.paramTarget).toBeUndefined();
    }
  });

  it('the 2 video inputs (inA/inB) are type `video` (a patched feed into a layer)', () => {
    const inA = toyboxDef.inputs.find((p) => p.id === 'inA');
    const inB = toyboxDef.inputs.find((p) => p.id === 'inB');
    expect(inA?.type).toBe('video');
    expect(inB?.type).toBe('video');
  });

  it('has no static numeric engine params (content/material/combine live in node.data)', () => {
    expect(toyboxDef.params).toEqual([]);
  });

  it('is schemaVersion 3 with a migrate hook', () => {
    // v3 = chromakey single `key` channel-select → keyR/keyG/keyB HSV key
    // (v2 was the 8→6 cv7/cv8 route strip).
    expect(toyboxDef.schemaVersion).toBe(3);
    expect(typeof toyboxDef.migrate).toBe('function');
  });
});

describe('migrateToyboxData — 8-input (cv1..cv8) patch loads as 6 inputs', () => {
  it('strips the dropped cv7/cv8 routes from a v1 save without throwing', () => {
    const v1data = {
      layers: [{ kind: 'gen', contentId: 'noise-fbm', params: {} }],
      cvRoutes: {
        cv1: { target: 'layer', layer: 0, param: 'speed' },
        cv6: { target: 'combine', nodeId: 'op1', param: 'amount' },
        cv7: { target: 'layer', layer: 0, param: 'scale' }, // dropped pool port
        cv8: { target: 'layer', layer: 1, param: 'speed' }, // dropped pool port
      },
    };
    const out = migrateToyboxData(v1data, 1) as { cvRoutes: Record<string, unknown> };
    const keys = Object.keys(out.cvRoutes);
    expect(keys).toContain('cv1');
    expect(keys).toContain('cv6');
    expect(keys).not.toContain('cv7');
    expect(keys).not.toContain('cv8');
    expect(keys).toHaveLength(2);
  });

  it('is a no-op at/above the current schemaVersion + tolerates missing/garbage data', () => {
    const same = { cvRoutes: { cv7: { target: 'layer', layer: 0, param: 'x' } } };
    expect(migrateToyboxData(same, 2)).toBe(same); // already current → untouched
    expect(() => migrateToyboxData(null, 1)).not.toThrow();
    expect(() => migrateToyboxData(undefined, 1)).not.toThrow();
    expect(() => migrateToyboxData({}, 1)).not.toThrow();
  });
});
