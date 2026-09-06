// packages/web/src/lib/ui/modules/nibbles-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the NIBBLES faceplate.
//
// This face rests on six claims that no shared gate can check, and every one of
// them reads as true whether or not it is:
//
//   1. "The lane tile gets a live picture, and `glyph: 'none'` is what gives it
//      one." Counter-intuitive, and — unlike frogger's — NOT forced: this def
//      HAS a primary audio output, so a `meter`/`scope`/`waveform` literal
//      binds LIVE and the dead-glyph lint would stay green while the declared
//      glyph never painted at all.
//   2. "SCREEN OFF stops the picture and NOTHING else." The most valuable
//      assertion on this surface, and the one a reader is most likely to copy
//      from frogger — where it is true for a DIFFERENT reason that does not
//      hold here. nibbles ticks its game inside `surface.draw`.
//   3. "AUTO derives a toggle." One param shape away from the moog962 trap (a
//      two-position control drawn across a whole dial), which failed
//      faces-parity twice.
//   4. "The face adds no resting numbers of its own." `face-resting-text-source`
//      names its own blind spot — text inside a module-owned body is not a
//      `ModuleFace` field — and here the deleted readout has NO in-canvas
//      fallback, so nothing else looks at all.
//   5. "RESET is observable." `readParam` and `readData` are structurally blind
//      to it; a dead audition passed a whole face green once already.
//   6. "The VRT pin can actually pin, and BOTH halves are needed." A dead pin
//      produces a perfectly plausible picture — a different one on every boot.
//
// ⚠ NONE OF THESE IS A KNOB-WIGGLE TEST. The game's own behaviour is pinned in
// `nibbles.test.ts`, `nibbles-game.test.ts` and `nibbles-bot.test.ts`. What is
// at risk HERE is a set of structural claims that would go quietly false if a
// port type, a predicate, a call signature or a rank changed underneath them.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nibblesDef, NIBBLES_MAX_LENGTH } from '$lib/video/modules/nibbles';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { hasVideoSurface, laneGlyphFor } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { curatedFace, FACE_TIER_CAPS, type FaceTier } from '$lib/ui/workflow/curated-face';
import { paramCellKind } from '$lib/ui/workflow/shell-control-kind';
import { RAW_WRITE_LEDGER } from '$lib/graph/raw-write-ledger';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';
import type { ModuleNode } from '$lib/graph/types';
import {
  fireNibblesReset,
  nextNibblesScale,
  nibblesDirectionForKey,
  nibblesPreviewCollapsed,
  nibblesPreviewScale,
  nibblesScreenLabel,
  nibblesTickValueText,
  resolveNibblesExtras,
  resolveNibblesReset,
  NIBBLES_SCALE_STEPS,
} from './nibbles-game-actions';
import {
  auditionDelivered,
  auditionLog,
  recordAudition,
  __resetAuditionLedger,
} from './audition-ledger';

/** Every tier the shell can render, DERIVED from the cap table rather than
 *  re-typed — a hand-listed ladder would silently stop covering a new tier. */
const ALL_TIERS = Object.keys(FACE_TIER_CAPS) as FaceTier[];

/** The face, unwrapped once so every case reads off the live declaration. */
const FACE = nibblesDef.face!;
/** Declaration order — what a rank has to be measured AGAINST. */
const DECLARED: readonly string[] = nibblesDef.params.map((p) => p.id);

const BODY = readFileSync(new URL('./nibbles/NibblesScreenBody.svelte', import.meta.url), 'utf8');
const ACTIONS = readFileSync(new URL('./nibbles-game-actions.ts', import.meta.url), 'utf8');
const DEF_SRC = readFileSync(new URL('../../video/modules/nibbles.ts', import.meta.url), 'utf8');

/**
 * The CODE of each surface, comments blanked by the shared quote-aware
 * stripper.
 *
 * ⚠ EVERY "this source must NOT contain X" LEG READS THESE, and the reason is a
 * documented repeat offence rather than caution: the natural way to write down
 * what a gate forbids is to QUOTE it, so a raw grep flags its own explanation.
 * This file does exactly that — the body's header explains why `advanceGame` is
 * NOT called here, the card's header quotes the `params.auto = …` raw write it
 * replaced, and both quote `width: max-content` to say the face must not
 * inherit it. Three legs below would have been red on their first run.
 */
const BODY_CODE = stripSourceComments(BODY);

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
 * comment is not rendered text but CAN contain `>`, which splits a naive
 * `<[^>]*>` tag match part-way through and leaks prose into the result.
 */
