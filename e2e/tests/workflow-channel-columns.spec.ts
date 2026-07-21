// e2e/tests/workflow-channel-columns.spec.ts
//
// WORKFLOW CHANNEL COLUMNS — acceptance. Drives the REAL palette-drop path into
// numbered channel columns + the sends rail (via __setSpawnFlowPos +
// __spawnFromPalette, which run the actual wcolDropTarget → membership + order +
// automation + reconcile pipeline — NOT a raw graph write), then proves:
//
//   1. WIRING (deterministic): the reconciler owns the wcol- edge set — clip
//      control on the source, send-to-mixer on the tail, automation lane per
//      channel — with the right membership/order manifest.
//   2. REAL SOURCE CHAIN (the poly-real-source rule): the PINNED clip player
//      drives each dropped instrument (tidyvco/kickdrum/wavesculpt on ch1/2/3)
//      and each channel registers audible RMS at the mixer's per-channel meter
//      AND at the pinned AUDIO OUT — i.e. clip → module → mixer → out really
//      carries audio, driven end-to-end (not engine-direct).
//   3. SENDS: a DSP dropped in SEND 1 forms the aux loop (send1 → FX → ret1),
//      the source channel's send amount auto-raises, and with the dry channel
//      muted the WET-only path is still audible.
//
// Driving /rack?mode=workflow keeps this in the normal e2e lane (no DB/relay).
// Audio RMS uses the same real AudioContext the other audio specs assert on (the
// --autoplay-policy launch flag lets it start headless); thresholds are tolerant
// and timeouts generous for the CI software renderer / slow round-trips.

import { test, expect, type Page } from '@playwright/test';

/** channel-columns.ts geometry (kept in sync with the pure module). */
const COLUMN_W = 360; // 16 * HP_UNIT(22.5)
const SEND_RAIL_X0 = 8 * COLUMN_W; // 2880

const PINNED_MIXER = 'pinned-mixmstrs';
const PINNED_CLIP = 'pinned-clipplayer';

/** A flow-space spawn anchor inside channel column `ch` (top area → append). */
function colPos(ch: number): { x: number; y: number } {
  return { x: (ch - 1) * COLUMN_W + 60, y: 40 };
}
/** A flow-space spawn anchor inside send box `box` (1 = top half, 2 = bottom). */
function sendPos(box: number): { x: number; y: number } {
  return { x: SEND_RAIL_X0 + 60, y: box === 1 ? 100 : 3200 };
}

async function waitForPinnedTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return !!w.__patch && ['pinned-mixmstrs', 'pinned-clipplayer', 'pinned-audioOut'].every(
        (id) => w.__patch!.nodes[id]?.data?.pinned === true,
      );
    },
    undefined,
    { timeout: 15_000 },
  );
}

/** Drive the REAL palette-drop path: anchor the spawn in `pos`, spawn `type`. */
async function dropInBand(page: Page, type: string, pos: { x: number; y: number }): Promise<void> {
  await page.evaluate(
    ({ type, pos }) => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
      };
      w.__setSpawnFlowPos(pos);
      w.__spawnFromPalette(type);
    },
    { type, pos },
  );
}

/** The pinned mixer's order array for a column (or send box). */
async function orderOf(page: Page, kind: 'columns' | 'sends', key: number): Promise<string[]> {
  return page.evaluate(
    ({ kind, key }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, Record<string, string[]>> } | undefined> };
      };
      return w.__patch.nodes['pinned-mixmstrs']?.data?.[kind]?.[String(key)] ?? [];
    },
    { kind, key },
  );
}

/** Every wcol- edge `src.port->dst.port` string, for structural assertions. */
async function wcolEdges(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined> };
    };
    return Object.entries(w.__patch.edges)
      .filter(([id, e]) => e && id.startsWith('wcol-e-'))
      .map(([, e]) => `${e!.source.nodeId}.${e!.source.portId}->${e!.target.nodeId}.${e!.target.portId}`);
  });
}

/** The clip player's automation-lane assignment for a module (or null). */
async function laneOf(page: Page, moduleId: string): Promise<number | null> {
  return page.evaluate((mid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { autoAssign?: Record<string, number> } } | undefined> };
    };
    const a = w.__patch.nodes['pinned-clipplayer']?.data?.autoAssign;
    return a && mid in a ? a[mid]! : null;
  }, moduleId);
}

