// e2e/tests/stereo-only-channel.spec.ts
//
// "PATCH ONLY L" / "PATCH ONLY R", end to end, with AUDIO as the verdict.
//
// The gesture under test is the real one: right-click a collapsed stereo OUTPUT
// row → the picker's channel rows → pick a target module + its (collapsed)
// input jack → planAudioCommit writes ONE leg. The verdict is what comes out of
// the speakers, read at AUDIO OUT's PER-CHANNEL taps.
//
// ⚠⚠ THE INSTRUMENT IS THE WHOLE POINT HERE, so read this before touching it.
//
// `read('outputSnapshot')` — the mono tap every other audibility spec uses — is
// an AnalyserNode, and an AnalyserNode analyses a MONO DOWNMIX by spec. It
// reads HALF level for only-L and half level for only-R: measured in Chrome by
// PR-2a on the real default chain, mono 0.15507 vs L 0.31015 vs R 0, i.e. mono
// is EXACTLY L/2. It therefore CANNOT DISTINGUISH only-L from only-R — the two
// cases it exists to tell apart produce the same number. Every assertion below
// uses `outputSnapshotL` / `outputSnapshotR` (PR-2a, #1402), which hang off a
// ChannelSplitter(2) at the same post-limiter node.
//
// ⚠ THE DEFAULT WORKFLOW CHAIN IS LEFT-ONLY. A mono VCO into mixmstrs ch1L
// reaches AUDIO OUT's L and nothing else. So this spec does NOT use it: it
// builds an EXPLICIT stereo source (a free-running analogVco through
// `resofilter`, whose `out_l`/`out_r` are a declared pair) and PROVES the
// source is stereo — both channels audible
// through a full stereo patch — before asserting anything about one channel
// being silenced. Without that control, "R is silent" would be indistinguishable
// from "R was never alive", and the whole file would be vacuous rather than red.
//
// ⚠ NO FRAME WAITS AND NO WALL-CLOCK GATES. The level is a CONDITION with a
// generous bound, sampled by an accumulator INSIDE the page that exits the
// moment the level is reached — so the sampler never competes with the audio
// thread over the CDP boundary, a healthy run costs what the graph costs, and
// a slow machine cannot turn "not yet" into "never". See `readTaps`.

import { test, expect, loadVoiceDemo } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Audible / silent thresholds (linear RMS at the post-limiter tap).
 *  The gap is ~2 orders of magnitude, so neither is a knife edge: a live
 *  channel measures ~0.1–0.5 and a dead one is bit-zero, not "quiet". */
const AUDIBLE_RMS = 0.01;
const SILENT_RMS = 0.001;

/**
 * How long to wait for the audio graph to come up before declaring a channel
 * dead. This bounds the FAILURE, it is not the gate — the sampler exits the
 * instant `minRms` is reached, so a healthy run costs whatever the graph
 * actually takes (~0.3–1 s measured) and only a genuinely silent one spends
 * the budget.
 *
 * ⚠ IT MUST BE COMFORTABLY SMALLER THAN THE TEST TIMEOUT, and that is not a
 * style point — it is the difference between a diagnosable failure and a
 * useless one. At the 30 s Playwright default this was 30 s, so on a loaded
 * machine the accumulator ate the whole test budget and the run died as a bare
 * `Test timeout of 30000ms exceeded`: every RMS number, the read count and the
 * elapsed time — the entire reason this instrument reports them — were never
 * printed. A wait that can outlive its own test cannot report anything.
 * Measured: two failures of exactly that shape at load average ~23–45.
 */
const AUDIO_SETTLE_MS = 12_000;

// Spawning three modules, booting a Faust worklet and MEASURING SOUND does not
// fit the 30 s default with any headroom — the UI gestures alone are ~2–4 s and
// `spawnPatch`'s mount budget can run long on a loaded machine. The generous
// per-test cap costs nothing on a passing run (measured 7–12 s each) and leaves
// room for AUDIO_SETTLE_MS to actually expire and print its diagnostics.
test.describe.configure({ timeout: 90_000 });

interface Taps {
  l: number;
  r: number;
  mono: number;
  /** Samples the in-page accumulator actually took. */
  samples: number;
  /** Samples where the engine AND the node both resolved. */
  reads: number;
  elapsedMs: number;
}