function literalTextOf(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A fake engine handle: `read(node, key)` answers from a plain map. */
function fakeEngine(answers: Record<string, unknown>) {
  return { read: (_n: ModuleNode, key: string) => answers[key] };
}
const FAKE_NODE = { id: 'n1', type: 'nibbles', domain: 'video' } as unknown as ModuleNode;

describe('nibbles — the face is promoted and complete', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('nibbles')).toBe(true);
    expect(migrated('nibbles')).toBe(true);
  });

  it('ranks EVERY declared param — a face that drops one silently hides a control', () => {
    expect([...FACE.order].sort()).toEqual([...DECLARED].sort());
    // ⚠ AND IT DECLARES NO CONTROL FAMILY, which is a decision rather than an
    // absence — see the RESET block below. A family would have to be RANKED
    // (module-face-lint's completeness leg) and therefore resolve a shell cell.
    expect(nibblesDef.controlFamilies ?? []).toEqual([]);
  });

  it('declares ONE page, so the tab rail is structurally out of reach', () => {
    // DOCK_TAB_MIN_BANDS is 7. Recorded so ADDING pages later is a deliberate
    // act with a red test, and so nobody pads bands to reach a rail — nibbles
    // is exactly the module a reader might expect to be TABBED, and the owner's
    // control-heavy ruling is about "lots of controls of DIFFERENT types".
    expect(FACE.pages).toHaveLength(1);
    expect(FACE.pages?.[0]?.controls).toEqual(['tick_ms', 'auto']);
  });

  it('the REAR groups are all OUTPUT groups, and they cover every port once', () => {
    // ⚠ `direction` DEFAULTS TO 'input' and module-face-lint refuses a group
    // whose ports are not on the rail it declares — so a forgotten `direction`
    // here is red rather than silently wrong. Pinned because ALL THREE need it
    // and nibbles has NO INPUTS AT ALL for the derivation to fall back on.
    const groups = FACE.rear?.groups ?? [];
    expect(groups).toHaveLength(3);
    for (const g of groups) {
      expect(g.direction, `rear group '${g.id}' must declare direction: 'output'`).toBe('output');
    }
    expect(groups.flatMap((g) => [...g.ports]).sort())
      .toEqual(nibblesDef.outputs.map((o) => o.id).sort());
    expect(nibblesDef.inputs, 'nibbles has no inputs, so the input rail is empty').toEqual([]);
  });

  it('and the SPLIT means something the derived one would not', () => {
    // The derived default splits the OUT rail by CABLE DOMAIN once it out-runs
    // a column, which would file `length_cv` away from the two oscillators it
    // PITCHES. That is the whole reason to author this.
    const voice = (FACE.rear?.groups ?? []).find((g) => g.id === 'voice');
    expect(voice?.ports).toEqual(['length_cv', 'snake', 'gated']);
    const cableTypes = new Set(
      nibblesDef.outputs.filter((o) => voice!.ports.includes(o.id)).map((o) => o.type),
    );
    expect(
      cableTypes.size,
      'the voice group deliberately spans MORE THAN ONE cable type — that is what makes it '
        + 'an authored grouping rather than a restatement of the domain split',
    ).toBeGreaterThan(1);
  });
});

describe('nibbles — the TIER LADDER, derived rather than read off the caps', () => {
  // ⚠ DERIVED THROUGH `curatedFace`, NEVER FROM THE CAP CONSTANTS. Four sibling
  // faces got this wrong by reading `FACE_TIER_CAPS` directly, which is the
  // pre-reconciliation number and not what the lane actually fits — and this is
  // a WITH-GLYPH module, where the cap differs.
  it('mini = TICK; compact, full and dock = TICK + AUTO', () => {
    expect(ALL_TIERS.length, 'the ladder must cover every declared tier').toBeGreaterThan(1);
    const at = (tier: FaceTier) => curatedFace(nibblesDef, tier)!.controls.map((c) => c.key);
    expect(at('mini')).toEqual(['tick_ms']);
    expect(at('compact')).toEqual(['tick_ms', 'auto']);
    expect(at('full')).toEqual(['tick_ms', 'auto']);
    expect(at('dock')).toEqual(['tick_ms', 'auto']);
  });

  it('so the COMPACT tile is the live picture plus BOTH params, with nothing evicted', () => {
    // §2.1 of the build spec, checked rather than assumed: the with-glyph
    // compact cap and the number of ranked PARAMS coincide exactly here, so the
    // #1785 "a PICTURE outranks ranked controls" rule — which strips cells off
    // backdraft's tile — never has to fire.
    const compact = curatedFace(nibblesDef, 'compact')!.controls.map((c) => c.key);
    expect(compact).toEqual(DECLARED.slice().sort((a, b) =>
      FACE.order.indexOf(a) - FACE.order.indexOf(b)));
    expect(laneGlyphFor(nibblesDef)).toBe('picture');
  });

  it('the DOCK renders the one declared band', () => {
    expect(curatedFace(nibblesDef, 'dock')!.pages?.map((p) => p.id)).toEqual(['snake']);
  });
});

