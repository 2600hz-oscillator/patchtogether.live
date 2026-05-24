// art/scenarios/video/phase1-defs.test.ts
//
// "ART scenario" placeholder for Phase-1 video modules.
//
// Why a defs-shape test, not a render test: the existing ART harness
// renders compiled DSP through OfflineAudioContext (audio-domain). The
// video equivalent needs a headless GL context — node-canvas + headless-gl
// is the standard option but adds a substantial dep + native build to
// CI. For Phase-1 we keep video render verification in the e2e suite
// (real Chromium WebGL2; see e2e/tests/video-phase1.spec.ts), and use
// the ART workspace just to assert the def shapes are stable across
// commits — same gate as the other video unit tests, but importable
// from the ART harness for Phase-2 when we add headless-gl render.
//
// When headless-gl lands, replace this file with per-module render
// scenarios writing PNG + pixel-variance comparisons against
// art/baselines/video/.

import { describe, expect, it } from 'vitest';
import { listVideoModuleDefs, getVideoModuleDef } from '../../../packages/web/src/lib/video/module-registry';
// Side-effect import auto-registers all video defs.
import '../../../packages/web/src/lib/video/modules';

const PHASE1_TYPES = [
  'inwards',
  'picturebox',
  'destructor',
  'chroma',
  'luma',
  'colorizer',
  'feedback',
  'videoMixer',
];

describe('ART video Phase-1 — module def stability', () => {
  it('all 8 Phase-1 video modules registered', () => {
    const types = new Set(listVideoModuleDefs().map((d) => d.type));
    for (const t of PHASE1_TYPES) {
      expect(types.has(t), `${t} registered`).toBe(true);
    }
  });

  it('every def declares non-empty port surface', () => {
    for (const t of PHASE1_TYPES) {
      const def = getVideoModuleDef(t)!;
      const total = def.inputs.length + def.outputs.length;
      expect(total, `${t} has at least one port`).toBeGreaterThan(0);
    }
  });

  // Pin the param ranges so a regression that doubles `decay` from
  // [0,2] to [0,4] is caught here rather than in subjective UI tweaks.
  it('FEEDBACK decay range stable: [0, 2]', () => {
    const def = getVideoModuleDef('feedback')!;
    const decay = def.params.find((p) => p.id === 'decay');
    expect(decay?.min).toBe(0);
    expect(decay?.max).toBe(2);
  });

  it('LINES orient param stable: [0, 1]', () => {
    const def = getVideoModuleDef('lines')!;
    const orient = def.params.find((p) => p.id === 'orient');
    expect(orient?.min).toBe(0);
    expect(orient?.max).toBe(1);
  });

  it('CHROMA threshold default stable: 0.2 (green-screen tuning, v2 HSV keyer)', () => {
    // v2 schema renamed `tolerance` → `threshold`. The default was
    // re-tuned from 0.4 (RGB-distance era) to 0.2 (HSV-hue-distance) so
    // a fresh CHROMA still keys a green-screen cleanly on default knobs.
    const def = getVideoModuleDef('chroma')!;
    const th = def.params.find((p) => p.id === 'threshold');
    expect(th?.defaultValue).toBe(0.2);
  });
});