/** Seed a looping single-note clip on each `lane` (slot 0), LAUNCH it (via the
 *  card's store-safe queued/queuedImmediate path — the engine applies it to the
 *  `playing` set), and run the transport — the pinned clip player then drives
 *  channel `lane+1` through the reconciler's clip-control edges. */
async function seedAndRun(page: Page, lanes: number[]): Promise<void> {
  await page.evaluate((lanes) => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, { type?: string; params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
    };
    w.__ydoc.transact(() => {
      const cp = w.__patch.nodes['pinned-clipplayer']!;
      if (!cp.data) cp.data = {};
      const d = cp.data as { clips?: Record<string, unknown>; queued?: (number | 'stop' | null)[]; queuedImmediate?: boolean[] };
      if (!d.clips) d.clips = {};
      // A DENSE pattern (a note every 4 steps) keeps each instrument retriggering
      // ~4×/bar, so the per-channel meters and the reverb-tail WET path hold a
      // steady RMS well above threshold (no marginal single-note-per-bar dip).
      const steps = [0, 4, 8, 12].map((step) => ({ step, midi: 60 }));
      for (const lane of lanes) {
        d.clips[String(lane * 64)] = { kind: 'note', steps, lengthSteps: 16, root: 48, loop: true };
      }
      // LAUNCH via queued (fresh key — SyncedStore rejects REPLACING the existing
      // `playing` Y.Array; the card's queueLane rebuild-and-assign is the safe
      // path, and the engine promotes queued→playing on the next tick).
      const queued = new Array(8).fill(null) as (number | 'stop' | null)[];
      const imm = new Array(8).fill(false) as boolean[];
      for (const lane of lanes) { queued[lane] = 0; imm[lane] = true; }
      d.queued = queued;
      d.queuedImmediate = imm;
      for (const n of Object.values(w.__patch.nodes)) {
        if (n?.type === 'timelorde') { n.params.running = 1; n.params.bpm = 120; }
      }
    });
  }, lanes);
}

/** Poll for `durationMs`, accumulating the per-channel MAX mixmstrs meter RMS
 *  (read('levels') → number[8]) and the MAX pinned AUDIO OUT RMS. */
async function pollAudio(
  page: Page,
  durationMs: number,
): Promise<{ channelMax: number[]; outMax: number }> {
  const channelMax = new Array(8).fill(0);
  let outMax = 0;
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const sample = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
      };
      const eng = w.__engine?.();
      const mixer = w.__patch.nodes['pinned-mixmstrs'];
      const out = w.__patch.nodes['pinned-audioOut'];
      const levels = eng && mixer ? (eng.read(mixer, 'levels') as number[] | undefined) : undefined;
      let outRms = 0;
      if (eng && out) {
        const snap = eng.read(out, 'outputSnapshot') as { samples: Float32Array } | undefined;
        if (snap?.samples?.length) {
          let s = 0;
          for (let i = 0; i < snap.samples.length; i++) s += snap.samples[i]! * snap.samples[i]!;
          outRms = Math.sqrt(s / snap.samples.length);
        }
      }
      return { levels: levels ?? [], outRms };
    });
    for (let i = 0; i < sample.levels.length && i < 8; i++) {
      channelMax[i] = Math.max(channelMax[i], sample.levels[i] ?? 0);
    }
    outMax = Math.max(outMax, sample.outRms);
    await page.waitForTimeout(40);
  }
  return { channelMax, outMax };
}

