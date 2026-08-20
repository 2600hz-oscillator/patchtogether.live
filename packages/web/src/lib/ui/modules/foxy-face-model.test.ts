// packages/web/src/lib/ui/modules/foxy-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the FOXY faceplate.
//
// This face makes five claims in prose that no shared gate can check, and every
// one of them reads as true whether or not it is:
//
//   1. "The tab rail engages by the THRESHOLD, not by `face.tabbed`." Four
//      modules are railed and one of them (spirographs) is railed by an
//      owner-fenced opt-in. A comment saying "ours engages naturally" is
//      indistinguishable from one describing an opt-in nobody checked, unless
//      something proves the rail would GO AWAY if the band count dropped.
//   2. "The shell cannot draw this module's pictures." That is the entire
//      reason foxy ships a `fullViewBody` extension, and it rests on the exact
//      wording of one predicate over a def with THREE video outputs — which is
//      precisely the shape that looks like it should be drawable.
//   3. "`sync_mode` was an ANONYMOUS three-state rotary" (#2007). The fix is
//      cosmetic and reversible, so the assertion has to show the roster is what
//      makes the difference, not merely that a roster exists today.
//   4. "The rosters are DERIVED from the exported constants, never re-typed."
//      A copy would look identical until someone renamed a mode.
//   5. "SCREEN OFF must not stop the module." foxy is pull-driven — the preview
//      loop is the only thing advancing the rasters when nothing downstream is
//      patched — so gating the tick on the collapse flag would freeze the
//      instrument. Nothing at runtime can observe that, so it is checked at
//      SOURCE level, the `card-range-source` discipline.
//
// ⚠ NONE OF THESE IS A KNOB-WIGGLE TEST, deliberately. There is no derived
// readout on this face to negative-control — the resting faceplate paints no
// derived text — so what is at risk is a set of STRUCTURAL claims that would go
// quietly false if a page, a predicate, a roster or a collapse branch moved.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  foxyDef,
  FOXY_GEN_MODE_NAMES,
  FOXY_SYNC_MODE_NAMES,
} from '$lib/audio/modules/foxy';
import { dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { dockTabPlan, faceForcesTabs, DOCK_TAB_MIN_BANDS } from '$lib/ui/workflow/dock-tabs-model';
import { paramCellKind } from '$lib/ui/workflow/shell-control-kind';
import { dockFullViewHeadPlan, hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { PUSH_CARD_CONTROLS } from '$lib/control/push2/push-card-config';
import { OPERATIONAL_DEBT } from '$lib/ui/modules/card-def-debt';
import {
  pushCardParams,
  resolvePushCardControls,
  type PushCardDefLike,
} from '$lib/control/push2/push-card-schema';
import type { ParamDef } from '$lib/graph/types';

/** The face, unwrapped once so every case reads off the LIVE declaration. */
const FACE = foxyDef.face!;
/** Declaration order — the thing the ranking has to be measured AGAINST. */
const DECLARED: readonly string[] = foxyDef.params.map((p) => p.id);
const NO_MOMENTARY: ReadonlySet<string> = new Set<string>();
const param = (id: string): ParamDef => foxyDef.params.find((p) => p.id === id)!;

describe('foxy — the face is promoted and complete', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('foxy')).toBe(true);
    expect(migrated('foxy')).toBe(true);
  });

  it('ranks EVERY declared param — a face that drops one silently hides a control', () => {
    expect([...FACE.order].sort()).toEqual([...DECLARED].sort());
  });

  it('pages every ranked control EXACTLY once — no orphan, no duplicate', () => {
    const paged = (FACE.pages ?? []).flatMap((pg) => [...pg.controls]);
    // Duplicates would emit a second `control-<paramId>` and fail faces-parity's
    // exact multiset; orphans would silently grow a `__unpaged` band and, on a
    // 7-page face, a spurious EIGHTH tab.
    expect(paged.length, 'a control is paged twice').toBe(new Set(paged).size);
    expect([...paged].sort()).toEqual([...FACE.order].sort());
  });

  it('RANKS AGAINST DECLARATION ORDER rather than echoing it', () => {
    // Circularity guard: reading the array back proves nothing. The finding is
    // that MORPH — declared third — leads, because on this module alone the
    // table under it is being rewritten ~24x/second, so MORPH scans an EVOLVING
    // surface rather than picking a frame from a fixed one.
    expect(FACE.order[0]).toBe('morph');
    expect(DECLARED[0]).toBe('tune');
    expect(FACE.order).not.toEqual(DECLARED);
    // The four state pins sit last, together, and BELOW every sound control.
    const freezes = ['freezeRasterA', 'freezeRasterB', 'freezeRasterC', 'freezeTable'];
    expect(FACE.order.slice(-4)).toEqual(freezes);
  });
});

