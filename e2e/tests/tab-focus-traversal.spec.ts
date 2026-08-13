// e2e/tests/tab-focus-traversal.spec.ts
//
// NATIVE TAB FOCUS TRAVERSAL — the accessibility contract (#1508).
//
// ROOT CAUSE this pins against: bare TAB used to be the rack-flip shortcut.
// Canvas.svelte consumed it on a `window` keydown with `preventDefault()`
// everywhere outside a text input, so the browser's fundamental
// keyboard-navigation key did nothing but turn the rack around. For a
// keyboard-only or screen-reader user Tab is not one shortcut among many — it
// is the ONLY way to reach a control at all, so the shipping shell had no
// keyboard navigation. Shift-Tab was already exempted, which acknowledged half
// the problem. The flip moved to a bare letter (`RACK_FLIP_KEY`); Tab is
// native again.
//
// WHAT THIS ASSERTS, and why in this shape:
//
//   1) TRAVERSAL IS A PROPERTY, NOT A LIST. Pressing Tab N times must move
//      focus N times, to N DISTINCT elements, each one LATER IN DOCUMENT ORDER
//      than the last. That is what "Tab walks the focusable elements" means,
//      and it stays true as the shell's chrome changes — a hard-coded expected
//      element list would rot on the next topbar edit and prove nothing.
//
//   2) THE ACCUMULATOR LIVES IN THE PAGE. A `focusin` listener records the
//      trail and the spec reads it ONCE, instead of round-tripping
//      `document.activeElement` per press on the same main thread as the
//      subject. The assertion message carries `presses` / `moves` / the trail
//      so a failure says WHICH of "focus never moved" and "focus moved
//      somewhere unexpected" happened — they are different bugs.
//
//   3) BOTH OCCUPANCY STATES. The flip has a SINGLE-OWNER guard keyed on
//      `dockStore.fullViewNodeIds.length` (dock owns the key while the
//      full-view is open, canvas owns it when closed). That guard is where the
//      previous phase-divergence bug lived, so Tab is proven inert in BOTH —
//      and with the full-view OPEN, traversal is proven to walk INTO the dock
//      pane and back OUT of it.
//
//   4) THE INSTRUMENT IS NEGATIVE-CONTROLLED, PERMANENTLY. The same in-page
//      accumulator that records N moves for Tab must record ZERO for the flip
//      key — which DOES flip. One probe, two opposite readings, both legs
//      permanent: a trail that came back empty because the listener never
//      installed would fail the Tab leg, and a trail that fills up regardless
//      of the key would fail the flip leg.
//
// Runs on /rack (no DB/relay) — the normal e2e lane.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressFlipKey, RACK_FLIP_KEY } from './_flip-key';

test.describe.configure({ mode: 'serial' });

/** One recorded focus stop: a stable descriptor plus its document-order rank
 *  among the focus stops seen so far (computed in-page via
 *  compareDocumentPosition, which needs the live nodes). */
interface FocusStop {
  /** tag + testid/aria-label/id, enough to read a failure without guessing. */
  label: string;
  /** True when this stop is INSIDE the dock full-view drawer. */
  inDock: boolean;
  /** True when this stop comes AFTER the previous stop in document order. */
  advanced: boolean;
}

declare global {
  interface Window {
    __focusTrail?: FocusStop[];
    __focusTrailStop?: () => void;
  }
}

/**
 * Install the in-page focus accumulator and clear any previous trail.
 *
 * `focusin` (not `focus`) because it bubbles, so ONE document-level listener
 * sees every stop regardless of where focus lands. Document order is compared
 * against the PREVIOUS stop at record time, while both nodes are still live.
 */
