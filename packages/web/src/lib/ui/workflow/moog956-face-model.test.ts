// packages/web/src/lib/ui/workflow/moog956-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the 956's faceplate.
//
// This face is held together by ABSENCES and by an ARITY, and the registry
// sweeps can ask for neither:
//
//   * `module-face-lint`'s lane clause proves the lane paints the ranked cells.
//     It cannot say the strip must NOT carry the cell contract — a doubled
//     `control-pos` anchor only fails 25 minutes later in the browser lane, as
//     a `faces-parity` multiset mismatch.
//   * `face-rack-status-source`'s `EXTENSION_BODY_ROLES` sweep reaches
//     `fullViewBody` ONLY (`extensionsWithBody` greps for `fullViewBody:`), so
//     the `tileBody` — the half of this promotion that exists to close a parity
//     hole — is outside every source gate in the tree. It is pinned HERE or
//     nowhere.
//   * Nothing anywhere asserts the ARITHMETIC the `tileBody` answers:
//     `faceTierCap('compact', 'none') === 3` with `gate` ranked fourth. If a
//     future cap change made `gate` reachable on the tile, or a re-rank pushed
//     something else off, the argument for the tile strip changes and should be
//     re-judged rather than silently obsolete.
//
// ⚠ EACH ASSERTION EXISTS BECAUSE A PLAUSIBLE EDIT WOULD DEFEAT IT QUIETLY, and
// the comment on each says which edit.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '$lib/audio/modules';
import { moog956Def } from '$lib/audio/modules/moog956';
import { STRICT_FACES } from './strict-faces';
import { glyphBinding } from './shell-glyph-live';
import {
  curatedFace,
  dockFacePlan,
  dockPlanControls,
  faceTierCap,
} from './curated-face';
import type { FaceDefLike } from './curated-face';
import { laneGlyphFor } from './module-shell-model';
import { looksLikeSwitch, momentaryParamIds } from './shell-control-kind';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = resolve(HERE, '../modules');
const EXT_DIR = resolve(MODULES_DIR, 'moog956');

const FACE = () => moog956Def.face!;
const LANE_TIERS = ['mini', 'compact', 'full'] as const;

/** A component the extension names for one of its slots, resolved THROUGH the
 *  extension file the way the shell and the source sweeps resolve it — a
 *  renamed or re-pointed file fails here rather than pinning a stale copy. */
function slotSource(slot: 'fullViewBody' | 'tileBody'): string {
  const ext = resolve(EXT_DIR, 'shell-extension.ts');
  expect(existsSync(ext), 'moog956/shell-extension.ts exists').toBe(true);
  const src = readFileSync(ext, 'utf8');
  const m = new RegExp(`${slot}:\\s*([A-Za-z0-9_]+)`).exec(src);
  expect(m, `the extension fills ${slot}`).toBeTruthy();
  const imported = new RegExp(`import\\s+${m![1]}\\s+from\\s+'\\./([^']+)'`).exec(src);
  expect(imported, `the ${slot} component is imported from this directory`).toBeTruthy();
  const file = resolve(EXT_DIR, imported![1]!);
  expect(existsSync(file), `the component file exists: ${imported![1]}`).toBe(true);
  return readFileSync(file, 'utf8');
}

/** The shared strip both slots mount. */
function stripSource(): string {
  const file = resolve(EXT_DIR, 'Moog956RibbonStrip.svelte');
  expect(existsSync(file), 'the shared strip exists').toBe(true);
  return readFileSync(file, 'utf8');
}

describe('moog956 face — the promotion itself', () => {
  it('is PROMOTED, not merely authored', () => {
    expect(moog956Def.face, 'a face is declared').toBeTruthy();
    expect(STRICT_FACES.has('moog956'), 'and it is promoted').toBe(true);
  });

  it('`glyph: none` is RUN through glyphBinding, not argued from the module', () => {
    // ⚠ TWO WAYS TO GET THIS WRONG AND ONLY ONE IS LOUD. Any literal but
    // 'algorithm' falls through to `{ kind: 'static' }` (outputs are `pitch`
    // and `gate`, so `primaryAudioOutPortId` is null), which the dead-glyph
    // clause reddens. But `glyph: 'algorithm'` would RESOLVE — the
    // layout-source branch fires for any def carrying a `face.extension`
    // string, and this one does — passing the dead-glyph clause while pointing
    // at an extension that exports no `glyph` slot. Silent. That is the edit
    // this assertion exists for.
    expect(FACE().glyph).toBe('none');
    expect(glyphBinding(moog956Def).kind).toBe('none');
    const asAlgorithm = { ...moog956Def, face: { ...FACE(), glyph: 'algorithm' as const } };
    expect(glyphBinding(asAlgorithm).kind, 'would pass the dead-glyph clause').toBe('algorithm');
    // …and the extension really does NOT export a glyph slot, so the trap the
    // clause above describes is a live one rather than hypothetical.
    const ext = readFileSync(resolve(EXT_DIR, 'shell-extension.ts'), 'utf8');
    expect(/^\s*glyph:/m.test(ext), 'no glyph slot to fall back on').toBe(false);
  });
});

