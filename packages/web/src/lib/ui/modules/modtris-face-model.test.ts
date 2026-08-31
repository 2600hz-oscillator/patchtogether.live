// packages/web/src/lib/ui/modules/modtris-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the MODTRIS faceplate.
//
// This face rests on six claims that no shared gate can check, and every one of
// them reads as true whether or not it is:
//
//   1. "The well survives promotion." The picture was painted by a LEGACY CARD
//      the shipping shell does not mount. Every registry test stays green if it
//      simply disappears.
//   2. "SCREEN OFF stops the picture and NOTHING else." The strongest single
//      claim on this surface, and the one a reader is most likely to copy onto
//      a module where it is false (`skifree`, one module away in this family).
//   3. "`glyph: 'none'` is not a lazy default." It is nearly forced here — but
//      "nearly" is a measurement, and one kind does still resolve.
//   4. "The face adds no resting numbers of its own." `face-resting-text-source`
//      names its own blind spot: text drawn INTO a canvas is invisible to it,
//      and a chrome row inside a module-owned `fullViewBody` is not a
//      `ModuleFace` field either. Nothing else looks.
//   5. "The VRT pin can actually pin." A dead pin produces a perfectly plausible
//      picture — a different one on every boot. modtris needs BOTH halves (seed
//      AND ticks) and either one alone is a dead pin that looks alive.
//   6. "`levelStep` is a control worth ranking." It was ranked-shaped and INERT
//      until this diff; the rank is only honest because the ramp landed with it.
//
// ⚠ NONE OF THESE IS A KNOB-WIGGLE TEST. The ramp's own behaviour is pinned in
// `modtris-state.test.ts`, where the stepper lives and where the legs fail on
// the old code (verified: disabling the level term reddens three of them,
// including the measured drop-interval leg). What is at risk HERE is a set of
// structural claims that would go quietly false if a port type, a predicate, a
// call signature or a rank changed underneath them.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modtrisDef } from '$lib/audio/modules/modtris';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { curatedFace, FACE_TIER_CAPS, type FaceTier } from '$lib/ui/workflow/curated-face';

/** Every tier the shell can render, DERIVED from the cap table rather than
 *  re-typed — a hand-listed ladder would silently stop covering a new tier. */
const ALL_TIERS = Object.keys(FACE_TIER_CAPS) as FaceTier[];

/** The face, unwrapped once so every case reads off the live declaration. */
const FACE = modtrisDef.face!;
/** Declaration order — what a rank has to be measured AGAINST. */
const DECLARED: readonly string[] = modtrisDef.params.map((p) => p.id);

const BODY = readFileSync(new URL('./modtris/ModtrisWellBody.svelte', import.meta.url), 'utf8');
const CARD = readFileSync(new URL('./ModtrisCard.svelte', import.meta.url), 'utf8');
const STEPPER = readFileSync(
  new URL('../../audio/modules/modtris-state.ts', import.meta.url),
  'utf8',
);
const DEF_SRC = readFileSync(new URL('../../audio/modules/modtris.ts', import.meta.url), 'utf8');

/**
 * Source with `//` and block comments removed.
 *
 * ⚠ REQUIRED FOR EVERY NEGATIVE LEG BELOW, and `card-range-source.test.ts`
 * learned the same lesson before this file did: a comment that QUOTES the shape
 * it removed ("the card used to pass `min={30} max={240}`", "this comment used
 * to read 'unused in v1 stepper'") is indistinguishable from the shape itself to
 * a grep. Stripping first is what lets the history stay written down beside the
 * fix instead of being deleted to keep a regex green.
 */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

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
 * CLI flag), which splits a naive `<[^>]*>` tag match part-way through and leaks
 * prose into the result. That is a false POSITIVE — the safe direction — but it
 * would have made this leg impossible to keep honest, so it is handled rather
 * than worked around.
 */
function literalTextOf(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, ' ')  // markup comments — never rendered
    .replace(/<[^>]*>/g, ' ')           // element tags + their attributes
    .replace(/\{[^{}]*\}/g, ' ')        // svelte interpolations + blocks
    .replace(/\s+/g, ' ')
    .trim();
}

