// packages/web/src/lib/video/modules/doom.test.ts
//
// Locks down DOOM's module-def shape — port set, paramTarget wiring,
// maxInstances, audio output declarations. No factory/runtime
// execution here (those need WebGL / WASM and live in the unit and
// e2e suites separately).

import { describe, it, expect } from 'vitest';
import { doomDef } from './doom';
import { CV_GATE_PORT_IDS } from '$lib/doom/doomkeys';

describe('doomDef — module def shape', () => {
  it('registers with the right type + domain + category + max-instances', () => {
    expect(doomDef.type).toBe('doom');
    expect(doomDef.domain).toBe('video');
    expect(doomDef.category).toBe('sources');
    expect(doomDef.maxInstances).toBe(1);
    expect(doomDef.label).toBe('DOOM');
  });

  it('declares exactly the 7 CV-gate input ports the plan calls for', () => {
    const ids = doomDef.inputs.map((p) => p.id);
    expect(ids).toEqual([...CV_GATE_PORT_IDS]);
    for (const inp of doomDef.inputs) {
      expect(inp.type).toBe('cv');
      // paramTarget routes the CV through engine setParam — the synthetic
      // cv_<port> param is then edge-detected into key-down/up events.
      expect(inp.paramTarget).toBe(`cv_${inp.id}`);
    }
  });

  it('declares stereo audio outputs that ride the video → audio bridge', () => {
    const outs = doomDef.outputs.map((p) => p.id);
    expect(outs).toEqual(['audio_l', 'audio_r']);
    for (const out of doomDef.outputs) {
      expect(out.type).toBe('audio');
    }
  });

  it('every cv-gate port has a matching synthetic param', () => {
    const paramIds = new Set(doomDef.params.map((p) => p.id));
    for (const port of CV_GATE_PORT_IDS) {
      expect(paramIds.has(`cv_${port}`), `expected param cv_${port}`).toBe(true);
    }
  });

  it('exposes the run / audioGain user-facing params (no surprises)', () => {
    const paramIds = doomDef.params.map((p) => p.id);
    expect(paramIds).toContain('running');
    expect(paramIds).toContain('audioGain');
  });

  it('schemaVersion is 1 (first slice)', () => {
    expect(doomDef.schemaVersion).toBe(1);
  });
});