describe('moog956 face — the RANK, and the arithmetic the tileBody answers', () => {
  it('ranks all four params, `pos` first, as a FADER', () => {
    // A re-rank is the plausible edit: it looks cosmetic and it silently
    // re-points the mini tile and moves what falls off the compact one.
    expect(FACE().order).toEqual(['pos', 'scale', 'offset', 'gate']);
    expect(FACE().paramCells, 'the position is a THROW, not a dial').toEqual({ pos: 'fader' });
    expect(FACE().xyPads, 'a 1-D control is not a pad').toBeUndefined();
  });

  it('⚠ `gate` FALLS OFF the compact lane tile — the parity hole the tile strip closes', () => {
    // THE MEASUREMENT, not the assumption. This is the whole argument for
    // shipping a `tileBody` on an audio utility with no picture, and if a cap
    // change ever made `gate` reachable on the tile the argument should be
    // re-judged rather than left standing as folklore.
    expect(faceTierCap('compact', 'none'), 'the compact tile paints three cells').toBe(3);
    expect(laneGlyphFor(moog956Def as unknown as FaceDefLike), 'and there is no glyph to shrink it')
      .toBe('none');
    const compact = curatedFace(moog956Def as unknown as FaceDefLike, 'compact')!.controls;
    expect(compact.map((c) => c.key)).toEqual(['pos', 'scale', 'offset']);
    expect(
      compact.some((c) => c.key === 'gate'),
      'if this ever goes true, re-read the tileBody argument in the def',
    ).toBe(false);
  });

  it('every lane tier paints something, and rank 1 is always the ribbon position', () => {
    for (const tier of LANE_TIERS) {
      const controls = curatedFace(moog956Def as unknown as FaceDefLike, tier)?.controls ?? [];
      expect(controls.length, `lane tier '${tier}' paints something`).toBeGreaterThan(0);
      expect(controls[0]?.key, `rank 1 at '${tier}' is the ribbon position`).toBe('pos');
    }
  });

  it('the dock plan is ONE band with each param EXACTLY once', () => {
    // The redundancy contract's band half: the cells beneath the strip are the
    // parity-credited controls, each exactly once. A second cell for `pos` (a
    // declared pad, a cluster duplicate) fails here before faces-parity fails
    // it in the browser lane.
    const bands = dockFacePlan(moog956Def as unknown as FaceDefLike)!;
    expect(bands.length, 'a page-less face renders the one __all band').toBe(1);
    expect(dockPlanControls(bands).map((c) => c.key).sort())
      .toEqual(['gate', 'offset', 'pos', 'scale']);
  });
});

describe('moog956 face — `gate` is a PRESS, and the curve is what makes that sayable', () => {
  it('the def declares the press-pad SHAPE, which `linear` could not', () => {
    // ⚠ THE REGRESSION THIS CATCHES IS A REVERT THAT LOOKS LIKE A TIDY.
    // `looksLikeSwitch` reaches only params that are ALREADY `0..1 discrete`,
    // so putting `curve: 'linear'` back would make this param invisible to
    // module-face-lint's switch-classification ratchet AND make
    // `face.momentary` refuse it — and the only visible symptom would be a
    // two-state control rendered as a rotary.
    const gate = moog956Def.params.find((p) => p.id === 'gate')!;
    expect(gate.curve).toBe('discrete');
    expect(looksLikeSwitch(gate), 'the shape the momentary lint demands').toBe(true);
    expect(momentaryParamIds(moog956Def).has('gate')).toBe(true);
  });

  it('the FACTORY still thresholds at 0.5 — the curve move is neutral by construction', async () => {
    // The claim the promotion makes about the contract re-pin, executed
    // instead of asserted in prose: every value on either side of the
    // threshold resolves to the same 0 or 1 it always did.
    const sources: { offset: { value: number; setValueAtTime(v: number): void } }[] = [];
    const ctx = {
      sampleRate: 48000,
      currentTime: 0,
      createConstantSource() {
        const s = {
          offset: { value: 0, setValueAtTime(v: number) { this.value = v; } },
          connect() {}, start() {}, stop() {}, disconnect() {},
        };
        sources.push(s);
        return s;
      },
    } as unknown as AudioContext;
    const handle = await moog956Def.factory(ctx, {
      id: 'n', type: 'moog956', domain: 'audio',
      position: { x: 0, y: 0 }, params: {}, data: {},
    } as never);
    const gateSrc = handle.outputs.get('gate')!.node as unknown as { offset: { value: number } };
    for (const [written, expected] of [[0, 0], [0.4, 0], [0.5, 0], [0.6, 1], [1, 1]] as const) {
      handle.setParam('gate', written);
      expect(gateSrc.offset.value, `gate ${written} still resolves ${expected}`).toBe(expected);
    }
  });
});

