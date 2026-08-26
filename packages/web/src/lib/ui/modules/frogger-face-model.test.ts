// packages/web/src/lib/ui/modules/frogger-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the FROGGER faceplate.
//
// This face rests on five claims that no shared gate can check, and every one
// of them reads as true whether or not it is:
//
//   1. "The board survives promotion." The picture was painted by a LEGACY CARD
//      the shipping shell does not mount. Every registry test stays green if it
//      simply disappears.
//   2. "SCREEN OFF stops the picture and NOTHING else." The strongest single
//      claim on this surface, and the one a reader is most likely to copy onto
//      a module where it is false.
//   3. "`glyph: 'none'` is not a lazy default." It is nearly forced here — but
//      "nearly" is a measurement, and one kind does still resolve.
//   4. "The face adds no resting numbers of its own." `face-resting-text-source`
//      names its own blind spot: text drawn INTO a canvas is invisible to it,
//      and a chrome row inside a module-owned `fullViewBody` is not a
//      `ModuleFace` field either. Nothing else looks.
//   5. "The VRT tick pin can actually pin." A dead pin produces a perfectly
//      plausible picture — a different one on every boot.
//
// ⚠ NONE OF THESE IS A KNOB-WIGGLE TEST. The knob's own behaviour is pinned in
// `frogger-state.test.ts`, where the stepper lives and where the legs fail on
// the old code. What is at risk HERE is a set of structural claims that would
// go quietly false if a port type, a predicate, a call signature or a rank
// changed underneath them.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { froggerDef } from '$lib/audio/modules/frogger';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { curatedFace, FACE_TIER_CAPS, type FaceTier } from '$lib/ui/workflow/curated-face';

/** Every tier the shell can render, DERIVED from the cap table rather than
 *  re-typed — a hand-listed ladder would silently stop covering a new tier. */
const ALL_TIERS = Object.keys(FACE_TIER_CAPS) as FaceTier[];

/** The face, unwrapped once so every case reads off the live declaration. */
const FACE = froggerDef.face!;
/** Declaration order — what a rank has to be measured AGAINST. */
const DECLARED: readonly string[] = froggerDef.params.map((p) => p.id);

const BODY = readFileSync(new URL('./frogger/FroggerBoardBody.svelte', import.meta.url), 'utf8');
const CARD = readFileSync(new URL('./FroggerCard.svelte', import.meta.url), 'utf8');
const STEPPER = readFileSync(
  new URL('../../audio/modules/frogger-state.ts', import.meta.url),
  'utf8',
);
const DEF_SRC = readFileSync(new URL('../../audio/modules/frogger.ts', import.meta.url), 'utf8');

/** Everything between `</script>` and `<style>` — the rendered DOM, as source. */
function markupOf(svelte: string): string {
  const start = svelte.indexOf('</script>');
  const end = svelte.lastIndexOf('<style>');
  expect(start, 'the component must have a script block').toBeGreaterThan(-1);
  return svelte.slice(start + '</script>'.length, end === -1 ? undefined : end);
}

/**
 * The LITERAL TEXT the body's DOM would contain — tags, markup comments and
 * Svelte interpolations removed.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST AND THAT ORDER IS LOAD-BEARING. A markup
 * comment is not rendered text, but it CAN contain `>` (an attribute example, a
 * CLI flag), which splits a naive `<[^>]*>` tag match part-way through and
 * leaks prose into the result. That is a false POSITIVE — the safe direction —
 * but it would have made this leg impossible to keep honest, so it is handled
 * rather than worked around.
 */
function literalTextOf(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, ' ')  // markup comments — never rendered
    .replace(/<[^>]*>/g, ' ')           // element tags + their attributes
    .replace(/\{[^{}]*\}/g, ' ')        // svelte interpolations + blocks
    .replace(/\s+/g, ' ')
    .trim();
}

