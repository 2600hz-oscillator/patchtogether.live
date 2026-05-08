// packages/web/src/lib/video/modules/camera-input.test.ts
//
// Unit-level checks for the CAMERA module def. Vitest runs under node
// (see vitest.config.ts) — it can't instantiate the factory (no WebGL2
// in node) but it CAN verify:
//   - the def is registered under the right type / domain
//   - the I/O surface matches the spec (.myrobots/plans/module-camera-input.md §2)
//   - default param values are in-range and match defaults declared in the def
//   - schema/version + maxInstances guardrails are wired
//
// The full GL-bound factory + state machine + getUserMedia path is
// covered by e2e/tests/camera-input.spec.ts (Playwright with
// `--use-fake-device-for-media-stream`).

import { describe, expect, it } from 'vitest';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
// Side-effect import auto-registers the video defs (lines, videoOut,
// cameraInput).
import '$lib/video/modules';

describe('CAMERA — module def shape', () => {
  it('is registered under type "cameraInput" with domain "video"', () => {
    const def = getVideoModuleDef('cameraInput');
    expect(def).toBeDefined();
    if (!def) return;
    expect(def.domain).toBe('video');
    expect(def.label).toBe('CAMERA');
    expect(def.category).toBe('sources');
    expect(def.schemaVersion).toBe(1);
  });

  it('input port surface: a single CV gain input', () => {
    const def = getVideoModuleDef('cameraInput')!;
    expect(def.inputs).toHaveLength(1);
    const gain = def.inputs.find((p) => p.id === 'gain');
    expect(gain?.type).toBe('cv');
  });

  it('output port surface: a single video output', () => {
    const def = getVideoModuleDef('cameraInput')!;
    expect(def.outputs).toHaveLength(1);
    const out = def.outputs.find((p) => p.id === 'out');
    expect(out?.type).toBe('video');
  });

  it('declares the three documented params with documented ranges', () => {
    const def = getVideoModuleDef('cameraInput')!;
    const ids = def.params.map((p) => p.id).sort();
    expect(ids).toEqual(['enabled', 'gain', 'mirror']);

    const gain = def.params.find((p) => p.id === 'gain')!;
    expect(gain.min).toBe(0);
    expect(gain.max).toBe(2);
    expect(gain.defaultValue).toBe(1);
    expect(gain.curve).toBe('linear');

    const enabled = def.params.find((p) => p.id === 'enabled')!;
    expect(enabled.curve).toBe('discrete');
    // Default ON — user can spawn the card and immediately request access
    // without flipping a switch first.
    expect(enabled.defaultValue).toBe(1);
    expect(enabled.min).toBe(0);
    expect(enabled.max).toBe(1);

    const mirror = def.params.find((p) => p.id === 'mirror')!;
    expect(mirror.curve).toBe('discrete');
    // Default ON — selfie convention (matches Zoom / Photo Booth).
    expect(mirror.defaultValue).toBe(1);
  });

  it('caps simultaneous instances at 4 (matches per-rackspace user limit)', () => {
    const def = getVideoModuleDef('cameraInput')!;
    expect(def.maxInstances).toBe(4);
  });

  it('every default value is within the declared min/max range', () => {
    const def = getVideoModuleDef('cameraInput')!;
    for (const p of def.params) {
      expect(p.defaultValue, `${p.id} defaultValue ≥ min`).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue, `${p.id} defaultValue ≤ max`).toBeLessThanOrEqual(p.max);
    }
  });

  it('appears in the global video registry list (auto-registered)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('cameraInput');
  });

  it('has a factory function (not yet invoked under node — see e2e)', () => {
    const def = getVideoModuleDef('cameraInput')!;
    expect(typeof def.factory).toBe('function');
  });
});

describe('CAMERA — interop with cable type rules', () => {
  // The output is `video`, so it should accept the same upcast rules
  // every video-domain output gets. We don't re-test canConnect itself
  // (engine.test.ts already does); this is a regression guard against
  // accidentally typing the output as `mono-video` or `image`.
  it('output is type "video" so downstream OUTPUT (input video) accepts directly', () => {
    const def = getVideoModuleDef('cameraInput')!;
    const out = def.outputs[0];
    expect(out?.type).toBe('video');
  });
});