describe('modtris — the face is promoted and complete', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('modtris')).toBe(true);
    expect(migrated('modtris')).toBe(true);
  });

  it('ranks EVERY declared param — a face that drops one silently hides a control', () => {
    expect([...FACE.order].sort()).toEqual([...DECLARED].sort());
  });

  it('declares ONE page, so the tab rail is structurally out of reach', () => {
    // DOCK_TAB_MIN_BANDS is 7. Recorded so that ADDING pages later is a
    // deliberate act with a red test, and so nobody pads bands to reach a rail.
    expect(FACE.pages).toHaveLength(1);
    expect(FACE.pages?.[0]?.controls).toEqual(['gravityBpm', 'levelStep']);
  });

  it('declares BOTH cells as FADERS, because the legacy card draws faders', () => {
    // ⚠ PARITY, NOT TASTE. Without `paramCells` the shell derives KNOBS from a
    // continuous param and a player's muscle memory for a vertical throw lands
    // on a rotary. ⚠ And note the divergence from the sibling: `frogger`
    // declares NOTHING here because `FroggerCard` draws a `<Knob>`. Each face
    // matches its OWN card; copying across the family is a parity loss nothing
    // gates.
    expect(FACE.paramCells).toEqual({ gravityBpm: 'fader', levelStep: 'fader' });
    expect(CARD.match(/<NeonFader\b/g) ?? []).toHaveLength(2);
    expect(CARD, 'the card must not have grown a Knob under a fader declaration')
      .not.toMatch(/<Knob\b/);
  });
});

describe('modtris — the TIER LADDER, derived rather than read off the caps', () => {
  // ⚠ DERIVED THROUGH `curatedFace`, NEVER FROM THE CAP CONSTANTS. Four sibling
  // faces got this wrong by reading `FACE_TIER_CAPS` directly, which is the
  // pre-reconciliation number and not what the lane actually fits.
  it('shows DROP at every tier and both controls once there is room', () => {
    expect(ALL_TIERS.length, 'the ladder must cover every declared tier').toBeGreaterThan(1);
    for (const tier of ALL_TIERS) {
      const face = curatedFace(modtrisDef, tier);
      expect(face, `tier ${tier} must resolve a face`).not.toBeNull();
      const keys = face!.controls.map((c) => c.key);
      expect(keys.length, `tier ${tier} must show at least one control`).toBeGreaterThan(0);
      expect(keys[0], `tier ${tier}: the module's TEMPO is rank 1 everywhere`).toBe('gravityBpm');
      expect(
        keys,
        `tier ${tier}: a two-param module can only ever show these two, in this order`,
      ).toEqual(['gravityBpm', 'levelStep'].slice(0, keys.length));
    }
  });

  it('the DOCK shows both, in one band, with nothing dropped', () => {
    const dock = curatedFace(modtrisDef, 'dock')!;
    expect(dock.controls).toHaveLength(DECLARED.length);
    expect(dock.pages?.map((p) => p.id)).toEqual(['fall']);
  });
});

