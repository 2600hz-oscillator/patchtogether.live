// e2e/tests/_card-overflow.ts
//
// The card-bounds overflow instrument, extracted VERBATIM from
// card-control-overflow.spec.ts (#1861) so it can be shared by the two callers
// that now exist:
//
//   * the consolidated registry sweep in io-spec-consistency.spec.ts — one
//     spawn per module, measured as one of that sweep's assertion groups, and
//   * card-control-overflow.spec.ts, which keeps the BACKDRAFT per-TV-mode
//     cases (controls that only EXIST in a non-default mode, which a
//     default-params sweep structurally cannot see).
//
// Nothing about the measurement changed in the move. The exemption map lives
// here rather than in either spec because a Playwright spec must never import
// another spec (that re-registers its tests); it is ANCHORED to REGISTRY by
// the anchor test in io-spec-consistency.spec.ts, which is where the sweep
// that consults it now lives.

import { expect, type Page } from '@playwright/test';

// ────────── Overflow tolerance ──────────
// A control's right/bottom edge may sit up to TOL px past the card's edge
// before we call it overflow. 6px absorbs sub-pixel layout rounding, 1px
// borders, and focus-ring insets WITHOUT masking the Grains-class "way off
// the card" failure (those spill tens-to-hundreds of px). Same threshold
// applies to the card's own horizontal content overflow.
export const OVERFLOW_TOL_PX = 6;

// ────────── EXEMPTIONS — cards with KNOWN pre-existing overflow ──────────
// Format: `<moduleType>` → one-line reason (measured overflow + where the real
// layout fix belongs). Every entry is layout DEBT we still owe. Adding a NEW
// entry is a REVIEWED decision that appears in the diff as a named key plus a
// measured reason; letting a non-exempt card regress fails the gate on purpose.
//
//   RULE: delete a card's entry when you reflow its layout. Only ADD one for a
//   genuinely pre-existing, MEASURED overflow — NEVER to make a red sweep go
//   green for a card whose overflow this PR (or a future one) newly introduced.
//   The reason string must carry the measurement, because that string is the
//   whole of the review.
//
// (Populated from the full-registry sweep — see the PR body for the measured
// per-card overflow figures. GRAINS OF VISION is deliberately NOT here: its card
// was widened + tightened in that PR so it PASSES.)
export const EXEMPT_CONTROL_OVERFLOW: Record<string, string> = {
  // CLIPPLAYER (3u/hp2 = 360×540) — the title/transport button row
  // (span.title-btns) runs ~49px past the card's RIGHT edge (51px horizontal
  // content overflow), and the body is ~21px too tall. The transport chrome
  // was authored wider than the 2hp tier. Fix = widen the tier or wrap/condense
  // the title-button row so it fits.
  clipplayer: 'title/transport button row (title-btns) extends ~49px past the RIGHT edge + 51px horizontal content overflow (body ~21px too tall) on the 3u/hp2 tier; fix = widen tier or wrap the transport chrome',
  // CLOUDSEED (3u/hp4 = 720×540) — the EQ low-pass knob (cs-eq-lp) in the
  // bottom mix/EQ panel sits ~13px past the card's RIGHT edge (~14px horizontal
  // content overflow). The 4-panel + bottom-EQ layout is a hair too wide for
  // the tier. Fix = tighten the EQ panel column widths or widen the tier.
  cloudseed: 'EQ low-pass knob (cs-eq-lp) extends ~13px past the RIGHT edge (~14px horizontal content overflow) on the 3u/hp4 tier; fix = tighten the bottom EQ panel or widen the tier',
  // GRAPHIC EQ (2u/hp2 = 360×360) — the controls block (graphicEq-controls)
  // extends ~15px below the card's BOTTOM edge. The preview + controls stack is
  // taller than the 2u tier. Fix = shorten the controls row or take a taller
  // tier.
  graphicEq: 'controls block (graphicEq-controls) extends ~15px past the BOTTOM edge on the 2u/hp2 tier; fix = shorten the controls row or take a taller tier',
  // RUTTETRA (user-resizable / DYNAMIC_SIZED) — at its DEFAULT size the fader
  // grid extends ~87px below the card's BOTTOM edge. The corner-resize default
  // is shorter than the fader stack needs. Fix = raise the default/min height so
  // the controls fit before the user resizes.
  ruttetra: 'DEFAULT-size fader grid extends ~87px past the BOTTOM edge (user-resizable card whose default min-height is shorter than its control stack); fix = raise the resize default/min height',
  // SYNESTHESIA (3u/hp2 = 360×540) — a descriptive copy block (div.copy) sits
  // ~7px below the card's BOTTOM edge (marginal — smallest of the debt). Fix =
  // trim the copy block's bottom margin or nudge the tier height.
  synesthesia: 'copy block (div.copy) extends ~7px past the BOTTOM edge on the 3u/hp2 tier (marginal — the smallest overflow in the debt list); fix = trim the copy block bottom margin',
  // WAVESCULPT (user-resizable / DYNAMIC_SIZED) — at its DEFAULT size the card
  // body extends ~282px below the BOTTOM edge (the 3D viewport + control stack
  // far exceed the default height). Fix = raise the default/min height, or gate
  // the assertion to a grown size, once the resizable layout is reflowed.
  wavesculpt: 'DEFAULT-size body extends ~282px past the BOTTOM edge (user-resizable viewport card whose default height is far shorter than its content); fix = raise the resize default/min height',
};

