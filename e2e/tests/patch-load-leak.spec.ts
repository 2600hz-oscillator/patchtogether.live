// e2e/tests/patch-load-leak.spec.ts
//
// PATCH-LOAD RETENTION — does loading a patch release the one it replaced?
//
// Origin: the 2026-07-29 audio-bog investigation reported, as a side-finding,
// that every patch/preset load leaked ~7,700–9,800 DOM nodes, ~850–1,000 event
// listeners and ~25–33 Blink audio handlers, surviving a forced GC — 4,626 →
// 52,938 DOM nodes over five loads. It was filed as a separate P0.
//
// !! THAT DOM FIGURE WAS A DEV-SERVER ARTIFACT. !!
// Re-measured 2026-07-31 on both servers with the same harness:
//
//   per load, 12-card patch     DOM nodes   listeners   audio handlers
//   vite dev  (HMR live)          +11,713        +630              +26
//   vite preview (prod build)          +0         +10              +26
//
// Vite/Svelte HMR retains component instances so it can re-render them on a hot
// update — that is what it is FOR. Measuring retention against a dev server
// therefore reports the HMR registry as an application leak. The heap snapshot
// showed 534 live `HMRContext` objects, which is what prompted the re-measure.
// The DOM half of that P0 does not exist in a build users run.
//
// What IS real, in production, and monotonic: **audio handlers**. Every
// AudioNode carries a Blink handler, and unmounting a card leaves some behind:
//
//   vca 1/card · filter 1 · cloudseed 1 · kickdrum 1 · scope 2 · sequencer 14
//   delay 0/card  ← proof that zero is reachable; delay's factory is the model
//
// For a performer switching preset slots mid-set this accumulates in the audio
// thread, which is exactly the shape of "bogs down, then stops".
//
// THE INSTRUMENT — CDP `Performance.getMetrics`, not `performance.memory`
// (quantized to ~5 MB; observed frozen at exactly 117.3 MB across eight
// consecutive windows in July — it reads like "nothing changed" when everything
// did). GC is forced twice before every reading — V8 often needs a second sweep
// for objects freed by the first — so a rising count is retention, not garbage.

import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface Counters {
  nodes: number;
  listeners: number;
  audioHandlers: number;
  documents: number;
}

/** A representative rack: 12 cards spanning canvas-bearing (scope, kickdrum),
 *  worklet-backed (cloudseed) and plain-param modules. Deliberately NO video —
 *  the retention here is card-count-driven, and a video-free patch that still
 *  leaks is the stronger claim. */
const PATCH_TYPES = [
  'tidyVco',
  'adsr',
  'vca',
  'lfo',
  'filter',
  'delay',
  'mixer',
  'scope',
  'kickdrum',
  'reverb',
  'cloudseed',
  'sequencer',
] as const;

// ── RATCHET ────────────────────────────────────────────────────────────────
// Audio handlers retained per load of PATCH_TYPES, measured on the production
// build 2026-07-31: **26**. The target is 0 and this ceiling ONLY SHRINKS —
// lower it in the same commit that fixes a module's teardown (same discipline
// as the vrt-meta linux-deficit ratchet). Per-module ownership is in the table
// above; `sequencer` alone is 14 of the 26.
const AUDIO_HANDLER_CEILING_PER_LOAD = 30;

/** Is the app under test the PRODUCTION build (vite preview) rather than the
 *  dev server? Taken from the flag the RUNNER set, not sniffed from the page:
 *  the first attempt looked for a `script[src*="/@vite/client"]`, which the dev
 *  page does not have — SvelteKit dev pulls the client through an inline
 *  `/@fs/` module import — so the sniff silently reported "production" on dev
 *  and the DOM assertion fired against HMR anyway. The harness already KNOWS
 *  which server it booted; ask it.
 *
 *  ⚠ Consequence, stated rather than buried: the DOM assertions below run ONLY
 *  in the preview lane. If no CI lane runs `E2E_PREVIEW=1`, they are local-only
 *  and cannot catch a real DOM-retention regression on CI. Wiring one preview
 *  lane is the follow-up. */
const IS_PRODUCTION_BUILD =
  process.env.E2E_PREVIEW === '1' || process.env.E2E_USE_PREVIEW === '1';

async function readCountersOnce(page: Page, cdp: CDPSession): Promise<Counters> {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
  // Settle for pending finalizers + queued detach work. This is a settle, not a
  // gate on a rendered result, so wall-clock is the right unit.
  await page.waitForTimeout(300);

  const res = (await cdp.send('Performance.getMetrics')) as {
    metrics: { name: string; value: number }[];
  };
  const get = (name: string): number => res.metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    nodes: get('Nodes'),
    listeners: get('JSEventListeners'),
    audioHandlers: get('AudioHandlers'),
    documents: get('Documents'),
  };
}

