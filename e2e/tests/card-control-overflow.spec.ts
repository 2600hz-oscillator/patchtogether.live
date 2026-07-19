// e2e/tests/card-control-overflow.spec.ts
//
// SYSTEMIC control-overflow gate — the regression net for the class of bug
// where a module card's controls spill OFF the card (they run past the right
// edge / below the bottom, or the card develops horizontal content overflow).
//
// Motivation (GRAINS OF VISION): the granular-video card packed ~19 faders into
// a 258px card whose 4-column grid couldn't hold them, so the FEEDBACK / REVERB
// / COMPOSITE controls ran off the right edge — "controls go way off the card,
// which is something we should have OVERALL tests against" (owner). Nothing in
// the suite asserted card layout bounds, so any card could quietly overflow.
// This file slams that door shut for EVERY module.
//
// WHAT IT ASSERTS (one test per module, mirrors the per-module-per-port sweep):
//   1. spawn the module solo, wait for its card to render + fonts to settle,
//   2. resolve the CARD ROOT element (.mod-card / .card / .moog-panel inside the
//      SvelteFlow node),
//   3. assert no in-flow, visible control/content element extends significantly
//      beyond the card's right OR bottom edge (getBoundingClientRect within a
//      small ~6px tolerance for borders/rounding), AND the card has no
//      horizontal content overflow (scrollWidth <= clientWidth + tol).
//
// The check is DOM/layout only (no pixel read, no signal poll), and video cards
// run with the per-frame GL draw frozen (freezeVideoRender) so the sweep stays
// cheap on CI's SwiftShader software renderer — same lever the handle-presence
// sweep uses. Added CI wall-time is comparable to ONE handle-presence pass.
//
// EXEMPT RATCHET: many EXISTING cards already overflow (a pre-existing debt
// backlog, NOT introduced here). Fixing them all is a separate campaign, so
// they land in EXEMPT_CONTROL_OVERFLOW — a frozen, one-reason-per-entry map
// capped by the RATCHET test at the bottom so it can only SHRINK. The gate is
// therefore GREEN today while still catching any NEW overflow a future card
// introduces. Follows the same convention as EXEMPT_FROM_VRT /
// BEHAVIORAL_MODULE_EXEMPT / EXEMPT_OUTPUT_EMIT_MODULES.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { REGISTRY, type RegistryModule } from './_registry';
import { driverFor } from './_drivers';

// ────────── Overflow tolerance ──────────
// A control's right/bottom edge may sit up to TOL px past the card's edge
// before we call it overflow. 6px absorbs sub-pixel layout rounding, 1px
// borders, and focus-ring insets WITHOUT masking the Grains-class "way off
// the card" failure (those spill tens-to-hundreds of px). Same threshold
// applies to the card's own horizontal content overflow.
const OVERFLOW_TOL_PX = 6;

// ────────── Module-level spawn skips ──────────
// Mirrors per-module-per-port.spec.ts SKIP_SPAWN: modules that don't render a
// normal flow-card body under bare spawnPatch have no card bounds to measure.
const SKIP_SPAWN: Record<string, string> = {
  group: 'requires data.children; no standalone card body (covered by grouping-phase1.spec.ts)',
  cadillac: 'roaming overlay sprite, not a flow card (zero ports); covered by cadillac.spec.ts',
};

// ────────── EXEMPT RATCHET — cards with KNOWN pre-existing overflow ──────────
// Format: `<moduleType>` → one-line reason (measured overflow + where the real
// layout fix belongs). Every entry is layout DEBT we still owe; the RATCHET
// test caps the list so it can only shrink. Adding a NEW entry (or letting a
// non-exempt card regress) fails the gate on purpose.
//
//   RATCHET RULE: exemptions only shrink. LOWER the cap when you fix a card's
//   layout and delete its entry. Only RAISE it for a genuinely new, documented
//   pre-existing overflow — NEVER to make a red sweep go green for a card whose
//   overflow this PR (or a future one) newly introduced.
//
// (Populated from the full-registry sweep — see the PR body for the measured
// per-card overflow figures. GRAINS OF VISION is deliberately NOT here: its card
// was widened + tightened in this PR so it PASSES.)
const EXEMPT_CONTROL_OVERFLOW: Record<string, string> = {
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

// ────────── Heavy-WebGL predicate + render freeze (copied from per-module-per-port) ──────────
//
// A module touches the video GL pipeline if it has ANY video / mono-video port
// on EITHER side (NOT just domain === 'video' — WAVESCULPT is audio-domain with
// a 3D viewport). Those cards mount the VideoEngine, whose per-frame draw is
// brutally slow on CI's SwiftShader renderer. This bounds check is layout-only,
// so we freeze the per-frame draw (the card still mounts + lays out its chrome).
function touchesVideo(mod: RegistryModule): boolean {
  return (
    mod.hasVideoOutput ||
    mod.outputs.some((p) => p.type === 'video' || p.type === 'mono-video') ||
    mod.inputs.some((p) => p.type === 'video' || p.type === 'mono-video')
  );
}

async function freezeVideoRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as unknown as { __videoEngineFreezeRender?: boolean })
      .__videoEngineFreezeRender = true;
  });
}