/**
 * Peak-held per-channel RMS at AUDIO OUT, accumulated IN THE PAGE, exiting as
 * soon as either channel reaches `minRms`.
 *
 * ⚠ THREE instrument decisions, each of which was a real failure mode here:
 *
 * 1. The accumulator runs on a `setInterval` INSIDE the page, not as a
 *    Playwright poll loop. A poll loop is one `page.evaluate` round-trip per
 *    sample ON THE SAME MAIN THREAD as the audio it measures, so a loaded
 *    runner starves the subject and the sampler together — and a thread that
 *    stalls for 3 s then runs reports "never moved" off a sample size of two.
 *    Peak-holding also means a momentary stall cannot read as silence, which
 *    matters enormously because SILENCE IS AN ASSERTION in this file.
 *
 * 2. It reports `reads` — the number of samples where the engine AND the node
 *    both resolved. Without it, "the channel is silent" and "the sampler never
 *    found the engine" BOTH return 0.0 and are indistinguishable from the
 *    output. Every caller asserts `reads > 0` before believing a zero.
 *
 * 3. The wait is a CONDITION with a bound, not a budget. `minRms` short-
 *    circuits it, so the generous `AUDIO_SETTLE_MS` costs nothing on a healthy
 *    run and a slow machine cannot turn "not yet" into "never".
 */
async function readTaps(
  page: Page,
  nodeId: string,
  opts: { minRms?: number; timeoutMs?: number; settleMs?: number } = {},
): Promise<Taps> {
  const minRms = opts.minRms ?? 0;
  const timeoutMs = opts.timeoutMs ?? AUDIO_SETTLE_MS;
  // Once the target level is reached, keep sampling briefly so the OTHER
  // channel is measured over a comparable window — the silence assertion has
  // to be about the same stretch of time as the audibility one.
  const settleMs = opts.settleMs ?? 400;
  return await page.evaluate(
    async ({ nodeId, minRms, timeoutMs, settleMs }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: {
          nodes: Record<string, { id: string; type: string; domain: string } | undefined>;
        };
      };
      const rms = (s?: Float32Array) => {
        if (!s?.length) return 0;
        let q = 0;
        for (let i = 0; i < s.length; i++) q += s[i]! * s[i]!;
        return Math.sqrt(q / s.length);
      };
      const t0 = performance.now();
      const peak = { l: 0, r: 0, mono: 0, samples: 0, reads: 0, elapsedMs: 0 };
      let hitAt = -1;
      const sample = () => {
        peak.samples += 1;
        const eng = w.__engine?.();
        const node = w.__patch.nodes[nodeId];
        if (!eng || !node) return;
        peak.reads += 1;
        const read = (k: string) => eng.read(node, k) as { samples: Float32Array } | undefined;
        peak.l = Math.max(peak.l, rms(read('outputSnapshotL')?.samples));
        peak.r = Math.max(peak.r, rms(read('outputSnapshotR')?.samples));
        peak.mono = Math.max(peak.mono, rms(read('outputSnapshot')?.samples));
      };
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          sample();
          peak.elapsedMs = Math.round(performance.now() - t0);
          resolve();
        };
        // ⚠ IRREGULAR interval, not a fixed grid. Each read is an RMS over the
        // analyser's whole 2048-sample buffer (~42 ms), which is already
        // phase-independent for a steady tone — but a fixed period against a
        // PERIODIC subject is the aliasing shape CLAUDE.md calls out (an even
        // lag against a period-2 signal reads as a constant), and a co-prime
        // jitter costs nothing. Chosen so successive reads walk the waveform
        // rather than landing on the same phase.
        const JITTER_MS = [7, 11, 13, 9];
        let tick = 0;
        const step = () => {
          sample();
          const now = performance.now();
          if (hitAt < 0 && minRms > 0 && Math.max(peak.l, peak.r) >= minRms) hitAt = now;
          if (hitAt >= 0 && now - hitAt >= settleMs) return done();
          if (now - t0 >= timeoutMs) return done();
          timer = setTimeout(step, JITTER_MS[tick++ % JITTER_MS.length]!);
        };
        let timer = setTimeout(step, JITTER_MS[0]!);
      });
      return peak;
    },
    { nodeId, minRms, timeoutMs, settleMs },
  );
}

/**
 * Wait until ONE channel has gone quiet while the OTHER is still speaking, then
 * report both — for asserting silence AFTER a change.
 *
 * ⚠ WHY `readTaps` CANNOT DO THIS. It PEAK-HOLDS across its whole window, which
 * is exactly right for "is this channel alive" (a scheduling stall cannot read
 * as silence) and exactly WRONG across a transition: called straight after
 * dropping the R leg it reports the pre-teardown tail and says R=0.40485 when R
 * is on its way to zero. Measured, on the first run of the round-trip test.
 *
 * So this keeps a SLIDING window and asks whether the RECENT peak is quiet —
 * a settling condition, bounded, never a sleep.
 *
 * The `&& other side still audible` clause is a NEGATIVE CONTROL baked into the
 * instrument: without it, the engine dying, the context suspending, or the whole
 * patch being torn down would all satisfy "R is quiet" and pass.
 */
