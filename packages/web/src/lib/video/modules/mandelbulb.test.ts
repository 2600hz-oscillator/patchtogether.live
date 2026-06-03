// packages/web/src/lib/video/modules/mandelbulb.test.ts
//
// Unit tests for the MANDELBULB module def shape. The GL raymarch pipeline
// is exercised by E2E (jsdom can't render shaders); the DE algebra is in
// mandelbulb-math.test.ts.

import { describe, it, expect } from 'vitest';
import { mandelbulbDef, MANDELBULB_DEFAULTS } from './mandelbulb';

describe('mandelbulbDef shape', () => {
  it('is a video-source module with one mono-video output', () => {
    expect(mandelbulbDef.type).toBe('mandelbulb');
    expect(mandelbulbDef.domain).toBe('video');
    expect(mandelbulbDef.outputs).toHaveLength(1);
    expect(mandelbulbDef.outputs[0]!.id).toBe('video_out');
    expect(mandelbulbDef.outputs[0]!.type).toBe('mono-video');
  });

  it('declares zoom + every spatial control as a CV input', () => {
    const ids = mandelbulbDef.inputs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'detail_cv', 'hue_cv', 'power_cv', 'rotate_x_cv', 'rotate_y_cv', 'zoom_cv',
    ]);
  });

  it('EVERY CV input has a matching param target + linear cvScale (full-range sweep)', () => {
    // The user requirement: zoom + spatial controls under BOTH CV and knobs.
    // Each cv port must map to a real param so the bridge sweeps it.
    const paramIds = new Set(mandelbulbDef.params.map((p) => p.id));
    for (const input of mandelbulbDef.inputs) {
      expect(input.type).toBe('cv');
      expect(input.paramTarget, `${input.id} paramTarget`).toBeTruthy();
      expect(paramIds.has(input.paramTarget!), `${input.paramTarget} is a real param`).toBe(true);
      expect(input.cvScale?.mode, `${input.id} cvScale`).toBe('linear');
    }
  });

  it('every CV-targeted param is also a KNOB on the card (knob + CV each)', () => {
    // Each input.paramTarget must appear in params (so the card renders a
    // knob for it) — the "knob AND CV" guarantee.
    const cvTargets = mandelbulbDef.inputs.map((p) => p.paramTarget);
    const knobIds = new Set(mandelbulbDef.params.map((p) => p.id));
    for (const t of cvTargets) {
      expect(knobIds.has(t!), `${t} has a knob`).toBe(true);
    }
  });

  it('declares the documented param set', () => {
    const ids = mandelbulbDef.params.map((p) => p.id).sort();
    expect(ids).toEqual([
      'autospin', 'detail', 'hue', 'power', 'rotate_x', 'rotate_y', 'screen_on', 'zoom',
    ]);
  });

  it('power defaults to 8 (the classic Mandelbulb) and detail to ~20', () => {
    expect(MANDELBULB_DEFAULTS.power).toBe(8);
    expect(MANDELBULB_DEFAULTS.detail).toBe(20);
    const power = mandelbulbDef.params.find((p) => p.id === 'power')!;
    expect(power.defaultValue).toBe(8);
  });

  it('detail / autospin / screen_on are discrete toggles/steppers', () => {
    for (const k of ['detail', 'autospin', 'screen_on'] as const) {
      expect(mandelbulbDef.params.find((p) => p.id === k)?.curve).toBe('discrete');
    }
  });

  it('declares NO audio output ports (video-only module)', () => {
    // Honest port declaration — a video-only module must not declare
    // audio_l/audio_r unless it actually wires them.
    for (const o of mandelbulbDef.outputs) {
      expect(o.type).not.toBe('audio');
    }
  });

  it('files itself into the video palette via def.palette (no shared edit)', () => {
    expect(mandelbulbDef.palette).toEqual({ top: 'Video modules', sub: 'Sources' });
  });
});
