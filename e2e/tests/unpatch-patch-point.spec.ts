// e2e/tests/unpatch-patch-point.spec.ts
//
// RIGHT-CLICK → UNPATCH on a PATCH POINT, in every view that renders one.
//
// Owner report: "there's no way to break a patch right now if i put six strum
// in a lane and then want to unpatch poly." A cable is only a selectable object
// on the free-rack EDGE LAYER — the workflow lanes and the flip-side jack
// fields render patch POINTS, so a cable the app wired FOR you (a lane's
// auto-wired clip→POLY feed) had no removal affordance at all.
//
// What this pins:
//
//   1) THE OWNER'S EXACT SCENARIO — SIX STRUM dropped in channel column 1 (the
//      REAL palette-drop path, so the reconciler really owns the wcol- clip
//      link), its dock full-view flipped to the rear card with the flip key, POLY
//      right-clicked → "Unpatch — clip player PITCH1" → the edge is GONE from
//      the graph, STAYS gone across several reconcile passes (the MAJOR-1
//      detach suppression), the hole re-renders UNPATCHED, and Cmd-Z restores
//      the whole patch.
//   2) THE AUDIO REALLY STOPS: with the pinned clip player driving lane 1, the
//      mixer's channel-1 meter carries energy BEFORE and is silent AFTER — the
//      note path is severed, not just the graph row. (The reconciler yields the
//      clip link ALL-OR-NOTHING, so detaching POLY stands the whole managed
//      clip→instrument link down; that is the shipped MAJOR-2 semantic, and it
//      is exactly what "unpatch poly" has to mean audibly.)
//   3) FAN-OUT: a right-clicked OUTPUT feeding N inputs lists each cable plus
//      "Unpatch all (N)", and the menu is VIEWPORT-CLAMPED even when the hole
//      sits at the far edge of the screen.
//   4) An UNPATCHED point opens NO unpatch menu (its pre-existing right-click
//      behaviour is untouched).
//   5) THE PATCH PANEL gets the same affordance on BOTH of its patch point
//      surfaces — the rear-view back-panel jacks and the front drill-down
//      port rows (shared components; the shell tile mounts both) — including
//      the precedence rule on a gate INPUT row (patched → unpatch menu;
//      unpatched → the shipped MIDI-assign menu).
//
// Runs on /rack (both halves — the same default shell) — the normal e2e lane,
// no DB/relay. Multiplayer convergence + undo of the removal op itself are
// pinned as pure unit tests against a real syncedStore peer pair
// (packages/web/src/lib/ui/unpatch-menu.test.ts) — the removal reuses the
// shipped LOCAL_ORIGIN edge-delete seam, so a second browser context here would
// buy nothing over that.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';

// Serial: these tests drive the shared connect-drag singleton + one warm dev
// server through real pointer clicks on flipped card faces (the
// rear-view-patching / workflow-rear-card precedent).
test.describe.configure({ mode: 'serial' });

/** channel-columns.ts geometry (mirrors workflow-channel-columns.spec.ts). The
 *  drop hit-test is 2-D (laneTargetForFlowPoint): the anchor must be inside the
 *  painted band in Y as well as inside a column in X. */
const COLUMN_W = 765;
const COLUMN_BASELINE_Y = 4320; // COLUMN_SLOT_H(720) × COLUMN_MAX_SLOTS(6)
function colPos(ch: number): { x: number; y: number } {
  return { x: (ch - 1) * COLUMN_W + 60, y: COLUMN_BASELINE_Y - 40 };
}

