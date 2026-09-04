// e2e/tests/workflow-master-transport.spec.ts
//
// P0 GUARD — WORKFLOW MASTER TRANSPORT drives real clip playback, end to end.
// Joins the transport guard family (clipplayer-transport-no-controller covers
// the legacy card seam); this one drives the OWNER-FACING workflow surface on
// /rack?shell=legacy (faces) AND ?shell=legacy: the pinned clipplayer in the `c` drawer,
// a lane instrument auto-wired by the wcol reconciler, and the pinned master
// chain (MIXMSTRS → audio out).
//
// The transport CONTRACT it pins (per timelorde's design — `running` defaults
// to 1, so a fresh rack FREE-RUNS):
//   (1) a clip-cell click LAUNCHES the lane on the default-running transport:
//       `playing[0]` flips, the lane's step counter ADVANCES, and the REAL
//       chain (clip pitch/gate → tidyVco → mixmstrs ch1 → master) is AUDIBLE;
//   (2) the drawer card's ■ STOPS the rack TIMELORDE: `params.running` → 0
//       and the step counter FREEZES (playback genuinely halts — not just a
//       flag flip);
//   (3) the same control STARTS it again: `running` → 1, steps advance again,
//       and the master is audible again;
//   (4) the wcol reconcile budget NEVER trips during this ordinary flow (the
//       janitor stays quiet — a tripped budget here means a diverging heal).
//
// Any break in the click→running plumbing, the timelorde scheduler, the clip
// engine's transport lock, the lane note wiring, or the master chain turns
// this red in the exact mode that broke.

import { test, expect, type Page } from '@playwright/test';
import { readScopePeakOverWindow } from './_module-coverage-helpers';
import { AUDIO_READY_MS } from '../_helpers/boot-budget';

test.describe.configure({ mode: 'parallel' });

// CI (and a local E2E_SWIFTSHADER=1 flake-check) rasterizes on the SwiftShader
// SOFTWARE renderer with 4 workers per shard. The MEASUREMENT windows below
// cost up to ~14.1s of pure wall-clock — 2× `stepScan(4_000)` (early-exits
// on the 2nd distinct step, so it stretches toward 4s exactly when the clock is
// slow) + 2× audibility windows (bounded condition waits — early-exit the
// instant sustained RMS crosses the asserted floor, capped at AUDIO_READY_MS;
// see the launch leg) + ~1.1s stop-drain/freeze-scan waits — BEFORE bootWorkflow, the 10s
// reconciler-edge poll, the clip seed, the drawer open and four click/assert
// round-trips (each a ~1s page.evaluate under CI contention). That fits a warm
// dev box inside the flat 30s default; it does NOT fit shard 10 (242 tests /
// 4 workers), where it timed out 4/4 attempts (both `label` variants × 2
// retries) mid-RESTART leg — always still PROGRESSING, never a failed
// assertion. Repo rule (ci-swiftshader-video-e2e-timeouts): scale the budget by
// render load, never flat, and never shrink the measurement windows — the
// windows ARE the test.
// Mirrors the SLOW_RENDER idiom in workflow-shell-video / videovarispeed-switch.
//
// ⚠ THE SECOND CI RED (2026-08-02, shard 10) was NOT that timeout: it was a
// failed ASSERTION, `distinct steps >= 2` returning 1 on the restart leg. The
// budget above was innocent — the INSTRUMENT was, see `stepScan`.
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

const PINNED_CLIP = 'pinned-clipplayer';
const PINNED_MIXER = 'pinned-mixmstrs';
const PINNED_TL = 'pinned-timelorde';

