// packages/web/src/lib/ui/modules/rasterize-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the RASTERIZE faceplate.
//
// This face makes three claims in prose that no shared gate can check, and each
// one is the kind that reads as true whether or not it is:
//
//   1. "`glyph: 'none'` is a CHOICE here, not a forced one." Every other
//      glyph-less face in the roster (`moog921a`, `fourplexer`) has that
//      decision MADE FOR IT — every output is `cv`, so `primaryAudioOutPortId`
//      returns null and the dead-glyph clause refuses anything else. A comment
//      saying "we chose this" is indistinguishable from one saying "we had no
//      option" unless something proves a different glyph WOULD have resolved.
//   2. "The shell cannot draw this module's picture." That is why the module
//      ships a `fullViewBody` extension at all, and it rests on the exact
//      wording of one predicate.
//   3. "SCAN ranks last." A rank assertion that merely reads the array back is
//      circular; what makes it a finding is that it INVERTS declaration order.
//
// ⚠ NONE OF THESE IS A KNOB-WIGGLE TEST, deliberately. There is no derived
// readout on this face to negative-control — the resting faceplate paints no
// derived text — so what is at risk here is not arithmetic, it is a set of
// structural claims that would go quietly false if a port type, a predicate or
// a rank changed underneath them.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rasterizeDef } from '$lib/audio/modules/rasterize';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import {
  pushCardParams,
  resolvePushCardControls,
  type PushCardDefLike,
} from '$lib/control/push2/push-card-schema';
import { VIDEO_RES } from '$lib/video/engine';

/** The face, unwrapped once so every case reads off the live declaration. */
const FACE = rasterizeDef.face!;
/** Declaration order — the thing the rank has to be measured AGAINST. */
const DECLARED: readonly string[] = rasterizeDef.params.map((p) => p.id);

describe('rasterize — the face is promoted and complete', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('rasterize')).toBe(true);
    expect(migrated('rasterize')).toBe(true);
  });

  it('ranks EVERY declared param — a face that drops one silently hides a control', () => {
    expect([...FACE.order].sort()).toEqual([...DECLARED].sort());
  });

  it('declares no `pages`: four params are one idea, and a rail needs seven bands', () => {
    // Recorded so that ADDING pages later is a deliberate act with a red test,
    // not a drive-by. The tabbed ruling's threshold is DOCK_TAB_MIN_BANDS = 7.
    expect(FACE.pages).toBeUndefined();
  });
});

