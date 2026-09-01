// packages/web/src/lib/ui/workflow/joystick-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for JOYSTICK's faceplate — the file
// `joystick-persist-model.test.ts` spent two header revisions promising.
//
// joystick shipped as the owner's TWO-ORDINARY-CELLS FALLBACK (2026-08-31,
// owner-decisions item 2): NO `xyPads`, the two axes ranked as plain knob
// cells, and the real pad carried as the `joystick` extension's `fullViewBody`
// — a deliberately REDUNDANT surface at the dock (the twotracks shape). That
// design is held together by absences as much as by presences, and absences
// are exactly what the registry-driven sweeps cannot ask for:
//
//   * `module-face-lint`'s lane clause proves the lane paints the ranked
//     cells — it cannot say the face MUST NOT declare `xyPads` (declaring one
//     would empty the lane and go red there, but only as a generic offender
//     message a "tidy" could try to fix by widening the gate instead).
//   * `faces-parity` proves each `control-*` cell operates — it cannot say the
//     PAD must not emit a second `control-pos_x`, because a doubled anchor
//     only fails 25 minutes later in the browser lane as a multiset mismatch.
//   * `face-xy-body-source.test.ts` is scoped to `surface:'body'` pads BY
//     DESIGN and its own header names this body as structurally invisible to
//     it — so the drag contract the body ports from the legacy card
//     (#1963 no-snap-back and the rest) is pinned HERE or nowhere.
//
// ⚠ EACH ASSERTION EXISTS BECAUSE A PLAUSIBLE EDIT WOULD DEFEAT IT QUIETLY,
// and the comment on each says which edit.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '$lib/audio/modules';
import { joystickDef } from '$lib/audio/modules/joystick';
import { STRICT_FACES } from './strict-faces';
import { glyphBinding } from './shell-glyph-live';
import { curatedFace, dockFacePlan, dockPlanControls, laneOrder } from './curated-face';
import type { FaceDefLike } from './curated-face';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = resolve(HERE, '../modules');

const FACE = () => joystickDef.face!;
const LANE_TIERS = ['mini', 'compact', 'full'] as const;

/** The fullViewBody component source, resolved THROUGH the extension file the
 *  way the shell and the source sweeps resolve it — a renamed or re-pointed
 *  file fails here rather than silently pinning a stale copy. */
function padBodySource(): string {
  const ext = resolve(MODULES_DIR, 'joystick', 'shell-extension.ts');
  expect(existsSync(ext), 'joystick/shell-extension.ts exists').toBe(true);
  const src = readFileSync(ext, 'utf8');
  const m = /fullViewBody:\s*([A-Za-z0-9_]+)/.exec(src);
  expect(m, 'the extension fills fullViewBody').toBeTruthy();
  const imported = new RegExp(`import\\s+${m![1]}\\s+from\\s+'\\./([^']+)'`).exec(src);
  expect(imported, 'the fullViewBody component is imported from this directory').toBeTruthy();
  const file = resolve(MODULES_DIR, 'joystick', imported![1]!);
  expect(existsSync(file), `the component file exists: ${imported![1]}`).toBe(true);
  return readFileSync(file, 'utf8');
}

describe('joystick face — the promotion itself', () => {
  it('is PROMOTED, not merely authored', () => {
    expect(joystickDef.face, 'a face is declared').toBeTruthy();
    expect(STRICT_FACES.has('joystick'), 'and it is promoted').toBe(true);
  });

  it('`glyph: none` is RUN through glyphBinding, not argued from the module', () => {
    // ⚠ TWO WAYS TO GET THIS WRONG, and only one is caught by the registry
    // lint. Any literal but 'algorithm' falls through to `{ kind: 'static' }`
    // (four `cv` outputs, no audio out ⇒ `primaryAudioOutPortId` null), which
    // the dead-glyph clause reddens — loud. But `glyph: 'algorithm'` would
    // RESOLVE, because the layout-source branch fires for any def carrying a
    // `face.extension` string, and this one does — passing the dead-glyph
    // clause while pointing at an extension that exports no `glyph` slot.
    // Silent. That is the edit this assertion exists for.
    expect(FACE().glyph).toBe('none');
    expect(glyphBinding(joystickDef).kind).toBe('none');
    const asAlgorithm = { ...joystickDef, face: { ...FACE(), glyph: 'algorithm' as const } };
    expect(glyphBinding(asAlgorithm).kind, 'would pass the dead-glyph clause').toBe('algorithm');
  });
});

