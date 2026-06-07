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
import { cameraCoverScale } from '$lib/video/modules/camera-input';
// Side-effect import auto-registers the video defs (lines, videoOut,
// cameraInput).
import '$lib/video/modules';

describe('CAMERA — module def shape', () => {
  it('is registered under type "cameraInput" with domain "video"', () => {
    const def = getVideoModuleDef('cameraInput');
    expect(def).toBeDefined();
    if (!def) return;
    expect(def.domain).toBe('video');
    expect(def.label).toBe('camera');
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

  it('declares the documented params with documented ranges', () => {
    const def = getVideoModuleDef('cameraInput')!;
    const ids = def.params.map((p) => p.id).sort();
    expect(ids).toEqual(['enabled', 'fillMode', 'gain', 'mirror']);

    // Per-source fit/fill: discrete, defaults to FILL (1 = cover-crop, the
    // existing camera behaviour — never letterbox the live feed by default).
    const fillMode = def.params.find((p) => p.id === 'fillMode')!;
    expect(fillMode.curve).toBe('discrete');
    expect(fillMode.defaultValue).toBe(1);
    expect(fillMode.min).toBe(0);
    expect(fillMode.max).toBe(1);

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

describe('CAMERA — zoom-fit (cover) scale math', () => {
  // The shader applies: centered = (vUv - 0.5) / (sx, sy) + 0.5. Cover
  // scaling keeps sx,sy >= 1 so the sampled region SHRINKS (zoom in) on
  // the cropped axis, filling the FBO edge-to-edge with no black bars.
  // Regression guard for #270a4441 (pipeline flipped 16:9 → 4:3 while the
  // camera kept requesting a 16:9 stream — the old contain math then
  // letterboxed the feed with top/bottom bars).

  const FBO_W = 640;
  const FBO_H = 480; // 4:3 engine FBO

  it('16:9 webcam into 4:3 FBO: full height, crop the sides (the regression case)', () => {
    // 640×360 is exactly what CameraInputCard requests via getUserMedia.
    const { sx, sy } = cameraCoverScale(640, 360, FBO_W, FBO_H);
    // Vertical axis fills 1:1 (no crop), horizontal zooms in to crop sides.
    expect(sy).toBe(1);
    expect(sx).toBeCloseTo((640 / 360) / (FBO_W / FBO_H), 6); // 1.777.. / 1.333.. = 1.333..
    expect(sx).toBeCloseTo(1.3333333, 5);
    // Cover MUST zoom in (>= 1) — never shrink (the old letterbox bug).
    expect(sx).toBeGreaterThanOrEqual(1);
    expect(sy).toBeGreaterThanOrEqual(1);
  });

  it('4:3 webcam into 4:3 FBO: exact fit, no crop on either axis', () => {
    const { sx, sy } = cameraCoverScale(640, 480, FBO_W, FBO_H);
    expect(sx).toBe(1);
    expect(sy).toBe(1);
  });

  it('1:1 (square) webcam into 4:3 FBO: full width, crop top/bottom', () => {
    const { sx, sy } = cameraCoverScale(480, 480, FBO_W, FBO_H);
    expect(sx).toBe(1);
    expect(sy).toBeCloseTo(FBO_W / FBO_H, 6); // 1.333..
    expect(sy).toBeGreaterThanOrEqual(1);
  });

  it('taller-than-FBO (portrait) webcam into 4:3 FBO: full width, crop top/bottom', () => {
    // 9:16 portrait phone cam.
    const { sx, sy } = cameraCoverScale(360, 640, FBO_W, FBO_H);
    expect(sx).toBe(1);
    expect(sy).toBeGreaterThan(1); // zoom in vertically, crop top/bottom
    expect(sy).toBeCloseTo((FBO_W / FBO_H) / (360 / 640), 6);
  });

  it('cover scaling never shrinks: at least one axis is exactly 1, both >= 1', () => {
    for (const [w, h] of [
      [640, 360], [1280, 720], [640, 480], [480, 480], [360, 640], [1920, 1080],
    ] as const) {
      const { sx, sy } = cameraCoverScale(w, h, FBO_W, FBO_H);
      expect(sx).toBeGreaterThanOrEqual(1);
      expect(sy).toBeGreaterThanOrEqual(1);
      // Exactly one axis is the "fill" axis (== 1); the other is cropped.
      expect(Math.min(sx, sy)).toBe(1);
    }
  });

  it('is resolution-independent (adapts to ctx.res): 16:9 src into any 4:3 FBO is identical', () => {
    const a = cameraCoverScale(1280, 720, 640, 480);
    const b = cameraCoverScale(1280, 720, 1024, 768);
    expect(a.sx).toBeCloseTo(b.sx, 6);
    expect(a.sy).toBeCloseTo(b.sy, 6);
  });

  it('degenerate dimensions fall back to (1,1) (idle / pre-stream)', () => {
    expect(cameraCoverScale(0, 0, FBO_W, FBO_H)).toEqual({ sx: 1, sy: 1 });
    expect(cameraCoverScale(640, 0, FBO_W, FBO_H)).toEqual({ sx: 1, sy: 1 });
    expect(cameraCoverScale(640, 360, 0, FBO_H)).toEqual({ sx: 1, sy: 1 });
    expect(cameraCoverScale(NaN, 360, FBO_W, FBO_H)).toEqual({ sx: 1, sy: 1 });
  });

  it('cropped-axis sampled region stays within [0,1] (no out-of-bounds black bars)', () => {
    // Reproduce the shader: centered = (vUv - 0.5)/scale + 0.5 at the
    // frame edges (vUv 0 and 1). With cover scaling the result must NEVER
    // go outside [0,1] — that range going negative/over-1 is what painted
    // the black bars under the old contain math.
    const { sx, sy } = cameraCoverScale(640, 360, FBO_W, FBO_H);
    for (const vUv of [0, 1]) {
      const cx = (vUv - 0.5) / sx + 0.5;
      const cy = (vUv - 0.5) / sy + 0.5;
      expect(cx).toBeGreaterThanOrEqual(0);
      expect(cx).toBeLessThanOrEqual(1);
      expect(cy).toBeGreaterThanOrEqual(0);
      expect(cy).toBeLessThanOrEqual(1);
    }
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