// ---------------------------------------------------------------------------
// Workflow-lane harness (mirrors workflow-channel-columns.spec.ts).
// ---------------------------------------------------------------------------

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  // 15s FIRST-LOAD budget — SvelteKit dev compiles /rack on demand, so the
  // very first navigation of a run pays that compile (the CI-validated number
  // workflow-rear-card.spec.ts and workflow-shell.spec.ts already use).
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return (
        !!w.__patch &&
        ['pinned-mixmstrs', 'pinned-clipplayer', 'pinned-audioOut'].every(
          (id) => w.__patch!.nodes[id]?.data?.pinned === true,
        )
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Drive the REAL palette-drop into a channel column (runs wcolDropTarget →
 *  membership → the reconciler), then resolve the spawned node's id. */
async function dropSixStrumInLane1(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __setSpawnFlowPos?: unknown; __spawnFromPalette?: unknown };
      return typeof w.__setSpawnFlowPos === 'function' && typeof w.__spawnFromPalette === 'function';
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.evaluate((pos) => {
    const w = globalThis as unknown as {
      __setSpawnFlowPos: (p: { x: number; y: number }) => void;
      __spawnFromPalette: (t: string) => void;
    };
    w.__setSpawnFlowPos(pos);
    w.__spawnFromPalette('sixstrum');
  }, colPos(1));
  // Wait for the RECONCILER to own the lane link, not just the node — that is
  // the state the whole spec is about.
  await expect
    .poll(async () => (await edgeSummaries(page)).some((s) => s.includes('pinned-clipplayer.pitch1 -> ')), {
      timeout: 15_000,
    })
    .toBe(true);
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { id: string; type: string } | undefined> };
    };
    return Object.values(w.__patch.nodes).find((n) => n?.type === 'sixstrum')!.id;
  });
}

/** Open a node's dock full-view (the shipped __openDockFullView hook the shell
 *  tiles' EXPAND buttons call) and flip it to the rear card. */
async function openRearCard(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id),
    nodeId,
  );
  await expect(page.getByTestId('dock-full-view')).toBeVisible({ timeout: 15_000 });
  // The flip key is inert inside a text input (isTypingTarget), so a press
  // swallowed that way would silently pass for the wrong reason — drop focus
  // to <body> first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pressFlipKey(page);
  await expect(page.getByTestId('rear-card')).toBeVisible({ timeout: 15_000 });
}

function rearHole(page: Page, portId: string, direction: 'input' | 'output') {
  return page
    .getByTestId('rear-card')
    .locator(`[data-testid="back-jack"][data-port-id="${portId}"][data-direction="${direction}"]`);
}

// ---------------------------------------------------------------------------
// Shared graph / menu readers.
// ---------------------------------------------------------------------------

/** "<src>.<port> -> <dst>.<port>" for every live edge. */
async function edgeSummaries(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        edges: Record<
          string,
          { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined
        >;
      };
    };
    return Object.values(w.__patch.edges)
      .filter(Boolean)
      .map((e) => `${e!.source.nodeId}.${e!.source.portId} -> ${e!.target.nodeId}.${e!.target.portId}`)
      .sort();
  });
}

function unpatchMenu(page: Page) {
  return page.getByTestId('unpatch-menu');
}

/** Seed a dense looping clip on `lane` and run the transport, so the pinned
 *  clip player really drives channel `lane+1` (workflow-channel-columns's
 *  store-safe queued/queuedImmediate launch path). */
async function seedAndRun(page: Page, lane: number): Promise<void> {
  await page.evaluate((lane) => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: {
        nodes: Record<string, { type?: string; params: Record<string, number>; data?: Record<string, unknown> } | undefined>;
      };
    };
    w.__ydoc.transact(() => {
      const cp = w.__patch.nodes['pinned-clipplayer']!;
      if (!cp.data) cp.data = {};
      const d = cp.data as {
        clips?: Record<string, unknown>;
        queued?: (number | 'stop' | null)[];
        queuedImmediate?: boolean[];
      };
      if (!d.clips) d.clips = {};
      // A note every 4 steps keeps the instrument retriggering ~4×/bar, so the
      // channel meter holds a steady RMS well above threshold.
      const steps = [0, 4, 8, 12].map((step) => ({ step, midi: 60 }));
      d.clips[String(lane * 64)] = { kind: 'note', steps, lengthSteps: 16, root: 48, loop: true };
      const queued = new Array(8).fill(null) as (number | 'stop' | null)[];
      const imm = new Array(8).fill(false) as boolean[];
      queued[lane] = 0;
      imm[lane] = true;
      d.queued = queued;
      d.queuedImmediate = imm;
      for (const n of Object.values(w.__patch.nodes)) {
        if (n?.type === 'timelorde') {
          n.params.running = 1;
          n.params.bpm = 120;
        }
      }
    });
  }, lane);
}