describe('rasterize — CLAIM 1: the missing glyph is a CHOICE, not a refusal', () => {
  it('a primary AUDIO output EXISTS, so a live glyph would have resolved', () => {
    // THE POSITIVE CONTROL, and it is the whole point of this block. The
    // glyph-less faces this one sits beside are glyph-less because this
    // returns null. Here it returns THRU — so nothing forced the decision.
    expect(primaryAudioOutPortId(rasterizeDef)).toBe('thru');
  });

  it('NEGATIVE CONTROL: asking for a `scope` glyph binds LIVE, it does not fall to static', () => {
    // Proves the counterfactual rather than asserting it in a comment: had the
    // face declared `scope`, the shell would have bound a real analyser trace
    // (`live-audio`), NOT the `{kind:'static'}` shape the dead-glyph clause
    // refuses. So `'none'` was available to reject, which is what "chosen"
    // means. ⚠ If this ever starts returning 'static', the comment on the def
    // becomes false and this test is the thing that says so.
    const asScope = glyphBinding({ ...rasterizeDef, face: { ...FACE, glyph: 'scope' } });
    expect(asScope.kind).toBe('live-audio');
  });

  it('and the face nonetheless declares none, so the lane tile paints controls', () => {
    expect(FACE.glyph).toBe('none');
    expect(laneGlyphFor(rasterizeDef)).toBe('none');
  });

  // ⚠ THE SECOND COUNTERFACTUAL, AND IT DID NOT EXIST WHEN THE FACE SHIPPED.
  // #2160 widened the resolver so `algorithm` + `layoutSource` binds for this
  // cohort, which turned the def's recorded reason from "no kind fits" into
  // "the kind that fits carries no data". The leg above proves `'scope'` was
  // available to reject; this one proves the NEWER option was too — otherwise
  // the rewritten comment on the def is an unchecked claim, and the next
  // reader re-derives the widening from scratch and may reach the opposite
  // answer.
  it('NEGATIVE CONTROL: a LAYOUT-SOURCE glyph also binds — and is a CONSTANT picture', () => {
    const asAlgorithm = glyphBinding({
      ...rasterizeDef,
      face: { ...FACE, glyph: 'algorithm' },
    });
    // It RESOLVES — the refusal is not mechanical, unlike a terminal sink's.
    expect(asAlgorithm.kind).toBe('algorithm');
    expect(asAlgorithm).toMatchObject({ kind: 'algorithm', layoutSource: 'rasterize' });

    // …AND IT CARRIES NO DATUM. `paramId: null` is the whole finding: the
    // shell feeds `topologyValue: 0` whenever it is null, and
    // `ShellExtensionGlyphProps` has no `nodeId`, so the picture cannot vary
    // per node or over time. A live-KIND glyph that is identical on every
    // instance forever is not a picture of this module — which is why `'none'`
    // survives the re-decision rather than merely surviving inertia.
    expect(
      (asAlgorithm as { paramId?: string | null }).paramId ?? null,
      'a layout-source glyph binds no param, so the shell has nothing to vary it with',
    ).toBeNull();
  });
});

describe('rasterize — CLAIM 2: the shell has no generic route to this picture', () => {
  it('the def is AUDIO-domain with a mono-video OUT — the excluded case, exactly', () => {
    expect(rasterizeDef.domain).toBe('audio');
    expect(rasterizeDef.outputs.find((o) => o.id === 'out')?.type).toBe('mono-video');
  });

  it('so `hasVideoSurface` is FALSE, which is why the extension exists', () => {
    // The load-bearing one. `hasVideoSurface` is `domain === 'video'`; a
    // mono-video PORT does not make a video SURFACE, because the VideoEngine
    // registers a per-node FBO only for video-domain nodes. Without this being
    // false the extension would be redundant; with it true the picture is gone.
    expect(hasVideoSurface(rasterizeDef)).toBe(false);
  });

  it('POSITIVE CONTROL: the same predicate IS true for a video-domain def', () => {
    // Without this leg the assertion above passes on a predicate that returns
    // false for everything — the blind-gate shape. This pins that the
    // predicate discriminates, so `false` above is a fact about rasterize.
    expect(hasVideoSurface({ domain: 'video' })).toBe(true);
  });

  it('declares the extension that carries the picture to the dock', () => {
    expect(FACE.extension).toBe('rasterize');
  });
});

describe('rasterize — CLAIM 3: SCAN ranks LAST, inverting declaration order', () => {
  it('cursor is declared FIRST', () => {
    expect(DECLARED[0]).toBe('cursor');
  });

  it('and ranked LAST — the inversion is the finding (#2000)', () => {
    // A control that cannot return to a position it is already displaying, and
    // whose finest gesture moves ~39 px of a 786 432 px range, is the least
    // trustworthy thing on the module. Asserted as an INVERSION rather than as
    // an index, so it stays meaningful if a param is ever added.
    expect(FACE.order[FACE.order.length - 1]).toBe('cursor');
    expect(FACE.order.indexOf('cursor')).toBeGreaterThan(FACE.order.indexOf('samplesPerFrame'));
  });

  it('SAMP/F ranks first — the only control that changes the picture STRUCTURE', () => {
    expect(FACE.order[0]).toBe('samplesPerFrame');
  });

  it('the compact tier therefore drops SCAN, not a working control', () => {
    // A glyph-less compact tile takes the top 3 ranks (`faceTierCap`). Written
    // as a property of the ORDER rather than a hardcoded tier call, so it says
    // what it means: whatever falls off the lane budget, it is the broken one.
    const compactThree = FACE.order.slice(0, 3);
    expect(compactThree).not.toContain('cursor');
    expect(compactThree).toEqual(['samplesPerFrame', 'gain', 'wrap']);
  });
});