/** Read the counters at a CONVERGED state: repeat GC+read until AudioHandlers
 *  is unchanged across three consecutive readings (≥2 quiet gaps of ~300 ms
 *  plus two full GC cycles each), bounded by MAX_READS.
 *
 *  Why not one read: AudioHandlers settles ASYNCHRONOUSLY in both directions —
 *  worklet fetch + AudioNode construction finish after the DOM says "mounted",
 *  and Blink releases handlers only after the audio thread drops its refs.
 *  #1569's flaky run is the exact signature of a single-sample instrument: its
 *  baseline read 129 where the recovery-run read 143 (14 low, construction
 *  still in flight), so load 1 was debited +41 while every later load read the
 *  true steady +27 — the identical absolute line (170/197/224/251/278) in both
 *  attempts. The subject never changed; the sample was early. Convergence
 *  waits out both the stragglers and the laggards; the iteration cap only
 *  BOUNDS the failure (a page that never converges returns the last reading
 *  and reports how many reads it burned). */
async function readCounters(page: Page, cdp: CDPSession): Promise<Counters> {
  const MAX_READS = 12;
  let last = await readCountersOnce(page, cdp);
  let stableGaps = 0;
  for (let i = 1; i < MAX_READS; i++) {
    const next = await readCountersOnce(page, cdp);
    stableGaps = next.audioHandlers === last.audioHandlers ? stableGaps + 1 : 0;
    last = next;
    if (stableGaps >= 2) return last;
  }
  console.log(
    `[leak] ⚠ AudioHandlers did not converge within ${MAX_READS} reads — ` +
      `using last reading ${last.audioHandlers} (units: Blink AudioHandlers)`,
  );
  return last;
}

function delta(a: Counters, b: Counters): Counters {
  return {
    nodes: b.nodes - a.nodes,
    listeners: b.listeners - a.listeners,
    audioHandlers: b.audioHandlers - a.audioHandlers,
    documents: b.documents - a.documents,
  };
}

async function bootAndCapture(page: Page): Promise<unknown> {
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
    undefined,
    { timeout: 60_000 },
  );
  await spawnPatch(
    page,
    PATCH_TYPES.map((type, i) => ({
      id: `n${i}`,
      type,
      x: 80 + (i % 4) * 260,
      y: 80 + Math.floor(i / 4) * 240,
    })),
  );
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __persistence: { save: () => unknown } };
    return w.__persistence.save();
  });
}

/** Replay the envelope through the REAL load path (`__persistence.load` →
 *  `loadEnvelopeIntoStore`, what Load-example / import-JSON / rackspace restore
 *  all call).
 *
 *  ⚠ THE READINESS CHECK MUST NOT BE VACUOUS. Waiting for "12 nodes mounted"
 *  after loading a 12-node patch INTO a 12-node patch passes whether the load
 *  ran or was refused — `loadEnvelopeGuarded` returns null and leaves the graph
 *  untouched when the cross-mode precondition fails, and the first version of
 *  this harness reported a flawless +0 on every counter for exactly that
 *  reason. So: WIPE, assert genuinely empty, load, assert refilled. The
 *  counters then span a real unmount-all → mount-all cycle. */
async function loadEnvelope(page: Page, env: unknown): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
    });
  });
  await expect(page.locator('.svelte-flow__node')).toHaveCount(0, { timeout: 30_000 });

  const loaded = await page.evaluate((e) => {
    const w = globalThis as unknown as { __persistence: { load: (env: unknown) => unknown } };
    return w.__persistence.load(e) !== null;
  }, env);
  expect(loaded, 'load() returned null — the cross-mode guard refused it and the graph is untouched').toBe(true);
  await expect(page.locator('.svelte-flow__node')).toHaveCount(PATCH_TYPES.length, { timeout: 30_000 });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