/** MAX mixmstrs meter RMS for channel `ch` (1-based) over `durationMs`. */
/**
 * Peak channel RMS over a sampling window.
 *
 * `untilAbove` turns the fixed WINDOW into a CONDITION WAIT: sampling stops the
 * moment the peak clears the threshold, and `durationMs` degrades from "how
 * long we watch" to "how long we are willing to wait".
 *
 * WHY THAT DISTINCTION MATTERS, measured rather than assumed. The two calls in
 * the POLY test look symmetrical and are not:
 *
 *   * the BEFORE call asks "does audio START?" — a one-way event. A fixed
 *     window makes it a race between the CI runner and a wall clock, which is
 *     the CLAUDE.md failure (a wall-clock budget is a different assertion on
 *     every machine). It went red on main and on every PR that merged main
 *     with `the lane really plays before the unpatch` — the PRECONDITION, not
 *     the behaviour under test — while passing locally in ~1.6 s of real work.
 *     Ten e2e shards share the runner, and the boot + engine start + transport
 *     + poly voice attack all have to land inside the window.
 *   * the AFTER call asks "does it STAY silent?" — a property over an
 *     interval, where an early return would be exactly wrong. That one keeps a
 *     genuine fixed window and passes no threshold.
 *
 * ⚠ CI WALL-TIME DELTA IS NEGATIVE. The BEFORE call now returns as soon as the
 * meter clears (well under a second locally) instead of always burning its
 * whole window, so raising the ceiling to 30 s makes the happy path FASTER
 * while removing the load dependence.
 */
async function pollChannelRms(
  page: Page,
  ch: number,
  durationMs: number,
  untilAbove?: number,
): Promise<number> {
  let max = 0;
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    if (untilAbove !== undefined && max > untilAbove) return max;
    const level = await page.evaluate((chIdx) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
      };
      const eng = w.__engine?.();
      const mixer = w.__patch.nodes['pinned-mixmstrs'];
      const levels = eng && mixer ? (eng.read(mixer, 'levels') as number[] | undefined) : undefined;
      return levels?.[chIdx] ?? 0;
    }, ch - 1);
    max = Math.max(max, level);
    await page.waitForTimeout(40);
  }
  return max;
}

// ═══════════════════════════════════════════════════════════════════════════
// (1) THE OWNER'S SCENARIO — unpatch POLY on a lane-hosted SIX STRUM's rear card
// ═══════════════════════════════════════════════════════════════════════════

test("rear card: right-click UNPATCH removes a lane's auto-wired POLY cable (and it stays gone); undo restores it", async ({
  page,
}) => {
  // ⚠ THE BUDGET IS NOT A GATE — it BOUNDS the failure. See the block comment
  // above `pollChannelRms`: a wall-clock budget is a different assertion on
  // every machine. This test never had one that was sized; it inherited
  // Playwright's STOCK 30 s default, which nobody chose for a scenario that
  // boots the workflow shell, palette-drops through the reconciler, opens a
  // dock full view, flips it, drives two real pointer clicks, and then holds a
  // MANDATORY 2.5 s window open to prove the cable stays detached.
  //
  // MEASURED (main @ 9b2c922a, CI run 30851519718, shard 10/10 — the P0):
  //   attempt 1  every assertion PASSED, last one finished at 32.06 s
  //   retry 1    every assertion PASSED, last one finished at 30.77 s
  // Both were killed at 30.00 s having already proved the behaviour correct —
  // the retry missed by 0.77 s. On the previous GREEN run (30839088507) this
  // same test took 26.86 s, i.e. it was shipping at 89.5 % of its budget and
  // had been a coin flip since it was written.
  //
  // `test.slow()` (×3 → 90 s) rather than a hand-picked constant: it scales
  // with the suite default instead of pinning a second magic number, and it
  // costs ZERO wall time on the happy path — a timeout is a ceiling, not a
  // sleep. 90 s is ~2.8× the worst observed 32.06 s and stays well inside the
  // shard's `timeout-minutes`, so a genuine hang still reports its own trace
  // rather than being killed with the job (#1319).
  test.slow();
  await gotoWorkflow(page);
  const strum = await dropSixStrumInLane1(page);
  const polyEdge = `pinned-clipplayer.pitch1 -> ${strum}.poly`;
  expect(await edgeSummaries(page)).toContain(polyEdge);

  await openRearCard(page, strum);
  const poly = rearHole(page, 'poly', 'input');
  await expect(poly).toHaveAttribute('data-patched', 'true');

  // Right-click the PATCHED hole → the unpatch menu, naming the real source.
  await poly.click({ button: 'right' });
  await expect(unpatchMenu(page)).toBeVisible();
  // (module labels are lowercase by house rule; the header uppercases in CSS)
  await expect(unpatchMenu(page).getByTestId('unpatch-menu-title')).toHaveText(/^six strum POLY$/i);
  const items = unpatchMenu(page).getByTestId('unpatch-item');
  await expect(items).toHaveCount(1); // one cable in → one line, no "all"
  await expect(items.first()).toHaveText(/Unpatch — clip player PITCH1/i);
  await expect(unpatchMenu(page).getByTestId('unpatch-all')).toHaveCount(0);

  await items.first().click();
  await expect(unpatchMenu(page)).toHaveCount(0);

  // GONE from the graph…
  await expect.poll(async () => (await edgeSummaries(page)).includes(polyEdge), { timeout: 5000 }).toBe(false);
  // …and it STAYS gone: the reconciler runs on every graph change, so without
  // the detach suppression the lane would snap the cable straight back.
  await page.waitForTimeout(2500);
  expect(await edgeSummaries(page)).not.toContain(polyEdge);
  // The JACK re-renders unpatched (the visual the user is looking at).
  await expect(poly).toHaveAttribute('data-patched', 'false');

  // UNDO restores the patch (the removal rode the LOCAL_ORIGIN edge-delete
  // seam, so the app's UndoManager owns it).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await edgeSummaries(page)).includes(polyEdge), { timeout: 5000 }).toBe(true);
  await expect(poly).toHaveAttribute('data-patched', 'true');
});

