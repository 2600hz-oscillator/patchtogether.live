// packages/web/src/lib/ui/modules/skifree-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the SKIFREE faceplate.
//
// ⚠ THIS FILE IS LOAD-BEARING IN A WAY MOST FACE-MODEL TESTS ARE NOT, and the
// reason is a gap rather than a preference. skifree declares `params: []` and
// therefore `face.order: []`, and #1974's zero-lane clause — the one thing in
// CI that asks "does a promoted lane tile paint anything?" — SKIPS a face that
// ranks nothing, by construction and correctly (`flipper` and `videoOut` are
// the honest cases it was written to let through). So if `tileBody` were
// deleted, renamed, or quietly stopped being wired, skifree's lane tile would
// regress to a title bar and four jacks and EVERY GATE IN THE REPO WOULD STAY
// GREEN. There is also no VRT baseline to contradict it: this face carries a
// named `FACES_WITHOUT_SCENES` entry, because the game is a committed
// third-party IIFE running its own rAF and its own RNG.
//
// The claims this face rests on, none of which a shared gate can check:
//
//   1. BOTH extension slots exist and are wired — the lane tile has a picture
//      and the dock has a steerable one.
//   2. `glyph: 'none'` is FORCED, measured through the real resolver.
//   3. THE BLIT IS A SCALE. The card's three-argument `drawImage` painted the
//      TOP-LEFT QUADRANT on any DPR >= 2 display, and no gate in this repo can
//      see it (Playwright and VRT both run at `deviceScaleFactor: 1`).
//   4. THE SURFACES OWN THE MOUSE. `controller.enableMouse` takes its rect from
//      the FACTORY's DETACHED canvas — all zeros since #2192 — so it fed raw
//      viewport pixels into a 0..320 space. Nothing may call it again.
//   5. THE CURSOR WRITE SITS ABOVE THE `previewCollapsed` BRANCH, because
//      `player.isMoving` latches only through `setCursor`.
//   6. The face adds NO resting numbers of its own — the card's
//      `{distance}m · lives {n} · CV|MOUSE|IDLE · GAME OVER` row is DELETED.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripSourceCommentsWithReport } from '$lib/source-guards/strip-source-comments';
import { skifreeDef } from '$lib/audio/modules/skifree';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { curatedFace, FACE_TIER_CAPS, type FaceTier } from '$lib/ui/workflow/curated-face';
import {
  shellExtensionIds,
  WIRED_SHELL_EXTENSION_SLOTS,
} from '$lib/ui/workflow/shell-extensions';

/** Every tier the shell can render, DERIVED from the cap table rather than
 *  re-typed — a hand-listed ladder would silently stop covering a new tier. */
const ALL_TIERS = Object.keys(FACE_TIER_CAPS) as FaceTier[];

/** The face, unwrapped once so every case reads off the live declaration. */
const FACE = skifreeDef.face!;

/**
 * ⚠ EVERY GREP IN THIS FILE READS CODE WITH THE COMMENTS REMOVED, and it is not
 * a nicety. This face's whole story is two defects whose OLD SPELLING is quoted
 * verbatim in the headers that explain the fix — `drawImage(src, 0, 0)`,
 * `enableMouse`, `e.clientX - rect.left`. On its first run this file flagged
 * five of its own explanations as offences, which is the exact shape
 * `strip-source-comments.ts` was extracted for (three prior gates, three
 * one-off regexes, all wrong). The stripper replaces comment bytes with
 * whitespace, so offsets survive and the source-ORDER legs below still mean
 * what they say.
 */
function code(src: string): string {
  const { text, report } = stripSourceCommentsWithReport(src);
  // NON-VACUITY, per read: a stripper that silently returned its input would
  // make every negative control below pass for the wrong reason on a file whose
  // comments quote the defect.
  expect(
    report.line + report.block + report.html,
    'the comment stripper removed nothing — either this file lost its headers or the '
      + 'stripper is a no-op, and both make the negative controls vacuous',
  ).toBeGreaterThan(0);
  return text;
}