// Spawn a module solo (same shape as the per-module-per-port handle sweep).
async function spawnSolo(page: Page, mod: RegistryModule): Promise<void> {
  const driver = driverFor(mod);
  const nodes: SpawnNode[] = [
    {
      id: 'sut',
      type: mod.type,
      position: { x: 400, y: 60 },
      domain: mod.domain,
      params: driver.params,
    },
  ];
  const edges: SpawnEdge[] = [];
  await spawnPatch(page, nodes, edges);
}

// ────────── Page-side overflow measurement ──────────
//
// Resolves the card root and returns the worst right/bottom control overflow +
// the card's own horizontal content overflow, plus a short descriptor of the
// worst offender so a failure message names it. Runs ENTIRELY in the browser.
interface OverflowReport {
  found: boolean;
  cardW: number;
  cardH: number;
  horizontalOverflow: number; // scrollWidth - clientWidth (card root)
  worstRight: number; // max (control.right - card.right)
  worstRightSel: string;
  worstBottom: number; // max (control.bottom - card.bottom)
  worstBottomSel: string;
}

async function measureOverflow(page: Page, nodeType: string): Promise<OverflowReport> {
  return await page.evaluate((type) => {
    const empty: OverflowReport = {
      found: false, cardW: 0, cardH: 0, horizontalOverflow: 0,
      worstRight: 0, worstRightSel: '', worstBottom: 0, worstBottomSel: '',
    };
    const flowNode =
      (document.querySelector(`.svelte-flow__node-${type}`) as HTMLElement | null) ??
      (document.querySelector('.svelte-flow__node[data-id="sut"]') as HTMLElement | null);
    if (!flowNode) return empty;
    const card =
      (flowNode.querySelector('.mod-card, .card, .moog-panel') as HTMLElement | null) ?? flowNode;
    const cardRect = card.getBoundingClientRect();
    if (cardRect.width === 0 || cardRect.height === 0) return empty;

    // Short human descriptor for the offending element (testid > id > tag.class).
    const describe = (el: Element): string => {
      const tid = el.getAttribute('data-testid');
      if (tid) return `[${tid}]`;
      const pid = el.getAttribute('data-port-id') ?? el.getAttribute('data-param-id');
      if (pid) return `${el.tagName.toLowerCase()}#${pid}`;
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
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
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const ro = r.right - cardRect.right;
      const bo = r.bottom - cardRect.bottom;
      if (ro > worstRight) { worstRight = ro; worstRightSel = describe(el); }
      if (bo > worstBottom) { worstBottom = bo; worstBottomSel = describe(el); }
    }

    return {
      found: true,
      cardW: Math.round(cardRect.width),
      cardH: Math.round(cardRect.height),
      horizontalOverflow: Math.round((card.scrollWidth - card.clientWidth) * 10) / 10,
      worstRight: Math.round(worstRight * 10) / 10,
      worstRightSel,
      worstBottom: Math.round(worstBottom * 10) / 10,
      worstBottomSel,
    };
  }, nodeType);
}

// Settle: fonts affect label widths (a late-loading font can change a control's
// measured width), so wait for fonts.ready + two rAFs after the card is visible
// before measuring. Deterministic + cheap — no signal poll.
async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try { await (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready; }
    catch { /* fonts API absent — ignore */ }
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}

// ────────── Tests ──────────

