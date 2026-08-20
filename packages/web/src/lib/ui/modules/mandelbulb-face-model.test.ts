// packages/web/src/lib/ui/modules/mandelbulb-face-model.test.ts
//
// MANDELBULB — the permanent gates on the claims this face is built from that
// nothing else covers.
//
// ⚠ WHAT IS DELIBERATELY *NOT* HERE. The glyph finding — that this is the one
// video def whose `primaryAudioOutPortId` resolves, binding a live glyph to a
// tap that cannot see a video-domain node — is already proven permanently in
// `mandelbulb-glyph-tap.test.ts`, including a positive control. Re-asserting it
// here would be a second copy of one truth, which is how two gates drift apart.
// This file covers the parts that gate has no opinion on.

import { describe, expect, it } from 'vitest';
import { mandelbulbDef } from '$lib/video/modules/mandelbulb';
import {
  declaredParamCells,
  momentaryParamIds,
  paramCellKind,
} from '$lib/ui/workflow/shell-control-kind';
import { curatedFace, laneOrder } from '$lib/ui/workflow/curated-face';
import { laneGlyphFor } from '$lib/ui/workflow/module-shell-model';

const MOMENTARY = momentaryParamIds(mandelbulbDef);
const AUTHORED_CELLS = declaredParamCells(mandelbulbDef);
const face = mandelbulbDef.face;

describe('mandelbulb face — the XY pad is over the SLICE PLANE, not the camera', () => {
  it('declares exactly one pad, on slice_ry x slice_y', () => {
    // ⚠ THE CORRECTION THIS PINS. `face-migration-inventory.ts` used to say
    // "the orbit drag over the preview is a 2-D camera gesture -> the `xy`
    // cell". There IS no orbit drag: the card's pointer handlers write
    // `slice_y` (vertical) and `slice_ry` (horizontal) and only fire while
    // SLICE is ON; `rotate_x`/`rotate_y` are knob-only. A face built to the old
    // note would have shipped a pad wired to two params nothing drags — and it
    // would have looked completely fine.
    expect(face?.xyPads?.length).toBe(1);
    expect(face?.xyPads?.[0]?.x).toBe('slice_ry');
    expect(face?.xyPads?.[0]?.y).toBe('slice_y');
    // The camera params are NOT the pad, and that is the assertion that would
    // have caught the old note.
    const padIds = new Set([face?.xyPads?.[0]?.x, face?.xyPads?.[0]?.y]);
    expect(padIds.has('rotate_x')).toBe(false);
    expect(padIds.has('rotate_y')).toBe(false);
  });

  it('both pad axes are CONTINUOUS and both are ranked', () => {
    // module-face-lint enforces these globally; asserted here because the pad
    // is the one cell whose contract spans TWO params and a future re-point to
    // a discrete param would be a silent stepper-wearing-a-joystick.
    for (const id of ['slice_ry', 'slice_y']) {
      const pd = (mandelbulbDef.params ?? []).find((p) => p.id === id);
      expect(pd, `param ${id}`).toBeTruthy();
      expect(pd!.curve, `${id} must be continuous`).not.toBe('discrete');
      expect(face?.order ?? [], `${id} must stay ranked`).toContain(id);
    }
  });

  it('the pad is DOCK-ONLY — it costs no lane rank', () => {
    // `laneOrder` excludes a declared pad's anchor, which is what lets it rank
    // high without stealing one of the 1-3 lane cells. If that ever changed,
    // the lane ladder below would silently lose a control to a square pad.
    expect(laneOrder(face!)).not.toContain('slice_ry');
  });
});

describe('mandelbulb face — the two SCREEN controls are different things', () => {
  it('screen_on is a ranked PARAM toggle, not the preview switch', () => {
    // The preview switch is `node.data.previewCollapsed` and lives in the
    // extension body; this one is product behaviour (it gates the raymarch).
    // Both exist on purpose — see the def's face block for the full argument.
    expect(face?.order ?? []).toContain('screen_on');
    const pd = (mandelbulbDef.params ?? []).find((p) => p.id === 'screen_on');
    expect(paramCellKind(pd!, MOMENTARY, 'dock', AUTHORED_CELLS)).toBe('toggle');
  });

  it('all three card BUTTONS survive promotion as toggle cells', () => {
    // SPIN / SCRN / SLICE are the card's three latching buttons. Promotion
    // deletes the card, so this is the assertion that they did not vanish.
    for (const id of ['autospin', 'screen_on', 'slice']) {
      const pd = (mandelbulbDef.params ?? []).find((p) => p.id === id);
      expect(pd, `param ${id}`).toBeTruthy();
      expect(paramCellKind(pd!, MOMENTARY, 'dock', AUTHORED_CELLS), `${id} cell`).toBe('toggle');
      expect(face?.order ?? [], `${id} ranked`).toContain(id);
    }
  });

  it('a CONTINUOUS control still resolves a KNOB (negative control)', () => {
    for (const id of ['power', 'zoom', 'hue']) {
      const pd = (mandelbulbDef.params ?? []).find((p) => p.id === id);
      expect(paramCellKind(pd!, MOMENTARY, 'dock', AUTHORED_CELLS), `${id} cell`).toBe('knob');
    }
  });
});