async function bootWorkflow(page: Page, url: string): Promise<void> {
  await page.goto(url);
  // 15s: first paint pays SvelteKit's on-demand route compile on a cold dev
  // server (and SwiftShader contention on CI) — the sibling workflow specs'
  // first-visibility budget (workflow-shell-video / workflow-lane-add-safety).
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
        __spawnFromPalette?: unknown;
        __assignNodeToChannel?: unknown;
      };
      return (
        typeof w.__spawnFromPalette === 'function' &&
        typeof w.__assignNodeToChannel === 'function' &&
        !!w.__patch &&
        ['pinned-mixmstrs', 'pinned-clipplayer', 'pinned-timelorde'].every(
          (id) => w.__patch!.nodes[id]?.data?.pinned === true,
        )
      );
    },
    undefined,
    // The pinned-node boot poll rides the same cold-compile / software-renderer
    // cost as the paint above (a COLD local run blew the flat 20s here).
    { timeout: SLOW_RENDER ? 45_000 : 30_000 },
  );
}

/** Spawn a module and make it a channel-1 member through the REAL assign path
 *  (the same commitAssignToChannel seam the module menu drives). */
async function addLaneInstrument(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const w = globalThis as unknown as {
      __spawnFromPalette: (t: string) => void;
      __assignNodeToChannel: (id: string, ch: number) => void;
      __patch: { nodes: Record<string, unknown> };
    };
    const before = new Set(Object.keys(w.__patch.nodes));
    w.__spawnFromPalette(t);
    const added = Object.keys(w.__patch.nodes).find((id) => !before.has(id));
    if (!added) throw new Error(`spawn of ${t} added no node`);
    w.__assignNodeToChannel(added, 0); // 0-based → channel 1
    return added;
  }, type);
}

/** Seed a 4-note clip in lane 0 / slot 0 (flat key '0') — the same record shape
 *  the card/grid write. Playback itself is then driven via the REAL pad click. */
async function seedClip(page: Page): Promise<void> {
  await page.evaluate((cpId) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[cpId]!;
      if (!n.data) n.data = {};
      n.data.clips = {
        '0': {
          kind: 'note', lengthSteps: 4, root: 48, loop: true,
          steps: [
            { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
            { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
            { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
            { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
          ],
        },
      };
    });
  }, PINNED_CLIP);
}

/** Wire a scope onto the pinned master L so audibility is measurable. */
async function tapMaster(page: Page): Promise<void> {
  await page.evaluate((mixId) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['p0-scope'] = {
        id: 'p0-scope', type: 'scope', domain: 'audio',
        position: { x: 2400, y: 900 }, params: { timeMs: 200 }, data: {},
      } as never;
      w.__patch.edges['p0-e-master-scope'] = {
        id: 'p0-e-master-scope',
        source: { nodeId: mixId, portId: 'masterL' },
        target: { nodeId: 'p0-scope', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio',
      } as never;
    });
  }, PINNED_MIXER);
}

async function timelordeRunning(page: Page): Promise<number | undefined> {
  return page.evaluate(
    (tid) =>
      (globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> } })
        .__patch.nodes[tid]?.params?.running,
    PINNED_TL,
  );
}

async function lane0Playing(page: Page): Promise<unknown> {
  return page.evaluate(
    (cpId) =>
      (globalThis as unknown as { __patch: { nodes: Record<string, { data?: { playing?: unknown[] } } | undefined> } })
        .__patch.nodes[cpId]?.data?.playing?.[0] ?? null,
    PINNED_CLIP,
  );
}

/** What one step scan actually observed — reported in the assertion message so a
 *  red run says WHICH failure happened (see `stepScan`). */
interface StepScan {
  /** Distinct lane-0 step values seen. ≥2 ⇒ the clock advances. */
  distinct: number;
  /** How many times the counter was actually READ. */
  samples: number;
  /** Reads that answered -1 — the engine's STOPPED-TRANSPORT contract ("nothing
   *  is sounding"), distinct from a missing engine. See the stop leg. */
  stopped: number;
  /** Reads that came back with no engine / no node. */
  nulls: number;
  elapsedMs: number;
  values: number[];
}