async function startFocusTrail(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__focusTrailStop?.();
    window.__focusTrail = [];
    let prev: Element | null = null;
    const onFocusIn = (ev: Event) => {
      const el = ev.target;
      if (!(el instanceof Element)) return;
      const testid = el.getAttribute('data-testid');
      const label = [
        el.tagName.toLowerCase(),
        testid ? `[data-testid=${testid}]` : '',
        el.getAttribute('aria-label') ? `[aria-label=${el.getAttribute('aria-label')}]` : '',
        el.id ? `#${el.id}` : '',
      ]
        .filter(Boolean)
        .join('');
      const advanced =
        prev === null
          ? true
          : (prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      window.__focusTrail!.push({
        label,
        inDock: !!el.closest('[data-testid="dock-fullview-drawer"]'),
        advanced,
      });
      prev = el;
    };
    document.addEventListener('focusin', onFocusIn, true);
    window.__focusTrailStop = () => document.removeEventListener('focusin', onFocusIn, true);
  });
}

/** Read the recorded trail (ONE round-trip, after all the presses). */
async function readFocusTrail(page: Page): Promise<FocusStop[]> {
  return page.evaluate(() => window.__focusTrail ?? []);
}

/** How many elements the document can currently focus. Read live so the press
 *  budget below is DERIVED from the page rather than typed at it. */
async function focusableCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sel =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
      ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return [...document.querySelectorAll(sel)].filter(
      (el) => el instanceof HTMLElement && el.offsetParent !== null,
    ).length;
  });
}

/** Drop focus to <body> so the next Tab starts at the document's first stop. */
async function resetFocus(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  // 15s FIRST-LOAD budget — the CI-validated number workflow-rear-card.spec.ts
  // uses for this exact route (SvelteKit dev compiles /rack on demand).
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function openFullView(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
  );
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
    nodeId,
  );
  await expect(page.locator(`[data-testid="dock-full-view"][data-fullview-node="${nodeId}"]`)).toBeVisible();
}

function canvasFlow(page: Page) {
  return page.locator('div.flow');
}

/** Press Tab `n` times and hand back what the in-page accumulator recorded. */
async function tabTimes(page: Page, n: number): Promise<FocusStop[]> {
  await startFocusTrail(page);
  for (let i = 0; i < n; i++) await page.keyboard.press('Tab');
  return readFocusTrail(page);
}

// ── (1) full-view CLOSED: Tab traverses, and does NOT flip the rack ─────────

test('full-view CLOSED: Tab advances focus through the shell and never flips the rack', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);

  const flipBtn = page.getByTestId('flip-rack-btn');
  await expect(canvasFlow(page), 'the rack starts front-side').not.toHaveClass(/rear-view/);
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');

  // PRESS BUDGET, derived: walk a handful of stops but stay strictly inside
  // one lap, so "focus wrapped to the top" can never be mistaken for "focus
  // went backwards". 8 is a RUNTIME cap on how long the walk takes, not a
  // claim about how many focusable elements the shell has.
  const focusables = await focusableCount(page);
  expect(focusables, 'the shell must have focusable chrome to traverse at all').toBeGreaterThan(1);
  const presses = Math.min(8, focusables - 1);

  await resetFocus(page);
  const trail = await tabTimes(page, presses);

  const labels = trail.map((s) => s.label);
  const detail = `presses=${presses} moves=${trail.length} focusables=${focusables} trail=${labels.join(' → ')}`;

  // (a) EVERY Tab moved focus. This is the whole #1508 regression: pre-fix the
  //     handler called preventDefault() and the trail came back EMPTY.
  expect(trail.length, `every Tab must move focus — ${detail}`).toBe(presses);

  // (b) …each stop LATER IN DOCUMENT ORDER than the last. That is the whole
  //     property — and it subsumes distinctness, since no element follows
  //     itself. Deliberately NOT a list of expected ids: this stays true as
  //     the shell's chrome changes, where a list would rot on the next edit.
  expect(
    trail.filter((s) => !s.advanced).map((s) => s.label),
    `focus must advance in document order — ${detail}`,
  ).toEqual([]);

  // (c) …and the rack did NOT flip. The permanent regression leg: the flip
  //     state attribute is untouched by any number of Tab presses.
  await expect(canvasFlow(page), `Tab must not flip the rack — ${detail}`).not.toHaveClass(
    /rear-view/,
  );
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');
});

