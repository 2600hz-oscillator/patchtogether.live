// packages/web/src/lib/ui/modules/textmarquee-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the TEXTMARQUEE faceplate (2026-08-31).
//
// Everything here is a claim the shipped face MAKES and that no pixel gate can
// check. Each block says what it would look like if it were wrong.
//
// ⚠ THE SHARPEST LEG IN THIS FILE IS THE PARITY ONE, and it is the check the
// face program's own risk register says would have caught most of its misses:
// enumerate every `data-testid` on the legacy card and diff it against
// (ranked params ∪ control families ∪ the body's own testids). For this module
// the leftover is THIRTEEN of fifteen and every one of them is the model
// writer — a live DOM Selection, three colour inputs, a twelve-entry `<select>`
// and the `contenteditable` itself. None is expressible as a face cell, so all
// thirteen had to move into the body, and a body that quietly dropped one would
// ship a module with four working knobs and (say) no way to set the background
// ever again, with every def-reading gate green.
//
// ⚠ THE SECOND LEG IS THE ONE THAT IS NOT ABOUT LOOKS AT ALL. `serializeEditor`
// reads `getComputedStyle`, so the editor's CASCADE is part of the persisted
// document. Both surfaces must stamp `EDITOR_BASE_STYLE` on the element rather
// than inherit it, and neither may keep a private copy of the serializer. A
// source probe can see exactly that and nothing more — whether the cascade
// actually resolves the way we think on a real page is a browser fact, covered
// by the default-shell leg of `e2e/tests/textmarquee-face-editor.spec.ts`.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { textmarqueeDef } from '$lib/video/modules/textmarquee';
import {
  TEXTMARQUEE_DEFAULTS,
} from '$lib/video/modules/textmarquee';
import { scrollOffset } from '$lib/video/modules/textmarquee-layout';
import { curatedFace, dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { shellExtensionIds } from '$lib/ui/workflow/shell-extensions';
import { EDITOR_BASE_STYLE } from '$lib/graph/textmarquee-editor';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';

const def = textmarqueeDef as unknown as FaceDefLike & { type: string };
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * ⚠ EVERY SOURCE PROBE HERE READS COMMENT-STRIPPED TEXT, and it is not hygiene
 * — it is the only way the probes can be true. Both files' headers EXPLAIN the
 * hazards they must avoid (they name `getComputedStyle`, they quote the
 * `#eef1f5` the body must never write, they say "never `getContext('webgl')`"),
 * so a raw grep would read the warning as the offence. The negative controls
 * below are what keep the stripping from hiding a real offence instead.
 */
function src(rel: string): string {
  return stripSourceComments(readFileSync(resolve(HERE, rel), 'utf8'));
}
const bodySrc = () => src('textmarquee/TextmarqueeEditorBody.svelte');

/** Every `data-testid` literal in a source file. */
function testids(source: string): string[] {
  return [...source.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!).sort();
}

describe('textmarquee face — promoted, and the tile shows the module', () => {
  it('is promoted and declares a face', () => {
    expect(STRICT_FACES.has('textmarquee')).toBe(true);
    expect(def.face).toBeTruthy();
  });

  it("declares glyph 'none' — and here the literal is MECHANICALLY FORCED", () => {
    expect(def.face?.glyph).toBe('none');
    // The forcing: ONE output and it is video, so there is no analyser tap for
    // any live binding to attach to.
    expect(primaryAudioOutPortId(textmarqueeDef)).toBeNull();
    expect(textmarqueeDef.outputs.map((o) => o.type)).toEqual(['video']);
    // …and the tile's picture comes from the OTHER seam, which is what makes
    // 'none' costless. This is textmarquee's FIRST lane picture: the card only
    // ever painted its preview inside itself.
    expect(hasVideoSurface(def)).toBe(true);
  });

  it('NEGATIVE CONTROL: every OTHER glyph literal on this def is a DEAD static', () => {
    // Which is what `module-face-lint`'s dead-glyph clause refuses — so `'none'`
    // is not a taste call that could drift, it is the only literal that compiles
    // past the gate. If a future edit added an audio output this leg goes red
    // and the choice becomes real again.
    for (const glyph of ['scope', 'meter', 'envelope', 'waveform'] as const) {
      const probe = { ...textmarqueeDef, face: { ...def.face, glyph } };
      expect(
        glyphBinding(probe as never).kind,
        `glyph '${glyph}' would resolve to a live binding`,
      ).toBe('static');
    }
  });

  it('owns a fullViewBody extension whose id the glob actually discovered', () => {
    expect(def.face?.extension).toBe('textmarquee');
    expect(shellExtensionIds()).toContain('textmarquee');
  });
});

describe('textmarquee face — four knobs, one band, no rail', () => {
  const keysAt = (t: 'mini' | 'compact' | 'full' | 'dock') =>
    curatedFace(def, t)!.controls.map((c) => c.key);

  it('ranks POSITION first, because SCROLL does nothing at its defaults', () => {
    expect(def.face?.order).toEqual(['posX', 'posY', 'scrollX', 'scrollY']);
  });

  it('⚠ the ranking argument is MEASURED, not asserted: scroll is inert at rest', () => {
    // `scrollOffset` opens with `vel = (knob - 0.5) * 2 * MAX * span` and then
    // `if (vel === 0) return 0`. Both defaults are exactly 0.5, and 0.5 - 0.5
    // is exact in IEEE-754, so the SCRL knobs contribute nothing until moved —
    // which is also this face's whole VRT determinism argument.
    expect(TEXTMARQUEE_DEFAULTS.scrollX).toBe(0.5);
    expect(TEXTMARQUEE_DEFAULTS.scrollY).toBe(0.5);
    for (const t of [0, 0.5, 1, 10, 1e6]) {
      expect(scrollOffset(TEXTMARQUEE_DEFAULTS.scrollX, t, 1024, 512)).toBe(0);
    }
    // NEGATIVE CONTROL: the probe can move, so the zeros above mean something.
    expect(scrollOffset(0.9, 1, 1024, 512)).not.toBe(0);
  });

  it('⚠ the LANE TIERS TRUNCATE, and this is where the ranking is spent', () => {
    // `module-face-lint` denies a face that ranks controls the lane then drops
    // ENTIRELY; four ordinary knobs cannot hit that. But the tiers still budget
    // by width, so the ranking decides WHICH two survive on a 192 px tile — and
    // POSITION winning is the whole reason the order is what it is. A player
    // who has just typed a word and cannot see it needs PosX/PosY; the two SCRL
    // knobs are inert at their defaults (leg above) and the def's own docs
    // reach for an LFO rather than a hand for them.
    //
    // Recorded as an exact ladder rather than a ">= 1" so that a platform
    // change to the tier budget shows up here as a face-visible consequence
    // instead of silently reshaping this module's lane tile.
    expect(keysAt('mini')).toEqual(['posX']);
    expect(keysAt('compact')).toEqual(['posX', 'posY']);
    expect(keysAt('full')).toEqual(['posX', 'posY', 'scrollX']);
    expect(keysAt('dock')).toEqual(['posX', 'posY', 'scrollX', 'scrollY']);
  });

  it('⚠ declares NO xyPads, and the refusal is the interesting one', () => {
    // posX/posY are a textbook pad pair — continuous, 0..1, one gesture. A pad
    // is DOCK-ONLY and costs no lane rank, so declaring one would fold posY
    // into posX and halve what the LANE paints, to buy a gesture for the one
    // pair the def's own docs calibrate for an LFO sweep. The card draws four
    // dials; the face draws four dials.
    expect(def.face?.xyPads).toBeUndefined();
    expect(def.face?.paramCells).toBeUndefined();
  });

  it('renders exactly the one authored band, and no tab rail', () => {
    const bands = dockFacePlan(def)!;
    expect(bands.map((b) => b.id)).toEqual(['ribbon']);
    expect(bands[0]!.controls.map((c) => c.key)).toEqual([
      'posX', 'posY', 'scrollX', 'scrollY',
    ]);
    // DOCK_TAB_MIN_BANDS is 7. One band is not padded toward it.
    expect(bands.length).toBeLessThan(7);
  });

  it('face completeness: every declared param is ranked exactly once', () => {
    const order = def.face?.order ?? [];
    expect([...order].sort()).toEqual(textmarqueeDef.params.map((p) => p.id).sort());
    expect(new Set(order).size).toBe(order.length);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE PARITY DIFF, AS A GATE
// ────────────────────────────────────────────────────────────────────────────

describe('⚠ textmarquee — the STOP-2 surface, pinned on the face', () => {
  /**
   * THE THIRTEEN AFFORDANCES THAT HAD TO SURVIVE PROMOTION.
   *
   * ⚠ THIS TABLE USED TO BE DERIVED FROM `TextmarqueeCard.svelte`, AND THAT IS
   * WHY IT IS WRITTEN OUT HERE. The original three legs read the card's fifteen
   * testids, subtracted the two that are shell chrome after promotion (the
   * card's own plate, which ModuleShell IS; and its preview canvas, which the
   * body renames to the fleet-convention `textmarquee-face-canvas`), and
   * required every one of the remaining thirteen to be declared BY THE BODY —
   * because textmarquee declares four params and NO control families, so not
   * one of these corresponds to a ranked control and the entire remainder is
   * component-only behaviour a promotion can silently delete.
   *
   * The card is gone, so the diff cannot be computed any more. What it was
   * protecting is not: each of these thirteen is a capability, and a future
   * edit that drops one from the body is exactly the loss the diff existed to
   * catch. So the DERIVED list becomes a WRITTEN one, once, at the moment the
   * derivation stops being possible — with the vacuity guard that made the
   * original honest kept in the same shape (the body's inventory is read, not
   * assumed) and its direction inverted: the body must contain all thirteen.
   */
  const CARD_ERA_AFFORDANCES = [
    'textmarquee-align-center',
    'textmarquee-align-left',
    'textmarquee-align-right',
    'textmarquee-bg',
    'textmarquee-bold',
    'textmarquee-editor',
    'textmarquee-empty',
    'textmarquee-font',
    'textmarquee-italic',
    'textmarquee-run-color',
    'textmarquee-size',
    'textmarquee-toolbar',
    'textmarquee-underline',
  ] as const;

  it('the thirteen are exactly the affordances that are NOT ranked controls', () => {
    // The diff's denominator, kept: textmarquee declares four params and no
    // control families, and not one of these thirteen corresponds to either —
    // which is what made them STOP-2 subjects rather than cells.
    const ranked = new Set(def.face?.order ?? []);
    expect(ranked.size).toBe(4);
    expect((textmarqueeDef as { controlFamilies?: unknown }).controlFamilies).toBeUndefined();
    expect(CARD_ERA_AFFORDANCES.length).toBe(13);
    for (const t of CARD_ERA_AFFORDANCES) {
      const asParam = t.replace(/^textmarquee-/, '');
      expect(ranked.has(asParam), `${t} is not a ranked param`).toBe(false);
    }
  });

  it('every one of them is declared BY THE BODY, verbatim', () => {
    const onBody = new Set(testids(bodySrc()));
    // Vacuity guard first: a body whose testids stopped resolving would make
    // the missing list empty for the wrong reason.
    expect(onBody.size, 'the body declares no testids at all').toBeGreaterThan(0);
    const missing = CARD_ERA_AFFORDANCES.filter((t) => !onBody.has(t));
    expect(
      missing,
      'these affordances have no home on the promoted surface — each one listed here is a ' +
        'capability a player permanently loses',
    ).toEqual([]);
  });

  it('the body ALSO declares the two fleet-convention names the switch needs', () => {
    const onBody = new Set(testids(bodySrc()));
    expect(onBody.has('textmarquee-face-canvas')).toBe(true);
    expect(onBody.has('textmarquee-face-screen-toggle')).toBe(true);
    // `face-screen-render-suite.ts` derives `<prefix>-face-canvas` from the
    // declared prefix, so a rename here silently drops that subject's coverage.
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE SERIALIZER — one copy, explicit styles
// ────────────────────────────────────────────────────────────────────────────

describe('⚠ textmarquee — the editor cascade is DATA, and the surface says so', () => {
  it('the surface stamps the explicit style contract on the element', () => {
    for (const [name, s] of [['body', bodySrc()] as const]) {
      expect(
        s.includes('applyEditorBaseStyle'),
        `${name} never stamps EDITOR_BASE_STYLE — every untouched run will serialize whatever ` +
          'the surrounding cascade resolved to',
      ).toBe(true);
    }
  });

  it('it keeps NO private serializer', () => {
    for (const [name, s] of [['body', bodySrc()] as const]) {
      expect(
        s.includes('getComputedStyle'),
        `${name} reads getComputedStyle directly — the serializer is shared for a reason`,
      ).toBe(false);
      expect(s.includes('$lib/graph/textmarquee-editor')).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the probes can fail', () => {
    // A body-shaped string with neither property must fail both clauses, so a
    // green run above is evidence rather than a matcher that cannot move.
    const fake = '<script>const x = 1;</script><div contenteditable></div>';
    expect(fake.includes('applyEditorBaseStyle')).toBe(false);
    expect(fake.includes('$lib/graph/textmarquee-editor')).toBe(false);
    // …and a source that DID read the cascade itself trips the second clause.
    expect('const cs = getComputedStyle(el);'.includes('getComputedStyle')).toBe(true);
  });

  it('the contract still covers the colour the card has always persisted', () => {
    // If this drifts, every saved rack silently changes colour the first time
    // anyone types into it.
    expect(EDITOR_BASE_STYLE.color).toBe('#ffffff');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCREEN ON / OFF
// ────────────────────────────────────────────────────────────────────────────

describe('⚠ textmarquee — SCREEN OFF stops the COPY, never the producer', () => {
  it('the body reads, writes and exposes a button for `previewCollapsed`', () => {
    const s = bodySrc();
    expect(s.includes('previewCollapsed')).toBe(true);
    expect(/\.data\.previewCollapsed\s*=/.test(s)).toBe(true);
    expect(/<button/.test(s)).toBe(true);
  });

  it('the collapsed branch RENEWS the watch mark', () => {
    // ⚠ THE WHOLE POINT. `blitOutputForPreview` IS the engine's "someone is
    // watching" signal, and textmarquee is a SOURCE — a collapsed state that
    // merely stopped blitting would drop the node out of the pull set and mute
    // the generator every downstream node samples. Proximity, on
    // whitespace-collapsed CODE (stripping leaves comment bytes as spaces, so
    // the window has to be measured between real statements).
    const code = bodySrc().replace(/\s+/g, ' ');
    const branch = code.indexOf('if (previewCollapsed)');
    const mark = code.indexOf('markWatched', branch);
    expect(branch, 'no collapsed branch in the body').toBeGreaterThan(-1);
    expect(mark, 'markWatched is not inside the collapsed branch').toBeGreaterThan(branch);
    expect(mark - branch).toBeLessThan(400);
  });

  it('⚠ the body flushes its pending debounced write on UNMOUNT', () => {
    // ⚠ THIS LEG EXISTS BECAUSE E2E CANNOT ISOLATE IT. Two seams protect the
    // pending write — `onblur` → `flushPersist()` and `onDestroy` →
    // `flushPersist()` — and any gesture that closes the dock moves focus out
    // of the `contenteditable` first, so the blur always fires before the
    // unmount and a body with NO onDestroy flush still passes the browser leg.
    // (`textmarquee-face-editor.spec.ts` records the measurement: `Escape`
    // typed into the focused editor does not tear the pane down, so there is no
    // focus-preserving gesture to reach for.) The dock LRU-evicts a pane at the
    // third expand, so the unmount path is ordinary rather than rare — it needs
    // an assertion somewhere, and this is the only place one can live.
    const code = bodySrc().replace(/\s+/g, ' ');
    const destroy = code.indexOf('onDestroy(');
    expect(destroy, 'the body registers no onDestroy at all').toBeGreaterThan(-1);
    const flush = code.indexOf('flushPersist', destroy);
    expect(flush, 'onDestroy does not flush the pending write').toBeGreaterThan(destroy);
    expect(flush - destroy).toBeLessThan(200);
  });

  // ⚠ 'the LEGACY CARD honours the same key, and marks too' STOOD HERE. Two
  // surfaces reading one persisted node key must agree about it, or switching
  // SCREEN off on the faceplate and then opening the other surface brings the
  // picture back. One surface cannot disagree with itself.
});

// ────────────────────────────────────────────────────────────────────────────
// RANGES
// ────────────────────────────────────────────────────────────────────────────

describe('textmarquee — no surface re-types a bound', () => {
  // ⚠ 'the card binds every knob through paramSpec, not a literal' STOOD HERE.
  // It was the module-local form of the range rule: a def-reading gate cannot
  // see a surface that widens what the contract allows, so the surface had to
  // be read. The shell renders these four straight off the ParamDef, so there
  // is no second bound to re-type — and the def half of the pair, which is what
  // the face actually resolves against, is kept below.

  it('and the def is still the 0..1 linear four this face was built on', () => {
    for (const id of ['posX', 'posY', 'scrollX', 'scrollY']) {
      const p = textmarqueeDef.params.find((x) => x.id === id)!;
      expect(p.min).toBe(0);
      expect(p.max).toBe(1);
      expect(p.curve).toBe('linear');
      expect(p.defaultValue).toBe(0.5);
    }
  });
});
