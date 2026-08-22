// packages/web/src/lib/ui/modules/quadralogical-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the QUADRALOGICAL faceplate (#2102).
//
// Everything asserted here is a claim the shipped face MAKES and that no pixel
// gate, no def-reading gate and no e2e sweep would NAME if it broke. Each block
// states what it would look like if it were wrong, because "the assertion went
// red" is only useful when the reader knows which of two opposite fixes applies.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUADRALOGICAL_FX_OPTIONS,
  TRANSITIONS,
  blend2,
  edgeWeights,
  quadWeights,
  quadralogicalDef,
  type RGB,
} from '$lib/video/modules/quadralogical';
import {
  QUAD_FIELD_H,
  QUAD_FIELD_W_OFF,
  QUAD_FIELD_W_ON,
  QUAD_INPUT_NAMES,
  quadDiamondClipPath,
  quadDominantInput,
  quadFieldWidth,
  quadPadAriaLabel,
} from './quadralogical-face-model';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { consoleGridCols } from '$lib/ui/workflow/console-grid';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { bodyPaintedParamIds } from '$lib/ui/workflow/shell-control-kind';

const def = quadralogicalDef as unknown as FaceDefLike & { type: string };

/** The LIVE `ParamDef`, not the `FaceParamLike` narrowing `FaceDefLike` applies
 *  — the face-side type deliberately projects only what curation reads, so
 *  `min`/`max`/`curve`/`options` are unreachable through `def.params`. Read
 *  them off the def itself. (svelte-check catches this where vitest does not.) */
function param(id: string) {
  const p = quadralogicalDef.params.find((x) => x.id === id);
  if (!p) throw new Error(`quadralogical has no param '${id}'`);
  return p;
}