// ── (2) full-view OPEN: Tab walks INTO the dock pane and back OUT ───────────

test('full-view OPEN: Tab traverses into and out of the dock pane, flipping nothing', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'env');

  const drawer = page.getByTestId('dock-fullview-drawer');
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');

  // PRESS BUDGET: comfortably more than one traversal lap from <body>, so the
  // walk is GUARANTEED to reach the dock and come out the far side.
  //
  // ⚠ It BOUNDS the walk; the PATTERN in the trail is the gate. Two earlier
  // drafts got this wrong in ways that read exactly like product bugs:
  //
  //   * sizing the walk from a hand-rolled "focusable elements" query and
  //     asserting focus had left the pane by exactly that many presses —
  //     measured: the query said 6 in-pane stops, the browser walked 7;
  //   * asserting one focus MOVE per press across a multi-lap walk —
  //     measured: 96 presses, 93 moves, because the wrap at the end of each
  //     lap lands on <body>, which fires no `focusin`. Exactly 3 laps, exactly
  //     3 "missing" moves. Not a hijacked key; an instrument that counted
  //     something slightly different from what it claimed.
  //
  // So "every press moves focus" is asserted by the CLOSED test above, which
  // stays strictly inside one lap. This test owns the INTO/OUT-OF pattern,
  // which is wrap-proof: a hijacked Tab produces an EMPTY trail and reddens
  // here just as loudly.
  const focusables = await focusableCount(page);
  expect(focusables, 'the shell must have focusable chrome to traverse at all').toBeGreaterThan(0);
  const presses = focusables + 1;

  await resetFocus(page);
  const trail = await tabTimes(page, presses);
  const labels = trail.map((s) => s.label);
  const detail =
    `presses=${presses} moves=${trail.length} focusables=${focusables} ` +
    `inDock=${trail.filter((s) => s.inDock).length} trail=${labels.join(' → ')}`;

  // (a) Tab moved focus at all — the trail is not empty (the shape a hijacked
  //     Tab leaves behind).
  expect(trail.length, `Tab must move focus with the dock open — ${detail}`).toBeGreaterThan(0);

  // (b) Traversal went INTO the dock pane and back OUT of it: some in-dock
  //     stop is followed, later in the same walk, by a stop outside it.
  const firstInDock = trail.findIndex((s) => s.inDock);
  expect(firstInDock, `focus must walk INTO the dock pane — ${detail}`).toBeGreaterThanOrEqual(0);
  expect(
    trail.slice(firstInDock).some((s) => !s.inDock),
    `focus must walk back OUT of the dock pane — ${detail}`,
  ).toBe(true);

  // (c) …and nothing flipped, in either owner's state.
  await expect(drawer, `Tab must not flip the dock panes — ${detail}`).toHaveAttribute(
    'data-fullview-flipped',
    'false',
  );
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
});

// ── (3) the NEW binding still flips — and moves NO focus ────────────────────
//
// The positive leg AND the instrument's negative control in one: the same
// accumulator that recorded a stop per Tab above must record NOTHING here,
// while the flip state DOES move. If the probe were broken in the "always
// empty" direction test (1) reddens; in the "always full" direction this one
// does.

