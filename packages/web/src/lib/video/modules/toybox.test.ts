// packages/web/src/lib/video/modules/toybox.test.ts
//
// Def-shape coverage for the TOYBOX module (Phase 5 CV pool). The GL render
// pipeline is exercised by E2E/VRT (jsdom can't render shaders); here we pin
// the port surface — that the 8 generic cv input ports exist with the neutral
// linear hint + no paramTarget (routing is dynamic, handled in setParam) — so a
// regression that drops a cv port fails a fast unit test, not just an e2e sweep.

import { describe, it, expect } from 'vitest';
import { toyboxDef } from './toybox';
import { CV_PORT_IDS } from '$lib/video/toybox-cv-routes';

describe('toyboxDef shape (Phase 5)', () => {
  it('is a video-source module with one video output', () => {
    expect(toyboxDef.type).toBe('toybox');
    expect(toyboxDef.domain).toBe('video');
    expect(toyboxDef.outputs).toHaveLength(1);
    expect(toyboxDef.outputs[0]!.id).toBe('out');
    expect(toyboxDef.outputs[0]!.type).toBe('video');
  });

  it('declares the 8 generic cv input ports (cv1..cv8)', () => {
    const ids = toyboxDef.inputs.map((p) => p.id);
    expect(ids).toEqual([...CV_PORT_IDS]);
    expect(toyboxDef.inputs).toHaveLength(8);
  });

  it('each cv port is type cv with a neutral linear hint + NO paramTarget', () => {
    for (const port of toyboxDef.inputs) {
      expect(port.type).toBe('cv');
      // Neutral-linear hint: the cv-bridge degrades to raw passthrough (no
      // param named 'cvN' to resolve), so TOYBOX re-scales in setParam itself.
      expect(port.cvScale).toEqual({ mode: 'linear' });
      // Dynamic routing → no static paramTarget.
      expect(port.paramTarget).toBeUndefined();
    }
  });

  it('has no static numeric engine params (content/material/combine live in node.data)', () => {
    expect(toyboxDef.params).toEqual([]);
  });
});
