// e2e/tests/clipplayer-grid-stability.spec.ts
//
// THE LAUNCH GRID MUST NOT MOVE WHEN YOU CLICK A PAD.
//
// Owner report: "i often end up in a state where trying to double click into an
// already existing pattern in row 1, causes me to end up in a new clip in row 3
// … it happens so consistently with that exact spacing that it seems
// deterministic." It is deterministic, and it is exactly +2 rows.
//
// MEASURED CAUSE (not inferred). `onCardClick` grabs focus so the card owns
// computer keys 1-8, and a bare `HTMLElement.focus()` asks the browser to scroll
// the focused element into view. On the CANVAS nothing above the card scrolls,
// so it never reproduced there. In the DOCK FULL-VIEW pane the card (540px) is
// taller than its scrollport (`.faceplate-scroll`, ~352px), so the browser
// scrolls the pane to align the card's top edge — by the card's offset inside
// the scroll content, measured 62px, which is EXACTLY two pad rows (28px pad +
// 3px gap = 31px pitch). That scroll lands BETWEEN the two clicks of a
// double-click, so click 1 hits data-clip=0 and click 2 hits data-clip=2. Fix:
// `focus({ preventScroll: true })`.
//
// The gate is the GEOMETRIC INVARIANT, not a re-enactment of the gesture: the
// grid's top must be bit-identical across a pad click. A rAF sampler INSIDE the
// page accumulates it (a Playwright-side poll loop would sample the same main
// thread it is measuring, and would miss a transient shift entirely) — and the
// instrument is NEGATIVE-CONTROLLED on every run by deliberately scrolling the
// pane one row and requiring the sampler to see it. A gate that cannot see the
// movement it forbids is decoration.
//
// UNITS: every figure here is CSS px in the DOCK pane, which carries no xyflow
// zoom transform (asserted). Deltas are also reported in ROWS so a failure reads
// as "the grid slid N rows", which is the user-visible fault.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'default' });

async function gotoShellWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  // 15s first-load budget (the workflow-shell.spec.ts pattern — cold dev-server
  // compile latency on the very first /rack load).
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open a node's dock full-view via the same dockStore call the tile EXPAND pill
 *  makes (the shipped `__openDockFullView` hook). */
async function openFullView(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
  );
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
    nodeId,
  );
  await expect(
    page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${nodeId}"]`),
  ).toBeVisible();
}

/** Everything must be scoped to the DOCK PANE: while a node is expanded the
 *  SAME card is mounted twice (the canvas node and the pane), so a bare
 *  `[data-clip="0"]` is ambiguous and a page-side `querySelector` silently
 *  resolves the canvas copy — which is exactly the "wrong instrument, confident
 *  number" failure this file exists to guard against. */
const PANE = '[data-testid="dock-fullview-pane"][data-pane-node="cp"]';

type Rec = { tops: number[]; stop: () => void };
type W = {
  __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
  __gridRec?: Rec;
};

/** Sample the grid's viewport top on every animation frame, IN THE PAGE. The
 *  accumulated array survives a main-thread stall, so "never moved" and "never
 *  looked" are distinguishable from the output (we report the sample count). */
async function startSampler(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const w = globalThis as unknown as W;
    w.__gridRec?.stop();
    const tops: number[] = [];
    let raf = 0;
    const sample = () => {
      const g = document.querySelector(`${sel} [data-testid="clipplayer-grid"]`);
      if (g) tops.push(+g.getBoundingClientRect().top.toFixed(2));
    };
    // Take t0 SYNCHRONOUSLY. The first rAF callback is up to a frame away, and
    // a CDP round-trip is faster than that — waiting for it loses the baseline
    // and makes every delta read as 0 (which is how the negative control caught
    // this sampler bug on its first run).
    sample();
    const tick = () => { sample(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    w.__gridRec = { tops, stop: () => cancelAnimationFrame(raf) };
  }, PANE);
}

async function readSampler(page: Page): Promise<{ samples: number; distinct: number[]; span: number }> {
  return page.evaluate(() => {
    const r = (globalThis as unknown as W).__gridRec!;
    r.stop();
    const distinct = [...new Set(r.tops)].sort((a, b) => a - b);
    return {
      samples: r.tops.length,
      distinct,
      span: distinct.length ? +(distinct[distinct.length - 1] - distinct[0]).toFixed(2) : 0,
    };
  });
}

/** A genuine slow double-click at ONE screen point: two full press/release
 *  pairs, clickCount 1 then 2, so Chromium emits the real `dblclick`. The gap is
 *  incidental — the pane scrolled on the FIRST click's handler either way — so
 *  this is not a timing-tuned assertion. */
async function slowDblClick(page: Page, x: number, y: number, gapMs: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  if (gapMs > 0) await page.waitForTimeout(gapMs);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}