async function readTapsSettled(
  page: Page,
  nodeId: string,
  opts: { silent: 'l' | 'r'; minRms: number; silentRms: number; timeoutMs?: number },
): Promise<Taps & { settled: boolean }> {
  const timeoutMs = opts.timeoutMs ?? AUDIO_SETTLE_MS;
  return await page.evaluate(
    async ({ nodeId, silent, minRms, silentRms, timeoutMs }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: {
          nodes: Record<string, { id: string; type: string; domain: string } | undefined>;
        };
      };
      const rms = (s?: Float32Array) => {
        if (!s?.length) return 0;
        let q = 0;
        for (let i = 0; i < s.length; i++) q += s[i]! * s[i]!;
        return Math.sqrt(q / s.length);
      };
      const WINDOW_MS = 250; // the sliding "recent" span
      const t0 = performance.now();
      const recent: { t: number; l: number; r: number; mono: number }[] = [];
      let samples = 0;
      let reads = 0;
      let settled = false;
      const JITTER = [7, 11, 13, 9];
      let tick = 0;

      await new Promise<void>((resolve) => {
        const step = () => {
          samples += 1;
          const eng = w.__engine?.();
          const node = w.__patch.nodes[nodeId];
          if (eng && node) {
            reads += 1;
            const rd = (k: string) => eng.read(node, k) as { samples: Float32Array } | undefined;
            recent.push({
              t: performance.now(),
              l: rms(rd('outputSnapshotL')?.samples),
              r: rms(rd('outputSnapshotR')?.samples),
              mono: rms(rd('outputSnapshot')?.samples),
            });
          }
          const now = performance.now();
          while (recent.length > 0 && now - recent[0]!.t > WINDOW_MS) recent.shift();
          if (recent.length > 3) {
            const peak = (k: 'l' | 'r') => Math.max(...recent.map((e) => e[k]));
            const quiet = peak(silent);
            const loud = peak(silent === 'l' ? 'r' : 'l');
            if (quiet < silentRms && loud >= minRms) {
              settled = true;
              return resolve();
            }
          }
          if (now - t0 >= timeoutMs) return resolve();
          setTimeout(step, JITTER[tick++ % JITTER.length]!);
        };
        setTimeout(step, JITTER[0]!);
      });

      const peak = (k: 'l' | 'r' | 'mono') =>
        recent.length === 0 ? 0 : Math.max(...recent.map((e) => e[k]));
      return {
        l: peak('l'),
        r: peak('r'),
        mono: peak('mono'),
        samples,
        reads,
        elapsedMs: Math.round(performance.now() - t0),
        settled,
      };
    },
    { nodeId, silent: opts.silent, minRms: opts.minRms, silentRms: opts.silentRms, timeoutMs },
  );
}

/** Assert the sampler actually looked. A zero from an instrument that never
 *  resolved the engine is not evidence of silence — it is evidence of nothing,
 *  and it would make every assertion in this file pass for the wrong reason. */
function expectInstrumentLive(t: Taps, where: string): void {
  expect(
    t.reads,
    `${where}: the sampler never resolved the engine + AUDIO OUT node ` +
      `(samples=${t.samples}, reads=0, elapsed=${t.elapsedMs}ms). Every RMS ` +
      `below would read 0.0 for that reason alone.`,
  ).toBeGreaterThan(0);
}

async function readEdgeIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __patch: {
        edges: Record<
          string,
          | {
              id: string;
              source: { nodeId: string; portId: string };
              target: { nodeId: string; portId: string };
            }
          | undefined
        >;
      };
    };
    return Object.values(w.__patch.edges)
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => `${e.source.nodeId}.${e.source.portId}->${e.target.nodeId}.${e.target.portId}`)
      .sort();
  });
}

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

/**
 * The gesture: RIGHT-CLICK the collapsed stereo output row → pick a channel
 * mode (or leave it at stereo) → pick the target module + its collapsed input
 * jack.
 *
 * `channel: null` exercises the same menu with the default 'both' row still
 * selected, so the stereo control and the only-L/R cases differ by exactly one
 * click and nothing else.
 */