test(`the flip key (${RACK_FLIP_KEY}) still flips — canvas and dock — and moves no focus`, async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);

  const flipBtn = page.getByTestId('flip-rack-btn');

  // (a) full-view CLOSED → the CANVAS owns the key.
  await resetFocus(page);
  await startFocusTrail(page);
  await pressFlipKey(page);
  await expect(canvasFlow(page), 'the flip key must still flip the rack').toHaveClass(/rear-view/);
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'true');
  let trail = await readFocusTrail(page);
  expect(
    trail.map((s) => s.label),
    `the flip key must not move focus — trail=${trail.map((s) => s.label).join(' → ')}`,
  ).toEqual([]);

  await pressFlipKey(page);
  await expect(canvasFlow(page), 'and flip back').not.toHaveClass(/rear-view/);
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');

  // (b) full-view OPEN → the DOCK owns the key, and ONLY the dock moves
  //     (the single-owner guard is by occupancy, not listener order).
  await openFullView(page, 'env');
  const drawer = page.getByTestId('dock-fullview-drawer');
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');

  await resetFocus(page);
  await startFocusTrail(page);
  await pressFlipKey(page);
  await expect(drawer, 'the flip key must still flip the dock panes').toHaveAttribute(
    'data-fullview-flipped',
    'true',
  );
  await expect(
    canvasFlow(page),
    'exactly ONE owner acts per keystroke — the canvas must not flip behind the dock',
  ).not.toHaveClass(/rear-view/);
  trail = await readFocusTrail(page);
  expect(
    trail.map((s) => s.label),
    `the flip key must not move focus — trail=${trail.map((s) => s.label).join(' → ')}`,
  ).toEqual([]);
});

// ── (4) the flip key is INERT in a typing context (it is a letter now) ──────
//
// Bare Tab needed no such guard; a letter does. TWO different guards cover
// two different elements, and they are asserted separately because only one
// of them is new:
//
//   * an <input> / <textarea> / contenteditable was ALREADY excluded by
//     `shouldIgnore()` at the top of the canvas keymap (it exists for the
//     undo/redo pair). Test (4a) is a regression leg on that;
//   * a <select> is NOT — `shouldIgnore` never looked at it, because Tab in a
//     select needs no guard. A letter does: it is select TYPE-AHEAD. That is
//     the line `isFlip` now adds via `isTypingTarget`, and test (4b) is its
//     negative control — measured: with that one line removed, (4a) still
//     passes and (4b) reddens.

test(`the flip key is inert while typing into a text field`, async ({ page }) => {
  // `?shell=legacy` renders the verbatim *Card.svelte inside the shell, which
  // is where the per-module NAME box lives — the text field a user really
  // types letters into. (The default shell route renders faceplate tiles and
  // has no name box; the flip owners are the same window listeners either way.)
  await page.goto('/rack?shell=legacy&seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);

  const nameBtn = page.locator('.svelte-flow__node[data-id="env"] [data-testid="name-label-button"]');
  await expect(nameBtn).toBeVisible();
  await nameBtn.click();
  const input = page.locator('[data-testid="name-label-input"]');
  await expect(input).toBeFocused();

  await input.fill('');
  const typed = `${RACK_FLIP_KEY}${RACK_FLIP_KEY}${RACK_FLIP_KEY}`;
  await input.pressSequentially(typed);

  await expect(
    canvasFlow(page),
    'typing the flip letter into a field must not flip the rack',
  ).not.toHaveClass(/rear-view/);
  await expect(input, 'and the letters must reach the field').toHaveValue(typed);
});

test(`the flip key is inert while a <select> has focus (type-ahead, not a flip)`, async ({ page }) => {
  await gotoWorkflow(page);

  // The audio buffer/latency picker is the shell's own <select>. A letter
  // pressed here is SELECT TYPE-AHEAD; `shouldIgnore()` does not screen a
  // select, so this is the case `isTypingTarget` in `isFlip` exists for.
  const select = page.getByTestId('audio-buffer-select');
  await expect(select).toBeVisible();
  await select.focus();
  await expect(select).toBeFocused();

  await page.keyboard.press(RACK_FLIP_KEY);

  await expect(
    canvasFlow(page),
    'the flip key must be inert while a <select> has focus',
  ).not.toHaveClass(/rear-view/);
  await expect(page.getByTestId('flip-rack-btn')).toHaveAttribute('aria-pressed', 'false');
});