const EXT = code(readFileSync(new URL('./skifree/shell-extension.ts', import.meta.url), 'utf8'));
const SCREEN = code(readFileSync(new URL('./skifree/SkifreeScreen.svelte', import.meta.url), 'utf8'));
const SLOPE = code(readFileSync(new URL('./skifree/SkifreeSlopeBody.svelte', import.meta.url), 'utf8'));
const TILE = code(readFileSync(new URL('./skifree/SkifreeTileBody.svelte', import.meta.url), 'utf8'));
const CARD = code(readFileSync(new URL('./SkifreeCard.svelte', import.meta.url), 'utf8'));
const DEF_SRC = code(readFileSync(new URL('../../audio/modules/skifree.ts', import.meta.url), 'utf8'));
const EMBED = code(readFileSync(
  new URL('../../../../native/skifree/embed.js', import.meta.url),
  'utf8',
));

/** Everything between `</script>` and `<style>` — the rendered DOM, as source. */
function markupOf(svelte: string): string {
  const start = svelte.indexOf('</script>');
  const end = svelte.lastIndexOf('<style>');
  expect(start, 'the component must have a script block').toBeGreaterThan(-1);
  return svelte.slice(start + '</script>'.length, end === -1 ? undefined : end);
}

/**
 * The LITERAL TEXT the body's DOM would contain — tags, markup comments and
 * Svelte interpolations removed. Comments are stripped FIRST because a markup
 * comment can contain a `>` that would split a naive tag match part-way through
 * and leak prose into the result (the FroggerBoardBody finding).
 */
function literalTextOf(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, ' ')  // markup comments — never rendered
    .replace(/<[^>]*>/g, ' ')           // element tags + their attributes
    .replace(/\{[^{}]*\}/g, ' ')        // svelte interpolations + blocks
    .replace(/\s+/g, ' ')
    .trim();
}

describe('skifree — the face is promoted, and it is the FLIPPER shape', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('skifree')).toBe(true);
    expect(migrated('skifree')).toBe(true);
  });

  it('ranks NOTHING, because there is nothing to rank — `params: []`', () => {
    expect(skifreeDef.params).toEqual([]);
    expect(FACE.order).toEqual([]);
    // And no pages either: a band over zero controls is a band too many.
    expect(FACE.pages ?? []).toEqual([]);
  });

  it('so EVERY tier resolves zero cells — the honest rendering of a zero-param module', () => {
    expect(ALL_TIERS.length, 'the ladder must cover every declared tier').toBeGreaterThan(1);
    for (const tier of ALL_TIERS) {
      expect(
        curatedFace(skifreeDef, tier)?.controls.length ?? 0,
        `tier ${tier}: a module with no params must resolve no cells`,
      ).toBe(0);
    }
  });
});