async function patchChannel(
  page: Page,
  src: { nodeId: string; portId: string },
  dst: { nodeId: string; portId: string },
  channel: 'both' | 'left' | 'right',
) {
  await page
    .locator(`.svelte-flow__node[data-id="${src.nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(chrome(page, src.nodeId)).toHaveAttribute('aria-hidden', 'false');
  await chrome(page, src.nodeId)
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();
  const row = chrome(page, src.nodeId).locator(
    `[data-testid="patch-panel-port-row"][data-port-id="${src.portId}"]`,
  );
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });

  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  // The channel rows must EXIST for this source — their absence would make
  // the click below a no-op and the test would then measure the stereo case
  // while claiming to measure only-L.
  const modes = menu.locator('[data-testid="patch-channel-mode"]');
  await expect(modes).toHaveCount(3);
  await menu.locator(`[data-testid="patch-channel-mode"][data-mode="${channel}"]`).click();
  await expect(
    menu.locator(`[data-testid="patch-channel-mode"][data-mode="${channel}"]`),
  ).toHaveAttribute('data-selected', 'true');

  await menu.locator(`[data-testid="patch-to-module"][data-node-id="${dst.nodeId}"]`).click();
  // ⚠ `data-leg=""` PICKS THE PAIR ROW. A collapsed stereo target now offers
  // THREE rows — the pair, its L and its R (the per-leg drill-down added for
  // the ES-9 return case, where a MONO source has to name one side of a
  // collapsed input). Without the leg filter this locator matches all three and
  // Playwright fails on strict mode. The channel for these tests comes from the
  // SOURCE-side rows above, so the pair row is the right one here.
  const portRow = menu.locator(
    `[data-testid="patch-to-port"][data-port-id="${dst.portId}"][data-leg=""]`,
  );
  await expect(portRow).toBeVisible();
  await portRow.click();
  await expect(menu).toHaveCount(0);
}

/**
 * THE STEREO RIG: a free-running `analogVco` → `resofilter` → AUDIO OUT.
 *
 * `resofilter` is the source under test because it is a genuine mono→stereo
 * generator: one `audio` input, a declared `out_l`/`out_r` pair, and its worklet
 * runs independent per-channel state (its own docs: "with a mono input OUT R
 * carries the same filtered signal as OUT L"). Both channels are therefore
 * ALIVE at defaults, which is exactly what an only-L/R test needs.
 *
 * ⚠ NOT tidyVco, the obvious first pick — it is a VOICE with a gated amp
 * envelope, so with nothing patched into its `gate` it is silent, and every
 * "R is silent" assertion here would have passed for the wrong reason. The
 * `analogVco` free-runs (internal default frequency + a silence-injecting
 * ConstantSource), which is why the cold-load spec uses it for the same job.
 *
 * The VCO→filter cable is seeded through `spawnPatch`, NOT through the UI: the
 * gesture under test is the ONE cable from the filter to AUDIO OUT, and seeding
 * the upstream keeps the audio verdict about that cable alone.
 */
async function spawnStereoRig(page: Page, srcId = 'osc') {
  await spawnPatch(
    page,
    [
      { id: `${srcId}-vco`, type: 'analogVco', position: { x: 40, y: 40 }, domain: 'audio' },
      { id: srcId, type: 'resofilter', position: { x: 460, y: 40 }, domain: 'audio' },
      {
        id: 'aout',
        type: 'audioOut',
        position: { x: 1100, y: 40 },
        domain: 'audio',
        params: { master: 0.9 },
      },
    ],
    [
      {
        id: `e-${srcId}-in`,
        from: { nodeId: `${srcId}-vco`, portId: 'sine' },
        to: { nodeId: srcId, portId: 'audio' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );
}

/** Two independent stereo sources into ONE AUDIO OUT — the leg-occupancy rig. */
async function spawnTwoStereoSources(page: Page) {
  await spawnPatch(
    page,
    [
      { id: 'vcoA', type: 'analogVco', position: { x: 40, y: 40 }, domain: 'audio' },
      { id: 'oscA', type: 'resofilter', position: { x: 460, y: 40 }, domain: 'audio' },
      { id: 'vcoB', type: 'analogVco', position: { x: 40, y: 620 }, domain: 'audio' },
      { id: 'oscB', type: 'resofilter', position: { x: 460, y: 620 }, domain: 'audio' },
      {
        id: 'aout',
        type: 'audioOut',
        position: { x: 1100, y: 320 },
        domain: 'audio',
        params: { master: 0.9 },
      },
    ],
    [
      {
        id: 'e-a-in',
        from: { nodeId: 'vcoA', portId: 'sine' },
        to: { nodeId: 'oscA', portId: 'audio' },
        sourceType: 'audio',
        targetType: 'audio',
      },
      {
        id: 'e-b-in',
        from: { nodeId: 'vcoB', portId: 'sine' },
        to: { nodeId: 'oscB', portId: 'audio' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );
}

test.describe('patch only L / only R', () => {
  test('the SOURCE is genuinely stereo — the control this whole file rests on', async ({
    page,
    rack,
  }) => {
    // If this fails, every "R is silent" assertion below is meaningless: a
    // channel that was never alive reads exactly like a channel we silenced.
    await spawnStereoRig(page);
    await patchChannel(page, { nodeId: 'osc', portId: 'out_l' }, { nodeId: 'aout', portId: 'L' }, 'both');

    // ONE stereo cable = TWO legs, L→L and R→R.
    await expect.poll(() => readEdgeIds(page), { timeout: 4000 }).toEqual([
      'osc-vco.sine->osc.audio',
      'osc.out_l->aout.L',
      'osc.out_r->aout.R',
    ]);

    // ONE measurement window for BOTH channels, so "audible" and "silent" are
    // claims about the same stretch of time.
    const t = await readTaps(page, 'aout', { minRms: AUDIBLE_RMS });
    expectInstrumentLive(t, 'stereo control');
    const seen = `RMS L=${t.l.toFixed(5)} R=${t.r.toFixed(5)} mono=${t.mono.toFixed(5)} ` +
      `(reads=${t.reads}/${t.samples} in ${t.elapsedMs}ms)`;
    expect(t.l, `LEFT channel dead on a FULL stereo patch — ${seen}`).toBeGreaterThan(AUDIBLE_RMS);
    expect(
      t.r,
      `RIGHT channel dead on a FULL stereo patch — the rig is not stereo, so ` +
        `every only-L/R assertion in this file would be vacuous. ${seen}`,
    ).toBeGreaterThan(AUDIBLE_RMS);
  });

  test('only L: outputSnapshotL is AUDIBLE and outputSnapshotR is SILENT', async ({
    page,
    rack,
  }) => {
    await spawnStereoRig(page);
    await patchChannel(page, { nodeId: 'osc', portId: 'out_l' }, { nodeId: 'aout', portId: 'L' }, 'left');

    // Exactly ONE leg in the graph — the L one.
    await expect.poll(() => readEdgeIds(page), { timeout: 4000 }).toEqual(['osc-vco.sine->osc.audio', 'osc.out_l->aout.L']);

    const t = await readTaps(page, 'aout', { minRms: AUDIBLE_RMS });
    expectInstrumentLive(t, 'only-L');
    const seen = `RMS L=${t.l.toFixed(5)} R=${t.r.toFixed(5)} mono=${t.mono.toFixed(5)} ` +
      `(reads=${t.reads}/${t.samples} in ${t.elapsedMs}ms)`;
    expect(t.l, `L should be audible on an only-L patch — ${seen}`).toBeGreaterThan(AUDIBLE_RMS);
    expect(
      t.r,
      `R should be SILENT on an only-L patch — ${seen}. Peak-held across the ` +
        `whole window, so this is a real zero and not a sampling stall.`,
    ).toBeLessThan(SILENT_RMS);
  });

  test('only R: outputSnapshotR is AUDIBLE and outputSnapshotL is SILENT', async ({
    page,
    rack,
  }) => {
    await spawnStereoRig(page);
    await patchChannel(page, { nodeId: 'osc', portId: 'out_l' }, { nodeId: 'aout', portId: 'L' }, 'right');

    // The R leg alone — note the row the user right-clicked was the LEFT one
    // (the collapsed jack is addressed to the left leg), and the commit still
    // wrote out_r→R. That is the whole channelMode contract.
    await expect.poll(() => readEdgeIds(page), { timeout: 4000 }).toEqual(['osc-vco.sine->osc.audio', 'osc.out_r->aout.R']);

    const t = await readTaps(page, 'aout', { minRms: AUDIBLE_RMS });
    expectInstrumentLive(t, 'only-R');
    const seen = `RMS L=${t.l.toFixed(5)} R=${t.r.toFixed(5)} mono=${t.mono.toFixed(5)} ` +
      `(reads=${t.reads}/${t.samples} in ${t.elapsedMs}ms)`;
    expect(t.r, `R should be audible on an only-R patch — ${seen}`).toBeGreaterThan(AUDIBLE_RMS);
    expect(
      t.l,
      `L should be SILENT on an only-R patch — ${seen}. Note the MONO tap ` +
        `reads the SAME value here as it does for only-L; that is exactly why ` +
        `this file reads the per-channel taps.`,
    ).toBeLessThan(SILENT_RMS);
  });

  test('LEG OCCUPANCY: A-only-L and B-only-R coexist on one AUDIO OUT, one channel each', async ({
    page,
    rack,
  }) => {
    // Owner decision Q4: an only-X patch replaces only the X leg. Two different
    // sources therefore share one stereo input — and each one owns a channel.
    await spawnTwoStereoSources(page);

    await patchChannel(page, { nodeId: 'oscA', portId: 'out_l' }, { nodeId: 'aout', portId: 'L' }, 'left');
    await expect.poll(() => readEdgeIds(page), { timeout: 4000 }).toEqual(['oscA.out_l->aout.L', 'vcoA.sine->oscA.audio', 'vcoB.sine->oscB.audio']);

    await patchChannel(page, { nodeId: 'oscB', portId: 'out_l' }, { nodeId: 'aout', portId: 'L' }, 'right');
    // BOTH survive. A whole-input eviction would have taken A's L leg with it.
    await expect
      .poll(() => readEdgeIds(page), { timeout: 4000 })
      .toEqual([
        'oscA.out_l->aout.L',
        'oscB.out_r->aout.R',
        'vcoA.sine->oscA.audio',
        'vcoB.sine->oscB.audio',
      ]);

    // …and BOTH channels speak: A owns L, B owns R.
    const t = await readTaps(page, 'aout', { minRms: AUDIBLE_RMS });
    expectInstrumentLive(t, 'leg occupancy');
    const seen = `RMS L=${t.l.toFixed(5)} R=${t.r.toFixed(5)} ` +
      `(reads=${t.reads}/${t.samples} in ${t.elapsedMs}ms)`;
    expect(t.l, `A's only-L leg must speak on LEFT — ${seen}`).toBeGreaterThan(AUDIBLE_RMS);
    expect(t.r, `B's only-R leg must speak on RIGHT — ${seen}`).toBeGreaterThan(AUDIBLE_RMS);
  });

  test('a FULL stereo patch REPLACES an only-L cable from another source', async ({
    page,
    rack,
  }) => {
    // The other half of leg-level occupancy, and the negative control for the
    // test above: co-existence is a property of SINGLE-leg patches, not a
    // blanket "never evict".
    await spawnTwoStereoSources(page);
    await patchChannel(page, { nodeId: 'oscA', portId: 'out_l' }, { nodeId: 'aout', portId: 'L' }, 'left');
    await patchChannel(page, { nodeId: 'oscB', portId: 'out_l' }, { nodeId: 'aout', portId: 'L' }, 'both');
    await expect
      .poll(() => readEdgeIds(page), { timeout: 4000 })
      .toEqual([
        'oscB.out_l->aout.L',
        'oscB.out_r->aout.R',
        'vcoA.sine->oscA.audio',
        'vcoB.sine->oscB.audio',
      ]);
  });

  test('ONE BEZIER PER LEG GROUP: the demo patch is 6 edges and 5 cables', async ({
    page,
    rack,
  }) => {
    // THE cable-dedupe pin, and the reason six specs now say 5 where they used
    // to say 6. The "sequenced-vco" demo ends `vca.audio → out.L` AND
    // `vca.audio → out.R` — one stereo cable written as two Edge records.
    // Drawing both would put two beziers between the same two cards, anchored
    // at the same hidden corner handle stack: a visually fat cable that deletes
    // half at a time.
    await loadVoiceDemo(page);
    await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

    // SIX in the graph…
    await expect
      .poll(async () => (await readEdgeIds(page)).length, { timeout: 5000 })
      .toBe(6);
    // …FIVE on the canvas. Asserting both is what makes this a dedupe test
    // rather than an accommodation of a smaller number.
    await expect(page.locator('.svelte-flow__edge')).toHaveCount(5);

    // …and the surviving stereo cable is drawn by the LEFT leg, SOLID (it is a
    // complete pair, not an only-L).
    const stereo = page.locator('.svelte-flow__edge[data-id="e-vd-vca-audio-vd-out-L"]');
    await expect(stereo).toHaveCount(1);
    await expect(stereo).not.toHaveClass(/cable-left-only|cable-right-only/);
    await expect(page.locator('.svelte-flow__edge[data-id="e-vd-vca-audio-vd-out-R"]')).toHaveCount(
      0,
    );
  });

  test('a LEGACY single-leg cable renders DASHED with its channel tag', async ({
    page,
    rack,
  }) => {
    // A rack saved before leg groups carries `x → audioOut.L` and nothing on R.
    // Audio-identical to what it always was; the dashes are the app finally
    // saying half the image is silent. Seeded raw (not through the UI) because
    // the UI can no longer produce this shape by accident — which is the point.
    await spawnPatch(
      page,
      [
        { id: 'vco', type: 'analogVco', position: { x: 80, y: 100 }, domain: 'audio' },
        { id: 'aout', type: 'audioOut', position: { x: 760, y: 100 }, domain: 'audio' },
      ],
      [
        {
          id: 'legacy',
          from: { nodeId: 'vco', portId: 'sine' },
          to: { nodeId: 'aout', portId: 'L' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );
    const cable = page.locator('.svelte-flow__edge[data-id="legacy"]');
    await expect(cable).toHaveClass(/cable-left-only/);
    await expect(cable).not.toHaveClass(/cable-right-only/);
    // The dashes are what the CSS actually produces — assert the computed
    // value, not the class, so a rule that stops matching (the class is on the
    // <g>, the stroke is on a descendant <path>) is a red test.
    // (Chromium serialises the computed value comma-separated.)
    await expect(cable.locator('.svelte-flow__edge-path')).toHaveCSS(
      'stroke-dasharray',
      '4px, 4px',
    );

    // The channel TAG — dashes alone say "partial", not WHICH half. ⚠ xyflow
    // PORTALS an edge label out of the edge element into its own `edge-labels`
    // container, so it is deliberately NOT looked up under `cable`: a
    // descendant locator here would find nothing and read as "no tag" whether
    // or not one was rendered.
    const labels = page.locator('.svelte-flow__edge-label');
    await expect(labels).toHaveCount(1);
    await expect(labels).toHaveText('L');
  });

  test('a LIVE stereo cable round-trips stereo → L only → stereo from the UNPATCH menu', async ({
    page,
    rack,
  }) => {
    // THE OWNER-REPORTED GAP: right-clicking a PATCHED output opened only the
    // unpatch menu — `onPortRowContextMenu` returns as soon as that menu claims
    // the event — so "patch only L/R" existed exclusively on an UNPATCHED
    // output. A live cable could not be narrowed without unpatching and
    // re-patching it. The channel chips now ride on the unpatch menu.
    //
    // SEMANTICS (flagged in the PR for the owner to overrule): narrowing DROPS
    // the other leg rather than muting it — a muted-but-present edge is
    // invisible state. So the round trip is asserted on the GRAPH as well as
    // the audio.
    await spawnStereoRig(page);
    await patchChannel(page, { nodeId: 'osc', portId: 'out_l' }, { nodeId: 'aout', portId: 'L' }, 'both');
    await expect.poll(() => readEdgeIds(page), { timeout: 4000 }).toEqual([
      'osc-vco.sine->osc.audio',
      'osc.out_l->aout.L',
      'osc.out_r->aout.R',
    ]);

    // Right-click the now-PATCHED output row → the unpatch menu, carrying the
    // channel chips with `both` selected.
    const openMenu = async () => {
      // ⚠ RESET TO A KNOWN STATE FIRST. Two things persist between passes and
      // each one hung this helper in turn: the trigger TOGGLES (so a second
      // click closes the chrome), and the panel keeps its DRILL VIEW (so the
      // chrome can be open on the outputs list, where the root nav row does not
      // exist). Escape closes it outright, so every pass starts from shut and
      // walks the same path — deterministic instead of state-sniffing.
      await page.keyboard.press('Escape');
      await expect(chrome(page, 'osc')).toHaveCount(0);
      await page
        .locator('.svelte-flow__node[data-id="osc"] [data-testid="patch-trigger"]')
        .click();
      await expect(chrome(page, 'osc')).toHaveAttribute('aria-hidden', 'false');
      await chrome(page, 'osc')
        .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
        .click();
      await chrome(page, 'osc')
        .locator('[data-testid="patch-panel-port-row"][data-port-id="out_l"]')
        .click({ button: 'right' });
      const menu = page.locator('[data-testid="unpatch-menu"]');
      await expect(menu).toBeVisible();
      return menu;
    };

    let menu = await openMenu();
    // The header names the JACK, not a leg — the label-drift bug the owner
    // also reported. `OUT`, never `OUT_L`.
    await expect(menu.getByTestId('unpatch-menu-title')).toHaveText(/\bOUT\b/);
    await expect(menu.getByTestId('unpatch-menu-title')).not.toHaveText(/OUT_L/);
    await expect(menu.getByTestId('unpatch-channel-mode')).toHaveCount(3);
    await expect(
      menu.locator('[data-testid="unpatch-channel-mode"][data-mode="both"]'),
    ).toHaveAttribute('data-selected', 'true');

    // → L only. The R leg is DROPPED, not muted.
    await menu.locator('[data-testid="unpatch-channel-mode"][data-mode="left"]').click();
    await expect.poll(() => readEdgeIds(page), { timeout: 4000 }).toEqual([
      'osc-vco.sine->osc.audio',
      'osc.out_l->aout.L',
    ]);
    // SETTLED, not peak-held: dropping the R leg leaves a decaying tail, and a
    // peak-hold across the transition reports it (measured: R=0.40485 on the
    // way to zero). The instrument's own negative control requires L to STILL
    // be audible, so "the whole engine died" cannot pass as "R went quiet".
    // `settled` is only meaningful on the readTapsSettled read; the later
    // readTaps re-read (plain Taps) reuses the same binding, so it is optional.
    let t: Taps & { settled?: boolean } = await readTapsSettled(page, 'aout', {
      silent: 'r',
      minRms: AUDIBLE_RMS,
      silentRms: SILENT_RMS,
    });
    expectInstrumentLive(t, 'after → L only');
    const seenNarrow =
      `RMS L=${t.l.toFixed(5)} R=${t.r.toFixed(5)} ` +
      `(settled=${t.settled} reads=${t.reads}/${t.samples} in ${t.elapsedMs}ms)`;
    expect(t.settled, `R never went quiet after dropping its leg — ${seenNarrow}`).toBe(true);
    expect(t.l, `L must still be audible after narrowing — ${seenNarrow}`).toBeGreaterThan(
      AUDIBLE_RMS,
    );
    expect(t.r, `R must be silent after narrowing — ${seenNarrow}`).toBeLessThan(SILENT_RMS);

    // → back to stereo. The dropped leg is re-derived, so the trip is lossless.
    menu = await openMenu();
    await expect(
      menu.locator('[data-testid="unpatch-channel-mode"][data-mode="left"]'),
      'the menu now reports the cable as L-only',
    ).toHaveAttribute('data-selected', 'true');
    await menu.locator('[data-testid="unpatch-channel-mode"][data-mode="both"]').click();
    await expect.poll(() => readEdgeIds(page), { timeout: 4000 }).toEqual([
      'osc-vco.sine->osc.audio',
      'osc.out_l->aout.L',
      'osc.out_r->aout.R',
    ]);
    t = await readTaps(page, 'aout', { minRms: AUDIBLE_RMS });
    expectInstrumentLive(t, 'after → stereo');
    expect(t.r, `R speaks again after widening — L=${t.l.toFixed(5)} R=${t.r.toFixed(5)}`).toBeGreaterThan(
      AUDIBLE_RMS,
    );
  });

  test('the unpatch menu shows NO channel chips on a mono cable', async ({ page, rack }) => {
    // Scope control for the chips: without it, "the chips are there" would be
    // untested for the case where they must NOT be, and an always-on chip row
    // would satisfy the round-trip test above.
    await spawnPatch(
      page,
      [
        { id: 'vco', type: 'analogVco', position: { x: 80, y: 100 }, domain: 'audio' },
        { id: 'vca', type: 'vca', position: { x: 520, y: 100 }, domain: 'audio' },
      ],
      [
        {
          id: 'mono',
          from: { nodeId: 'vco', portId: 'sine' },
          to: { nodeId: 'vca', portId: 'audio' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );
    await page.locator('.svelte-flow__node[data-id="vca"] [data-testid="patch-trigger"]').click();
    await chrome(page, 'vca')
      .locator('[data-testid="patch-panel-nav"][data-nav="inputs"]')
      .click();
    await chrome(page, 'vca')
      .locator('[data-testid="patch-panel-port-row"][data-port-id="audio"]')
      .click({ button: 'right' });
    const menu = page.locator('[data-testid="unpatch-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('unpatch-item')).toHaveCount(1);
    await expect(menu.getByTestId('unpatch-channel-mode')).toHaveCount(0);
  });

  test('the channel rows are ABSENT on a MONO output (nothing to take a side of)', async ({
    page,
    rack,
  }) => {
    // Scope guard: without it, "the rows are there" would be untested for the
    // case where they must NOT be, and an always-on menu would pass every test
    // above.
    //
    // ⚠ WHAT CHANGED, and why this is a STRICTLY STRONGER test than before.
    // Right-clicking a mono output used to do NOTHING — the event fell through
    // to the browser menu — so this asserted `port-context-menu` count 0. That
    // conflated two different facts: "no channel rows" and "no menu". It also
    // made the owner's ES-9 return unbuildable, because the source he patches
    // FROM (`es9.in14`) is a mono hardware point and the gesture he reached for
    // was dead on exactly the port that needed it. Every output now opens the
    // picker; the CHANNEL ROWS still appear only where there is a side to take,
    // which is the scope this test actually exists to pin — and it now pins it
    // against a menu that is really there rather than against its absence.
    await spawnPatch(page, [
      { id: 'vca', type: 'vca', position: { x: 80, y: 100 }, domain: 'audio' },
      { id: 'aout', type: 'audioOut', position: { x: 760, y: 100 }, domain: 'audio' },
    ]);
    await page
      .locator('.svelte-flow__node[data-id="vca"] [data-testid="patch-trigger"]')
      .click();
    await chrome(page, 'vca')
      .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
      .click();
    await chrome(page, 'vca')
      .locator('[data-testid="patch-panel-port-row"][data-port-id="audio"]')
      .click({ button: 'right' });
    const menu = page.locator('[data-testid="port-context-menu"]');
    await expect(menu, 'every output is right-clickable to "patch to…"').toBeVisible();
    await expect(
      menu.locator('[data-testid="patch-channel-mode"]'),
      "VCA's `audio` output is not half of anything — there is no side to take",
    ).toHaveCount(0);
  });
});
