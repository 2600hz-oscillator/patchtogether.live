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
// EXEMPTIONS: many EXISTING cards already overflow (a pre-existing debt
// backlog, NOT introduced here). Fixing them all is a separate campaign, so
// they land in EXEMPT_CONTROL_OVERFLOW — a NAMED, one-reason-per-entry map,
// ANCHORED to REGISTRY by the test at the bottom of this file so an entry can
// never outlive the module it names. The gate is therefore GREEN today while
// still catching any NEW overflow a future card introduces. Follows the same
// convention as EXEMPT_FROM_VRT / BEHAVIORAL_MODULE_EXEMPT /
// EXEMPT_OUTPUT_EMIT_MODULES.

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
//
// ⚠ EVERY REPORTED LENGTH IS IN **CSS PIXELS** — see `scale` below. Do NOT
//   "simplify" that normalisation away.
interface OverflowReport {
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

async function measureOverflow(page: Page, nodeType: string): Promise<OverflowReport> {
  return await page.evaluate((type) => {
    const empty: OverflowReport = {
      found: false, cardW: 0, cardH: 0, scale: 1, horizontalOverflow: 0,
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
function describeReport(r: OverflowReport): string {
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
      // module still appears in the sweep as documented debt, and the anchor
      // test at the bottom keeps the key honest against REGISTRY.
      // ⚠ Because this is `test.fixme`, the card is NEVER MEASURED — see the
      // stated-scope note on the anchor test: an exempt card that has since
      // been reflowed stays exempt silently.
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

      await page.goto('/rack?shell=legacy&seed=none');
      await page.waitForLoadState('networkidle');

      await spawnSolo(page, mod);

      const card = page.locator(`.svelte-flow__node-${mod.type}`);
      await expect(card, `${mod.type} card visible`).toBeVisible();
      await settleLayout(page);

      const r = await measureOverflow(page, mod.type);
      expect(r.found, `${mod.type}: card root element resolved for measurement`).toBe(true);

      // All figures in CSS px (see the `scale` note in measureOverflow) — these
      // are the numbers you SIZE the card against, so they must be the card's
      // own coordinate system, not the zoomed screen's.
      const detail = describeReport(r);

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

// ─── BACKDRAFT TV MODES — controls that only EXIST in a non-default mode ─────
//
// The sweep above spawns every module at its DEFAULT params, which for BACKDRAFT
// means TV MODE = OFF — and a chunk of the card's chrome (the TV readout today;
// the VIRTUAL CAMERA ORIENTATION row on the branch that follows) only mounts
// when the mode is ON. So the sweep structurally CANNOT see those controls: it
// reports a clean card while the newest controls go unmeasured.
//
// That is not hypothetical. A ~310 CSS px bottom overflow sat on this card for
// hours precisely because the gate only ever ran it with TV MODE off. A gate
// with a real catch that cannot see the newest controls is a hole, so the modes
// are measured EXPLICITLY here.
//
// THE GUARD IS THE POINT: each case asserts the mode actually APPLIED
// (data-tv-mode on the card root) AND that mode-conditional chrome is mounted
// (the TV readout). Without that a param that silently failed to land would
// leave this measuring the OFF layout again and proving nothing.
//
// ALL THREE modes are measured, including the default OFF — and the OFF case
// carries an extra job. BACKDRAFT's rule is that a control which is inert in
// the MODEL is DIMMED, never `disabled` and never `{#if}`-ed away, because both
// of those make it unreachable while the gate CV path keeps writing the param.
// The OFF case is where that rule is observable: the TV SCREEN faders are inert
// there, so it asserts they are still VISIBLE and still ENABLED. That is also
// what keeps the card's height mode-INVARIANT, which is the property the three
// measurements below jointly pin.
//
// (The label list is the REAL mode vocabulary — BACKDRAFT_TV_MODE_LABELS in
// backdraft.ts is ['OFF','PURE TV','CRITICAL']. Mode 1 was long mislabelled
// 'VIRTUAL CAMERA' here, so every failure message named a mode that does not
// exist.)
test.describe('backdraft: controls fit in EVERY TV MODE, not just the default', () => {
  for (const [label, tvMode] of [['OFF', 0], ['PURE TV', 1], ['CRITICAL', 2]] as const) {
    test(`backdraft: controls fit within the card in TV MODE = ${label}`, async ({ page }) => {
      // Video card → freeze the per-frame GL draw + take the SwiftShader budget,
      // same levers as the sweep above.
      await freezeVideoRender(page);
      test.setTimeout(60_000);

      await page.goto('/rack?shell=legacy&seed=none');
      await page.waitForLoadState('networkidle');
      await spawnPatch(
        page,
        [{
          id: 'sut', type: 'backdraft', position: { x: 400, y: 60 },
          domain: 'video', params: { tvMode },
        }],
        [],
      );

      const card = page.locator('.svelte-flow__node-backdraft');
      await expect(card, 'backdraft card visible').toBeVisible();

      // (1) the mode actually landed on the card…
      await expect(
        page.locator('[data-testid="backdraft-card"]'),
        `backdraft card is in TV MODE ${label}`,
      ).toHaveAttribute('data-tv-mode', String(tvMode));
      // (2) …and the mode-CONDITIONAL chrome agrees with the mode. If this is
      //     missing we are measuring some other layout and proving nothing.
      if (tvMode === 0) {
        // OFF: the readout is the ONLY mode-conditional chrome, and it is gone.
        await expect(
          page.locator('[data-testid="backdraft-tv-readout"]'),
          'the TV readout is absent in OFF',
        ).toHaveCount(0);
        // ALL CONTROLS REMAIN USABLE. The TV SCREEN faders do nothing in OFF —
        // they are dimmed, and that is ALL they are. Still rendered (so the
        // card's height does not move with the mode) and still enabled (so drag
        // / dbl-click-reset / wheel / right-click MIDI-Learn all keep working,
        // and the UI cannot disagree with what the gate CV path is writing).
        const tvFaders = page.locator('.tv-bank [data-testid="backdraft-tv-screen-hint"], .tv-bank .bank-faders');
        await expect(
          page.locator('.tv-bank .bank-faders'),
          'TV SCREEN faders stay MOUNTED + VISIBLE while inert (dimmed, not hidden)',
        ).toBeVisible();
        await expect(tvFaders.first()).toBeVisible();
        // The VIRTUAL CAMERA bank is the SAME rule, and it is the one that got
        // it wrong first: it originally shipped behind `{#if tvOn}`, which is
        // precisely the unmount this sweep cannot see — the sweep spawns at
        // DEFAULT params (tvMode 0), so a control that only mounts in a non-
        // default mode goes unmeasured, which is how a ~310 CSS px overflow sat
        // on this card for hours. Asserting it VISIBLE here is what proves the
        // camera controls are reachable in the mode the sweep actually runs.
        await expect(
          page.locator('[data-testid="backdraft-cam-row"]'),
          'VIRTUAL CAMERA controls stay MOUNTED + VISIBLE in OFF (dimmed, never {#if}-ed away)',
        ).toBeVisible();
        await expect(
          page.locator('[data-testid="backdraft-cam-tilt-pad"]'),
          'the TILT joystick is reachable in the default mode',
        ).toBeVisible();
        await expect(
          page.locator('[data-testid="backdraft-cam-pos-pad"]'),
          'the POSITION joystick is reachable in the default mode',
        ).toBeVisible();
        const lockedOut = await page.locator('[data-testid="backdraft-card"]')
          .locator('button[disabled], input[disabled]')
          .count();
        expect(lockedOut, 'NO control on the card is disabled in the default mode').toBe(0);
      } else {
        await expect(
          page.locator('[data-testid="backdraft-tv-readout"]'),
          `TV-mode-only chrome is mounted in ${label}`,
        ).toBeVisible();
      }

      await settleLayout(page);

      const r = await measureOverflow(page, 'backdraft');
      expect(r.found, 'backdraft: card root resolved for measurement').toBe(true);
      const detail = `TV MODE ${label} · ${describeReport(r)}`;

      expect(r.worstRight, `backdraft RIGHT overflow — ${detail}`)
        .toBeLessThanOrEqual(OVERFLOW_TOL_PX);
      expect(r.worstBottom, `backdraft BOTTOM overflow — ${detail}`)
        .toBeLessThanOrEqual(OVERFLOW_TOL_PX);
      expect(r.horizontalOverflow, `backdraft horizontal content overflow — ${detail}`)
        .toBeLessThanOrEqual(OVERFLOW_TOL_PX);
    });
  }
});

// ─── ARTIFACT ANCHOR — every exemption key must still name a live module ─────
//
// ⚠ `toBeLessThanOrEqual(6)` on `Object.keys(EXEMPT_CONTROL_OVERFLOW).length`
// IS GONE (2026-08-10) — P0 owner directive, "ratchets are an anti pattern;
// remove all ratchets".
//
// WHAT IT WAS: a hand-typed population count frozen at 6 (2026-07-19) — the
// pre-existing overflow backlog found by the first full-registry sweep:
// clipplayer (transport row ~49px right), cloudseed (EQ knob ~13px right),
// graphicEq (~15px bottom), ruttetra (~87px bottom, resizable default),
// synesthesia (~7px bottom, marginal), wavesculpt (~282px bottom, resizable
// default). GRAINS OF VISION was fixed in that same PR (widened 2hp→4hp +
// 2-col layout) and is deliberately not exempt.
//
// WHAT IT PROTECTED, honestly: it was the ONLY thing that made a 7th exemption
// red. That protection is DROPPED — a future PR can now add a named exemption
// with a measured reason and no test goes red. That is the pre-authorised
// coverage loss of the kill-ratchets directive, and it is a smaller loss than
// it looks: the count could not tell a justified addition from an unjustified
// one, only that the number moved, and BOTH already show up as a named key
// plus a prose reason in the diff. Review the reason string; that was always
// the real gate.
//
// WHAT REPLACES IT is a protection the count NEVER had. EXEMPT_CONTROL_OVERFLOW
// had NO artifact anchor at all: it is read exactly once, as
// `EXEMPT_CONTROL_OVERFLOW[mod.type]` in the sweep above, so a key naming a
// module that was renamed or deleted is simply never consulted — a dead
// exemption, invisible, occupying a slot in a cap that was itself the only
// thing anyone was watching. The anchor below makes that RED. A name is
// checkable against the tree; a number never was.
//
// ⚠ STATED SCOPE — what this file STILL cannot see, and neither could the cap:
// an exempt card that has since been REFLOWED and no longer overflows stays
// exempt SILENTLY. The sweep `test.fixme`s an exempt module rather than
// measuring it, so there is no "unexpectedly passing" signal anywhere; the
// debt can only be reclaimed by a human re-running the card unexempted. Fixing
// that means measuring exempt cards and asserting they still overflow — a real
// change to the sweep's shape, deliberately not made here.
test('control-overflow exemption keys are anchored to REGISTRY', () => {
  const liveTypes = new Set(REGISTRY.map((m) => m.type));

  // ── VACUITY FLOOR ──
  // Every assertion below is a lookup against REGISTRY. If REGISTRY resolved
  // nothing, "no key is stale" would be trivially true and this test would pass
  // while proving NOTHING. This is a sanity FLOOR, not a ratchet: the tree
  // carries ~196 modules, so it only trips if the manifest is empty/truncated.
  expect(
    REGISTRY.length,
    'VACUITY: REGISTRY resolved almost no modules — the anchors below would pass trivially. '
    + 'Run `flox activate -- task test:emit-manifest` (e2e/.generated/registry-manifest.json).',
  ).toBeGreaterThan(100);

  // ── ARTIFACT ANCHOR ──
  // Ground truth is the REGISTRY module, not the list. A key that outlives the
  // module it names is a dead exemption the sweep can never consult.
  const moduleKeyIsLive = (moduleType: string): boolean => liveTypes.has(moduleType);

  expect(
    Object.keys(EXEMPT_CONTROL_OVERFLOW).filter((k) => !moduleKeyIsLive(k)).sort(),
    'STALE EXEMPTION: these EXEMPT_CONTROL_OVERFLOW keys name modules that are no longer in '
    + 'REGISTRY. The module was renamed or deleted, so `EXEMPT_CONTROL_OVERFLOW[mod.type]` can '
    + 'never match and the entry buys nothing — delete it. If the module was RENAMED, re-measure '
    + 'the new card before re-adding the key under its new name: the layout debt may be gone.',
  ).toEqual([]);

  // Same hole, same file: SKIP_SPAWN is read the identical way and was never
  // anchored either.
  expect(
    Object.keys(SKIP_SPAWN).filter((k) => !moduleKeyIsLive(k)).sort(),
    'STALE SKIP: these SKIP_SPAWN keys name modules that are no longer in REGISTRY — delete them.',
  ).toEqual([]);

  // ── PERMANENT NEGATIVE CONTROL, BOTH DIRECTIONS ──
  // Runs on EVERY execution, not once at authoring time. Without it, an anchor
  // that silently resolved nothing (empty manifest, a refactor that made the
  // resolver return `true` unconditionally) prints the same empty array as a
  // genuinely clean tree — "no stale keys" and "never looked" are
  // indistinguishable from the output. So force both answers out of the SAME
  // resolver the assertions above used.
  const liveType = REGISTRY[0]?.type;
  expect(liveType, 'NEGATIVE CONTROL: REGISTRY is empty').toBeTruthy();
  expect(
    moduleKeyIsLive('__no_such_module__'),
    'NEGATIVE CONTROL (false leg): the resolver called a non-existent module type LIVE — it '
    + 'accepts anything, so the stale-key assertions above are decoration.',
  ).toBe(false);
  expect(
    moduleKeyIsLive(liveType!),
    `NEGATIVE CONTROL (true leg): the resolver called the real module "${liveType}" STALE — it `
    + 'rejects everything, so it would have reddened on a clean tree.',
  ).toBe(true);
});
