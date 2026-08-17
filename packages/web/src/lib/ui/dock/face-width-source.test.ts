// packages/web/src/lib/ui/dock/face-width-source.test.ts
//
// THE GATE FOR "A FACEPLATE IS AS WIDE AS ITS CONTENT".
//
// ── THE RULING, AND THE DEFECT BEHIND IT ───────────────────────────────────
//
// Owner, 2026-08-17: *"also tidyvco is fully twice as wide as it needs to be,
// that needs to be fixed and any other new cards we have that are fucked like
// that need to be fixed"*, then generalised: *"we do not want useless gray
// horizontal space on cards, ever. prefer compact. screen real estate is
// expensive!"*
//
// The cause was one declaration: `.dock-faceplate .faceplate-body` carried
// `min-width: 900px`, the RACKLINE kit's frame width. Every element above it in
// the chain shrink-wraps (`.dock-fullview-pane`, `.dock-faceplate`,
// `.faceplate`, `.faceplate-scroll` are all `flex: 0 1 auto; min-width: 0`) and
// `.rl-tile` is `width: 100%`, so whatever floor was set there simply BECAME
// the faceplate's width. `.dock-pages` then stretched each band across it and
// `.page-controls` left-packed its cells, so the surplus painted as blank
// plate. MEASURED off the committed PNG headers: 39 of the 50 dock faces
// were EXACTLY 900 px wide, against ~450 px of real content on tidyVco. A modal
// 900 with a single outlier is the signature of a floor, not of thirty-nine
// faces that independently needed the same width.
//
// ⚠ AND IT HAD ALREADY GROWN TWO ESCAPE HATCHES, which is the part worth
// gating. `:has(.fp-card-frame)` (legacy cards, #1573) and
// `:has([data-shell-type='mixmstrs'])` (#1738) each landed after an owner
// review of one screenshot, each saying "…but not this occupant". A default
// that needs a new exemption per review is the wrong default. The next
// regression is not someone re-typing `900px`; it is someone adding a third
// per-module hatch instead of fixing the rule.
//
// ── WHY A SOURCE GATE, GIVEN THE MEASUREMENT EXISTS ────────────────────────
//
// The geometric check — content extent vs plate width, swept over the whole
// roster — lives in `e2e/vrt/workflow-shell-faces.spec.ts`, and it is the one
// that can actually say a face is too wide. ⚠ THAT SPEC *IS* IN THE REQUIRED
// LANE — verified on this PR, where all four `vrt-strict` shards reddened and
// every failure was `workflow-shell-faces.spec.ts`. (An older note in this repo
// says vrt-strict covers cards only; it is out of date, and believing it would
// have made this file look like the only gate.) They are still complements: the
// spec cannot run without a browser and a captured baseline, while this runs in
// the unit lane on every push and holds the MECHANISM the measurement is
// downstream of. This says the rule is right; that says it produced the result.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ───────────────────────────────
//
//   * WIDTH SET ANYWHERE ELSE. It reads the files in `WIDTH_CHAIN` and nothing
//     more. A px floor introduced in a component's `<style>` block, in an
//     inline style, or in a stylesheet not listed here is invisible. The e2e
//     measurement is what catches those, by their effect rather than by name.
//   * PIXELS. It cannot tell whether a face LOOKS right at its new width, or
//     whether narrowing clipped a control. `hiddenX === 0` in the dock scene is
//     that leg.
//   * A FACE THAT IS GENUINELY TOO WIDE FOR CONTENT REASONS — a band whose
//     cells simply do not pack. That is not a CSS floor and no source rule
//     could express it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The files that can set the dock faceplate's width. Named rather than globbed
 * so the gate's scope is legible, and so adding a file is a decision.
 */
const WIDTH_CHAIN = ['_dock-faceplate.css'] as const;

/**
 * A px floor big enough to be a PLATE width rather than a control's. Below this
 * a `min-width` is a knob column, a switch, a badge — legitimate physical
 * constants that have nothing to do with how wide a faceplate is.
 *
 * A policy threshold on a measured quantity, not a count of anything.
 */
const PLATE_SCALE_PX = 100;

/**
 * `min-width` floors at plate scale that are ALLOWED, each naming what needs
 * the room.
 *
 * ⚠ ANCHORED: an entry whose selector no longer appears in its file is RED, so
 * a refactor cannot leave a permission behind.
 */
const PLATE_FLOOR_EXEMPTIONS: readonly { file: string; selector: string; why: string }[] = [];

function css(file: string): string {
  return readFileSync(resolve(HERE, file), 'utf8');
}

/** Every `selector { … }` block in a stylesheet, comments removed. Crude by
 *  design — the declarations this gate looks for are flat, and a real CSS
 *  parser would be a dependency for no extra truth. */
function blocks(text: string): { selector: string; body: string }[] {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const selector = m[1]!.trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@')) continue;
    out.push({ selector, body: m[2]! });
  }
  return out;
}