describe('quadralogical face — the module is faced, and the picture is the tile', () => {
  it('is promoted', () => {
    expect(STRICT_FACES.has('quadralogical')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' AND still has a live picture — the counter-intuitive pair", () => {
    // ⚠ THE ASSERTION THAT MATTERS IS THE SECOND ONE. A video def MUST declare
    // `glyph: 'none'` (`primaryAudioOutPortId` matches `type === 'audio'` and
    // this def has none, so any other literal resolves to a dead static glyph
    // that module-face-lint refuses) — which means `'none' + blank tile` and
    // `'none' + live thumb` are INDISTINGUISHABLE from the declaration. The
    // picture arrives from a different seam entirely, so that seam is what gets
    // asserted. If this pair ever disagrees the lane tile is empty and nothing
    // else says so.
    expect(def.face?.glyph).toBe('none');
    expect(hasVideoSurface(def)).toBe(true);
  });
});

describe('quadralogical face — the pad the SHELL does not paint', () => {
  it("declares ONE pad, both joystick axes, surface 'body'", () => {
    expect(def.face?.xyPads).toEqual([
      { x: 'pos_x', y: 'pos_y', label: 'joystick', surface: 'body' },
    ]);
    expect([...bodyPaintedParamIds(def)].sort()).toEqual(['pos_x', 'pos_y']);
  });

  it('the DOCK renders ZERO cells for either axis — the body owns them', () => {
    const plan = dockFacePlan(def)!;
    const keys = plan.flatMap((b) => [
      ...b.controls.map((c) => c.key),
      ...b.clusters.flatMap((cl) => cl.controls.map((c) => c.key)),
    ]);
    expect(keys).not.toContain('pos_x');
    expect(keys).not.toContain('pos_y');
    // …and every OTHER param still renders exactly once, so this is a targeted
    // drop rather than a page that quietly lost its controls.
    const others = (def.params ?? [])
      .map((p) => p.id)
      .filter((id) => id !== 'pos_x' && id !== 'pos_y' && id !== 'freeze');
    for (const id of others) {
      expect(keys.filter((k) => k === id), `dock cells for '${id}'`).toHaveLength(1);
    }
  });

  it('⚠ NEGATIVE CONTROL: the drop is caused by `surface`, not by the ids', () => {
    // THE PERMANENT LEG. Every assertion above is an ABSENCE, and an absence
    // passes just as well if `dockFacePlan` stopped resolving pages at all, or
    // if the two axes were never ranked in the first place. Flip ONLY the
    // `surface` word on a copy of the live face and the SAME plan must gain a
    // pos_x cell — which is what proves the mechanism under test is the one
    // doing the work.
    const asBand: FaceDefLike = {
      ...def,
      face: {
        ...def.face!,
        xyPads: [{ x: 'pos_x', y: 'pos_y', label: 'joystick', surface: 'band' }],
      },
    };
    const keys = dockFacePlan(asBand)!.flatMap((b) => [
      ...b.controls.map((c) => c.key),
      ...b.clusters.flatMap((cl) => cl.controls.map((c) => c.key)),
    ]);
    expect(keys, "surface:'band' must put the pad back in a band").toContain('pos_x');
    // The PARTNER axis still folds into the x cell — a `'band'` pad is one cell
    // over two params, which is a different fold from this one and must survive.
    expect(keys).not.toContain('pos_y');
  });

  it('⚠ the LANE NEVER SHOWS A PAD — and `surface` is not what does that', () => {
    // ⚠ THIS TEST WAS WRITTEN ASSERTING THE OPPOSITE AND THE CODE CORRECTED IT,
    // which is why it is spelled out rather than quietly matched to the output.
    // The first draft claimed "every lane tier keeps the generic XyPad, which
    // is what stops this being the #1974 refusal". That premise is FALSE:
    // `laneOrder` (`curated-face.ts:131-143`) makes EVERY declared pad's anchor
    // dock-only already, for a MEASURED reason that predates this face — a pad
    // is square and a lane knob column is 46 px, so squeezing it there would
    // keep the gesture and lose the precision. `surface: 'body'` therefore
    // changes the DOCK ONLY, and it changes it from "the shell paints the pad
    // in a band" to "the module paints it in its own body". The lane is
    // untouched because the pad was never there.
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const keys = curatedFace(def, tier)!.controls.map((c) => c.key);
      expect(keys, `lane tier '${tier}'`).not.toContain('pos_x');
      expect(keys, `lane tier '${tier}'`).not.toContain('pos_y');
    }
  });

  it('⚠ and the lane is NOT EMPTY, which is the real #1974 distinction', () => {
    // `joystick` is refused (#1974) because a pad is its ONLY control: with the
    // anchor dock-only and the partner folded, every lane tier resolves to ZERO
    // controls — a title, a patch panel, and no stick, on a module whose whole
    // purpose is a gesture. That refusal is about the module's SHAPE, not about
    // pads, and this is the assertion that says quadralogical does not share
    // it: eighteen other ranked params mean the lane still has something to
    // show. If this ever goes to zero the face must be un-promoted, not tuned.
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(
        curatedFace(def, tier)!.controls.length,
        `lane tier '${tier}' must not resolve to zero controls (#1974)`,
      ).toBeGreaterThan(0);
    }
  });

  it('the tier ladder is MEASURED through curatedFace, not inferred', () => {
    // Read back as a sentence: at mini you get the DIAMOND — the size of the
    // all-four zone, which is the one thing besides the stick that decides what
    // is on screen; at compact, the diamond and its partner SHARP.
    //
    // ⚠ `full` (the "plate" tier) is NOT six. An `xy` cell is 'wide' and this
    // is a video face, so `laneBodyPlan` fits fewer cells than
    // `LANE_PLATE_MAX_CELLS` suggests. Asserting the MEASURED number is what
    // stopped ruttetra, monoglitch and reshaper each repeating the same wrong
    // inference in their own face comments — and it is what corrected this
    // face's first draft too.
    const keysAt = (t: 'mini' | 'compact' | 'full') =>
      curatedFace(def, t)!.controls.map((c) => c.key);
    expect(keysAt('mini')).toEqual(['diamond_margin']);
    expect(keysAt('compact')).toEqual(['diamond_margin', 'blend_sharp']);
    // The plate tier is whatever the geometry fits; pin the relationship so a
    // change is a decision rather than a drift.
    expect(keysAt('full').length).toBeGreaterThanOrEqual(keysAt('compact').length);
    expect(keysAt('full')[0]).toBe('diamond_margin');
  });
});