describe('foxy — THE RAIL IS EARNED BY BAND COUNT, NOT DECLARED', () => {
  const plan = dockFacePlan(foxyDef as unknown as FaceDefLike)!;

  it('declares NO face.tabbed — the opt-in is owner-instruction-only', () => {
    expect(FACE.tabbed).toBeUndefined();
    expect(faceForcesTabs(foxyDef as unknown as FaceDefLike)).toBe(false);
  });

  it('reaches the threshold on its own seven honest bands', () => {
    expect(plan.length).toBe(7);
    expect(plan.length).toBeGreaterThanOrEqual(DOCK_TAB_MIN_BANDS);
    expect(dockTabPlan(plan, 'dock-full', foxyDef as unknown as FaceDefLike)).toBeTruthy();
  });

  it('NEGATIVE CONTROL: at SIX bands this face would NOT be railed', () => {
    // ⚠ THE LOAD-BEARING CASE. Without it, "the rail engages naturally" is
    // indistinguishable from "something else is forcing it" — and the module
    // that IS forced (spirographs, 3 bands) sits in the same roster. Dropping
    // one band must turn the rail OFF, which proves the band COUNT is the cause.
    const six = plan.slice(0, 6);
    expect(six.length).toBe(DOCK_TAB_MIN_BANDS - 1);
    expect(dockTabPlan(six, 'dock-full', foxyDef as unknown as FaceDefLike)).toBeFalsy();
  });

  it('declares no page HINT — a hint never paints on a railed face', () => {
    // Authoring seven of them would be writing text that cannot render at any
    // setting, which the annotation-reach lint treats as a defect.
    for (const pg of FACE.pages ?? []) expect(pg.hint).toBeUndefined();
  });
});

describe('foxy — THE SHELL HAS NO ROUTE TO THE PICTURES (why the extension exists)', () => {
  it('has three VIDEO outputs and is still not a video surface', () => {
    // The trap this guards: foxy LOOKS drawable. It declares `scope_out`,
    // `wave3d_out` and `combined_out`, so "the shell can show it" is the
    // natural assumption — and `hasVideoSurface` is `domain === 'video'`, which
    // this AUDIO def fails no matter how many video ports it declares.
    const videoOuts = foxyDef.outputs.filter((o) => o.type === 'video' || o.type === 'mono-video');
    expect(videoOuts.length).toBe(3);
    expect(foxyDef.domain).toBe('audio');
    expect(hasVideoSurface(foxyDef as never)).toBe(false);
  });

  it('declares the extension that supplies them', () => {
    expect(FACE.extension).toBe('foxy');
  });

  it('the extension body CLAIMS THE DOCK HEAD and suppresses the glyph there — but only there', () => {
    const dock = dockFullViewHeadPlan({
      view: 'dock-full', hasGlyph: true, heroCell: false, hasExtensionBody: true,
    });
    expect(dock.extBody).toBe(true);
    expect(dock.heroGlyph, 'two pictures must never paint at once').toBe(false);
    // The PINNED DRAWER paints the same full faceplate and must resolve the
    // same head (#1739) — `isFaceplateView`, not `=== 'dock-full'`.
    const drawer = dockFullViewHeadPlan({
      view: 'drawer', hasGlyph: true, heroCell: false, hasExtensionBody: true,
    });
    expect(drawer.extBody).toBe(true);
    expect(drawer.heroGlyph).toBe(false);
    // NEGATIVE CONTROL, the other direction: the LANE keeps the glyph. A 192px
    // tile cannot carry a module surface, so suppressing it there would leave
    // the compact tile with no identity mark at all.
    const lane = dockFullViewHeadPlan({
      view: 'lane', hasGlyph: true, heroCell: false, hasExtensionBody: true,
    });
    expect(lane.extBody).toBe(false);
    expect(lane.heroGlyph).toBe(true);
  });
});

