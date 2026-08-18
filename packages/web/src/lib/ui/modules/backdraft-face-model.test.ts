// packages/web/src/lib/ui/modules/backdraft-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for BACKDRAFT's three derived readouts, plus
// the two structural assertions the FIRST VIDEO FACE owes that no generic gate
// can make.
//
// The bar (face-readout-values.ts): a derived readout must be controlled on the
// input a nearby KNOB READBACK would be BLIND to — permanently, not once at
// authoring time. The kick-drum TAIL trap is what that rule is for: it tracks
// SUB DEC, looks right, and is invariant to SUB LEVEL, which genuinely shortens
// the tail.

import { describe, expect, it } from 'vitest';

import {
  BACKDRAFT_BUFFER_FRAMES,
  BACKDRAFT_FPS,
  backdraftDef,
  backdraftTvBezel,
  backdraftTvDepth,
  backdraftTvFill,
  backdraftTvGain,
} from '$lib/video/modules/backdraft';
import { hasVideoSurface, laneBodyPlan, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { curatedFace } from '$lib/ui/workflow/curated-face';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';
import {
  BACKDRAFT_READOUT_WIDTH_PX,
  backdraftBandsText,
  backdraftFillPct,
  backdraftResolvedBands,
  backdraftTapFrames,
  backdraftTapText,
} from './backdraft-face-model';

/** The def's own shipped defaults, read off the def rather than re-typed — so
 *  a default change reddens these legs instead of leaving them quietly wrong. */
function defaults(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of backdraftDef.params ?? []) out[p.id] = p.defaultValue;
  return out;
}

/** A param reader over an override map on top of the def defaults. */
function reader(over: Record<string, number> = {}) {
  const base = { ...defaults(), ...over };
  return (id: string): number | undefined => base[id];
}