describe('frogger — the face is promoted and complete', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('frogger')).toBe(true);
    expect(migrated('frogger')).toBe(true);
  });

  it('ranks EVERY declared param — a face that drops one silently hides a control', () => {
    expect([...FACE.order].sort()).toEqual([...DECLARED].sort());
  });

  it('declares ONE page, so the tab rail is structurally out of reach', () => {
    // DOCK_TAB_MIN_BANDS is 7. Recorded so that ADDING pages later is a
    // deliberate act with a red test, and so nobody pads bands to reach a rail.
    expect(FACE.pages).toHaveLength(1);
    expect(FACE.pages?.[0]?.controls).toEqual(['initialTime']);
  });
});

describe('frogger — the TIER LADDER, derived rather than read off the caps', () => {
  // ⚠ DERIVED THROUGH `curatedFace`, NEVER FROM THE CAP CONSTANTS. Four sibling
  // faces got this wrong by reading `FACE_TIER_CAPS` directly, which is the
  // pre-reconciliation number and not what the lane actually fits.
  it('is the SAME SENTENCE at every tier — TIME, and at the dock TIME plus the board', () => {
    expect(ALL_TIERS.length, 'the ladder must cover every declared tier').toBeGreaterThan(1);
    for (const tier of ALL_TIERS) {
      const face = curatedFace(froggerDef, tier);
      expect(face, `tier ${tier} must resolve a face`).not.toBeNull();
      expect(
        face!.controls.map((c) => c.key),
        `tier ${tier}: a one-param module shows its one param at every tier`,
      ).toEqual(['initialTime']);
    }
  });

  it('and that is the CORRECT outcome of a one-param module, not a truncation', () => {
    // The distinction worth pinning: nothing is being DROPPED at the small
    // tiers. If a control were ever added and silently fell off the lane
    // budget, this leg separates "we show everything" from "we show the cap".
    expect(DECLARED).toHaveLength(1);
    const dock = curatedFace(froggerDef, 'dock')!;
    expect(dock.controls).toHaveLength(DECLARED.length);
    expect(dock.pages?.map((p) => p.id)).toEqual(['run']);
  });
});