describe('moog956 face — the STRIP (source-pinned; no sweep reaches a tileBody)', () => {
  it('BOTH slots are filled, and both mount the SAME strip', () => {
    // ⚠ THE `tileBody` IS THE ONE A SOURCE GATE CANNOT SEE.
    // `face-rack-status-source`'s roster sweep greps for `fullViewBody:` and
    // therefore has no opinion about the lane at all, so deleting the tile slot
    // is a green edit everywhere else — and the lane silently loses `gate`.
    const ext = readFileSync(resolve(EXT_DIR, 'shell-extension.ts'), 'utf8');
    expect(ext).toMatch(/fullViewBody:\s*Moog956RibbonBody/);
    expect(ext).toMatch(/tileBody:\s*Moog956TileBody/);
    for (const slot of ['fullViewBody', 'tileBody'] as const) {
      expect(slotSource(slot), `${slot} mounts the shared strip`).toMatch(/<Moog956RibbonStrip/);
    }
  });

  it('the two mounts NAMESPACE their testids — they can be on screen together', () => {
    // A faced module's lane tile and its open dock pane are two ModuleShell
    // instances for the same node. A shared testid is not a style problem: it
    // throws every strict locator in every spec that reaches for the strip.
    expect(slotSource('fullViewBody')).toMatch(/testidPrefix="moog956-face"/);
    expect(slotSource('tileBody')).toMatch(/testidPrefix="moog956-tile"/);
  });

  it('the gesture goes through the ACTION SEAM — no surface implements it', () => {
    const src = stripSource();
    expect(src.length, 'a real component, not a stub').toBeGreaterThan(500);
    for (const fn of ['ribbonPress', 'ribbonSlide', 'ribbonRelease', 'ribbonPersistPos']) {
      expect(src, `the strip calls ${fn}`).toMatch(new RegExp(`\\b${fn}\\b`));
    }
    // The durable write is rAF-coalesced (the paid raw-write debt) and flushed
    // on release, because the held pitch is the value the module promises to
    // keep.
    expect(src).toMatch(/createDragCommit/);
    expect(src).toMatch(/commitPos\.flush\(\)/);
    // Capture, and BOTH recovery paths — a gesture that ends by losing the
    // capture must still drop the gate, or the note hangs.
    expect(src).toMatch(/setPointerCapture/);
    expect(src).toMatch(/onpointercancel/);
    expect(src).toMatch(/onlostpointercapture/);
    // …and the one no other surface has: unmount mid-hold. Pointer capture
    // protects a MOVING pointer, not a DELETED element, and this strip unmounts
    // whenever the dock pane closes or the tile is LRU-evicted.
    expect(
      /onDestroy\([\s\S]*?ribbonRelease\(/.test(src),
      'unmount must release the gate — otherwise the engine holds it with no surface left',
    ).toBe(true);
    // NO SNAP-BACK: nothing in the end-of-gesture path writes a position.
    expect(
      /function endGesture[\s\S]*?ribbonPersistPos\(/.test(src),
      'the release must not write a position — the wiper keeps its voltage',
    ).toBe(false);
  });

  it('⚠ is NOT a face cell: no parity anchor, no cell contract, no canvas, no painted values', () => {
    const src = stripSource();
    // A `control-*` anchor or `data-control-params` here would double-count
    // `pos` in faces-parity's exact multiset — a failure that only shows in the
    // browser lane, ~25 minutes late. (Attribute-ASSIGNMENT syntax
    // deliberately: the file's own header names these strings in prose, and a
    // probe that cannot tell code from a comment would forbid the comment that
    // explains the rule.)
    expect(src).not.toMatch(/data-control-params\s*=/);
    expect(src).not.toMatch(/data-testid="control-/);
    expect(src).not.toMatch(/data-cell-(kind|control|key)\s*=/);
    // No canvas: the `control-grid` body role's predicate, and the WebGL attest
    // argument (basis membership is derived from CONTENT — a drawn strip would
    // enrol an audio utility permanently).
    expect(src).not.toMatch(/<canvas/);
    // The value is SPEAKABLE, not painted (owner-decisions item 11: the card's
    // `{n} st` row is this promotion's named deletion). `role="slider"` has a
    // real `aria-valuetext`, unlike the joystick pad's `role="application"`.
    expect(src).toMatch(/role="slider"/);
    expect(src).toMatch(/aria-valuetext=/);
    expect(src).not.toMatch(/moog956-readout|-readout"/);
    // ⚠ AND NOT IN THE TAB ORDER. Bare Tab is the faceplate FLIP gesture
    // (#1629), and `role="slider"` obliges the compiler to see SOME tabindex —
    // so the value has to be -1, and `0` is the edit this leg refuses.
    expect(src).toMatch(/tabindex="-1"/);
    expect(src).not.toMatch(/tabindex="0"/);
  });

  it('the dock body and the tile body each carry the role\'s accessible name', () => {
    // `EXTENSION_BODY_ROLES` declares `control-grid`, whose predicate is "sets
    // aria-label on what it paints and mounts NO canvas". The predicate reaches
    // only the `fullViewBody` file; the tile's identical claim is checked here.
    for (const slot of ['fullViewBody', 'tileBody'] as const) {
      const src = slotSource(slot);
      expect(src, `${slot} names itself`).toMatch(/aria-label="956 ribbon controller/);
      expect(src, `${slot} mounts no canvas`).not.toMatch(/<canvas/);
    }
  });
});