describe('joystick face — the TWO-ORDINARY-CELLS shape (owner decision 2026-08-31)', () => {
  it('declares NO xyPads — the one-field edit that would empty the lane', () => {
    // ⚠ THE PLAUSIBLE EDIT IS AN UPGRADE, NOT A MISTAKE: someone re-reads the
    // inventory's pre-decision prose ("migrate onto the shared `xy` cell,
    // never two knobs"), declares the pad, and the lane resolves to ZERO —
    // module-face-lint goes red with a generic message that reads like the
    // GATE needs widening. This leg is where the edit meets its actual
    // ruling: the owner declined the gate edit and chose this shape.
    expect(FACE().xyPads, 'no declared pad — the axes are ordinary cells').toBeUndefined();
    expect(FACE().order).toEqual(['pos_x', 'pos_y']);
    expect(FACE().paramCells, 'plain knobs — no declared cell kinds').toBeUndefined();
  });

  it('every lane tier really paints at least one axis cell, and FULL paints both', () => {
    // The registry sweep asserts non-emptiness; the per-tier LADDER is this
    // module's own contract (X before Y — `order` is rank, and a swap would
    // re-point the mini tile silently while every generic gate stayed green).
    for (const tier of LANE_TIERS) {
      const controls = curatedFace(joystickDef as unknown as FaceDefLike, tier)?.controls ?? [];
      expect(controls.length, `lane tier '${tier}' paints something`).toBeGreaterThan(0);
      expect(controls[0]?.key, `rank 1 at '${tier}' is the X axis`).toBe('pos_x');
    }
    const full = curatedFace(joystickDef as unknown as FaceDefLike, 'full')!.controls;
    expect(full.map((c) => c.key), 'the full tier paints both axes').toEqual(['pos_x', 'pos_y']);
    // And the pad anchor's absence is what keeps `laneOrder` a no-op here.
    expect(laneOrder(FACE())).toEqual(['pos_x', 'pos_y']);
  });

  it('the dock plan is ONE band with each axis EXACTLY once', () => {
    // The redundancy contract's band half: the knobs beneath the pad are the
    // parity-credited cells, each exactly once. A second cell for either axis
    // (a declared pad, a cluster duplicate) fails here before faces-parity
    // fails it in the browser lane.
    const bands = dockFacePlan(joystickDef as unknown as FaceDefLike)!;
    expect(bands.length, 'a page-less face renders the one __all band').toBe(1);
    expect(dockPlanControls(bands).map((c) => c.key).sort()).toEqual(['pos_x', 'pos_y']);
  });

  it('NEGATIVE CONTROL: the pad-only variant of THIS LIVE DEF still empties the lane', () => {
    // module-face-lint's permanent fixture is a synthetic literal; this leg
    // runs the SAME derivation over the live def plus the one field the owner
    // declined, proving the fallback is still load-bearing — if a platform
    // change ever lets a declared pad reach the lane, this goes red and the
    // two-ordinary-cells shape (and its stated redundancy cost) is up for
    // re-judgement rather than silently obsolete.
    const padOnly = {
      ...joystickDef,
      face: { ...FACE(), xyPads: [{ x: 'pos_x', y: 'pos_y' }] },
    } as unknown as FaceDefLike;
    for (const tier of LANE_TIERS) {
      expect(
        curatedFace(padOnly, tier)?.controls.length ?? 0,
        `lane tier '${tier}' under the declined xyPads shape`,
      ).toBe(0);
    }
  });
});

describe('joystick face — the PAD BODY (source-pinned, the way face-xy-body-source cannot)', () => {
  it('ports the card drag contract: both axes, tracked commits, flush, capture recovery, re-centre', () => {
    const src = padBodySource();
    expect(src.length, 'a real component, not a stub').toBeGreaterThan(500);
    // Both axes commit through the tracked rAF-coalesced pump — the raw-write
    // debt stays paid on this surface too.
    expect(src).toMatch(/createDragCommit/);
    expect(src).toMatch(/set\('pos_x'\)/);
    expect(src).toMatch(/set\('pos_y'\)/);
    // The Y flip: dragging UP is +y, the convention every joystick surface
    // in the repo shares.
    expect(src).toMatch(/-\(py \* 2 - 1\)/);
    // Flush on pointerup — the final drag position must reach the store
    // (#1963: it IS the persisted value), and lostpointercapture recovery.
    expect(src).toMatch(/onpointerup/);
    expect(src).toMatch(/onlostpointercapture/);
    expect((src.match(/\.flush\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // Jump-to-point needs capture, or the drag dies at the pad edge.
    expect(src).toMatch(/setPointerCapture/);
    // Double-click re-centres TO THE DEFAULTS — the gesture that replaced the
    // snap-back — and it is the only path that writes a value the pointer is
    // not at.
    expect(src).toMatch(/function onDblClick[\s\S]*?defaultFor\('pos_x'\)/);
    // No snap-back: nothing in the pointerup path writes a position.
    expect(src).toMatch(/function onPointerUp[\s\S]*?releasePointerCapture/);
    expect(/function onPointerUp[\s\S]*?\.commit\([\s\S]*?releasePointerCapture/.test(src),
      'onPointerUp must not commit a value — release leaves the stick where it is').toBe(false);
  });

  it('⚠ is NOT a face cell: no parity anchor, no cell contract, no canvas, no painted values', () => {
    const src = padBodySource();
    // The redundancy discipline. A `control-*` anchor or `data-control-params`
    // here would double-count both axes in faces-parity's exact multiset (a
    // failure that only shows in the browser lane, ~25 minutes late), and the
    // inverse leg of face-xy-body-source would refuse the undeclared pad.
    // (Attribute-ASSIGNMENT syntax, deliberately: the body's own header names
    // these strings in prose, and a probe that cannot tell code from a comment
    // would forbid the comment that explains the rule.)
    expect(src).not.toMatch(/data-control-params\s*=/);
    expect(src).not.toMatch(/data-testid="control-/);
    expect(src).not.toMatch(/data-cell-(kind|control|key)\s*=/);
    // No canvas: the `control-grid` body role's predicate, and the WebGL
    // attest argument (basis membership is derived from CONTENT — a drawn pad
    // would enrol an audio utility permanently).
    expect(src).not.toMatch(/<canvas/);
    // The values are SPEAKABLE, not painted (owner-decisions item 11: the
    // card's readout row is the named deletion of this promotion). aria-label
    // is the pad's value home — role="application" has no aria-valuetext.
    expect(src).toMatch(/aria-label/);
    expect(src).not.toMatch(/joystick-readout|xy-readout/);
    // And the body's own testids are module-owned, so specs can reach the pad
    // without colliding with the band cells.
    expect(src).toMatch(/data-testid="joystick-face-pad"/);
    expect(src).toMatch(/data-testid="joystick-face-dot"/);
  });
});