/**
 * Scan the lane-0 step counter for `windowMs` and report what was seen.
 * The gate is `distinct >= 2` — the clock advances.
 *
 * ⚠ SAMPLED INSIDE THE PAGE, deliberately. The previous version was a
 * Playwright-side `while` loop doing one `page.evaluate` round-trip per sample,
 * and that instrument is BLIND to the difference between the two failures it
 * can report:
 *
 *   · the clock genuinely froze (a real bug), and
 *   · the sampler never got to look (a loaded runner).
 *
 * Both print `Received: 1` and nothing else. Worse, they are not independent:
 * the step scheduler and a `page.evaluate` round-trip run on the SAME main
 * thread, so whatever starves one starves the other — a stalled thread can eat
 * the whole 4s window in two reads and then declare the clock dead on a sample
 * size of two. Measured under `E2E_SWIFTSHADER=1` at 4 workers, the clock needs
 * only ~150ms and 2-3 reads to show a second step (16/16 scans), so a scan that
 * sees ONE value after 4s is never about the step rate.
 *
 * An in-page accumulator fixes the mechanism rather than the budget: it adds no
 * protocol traffic, and — the point — the Set SURVIVES a stall, so a thread that
 * freezes for 3s and then runs still reports every value it computed. The gate
 * (≥2) and the window are UNCHANGED; only the sampling is.
 *
 * The instrument is negative-controlled on every run: the STOP leg scans with
 * the transport halted and requires ZERO step values with the engine
 * demonstrably answering (`stopped > 0` — the read returns -1 while the
 * transport is stopped, the honest "nothing is sounding"), so a scanner that
 * always reported "advancing" would fail there, and so would one that lost its
 * engine and mistook silence for a stop.
 */
async function stepScan(page: Page, windowMs: number): Promise<StepScan> {
  return page.evaluate(
    ([cpId, ms]) =>
      new Promise<StepScan>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
          __patch: { nodes: Record<string, unknown> };
        };
        const seen = new Set<number>();
        let samples = 0;
        let stopped = 0;
        let nulls = 0;
        const t0 = performance.now();
        const done = () => {
          clearInterval(timer);
          resolve({
            distinct: seen.size,
            samples,
            stopped,
            nulls,
            elapsedMs: performance.now() - t0,
            values: [...seen],
          });
        };
        const read = () => {
          const e = typeof w.__engine === 'function' ? w.__engine() : null;
          const cp = w.__patch?.nodes?.[cpId];
          const v = e && cp ? e.read(cp, 'currentStep:0') : null;
          if (typeof v === 'number' && v >= 0) {
            seen.add(v);
            samples++;
          } else if (v === -1) stopped++;
          else nulls++;
          // Early exit the moment the question is answered, so a healthy clock
          // costs ~150ms rather than the whole window.
          if (seen.size >= 2 || performance.now() - t0 >= ms) done();
        };
        // 20ms < the ~25ms scheduler tick, so no step can slip past unseen.
        const timer = setInterval(read, 20);
        read();
      }),
    [PINNED_CLIP, windowMs] as const,
  );
}

/** The failure line a step scan deserves: the reading AND how it was taken. */
function scanMsg(label: string, s: StepScan): string {
  return (
    `${label} — read ${s.samples} times (+${s.stopped} stopped, +${s.nulls} null) over ` +
    `${Math.round(s.elapsedMs)} ms IN-PAGE; distinct step values seen: [${s.values.join(', ')}]`
  );
}

/** The wcol edges as src.port->dst.port strings. */
async function wcolEdges(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        edges: Record<
          string,
          { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined
        >;
      };
    };
    return Object.entries(w.__patch.edges)
      .filter(([id, e]) => e && id.startsWith('wcol-e-'))
      .map(([, e]) => `${e!.source.nodeId}.${e!.source.portId}->${e!.target.nodeId}.${e!.target.portId}`);
  });
}