describe('modtris — CLAIM 1: the shell has no generic route to this well', () => {
  it('the def is AUDIO-domain, which is exactly the excluded case', () => {
    expect(modtrisDef.domain).toBe('audio');
    expect(hasVideoSurface(modtrisDef)).toBe(false);
  });

  it('POSITIVE CONTROL: the same predicate IS true for a video-domain def', () => {
    // Without this leg the assertion above passes on a predicate that returns
    // false for everything — the blind-gate shape.
    expect(hasVideoSurface({ domain: 'video' })).toBe(true);
  });

  it('so the face declares the extension that carries the well to the dock', () => {
    expect(FACE.extension).toBe('modtris');
  });

  it('and the body IMPORTS the def\'s painter rather than re-implementing it', () => {
    // Two painters for one picture is two things that can diverge with nothing
    // able to notice. `drawModtris` is already a pure exported function.
    expect(BODY).toMatch(/import \{[^}]*drawModtris/);
    expect(BODY).toMatch(/drawModtris\(/);
    // NEGATIVE CONTROL on the shape: the body must not carry its own cell
    // geometry. If it ever draws the well itself, this is what says so.
    expect(BODY).not.toMatch(/fillRect\(/);
  });

  it('the body stays 2-D, which is what keeps modtris OUT of the WebGL attest basis', () => {
    // `resolveWebglBasis` enrols any file under lib/ui/modules whose source
    // creates a WebGL context. A `getContext('webgl')` here would make every
    // future modtris edit cost an owner-machine re-attest, permanently.
    expect(BODY).toMatch(/getContext\('2d'\)/);
    expect(BODY).not.toMatch(/getContext\(\s*['"]webgl/);
  });
});

describe('modtris — CLAIM 2: SCREEN OFF stops the PICTURE and nothing else', () => {
  // ⚠ THE MOST VALUABLE ASSERTION ON THIS SURFACE, and it is here rather than in
  // a comment precisely because `skifree` — one module away in the same family —
  // does NOT have this property, and somebody will copy this body.
  //
  // The mechanism: MODTRIS's game runs on the shared scheduler clock, subscribed
  // inside the module's FACTORY. Not in a card, not on rAF, and not gated on the
  // AudioContext (the clock is a Web Worker `setInterval`). So collapsing the
  // preview skips a `drawModtris` call and the pieces still fall, the lines
  // still clear and the gates still fire.
  it('the game is driven from the FACTORY, so no surface owns its clock', () => {
    expect(DEF_SRC).toMatch(/getSchedulerClock\(\)\.subscribe\(tick\)/);
    // …and the stepper is called from that subscription, not from a component.
    expect(DEF_SRC).toMatch(/stepModtrisState\(/);
    expect(BODY, 'the body must never step the game').not.toMatch(/stepModtrisState/);
  });

  it('the body only READS a snapshot — it has no write path into the engine', () => {
    expect(BODY).toMatch(/eng\.read\(node, 'snapshot'\)/);
    // The one and only engine call. A `write`/`setParam` here would mean the
    // picture had become load-bearing for the module's behaviour, which is the
    // rasterize inversion and is NOT this module's shape.
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

  it('the ACCESSIBLE NAME survives SCREEN OFF — the frame is outside the guard', () => {
    // ⚠ THE ONE PLACE THIS BODY DELIBERATELY DIVERGES FROM `FroggerBoardBody`,
    // which it is otherwise a port of. Frogger renders `role="img"` INSIDE its
    // `{#if !previewCollapsed}`, so its own comment's claim that "the accessible
    // name tracks the game even while the picture is off" is false there. Here
    // only the <canvas> is inside the guard.
    const markup = markupOf(BODY);
    const guardAt = markup.indexOf('{#if !previewCollapsed}');
    const frameAt = markup.indexOf('role="img"');
    expect(guardAt, 'the collapse guard must exist').toBeGreaterThan(-1);
    expect(frameAt, 'the role="img" frame must exist').toBeGreaterThan(-1);
    expect(
      frameAt,
      'the aria-label carrier must be rendered BEFORE (i.e. outside) the collapse guard, '
        + 'or SCREEN OFF silently drops the game from the a11y tree',
    ).toBeLessThan(guardAt);
    // …and it is the CANVAS that the guard removes, which is what makes SCREEN
    // OFF reclaim space rather than merely blank it.
    expect(markup.slice(guardAt)).toMatch(/<canvas/);
  });

  it('the switch state lives on node.data (the #1531/#1574/#1583 class)', () => {
    // A `$state` here dies with the component, and this component unmounts on
    // dock collapse / LRU eviction.
    expect(BODY).toMatch(/data\?\.previewCollapsed/);
    expect(BODY).toMatch(/mutateNode\(/);
  });
});

describe('modtris — CLAIM 3: the missing glyph is all but FORCED, and that is measured', () => {
  it('there is NO primary audio output — every output is a gate', () => {
    expect(modtrisDef.outputs.every((o) => o.type === 'gate')).toBe(true);
    expect(primaryAudioOutPortId(modtrisDef)).toBeNull();
  });

  it('so every LIVE glyph kind resolves STATIC and is refused by the dead-glyph clause', () => {
    for (const kind of ['scope', 'meter', 'envelope', 'waveform'] as const) {
      const bound = glyphBinding({ ...modtrisDef, face: { ...FACE, glyph: kind } });
      expect(bound.kind, `glyph '${kind}' must resolve static on a gate-only def`).toBe('static');
    }
  });

  it('⚠ but `algorithm` DOES resolve — and it is refused on its own merits', () => {
    // The honest half, and the reason the def does not say "forced" flat out.
    // #2160 widened the resolver, so this kind binds. It is still wrong here,
    // and for a mechanical reason rather than a taste one.
    const asAlgorithm = glyphBinding({ ...modtrisDef, face: { ...FACE, glyph: 'algorithm' } });
    expect(asAlgorithm.kind).toBe('algorithm');
    expect(asAlgorithm).toMatchObject({ kind: 'algorithm', layoutSource: 'modtris' });
    // …AND IT CARRIES NO DATUM. The shell feeds `topologyValue: 0` when
    // `paramId` is null, and `ShellExtensionGlyphProps` has no `nodeId`, so the
    // component cannot resolve a node and cannot reach the game snapshot. A
    // glyph identical on every modtris in the rack forever is not a picture of
    // this module.
    expect(
      (asAlgorithm as { paramId?: string | null }).paramId ?? null,
      'a layout-source glyph binds no param, so the shell has nothing to vary it with',
    ).toBeNull();
  });

  it('and the face declares none, so the lane tile paints two faders and no well', () => {
    expect(FACE.glyph).toBe('none');
    expect(laneGlyphFor(modtrisDef)).toBe('none');
  });
});

describe('modtris — CLAIM 4: the face adds NO resting numbers of its own', () => {
  // ⚠ THE RULING AND ITS ENFORCEMENT GAP, STATED HONESTLY. A game's score
  // painted INSIDE the playfield canvas is ALLOWED — that is the game's own
  // artwork, drawn by `drawModtris`, and it is part of the picture that earns
  // the width; the strip is 30 % of the canvas by construction
  // (`wellWidthPx = w * 0.7`) rather than slack to be reclaimed. A `LINES 17` or
  // `LEVEL 2` row rendered as CHROME BESIDE the well is FORBIDDEN: that is the
  // hero readout strip with a different label.
  //
  // `face-resting-text-source` cannot see either shape (canvas text is invisible
  // to it, and a row inside a module-owned body is not a `ModuleFace` field).
  // This block plus the dock VRT baseline are the only things that look.
  it('the counts are painted by the MODULE\'s own function, into the canvas', () => {
    expect(DEF_SRC).toMatch(/ctx2d\.fillText\('LN', stripX/);
    expect(DEF_SRC).toMatch(/ctx2d\.fillText\(String\(state\.lines\)/);
    // ⚠ `LV` IS NEW IN THIS DIFF and it is a WIRING consequence rather than
    // decoration: `levelStep` did nothing until the ramp landed, and without the
    // number the only evidence a level advanced is that the pieces feel faster —
    // indistinguishable from someone having moved DROP.
    expect(DEF_SRC).toMatch(/ctx2d\.fillText\('LV', stripX/);
    expect(DEF_SRC).toMatch(/ctx2d\.fillText\(String\(state\.level\)/);
  });

  it('the body renders exactly ONE literal text run, and it is the SWITCH CAPTION', () => {
    // Strip tags, then interpolations, and see what literal text the DOM would
    // actually contain. Anything but the switch caption is a chrome row.
    const text = literalTextOf(markupOf(BODY));
    expect(
      text,
      'the only text beside the well must be the SCREEN switch caption — a LINES pill, '
        + 'a LEVEL readout or a GAME OVER banner here is the refused hero-readout shape',
    ).toBe('SCREEN');
  });

  it('NEGATIVE CONTROL: the extractor can SEE an added chrome row', () => {
    // Without this the assertion above passes on an extractor that returns ''
    // for everything, which is exactly how a green blind gate looks.
    const withRow = markupOf(BODY).replace(
      '<div class="preview-wrap"',
      '<span>LINES 17</span><div class="preview-wrap"',
    );
    const text = literalTextOf(withRow);
    expect(text).toContain('LINES 17');
    expect(text).not.toBe('SCREEN');
  });

  it('the derived numbers reach the a11y tree ONLY, never the DOM as content', () => {
    // `ariaLabel` carries lines / level / next piece / fill. It is the speakable
    // half of a painted HUD — and it must stay an ATTRIBUTE. Rendering it as
    // element content would be the resting-readout row by the back door.
    const markup = markupOf(BODY);
    expect(markup).toMatch(/aria-label=\{ariaLabel\}/);
    expect(markup).not.toMatch(/>\s*\{ariaLabel\}/);
    expect(markup).not.toMatch(/\{ariaLabel\}\s*</);
  });

  it('the well canvas is role="img" — a picture is not a range role', () => {
    expect(markupOf(BODY)).toMatch(/role="img"/);
    // …and it does NOT reach for aria-valuetext, which belongs to a range role
    // and therefore to the FADER, not to a picture. ⚠ Scoped to the MARKUP: the
    // component's header names `aria-valuetext` to explain why it is NOT used,
    // and a source-wide grep would read that prose as a violation.
    expect(markupOf(BODY)).not.toMatch(/aria-valuetext/);
  });
});

describe('modtris — CLAIM 5: the VRT pin needs BOTH halves and can actually pin', () => {
  // ⚠ THE PIN IS THE WHOLE REASON THIS MODULE COULD LEAVE `EXEMPT_FROM_VRT`.
  // Unlike frogger's, modtris' exemption named NO exit condition, so leaving it
  // is a judgement made on a built seam — and the seam is strictly harder.
  it('the stepper HAS an RNG, which is why a tick count alone is NOT enough', () => {
    // The load-bearing fact under the whole determinism argument, and the exact
    // place frogger's three-line pin stops transferring. Asserted POSITIVELY:
    // frogger's equivalent leg asserts the ABSENCE of `Math.random`, and copying
    // that here would have certified a claim that is false about this module.
    expect(STEPPER).toMatch(/opts\.rng \?\? Math\.random/);
    expect(STEPPER, 'the 7-bag shuffle is the nondeterminism a seed exists for')
      .toMatch(/Fisher-Yates/);
    // …and no OTHER clock source has crept in, so (seed, ticks, params) really
    // is the whole input space.
    expect(STEPPER).not.toMatch(/performance\.now/);
    expect(STEPPER).not.toMatch(/Date\.now/);
  });

  it('the pin is a SEED *and* a tick budget, and the seed is what ARMS it', () => {
    expect(DEF_SRC).toMatch(/__modtrisVrtSeed/);
    expect(DEF_SRC).toMatch(/__modtrisVrtTicks/);
    // A ticks-only install must NOT pin: without a seed the piece sequence still
    // differs per boot, so a "pinned" capture would be a different well each
    // time — a dead pin that looks alive.
    expect(
      DEF_SRC,
      'the seed is the arming condition; ticks alone cannot pin a 7-bag game',
    ).toMatch(/if \(typeof seed !== 'number'[\s\S]{0,40}\) return undefined;/);
    // ONE generator feeds the init bag AND every refill, or the capture is
    // deterministic only until the first bag runs out.
    expect(DEF_SRC).toMatch(/rng = mulberry32\(seed\);/);
    expect(DEF_SRC).toMatch(/initModtrisState\(\{ rng \}\)/);
    expect(DEF_SRC).toMatch(/stepModtrisState\(state, NO_INPUT_EDGES, params, dtSeconds, \{ rng \}\)/);
  });

  it('the factory reads the pin at CONSTRUCTION *and* in the tick — both harnesses', () => {
    // The face harness installs it with `addInitScript` BEFORE goto (visible at
    // construction); the CARD scene sets it from `afterSpawn` (after
    // construction). A construction-only read would leave the card scene
    // silently unpinned, which is the dead-pin failure this leg exists for.
    const ctorAt = DEF_SRC.indexOf('const bootPin = readVrtPin();');
    const tickAt = DEF_SRC.indexOf('const latePin = readVrtPin();');
    expect(ctorAt, 'the factory must read the pin at construction').toBeGreaterThan(-1);
    expect(tickAt, 'and once more in the tick, for the after-spawn install').toBeGreaterThan(-1);
    expect(ctorAt).toBeLessThan(tickAt);
  });

  it('and it SUPPRESSES the sim rather than freezing it — the well is time-invariant', () => {
    // A freeze holds whichever frame the harness caught, and "which frame" is a
    // function of boot speed (measured on pong: 72 px across two ubuntu boots
    // WITH a seed). Running a fixed number of ticks and then never ticking again
    // removes the question instead of narrowing it.
    expect(DEF_SRC).toMatch(/if \(vrtPinned\) return;/);
    const pinReturnAt = DEF_SRC.indexOf('if (vrtPinned) return;');
    const stepAt = DEF_SRC.indexOf('state = stepModtrisState(state, inputs, params, dtSeconds');
    expect(stepAt).toBeGreaterThan(-1);
    expect(
      pinReturnAt,
      'the pin must return BEFORE the tick steps the game, or the well drifts again',
    ).toBeLessThan(stepAt);
  });

  it('NO `freeze` ParamDef was added — the pin costs no contract row', () => {
    // The alternative that was refused: a `params` edit is in contract-lock (and
    // in the WebGL attest basis for a def that sits in it), and it buys only
    // INTRA-boot stillness. A boot-time global costs neither and buys
    // time-invariance.
    expect(DECLARED).toEqual(['gravityBpm', 'levelStep']);
    expect(modtrisDef.params.some((p) => p.id === 'freeze')).toBe(false);
  });

  it('NOTHING in the app ever sets the globals — they are a test-only seam', () => {
    // The pin must be unreachable from the product, or it is a shipped freeze
    // button nobody declared. (`g.__modtrisVrtSeed` appears in the VRT scene and
    // in the e2e spec, both outside packages/web/src.)
    expect(DEF_SRC).not.toMatch(/__modtrisVrtSeed\s*=/);
    expect(DEF_SRC).not.toMatch(/__modtrisVrtTicks\s*=/);
  });
});

describe('modtris — CLAIM 6: the RANK is honest because the control was WIRED', () => {
  it('`levelStep` is read by the stepper — it was ranked-shaped and inert before', () => {
    // ⚠ THE LEG THAT WOULD HAVE STOPPED THIS FACE SHIPPING A DEAD CONTROL. The
    // stepper's own type comment said "unused in v1 stepper but reserved for
    // future scoring" while `docs.controls.levelStep` promised "gravity speeds
    // up each level". A def-reading gate cannot see the difference: the param is
    // declared, contract-locked and documented either way.
    expect(STEPPER).toMatch(/levelForLines\(lines, params\.levelStep\)/);
    // …and the level actually reaches GRAVITY, which is the only thing that
    // makes the fader do anything. A `level` that were computed and then ignored
    // would satisfy the line above.
    expect(withoutComments(STEPPER))
      .toMatch(/gravitySecondsPerDrop\(\s*params\.gravityBpm,\s*levelForLines\(/);
    expect(
      withoutComments(STEPPER),
      'the stepper must not re-declare the param as unused (comments stripped, so the '
        + 'historical quote beside the fix does not count)',
    ).not.toMatch(/unused in v1 stepper/);
  });

  it('and the DOCS now describe what the code does', () => {
    const doc = modtrisDef.docs?.controls?.levelStep ?? '';
    expect(doc).toMatch(/0\.85/);
    expect(doc, 'the floor is part of the contract a player can hit').toMatch(/50 ms/);
  });

  it('the def no longer promises a GROUP-card portal the product does not do', () => {
    // `GROUP_VIZ_HOST_TYPES` is `new Set(['scope'])`; `group-viz-hosts.test.ts`
    // measures `canvasInSlot 0` for modtris (#1755). The flag stays declared —
    // it is the licence the eventual host fix reads — but the user-facing
    // sentence that said it worked is gone.
    expect(modtrisDef.vizPassthrough).toBe(true);
    const explanation = modtrisDef.docs?.explanation ?? '';
    expect(explanation).not.toMatch(/portaled into a containing GROUP card/);
    expect(explanation, 'and it names where the well actually lives now')
      .toMatch(/dock faceplate/);
  });
});

describe('modtris — the card and the face paint ONE well at ONE scale', () => {
  // ⚠ THE BUG THIS PINS WAS LIVE AND UNCATCHABLE. `ModtrisCard` passed
  // `canvasEl.width/height` — the BACKING STORE at DPR 2, i.e. 400x520 — into a
  // painter that lays out in those units and then draws its NEXT strip at an
  // ABSOLUTE `'700 9px'` with absolute `+14`/`+90`/`+102` offsets. Every WELL
  // dimension is derived from w/h so the well scaled correctly and the bug hid
  // in plain sight; only NEXT / LN / the count were wrong, rendering at ~4.5-5.5
  // CSS px with a compressed vertical rhythm. There was no pixel test at all,
  // because modtris was EXEMPT_FROM_VRT — the exemption this PR discharges.
  it('BOTH surfaces pass CSS px and scale the context by DPR', () => {
    for (const [name, src] of [['card', CARD], ['face body', BODY]] as const) {
      expect(src, `${name}: must scale the context`).toMatch(/setTransform\(DPR, 0, 0, DPR, 0, 0\)/);
      expect(src, `${name}: must pass CSS px, not the backing store`)
        .toMatch(/drawModtris\(ctx2d, snap, CSS_W, CSS_H\)/);
    }
  });

  it('NEGATIVE CONTROL: neither surface passes the BACKING STORE any more', () => {
    // The exact shape of the old call. Without this leg the assertion above
    // would still pass if someone added a second, wrong `drawModtris` call.
    for (const [name, src] of [['card', CARD], ['face body', BODY]] as const) {
      expect(src, `${name}: canvasEl.width is device px, not layout px`)
        .not.toMatch(/drawModtris\([^)]*canvasEl\.width/);
    }
  });

  it('and they agree on the well GEOMETRY, so the two pictures are the same picture', () => {
    const dims = (src: string) => ({
      w: /const CSS_W = (\d+);/.exec(src)?.[1],
      h: /const CSS_H = (\d+);/.exec(src)?.[1],
    });
    expect(dims(BODY)).toEqual(dims(CARD));
    expect(dims(BODY).w).toBe('200');
  });

  it('the card binds its ranges to the DEF, and never by POSITION', () => {
    // ⚠ THE POSITIONAL READ WAS ABOUT TO BECOME LIVE. The card read
    // `modtrisDef.params[0]/[1]` for both faders' defaults; the first draft of
    // the VRT seam in this same PR was a `freeze` ParamDef, and declaring it
    // ahead of `gravityBpm` would have re-pointed BOTH faders — with
    // contract-lock, module-docs-lint and every range assertion green, because
    // all of them read the DEF and none can see the card.
    // ⚠ COMMENTS STRIPPED: the card's own header quotes the six literals it
    // removed, and a raw grep cannot tell a quotation from the code.
    const card = withoutComments(CARD);
    expect(card).toMatch(/paramSpec\(modtrisDef, 'gravityBpm'\)/);
    expect(card).toMatch(/paramSpec\(modtrisDef, 'levelStep'\)/);
    expect(card, 'no positional param reads').not.toMatch(/modtrisDef\.params\[\d+\]/);
    expect(card, 'no re-typed travel').not.toMatch(/min=\{\d/);
    expect(card, 'no re-typed travel').not.toMatch(/max=\{\d/);
    expect(card, 'no re-typed default').not.toMatch(/defaultValue=\{\d/);
  });
});