describe('foxy — THE GLYPH IS HONEST (it resolves onto the REAL output)', () => {
  it("binds live audio on out_l, not a static plate and not a passthrough", () => {
    // The contrast that makes this worth asserting is `rasterize`, whose glyph
    // resolves LIVE onto `thru` — a bare passthrough nothing writes — so its
    // trace moves with the music and is invariant to every control. foxy's
    // primary audio out is the actual oscillator output, so the same mechanism
    // is honest here and the module declares a glyph where rasterize declares
    // none.
    expect(primaryAudioOutPortId(foxyDef as never)).toBe('out_l');
    expect(FACE.glyph).toBe('waveform');
    // `glyphBinding` reads the glyph off the def's OWN face, so this exercises
    // the live declaration rather than a value restated here.
    expect(glyphBinding(foxyDef as never)).toMatchObject({ kind: 'live-audio', portId: 'out_l' });
  });

  it('NEGATIVE CONTROL: strip the audio outputs and the same glyph goes STATIC', () => {
    // Without this, `{kind:'live-audio'}` is indistinguishable from a resolver
    // that returns live-audio for anything — which is exactly the reading that
    // would hide a dead glyph. The binding must DEPEND on the audio out.
    const videoOnly = {
      ...foxyDef,
      outputs: foxyDef.outputs.filter((o) => o.type !== 'audio'),
    };
    expect(primaryAudioOutPortId(videoOnly as never)).toBeNull();
    expect(glyphBinding(videoOnly as never)).toMatchObject({ kind: 'static' });
  });
});

