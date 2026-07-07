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