describe('frogger — CLAIM 1: the shell has no generic route to this board', () => {
  it('the def is AUDIO-domain, which is exactly the excluded case', () => {
    expect(froggerDef.domain).toBe('audio');
    expect(hasVideoSurface(froggerDef)).toBe(false);
  });

  it('POSITIVE CONTROL: the same predicate IS true for a video-domain def', () => {
    // Without this leg the assertion above passes on a predicate that returns
    // false for everything — the blind-gate shape.
    expect(hasVideoSurface({ domain: 'video' })).toBe(true);
  });

  it('so the face declares the extension that carries the board to the dock', () => {
    expect(FACE.extension).toBe('frogger');
  });

  it('and the body IMPORTS the def\'s painter rather than re-implementing it', () => {
    // Two painters for one picture is two things that can diverge with nothing
    // able to notice. `drawFrogger` is already a pure exported function.
    expect(BODY).toMatch(/import \{[^}]*drawFrogger/);
    expect(BODY).toMatch(/drawFrogger\(/);
    // NEGATIVE CONTROL on the shape: the body must not carry its own grid
    // geometry. If it ever draws cells itself, this is the thing that says so.
    expect(BODY).not.toMatch(/fillRect\(/);
  });
});

describe('frogger — CLAIM 2: SCREEN OFF stops the PICTURE and nothing else', () => {
  // ⚠ THE MOST VALUABLE ASSERTION ON THIS SURFACE, and it is here rather than
  // in a comment precisely because `skifree` — one module away in the same
  // family — does NOT have this property, and somebody will copy this body.
  //
  // The mechanism: FROGGER's game runs on the shared scheduler clock,
  // subscribed inside the module's FACTORY. Not in a card, not on rAF, not
  // gated on anything watching. So collapsing the preview skips a `drawFrogger`
  // call and the timer still counts, the traffic still moves and the gates
  // still fire.
  it('the game is driven from the FACTORY, so no surface owns its clock', () => {
    expect(DEF_SRC).toMatch(/getSchedulerClock\(\)\.subscribe\(tick\)/);
    // …and the stepper is called from that subscription, not from a component.
    expect(DEF_SRC).toMatch(/stepFroggerState\(/);
    expect(BODY, 'the body must never step the game').not.toMatch(/stepFroggerState/);
  });

  it('the body only READS a snapshot — it has no write path into the engine', () => {
    expect(BODY).toMatch(/eng\.read\(node, 'snapshot'\)/);
    // The one and only engine call. A `write`/`setParam`/`readParam` here would
    // mean the picture had become load-bearing for the module's behaviour,
    // which is the rasterize inversion and is NOT this module's shape.
    expect(BODY).not.toMatch(/eng\.write\(/);
    expect(BODY).not.toMatch(/eng\.setParam\(/);
  });

  it('collapse gates the DRAW ONLY — never an early return above the read', () => {
    // The negative control is the SHAPE. An early return on `previewCollapsed`
    // above the snapshot read would stop the accessible name tracking the game
    // and would be one refactor away from stopping the module.
    const readAt = BODY.indexOf("eng.read(node, 'snapshot')");
    expect(readAt).toBeGreaterThan(-1);
    const before = BODY.slice(0, readAt);
    expect(
      /if\s*\(\s*previewCollapsed\s*\)\s*return/.test(before),
      'an early return on previewCollapsed ABOVE the read would stop tracking the game',
    ).toBe(false);
    // And the draw IS gated, or the toggle would do nothing at all.
    expect(BODY).toMatch(/!previewCollapsed\s*&&\s*canvasEl/);
  });

  it('the switch state lives on node.data (the #1531/#1574/#1583 class)', () => {
    // A `$state` here dies with the component, and this component unmounts on
    // dock collapse / LRU eviction.
    expect(BODY).toMatch(/data\?\.previewCollapsed/);
    expect(BODY).toMatch(/mutateNode\(/);
  });
});

describe('frogger — CLAIM 3: the missing glyph is all but FORCED, and that is measured', () => {
  it('there is NO primary audio output — every output is a gate', () => {
    expect(froggerDef.outputs.every((o) => o.type === 'gate')).toBe(true);
    expect(primaryAudioOutPortId(froggerDef)).toBeNull();
  });

  it('so every LIVE glyph kind resolves STATIC and is refused by the dead-glyph clause', () => {
    // This is the leg that separates frogger from `rasterize`, whose identical
    // `glyph: 'none'` declaration is a genuine CHOICE (a scope glyph would have
    // bound live there). Here there was nothing live to reject.
    for (const kind of ['scope', 'meter', 'envelope', 'waveform'] as const) {
      const bound = glyphBinding({ ...froggerDef, face: { ...FACE, glyph: kind } });
      expect(bound.kind, `glyph '${kind}' must resolve static on a gate-only def`).toBe('static');
    }
  });

  it('⚠ but `algorithm` DOES resolve — and it is refused on its own merits', () => {
    // The honest half, and the reason the def does not say "forced" flat out.
    // #2160 widened the resolver, so this kind binds. It is still wrong here,
    // and for a mechanical reason rather than a taste one.
    const asAlgorithm = glyphBinding({ ...froggerDef, face: { ...FACE, glyph: 'algorithm' } });
    expect(asAlgorithm.kind).toBe('algorithm');
    expect(asAlgorithm).toMatchObject({ kind: 'algorithm', layoutSource: 'frogger' });
    // …AND IT CARRIES NO DATUM. The shell feeds `topologyValue: 0` when
    // `paramId` is null, and `ShellExtensionGlyphProps` has no `nodeId`, so the
    // component cannot resolve a node and cannot reach the game snapshot. A
    // glyph identical on every frogger in the rack forever is not a picture of
    // this module.
    expect(
      (asAlgorithm as { paramId?: string | null }).paramId ?? null,
      'a layout-source glyph binds no param, so the shell has nothing to vary it with',
    ).toBeNull();
  });

  it('and the face declares none, so the lane tile paints ONE control and no board', () => {
    expect(FACE.glyph).toBe('none');
    expect(laneGlyphFor(froggerDef)).toBe('none');
  });
});

describe('frogger — CLAIM 4: the face adds NO resting numbers of its own', () => {
  // ⚠ THE RULING AND ITS ENFORCEMENT GAP, STATED HONESTLY. A game's score and
  // lives painted INSIDE the playfield canvas are ALLOWED — that is the game's
  // own artwork, drawn by `drawFrogger`, and it is part of the picture that
  // earns the width. A score or lives row rendered as CHROME BESIDE the
  // playfield is FORBIDDEN: that is the hero readout strip with a different
  // label.
  //
  // `face-resting-text-source` cannot see either shape (canvas text is
  // invisible to it, and a row inside a module-owned body is not a `ModuleFace`
  // field). This block plus the dock VRT baseline are the only things that look.
  it('the HUD is painted by the MODULE\'s own function, into the canvas', () => {
    expect(DEF_SRC).toMatch(/ctx2d\.fillText\(`LIVES \$\{state\.player\.lives\}/);
  });

  it('the body renders exactly ONE literal text run, and it is the SWITCH CAPTION', () => {
    // Strip tags, then interpolations, and see what literal text the DOM would
    // actually contain. Anything but the switch caption is a chrome row.
    const text = literalTextOf(markupOf(BODY));
    expect(
      text,
      'the only text beside the board must be the SCREEN switch caption — a LIVES pill, '
        + 'a T readout or a state word here is the refused hero-readout shape',
    ).toBe('SCREEN');
  });

  it('NEGATIVE CONTROL: the extractor can SEE an added chrome row', () => {
    // Without this the assertion above passes on an extractor that returns ''
    // for everything, which is exactly how a green blind gate looks.
    const withRow = markupOf(BODY).replace(
      '<div class="preview-wrap"',
      '<span>LIVES 5</span><div class="preview-wrap"',
    );
    const text = literalTextOf(withRow);
    expect(text).toContain('LIVES 5');
    expect(text).not.toBe('SCREEN');
  });

  it('the derived numbers reach the a11y tree ONLY, never the DOM as content', () => {
    // `ariaLabel` carries lives / level / seconds / score. It is the speakable
    // half of a painted HUD — and it must stay an ATTRIBUTE. Rendering it as
    // element content would be the resting-readout row by the back door.
    const markup = markupOf(BODY);
    expect(markup).toMatch(/aria-label=\{ariaLabel\}/);
    expect(markup).not.toMatch(/>\s*\{ariaLabel\}/);
    expect(markup).not.toMatch(/\{ariaLabel\}\s*</);
  });

  it('the board canvas is role="img" — a picture is not a range role', () => {
    expect(markupOf(BODY)).toMatch(/role="img"/);
    // …and it does NOT reach for aria-valuetext, which belongs to a range role
    // and therefore to the KNOB, not to a picture. ⚠ Scoped to the MARKUP: the
    // component's header comment names `aria-valuetext` to explain why it is
    // NOT used, and a source-wide grep would read that prose as a violation.
    expect(markupOf(BODY)).not.toMatch(/aria-valuetext/);
  });
});

describe('frogger — CLAIM 5: the VRT tick pin can actually pin', () => {
  // ⚠ THE PIN IS THE WHOLE REASON THIS MODULE COULD LEAVE `EXEMPT_FROM_VRT`,
  // whose entry named this hook as its own exit condition. A pin that never
  // fires is indistinguishable from a working one in the captured image.
  it('the stepper has NO RNG — which is what makes the pin a TICK COUNT alone', () => {
    // The load-bearing fact under the whole determinism argument, and the one
    // that would go silently false if anyone reached for randomness later.
    expect(STEPPER).not.toMatch(/Math\.random/);
    expect(STEPPER).not.toMatch(/performance\.now/);
    expect(STEPPER).not.toMatch(/Date\.now/);
  });

  it('the factory reads the pin at CONSTRUCTION *and* in the tick — both harnesses', () => {
    // The face harness installs it with `addInitScript` BEFORE goto (visible at
    // construction); the CARD scene sets it from `afterSpawn` (after
    // construction). A construction-only read would leave the card scene
    // silently unpinned, which is the dead-pin failure this leg exists for.
    const ctorAt = DEF_SRC.indexOf('const bootPin = readVrtTickPin();');
    const tickAt = DEF_SRC.indexOf('const latePin = readVrtTickPin();');
    expect(ctorAt, 'the factory must read the pin at construction').toBeGreaterThan(-1);
    expect(tickAt, 'and once more in the tick, for the after-spawn install').toBeGreaterThan(-1);
    expect(ctorAt).toBeLessThan(tickAt);
  });

  it('and it SUPPRESSES the sim rather than freezing it — the board is time-invariant', () => {
    // A freeze holds whichever frame the harness caught, and "which frame" is a
    // function of boot speed (measured on pong: 72 px across two ubuntu boots
    // WITH a seed). Running a fixed number of ticks and then never ticking
    // again removes the question instead of narrowing it.
    expect(DEF_SRC).toMatch(/if \(vrtPinned\) return;/);
    const pinReturnAt = DEF_SRC.indexOf('if (vrtPinned) return;');
    const stepAt = DEF_SRC.indexOf('state = stepFroggerState(state, inputs, params, dtSeconds);');
    expect(stepAt).toBeGreaterThan(-1);
    expect(
      pinReturnAt,
      'the pin must return BEFORE the tick steps the game, or the board drifts again',
    ).toBeLessThan(stepAt);
  });

  it('NOTHING in the app ever sets the global — it is a test-only seam', () => {
    // The pin must be unreachable from the product, or it is a shipped freeze
    // button nobody declared.
    expect(DEF_SRC).toMatch(/__froggerVrtTicks/);
    expect(DEF_SRC).not.toMatch(/__froggerVrtTicks\s*=/);
  });
});

describe('frogger — the card and the face paint ONE board at ONE scale', () => {
  // ⚠ THE BUG THIS PINS WAS LIVE AND UNCATCHABLE. `FroggerCard` passed
  // `canvasEl.width/height` — the BACKING STORE at DPR 2 — into a painter that
  // lays out in those units and then draws its HUD at an ABSOLUTE `9px`. Every
  // GRID dimension is derived from w/h so the board scaled correctly and the
  // bug hid in plain sight; only the HUD was wrong, rendering ~4.5 CSS px tall.
  // There was no pixel test at all, because frogger was EXEMPT_FROM_VRT.
  it('BOTH surfaces pass CSS px and scale the context by DPR', () => {
    for (const [name, src] of [['card', CARD], ['face body', BODY]] as const) {
      expect(src, `${name}: must scale the context`).toMatch(/setTransform\(DPR, 0, 0, DPR, 0, 0\)/);
      expect(src, `${name}: must pass CSS px, not the backing store`)
        .toMatch(/drawFrogger\(ctx2d, snap, CSS_W, CSS_H\)/);
    }
  });

  it('NEGATIVE CONTROL: neither surface passes the BACKING STORE any more', () => {
    // The exact shape of the old call. Without this leg the assertion above
    // would still pass if someone added a second, wrong `drawFrogger` call.
    for (const [name, src] of [['card', CARD], ['face body', BODY]] as const) {
      expect(src, `${name}: canvasEl.width is device px, not layout px`)
        .not.toMatch(/drawFrogger\([^)]*canvasEl\.width/);
    }
  });

  it('and they agree on the board GEOMETRY, so the two pictures are the same picture', () => {
    const dims = (src: string) => ({
      w: /const CSS_W = (\d+);/.exec(src)?.[1],
      h: /const CSS_H = (\d+);/.exec(src)?.[1],
    });
    expect(dims(BODY)).toEqual(dims(CARD));
    expect(dims(BODY).w).toBe('200');
  });
});