describe('foxy — #2007: THE MODE ROSTERS', () => {
  it('sync_mode and gen_mode both declare an options roster', () => {
    expect(param('sync_mode').options?.length).toBe(3);
    expect(param('gen_mode').options?.length).toBe(2);
  });

  it('the rosters are DERIVED from the exported constants, both directions', () => {
    // ⚠ A RE-TYPED COPY WOULD PASS EVERY OTHER ASSERTION IN THIS FILE and only
    // diverge the day someone renames a mode — at which point the card (which
    // indexes the same arrays) and the face would silently disagree. Asserting
    // equality against the constant is what makes "one source of truth" a
    // checked property rather than a comment.
    expect(param('sync_mode').options!.map((o) => o.label)).toEqual([...FOXY_SYNC_MODE_NAMES]);
    expect(param('gen_mode').options!.map((o) => o.label)).toEqual([...FOXY_GEN_MODE_NAMES]);
    // Values are the param's own integers, in range — a roster that named a
    // value outside [min,max] would select a state the DSP cannot reach.
    for (const id of ['sync_mode', 'gen_mode']) {
      const p = param(id);
      expect(p.options!.map((o) => o.value)).toEqual(p.options!.map((_, i) => i));
      for (const o of p.options!) {
        expect(o.value).toBeGreaterThanOrEqual(p.min);
        expect(o.value).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it('sync_mode paints a NAMED cell at the dock', () => {
    expect(paramCellKind(param('sync_mode'), NO_MOMENTARY, 'dock')).toBe('segmented');
    expect(paramCellKind(param('gen_mode'), NO_MOMENTARY, 'dock')).toBe('segmented');
  });

  it('NEGATIVE CONTROL: WITHOUT the roster sync_mode is an anonymous knob', () => {
    // ⚠ THE DEFECT, REPRODUCED. This is what shipped: `looksLikeToggle` needs
    // min 0 / max 1, so a `discrete 0..2` falls through to a plain dial, and
    // with no roster nothing names the three states. Without this case the
    // suite would only prove "a roster exists", never that the roster is what
    // stopped it being anonymous.
    const stripped = { ...param('sync_mode'), options: undefined };
    expect(paramCellKind(stripped, NO_MOMENTARY, 'dock')).toBe('knob');
    // And the asymmetry that made the pair worth fixing together: gen_mode's
    // 0..1 span DID resolve a toggle without a roster, so it was never an
    // anonymous dial — its half of #2007 is the card's `curve` contradiction,
    // asserted below.
    const strippedGen = { ...param('gen_mode'), options: undefined };
    expect(paramCellKind(strippedGen, NO_MOMENTARY, 'dock')).toBe('toggle');
  });

  it('the FACE makes the fractional write unreachable — and the CARD keeps its LEDGERED debt', () => {
    // ⚠ THIS ASSERTION USED TO SAY "the card no longer contradicts the def",
    // AND FIXING THE CARD TO SATISFY IT WAS THE WRONG MOVE — recorded here
    // because the wrong move passed every gate it was aimed at.
    //
    // The card passes `curve="linear"` against this def's `discrete`. That is a
    // real disagreement, and it is DEFERRED DEBT rather than an oversight:
    // `card-def-debt.ts` states that binding the prop "would be a GREEN GATE
    // OVER A LIVE BUG", because the legacy `Knob.svelte` the card uses has no
    // `discrete` branch at all — so writing `discrete` there moves no pixel,
    // stops no fractional write, and only recolours a test. Both cards that
    // paid this entry did so on a release condition (entering
    // `RANGE_BOUND_CARDS`); FoxyCard has not met it.
    //
    // So what this test pins is the split §B10.5 actually predicted: the DEF is
    // right, the CARD's divergence stays tracked, and the FACE is where the
    // defect becomes unreachable — a `segmented` cell writes an option's own
    // integer `value`.
    expect(param('gen_mode').curve).toBe('discrete');
    expect(param('sync_mode').curve).toBe('discrete');
    // The face's cell writes exact integers, never a fraction.
    for (const o of param('gen_mode').options!) expect(Number.isInteger(o.value)).toBe(true);
    // ⚠ ANCHORED TO THE LEDGER, BOTH DIRECTIONS. If someone binds the card prop
    // without paying the entry, `card-def-agreement` reddens (a ledger entry
    // naming a divergence that no longer exists is stale). If someone deletes
    // the entry while the divergence stands, that gate reddens too. This side
    // asserts the debt is still DECLARED, so a silent removal of the record —
    // which would leave the disagreement untracked — cannot pass.
    expect(
      OPERATIONAL_DEBT['FoxyCard.svelte'],
      'foxy card debt is no longer declared — was it PAID, or just un-recorded?',
    ).toContain('gen_mode.curve');
    // And the divergence the entry names is really still there.
    const card = readFileSync(
      fileURLToPath(new URL('./FoxyCard.svelte', import.meta.url)),
      'utf8',
    );
    const genKnob = card.split('\n').find((l) => l.includes('paramId="gen_mode"'));
    expect(genKnob, 'the gen_mode Knob line vanished — re-point this assertion').toBeTruthy();
    expect(genKnob!).toContain('curve="linear"');
  });
});

describe('foxy — THE PUSH 2 CARD IS PINNED, not inherited', () => {
  /** The face's own ranks 1-8 — the thing the override is a LOCK on. */
  const PINNED = ['morph', 'fold', 'tune', 'spread', 'fine', 'xyz_zoom', 'xyz_smooth', 'xyz_warp'];

  it('has an explicit PUSH_CARD_CONTROLS entry at all', () => {
    // ⚠ THE REGRESSION THIS CATCHES IS A DELETION. Without an entry foxy falls
    // back to the FACE tier, which is correct TODAY and silently re-ranks the
    // hardware surface the next time `face.order` moves. An override REPLACES,
    // so it cannot drift.
    expect(PUSH_CARD_CONTROLS.foxy, 'foxy lost its pinned Push card').toBeDefined();
    expect([...PUSH_CARD_CONTROLS.foxy!]).toEqual(PINNED);
  });

  it('the pin AGREES with the face today — it is a lock, not a divergence', () => {
    // Resolving with NO overrides exercises the FACE tier (first 8 turnable
    // ranks). That it returns the same eight is what makes the entry a lock on
    // a decision rather than a second, competing ranking to keep in step.
    const faceTier = pushCardParams(
      resolvePushCardControls(foxyDef as unknown as PushCardDefLike, {}),
    ).map((p) => p.id);
    expect(faceTier).toEqual(PINNED);
    const pinned = pushCardParams(
      resolvePushCardControls(foxyDef as unknown as PushCardDefLike),
    ).map((p) => p.id);
    expect(pinned).toEqual(PINNED);
  });

  it('NEGATIVE CONTROL: promotion really did change the card (the silent move)', () => {
    // ⚠ THE THING THAT SHIPPED UNOBSERVED. Before the face, foxy resolved the
    // GENERIC tier — declaration order — and no golden pinned it, so the move
    // was invisible to every gate. Reproducing the un-faced resolution proves
    // the two cards genuinely differ, which is what makes pinning worth doing
    // rather than ceremony.
    const unfaced = { ...foxyDef, face: undefined };
    const generic = pushCardParams(
      resolvePushCardControls(unfaced as unknown as PushCardDefLike, {}),
    ).map((p) => p.id);
    expect(generic, 'the generic card is declaration order').toEqual(
      ['tune', 'fine', 'morph', 'spread', 'fold', 'src_tune', 'src_fine', 'src_timbre'],
    );
    expect(generic).not.toEqual(PINNED);
  });
});

describe('foxy — SCREEN OFF MUST NOT STOP THE MODULE (the pull-driven inversion)', () => {
  // ⚠ SOURCE-LEVEL, because no runtime gate can see it. `bridgeTick()` runs
  // INSIDE the engine handle's `read()` seam, so with nothing patched
  // downstream this component's rAF loop is the only thing advancing the three
  // rasters and the wavetable. Gating the tick on `previewCollapsed` would
  // freeze the instrument itself while looking like a sensible optimisation —
  // the #1720/#1721 class, and the mistake most likely to be copied in from the
  // VIDEO `fullViewBody` adopters, where collapsing legitimately stops a copy.
  const body = readFileSync(
    fileURLToPath(new URL('./foxy/FoxyOutputBody.svelte', import.meta.url)),
    'utf8',
  );

  it('reads the tick BEFORE the collapse branch, never inside it', () => {
    const tickAt = body.indexOf(`read(node, 'tick')`);
    const guardAt = body.indexOf('if (!previewCollapsed)');
    expect(tickAt, "the unconditional tick is gone — foxy stops when SCREEN is off").toBeGreaterThan(-1);
    expect(guardAt, 'the collapse branch is gone — re-point this assertion').toBeGreaterThan(-1);
    expect(tickAt, 'the tick moved INSIDE the collapse branch (#1720/#1721)').toBeLessThan(guardAt);
  });

  it('keeps both switches on node.data, which survives the unmount', () => {
    // The component unmounts on dock collapse / LRU eviction, so component
    // `$state` would lose the SCREEN setting the owner requires to persist
    // across tab switches (#1531 / #1574 / #1583).
    expect(body).toContain('data.previewCollapsed');
    expect(body).toContain('data.vizMode');
    expect(body, 'a $state switch would die with the component').not.toMatch(
      /let\s+previewCollapsed\s*=\s*\$state/,
    );
  });

  it('reuses the FLEET previewCollapsed key, so old racks stay collapsed', () => {
    // A foxy-specific key would silently re-open the preview of every rack
    // saved before this face existed.
    expect(body).toContain('previewCollapsed');
    expect(body).not.toMatch(/foxyPreviewCollapsed|previewCollapsedFoxy/);
  });

  it('emits NO control-<paramId> testid — those belong to param cells alone', () => {
    // faces-parity asserts exact multiset equality between the dock's
    // `control-*` testids and the def's param ids, so any `control-` testid in
    // a bespoke surface reads as an extra control with no def backing.
    expect(body).not.toMatch(/data-testid="control-/);
  });
});