// ═══════════════════════════════════════════════════════════════════════════
// (2) the AUDIO stops — the note path is really severed
// ═══════════════════════════════════════════════════════════════════════════

test('rear card: unpatching POLY silences the note path at the mixer channel meter', async ({ page }) => {
  test.setTimeout(120_000);
  await gotoWorkflow(page);
  const strum = await dropSixStrumInLane1(page);

  // BASELINE: the pinned clip player drives lane 1 → audible energy on ch1.
  await seedAndRun(page, 0);
  // CONDITION, not window (see pollChannelRms): wait for the meter to clear
  // 0.02, up to 30 s, returning the instant it does.
  const before = await pollChannelRms(page, 1, 30_000, 0.02);
  expect(before, 'the lane really plays before the unpatch').toBeGreaterThan(0.02);

  await openRearCard(page, strum);
  await rearHole(page, 'poly', 'input').click({ button: 'right' });
  await unpatchMenu(page).getByTestId('unpatch-item').first().click();
  await expect(unpatchMenu(page)).toHaveCount(0);
  await page.waitForTimeout(2500); // let the engine + reconciler settle

  // The transport is STILL running and the audio out is still wired — only the
  // note path is gone, so the channel goes silent.
  const after = await pollChannelRms(page, 1, 4000);
  expect(after, 'the poly/note path is silent after the unpatch').toBeLessThan(0.002);
  expect(await edgeSummaries(page)).toContain(`${strum}.out -> pinned-mixmstrs.ch1L`);
});

// ═══════════════════════════════════════════════════════════════════════════
// (3) fan-out + viewport clamp + no menu on an unpatched hole
// ═══════════════════════════════════════════════════════════════════════════