// The S2 inversion collapsed the two-renderer table: the drawer routes through
// DockFullView, which never read the shell flag, so both arms were already
// looking at the same faceplate (see the pane-wrapper note below) and the lane
// half of the legacy arm died with the flip. One arm carries the subject.
for (const [label, url] of [
  ['faces', '/rack'],
] as const) {
  test(`master transport drives audible clip playback through the real lane chain (${label})`, async ({ page }) => {
    // Software-renderer scale (see SLOW_RENDER): up to ~14.1s of measurement
    // windows + boot + the reconciler-edge poll + four click/assert round-trips.
    // The local (real-GPU) ceiling still gets headroom over the flat 30s default
    // because a COLD dev server pays SvelteKit's on-demand route compile on the
    // first `/rack` boot (measured: the flat 20s bootWorkflow poll
    // blown on the first COLD run, 9.6s per test once warm).
    test.setTimeout(SLOW_RENDER ? 90_000 : 60_000);
    const budgetWarns: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('reconcile budget tripped')) budgetWarns.push(m.text());
    });

    await bootWorkflow(page, url);

    // Lane-1 instrument through the REAL assign path → the reconciler wires
    // the clip's notes in AND the audio chain out to the pinned mixer.
    const vco = await addLaneInstrument(page, 'tidyVco');
    await expect
      .poll(async () => await wcolEdges(page), { timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          `${PINNED_CLIP}.pitch1->${vco}.poly`,
          `${vco}.out_l->${PINNED_MIXER}.ch1L`,
        ]),
      );

    await seedClip(page);
    await tapMaster(page);

    // Open the `c` drawer → the pinned clipplayer, the owner's surface.
    //
    // ⚠ THE CONTAINER IS THE PANE, NOT `[data-dock-card]`, AND THE PROMOTION IS
    // WHY. `data-dock-card` is emitted by `DockCardHost` and by `DockFullView`'s
    // CARD branch only, so it vanishes the moment this drawer paints a
    // faceplate — which it now does for `clipplayer` on BOTH urls in the table
    // below, not only the default one. `?shell=legacy` steers `laneRenderKind`,
    // which decides the CANVAS LANE; the `c` drawer routes through
    // `DockFullView`, which switches on bare `STRICT_FACES` membership and
    // never reads the flag. So the `legacy-cards` arm of this test is looking
    // at the faceplate too, and asserting on a card selector made BOTH arms red.
    //
    // The pane wrapper is what the two surfaces have in common: Canvas emits
    // `[data-testid="dock-fullview-pane"][data-pane-node]` around whichever one
    // mounts. Everything below is UNCHANGED and still exactly as load-bearing —
    // `[data-clip="0"]` is emitted identically by the card and by the launch
    // panel (deliberately; eighteen spec files locate through it), so the
    // launch, the transport mirror and the audibility windows all still
    // measure the real chain.
    await page.keyboard.press('c');
    const dockCard = page.locator(
      `[data-testid="dock-fullview-pane"][data-pane-node="${PINNED_CLIP}"]`,
    );
    await expect(dockCard).toBeVisible({ timeout: 10_000 });
    const pad = dockCard.locator('[data-clip="0"]');
    await expect(pad).toBeVisible({ timeout: 10_000 });
    // Let the drawer's slide-in settle: a click mid-animation can land on the
    // neighbouring pad row (verified live — the pad geometry moves under the
    // pointer while the drawer opens).
    await expect
      .poll(async () => JSON.stringify(await pad.boundingBox()), { timeout: 5_000 })
      .toBe(JSON.stringify(await pad.boundingBox()));

    // (1) LAUNCH on the default-running transport: the cell click starts the
    // lane (single-click path, 220ms debounce inside the card)…
    await pad.click();
    await expect.poll(() => lane0Playing(page), { timeout: 8_000 }).toBe(0);
    // …the engine is up and the drawer transport mirror agrees (■ = running)…
    await expect(dockCard.getByTestId(`clipplayer-transport-${PINNED_CLIP}`)).toHaveText('■', { timeout: 10_000 });
    // …the step counter genuinely advances…
    const launchScan = await stepScan(page, 4_000);
    expect(launchScan.distinct, scanMsg('launch: steps advance', launchScan)).toBeGreaterThanOrEqual(2);
    // …and the REAL chain is audible at the pinned master.
    //
    // ⚠ BOUNDED CONDITION WAIT, not a fixed window. The census (2026-08-31,
    // item 14) caught this leg recovered-on-retry on a re-binned shard: a
    // fixed 2.5s window opened immediately after launch, and under
    // co-scheduled audio the lane's first samples can arrive AFTER it closes —
    // the window measured the silence before the sound, the same geometry
    // #2310 closed for snh-hold's sleep. `untilRms` names the exact floor the
    // assertion below makes (the helper's own rule), so a green run exits the
    // moment sustained audio crosses it and a silent product still fails at
    // the AUDIO_READY_MS cap with the starvation diagnostics
    // (maxSampleGapMs) in the message.
    const RMS_FLOOR = 0.02;
    const runRms = await readScopePeakOverWindow(page, 'p0-scope', AUDIO_READY_MS, {
      untilRms: RMS_FLOOR,
    });
    expect(runRms.polls, 'scope polled').toBeGreaterThan(0);
    expect(runRms.rms, 'audible RMS at the master while running').toBeGreaterThan(RMS_FLOOR);

    // (2) STOP from the drawer card: running flips AND playback halts.
    const transport = dockCard.getByTestId(`clipplayer-transport-${PINNED_CLIP}`);
    await transport.click();
    await expect.poll(() => timelordeRunning(page), { timeout: 5_000 }).toBe(0);
    await expect(transport).toHaveText('▶', { timeout: 5_000 });
    // pacing: STOP cancels future scheduling, but audio already committed to the
    // graph still has to play out. That tail is the product's own scheduling
    // lookahead: `LOOKAHEAD_S = 0.2` in
    // packages/web/src/lib/audio/modules/clipplayer.ts:281, advanced on the
    // 25 ms scheduler tick (SCHEDULER_TICK_MS, packages/web/src/lib/audio/
    // scheduler-clock.ts). 400 ms is that 200 ms window plus its tick, so the
    // freeze scan below starts after the drain rather than during it.
    await page.waitForTimeout(400);
    // The stop is scanned CONTINUOUSLY (was: two spot reads 700ms apart, which
    // could not see a counter that moved and moved back). It doubles as the
    // NEGATIVE CONTROL for `stepScan` on every run: a scanner that always
    // reported "advancing" fails right here.
    //
    // ⚠ THE STOPPED CONTRACT CHANGED (PR #2336): `currentStep:L` used to FREEZE
    // at the last sounded step after a transport stop — which is exactly the
    // frozen full-column "playhead" the owner reported as a permanent artifact
    // on the clipplayer face's always-visible editor. The read is now gated on
    // the engine's own `transportRunning()` and answers -1 ("nothing is
    // sounding") while stopped. So the pin is no longer "one frozen value":
    // it is NO step values at all, with the engine DEMONSTRABLY answering the
    // stopped contract on every look (`stopped > 0`) — which keeps this leg a
    // real negative control: a dead engine or a vanished node reads as `nulls`,
    // not as a pass.
    const stopScan = await stepScan(page, 700);
    expect(
      stopScan.stopped,
      scanMsg('stop: the engine answers the stopped contract (-1)', stopScan),
    ).toBeGreaterThan(0);
    expect(stopScan.distinct, scanMsg('stop: no sounding step while stopped', stopScan)).toBe(0);

    // (3) START again from the same control: running flips back, steps move,
    // the master is audible again.
    await transport.click();
    await expect.poll(() => timelordeRunning(page), { timeout: 5_000 }).toBe(1);
    await expect(transport).toHaveText('■', { timeout: 5_000 });
    const restartScan = await stepScan(page, 4_000);
    expect(restartScan.distinct, scanMsg('restart: steps advance', restartScan)).toBeGreaterThanOrEqual(2);
    // Same bounded condition wait as the launch leg, same floor, same cap.
    const restartRms = await readScopePeakOverWindow(page, 'p0-scope', AUDIO_READY_MS, {
      untilRms: RMS_FLOOR,
    });
    expect(restartRms.rms, 'audible RMS after restart').toBeGreaterThan(RMS_FLOOR);

    // (4) The wcol reconcile budget never trips during this ordinary flow.
    expect(budgetWarns).toEqual([]);
  });
}
