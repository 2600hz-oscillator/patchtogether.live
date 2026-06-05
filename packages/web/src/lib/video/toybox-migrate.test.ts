// packages/web/src/lib/video/toybox-migrate.test.ts
//
// TOYBOX schema migration (v2 → v3): the chromakey combine OP changed from a
// single `key` channel-select scalar to an HSV key COLOUR (keyR/keyG/keyB). This
// covers the data migration + that any cvRoute pointing at the removed `key`
// param is dropped, plus a regression guard that the in-card chromakey shader
// PORTS the standalone chromakey.ts HSV keying verbatim (rgbToHsv + hueDistance
// + the satGate smoothstep).

import { describe, it, expect } from 'vitest';
import { migrateToyboxData, toyboxDef, __COMBINE_FRAG_SRC_FOR_TEST } from './modules/toybox';

describe('migrateToyboxData v2 → v3 (chromakey key → keyR/keyG/keyB)', () => {
  it('declares schemaVersion 3', () => {
    expect(toyboxDef.schemaVersion).toBe(3);
  });
  it('maps key=0.33 (green) → keyR0 keyG1 keyB0 and drops key', () => {
    const data = {
      combine: {
        nodes: [
          { id: 'ck', kind: 'chromakey', params: { amount: 0.3, soft: 0.1, key: 0.33 } },
        ],
        edges: [],
      },
    };
    const out = migrateToyboxData(data, 2) as typeof data;
    const p = out.combine.nodes[0]!.params as Record<string, number>;
    expect(p.keyR).toBe(0);
    expect(p.keyG).toBe(1);
    expect(p.keyB).toBe(0);
    expect('key' in p).toBe(false);
    // existing threshold/sharpness untouched.
    expect(p.amount).toBe(0.3);
    expect(p.soft).toBe(0.1);
  });
  it('maps key<0.25 → red, key>0.58 → blue', () => {
    const red = migrateToyboxData(
      { combine: { nodes: [{ id: 'a', kind: 'chromakey', params: { key: 0.0 } }], edges: [] } },
      2,
    ) as { combine: { nodes: { params: Record<string, number> }[] } };
    expect([red.combine.nodes[0]!.params.keyR, red.combine.nodes[0]!.params.keyG, red.combine.nodes[0]!.params.keyB])
      .toEqual([1, 0, 0]);
    const blue = migrateToyboxData(
      { combine: { nodes: [{ id: 'a', kind: 'chromakey', params: { key: 0.7 } }], edges: [] } },
      2,
    ) as { combine: { nodes: { params: Record<string, number> }[] } };
    expect([blue.combine.nodes[0]!.params.keyR, blue.combine.nodes[0]!.params.keyG, blue.combine.nodes[0]!.params.keyB])
      .toEqual([0, 0, 1]);
  });
  it('drops a cvRoute targeting the removed `key` param', () => {
    const data = {
      combine: { nodes: [{ id: 'ck', kind: 'chromakey', params: { key: 0.33 } }], edges: [] },
      cvRoutes: {
        cv1: { target: 'combine', nodeId: 'ck', param: 'key' },
        cv2: { target: 'combine', nodeId: 'ck', param: 'amount' },
      },
    };
    const out = migrateToyboxData(data, 2) as typeof data;
    expect(out.cvRoutes.cv1).toBeNull();
    expect(out.cvRoutes.cv2).toMatchObject({ param: 'amount' });
  });
  it('is a no-op for data already at v3', () => {
    const data = { combine: { nodes: [{ id: 'ck', kind: 'chromakey', params: { keyR: 0, keyG: 1, keyB: 0 } }], edges: [] } };
    const out = migrateToyboxData(data, 3) as typeof data;
    expect(out.combine.nodes[0]!.params).toEqual({ keyR: 0, keyG: 1, keyB: 0 });
  });
  it('still strips dropped cv7/cv8 routes when migrating from v1', () => {
    const data = { cvRoutes: { cv1: { target: 'layer', layer: 0, param: 'x' }, cv7: { target: 'layer', layer: 0, param: 'y' } } };
    const out = migrateToyboxData(data, 1) as { cvRoutes: Record<string, unknown> };
    expect('cv7' in out.cvRoutes).toBe(false);
    expect('cv1' in out.cvRoutes).toBe(true);
  });
});

describe('in-card chromakey shader ports chromakey.ts HSV keying verbatim', () => {
  it('includes rgbToHsv + hueDistance + the satGate smoothstep', () => {
    const src = __COMBINE_FRAG_SRC_FOR_TEST;
    expect(src).toContain('vec3 rgbToHsv(vec3 c)');
    expect(src).toContain('float hueDistance(float a, float b)');
    // The satGate from chromakey.ts: smoothstep(0.04, 0.18, <sat>).
    expect(src).toContain('smoothstep(0.04, 0.18,');
    // uniforms for the HSV key colour (the old single uKey is gone).
    expect(src).toContain('uniform float uKeyR;');
    expect(src).toContain('uniform float uKeyG;');
    expect(src).toContain('uniform float uKeyB;');
    expect(src).not.toContain('uniform float uKey;');
  });
});