test('rear card: a fanned-out OUTPUT lists every cable + "Unpatch all (N)", stays viewport-clamped, and an unpatched hole opens NO menu', async ({
  page,
}) => {
  // Same shape, same shell boot, and MEASURED WORSE than the test above:
  // 27.06 s of a 30 s budget (90.2 %) on the last GREEN run. It survived that
  // run only because it landed on a less contended shard slot. Budgeted with
  // the test above rather than left as the next P0. (Reasoning: see there.)
  test.slow();
  await gotoWorkflow(page);
  const strum = await dropSixStrumInLane1(page);
  await openRearCard(page, strum);

  // The lane double-patches SIX STRUM's mono out into BOTH mixer channel
  // inputs — which, since PR-3, is ONE LEG GROUP (a mono source filling a
  // stereo pair), not two cables. So a genuine fan-out needs a SECOND
  // destination; seed a hand-drawn only-L cable into channel 2. That leaves the
  // output point holding two DIFFERENT cables: the ch1 stereo group and a lone
  // ch2L leg — which also exercises the "(L only)" label on the same menu.
  const out = rearHole(page, 'out', 'output');
  await expect(out).toHaveAttribute('data-patched', 'true');
  await page.evaluate((strumId) => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.edges['e-handdrawn-ch2L'] = {
        id: 'e-handdrawn-ch2L',
        source: { nodeId: strumId, portId: 'out' },
        target: { nodeId: 'pinned-mixmstrs', portId: 'ch2L' },
        sourceType: 'audio',
        targetType: 'audio',
      };
    });
  }, strum);

  // Right-click at the hole's far BOTTOM-RIGHT corner: the outputs rail is the
  // rightmost column of a drawer pinned to the bottom of the window, so this is
  // the genuine screen-edge case the clamp exists for.
  const box = (await out.boundingBox())!;
  await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6, { button: 'right' });
  await expect(unpatchMenu(page)).toBeVisible();

  const items = unpatchMenu(page).getByTestId('unpatch-item');
  // TWO cables, not three legs: the ch1 stereo group collapses to ONE row that
  // carries both of its edge ids, and the hand-drawn ch2L cable is a lone leg.
  await expect(items).toHaveCount(2);
  // Order is by edge id (deterministic across peers + runs), so the hand-drawn
  // `e-handdrawn-ch2L` sorts ahead of the reconciler's `wcol-e-…ch1L`.
  // `CH2`, not `CH2L`: a menu line names the JACK the cable is seated on, and
  // `ch2L`+`ch2R` render as ONE `CH2` jack. The channel lives in the suffix, so
  // saying it twice — and disagreeing with the jack on the first half — was the
  // label bug the owner reported on #1409.
  //
  // ⚠ IF YOU RENAME A PORT LABEL, SWEEP ON ASSERTION SHAPE, NOT ON ID SPELLING.
  // This exact line survived two sweeps of that change and broke CI twice. The
  // first swept hardcoded COUNTS; the second grepped `OUT_L`/`IN_L`, which
  // structurally cannot match `CH2L` — a filter applied before the check, quietly
  // redefining the check's subject (CLAUDE.md, "a guard that is opt-in is itself
  // an instance of it"). What works: grep the ASSERTION — every `unpatch-item` /
  // `unpatch-menu-title` text expectation — and read each one against the
  // 59-pair golden in `$lib/graph/stereo-pairs`.
  await expect(items.nth(0)).toHaveText(/Unpatch → mixmstrs CH2 \(L only\)$/i);
  await expect(items.nth(0)).toHaveAttribute('data-edge-ids', 'e-handdrawn-ch2L');
  await expect(items.nth(1)).toHaveText(/Unpatch → mixmstrs CH1$/i);
  await expect(items.nth(1)).toHaveAttribute('data-edge-ids', /ch1L.*ch1R|ch1R.*ch1L/);
  await expect(unpatchMenu(page).getByTestId('unpatch-all')).toHaveText(/Unpatch all \(2\)/);

  // VIEWPORT CLAMP: the WHOLE menu is inside the client viewport.
  const menuBox = (await unpatchMenu(page).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(vp.width);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(vp.height);

  // "Unpatch all" drops BOTH cables in one go.
  await unpatchMenu(page).getByTestId('unpatch-all').click();
  await expect(unpatchMenu(page)).toHaveCount(0);
  await expect
    .poll(async () => (await edgeSummaries(page)).filter((s) => s.startsWith(`${strum}.out ->`)).length, {
      timeout: 5000,
    })
    .toBe(0);
  await expect(out).toHaveAttribute('data-patched', 'false');

  // An UNPATCHED hole opens NO unpatch menu — its right-click behaviour is
  // untouched (the surfaces don't even preventDefault for it).
  const chord = rearHole(page, 'chord', 'input');
  await expect(chord).toHaveAttribute('data-patched', 'false');
  await chord.click({ button: 'right' });
  await page.waitForTimeout(300);
  await expect(unpatchMenu(page)).toHaveCount(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// (4) the PATCH PANEL — back-panel jacks + front drill-down rows (the shared
//     component; the shell tile mounts the rear back panel AND the lane-rail
//     drill-down, so both legs run on the default shell).
//     ⚠ The two test TITLES below still say "legacy patch panel": the
//     waitfortimeout ledger keys on test titles, so the historical name is
//     pinned until those waits convert. The BOOT is the default shell.
// ═══════════════════════════════════════════════════════════════════════════

/** Spawn KRIA → ADSR with one pre-wired gate edge (the patch-panel
 *  jack-indicator fixture: two light, non-WebGL PatchPanel cards). */
async function spawnSeqAdsrWired(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'kria', position: { x: 80, y: 120 } },
      { id: 'adsr', type: 'adsr', position: { x: 1560, y: 120 } }, // clear of the (wide) KRIA card
    ],
    [
      {
        id: 'e-gate',
        from: { nodeId: 'seq', portId: 'gate1' },
        to: { nodeId: 'adsr', portId: 'gate' },
        sourceType: 'gate',
        targetType: 'gate',
      },
    ],
  );
}