describe('quadralogical face — three bands, the edge ROW, and no rail', () => {
  it('renders exactly the three authored bands', () => {
    expect(dockFacePlan(def)!.map((b) => b.id)).toEqual(['field', 'edges', 'key']);
  });

  it("the `edges` band is FOUR clusters flowing as a ROW", () => {
    const edges = dockFacePlan(def)!.find((b) => b.id === 'edges')!;
    expect(edges.clusters.map((c) => c.label)).toEqual(['1–2', '2–3', '3–4', '4–1']);
    // ⚠ THE FLOW IS THE OWNER'S LAYOUT, IN ONE WORD. Without it the clusters
    // STACK and the four edge boxes become four full-width rows under the
    // screen instead of a row of four beside each other.
    expect(edges.clusterFlow).toBe('row');
    // Every cluster is the same three cells — selector + its two controls.
    for (const cl of edges.clusters) expect(cl.controls).toHaveLength(3);
    // Nothing un-clustered is left over: the band is exactly its four boxes.
    expect(edges.controls).toHaveLength(0);
  });

  it("⚠ the CONSOLE GRID is OFF for the edges band, and `clusterFlow` is why", () => {
    // Four equal-sized clusters is the console grid's own trigger condition, so
    // WITHOUT the row flow this band would ask for a shared column ruler while
    // being laid out as a flex row — two layout systems disagreeing about one
    // element, which resolves as neither. `consoleGridCols` refuses a row-flow
    // band in its FIRST clause for exactly this reason; asserted here because
    // this face is the first one that could trip it.
    const edges = dockFacePlan(def)!.find((b) => b.id === 'edges')!;
    expect(consoleGridCols(edges)).toBeNull();
    // NEGATIVE CONTROL: the same band, stacked, IS a console grid — so the null
    // above is the flow's doing and not an accident of the cluster shapes.
    expect(consoleGridCols({ ...edges, clusterFlow: 'stack' })).toBe(3);
  });

  it('NO tab rail, and that is required rather than incidental', () => {
    // A rail shows ONE band at a time, so a tabbed face would put at most one
    // of the four EDGE boxes on screen — directly contradicting the layout.
    // Three bands is below DOCK_TAB_MIN_BANDS, and `tabbed` is not declared.
    expect(dockFacePlan(def)!.length).toBeLessThan(7);
    expect(def.face?.tabbed).toBeUndefined();
  });

  it('the `key` band holds the GLOBAL key controls, invert first', () => {
    const key = dockFacePlan(def)!.find((b) => b.id === 'key')!;
    expect(key.controls.map((c) => c.key)).toEqual(['invert', 'keyR', 'keyG', 'keyB']);
  });
});

describe('quadralogical — the eight effect NAMES reach the contract', () => {
  it('the roster is TOTAL over the param span and matches TRANSITIONS exactly', () => {
    const fx = param('edge1_fx');
    expect(fx.options).toBe(QUADRALOGICAL_FX_OPTIONS);
    // Derived, so it cannot disagree with the effect table even in principle —
    // asserted anyway, because "derived" is a property of today's source.
    expect(QUADRALOGICAL_FX_OPTIONS.map((o) => o.label)).toEqual([...TRANSITIONS]);
    // TOTAL: one entry per reachable value of the param, no gaps, no strays.
    expect(QUADRALOGICAL_FX_OPTIONS.map((o) => o.value)).toEqual(
      Array.from({ length: fx.max - fx.min + 1 }, (_, i) => fx.min + i),
    );
  });

  it('all four edges share the SAME roster object — one place, not four copies', () => {
    for (const n of [1, 2, 3, 4]) {
      const p = param(`edge${n}_fx`);
      expect(p.options, `edge${n}_fx`).toBe(QUADRALOGICAL_FX_OPTIONS);
    }
  });

  it("each title says what THAT effect's two controls do — DISSOLVE says they do nothing", () => {
    // The one fact the legacy card carried in a conditional render (it HID the
    // faders for an effect that reads neither) and that a static faceplate
    // caption cannot. It survives as prose on the option the player selects.
    const dissolve = QUADRALOGICAL_FX_OPTIONS[0]!;
    expect(dissolve.label).toBe('DISSOLVE');
    expect(dissolve.title).toMatch(/do nothing/);
    const luma = QUADRALOGICAL_FX_OPTIONS[5]!;
    expect(luma.label).toBe('LUMA');
    expect(luma.title).toMatch(/Thr \+ Soft/);
  });
});

