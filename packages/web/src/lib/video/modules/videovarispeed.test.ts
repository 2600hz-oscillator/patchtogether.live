// packages/web/src/lib/video/modules/videovarispeed.test.ts
//
// Locks down VIDEOVARISPEED's module-def shape. Mirrors videobox.test.ts —
// no factory/runtime execution (those need WebGL + a real <video> element;
// covered in e2e).

import { describe, expect, it } from 'vitest';
import { videoVarispeedDef, VIDEOVARISPEED_MAX_SLOT_BYTES } from './videovarispeed';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
import { ASSET_SLOT_NOTES, slotForVOct } from '$lib/video/asset-select';
import { midiToVOct } from '$lib/audio/note-entry';
// Side-effect import auto-registers every video def (including ours).
import '$lib/video/modules';

describe('videoVarispeedDef — module def shape', () => {
  it('appears in the global video registry list (auto-registered via barrel import)', () => {
    const types = listVideoModuleDefs().map((d) => d.type);
    expect(types).toContain('videovarispeed');
    expect(getVideoModuleDef('videovarispeed')).toBe(videoVarispeedDef);
  });

});

describe('videoVarispeedDef — 7-slot asset selector ports', () => {
  it('exports a documented per-slot size cap (100 MB)', () => {
    expect(VIDEOVARISPEED_MAX_SLOT_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('videoVarispeedDef — asset_gate slot-select decision (mapping)', () => {
  // The card runs slotForVOct(readParam('asset_pitch')) on each asset_gate
  // rising edge. These assertions lock down the same decision the card makes:
  // each default-clip row note maps to its slot; black keys map to null.
  it('the 7 default-clip rows (C3..B3) map to slots 0..6 via V/oct', () => {
    ASSET_SLOT_NOTES.forEach((midi, i) => {
      expect(slotForVOct(midiToVOct(midi)), `note ${midi} → slot ${i}`).toBe(i);
    });
  });

  it('a black-key V/oct (C#4) maps to null (the gate event is ignored)', () => {
    expect(slotForVOct(midiToVOct(61))).toBeNull();
  });
});