test.describe('workflow channel columns', () => {
  test('palette-drop into columns 1/2/3 wires clip-control + tail send + automation lane', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);

    await dropInBand(page, 'tidyVco', colPos(1));
    await dropInBand(page, 'kickdrum', colPos(2));
    await dropInBand(page, 'wavesculpt', colPos(3));

    // Membership + order manifest.
    const [c1, c2, c3] = [await orderOf(page, 'columns', 1), await orderOf(page, 'columns', 2), await orderOf(page, 'columns', 3)];
    expect(c1).toHaveLength(1);
    expect(c2).toHaveLength(1);
    expect(c3).toHaveLength(1);
    const [vco, kick, wav] = [c1[0]!, c2[0]!, c3[0]!];

    // Automation lanes assigned per channel (0-based).
    expect(await laneOf(page, vco)).toBe(0);
    expect(await laneOf(page, kick)).toBe(1);
    expect(await laneOf(page, wav)).toBe(2);

    // The reconciler-owned wcol edges materialize (clip → module; module → mixer).
    await expect.poll(async () => (await wcolEdges(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const edges = await wcolEdges(page);
    // tidyvco: poly clip control + stereo send.
    expect(edges).toContain(`${PINNED_CLIP}.pitch1->${vco}.poly`);
    expect(edges).toContain(`${vco}.out_l->${PINNED_MIXER}.ch1L`);
    expect(edges).toContain(`${vco}.out_r->${PINNED_MIXER}.ch1R`);
    // kickdrum on channel 2 sends to ch2; wavesculpt on channel 3 to ch3.
    expect(edges.some((e) => e.startsWith(`${kick}.`) && e.includes(`->${PINNED_MIXER}.ch2`))).toBe(true);
    expect(edges.some((e) => e.startsWith(`${wav}.`) && e.includes(`->${PINNED_MIXER}.ch3`))).toBe(true);
  });

  test('REAL source chain: the clip player drives each channel to audible RMS at the mixer + audio out', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);

    await dropInBand(page, 'tidyVco', colPos(1));
    await dropInBand(page, 'kickdrum', colPos(2));
    await dropInBand(page, 'wavesculpt', colPos(3));
    await expect.poll(async () => (await wcolEdges(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);

    // Drive the REAL chain: pinned clip player notes on lanes 0/1/2 → the wcol
    // clip-control edges → each instrument → its mixer channel → master → out.
    await seedAndRun(page, [0, 1, 2]);

    const { channelMax, outMax } = await pollAudio(page, 12_000);
    // Each of the three channels registers energy at its mixer meter…
    expect(channelMax[0], 'ch1 (tidyvco) audible at the mixer').toBeGreaterThan(0.002);
    expect(channelMax[1], 'ch2 (kickdrum) audible at the mixer').toBeGreaterThan(0.002);
    expect(channelMax[2], 'ch3 (wavesculpt) audible at the mixer').toBeGreaterThan(0.002);
    // …and the whole chain reaches the terminal audio out.
    expect(outMax, 'audible at the pinned AUDIO OUT').toBeGreaterThan(0.005);
  });

  test('SEND 1: a DSP forms the aux loop, the send amount auto-raises, and the WET-only path is audible', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);

    // One source in channel 1, then a reverb in SEND 1.
    await dropInBand(page, 'tidyVco', colPos(1));
    await dropInBand(page, 'reverb', sendPos(1));

    // The reverb joined send box 1 (membership + order).
    const s1 = await orderOf(page, 'sends', 1);
    expect(s1).toHaveLength(1);
    const rev = s1[0]!;

    // The aux loop is wired: mixer send1 → reverb; reverb → mixer ret1.
    await expect.poll(async () => (await wcolEdges(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const edges = await wcolEdges(page);
    expect(edges.some((e) => e.startsWith(`${PINNED_MIXER}.send1`) && e.includes(`->${rev}.`)), 'send1 → reverb').toBe(true);
    expect(edges.some((e) => e.startsWith(`${rev}.`) && e.includes(`->${PINNED_MIXER}.ret1`)), 'reverb → ret1').toBe(true);

    // Auto-raise fired for the channel that has a member (ch1_send1 > 0).
    const autoRaised = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> } };
      return w.__patch.nodes['pinned-mixmstrs']?.params?.['ch1_send1'] ?? 0;
    });
    expect(autoRaised, 'ch1_send1 auto-raised on first FX drop').toBeGreaterThan(0);

    // WET-ONLY proof: MUTE the dry channel (ch1_volume=0) but keep the send up.
    // Any RMS at the output can then only be the send → reverb → return path.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
      };
      w.__ydoc.transact(() => {
        const m = w.__patch.nodes['pinned-mixmstrs']!;
        m.params['ch1_volume'] = 0; // dry muted
        m.params['ch1_send1'] = 0.8; // send hot
      });
    });

    await seedAndRun(page, [0]);
    const { outMax } = await pollAudio(page, 16_000);
    expect(outMax, 'the WET send loop carries audio with the dry channel muted').toBeGreaterThan(0.002);
  });
});