test('legacy patch panel: right-click UNPATCH works on a REAR-VIEW back-panel jack', async ({ page }) => {
  await spawnSeqAdsrWired(page);

  const flipBtn = page.getByRole('button', { name: 'Flip rack (rear view)' });
  await flipBtn.click();
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.flow')).toHaveClass(/rear-view/);
  await expect(page.locator('[data-testid="back-jack"]').first()).toBeVisible();
  await page.waitForTimeout(420); // the flip keyframe (~360ms) must settle

  const jack = page
    .locator('.svelte-flow__node[data-id="adsr"]')
    .locator('[data-testid="back-jack"][data-port-id="gate"][data-direction="input"]');
  await expect(jack).toHaveAttribute('data-patched', 'true');

  await jack.click({ button: 'right' });
  await expect(unpatchMenu(page)).toBeVisible();
  await expect(unpatchMenu(page).getByTestId('unpatch-item')).toHaveText(/Unpatch — kria GATE1/i);
  // The module's own node context menu did NOT also open (the jack claims the
  // event when there is something to unpatch).
  await expect(page.getByTestId('node-context-menu')).toHaveCount(0);

  await unpatchMenu(page).getByTestId('unpatch-item').click();
  await expect
    .poll(async () => (await edgeSummaries(page)).length, { timeout: 5000 })
    .toBe(0);
  await expect(jack).toHaveAttribute('data-patched', 'false');

  // An UNPATCHED back jack opens no unpatch menu.
  await jack.click({ button: 'right' });
  await page.waitForTimeout(300);
  await expect(unpatchMenu(page)).toHaveCount(0);
});

test('legacy patch panel: right-click UNPATCH works on a FRONT drill-down port row (and yields to the MIDI menu when unpatched)', async ({
  page,
}) => {
  await spawnSeqAdsrWired(page);

  // Open ADSR's panel and drill into INPUTS — adsr.gate is fed by seq.gate.
  await page.locator('.svelte-flow__node[data-id="adsr"] [data-testid="patch-trigger"]').click();
  const chrome = page.locator('[data-patch-panel-chrome="adsr"]');
  await expect(chrome).toHaveAttribute('aria-hidden', 'false');
  await chrome.locator('[data-testid="patch-panel-nav"][data-nav="inputs"]').click();

  const gateRow = chrome.locator('[data-testid="patch-panel-port-row"][data-port-id="gate"]');
  await expect(gateRow.locator('[data-testid="port-row-jack"]')).toHaveAttribute('data-patched', 'true');

  // A PATCHED gate input right-clicks to UNPATCH (it wins over the gate MIDI
  // assign menu — a seated cable is what the user is pointing at).
  await gateRow.click({ button: 'right' });
  await expect(unpatchMenu(page)).toBeVisible();
  await expect(page.getByTestId('control-context-menu')).toHaveCount(0);
  await expect(unpatchMenu(page).getByTestId('unpatch-item')).toHaveText(/Unpatch — kria GATE1/i);

  await unpatchMenu(page).getByTestId('unpatch-item').click();
  await expect.poll(async () => (await edgeSummaries(page)).length, { timeout: 5000 }).toBe(0);
  await expect(gateRow.locator('[data-testid="port-row-jack"]')).toHaveAttribute('data-patched', 'false');

  // Now UNPATCHED, the SAME row falls back to the shipped gate MIDI-assign
  // menu — the pre-existing behaviour is preserved, not replaced.
  await gateRow.click({ button: 'right' });
  await expect(page.getByTestId('control-context-menu')).toBeVisible();
  await expect(unpatchMenu(page)).toHaveCount(0);
});