describe('quadralogical — `invert` is a SWITCH, and the curve change is pixel-neutral', () => {
  const A: RGB = [0.8, 0.8, 0.8];
  const B: RGB = [0.1, 0.2, 0.3];
  const P = (invert: number) => ({
    amount: 0.5,
    param: 0.2,
    key: [0, 1, 0] as RGB,
    invert,
    uv: [0.5, 0.5] as [number, number],
  });
  const LUMA = 5;

  it('is declared discrete — a two-state read must not paint a rotary', () => {
    const p = param('invert');
    expect(p.curve).toBe('discrete');
    expect([p.min, p.max]).toEqual([0, 1]);
  });

  it('⚠ THE CURVE CHANGE IS PIXEL-NEUTRAL — every old value keeps its old side', () => {
    // The claim that makes `linear` → `discrete` safe rather than merely
    // tidier: the shader thresholds at `>= 0.5`, so every value any surface
    // could previously write already resolved to one of two outputs. If this
    // went red the change would be a LOOK change and would need a baseline.
    const off = blend2(LUMA, A, B, 0.5, P(0));
    const on = blend2(LUMA, A, B, 0.5, P(1));
    expect(blend2(LUMA, A, B, 0.5, P(0.49)), 'below the threshold == 0').toEqual(off);
    expect(blend2(LUMA, A, B, 0.5, P(0.5)), 'at the threshold == 1').toEqual(on);
    expect(blend2(LUMA, A, B, 0.5, P(0.99)), 'above the threshold == 1').toEqual(on);
  });

  it('⚠ NEGATIVE CONTROL: the two states are genuinely DIFFERENT pictures', () => {
    // Without this, the block above passes just as well on a param the shader
    // ignores entirely — "every value is the same" and "every value is the same
    // because nothing reads it" are indistinguishable from the assertions
    // alone. This is the leg that says the control does something.
    const off = blend2(LUMA, A, B, 0.5, P(0));
    const on = blend2(LUMA, A, B, 0.5, P(1));
    expect(on).not.toEqual(off);
  });
});