describe('skifree — CLAIM 1: BOTH extension slots, and the LANE one is unwatched', () => {
  // ⚠ THE WHOLE REASON THIS FILE EXISTS. #1974's zero-lane clause reads
  // `if ((def.face?.order?.length ?? 0) === 0) continue;` — so it skips this
  // face BEFORE it measures anything, and it is right to (that exclusion is
  // what lets `flipper` and `videoOut` through). The consequence is that
  // nothing else in CI can tell a skifree lane tile with a slope on it from one
  // that is a title bar and a jack rail.
  it('the face declares the extension that carries the slope', () => {
    expect(FACE.extension).toBe('skifree');
    expect(shellExtensionIds()).toContain('skifree');
  });

  it('⚠ the extension fills `tileBody` — the LANE picture nothing else pins', () => {
    expect(EXT).toMatch(/tileBody:\s*SkifreeTileBody/);
    expect(EXT).toMatch(/import SkifreeTileBody from '\.\/SkifreeTileBody\.svelte'/);
    // …and the slot is actually RENDERED by the shell, not merely declared. An
    // unwired slot is a silent no-op, which is the failure this pairs against.
    expect(WIRED_SHELL_EXTENSION_SLOTS).toContain('tileBody');
  });

  it('and `fullViewBody` — the DOCK picture, which is also the only control surface', () => {
    expect(EXT).toMatch(/fullViewBody:\s*SkifreeSlopeBody/);
    expect(WIRED_SHELL_EXTENSION_SLOTS).toContain('fullViewBody');
  });

  it('#1974 GENUINELY SKIPS this face — recorded so the pin above is not redundant-looking', () => {
    // If a rank is ever added to this face, the shared clause starts covering
    // the lane and this file's justification changes. Asserting the premise
    // makes that a red test rather than a silent shift in who is watching.
    expect(
      (FACE.order?.length ?? 0) === 0,
      'the zero-lane clause `continue`s on a face that ranks nothing, so the shared gate is '
        + 'not watching this lane and the tileBody pin above is the only thing that is',
    ).toBe(true);
  });

  it('the two bodies NAMESPACE their testids — they can be mounted at the same time', () => {
    // A faced module's lane tile and its open dock pane coexist. Sharing a
    // testid would put two elements behind every selector in the face specs.
    expect(SLOPE).toMatch(/testidPrefix="skifree-face"/);
    expect(TILE).toMatch(/testidPrefix="skifree-tile"/);
  });

  it('the TILE is read-only and the DOCK steers — one cursor, one writer', () => {
    expect(SLOPE, 'the dock body must arm the pointer path').toMatch(/\bsteerable\b/);
    expect(TILE, 'the lane tile must NOT steer').not.toMatch(/\bsteerable\b/);
    // The SCREEN switch is likewise dock-only (the 192x180 slot has no room),
    // and the tile HONOURS the same node.data flag.
    expect(SLOPE).toMatch(/\bscreenToggle\b/);
    expect(TILE).not.toMatch(/\bscreenToggle\b/);
  });

  it('ONE surface component serves both, so the two pictures cannot diverge', () => {
    for (const [name, src] of [['dock body', SLOPE], ['lane tile', TILE]] as const) {
      expect(src, `${name}: must mount the shared screen`)
        .toMatch(/import SkifreeScreen from '\.\/SkifreeScreen\.svelte'/);
      expect(src, `${name}: must not draw for itself`).not.toMatch(/drawImage\(/);
    }
  });
});

describe('skifree — CLAIM 2: `glyph: none` is FORCED, and that is measured', () => {
  it('there is NO primary audio output — the outputs are a gate and a video port', () => {
    expect(skifreeDef.outputs.map((o) => o.type).sort()).toEqual(['gate', 'video']);
    expect(primaryAudioOutPortId(skifreeDef)).toBeNull();
  });

  it('and the shell\'s own video thumbnail is out of reach — this is an AUDIO def', () => {
    // `hasVideoSurface` is `domain === 'video'`. A video PORT is not a video
    // DOMAIN, which is precisely the trap that makes "it has a picture already"
    // the wrong conclusion here.
    expect(skifreeDef.domain).toBe('audio');
    expect(hasVideoSurface(skifreeDef)).toBe(false);
    // POSITIVE CONTROL: the predicate can be true, so the leg above is not
    // passing on a function that returns false for everything.
    expect(hasVideoSurface({ domain: 'video' })).toBe(true);
  });

  it('so every LIVE glyph kind resolves STATIC and is refused by the dead-glyph clause', () => {
    for (const kind of ['scope', 'meter', 'envelope', 'waveform'] as const) {
      const bound = glyphBinding({ ...skifreeDef, face: { ...FACE, glyph: kind } });
      expect(bound.kind, `glyph '${kind}' must resolve static on a gate+video def`).toBe('static');
    }
  });

  it('and the face declares none, so the tile picture MUST come from the module', () => {
    expect(FACE.glyph).toBe('none');
    expect(laneGlyphFor(skifreeDef)).toBe('none');
  });
});

describe('skifree — CLAIM 3: the blit is a SCALE, and the 3-arg form was a CROP', () => {
  // ⚠ A LIVE, SHIPPING DEFECT, FIXED IN THE PROMOTING DIFF AND PINNED HERE
  // BECAUSE NOTHING ELSE CAN SEE IT. `SkiFree.create()` overwrites the canvas
  // it is handed — `canvas.width = Math.round(width * dpr)` — so the source is
  // 640x640 on any DPR >= 2 display while the destination was 320x320, and
  // `drawImage(src, 0, 0)` paints the source at NATIVE size: the player saw the
  // TOP-LEFT QUADRANT with the skier in the corner. Playwright and VRT both run
  // at `deviceScaleFactor: 1`, where the numbers coincide and the bug does not
  // exist, so no runtime gate in this repo can reach it.
  it('the SOURCE canvas really is DPR-scaled by the vendored bundle', () => {
    // The premise the whole claim rests on, read from the vendored source
    // rather than remembered.
    expect(EMBED).toMatch(/canvas\.width\s*=\s*Math\.round\(width \* dpr\)/);
    expect(EMBED).toMatch(/dpr = \(typeof window !== 'undefined' && window\.devicePixelRatio\)/);
  });

  it('BOTH surfaces name a destination rect DERIVED FROM THE SOURCE', () => {
    for (const [name, src] of [['card', CARD], ['face screen', SCREEN]] as const) {
      expect(src, `${name}: the destination must be named, not assumed`)
        .toMatch(/drawImage\(\s*src,\s*0,\s*0,\s*src\.width,\s*src\.height,\s*0,\s*0,\s*dst\.width,\s*dst\.height\s*\)/);
      expect(src, `${name}: pixel art must never be box-filtered`)
        .toMatch(/imageSmoothingEnabled = false/);
    }
  });

  it('NEGATIVE CONTROL: neither surface still makes the CROPPING call', () => {
    // The exact shape of the old one. Without this leg the assertion above
    // would pass if someone added a second, wrong `drawImage` beside the right.
    for (const [name, src] of [['card', CARD], ['face screen', SCREEN]] as const) {
      expect(src, `${name}: the 3-argument form paints the source at NATIVE size`)
        .not.toMatch(/drawImage\(\s*src,\s*0,\s*0\s*\)/);
    }
  });

  it('and the destination is NOT re-derived from SKIFREE_CANVAS_SIZE', () => {
    // The source size is the BUNDLE's to choose. Deriving the rect from our own
    // constant is the same false premise the old comment made, one layer down.
    expect(SCREEN).not.toMatch(/drawImage\([^)]*SKIFREE_CANVAS_SIZE/);
    expect(CARD).not.toMatch(/drawImage\([^)]*SKIFREE_CANVAS_SIZE/);
  });
});

describe('skifree — CLAIM 4: the surfaces own the MOUSE, and enableMouse is dead', () => {
  // ⚠ THE SECOND SHIPPING DEFECT. `enableMouse(el)` attaches its listeners to
  // `el` but computes `canvas.getBoundingClientRect()` against the FACTORY's
  // canvas — which #2192 made detached BY DESIGN — so every field is 0 and
  // `e.clientX - rect.left` is the identity. The cursor received raw VIEWPORT
  // coordinates in a 0..320 space and the skier pinned itself to an edge.
  it('the vendored handler really does read the DETACHED canvas\'s rect', () => {
    // The bug, at the site: the listener target is `mouseTarget`/`el`, the rect
    // is `canvas`. Two different elements.
    expect(EMBED).toMatch(/const rect = canvas\.getBoundingClientRect\(\);/);
    expect(EMBED).toMatch(/mouseTarget\.addEventListener\('mousemove', onMouseMove\)/);
    // …and the factory's canvas is never appended to the document.
    expect(DEF_SRC).toMatch(/document\.createElement\('canvas'\)/);
    expect(DEF_SRC, 'the game canvas must stay detached').not.toMatch(/appendChild\(gameCanvas\)/);
  });

  it('NO SURFACE CALLS IT ANY MORE — neither the card nor the face', () => {
    for (const [name, src] of [['card', CARD], ['face screen', SCREEN]] as const) {
      expect(src, `${name}: enableMouse steers from a zero rect`).not.toMatch(/\.enableMouse\(/);
      expect(src, `${name}: and there is nothing left to disable`).not.toMatch(/\.disableMouse\(/);
    }
  });

  it('both map their OWN element\'s rect through the def\'s pure helper', () => {
    for (const [name, src] of [['card', CARD], ['face screen', SCREEN]] as const) {
      expect(src, `${name}: must import the shared map`).toMatch(/pointerToCanvasCoord/);
      expect(src, `${name}: must measure the element it is drawn on`)
        .toMatch(/el\.getBoundingClientRect\(\)/);
      expect(src, `${name}: must write the cursor itself`).toMatch(/\.setCursor\(/);
    }
    // ⚠ AND THE OLD ARITHMETIC IS GONE, not merely unused: a bare
    // `clientX - rect.left` anywhere here would be the defect re-typed by hand.
    for (const [name, src] of [['card', CARD], ['face screen', SCREEN]] as const) {
      expect(src, `${name}: a raw offset is the bug, whoever writes it`)
        .not.toMatch(/clientX\s*-\s*\w*[Rr]ect/);
    }
  });

  it('CV OVERRIDES THE MOUSE on both surfaces', () => {
    // The face reads the NODE's own snapshot; the card reads the bridge flag it
    // already owned. Same value — `tickFn` assigns both from one local — but
    // the face has no reason to reach for a single un-keyed global.
    expect(SCREEN).toMatch(/if \(!steerable \|\| cvDriven\) return;/);
    expect(SCREEN).toMatch(/snapshot\?\.cvDriven === true/);
    expect(CARD).toMatch(/return focused && !ensureBridge\(\)\.cvDriven;/);
  });
});

describe('skifree — CLAIM 5: SCREEN OFF stops the PICTURE, never the game', () => {
  it('the game is created in the FACTORY, so no surface owns its lifetime', () => {
    expect(DEF_SRC).toMatch(/SkiFree\.create\(\{/);
    expect(DEF_SRC).toMatch(/getSchedulerClock\(\)\.subscribe\(tickFn\)/);
    for (const [name, src] of [['face screen', SCREEN], ['card', CARD]] as const) {
      expect(src, `${name}: a surface must never build the game`).not.toMatch(/SkiFree\.create/);
    }
  });

  it('the collapse gates the DRAW ONLY — never an early return above the engine read', () => {
    const readAt = SCREEN.indexOf("eng.read(node, 'snapshot')");
    expect(readAt).toBeGreaterThan(-1);
    const before = SCREEN.slice(0, readAt);
    expect(
      /if\s*\(\s*previewCollapsed\s*\)\s*return/.test(before),
      'an early return on previewCollapsed ABOVE the read would stop the accessible name '
        + 'tracking the game, and is one refactor away from stopping the module',
    ).toBe(false);
    expect(SCREEN).toMatch(/!previewCollapsed && canvasEl/);
  });

  it('⚠ AND THE CURSOR WRITE SITS ABOVE THE COLLAPSE BRANCH — the play kill-switch trap', () => {
    // `player.isMoving` latches ONLY through `setCursor` (embed.js:
    // `startMovingIfPossible()` inside it), so a write path routed through the
    // paint would make SCREEN OFF stop the skier on an unpatched rack — a
    // different thing entirely from the producer kill switch it is not.
    const writeAt = SCREEN.indexOf('function writeCursor(');
    const setCursorAt = SCREEN.indexOf('ctl.setCursor(');
    expect(writeAt).toBeGreaterThan(-1);
    expect(setCursorAt).toBeGreaterThan(writeAt);
    const fn = SCREEN.slice(writeAt, SCREEN.indexOf('\n  }', setCursorAt));
    expect(
      fn,
      'writeCursor must not consult previewCollapsed at all — the picture and the cursor are '
        + 'two different questions',
    ).not.toMatch(/previewCollapsed/);
  });

  it('the switch state lives on node.data (the #1531/#1574/#1583 class)', () => {
    expect(SCREEN).toMatch(/data\?\.previewCollapsed/);
    expect(SCREEN).toMatch(/mutateNode\(/);
    // A `$state` here dies with the component, and this component unmounts on
    // dock collapse / LRU eviction.
    expect(SCREEN).not.toMatch(/let previewCollapsed = \$state/);
  });

  it('and the VIDEO port is fed by the FACTORY, not by any surface', () => {
    // `drawFrame` reads the factory's own controller, so `out` keeps carrying
    // the slope with every surface collapsed or unmounted.
    expect(DEF_SRC).toMatch(/function drawFrame\(target/);
    expect(DEF_SRC).toMatch(/const src = controller\?\.canvas;/);
  });
});

describe('skifree — CLAIM 6: the face adds NO resting numbers of its own', () => {
  // ⚠ THE CARD'S HUD ROW IS DELETED, NOT RELOCATED. `{distance}m · lives {n} ·
  // CV|MOUSE|IDLE · GAME OVER` in DOM chrome beside the canvas is a
  // measurement, a count, a state word and a status banner — none of the four
  // permitted resting-text roles. `face-resting-text-source` cannot see it
  // (body text is its own named blind spot), and there is no VRT baseline here
  // either, so this block is the whole enforcement.
  it('the shared screen renders ONLY the switch caption and two TRANSIENT overlays', () => {
    const text = literalTextOf(markupOf(SCREEN));
    expect(
      text,
      'the only literal text may be the SCREEN caption plus the loading / bundle-failure '
        + 'overlays, each of which names the surface\'s own condition and is replaced the '
        + 'moment a game exists',
    ).toBe('Bundle failed: Loading… SCREEN');
  });

  it('NEGATIVE CONTROL: the extractor can SEE the card\'s HUD row if it comes back', () => {
    const withRow = markupOf(SCREEN).replace(
      '<div class="preview-wrap"',
      '<span>280m</span><span>· lives 4</span><div class="preview-wrap"',
    );
    const text = literalTextOf(withRow);
    expect(text).toContain('280m');
    expect(text).toContain('lives 4');
    expect(text).not.toBe('Bundle failed: Loading… SCREEN');
  });

  it('the CONTROL MODE is TWO lamps with STATIC captions, never a three-way word', () => {
    // `StatusLed`'s caption is static BY CONTRACT, so `CV | MOUSE | IDLE` could
    // not be one: that is the deleted state word with a lamp drawn beside it.
    // Two static captions whose LIT state carries the answer is the primitive's
    // own form — both dark IS idle.
    expect(SCREEN).toMatch(/import \{ StatusLed \} from '\$lib\/ui\/controls'/);
    expect(SCREEN).toMatch(/caption="CV"/);
    expect(SCREEN).toMatch(/caption="MOUSE"/);
    expect(SCREEN, 'a caption computed from state is the refused shape')
      .not.toMatch(/caption=\{/);
  });

  it('the measurements reach the a11y tree ONLY, never the DOM as content', () => {
    const markup = markupOf(SCREEN);
    expect(markup).toMatch(/aria-label=\{ariaLabel\}/);
    expect(markup).not.toMatch(/>\s*\{ariaLabel\}/);
    expect(markup).not.toMatch(/\{ariaLabel\}\s*</);
    // The distance and lives are in that label, and nowhere else in the DOM.
    expect(SCREEN).toMatch(/metres, \$\{s\.lives\} lives/);
  });

  it('the steerable frame is role="application" and takes NO tabindex', () => {
    // A pointer surface that owns its own handling is exactly what
    // `application` is for. ⚠ NO `tabindex`: Tab is the faceplate FLIP gesture,
    // and there is no keyboard steering to expose — which is also why the
    // card's focus gate could not simply be ported to the face.
    const markup = markupOf(SCREEN);
    expect(markup).toMatch(/role="application"/);
    expect(markup).toMatch(/role="img"/);
    expect(markup, 'a tab stop inside the plate would compete with the flip gesture')
      .not.toMatch(/tabindex=/);
  });
});