test.describe('patch load releases the previous patch', () => {
  test.setTimeout(240_000);

  test('the counters track what they claim to — instrument negative control', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await bootAndCapture(page);

    // Idle floor: two readings with NO load between them.
    const a = await readCounters(page, cdp);
    await page.waitForTimeout(1500);
    const b = await readCounters(page, cdp);
    console.log(`[leak] idle noise floor over 1.5 s: ${JSON.stringify(delta(a, b))}`);
    expect(
      Math.abs(delta(a, b).nodes),
      `idle DOM-node drift ${delta(a, b).nodes} — the instrument itself is unstable`,
    ).toBeLessThan(400);

    // ⚠ A flat idle floor is ALSO exactly what a FROZEN counter looks like, and
    // the two are indistinguishable from the number alone. Perturb the quantity
    // the metric claims to measure and confirm it moves: without this, every
    // "+0" in the next test could equally mean "nothing leaked" or "the
    // instrument reads nothing at all".
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (let i = 0; i < 4; i++) {
          w.__patch.nodes[`probe${i}`] = {
            id: `probe${i}`,
            type: 'vca',
            domain: 'audio',
            position: { x: 1200, y: 100 + i * 200 },
            data: {},
          };
        }
      });
    });
    await expect(page.locator('.svelte-flow__node')).toHaveCount(PATCH_TYPES.length + 4, { timeout: 30_000 });
    const grown = await readCounters(page, cdp);
    const growth = delta(b, grown);
    console.log(`[leak] +4 cards moved the counters by: ${JSON.stringify(growth)}`);
    expect(
      growth.nodes,
      `adding 4 cards moved the DOM-node counter by ${growth.nodes} — the counter is not tracking the DOM`,
    ).toBeGreaterThan(100);
    expect(
      growth.audioHandlers,
      `adding 4 cards moved the audio-handler counter by ${growth.audioHandlers} — it is not tracking AudioNodes`,
    ).toBeGreaterThan(0);
  });

  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
  // NONDETERMINISM: 2 recovered-on-retry observation(s) across 2 SHA(s) / 2 branch(es) in the
  // 96 h CI census to 2026-08-18 — it also hard-failed 1 time(s) on a branch, but the recovered-on-retry runs stayed green.
  // LOST WHILE PARKED: the patch-load retention gate — five consecutive loads must release the graph they replaced; without it the 2026-07-29 audio-bog class returns with no signal at all.
  // Re-enable only on a root cause (#1847); "it passes now" is not one.
  test.fixme('five consecutive loads do not accumulate', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 2 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const env = await bootAndCapture(page);

    // Warm-up load before the baseline: a cold page's first load also pays
    // one-time costs (route chunks, worklet module fetches, font faces) that
    // are not retention.
    await loadEnvelope(page, env);
    const baseline = await readCounters(page, cdp);
    console.log(
      `[leak] lane=${IS_PRODUCTION_BUILD ? 'production build' : 'vite dev (HMR — DOM assertions skipped)'} ` +
        `baseline: ${JSON.stringify(baseline)}`,
    );

    const perLoad: Counters[] = [];
    let prev = baseline;
    for (let i = 1; i <= 5; i++) {
      await loadEnvelope(page, env);
      const now = await readCounters(page, cdp);
      const d = delta(prev, now);
      perLoad.push(d);
      console.log(
        `[leak] load ${i}: nodes ${now.nodes} (${d.nodes >= 0 ? '+' : ''}${d.nodes})  ` +
          `listeners ${now.listeners} (${d.listeners >= 0 ? '+' : ''}${d.listeners})  ` +
          `audioHandlers ${now.audioHandlers} (${d.audioHandlers >= 0 ? '+' : ''}${d.audioHandlers})`,
      );
      prev = now;
    }
    const total = delta(baseline, prev);
    console.log(
      `[leak] TOTAL over 5 loads: nodes +${total.nodes}, listeners +${total.listeners}, ` +
        `audioHandlers +${total.audioHandlers}`,
    );

    // ── AUDIO HANDLERS — the real, production-visible leak. Ratchet, not a
    //    pass: the ceiling documents today's debt and only ever shrinks.
    const worstAudio = Math.max(...perLoad.map((d) => d.audioHandlers));
    expect(
      worstAudio,
      `a load retained ${worstAudio} audio handlers (ceiling ${AUDIO_HANDLER_CEILING_PER_LOAD}). ` +
        `Every AudioNode left behind by an unmounted card stays in the audio thread. ` +
        `Lower the ceiling when you fix a module's teardown; never raise it.`,
    ).toBeLessThanOrEqual(AUDIO_HANDLER_CEILING_PER_LOAD);

    // ── DOM — production only. Under vite dev, HMR deliberately retains
    //    destroyed component instances, so this measures HMR, not the app.
    test.skip(
      !IS_PRODUCTION_BUILD,
      'DOM retention is not measurable under vite dev — HMR retains destroyed component instances by design',
    );
    const perLoadBudget = PATCH_TYPES.length * 60; // ~a tenth of one card
    const worstNodes = Math.max(...perLoad.map((d) => d.nodes));
    expect(
      worstNodes,
      `worst single-load DOM-node growth ${worstNodes} exceeds ${perLoadBudget} — a load is retaining the patch it replaced`,
    ).toBeLessThan(perLoadBudget);
    expect(
      total.nodes,
      `five loads grew the DOM by ${total.nodes} nodes — steady-state loading must not accumulate`,
    ).toBeLessThan(perLoadBudget * 2);
  });
});