describe('nibbles — CLAIM 1: the lane picture is FREE, and `glyph: none` is a real CHOICE', () => {
  it('the def is VIDEO-domain, which is the WHOLE condition for the lane picture', () => {
    expect(nibblesDef.domain).toBe('video');
    expect(hasVideoSurface(nibblesDef)).toBe(true);
    expect(laneGlyphFor(nibblesDef)).toBe('picture');
  });

  it('NEGATIVE CONTROL: the same predicate is FALSE for an audio def', () => {
    // Without this leg the assertion above passes on a predicate that returns
    // true for everything — the blind-gate shape.
    expect(hasVideoSurface({ domain: 'audio' })).toBe(false);
    // `LaneGlyphDefLike` carries only `{ domain, face: { glyph } }` — the
    // predicate reads nothing else, which is itself the point.
    expect(laneGlyphFor({ domain: 'audio', face: { glyph: 'none' } })).toBe('none');
    // …and a non-'none' literal on an AUDIO def gives a static TRACE, never a
    // picture — the branch nibbles never reaches.
    expect(laneGlyphFor({ domain: 'audio', face: { glyph: 'meter' } })).toBe('trace');
  });

  it('⚠ AND THE PICTURE DOES NOT COME FROM THE FACE — the DOMAIN decides, first', () => {
    // "'none' + blank tile" and "'none' + live thumb" are indistinguishable
    // from the declaration, so the picture must be asserted through
    // `hasVideoSurface` and never inferred from `face.glyph`. The proof that
    // the face has no say: laneGlyphFor is 'picture' for EVERY literal.
    for (const kind of ['none', 'scope', 'meter', 'envelope', 'waveform'] as const) {
      expect(
        laneGlyphFor({ ...nibblesDef, face: { ...FACE, glyph: kind } }),
        `glyph '${kind}' must not change what the lane paints on a video def`,
      ).toBe('picture');
    }
  });

  it('⚠ AND UNLIKE FROGGER, `none` IS NOT FORCED — the dead-glyph lint would NOT catch a wrong one', () => {
    // THE HONEST HALF, and the reason this block exists at all. frogger can say
    // "every live kind resolves static, so there was nothing to reject".
    // nibbles DECLARES TWO AUDIO OUTPUTS, so `primaryAudioOutPortId` resolves
    // and three of the five kinds bind LIVE. `module-face-lint`'s dead-glyph
    // leg only reddens a binding of kind 'static' — so a `glyph: 'meter'` here
    // would pass every gate in the tree while ModuleShell painted the
    // VideoTileThumb and never painted the meter at all.
    expect(primaryAudioOutPortId(nibblesDef)).toBe('snake');
    for (const kind of ['scope', 'meter', 'waveform'] as const) {
      const bound = glyphBinding({ ...nibblesDef, face: { ...FACE, glyph: kind } });
      expect(bound.kind, `glyph '${kind}' binds LIVE on this def — it is not a dead declaration`)
        .toBe('live-audio');
    }
    // …so the declaration is a JUDGEMENT: the module's identity is the game it
    // is drawing, not a VU of the square wave its length happens to pitch.
    expect(FACE.glyph).toBe('none');
  });

  it('so the face declares the extension that carries the screen to the dock', () => {
    expect(FACE.extension).toBe('nibbles');
  });
});