describe('BACKDRAFT face readouts — TOTALITY (they run on every render)', () => {
  // A throw here takes the whole faceplate down mid-drag, so totality is not a
  // nicety: `face-readout-values.ts` calls these on every frame of a drag.
  const HOSTILE: readonly (number | undefined)[] = [
    undefined, NaN, Infinity, -Infinity, 0, -0, 1e308, -1e308,
  ];

  it('every readout is TOTAL on a fresh node and on hostile values', () => {
    for (const v of HOSTILE) {
      const read = (): number | undefined => v;
      for (const id of ['backdraft-tv-fill', 'backdraft-tv-bands', 'backdraft-delay-frames']) {
        const fn = faceReadoutValueFor(id);
        expect(fn, `${id} must be registered`).toBeTruthy();
        const text = fn!(read);
        expect(typeof text, `${id} @ ${String(v)}`).toBe('string');
        expect(text.length, `${id} @ ${String(v)} printed an empty string`).toBeGreaterThan(0);
        expect(text, `${id} @ ${String(v)} leaked a non-finite number`).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it('all three ids are REGISTERED, and the FACE no longer declares any of them', () => {
    // ⚠ THE FACE DROPPED THESE IN OWNER REVIEW ROUND 1 — *"the bands, fill and
    // timing is not useful and should go away"* — so `hero` is gone entirely.
    // The functions are deliberately KEPT, registered and tested, because they
    // are the MEASUREMENT behind #1786: BackdraftCard prints a band count
    // computed at a hardcoded bezel of 0.4 while the param ships at 0.5, and is
    // blind to BEZEL across its whole range. Deleting them would delete the
    // evidence for an open bug on a surface this PR does not touch.
    //
    // Both directions are asserted so this cannot rot into either shape: the
    // ids must still RESOLVE (a dead registration is not evidence of anything),
    // and the face must still declare NONE of them (if a later round puts a
    // readout back, this line goes red and whoever does it reads this note).
    for (const id of ['backdraft-tv-fill', 'backdraft-tv-bands', 'backdraft-delay-frames']) {
      expect(faceReadoutValueFor(id), `valueId '${id}' resolves nothing`).toBeTruthy();
    }
    expect(
      backdraftDef.face?.hero,
      'the owner removed the hero row; a hero reappearing needs a fresh decision, not a silent one',
    ).toBeUndefined();
  });
});

describe('backdraft-tv-bands — the join a ZOOM readback cannot perform', () => {
  // The nearest dial to "how many nesting levels resolve" is ZOOM. These two
  // legs are the whole reason this is a derived readout and not a relabelled
  // knob: ZOOM is HELD FIXED in both, so a zoom readback would be a constant.

  it('NEGATIVE CONTROL 1 — FEEDBACK moves the band count with ZOOM held', () => {
    const zoomHeld = 1;
    const lo = backdraftResolvedBands(reader({ zoom: zoomHeld, feedback: 0.2 }));
    const hi = backdraftResolvedBands(reader({ zoom: zoomHeld, feedback: 1.6 }));
    expect(
      hi,
      `bands (levels) must RISE with FEEDBACK at fixed ZOOM=${zoomHeld}: ` +
        `FB 0.2 -> ${lo} levels, FB 1.6 -> ${hi} levels`,
    ).toBeGreaterThan(lo);
    // …and the instrument is not merely noisy: ZOOM really is fixed.
    expect(backdraftFillPct(reader({ zoom: zoomHeld, feedback: 0.2 })))
      .toBe(backdraftFillPct(reader({ zoom: zoomHeld, feedback: 1.6 })));
  });

  it('NEGATIVE CONTROL 2 — BEZEL moves the band count with ZOOM held (the card is BLIND to this)', () => {
    // ⚠ THE DIRECTION HERE IS THE OPPOSITE OF THE OBVIOUS GUESS, and the first
    // draft of this leg asserted the guess and FAILED. A THICKER bezel resolves
    // for MORE levels, not fewer: the ceiling is the depth at which the bezel
    // BAND ITSELF goes sub-pixel (`log(aspect/(tb·w))/log(s) − 1`), and a
    // wider band survives more halvings before it does. Recorded because a
    // plausible-but-backwards expectation is exactly what a negative control is
    // for, and this one earned its place on the first run.
    const zoomHeld = 1;
    const thin = backdraftResolvedBands(reader({ zoom: zoomHeld, bezel: 0 }));
    const thick = backdraftResolvedBands(reader({ zoom: zoomHeld, bezel: 1 }));
    expect(
      thick,
      `a THICKER bezel band survives more halvings before going sub-pixel: ` +
        `bezel 0 -> ${thin} levels, bezel 1 -> ${thick} levels (widthPx=${BACKDRAFT_READOUT_WIDTH_PX})`,
    ).toBeGreaterThan(thin);
    // BEZEL 0 collapsing to ZERO resolvable levels is INTENTIONAL, not a bug:
    // BACKDRAFT_TV_BEZEL_MIN is 0, and its own comment says at 0 "the nest
    // stops reading as frames-within-frames and becomes a smooth zoom". Pinned
    // so that a future re-floor has to come past this assertion.
    expect(thin, 'BEZEL 0 is a genuine no-nest look, and the readout says so').toBe(0);
  });

  it('POSITIVE CONTROL — ZOOM alone still moves it (the readout is not inert)', () => {
    const tight = backdraftResolvedBands(reader({ zoom: 0.4 }));
    const wide = backdraftResolvedBands(reader({ zoom: 1.6 }));
    expect(tight, `ZOOM 0.4 -> ${tight} levels vs ZOOM 1.6 -> ${wide} levels`).not.toBe(wide);
  });

  it('THE CARD PRINTS A DIFFERENT NUMBER, and this is the measurement of that defect', () => {
    // BackdraftCard computes `backdraftTvDepth({ fill, gain, widthPx: 1024 })`
    // with NO `bezelTb`, so it silently falls back to the argument default
    // `backdraftTvBezel(0.4)` while the `bezel` PARAM ships at 0.5. Two things
    // are wrong with that and this leg pins BOTH so a fix to either reddens.
    const d = defaults();
    expect(d.bezel, 'the shipped bezel default this leg is about').toBe(0.5);

    const fill = backdraftTvFill(d.zoom);
    const gain = backdraftTvGain(0, d.feedback, 1);
    const cardBands = backdraftTvDepth({
      fill, gain, widthPx: BACKDRAFT_READOUT_WIDTH_PX,
    }).resolved;                                   // the card's call, verbatim
    const faceBands = backdraftResolvedBands(reader());

    expect(
      cardBands,
      `at the SHIPPED DEFAULTS the card reads ${cardBands} levels and the model ` +
        `resolves ${faceBands} — the card evaluates at a hardcoded bezel of 0.4 ` +
        `(tb=${backdraftTvBezel(0.4)}) while the param ships at ${d.bezel} ` +
        `(tb=${backdraftTvBezel(d.bezel)})`,
    ).not.toBe(faceBands);

    // …and the card's number is STRUCTURALLY invariant to a fader sitting on
    // the same card, which is the more serious half.
    const cardAtBezel0 = backdraftTvDepth({ fill, gain, widthPx: BACKDRAFT_READOUT_WIDTH_PX }).resolved;
    const cardAtBezel1 = backdraftTvDepth({ fill, gain, widthPx: BACKDRAFT_READOUT_WIDTH_PX }).resolved;
    expect(
      cardAtBezel0,
      'the card formulation cannot respond to BEZEL at all — it never passes it',
    ).toBe(cardAtBezel1);
    // The face formulation does respond, on the same two inputs.
    expect(backdraftResolvedBands(reader({ bezel: 0 })))
      .not.toBe(backdraftResolvedBands(reader({ bezel: 1 })));
  });
});

describe('backdraft-tv-fill — the BEZEL-INVARIANT half of the pair', () => {
  // Published beside `bands` on purpose: each is the other's negative control.
  // If a future edit made `fill` bezel-sensitive, or `bands` bezel-blind, the
  // pair would stop carrying independent information and THIS leg is what says
  // so — the clap-q / clap-bandwidth-hz idiom.

  it('is invariant to BEZEL and to FEEDBACK, while `bands` is not', () => {
    const a = backdraftFillPct(reader({ bezel: 0, feedback: 0.2 }));
    const b = backdraftFillPct(reader({ bezel: 1, feedback: 1.6 }));
    expect(b, `fill % must depend on ZOOM alone: ${a}% vs ${b}%`).toBe(a);
    expect(
      backdraftResolvedBands(reader({ bezel: 0, feedback: 0.2 })),
      'if this ever equals its sibling the pair has stopped being a control',
    ).not.toBe(backdraftResolvedBands(reader({ bezel: 1, feedback: 1.6 })));
  });

  it('tracks ZOOM monotonically across the declared range', () => {
    const p = backdraftDef.params?.find((x) => x.id === 'zoom');
    expect(p, 'zoom must be a declared param').toBeTruthy();
    const lo = backdraftFillPct(reader({ zoom: p!.min }));
    const hi = backdraftFillPct(reader({ zoom: p!.max }));
    expect(hi, `fill at zoom ${p!.min} = ${lo}% must be below fill at ${p!.max} = ${hi}%`)
      .toBeGreaterThan(lo);
  });
});

describe('backdraft-delay-frames — the quantisation the ms fader cannot show', () => {
  it('is INVARIANT across the whole bottom of the fader (the strong control)', () => {
    // DELAY is a MILLISECOND fader, but the ring taps WHOLE 60fps frames and
    // floors at 1. So every value from 0 to half a frame is the same tap, and
    // the dial is advertising a resolution it does not have.
    const halfFrameMs = 1000 / BACKDRAFT_FPS / 2;
    const seen = new Set<number>();
    for (const ms of [0, 1, 2, 4, 6, 8, halfFrameMs - 0.01]) {
      seen.add(backdraftTapFrames(reader({ delay: ms })));
    }
    expect(
      [...seen],
      `every DELAY from 0 to ${halfFrameMs.toFixed(2)} ms must tap the SAME single frame`,
    ).toEqual([1]);
  });

  it('POSITIVE CONTROL — it does move, at the frame boundaries', () => {
    const frameMs = 1000 / BACKDRAFT_FPS;
    expect(backdraftTapFrames(reader({ delay: frameMs * 3 })), 'three frames').toBe(3);
    expect(backdraftTapFrames(reader({ delay: frameMs * 10 })), 'ten frames').toBe(10);
  });

  it('CLAMPS at the ring, and says so in frames rather than pretending', () => {
    const p = backdraftDef.params?.find((x) => x.id === 'delay');
    const atMax = backdraftTapFrames(reader({ delay: p!.max }));
    expect(
      atMax,
      `the fader tops out at ${p!.max} ms = ${(p!.max / 1000) * BACKDRAFT_FPS} frames, but the ` +
        `ring is ${BACKDRAFT_BUFFER_FRAMES} slots so the tap clamps to ${BACKDRAFT_BUFFER_FRAMES - 1}`,
    ).toBe(BACKDRAFT_BUFFER_FRAMES - 1);
    expect(backdraftTapText(reader({ delay: p!.max }))).toContain(`${BACKDRAFT_BUFFER_FRAMES - 1}f`);
  });

  it('the printed form carries UNITS on both numbers', () => {
    const t = backdraftTapText(reader());
    expect(t, `the tap readout must name frames AND ms: got '${t}'`).toMatch(/^\d+f · [\d.]+ ms$/);
  });
});

describe('BACKDRAFT — the structural claims the FIRST VIDEO FACE owes', () => {
  it('the def declares glyph:\'none\' — mandatory, and NOT because there is no picture', () => {
    // `primaryAudioOutPortId` matches `type === 'audio'`; this def has none, so
    // ANY other glyph literal collapses to the dead `{kind:'static'}` binding.
    expect(backdraftDef.face?.glyph).toBe('none');
  });

  it('…and the LIVE PICTURE arrives through hasVideoSurface, which is the leg the declaration cannot make', () => {
    // ⚠ THE WHOLE POINT. `'none' + blank tile` and `'none' + live thumb` are
    // INDISTINGUISHABLE from `face.glyph` alone, so asserting the declaration
    // proves nothing about whether anything paints. This asserts the other seam.
    expect(hasVideoSurface(backdraftDef), 'the video-domain tile surface').toBe(true);
    expect(backdraftDef.domain).toBe('video');
  });

  it('the PROMOTED lane tile paints the picture at EVERY lane tier (#1785), and this is what it cost', () => {
    // The regression #1784 shipped and #1785 measured: promotion moved the tile
    // from `ModuleShellPlaceholder` (which always painted `VideoTileThumb`) to
    // `ModuleShell`, and at the `full` tier the plate's "ranked controls outrank
    // the glyph" rule dropped the picture. The owner ruling is that for a video
    // module the picture IS the identity, so it now outranks them.
    //
    // ⚠ ASSERTED OFF THE LIVE DEF, not a fixture, and through the SAME two calls
    // ModuleShell makes — `laneGlyphFor(def)` and `laneBodyPlan(face.cellHeights,
    // …)`. A fixture would prove the platform rule and say nothing about whether
    // THIS face reaches it, which is the half that broke.
    expect(laneGlyphFor(backdraftDef), 'a video def is a PICTURE, not a trace').toBe('picture');
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const face = curatedFace(backdraftDef, tier)!;
      const plan = laneBodyPlan(face.cellHeights, laneGlyphFor(backdraftDef), tier);
      expect(plan.glyph, `${tier}: the live thumbnail renders`).toBe(true);
      // SELECTED === RENDERED. Before the reconciliation these were 3 and 2 at
      // `compact`: the selector asked the glyph-LESS question and the tile
      // silently dropped the third control it chose.
      expect(plan.cellCount, `${tier}: selected === rendered`).toBe(face.controls.length);
    }
  });

  it('…and the cells the lane gave up for it are NAMED, and still reachable', () => {
    // The trade, stated: the `full` tile drops its third ranked cell. It is not
    // lost — the dock faceplate renders every ranked control, and `laneOrder`
    // is the same ranking either way, so the cell that moved is the one the
    // face itself ranked last of the three.
    const laneKeys = (tier: 'compact' | 'full') =>
      curatedFace(backdraftDef, tier)!.controls.map((c) => c.key);
    const full = laneKeys('full');
    const dropped = (backdraftDef.face?.order ?? [])
      .filter((k) => !full.includes(k))
      .slice(0, 1);
    expect(dropped, 'exactly one ranked control moved out of the full-tier lane tile').toEqual([
      'mix',
    ]);
    expect(
      curatedFace(backdraftDef, 'dock')!.controls.map((c) => c.key),
      'and the dock still renders it',
    ).toContain('mix');
    // The two lane tiers now agree, which is the shape a picture face has: the
    // picture is the constant and the controls are what the tier ladder varies.
    expect(laneKeys('compact')).toEqual(full);
  });

  it('declares the fullViewBody extension — the module output stays reachable', () => {
    // The `⛶ OUTPUT` affordance is node.data-backed, so no ParamCellKind can
    // express it, and it is the SOLE entry to Full Frame / Full Screen /
    // Present. Without an extension, promotion deletes it.
    expect(backdraftDef.face?.extension).toBe('backdraft');
  });

  it('every noUserControl param is ABSENT from face.order, and every other param is present', () => {
    // Deny-by-default in both directions, DERIVED from the def — no counts.
    const noUser = new Set((backdraftDef.noUserControl ?? []).map((n) => n.param));
    const ranked = new Set(backdraftDef.face?.order ?? []);
    const allParams = (backdraftDef.params ?? []).map((p) => p.id);

    expect(noUser.size, 'the adopter set must not be empty (vacuity)').toBeGreaterThan(0);
    expect(
      [...noUser].filter((id) => ranked.has(id)).sort(),
      'a noUserControl param that is ALSO ranked — the declaration would be a lie',
    ).toEqual([]);
    expect(
      allParams.filter((id) => !noUser.has(id) && !ranked.has(id)).sort(),
      'a user param nobody ranked — it would never reach the faceplate',
    ).toEqual([]);
  });

  it('both xy pads name CONTINUOUS, distinct, ranked axes (the first adopter of face.xyPads)', () => {
    const pads = backdraftDef.face?.xyPads ?? [];
    expect(pads.length, 'backdraft is the repo\'s first xyPads adopter').toBeGreaterThan(0);
    const ranked = new Set(backdraftDef.face?.order ?? []);
    const byId = new Map((backdraftDef.params ?? []).map((p) => [p.id, p]));
    for (const pad of pads) {
      expect(pad.x, 'a pad with one axis is not a degraded pad, it is a broken one').not.toBe(pad.y);
      for (const axis of [pad.x, pad.y]) {
        const p = byId.get(axis);
        expect(p, `pad axis '${axis}' must be a declared param`).toBeTruthy();
        expect(p!.curve, `pad axis '${axis}' must be continuous`).not.toBe('discrete');
        expect(ranked.has(axis), `pad axis '${axis}' must be ranked in face.order`).toBe(true);
      }
    }
  });

  it('the three switch params the face repaints are DISCRETE 0..1 — the correction that made them visible', () => {
    // These declared `curve: 'linear'` until this face. `looksLikeToggle` is
    // `curve === 'discrete' && min === 0 && max === 1`, so while they said
    // linear every switch consumer in the repo read them as continuous.
    for (const id of ['mirrorX', 'mirrorY', 'pureGeo']) {
      const p = backdraftDef.params?.find((x) => x.id === id);
      expect(p, `${id} must exist`).toBeTruthy();
      expect(p!.curve, `${id} must be discrete or the shell paints a 0..1 rotary`).toBe('discrete');
      expect([p!.min, p!.max], `${id} must span exactly 0..1`).toEqual([0, 1]);
    }
  });

  it('the three named-state params carry an options roster DERIVED from their label arrays', () => {
    // Without a roster the dock paints an anonymous knob over unnamed states.
    for (const id of ['shape', 'flicker', 'tvMode']) {
      const p = backdraftDef.params?.find((x) => x.id === id);
      expect(p!.options?.length, `${id} must declare named detents`).toBeGreaterThan(1);
      // Every detent must land inside the declared range, and the roster must
      // cover the whole range — a state the shader can reach with no caption
      // is the defect this is here to prevent.
      const values = (p!.options ?? []).map((o) => o.value).sort((a, b) => a - b);
      expect(values[0], `${id} roster must start at min`).toBe(p!.min);
      expect(values[values.length - 1], `${id} roster must reach max`).toBe(p!.max);
      for (const o of p!.options ?? []) {
        expect(o.label.length, `${id} detent ${o.value} has an empty caption`).toBeGreaterThan(0);
      }
    }
  });
});

describe('BACKDRAFT face — the printed forms', () => {
  it('bands prints a unit and singularises', () => {
    expect(backdraftBandsText(reader())).toMatch(/^\d+ bands?$/);
  });
});