async function setupDockedClipplayer(page: Page): Promise<{ rowPitch: number; pad0: { x: number; y: number } }> {
  await gotoShellWorkflow(page);
  await spawnPatch(page, [{ id: 'cp', type: 'clipplayer', position: { x: 40, y: 40 }, domain: 'audio' }]);
  await openFullView(page, 'cp');
  const pane = page.locator(PANE);
  await expect(pane.locator('[data-clip="0"]')).toBeVisible();

  // The dock pane is screen-space — no xyflow zoom — so px here are CSS px.
  const scale = await page.evaluate((sel) => {
    const el = document.querySelector(`${sel} [data-testid="clipplayer-grid"]`) as HTMLElement | null;
    if (!el) return NaN;
    return +new DOMMatrixReadOnly(getComputedStyle(el).transform).a.toFixed(4) || 1;
  }, PANE);
  expect(scale, 'dock pane carries no scale transform → px are CSS px').toBe(1);

  const p0 = (await pane.locator('[data-clip="0"]').boundingBox())!;
  const p1 = (await pane.locator('[data-clip="1"]').boundingBox())!;
  const rowPitch = +(p1.y - p0.y).toFixed(2);
  expect(rowPitch, 'row pitch (CSS px) = 28px pad + 3px gap').toBeGreaterThan(20);
  return { rowPitch, pad0: { x: p0.x + p0.width / 2, y: p0.y + p0.height / 2 } };
}

test.describe('CLIP PLAYER launch grid — stable geometry across a pad click', () => {
  test('dock full-view: a pad click does not move the grid (and the sampler can see it if it does)', async ({
    page,
  }) => {
    const { rowPitch, pad0 } = await setupDockedClipplayer(page);

    // ── THE GATE: click one pad, grid must not budge. ────────────────────────
    await startSampler(page);
    await page.mouse.move(pad0.x, pad0.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(500); // past the 220ms single-click launch debounce
    const click = await readSampler(page);

    expect(click.samples, 'the in-page rAF sampler actually ran').toBeGreaterThan(10);
    expect(
      click.span,
      `grid top moved ${click.span} CSS px = ${(click.span / rowPitch).toFixed(2)} rows across a pad click ` +
        `(row pitch ${rowPitch} CSS px, ${click.samples} rAF samples, tops seen: ${click.distinct.join(', ')}). ` +
        `A grid that slides between the two clicks of a double-click sends click 2 to a different pad.`,
    ).toBe(0);

    // ── NEGATIVE CONTROL (permanent leg): move the pane one row on purpose and
    // require the sampler to report exactly that. Without this, a sampler that
    // silently read the wrong element would pass the gate above forever. ─────
    await startSampler(page);
    const scrolled = await page.evaluate(({ dy, PANE }) => {
      const s = document.querySelector(`${PANE} .faceplate-scroll`) as HTMLElement | null;
      if (!s) return -1;
      s.scrollTop = dy;
      return s.scrollTop;
    }, { dy: rowPitch, PANE });
    expect(scrolled, 'the dock pane is a real scroll container (the thing that moved the grid)').toBeCloseTo(
      rowPitch,
      0,
    );
    await page.waitForTimeout(120);
    const control = await readSampler(page);
    expect(
      control.span,
      `NEGATIVE CONTROL: scrolling the pane by one row (${rowPitch} CSS px) must show up in the sampler; ` +
        `it reported ${control.span} px over ${control.samples} samples. If this is 0 the gate above is blind.`,
    ).toBeCloseTo(rowPitch, 0);
  });

  test('dock full-view: a slow double-click opens the clip you aimed at, not one two rows down', async ({
    page,
  }) => {
    const { rowPitch, pad0 } = await setupDockedClipplayer(page);

    // Seed a real clip in row 1 / lane 1 — the owner's "already existing
    // pattern in row 1" — so the failure mode is exactly theirs: a NEW clip
    // appears two rows down instead of the existing one opening.
    // Mutate node.data IN PLACE — syncedStore rejects reassigning an object
    // that already occurs in the tree (the live-Y-type rule).
    await page.evaluate(() => {
      const d = ((globalThis as unknown as W).__patch.nodes['cp'].data ?? {}) as Record<string, unknown>;
      if (!d.clips) d.clips = {};
      (d.clips as Record<string, unknown>)['0'] = {
        kind: 'note', lengthSteps: 16, root: 60, steps: [{ step: 0, midi: 60, vel: 100 }],
      };
    });
    await expect(page.locator(PANE).locator('[data-clip="0"]')).toHaveAttribute('data-state', 'loaded');

    await slowDblClick(page, pad0.x, pad0.y, 300);
    await expect(page.locator(PANE).getByTestId('clipplayer-pianoroll')).toBeVisible();

    const clipKeys = await page.evaluate(() =>
      Object.keys(((globalThis as unknown as W).__patch.nodes['cp'].data?.clips ?? {}) as object).sort(
        (a, b) => +a - +b,
      ),
    );
    expect(
      clipKeys,
      `double-clicking the row-1 pad must not create a clip elsewhere. Row pitch ${rowPitch} CSS px; ` +
        `an extra key exactly 2 higher means the grid slid two rows between the clicks.`,
    ).toEqual(['0']);
  });
});