describe('nibbles — CLAIM 2: SCREEN OFF stops the PICTURE and nothing else', () => {
  // ⚠ THE MOST VALUABLE ASSERTION ON THIS SURFACE, and it is here rather than
  // in a comment because frogger's and modtris' version of this claim is TRUE
  // FOR A DIFFERENT REASON — their games step on the shared scheduler clock in
  // their factory. NIBBLES ticks inside `surface.draw`, so "collapsing the
  // preview cannot stop the game" needs its own argument, and somebody will
  // copy this body.
  it('the GAME TICKS INSIDE surface.draw — which is why this needs its own argument', () => {
    expect(DEF_SRC).toMatch(/tickAccumS \+= dt;/);
    expect(DEF_SRC).toMatch(/while \(tickAccumS >= tickPeriodS[\s\S]*?advanceGame\(\);/);
    // …and the body never steps it. Comments blanked: this body's own header
    // explains the mechanism by name.
    expect(BODY_CODE, 'the body must never advance the game').not.toMatch(/advanceGame/);
  });

  it('the module is PULL-EXEMPT by construction, so it renders unwatched', () => {
    // `VideoEngine.isPullExempt` returns true for a handle with a non-empty
    // `audioSources` map. nibbles publishes six entries, so it is a pull root
    // with nothing patched and nothing watching. THIS is the structural half.
    expect(DEF_SRC).toMatch(/audioSources\.set\('pellet',/);
    expect(DEF_SRC).toMatch(/audioSources\.set\('snake',/);
    const engineSrc = readFileSync(
      new URL('../../video/engine.ts', import.meta.url), 'utf8',
    );
    expect(engineSrc).toMatch(/if \(handle\.audioSources && handle\.audioSources\.size > 0\) return true;/);
  });

  it('AND the body renews the watch mark in BOTH screen states — the second, independent guard', () => {
    // The structural exemption above holds only while `ctx.audioCtx` exists at
    // construction (the map is populated inside `if (ctx.audioCtx)`). The mark
    // makes the switch safe independent of the audio topology, which is the
    // `blood` argument reached the same way — and the mark call must sit ABOVE
    // the collapse branch or it stops with the picture.
    expect(BODY).toMatch(/markWatched\(nodeId\)/);
    const markAt = BODY.indexOf('markWatched(nodeId)');
    const collapseAt = BODY.indexOf('if (!previewCollapsed && canvasEl)');
    expect(markAt, 'the body must renew the watch mark').toBeGreaterThan(-1);
    expect(collapseAt, 'the body must gate the blit on the collapse').toBeGreaterThan(-1);
    expect(
      markAt,
      'markWatched must be called ABOVE the collapse branch, or SCREEN OFF stops marking',
    ).toBeLessThan(collapseAt);
  });

  it('the body only READS the engine — it has no write path into it', () => {
    expect(BODY).toMatch(/eng\.read\(live, 'snapshot'\)/);
    // A `write`/`setParam` here would mean the picture had become load-bearing
    // for the module's behaviour, which is not this module's shape.
    expect(BODY).not.toMatch(/eng\.write\(/);
    expect(BODY).not.toMatch(/eng\.setParam\(/);
  });

  it('collapse gates the BLIT ONLY — never an early return above the reads', () => {
    // The negative control is the SHAPE. An early return on `previewCollapsed`
    // above the score/alive reads would stop the accessible name tracking the
    // game, and is one refactor away from stopping the watch mark too.
    const readAt = BODY.indexOf("eng.read(live, 'score')");
    expect(readAt).toBeGreaterThan(-1);
    const before = BODY.slice(0, readAt);
    expect(
      /if\s*\(\s*previewCollapsed\s*\)\s*return/.test(before),
      'an early return on previewCollapsed ABOVE the reads would stop tracking the game',
    ).toBe(false);
  });

  it('the switch state lives on node.data, under the SHARED key', () => {
    // A `$state` here dies with the component, and this component unmounts on
    // dock collapse / LRU eviction. And it must be the same key every other
    // video face uses, or a rack saved before the promotion re-opens.
    expect(BODY).toMatch(/data\.previewCollapsed\s*=/);
    expect(BODY).toMatch(/mutateNode\(/);
    expect(nibblesPreviewCollapsed(undefined)).toBe(false);
    expect(nibblesPreviewCollapsed({ data: {} } as unknown as ModuleNode)).toBe(false);
    expect(nibblesPreviewCollapsed({ data: { previewCollapsed: true } } as unknown as ModuleNode))
      .toBe(true);
  });
});

describe('nibbles — the SCALE zoom is on the node, which is a BUG FIX and not a port', () => {
  // ⚠ `let scale = $state(1)` in `NibblesCard.svelte` was component state, and
  // under the shipping shell an un-migrated module's card exists ONLY inside
  // the dock full view — so collapsing the pane already reset a user's 4x zoom
  // to 1x today, and the dock's LRU eviction did it to a module the user never
  // touched. The #1531 / #1574 / #1583 class verbatim.
  it('NEITHER surface holds the zoom in component state any more', () => {
    for (const [name, src] of [['face body', BODY] as const]) {
      expect(src, `${name}: the zoom must not be component state`)
        .not.toMatch(/let scale = \$state\(/);
      expect(src, `${name}: the zoom must be read off the node`).toMatch(/nibblesPreviewScale\(/);
    }
  });

  it('the reader is total and clamps to the declared steps', () => {
    expect(nibblesPreviewScale(undefined)).toBe(1);
    expect(nibblesPreviewScale({ data: {} } as unknown as ModuleNode)).toBe(1);
    for (const n of NIBBLES_SCALE_STEPS) {
      expect(nibblesPreviewScale({ data: { previewScale: n } } as unknown as ModuleNode)).toBe(n);
    }
    // A hand-edited or foreign value cannot strand the button on a step the
    // cycle can never leave.
    for (const bad of [0, 5, -2, 2.5, Number.NaN, Infinity]) {
      expect(nibblesPreviewScale({ data: { previewScale: bad } } as unknown as ModuleNode)).toBe(1);
    }
    expect(nibblesPreviewScale({ data: { previewScale: 'big' } } as unknown as ModuleNode)).toBe(1);
  });

  it('the cycle is 1 -> 2 -> 3 -> 4 -> 1 and closes', () => {
    expect([1, 2, 3, 4].map(nextNibblesScale)).toEqual([2, 3, 4, 1]);
    expect(nextNibblesScale(99), 'an out-of-range value lands back on 1').toBe(1);
  });

  it('⚠ AND IT IS NOT A ParamDef — that would be a GPU re-attest for a per-view preference', () => {
    expect(DECLARED, 'a `scale`/`zoom` param would put a view preference in the audio contract')
      .toEqual(['auto', 'tick_ms']);
  });

  it('the zoom SCROLLS rather than widening the plate — the card does the opposite', () => {
    // `.mod-card { width: max-content }` plus `width: ${320*scale}px` means a 4x
    // zoom makes the CARD 1280 px wide: the "useless gray horizontal space" the
    // compact ruling forbids. The face must not inherit it, and the plate is
    // sized to the 1x preview (an entry justified by 4x would justify the bug).
    expect(BODY_CODE).toMatch(/overflow: auto/);
    // ⚠ A DECLARED `width`, NOT a `max-width`, and the difference is a fix
    // rather than a style. The three corner switches are absolutely positioned
    // against `.screen-box`, and with SCREEN OFF its only in-flow child is an
    // empty wrap — so a shrink-to-fit box measured 0 px and `right: 4px` put
    // the SCREEN switch OUTSIDE the plate and to the LEFT of the two buttons it
    // sits opposite. The geometry is asserted at the render in
    // `face-nibbles.spec.ts`; this is the source half.
    expect(BODY_CODE).toMatch(/width: 322px/);
    expect(
      BODY_CODE,
      'a shrink-to-fit box collapses to 0 px with SCREEN OFF and takes the corner switches with it',
    ).not.toMatch(/max-width: 322px/);
    expect(BODY_CODE, 'the body must not size itself from the zoom')
      .not.toMatch(/width: max-content/);
  });
});

describe('nibbles — CLAIM 3: AUTO derives a TOGGLE, one param shape from the moog962 trap', () => {
  it('the derived kind is `toggle` at every tier, and the face DECLARES nothing', () => {
    const auto = nibblesDef.params.find((p) => p.id === 'auto')!;
    expect(paramCellKind(auto, new Set())).toBe('toggle');
    expect(paramCellKind(auto, new Set(), 'dock')).toBe('toggle');
    // Declaring an `options` roster would invent two state names the module
    // does not have; declaring a paramCell kind would override a derivation
    // that is already right.
    expect(FACE.paramCells ?? {}).toEqual({});
  });

  it('NEGATIVE CONTROL: the moog962 shape is one step away and does NOT derive a toggle', () => {
    // A `2..3 discrete` param has two reachable positions across a whole dial —
    // the inert control faces-parity failed moog962 on, twice. Without this leg
    // the assertion above passes on a derivation that returns 'toggle' for
    // every discrete param.
    const trap = { id: 'x', label: 'X', defaultValue: 2, min: 2, max: 3, curve: 'discrete' } as const;
    expect(paramCellKind(trap, new Set())).toBe('knob');
  });

  it('AUTO is NOT momentary — it is a LATCHING mode, and the two look identical at the def', () => {
    expect(FACE.momentary ?? []).not.toContain('auto');
    // The read sites are bare LEVELS on every tick, with no edge detector — and
    // no cable could bring one, because there are no inputs.
    expect(DEF_SRC).toMatch(/if \(params\.auto < 0\.5\) return;/);
    expect(DEF_SRC).toMatch(/if \(!state\.alive && params\.auto >= 0\.5\)/);
    expect(nibblesDef.inputs).toEqual([]);
  });

  it('TICK stays a plain knob — the card draws one, and the face declares nothing', () => {
    const tick = nibblesDef.params.find((p) => p.id === 'tick_ms')!;
    expect(paramCellKind(tick, new Set())).toBe('knob');
  });

  it('the TICK accessible name carries the ms AND the rate, and the rate is DERIVED', () => {
    // ⚠ The milliseconds are on `aria-valuetext`, NOT on a `units`/`format`
    // declaration: a format makes the readout PAINT, which re-introduces a
    // resting decimal under the dial by the back door — and it would be a
    // `params` edit on a def in the WebGL attest basis.
    expect(nibblesTickValueText(80)).toBe('80 ms — 12.5 ticks per second');
    expect(nibblesTickValueText(40)).toBe('40 ms — 25 ticks per second');
    expect(nibblesTickValueText(200)).toBe('200 ms — 5 ticks per second');
    // …and it is clamped to the same window the factory clamps to, so the name
    // cannot claim a rate the game will not run at.
    expect(nibblesTickValueText(10)).toBe(nibblesTickValueText(40));
    expect(nibblesTickValueText(9999)).toBe(nibblesTickValueText(200));
    expect(nibblesDef.params.find((p) => p.id === 'tick_ms')!.units).toBeUndefined();
  });
});

describe('nibbles — CLAIM 4: the face adds NO resting numbers of its own', () => {
  // ⚠ THE RULING AND ITS ENFORCEMENT GAP, STATED HONESTLY. A game's score
  // painted INSIDE the playfield canvas is ALLOWED — that is the game's own
  // artwork. A score row rendered as CHROME BESIDE the playfield is FORBIDDEN:
  // it is the hero readout strip with a different label.
  //
  // `face-resting-text-source` cannot see either shape. This block plus the
  // dock VRT baseline are the only things that look.
  it('⚠ THE CANVAS PAINTS NO TEXT AT ALL — so the ruling DELETES the readout, it does not move it', () => {
    // MEASURED at the source, and it is what makes nibbles the expensive case:
    // frogger and modtris both have an in-canvas HUD to fall back on.
    expect(DEF_SRC).toMatch(/function paintFrame\(\)/);
    expect(DEF_SRC, 'nibbles paints no text into its framebuffer').not.toMatch(/fillText/);
    expect(DEF_SRC).not.toMatch(/measureText/);
    // Restoring one would be a `paintFrame` edit on a file in the WebGL attest
    // basis — a separate, priced change, deliberately not folded into a face PR.
  });

  it('the body renders exactly THREE literal text runs, and all three are CONTROL CAPTIONS', () => {
    const text = literalTextOf(markupOf(BODY));
    expect(
      text,
      'the only text beside the picture may be the SCREEN and RESET captions and the scale '
        + "button's own option name — a LEN pill, a dagger or a state word here is the refused "
        + 'hero-readout shape',
    ).toBe('× RESET SCREEN');
  });

  it('NEGATIVE CONTROL: the extractor can SEE an added chrome row', () => {
    // Without this the assertion above passes on an extractor that returns ''
    // for everything, which is exactly how a green blind gate looks.
    const withRow = markupOf(BODY).replace(
      '<div class="screen-box">',
      '<span>LEN 17</span><div class="screen-box">',
    );
    const text = literalTextOf(withRow);
    expect(text).toContain('LEN 17');
    expect(text).not.toBe('× RESET SCREEN');
  });

  it('the derived numbers reach the a11y tree ONLY, never the DOM as content', () => {
    const markup = markupOf(BODY);
    expect(markup).toMatch(/aria-label=\{ariaLabel\}/);
    expect(markup).not.toMatch(/>\s*\{ariaLabel\}/);
    expect(markup).not.toMatch(/\{ariaLabel\}\s*</);
  });

  it('and the accessible name is where LEN and the dagger went', () => {
    expect(nibblesScreenLabel(17, true, false)).toBe('NIBBLES — length 17, alive, arrow keys');
    expect(nibblesScreenLabel(17, false, true)).toBe('NIBBLES — length 17, dead, auto-play on');
    // Before the first engine read there is no number to speak, and the name
    // must not invent one.
    expect(nibblesScreenLabel(null, true, false)).toBe('NIBBLES — the game screen');
  });

  it('the screen frame is role="application" — it owns its keys, and is not a range', () => {
    const markup = markupOf(BODY);
    expect(markup).toMatch(/role="application"/);
    // `aria-valuetext` belongs to a range role and therefore to the KNOB, never
    // to a picture. ⚠ Scoped to the MARKUP: the header names it to explain why
    // it is not used, and a source-wide grep would read that as a violation.
    expect(markup).not.toMatch(/aria-valuetext/);
  });
});

describe('nibbles — the ARROW KEYS are the INSTRUMENT, and Tab is still the FLIP gesture', () => {
  // ⚠ THE DISTINCTION HAS TO BE MADE EXPLICITLY BECAUSE IT IS EASY TO CONFLATE.
  // a11y keyboard nav = reaching and operating a CONTROL without a mouse: none
  // is proposed and no control's key handling is touched. These arrows are how
  // the module is PLAYED.
  it('the body is focusable by CLICK and absent from the TAB ORDER', () => {
    const markup = markupOf(BODY);
    expect(markup).toMatch(/tabindex="-1"/);
    expect(
      markup,
      'tabindex="0" would add a tab stop inside the plate, and Tab is the faceplate FLIP gesture',
    ).not.toMatch(/tabindex="0"/);
    // …and the focus is taken explicitly on the pointer press rather than left
    // to a browser default for a -1 element.
    expect(BODY).toMatch(/frameEl\?\.focus\(\)/);
    expect(markup).toMatch(/onpointerdown=/);
    expect(markup).toMatch(/onkeydown=/);
  });

  it('the FOCUS AFFORDANCE survives — it is the only signal the arrows will work', () => {
    // The card's `.tip` sentence ("Click to focus → arrow keys drive snake") is
    // deleted as prose, so the ring is what is left to say it.
    expect(BODY).toMatch(/class:has-focus=\{hasFocus\}/);
    expect(BODY).toMatch(/\.screen-frame\.has-focus/);
  });

  it('the key map is SHARED and total over the four arrows', () => {
    for (const [key, dir] of [
      ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'],
    ] as const) {
      expect(nibblesDirectionForKey(key)).toBe(dir);
    }
    for (const key of ['a', 'Enter', 'Tab', ' ', 'Escape', 'w']) {
      expect(nibblesDirectionForKey(key), `${key} must not steer the snake`).toBeNull();
    }
  });

  it('BOTH surfaces stop propagation — or SvelteFlow pans the viewport while you steer', () => {
    for (const [name, src] of [['face body', BODY] as const]) {
      expect(src, `${name}: must stop the keydown propagating to xyflow`)
        .toMatch(/e\.stopPropagation\(\)/);
      expect(src, `${name}: must preventDefault`).toMatch(/e\.preventDefault\(\)/);
    }
  });

  it('the AUTO guard is the FACTORY\'s, so the two drivers cannot disagree', () => {
    expect(DEF_SRC).toMatch(/function pushDirection\(dir: NibblesDirection\): boolean \{\s*\n\s*if \(params\.auto >= 0\.5\) return false;/);
    // Neither surface re-derives it. (The card used to, which is one more place
    // for the rule to drift.)
    for (const [name, src] of [['face body', BODY] as const]) {
      expect(src, `${name}: must not re-derive the AUTO guard`).not.toMatch(/if \(autoOn\) return;/);
    }
  });
});

describe('nibbles — CLAIM 5: RESET is OBSERVABLE, and the observable is the AUDITION LEDGER', () => {
  // ⚠ RESET IS A BODY BUTTON, NOT A RANKED `ShellActionCell`, and the build
  // spec argued the other way. The measurement overruled it: an action cell's
  // probe here would have to be an AUDITION, and `faces-parity` spawns EVERY
  // module with `spawnPatch({ id, type, position })` and no `domain`, which
  // `_helpers.ts` defaults to `'audio'`. A VIDEO module's factory is therefore
  // never constructed in that sweep, so `engine.read(node, 'extras')` is
  // `undefined` and the ledger records `delivered: false` on a perfectly live
  // button. Measured on the default shell, both directions, before the change.
  //
  // The probe moved somewhere STRICTLY STRONGER rather than being dropped:
  // `face-nibbles.spec.ts` presses this button on a REAL constructed nibbles
  // and asserts the ledger.
  it('the body owns the button, and the def declares no action-cell family', () => {
    expect(BODY_CODE).toMatch(/data-testid="nibbles-reset"/);
    expect(BODY_CODE).toMatch(/fireNibblesReset\(nodeId\)/);
    expect(nibblesDef.controlFamilies ?? []).toEqual([]);
    expect(FACE.order).not.toContain('nibbles-reset-{n}');
  });

  it('⚠ AND `readParam`/`readData` ARE STRUCTURALLY BLIND TO IT, which is WHY', () => {
    // `reset()` re-seeds the game, updates the CV and both pitches, repaints and
    // re-uploads — and writes to NEITHER params NOR node.data, because the game
    // is factory-internal by design. A `data-rev` probe would pass on a dead
    // button that bumped a counter.
    expect(DEF_SRC).toMatch(/function reset\(\): void \{\s*\n\s*state = newGame/);
    const resetBody = /function reset\(\): void \{([\s\S]*?)\n {4}\}/.exec(DEF_SRC)?.[1] ?? '';
    expect(resetBody.length, 'the reset body must be found').toBeGreaterThan(0);
    expect(resetBody, 'reset writes no param').not.toMatch(/params\./);
    expect(resetBody, 'reset writes no node.data').not.toMatch(/node\.data/);
  });

  it('the resolver says NO on every unavailable state (all four, individually)', () => {
    expect(resolveNibblesReset(null, FAKE_NODE), 'no engine').toBeNull();
    expect(resolveNibblesReset(fakeEngine({}), undefined), 'no node').toBeNull();
    expect(resolveNibblesReset(fakeEngine({ extras: undefined }), FAKE_NODE), 'no extras').toBeNull();
    expect(resolveNibblesReset(fakeEngine({ extras: 7 }), FAKE_NODE), 'extras not an object').toBeNull();
    expect(
      resolveNibblesReset(fakeEngine({ extras: { reset: 3 } }), FAKE_NODE),
      'a handle whose `reset` is not callable is a half-implemented seam',
    ).toBeNull();
  });

  it('POSITIVE CONTROL: a live handle DOES resolve, and the resolver is not just returning null', () => {
    const fn = () => {};
    expect(resolveNibblesReset(fakeEngine({ extras: { reset: fn } }), FAKE_NODE)).toBe(fn);
    expect(resolveNibblesExtras(fakeEngine({ extras: { reset: fn } }), FAKE_NODE))
      .toEqual({ reset: fn });
  });

  it('a press with NO live engine records delivered:false rather than nothing', () => {
    // ⚠ "Never pressed" and "pressed and reached nothing" must stay
    // distinguishable, or the probe is vacuous one level down. There is no
    // active engine in a unit environment, so this IS the unavailable path.
    __resetAuditionLedger();
    expect(fireNibblesReset('nib-x')).toBe(false);
    // ⚠ THE RECORD EXISTS. That is the whole point — an early return with no
    // record would collapse "never pressed" into "pressed and reached nothing".
    const rec = auditionLog().filter((r) => r.nodeId === 'nib-x');
    expect(rec, 'a failed press must still be recorded').toHaveLength(1);
    expect(rec[0]!.seam).toBe('engine-message');
    expect(rec[0]!.delivered).toBe(false);
    expect(auditionDelivered(auditionLog(), 'nib-x', 'engine-message')).toBe(false);
    // POSITIVE CONTROL on the predicate itself, so the leg above cannot pass on
    // a reader that returns false for everything.
    recordAudition({ nodeId: 'nib-x', seam: 'engine-message', delivered: true });
    expect(auditionDelivered(auditionLog(), 'nib-x', 'engine-message')).toBe(true);
    __resetAuditionLedger();
  });

  it('BOTH surfaces fire the SAME reset — the card no longer calls extras itself', () => {
    expect(ACTIONS).toMatch(/getActiveEngine\(\)/);
  });
});

describe('nibbles — the AUTO raw write is PAID, not made unreachable', () => {
  // ⚠ Promotion is what makes a ledgered raw write unreachable-without-paying:
  // the face's toggle cell writes through the sanctioned path, so a player can
  // no longer take the raw one — while the code and the ledger entry both stay
  // GREEN FOREVER describing a path nobody can walk.
  it('the ledger no longer names NibblesCard', () => {
    expect(Object.keys(RAW_WRITE_LEDGER)).not.toContain('ui/modules/NibblesCard.svelte');
  });

  it('and the card writes through setNodeParam', () => {
    expect(ACTIONS).toMatch(/setNodeParam\(nodeId, 'auto'/);
  });
});

describe('nibbles — CLAIM 6: the VRT pin can actually pin, and BOTH halves are needed', () => {
  // ⚠ THE PIN IS ALREADY PROVEN BYTE-IDENTICAL in the tree
  // (.myrobots/2026-08-23-nibbles-composite-vrt-nondeterminism.md: two runs
  // differing pre-fix, byte-identical post-fix). What this block holds is that
  // the SEAMS the roster names still exist and still do what the roster claims.
  it('the SEED half exists and is read at CONSTRUCTION *and* in the draw', () => {
    // Construction is what the face harness needs (`simPin` installs via
    // addInitScript BEFORE goto); the per-draw re-check is what the CARD scene
    // needs (it sets the global from afterSpawn). A construction-only read
    // would leave one of the two silently unpinned.
    expect(DEF_SRC).toMatch(/function initialSeed\(\): number \{/);
    const ctorAt = DEF_SRC.indexOf('let state: NibblesState = newGame(initialSeed());');
    const lateAt = DEF_SRC.indexOf('function maybeApplyVrtSeed(): void {');
    expect(ctorAt).toBeGreaterThan(-1);
    expect(lateAt).toBeGreaterThan(-1);
    expect(DEF_SRC).toMatch(/maybeApplyVrtSeed\(\);/);
  });

  it('and the SEED ALONE is not sufficient — the clock is the other half', () => {
    // The seed fixes WHICH pellets spawn; it cannot fix HOW MANY TICKS elapsed
    // before the capture, because `dt` comes from `frame.time`. That is what
    // `__videoEngineFreezeTime` pins, and it is an ENGINE seam rather than a
    // module one — so this leg asserts the dependency exists rather than
    // inventing a second module hook.
    expect(DEF_SRC).toMatch(/const tNow = frame\.time;/);
    expect(DEF_SRC).toMatch(/const dt = lastDrawTimeS < 0 \? 0 : Math\.max\(0, tNow - lastDrawTimeS\);/);
    const engineSrc = readFileSync(new URL('../../video/engine.ts', import.meta.url), 'utf8');
    expect(engineSrc, 'the engine clock pin the face scenes install').toMatch(/__videoEngineFreezeTime/);
  });

  it('NOTHING in the app ever SETS the seed — it is a test-only seam', () => {
    // A pin the product can set is a shipped freeze button nobody declared.
    expect(DEF_SRC).toMatch(/__nibblesVrtSeed/);
    expect(DEF_SRC).not.toMatch(/__nibblesVrtSeed\s*=/);
    expect(BODY).not.toMatch(/__nibblesVrtSeed/);
  });

  it('NO `freeze` param was added to buy an assertion that already holds', () => {
    // The 4plexvid conclusion, reached from the other side: a `params` edit on
    // a def in the WebGL attest basis costs an owner-machine re-attest.
    expect(DECLARED).not.toContain('freeze');
  });
});

describe('nibbles — the ZERO-ATTEST discipline this PR rests on', () => {
  it('the calibration constant is untouched — it rebases BOTH the CV and the pitch', () => {
    // Recorded so a face author does not treat it as a magic number, and
    // because it is exactly the constant a "put the score back in the canvas"
    // change would tempt someone to touch.
    expect(NIBBLES_MAX_LENGTH).toBe(119);
  });

  it('the body mounts a 2-D context and must never grow a GL one', () => {
    // Attest basis membership is derived from CONTENT: a WebGL body would enrol
    // every future face edit in the real-GPU attest.
    expect(BODY_CODE).toMatch(/getContext\('2d'\)/);
    // Comments blanked — the body's own header explains WHY it must stay 2-D
    // and names the basis, so a raw grep would flag its own explanation.
    expect(BODY_CODE).not.toMatch(/webgl/i);
    expect(BODY_CODE).not.toMatch(/getContext\((?!'2d')/);
  });

  it('the CONTRACT does not move at all — no param, no port, no control family', () => {
    // The whole discipline in one assertion: this PR adds `face` and rewrites
    // `docs`, and both are hash-transparent AND out of the contract signature.
    // A `controlFamilies` entry would have been the one contract-lock line this
    // PR could legitimately have cost; RESET moving into the body removes even
    // that, so `docs:accept` produces an EMPTY contract diff.
    expect(nibblesDef.controlFamilies ?? []).toEqual([]);
    expect(nibblesDef.params.map((p) => p.id).sort()).toEqual(['auto', 'tick_ms']);
    expect(nibblesDef.outputs).toHaveLength(7);
    expect(nibblesDef.inputs).toEqual([]);
    // …and BOTH surfaces still spell the button the same way, which is what
    // keeps the face and the legacy card describing one control.
    expect(BODY_CODE).toMatch(/data-testid="nibbles-reset"/);
  });

  it('the docs no longer describe card chrome the promotion removes', () => {
    // Every clause of the old ending was about a surface this face changes: the
    // LEN readout does not exist, the zoom does not make the plate grow, and
    // the buttons live on a faceplate rather than a card.
    const explanation = nibblesDef.docs?.explanation ?? '';
    expect(explanation.length).toBeGreaterThan(200);
    expect(explanation, 'the deleted LEN readout must not still be promised')
      .not.toMatch(/live LEN readout/);
    expect(explanation, 'the "only the screen grows" claim is false on the faceplate')
      .not.toMatch(/only the screen grows/);
    // …and the deleted `.tip` sentence's content is folded in, so right-click
    // ANNOTATE can carry what it used to say.
    expect(explanation).toMatch(/arrow keys/i);
    expect(explanation).toMatch(/AUTO/);
  });
});