describe('dock faceplate width — compact is the DEFAULT, not an exemption', () => {
  it('`.faceplate-body` is content-sized: no floor, `max-content`, clamped to the pane', () => {
    // The positive half. Every other assertion here is an absence, and an
    // absence cannot distinguish "the rule is right" from "the rule is gone".
    const body = blocks(css('_dock-faceplate.css')).find(
      (b) => b.selector === '.dock-faceplate .faceplate-body',
    );
    expect(body, 'the rule that sizes every curated faceplate has vanished').toBeTruthy();
    expect(body!.body, 'a px floor here IS the faceplate width — that was the tidyVco defect').toMatch(
      /min-width:\s*0\s*;/,
    );
    expect(body!.body, 'the plate must be its content').toMatch(/width:\s*max-content\s*;/);
    expect(
      body!.body,
      'and still clamp to the pane, so content wider than the drawer scrolls inside ' +
        '`.faceplate-scroll` instead of pushing the page sideways',
    ).toMatch(/max-width:\s*100%\s*;/);
  });

  it('no per-occupant escape hatch re-appears — the default is the rule', () => {
    // ⚠ THE SPECIFIC REGRESSION SHAPE. Both hatches that existed before this
    // ruling keyed a width override to ONE occupant (`:has(.fp-card-frame)`,
    // `:has([data-shell-type='mixmstrs'])`). Adding a third is how the wrong
    // default survives another review, so a module- or occupant-keyed width
    // override is denied outright rather than merely discouraged.
    const offenders = blocks(css('_dock-faceplate.css'))
      .filter((b) => /faceplate-body/.test(b.selector) && /:has\(/.test(b.selector))
      .filter((b) => /(^|[;\s])(min-)?width\s*:/.test(b.body))
      .map((b) => b.selector);
    expect(
      offenders,
      'a width override keyed to one occupant. If a face needs different width behaviour, ' +
        'the DEFAULT is wrong — fix the default. Per-module hatches are how `min-width: 900px` ' +
        'survived two owner reviews.',
    ).toEqual([]);
  });

  it('no plate-scale `min-width` floor in the width chain except the NAMED ones', () => {
    const exempt = new Set(PLATE_FLOOR_EXEMPTIONS.map((e) => `${e.file}::${e.selector}`));
    const offenders: string[] = [];
    for (const file of WIDTH_CHAIN) {
      for (const b of blocks(css(file))) {
        for (const m of b.body.matchAll(/min-width:\s*(\d+(?:\.\d+)?)px/g)) {
          if (Number(m[1]) < PLATE_SCALE_PX) continue;
          if (exempt.has(`${file}::${b.selector}`)) continue;
          offenders.push(`${file}::${b.selector} (min-width: ${m[1]}px)`);
        }
      }
    }
    expect(
      offenders,
      `a ${PLATE_SCALE_PX}px+ min-width in the faceplate width chain. Everything above ` +
        '`.faceplate-body` shrink-wraps and `.rl-tile` is `width: 100%`, so a floor here IS ' +
        'the faceplate width for every face at once. Either remove it or add a ' +
        'PLATE_FLOOR_EXEMPTIONS entry naming what needs the room.',
    ).toEqual([]);
  });

  it('ANCHOR: every floor exemption still names a live selector', () => {
    const dead = PLATE_FLOOR_EXEMPTIONS.filter(
      (e) => !blocks(css(e.file)).some((b) => b.selector === e.selector),
    ).map((e) => `${e.file}::${e.selector}`);
    expect(dead, 'an exemption names a selector that no longer exists — delete it').toEqual([]);

    const thin = PLATE_FLOOR_EXEMPTIONS.filter((e) => e.why.trim().length < 40).map(
      (e) => `${e.file}::${e.selector}`,
    );
    expect(thin, 'an exemption without a stated reason is a suppression').toEqual([]);
  });

  it('NEGATIVE CONTROL: the parser reads real rules, and the floor probe can fire', () => {
    // Anti-vacuity in both directions. A `blocks()` that returned [] — a bad
    // path, a regex that stopped matching — would green every absence above.
    const parsed = blocks(css('_dock-faceplate.css'));
    expect(parsed.length, 'the CSS probe parsed no rules at all').toBeGreaterThan(20);
    expect(
      parsed.some((b) => b.selector.includes('.faceplate-body')),
      'the probe did not find the rule this gate is about',
    ).toBe(true);
    // …and the detector really does detect: the exact declaration that caused
    // the defect, fed through the same parser.
    const synthetic = blocks('.dock-faceplate .faceplate-body { min-width: 900px; }');
    const caught = synthetic.some((b) =>
      [...b.body.matchAll(/min-width:\s*(\d+(?:\.\d+)?)px/g)].some(
        (m) => Number(m[1]) >= PLATE_SCALE_PX,
      ),
    );
    expect(caught, 'the floor detector does not detect the floor it exists for').toBe(true);
    // …and does NOT fire on a control-scale floor, which is a real constant.
    const control = blocks('.switch { min-width: 52px; }');
    const falsePositive = control.some((b) =>
      [...b.body.matchAll(/min-width:\s*(\d+(?:\.\d+)?)px/g)].some(
        (m) => Number(m[1]) >= PLATE_SCALE_PX,
      ),
    );
    expect(falsePositive, 'the detector eats legitimate control-scale constants').toBe(false);
  });
});