describe('quadralogical — the joystick FIELD geometry', () => {
  it('the toggle re-aspects on the WIDTH; the HEIGHT never moves', () => {
    // The property that stops the four EDGE boxes below the screen jumping
    // under the pointer on every toggle. Both widths share one height.
    expect(quadFieldWidth(true)).toBe(QUAD_FIELD_W_OFF);
    expect(quadFieldWidth(false)).toBe(QUAD_FIELD_W_ON);
    expect(QUAD_FIELD_W_OFF / QUAD_FIELD_H, 'SCREEN OFF is the card\'s square pad').toBe(1);
    expect(QUAD_FIELD_W_ON / QUAD_FIELD_H, 'SCREEN ON is 4:3').toBeCloseTo(4 / 3, 10);
  });

  it('SCREEN ON is 4:3 because a 2×2 of 4:3 tiles IS 4:3 — the arithmetic, not the number', () => {
    // VIDEO_RES is 1024×768. Two tiles wide by two tall is (2·4):(2·3) = 8:6.
    const tile = 1024 / 768;
    expect((2 * tile) / 2, 'a 2x2 grid of 4:3 tiles').toBeCloseTo(tile, 10);
    expect(QUAD_FIELD_W_ON / QUAD_FIELD_H).toBeCloseTo(tile, 10);
  });

  it('⚠ the diamond is a RHOMBUS: at 4:3 a rotated square would be wrong by 4/3', () => {
    // The clip-path is in PERCENTAGES, so the drawn semi-axes are
    // margin·W/2 and margin·H/2 — different lengths at 4:3, equal at 1:1.
    // A CSS square rotated 45° has EQUAL semi-axes at any aspect, which is why
    // the legacy card's version is correct on its square pad and would be a
    // silent maths error here: the outline still looks like a diamond.
    const m = 0.5;
    expect(quadDiamondClipPath(m)).toBe('polygon(50% 25%, 75% 50%, 50% 75%, 25% 50%)');
    // What the percentages MEAN in px, in each state.
    const semiXon = (m / 2) * QUAD_FIELD_W_ON;
    const semiYon = (m / 2) * QUAD_FIELD_H;
    expect(semiXon / semiYon, 'ON: the rhombus is wider than it is tall, by 4/3').toBeCloseTo(4 / 3, 10);
    const semiXoff = (m / 2) * QUAD_FIELD_W_OFF;
    expect(semiXoff / semiYon, 'OFF: it degenerates to the card\'s square-pad case').toBe(1);
  });

  it('the drawn diamond is 1:1 with the WEIGHT MODEL it claims to draw', () => {
    // The vertices sit where |x| + |y| == margin, which is exactly the boundary
    // `quadWeights` smoothsteps from. Walk the +x vertex and confirm the weight
    // model is still inside its all-four zone there but not beyond it.
    const m = 0.5;
    const inside = quadWeights(m * 0.5, 0, m, 3);
    const beyond = quadWeights(0.95, 0, m, 3);
    // Inside the diamond all four inputs still contribute meaningfully.
    expect(Math.min(...inside)).toBeGreaterThan(0.05);
    // Well outside it the field has collapsed toward a 2-input region.
    expect(Math.min(...beyond)).toBeLessThan(0.01);
  });

  it('clamps a margin outside the param range instead of drawing nonsense', () => {
    expect(quadDiamondClipPath(-1)).toBe(quadDiamondClipPath(0));
    expect(quadDiamondClipPath(9)).toBe(quadDiamondClipPath(1));
    expect(quadDiamondClipPath(Number.NaN)).toBe(quadDiamondClipPath(0));
  });
});

describe('quadralogical — the accessible name is where the deleted decimals went', () => {
  it('carries BOTH axes and the DOMINANT input', () => {
    expect(quadPadAriaLabel(0, 0, 0)).toBe('joystick: X 0.00, Y 0.00 — IN1');
    expect(quadPadAriaLabel(0.62, -0.18, 3)).toBe('joystick: X 0.62, Y -0.18 — IN4');
  });

  it('the RESTING puck is IN1 — the "red puck" of the design brief', () => {
    // At the spawn position all four weights are exactly 0.25, and the shipped
    // tie-break (`indexOf(max)`) takes the LOWEST index. That is what makes the
    // resting puck red, so it is behaviour rather than an accident, and a
    // tie-break that picked differently would change the module's appearance at
    // rest on every fresh spawn.
    const w = quadWeights(0, 0, 0.5, 3);
    expect(new Set(w).size, 'all four weights are equal at the origin').toBe(1);
    expect(quadDominantInput(w)).toBe(0);
    expect(QUAD_INPUT_NAMES[quadDominantInput(w)]).toBe('IN1');
  });

  it('⚠ NEGATIVE CONTROL: the dominant input actually FOLLOWS the stick', () => {
    // Without this the tie-break assertion above passes on a function that
    // returns 0 unconditionally — "always IN1" and "IN1 at the origin" are
    // indistinguishable from that one case. One corner per input, and the
    // corner→input map is the def's own.
    expect(quadDominantInput(quadWeights(-1, 1, 0.5, 3)), 'TL').toBe(0);
    expect(quadDominantInput(quadWeights(1, 1, 0.5, 3)), 'TR').toBe(1);
    expect(quadDominantInput(quadWeights(-1, -1, 0.5, 3)), 'BL').toBe(2);
    expect(quadDominantInput(quadWeights(1, -1, 0.5, 3)), 'BR').toBe(3);
  });

  it('the EDGE labels are the INDEX CYCLE, not geometric adjacency', () => {
    // ⚠ Edge 2 is in2<->in3 = TR<->BL, a DIAGONAL of the pad. The cluster
    // labels say `2–3`, and a future author "tidying" them into adjacent pairs
    // would be relabelling the wrong thing: the cycle is what the shader runs.
    // Proven from the model rather than from the comment: at the TR corner the
    // two edges that TOUCH in2 (edges 1 and 2) carry all the mass.
    const [e12, e23, e34, e41] = edgeWeights(1, 1, 0.5, 3);
    expect(e12.mass + e23.mass).toBeGreaterThan(1.9);
    expect(e34.mass).toBeLessThan(0.05);
    expect(e41.mass).toBeLessThan(0.05);
  });
});