test.describe.configure({ mode: 'parallel' });

test.describe('per-module: card controls fit within card bounds', () => {
  for (const mod of REGISTRY) {
    const title = `${mod.type}: controls fit within the card (no overflow past right/bottom edge)`;

    const skipReason = SKIP_SPAWN[mod.type];
    if (skipReason) {
      test.fixme(`${title} [SKIPPED: ${skipReason}]`, () => {});
      continue;
    }

    const exemptReason = EXEMPT_CONTROL_OVERFLOW[mod.type];
    if (exemptReason) {
      // Known pre-existing overflow debt (see EXEMPT_CONTROL_OVERFLOW). The
      // module still exists in the sweep as documented debt; the RATCHET test
      // caps the list so it can only shrink.
      test.fixme(`${title} [EXEMPT: ${exemptReason}]`, () => {});
      continue;
    }

    test(title, async ({ page }) => {
      // Video cards mount the GL pipeline; freeze the per-frame draw (layout-
      // only check) so the sweep stays cheap on SwiftShader. Keyed on any video
      // PORT (not domain) so audio-domain viewport cards (WAVESCULPT) also skip
      // the draw.
      if (touchesVideo(mod)) {
        await freezeVideoRender(page);
        // Cold GL first-paint of the card chrome is slower on SwiftShader; give
        // it a generous per-test budget (the check itself is instant).
        test.setTimeout(60_000);
      }

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

      await spawnSolo(page, mod);

      const card = page.locator(`.svelte-flow__node-${mod.type}`);
      await expect(card, `${mod.type} card visible`).toBeVisible();
      await settleLayout(page);

      const r = await measureOverflow(page, mod.type);
      expect(r.found, `${mod.type}: card root element resolved for measurement`).toBe(true);

      const detail =
        `card ${r.cardW}×${r.cardH}px · ` +
        `worst RIGHT overflow ${r.worstRight}px (${r.worstRightSel || 'none'}) · ` +
        `worst BOTTOM overflow ${r.worstBottom}px (${r.worstBottomSel || 'none'}) · ` +
        `horizontal content overflow ${r.horizontalOverflow}px`;

      expect(
        r.worstRight,
        `${mod.type}: a control extends ${r.worstRight}px past the card's RIGHT edge — ${detail}`,
      ).toBeLessThanOrEqual(OVERFLOW_TOL_PX);
      expect(
        r.worstBottom,
        `${mod.type}: a control extends ${r.worstBottom}px past the card's BOTTOM edge — ${detail}`,
      ).toBeLessThanOrEqual(OVERFLOW_TOL_PX);
      expect(
        r.horizontalOverflow,
        `${mod.type}: the card has ${r.horizontalOverflow}px of horizontal content overflow — ${detail}`,
      ).toBeLessThanOrEqual(OVERFLOW_TOL_PX);
    });
  }
});

// ─── RATCHET — control-overflow exemption cap ────────────────────────────────
// EXEMPT_CONTROL_OVERFLOW lets a card with KNOWN pre-existing overflow OPT OUT
// of the bounds assertion. Every entry is layout debt we still owe. This cap
// FREEZES the list at today's size so it can only SHRINK as cards are fixed —
// adding a NEW exemption fails this test on purpose.
//   RATCHET RULE: exemptions only shrink. LOWER the number when you fix a card
//   and delete its entry. Only RAISE it for a genuinely new, documented
//   pre-existing overflow — NEVER to make a red sweep go green.
test('RATCHET: control-overflow exemption list only shrinks', () => {
  expect(
    Object.keys(EXEMPT_CONTROL_OVERFLOW).length,
    'EXEMPT_CONTROL_OVERFLOW grew past its frozen cap — see the RATCHET rule above',
  ).toBeLessThanOrEqual(6); // FROZEN at 6 (2026-07-19): the pre-existing overflow backlog found by the first full-registry sweep — clipplayer (transport row ~49px right) + cloudseed (EQ knob ~13px right) + graphicEq (~15px bottom) + ruttetra (~87px bottom, resizable default) + synesthesia (~7px bottom, marginal) + wavesculpt (~282px bottom, resizable default). GRAINS OF VISION was FIXED (widened 2hp→4hp + 2-col layout) so it is NOT exempt. Lower this cap as each card is reflowed.
});