// ────────── Page-side overflow measurement ──────────
//
// Resolves the card root and returns the worst right/bottom control overflow +
// the card's own horizontal content overflow, plus a short descriptor of the
// worst offender so a failure message names it. Runs ENTIRELY in the browser.
//
// ⚠ EVERY REPORTED LENGTH IS IN **CSS PIXELS** — see `scale` below. Do NOT
//   "simplify" that normalisation away.
export interface OverflowReport {
  found: boolean;
  cardW: number; // CSS px
  cardH: number; // CSS px
  /** Effective screen-px-per-CSS-px of the card (xyflow viewport zoom). */
  scale: number;
  horizontalOverflow: number; // scrollWidth - clientWidth (card root) — already CSS px
  worstRight: number; // max (control.right - card.right), CSS px
  worstRightSel: string;
  worstBottom: number; // max (control.bottom - card.bottom), CSS px
  worstBottomSel: string;
}

export async function measureOverflow(page: Page, nodeType: string): Promise<OverflowReport> {
  return await page.evaluate((type) => {
    const empty: OverflowReport = {
      found: false, cardW: 0, cardH: 0, scale: 1, horizontalOverflow: 0,
      worstRight: 0, worstRightSel: '', worstBottom: 0, worstBottomSel: '',
    };
    // ⚠ BY NODE ID FIRST. xyflow stamps the wrapper class from the EMITTED node
    // type and every lane node emits `moduleShell`, so a per-type node class
    // matches nothing — and `found: false` is reported as a clean measurement
    // by every caller. The `data-shell-type` lookup is the by-type route that
    // still works; the per-type class is gone.
    const flowNode =
      (document.querySelector('.svelte-flow__node[data-id="sut"]') as HTMLElement | null) ??
      (document
        .querySelector(`[data-testid="module-shell"][data-shell-type="${type}"]`)
        ?.closest('.svelte-flow__node') as HTMLElement | null) ??
      null;
    if (!flowNode) return empty;
    const card =
      (flowNode.querySelector('[data-testid="module-shell"]') as HTMLElement | null) ?? flowNode;
    const cardRect = card.getBoundingClientRect();
    if (cardRect.width === 0 || cardRect.height === 0) return empty;

    // ── SCALE: report CSS px, NEVER viewport-scaled screen px ──────────────
    // xyflow applies a CSS `transform: scale(zoom)` to the flow pane for
    // viewport zoom, so every getBoundingClientRect() below comes back in
    // SCREEN pixels — i.e. multiplied by whatever zoom fit-view happened to
    // settle on for that spawn.
    //
    // PASS/FAIL is unaffected (an overflow of 0 is 0 at any scale, and the
    // tolerance is a hair either way), but every MAGNITUDE this gate PRINTS is
    // wrong by 1/zoom, and this gate's diagnostics are how people SIZE cards.
    // Concretely: BACKDRAFT requests 720px and reported "cardW 530" at zoom
    // 0.736, so a real ~310px overflow read as ~230px — size the card against
    // that number and you under-provision by ~80px and ship a second near-miss.
    // It also makes figures INCOMPARABLE ACROSS RUNS: two spawns of the same
    // card reported 707 vs 530 purely because fit-view settled differently.
    //
    // `offsetWidth` is LAYOUT (CSS) px and is immune to ancestor transforms,
    // while `getBoundingClientRect().width` includes them — so their ratio IS
    // the effective scale, with no dependency on xyflow internals (and it keeps
    // working for a card plain-mounted outside the flow pane, e.g. the dock).
    // Everything derived from a client rect is divided by it below.
    //
    // NOTE: `scrollWidth`/`clientWidth` are ALREADY layout px — the horizontal
    // content-overflow figure must NOT be divided.
    const scale =
      card.offsetWidth > 0 ? cardRect.width / card.offsetWidth : 1;
    const toCss = (px: number): number => (scale > 0 ? px / scale : px);

    // Short human descriptor for the offending element (testid > id > tag.class).
    const describe = (el: Element): string => {
      const tid = el.getAttribute('data-testid');
      if (tid) return `[${tid}]`;
      const pid = el.getAttribute('data-port-id') ?? el.getAttribute('data-param-id');
      if (pid) return `${el.tagName.toLowerCase()}#${pid}`;
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
    };

    /** The visible rect of `el` — its own box intersected with every CLIPPING
     *  ancestor between it and `card` (inclusive).
     *
     *  ⚠ WITHOUT THIS THE GATE REPORTS OVERFLOW THAT CANNOT PAINT. A live glyph
     *  strip is deliberately drawn oversized inside a `overflow: hidden` body so
     *  it fills its band; its BOX hangs 44–52 px below the tile while not a
     *  pixel of it renders there. Comparing raw `getBoundingClientRect()` against
     *  the tile called that a control running off the surface — 25 modules'
     *  worth of it, all of them clipped, none of them visible. A clipped child
     *  is not an overflow, so the comparison is against the CLIPPED rect. */
    const visibleRect = (el: Element): DOMRect => {
      const r = el.getBoundingClientRect();
      let top = r.top, right = r.right, bottom = r.bottom, left = r.left;
      // ⚠ STOP BEFORE `card` — ITS OWN CLIP MUST NOT EXCUSE THE OVERFLOW.
      // `card` is the box being measured against, and it clips
      // (`module-shell` is `overflow: hidden`). Folding its rect in here would
      // clamp EVERY descendant to the card and make the gate structurally
      // incapable of reporting anything: worstRight/worstBottom would be 0 for
      // all input, forever green. Only clips STRICTLY INSIDE the card count.
      let a: Element | null = el.parentElement;
      while (a && a !== card) {
        const acs = getComputedStyle(a);
        if (acs.overflowX !== 'visible' || acs.overflowY !== 'visible') {
          const ar = a.getBoundingClientRect();
          if (acs.overflowX !== 'visible') {
            left = Math.max(left, ar.left);
            right = Math.min(right, ar.right);
          }
          if (acs.overflowY !== 'visible') {
            top = Math.max(top, ar.top);
            bottom = Math.min(bottom, ar.bottom);
          }
        }
        a = a.parentElement;
      }
      return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
    };

    let worstRight = 0, worstBottom = 0, worstRightSel = '', worstBottomSel = '';
    for (const el of Array.from(card.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      // Skip decorations + portaled/anchored chrome + hidden nodes:
      //  - absolute/fixed: stripes, patch triggers, the (opacity-0) handle
      //    stack, hover-only value tags, MIDI badges, corner lock glyph — these
      //    are intentionally edge-anchored and not "controls running off"; the
      //    horizontalOverflow (scrollWidth) check below is the backstop that
      //    still catches an absolutely-positioned element spilling right.
      //  - display:none / visibility:hidden / opacity:0: not visible.
      if (cs.position === 'absolute' || cs.position === 'fixed') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const r = visibleRect(el);
      if (r.width === 0 || r.height === 0) continue;
      // Screen px here; normalised to CSS px in the return below.
      const ro = r.right - cardRect.right;
      const bo = r.bottom - cardRect.bottom;
      if (ro > worstRight) { worstRight = ro; worstRightSel = describe(el); }
      if (bo > worstBottom) { worstBottom = bo; worstBottomSel = describe(el); }
    }

    return {
      found: true,
      cardW: Math.round(toCss(cardRect.width)),
      cardH: Math.round(toCss(cardRect.height)),
      scale: Math.round(scale * 1000) / 1000,
      // scrollWidth/clientWidth are layout px already — NOT scaled.
      horizontalOverflow: Math.round((card.scrollWidth - card.clientWidth) * 10) / 10,
      worstRight: Math.round(toCss(worstRight) * 10) / 10,
      worstRightSel,
      worstBottom: Math.round(toCss(worstBottom) * 10) / 10,
      worstBottomSel,
    };
  }, nodeType);
}

/** One-line, explicitly CSS-px-labelled summary used in every failure message. */
export function describeReport(r: OverflowReport): string {
  return (
    `card ${r.cardW}×${r.cardH} CSS px (viewport zoom ${r.scale}×) · ` +
    `worst RIGHT overflow ${r.worstRight} CSS px (${r.worstRightSel || 'none'}) · ` +
    `worst BOTTOM overflow ${r.worstBottom} CSS px (${r.worstBottomSel || 'none'}) · ` +
    `horizontal content overflow ${r.horizontalOverflow}px`
  );
}

// Settle: fonts affect label widths (a late-loading font can change a control's
// measured width), so wait for fonts.ready + two rAFs after the card is visible
// before measuring. Deterministic + cheap — no signal poll.
export async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try { await (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready; }
    catch { /* fonts API absent — ignore */ }
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}

/** Settle, measure, and assert the three bounds. `subject` prefixes every
 *  failure message so a consolidated sweep still names the module (and, for
 *  BACKDRAFT's mode cases, the mode) rather than failing anonymously. */
export async function assertControlsFitCard(
  page: Page,
  nodeType: string,
  subject: string,
  detailPrefix = '',
): Promise<void> {
  await settleLayout(page);

  const r = await measureOverflow(page, nodeType);
  expect(r.found, `${subject}: card root element resolved for measurement`).toBe(true);

  // All figures in CSS px (see the `scale` note in measureOverflow) — these
  // are the numbers you SIZE the card against, so they must be the card's
  // own coordinate system, not the zoomed screen's.
  const detail = `${detailPrefix}${describeReport(r)}`;

  expect(
    r.worstRight,
    `${subject}: a control extends ${r.worstRight}px past the card's RIGHT edge — ${detail}`,
  ).toBeLessThanOrEqual(OVERFLOW_TOL_PX);
  expect(
    r.worstBottom,
    `${subject}: a control extends ${r.worstBottom}px past the card's BOTTOM edge — ${detail}`,
  ).toBeLessThanOrEqual(OVERFLOW_TOL_PX);
  expect(
    r.horizontalOverflow,
    `${subject}: the card has ${r.horizontalOverflow}px of horizontal content overflow — ${detail}`,
  ).toBeLessThanOrEqual(OVERFLOW_TOL_PX);
}