describe('mandelbulb face — ranking and completeness', () => {
  it('ranks POWER first and demotes the capped DETAIL dial', () => {
    // POWER is the only control that changes what the OBJECT is. DETAIL is
    // ranked low on measurement, not taste: the GLSL loop caps at
    // MAX_ITER = 16 while the param is declared 4..30, so 15 of its 27
    // positions render bit-identically and the shipped default of 20 sits
    // inside that dead band (#2036). It still moves audio_out, so it stays a
    // real control — just not a high-ranked one on a face about a picture.
    expect(face?.order?.[0]).toBe('power');
    const order = face?.order ?? [];
    expect(order.indexOf('detail')).toBeGreaterThan(order.indexOf('power'));
    expect(order.indexOf('detail')).toBeGreaterThan(order.indexOf('zoom'));
    expect(order.indexOf('detail')).toBeGreaterThan(order.indexOf('slice'));
  });

  it('every page control is ranked, and every ranked control is on a page', () => {
    const ranked = [...(face?.order ?? [])].sort();
    const paged = (face?.pages ?? []).flatMap((p) => [...p.controls]).sort();
    expect(paged).toEqual(ranked);
    // ...and both cover the def's params MINUS the declared non-controls.
    // DERIVED MEMBERSHIP in both directions: no count is typed, and a new
    // param that nobody classified would fail here rather than silently
    // appearing as a rotary on the faceplate.
    const notControls = new Set((mandelbulbDef.noUserControl ?? []).map((n) => n.param));
    const expected = (mandelbulbDef.params ?? [])
      .map((p) => p.id)
      .filter((id) => !notControls.has(id))
      .sort();
    expect(ranked).toEqual(expected);
  });

  it('the lane budget is set by the PICTURE, not the declared glyph', () => {
    // #1785's trap, same as every other video face: `face.glyph` is a mandatory
    // 'none' but `laneGlyphFor` answers 'picture', because `hasVideoSurface`
    // mounts a live thumbnail that SPENDS a lane cell.
    expect(face?.glyph).toBe('none');
    expect(laneGlyphFor(mandelbulbDef as never)).toBe('picture');
    const keys = (tier: 'mini' | 'compact' | 'full' | 'dock') =>
      curatedFace(mandelbulbDef as never, tier)?.controls.map((c) => c.key) ?? [];
    expect(keys('mini')).toEqual(['power']);
    expect(keys('compact')).toEqual(['power', 'zoom']);
    expect(keys('full')).toEqual(['power', 'zoom', 'slice']);
    // ⚠ THE DOCK RENDERS ONE FEWER CELL THAN `order` HAS KEYS, and that is the
    // pad doing its job: `slice_y` is FOLDED INTO the `slice_ry` cell rather
    // than rendering a second time. Asserted as the exact difference so a pad
    // that silently stopped folding (two dials where a gesture should be) is
    // RED rather than invisible.
    const dockKeys = keys('dock');
    const ranked = face?.order ?? [];
    expect(dockKeys).toEqual(ranked.filter((k) => k !== 'slice_y'));
    expect(ranked.length - dockKeys.length, 'exactly one folded axis').toBe(1);
  });
});

describe('mandelbulb — the slice waveform seam', () => {
  it('⚠ AUTOSPIN SHIPS ON, so the module animates at rest and NEEDS a freeze', () => {
    // ⚠ THIS ASSERTION EXISTS BECAUSE IT CAUGHT THE BUG. The first draft of
    // this face declared no `freeze` param, reasoning that the shader has no
    // `uTime` uniform and reads its camera from params — every clause true, the
    // conclusion false. `autospin` defaults to 1 and `draw` advances
    // `spinPhase` off `frame.time` every frame, so the VRT scenes would have
    // been a moving target. Reading the draw path did not catch it; asserting
    // the DEFAULT did.
    const spin = (mandelbulbDef.params ?? []).find((p) => p.id === 'autospin');
    expect(spin, 'autospin param').toBeTruthy();
    expect(spin!.defaultValue, 'AUTOSPIN ships ON — this is why a freeze is required').toBe(1);

    // So the determinism param must exist, and must be invisible.
    const freeze = (mandelbulbDef.params ?? []).find((p) => p.id === 'freeze');
    expect(freeze, 'a `freeze` param is REQUIRED while autospin defaults on').toBeTruthy();
    const notControls = (mandelbulbDef.noUserControl ?? []).map((n) => n.param);
    expect(notControls, 'freeze must never paint as a control').toContain('freeze');
    expect(face?.order ?? [], 'freeze must not be ranked').not.toContain('freeze');

    // ⚠ THE COUPLING IS THE POINT: if AUTOSPIN ever shipped OFF the freeze
    // could be argued away, so the two facts are asserted TOGETHER rather than
    // in separate tests that could drift apart.
    const entry = (mandelbulbDef.noUserControl ?? []).find((n) => n.param === 'freeze');
    expect(entry!.writer).toBe('internal');
    expect((entry!.why ?? '').length).toBeGreaterThan(40);
  });
});
