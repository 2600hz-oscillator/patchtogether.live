// packages/web/src/lib/video/modules/textmarquee.test.ts
//
// Def-level invariants for TEXTMARQUEE (the engine module). The pixel/GL path
// is covered by the bespoke e2e (textmarquee.spec.ts) + the per-port/VRT
// sweeps; the pos/scroll/layout math by textmarquee-layout.test.ts. Here we
// pin the registry shape: lowercase label (CI guard), CV ports == param ids
// with linear cvScale, defaults centred, and a single video output.

import { describe, it, expect } from 'vitest';
import { textmarqueeDef, TEXTMARQUEE_DEFAULTS } from './textmarquee';

describe('textmarquee def', () => {
  it('is a video source with a lowercase label', () => {
    expect(textmarqueeDef.type).toBe('textmarquee');
    expect(textmarqueeDef.domain).toBe('video');
    expect(textmarqueeDef.category).toBe('sources');
    // CI guard — module labels MUST be lowercase ([[lowercase-module-labels]]).
    expect(textmarqueeDef.label).toBe(textmarqueeDef.label.toLowerCase());
    expect(textmarqueeDef.label).toBe('textmarquee');
  });

  it('exposes a single video output `out`', () => {
    expect(textmarqueeDef.outputs).toEqual([{ id: 'out', type: 'video' }]);
  });

  it('every CV input is continuous: port id == param id + linear cvScale', () => {
    const cvInputs = textmarqueeDef.inputs.filter((p) => p.type === 'cv');
    expect(cvInputs.map((p) => p.id).sort()).toEqual(['posX', 'posY', 'scrollX', 'scrollY']);
    for (const input of cvInputs) {
      // port id == paramTarget (the cross-domain bridge routes onto setParam(portId)).
      expect(input.paramTarget).toBe(input.id);
      // continuous knob modulator → MUST carry a linear cvScale (cv-scale-registry).
      expect(input.cvScale).toEqual({ mode: 'linear' });
    }
  });

  it('every CV input has a matching param with a [0,1] linear range', () => {
    for (const input of textmarqueeDef.inputs.filter((p) => p.type === 'cv')) {
      const param = textmarqueeDef.params.find((p) => p.id === input.paramTarget);
      expect(param, `param for ${input.id}`).toBeDefined();
      expect(param!.min).toBe(0);
      expect(param!.max).toBe(1);
      expect(param!.curve).toBe('linear');
    }
  });

  it('defaults are centred (pos 0.5 = centred so a ±1 LFO sweeps the full range; scroll 0.5 = static)', () => {
    expect(TEXTMARQUEE_DEFAULTS.posX).toBe(0.5);
    expect(TEXTMARQUEE_DEFAULTS.posY).toBe(0.5);
    expect(TEXTMARQUEE_DEFAULTS.scrollX).toBe(0.5);
    expect(TEXTMARQUEE_DEFAULTS.scrollY).toBe(0.5);
    for (const param of textmarqueeDef.params) {
      expect(param.defaultValue).toBe(
        (TEXTMARQUEE_DEFAULTS as unknown as Record<string, number>)[param.id],
      );
    }
  });
});