describe('quadralogical — SCREEN OFF is not a producer kill switch', () => {
  // ⚠ SOURCE-LEVEL, AND DELIBERATELY SO — the `milkdrop-face-model` precedent.
  // The runtime observable would be "is this node still a pull root", and
  // `isPullRoot` is PRIVATE with no public probe beside it, so an e2e leg
  // asking the engine can only report "could not look" — which is decoration,
  // not a gate. What CAN be asserted mechanically is that the collapsed branch
  // takes the watch mark before it returns.
  //
  // THE DEFECT IT GUARDS (#1937 / #2015): `blitOutputForPreview` IS the "someone
  // is watching" signal — it calls `markWatched` itself — and a node is a pull
  // root only while that mark is fresher than `WATCH_TTL_MS`. So a collapsed
  // state that merely stops blitting silently drops the node out of the pull
  // set, and a control captioned SCREEN starts muting everything downstream.
  // On a MIXER that is the whole patch, and this module has TWO outputs, so a
  // player can be watching `preview` on a downstream monitor while this screen
  // is off.
  it("the collapsed branch marks the node watched BEFORE it returns", () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'quadralogical/QuadralogicalScreenBody.svelte'),
      'utf8',
    );
    expect(src).toContain('markWatched');
    expect(
      /if\s*\(previewCollapsed\)\s*\{[\s\S]{0,320}markWatched/.test(src),
      'the SCREEN-OFF branch must call markWatched before returning — otherwise the switch is a '
        + 'producer kill switch for everything downstream of `out` (#1937 / #2015)',
    ).toBe(true);
  });

  it('⚠ NEGATIVE CONTROL: the probe reads the real file, and the pattern discriminates', () => {
    // Both assertions above are satisfiable by a file that merely CONTAINS the
    // word, so pin that the probe is reading this component (not an empty
    // string, not a sibling) and that the ORDER clause can fail: the same
    // pattern must NOT match a body whose collapsed branch returns first.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'quadralogical/QuadralogicalScreenBody.svelte'),
      'utf8',
    );
    expect(src.length, 'the probe read an empty/missing component').toBeGreaterThan(2000);
    expect(src).toContain('quadralogical-face-screen-toggle');
    const sabotaged = src.replace(
      /if\s*\(previewCollapsed\)\s*\{[\s\S]{0,320}?markWatched[^\n]*\n/,
      'if (previewCollapsed) {\n',
    );
    expect(
      /if\s*\(previewCollapsed\)\s*\{[\s\S]{0,320}markWatched/.test(sabotaged),
      'the pattern must FAIL on a collapsed branch with no mark — otherwise it proves nothing',
    ).toBe(false);
  });
});

describe('quadralogical — `freeze` is declared unreachable, and stays that way', () => {
  it('is the only noUserControl param, written internally', () => {
    const decl = (quadralogicalDef as { noUserControl?: readonly { param: string; writer: string }[] })
      .noUserControl ?? [];
    expect(decl.map((d) => d.param)).toEqual(['freeze']);
    expect(decl[0]!.writer).toBe('internal');
  });

  it('⚠ NEGATIVE CONTROL: no input port targets it — the claim, not the comment', () => {
    // `writer: 'internal'` asserts nothing on the patch surface reaches it. The
    // day someone adds a `freeze` CV input this must go red rather than the
    // declaration quietly becoming false.
    const targets = (quadralogicalDef.inputs ?? []).map(
      (p) => (p as { paramTarget?: string }).paramTarget,
    );
    expect(targets).not.toContain('freeze');
    // …and the sweep is reading real ports, so the absence means something.
    expect(targets.filter(Boolean).length).toBeGreaterThan(10);
  });
});