describe('rasterize — the Push 2 card moved GENERIC → FACE, accepted deliberately', () => {
  it('resolves from the FACE tier and re-orders the encoders', () => {
    // CLAUDE.md's push-card note: a first promotion moves the whole card, and
    // the schema golden only covers OVERRIDES so it would never have gone red.
    // Recorded here instead of left silent. Nothing pins rasterize in
    // PUSH_CARD_CONTROLS, and nothing should — the card is a permutation of the
    // same four params, which is the case an override would be wrong to freeze.
    const spec = resolvePushCardControls(rasterizeDef as unknown as PushCardDefLike);
    expect(spec.source).toBe('face');
    // SCAN was encoder 1 under declaration order; it is now last.
    expect(pushCardParams(spec).map((p) => p.id)).toEqual([
      'samplesPerFrame',
      'gain',
      'wrap',
      'cursor',
    ]);
  });
});

describe('rasterize — the cvCombined PUSH moved to the NODE, and there is ONE writer', () => {
  // ⚠ HISTORY, BECAUSE THE OLD ASSERTION WAS THE OPPOSITE. This block used to
  // hold "the face body PUSHES the combined value before reading the frame" —
  // written when the body and the card each carried a pasted copy of the whole
  // loop, because whoever held the only mounted loop was the only thing making
  // a patched CV cable reach the picture (#1664) or advancing the painter at
  // all (#1720/#1721). legacy-removal S1.5 moved BOTH duties to
  // `RASTERIZE_FRAME_PRODUCER` on node lifetime, so the claims to hold at
  // source level inverted: the PRODUCER must push-then-read, and the surfaces
  // must NOT push — a surface that still did would be a second writer of one
  // engine channel, the exact drift class the scope extraction retired.
  const BODY = readFileSync(
    new URL('./rasterize/RasterizeOutputBody.svelte', import.meta.url),
    'utf8',
  );
  const CARD = readFileSync(
    new URL('./RasterizeCard.svelte', import.meta.url),
    'utf8',
  );
  const PRODUCER = readFileSync(
    new URL('../media/frame-producers.ts', import.meta.url),
    'utf8',
  );

  it('the NODE producer pushes the combined value BEFORE reading the frame (#1664)', () => {
    const block = /export const RASTERIZE_FRAME_PRODUCER[\s\S]*?\n\};/.exec(PRODUCER)?.[0];
    expect(block, 'RASTERIZE_FRAME_PRODUCER must exist in frame-producers.ts').toBeTruthy();
    const pushAt = block!.indexOf("'cvCombined'");
    const readAt = block!.indexOf("'imageData'");
    expect(pushAt, 'the producer must push cvCombined').toBeGreaterThan(-1);
    expect(readAt, "the producer must read('imageData') — that is what advances the painter")
      .toBeGreaterThan(-1);
    // ORDER IS THE ASSERTION, not mere presence: reading before pushing paints
    // the frame with last frame's CV, which is the #1664 bug wearing a fix.
    expect(pushAt, 'cvCombined must be written BEFORE imageData is read').toBeLessThan(readAt);
  });

  it('NEITHER surface pushes — a viewer that wrote engine state would be a second producer', () => {
    // The producer seam the derivation gate greps for is `write(node|id, …)`;
    // a surface reacquiring it would ALSO re-enrol rasterize in
    // CARD_PRODUCER_LANE_TYPES via dom-source-modules.test.ts, so this leg and
    // that gate hold the same line from two directions.
    // The CALL shape, not the word — both files may (and do) NAME the push in
    // the comment that says where it went.
    const PUSH_CALL = /write\(\s*(?:node|id|nodeId)\s*,\s*'cvCombined'/;
    expect(PUSH_CALL.test(BODY), 'the dock body must not push cvCombined').toBe(false);
    expect(PUSH_CALL.test(CARD), 'the legacy card must not push cvCombined').toBe(false);
    // …and both still READ the frame, which is how they show it. The read's
    // advance is deduped by the module's own 8 ms guard.
    expect(BODY).toMatch(/read\(node, 'imageData'\)/);
    expect(CARD).toMatch(/read\(node, 'imageData'\)/);
  });

  it('state lives on node.data, not component $state (the #1531/#1574/#1583 class)', () => {
    expect(BODY).toMatch(/data\?\.previewCollapsed/);
    expect(BODY).toMatch(/mutateNode\(/);
  });
});

describe('rasterize — WRAP keeps its STATE NAMES through promotion', () => {
  const wrap = rasterizeDef.params.find((p) => p.id === 'wrap')!;

  it('declares the roster the card printed as its button caption', () => {
    // Without this the face paints an ANONYMOUS switch: `paintsReadout` is
    // `!format && (options || landmarks)`, and the card is the only place the
    // words WRAP and CLAMP ever appeared. The fourplexer (Q29) control loss,
    // reached on a two-state param instead of a four-state one.
    expect(wrap.options?.map((o) => o.label)).toEqual(['WRAP', 'CLAMP']);
  });

  it('ANCHORED: every detent is a reachable value of the param', () => {
    for (const o of wrap.options ?? []) {
      expect(o.value).toBeGreaterThanOrEqual(wrap.min);
      expect(o.value).toBeLessThanOrEqual(wrap.max);
    }
  });

  it('NEGATIVE CONTROL: the labels are NAMES, not numbers wearing a label', () => {
    // The resting-text rule permits an option NAME and refuses a value. A
    // roster of '0'/'1' would satisfy the assertion above and still paint a
    // number, so the shape of the label is its own check.
    for (const o of wrap.options ?? []) {
      expect(o.label).not.toMatch(/^[-+0-9.]+$/);
    }
  });
});

describe('rasterize — the three continuous controls are FADERS, like the card', () => {
  it('declares fader for exactly the params the card mounts as NeonFaders', () => {
    // Nothing in a ParamDef separates a THROW from any other continuous
    // scalar, so an undeclared face silently renders three dials — the `noise`
    // regression the kind exists for.
    expect(FACE.paramCells).toEqual({
      samplesPerFrame: 'fader',
      gain: 'fader',
      cursor: 'fader',
    });
  });

  it('and WRAP is NOT among them — a switch is not a throw', () => {
    expect(FACE.paramCells?.wrap).toBeUndefined();
  });
});

describe('rasterize — #2001: the frame is 1024x768 and the prose now says so', () => {
  it('the cursor range IS the live engine frame, derived rather than retyped', () => {
    // The def computes `max` from VIDEO_RES, so this cannot drift — but the
    // PROSE around it did drift, for long enough to reach the public module
    // manifest. This pins the arithmetic the prose has to agree with.
    const cursor = rasterizeDef.params.find((p) => p.id === 'cursor')!;
    expect(cursor.max).toBe(VIDEO_RES.width * VIDEO_RES.height);
    expect(cursor.max).toBe(786_432);
  });

  it('NEGATIVE CONTROL: the retired 640x480 frame is NOT what the module uses', () => {
    // The leg that would have caught #2001. The stale prose figure has to be
    // WRONG against the live constant, or the correction was cosmetic.
    expect(VIDEO_RES.width * VIDEO_RES.height).not.toBe(640 * 480);
    expect(VIDEO_RES.width).toBe(1024);
  });
});
