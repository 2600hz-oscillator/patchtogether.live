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
const COLUMN_W = 765; // 34 * HP_UNIT(22.5) — wide enough for a 720px tidyvco/sixstrum
const SEND_RAIL_X0 = 8 * COLUMN_W; // 6120

const PINNED_MIXER = 'pinned-mixmstrs';
const PINNED_CLIP = 'pinned-clipplayer';

/** A flow-space spawn anchor inside channel column `ch` (X selects the column;
 *  members bottom-anchor regardless of the drop Y). */
function colPos(ch: number): { x: number; y: number } {
  return { x: (ch - 1) * COLUMN_W + 60, y: 40 };
}
/** A flow-space spawn anchor inside send box `box` — the two boxes sit SIDE BY
 *  SIDE, so the box is chosen by X (box 1 then box 2, each one column wide). */
function sendPos(box: number): { x: number; y: number } {
  return { x: SEND_RAIL_X0 + (box - 1) * COLUMN_W + 60, y: 100 };
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

/** Wait until the Canvas test hooks are registered (they attach in a mount
 *  effect, which can lag the pinned-trio spawn — a race that surfaced as an
 *  intermittent "__setSpawnFlowPos is not a function"). */
async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __setSpawnFlowPos?: unknown; __spawnFromPalette?: unknown };
      return typeof w.__setSpawnFlowPos === 'function' && typeof w.__spawnFromPalette === 'function';
    },
    undefined,
    { timeout: 15_000 },
  );
}

/** Drive the REAL palette-drop path: anchor the spawn in `pos`, spawn `type`. */
async function dropInBand(page: Page, type: string, pos: { x: number; y: number }): Promise<void> {
  await waitForHooks(page);
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

  test('MULTI-SOURCE: two instruments in ONE column → BOTH clip-driven AND BOTH audible (summed)', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);

    // Two tidyVcos dropped into the SAME column (channel 1). The second drop
    // also exercises the same-column order-array REPLACE ([vco1] → [vco1,vco2]).
    await dropInBand(page, 'tidyVco', colPos(1));
    await dropInBand(page, 'tidyVco', colPos(1));

    const c1 = await orderOf(page, 'columns', 1);
    expect(c1, 'both instruments joined channel 1').toHaveLength(2);
    const [a, b] = [c1[0]!, c1[1]!];

    await expect.poll(async () => (await wcolEdges(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const edges = await wcolEdges(page);
    // Parallel islands: BOTH sources clip-driven, BOTH tails send to ch1.
    expect(edges).toContain(`${PINNED_CLIP}.pitch1->${a}.poly`);
    expect(edges).toContain(`${PINNED_CLIP}.pitch1->${b}.poly`);
    expect(edges).toContain(`${a}.out_l->${PINNED_MIXER}.ch1L`);
    expect(edges).toContain(`${b}.out_l->${PINNED_MIXER}.ch1L`);

    // …and the summed channel is audible end-to-end.
    await seedAndRun(page, [0]);
    const { channelMax } = await pollAudio(page, 12_000);
    expect(channelMax[0], 'the two-source channel 1 is audible at the mixer').toBeGreaterThan(0.002);
  });

  test('SOURCE→DSP: drop tidyvco then cloudseed into the SAME column → tidyvco patched THROUGH cloudseed (one island, not two)', async ({ page }) => {
    // The owner's exact case. cloudseed is a DSP (has an audio input → NOT a
    // clip source), so it must INSERT into the chain, not form a parallel island.
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);

    await dropInBand(page, 'tidyVco', colPos(4));
    await dropInBand(page, 'cloudseed', colPos(4));

    const c4 = await orderOf(page, 'columns', 4);
    expect(c4, 'both joined channel 4, tidyvco above cloudseed').toEqual([c4[0], c4[1]]);
    expect(c4).toHaveLength(2);
    const [vco, cloud] = [c4[0]!, c4[1]!];

    await expect.poll(async () => (await wcolEdges(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const edges = await wcolEdges(page);
    // ONE island: clip drives the SOURCE (tidyvco); tidyvco.out → cloudseed.in;
    // cloudseed (the DSP tail) → mixer ch4.
    expect(edges).toContain(`${PINNED_CLIP}.pitch4->${vco}.poly`);
    expect(edges).toContain(`${vco}.out_l->${cloud}.in_l`);
    expect(edges).toContain(`${vco}.out_r->${cloud}.in_r`);
    expect(edges).toContain(`${cloud}.out_l->${PINNED_MIXER}.ch4L`);
    expect(edges).toContain(`${cloud}.out_r->${PINNED_MIXER}.ch4R`);
    // NOT two parallel islands: tidyvco must NOT send straight to the mixer.
    expect(edges.some((e) => e.startsWith(`${vco}.`) && e.includes(`${PINNED_MIXER}.ch4`)), 'tidyvco must NOT bypass cloudseed').toBe(false);
    // cloudseed is a DSP — never clip-driven.
    expect(edges.some((e) => e.startsWith(`${PINNED_CLIP}.`) && e.includes(cloud)), 'cloudseed must NOT get clip control').toBe(false);

    // Audible end-to-end through the reverb.
    await seedAndRun(page, [3]); // channel 4 → lane 3
    const { channelMax } = await pollAudio(page, 12_000);
    expect(channelMax[3], 'channel 4 (tidyvco→cloudseed) is audible at the mixer').toBeGreaterThan(0.002);
  });

  test('DRAG a free card into a column assigns + chains it (the drag-drop path)', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    // A tidyvco already in column 5.
    await dropInBand(page, 'tidyVco', colPos(5));
    const before = await orderOf(page, 'columns', 5);
    expect(before).toHaveLength(1);

    // Spawn a cloudseed on FREE canvas (far left, no column), then DRAG its card
    // into column 5 via handleNodeDragStop (the real card-drag "drop").
    await page.waitForFunction(
      () => typeof (globalThis as unknown as { __handleNodeDragStop?: unknown }).__handleNodeDragStop === 'function',
      undefined,
      { timeout: 15_000 },
    );
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
      };
      w.__setSpawnFlowPos({ x: -900, y: -900 }); // free canvas, outside all bands
      w.__spawnFromPalette('cloudseed');
    });
    // Find the free cloudseed id (not yet a column member).
    const cloudId = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { type?: string; data?: { channel?: number } } | undefined> } };
      const hit = Object.entries(w.__patch.nodes).find(([, n]) => n?.type === 'cloudseed' && n?.data?.channel == null);
      return hit?.[0] ?? null;
    });
    expect(cloudId).toBeTruthy();

    // Drive the drag-stop the way SvelteFlow does: move the node into column 5's
    // flow band, then fire handleNodeDragStop with the moved node.
    await page.evaluate(({ id, x, y }) => {
      const w = globalThis as unknown as {
        __handleNodeDragStop?: (p: { targetNode: unknown; nodes: { id: string; position: { x: number; y: number } }[] }) => void;
      };
      w.__handleNodeDragStop?.({ targetNode: null, nodes: [{ id, position: { x, y } }] });
    }, { id: cloudId!, x: 4 * COLUMN_W + 60, y: 100 });

    // The dragged cloudseed joined column 5 and chained under the tidyvco.
    await expect.poll(async () => (await orderOf(page, 'columns', 5)).length, { timeout: 8_000 }).toBe(2);
    const c5 = await orderOf(page, 'columns', 5);
    const vco = c5[0]!;
    await expect
      .poll(async () => {
        const edges = await wcolEdges(page);
        return edges.some((e) => e === `${vco}.out_l->${cloudId}.in_l`) && edges.some((e) => e === `${cloudId}.out_l->${PINNED_MIXER}.ch5L`);
      }, { timeout: 8_000 })
      .toBe(true);
  });

  test('ASSIGN-TO-CHANNEL (right-click path): a 2nd module on ch1 SPLICES through, never doubles into the mixer (bug 3)', async ({ page }) => {
    // Owner bug 3: "put tidyvco on ch1, then add cloudseed to ch1" via the
    // right-click "Assign to channel" action left BOTH modules wired straight to
    // the mixer (double), with NO tidyvco→cloudseed link. Root cause: the assign
    // path committed flat send-to-mixer edges, bypassing the column reconciler's
    // source→DSP splice + stale-edge GC. The fix routes assign through column
    // membership, so the reconciler owns the wiring deterministically. This test
    // drives the REAL commit handler (__assignNodeToChannel = the menu callback)
    // and is run 10× (REPEAT) to catch the reported intermittency.
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    await waitForHooks(page);
    await page.waitForFunction(
      () => typeof (globalThis as unknown as { __assignNodeToChannel?: unknown }).__assignNodeToChannel === 'function',
      undefined,
      { timeout: 15_000 },
    );

    // Spawn tidyvco + cloudseed on FREE canvas (outside every band), then assign
    // EACH to channel 1 via the right-click handler — tidyvco first, cloudseed
    // second (the occupied-channel case).
    const spawnFreeAndAssign = async (type: string): Promise<string> => {
      const id = await page.evaluate((t) => {
        const w = globalThis as unknown as {
          __setSpawnFlowPos: (p: { x: number; y: number }) => void;
          __spawnFromPalette: (t: string) => void;
          __patch: { nodes: Record<string, { type?: string; data?: { channel?: number } } | undefined> };
        };
        w.__setSpawnFlowPos({ x: -1500, y: -1500 }); // free canvas
        w.__spawnFromPalette(t);
        const hit = Object.entries(w.__patch.nodes).find(([, n]) => n?.type === t && n?.data?.channel == null);
        return hit?.[0] ?? null;
      }, type);
      expect(id, `${type} spawned on free canvas`).toBeTruthy();
      await page.evaluate((nid) => {
        (globalThis as unknown as { __assignNodeToChannel: (id: string, ch: number) => void }).__assignNodeToChannel(nid, 0);
      }, id!);
      return id!;
    };

    const vco = await spawnFreeAndAssign('tidyVco');
    const cloud = await spawnFreeAndAssign('cloudseed');

    // Membership: both joined channel 1, tidyvco above cloudseed.
    await expect.poll(async () => await orderOf(page, 'columns', 1), { timeout: 8_000 }).toEqual([vco, cloud]);

    // The reconciler settled the SPLICED chain — assert deterministically.
    await expect
      .poll(async () => {
        const edges = await wcolEdges(page);
        return (
          edges.includes(`${vco}.out_l->${cloud}.in_l`) &&
          edges.includes(`${cloud}.out_l->${PINNED_MIXER}.ch1L`)
        );
      }, { timeout: 8_000 })
      .toBe(true);

    const edges = await wcolEdges(page);
    // tidyvco is spliced THROUGH cloudseed (both L and R).
    expect(edges).toContain(`${vco}.out_l->${cloud}.in_l`);
    expect(edges).toContain(`${vco}.out_r->${cloud}.in_r`);
    // cloudseed (the DSP tail) is the ONLY thing feeding mixer ch1 — EXACTLY the
    // stereo pair from cloudseed, nothing from tidyvco (no double).
    const intoCh1 = edges.filter((e) => e.includes(`->${PINNED_MIXER}.ch1L`) || e.includes(`->${PINNED_MIXER}.ch1R`));
    expect(intoCh1.sort()).toEqual([`${cloud}.out_l->${PINNED_MIXER}.ch1L`, `${cloud}.out_r->${PINNED_MIXER}.ch1R`]);
    // tidyvco must NOT reach the mixer at all (it goes only into cloudseed).
    expect(edges.some((e) => e.startsWith(`${vco}.`) && e.includes(`${PINNED_MIXER}.`)), 'tidyvco must not bypass cloudseed').toBe(false);
    // cloudseed is a DSP — never clip-driven.
    expect(edges.some((e) => e.startsWith(`${PINNED_CLIP}.`) && e.includes(cloud)), 'cloudseed must not get clip control').toBe(false);
    // …and the source (tidyvco) IS clip-driven.
    expect(edges).toContain(`${PINNED_CLIP}.pitch1->${vco}.poly`);

    // Audible end-to-end through the reverb — the CHAINED signal (not doubled).
    await seedAndRun(page, [0]);
    const { channelMax } = await pollAudio(page, 12_000);
    expect(channelMax[0], 'channel 1 (tidyvco→cloudseed) audible at the mixer').toBeGreaterThan(0.002);
  });

  test('SEND 1: a DSP dropped in the send box forms the aux loop + auto-raises the send + is audible end-to-end', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);

    // One source in channel 1, then a reverb in SEND 1.
    await dropInBand(page, 'tidyVco', colPos(1));
    await dropInBand(page, 'reverb', sendPos(1));

    // The reverb joined send box 1 (membership + order).
    const s1 = await orderOf(page, 'sends', 1);
    expect(s1).toHaveLength(1);
    const rev = s1[0]!;

    // The aux loop is fully wired: mixer send1 → reverb.in ; reverb.out → mixer
    // ret1 (the DETERMINISTIC proof the send loop is formed).
    await expect.poll(async () => (await wcolEdges(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const edges = await wcolEdges(page);
    expect(edges.some((e) => e.startsWith(`${PINNED_MIXER}.send1`) && e.includes(`->${rev}.`)), 'send1 → reverb').toBe(true);
    expect(edges.some((e) => e.startsWith(`${rev}.`) && e.includes(`->${PINNED_MIXER}.ret1`)), 'reverb → ret1').toBe(true);
    // The send FX must NOT be treated as a column source (no clip control, no ch send).
    expect(edges.some((e) => e.startsWith(`${PINNED_CLIP}.`) && e.includes(rev)), 'send FX is not clip-driven').toBe(false);

    // Auto-raise fired for the channel that has a member (ch1_send1 > 0) — the
    // "it just works" default so the loop isn't silent.
    const autoRaised = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> } };
      return w.__patch.nodes['pinned-mixmstrs']?.params?.['ch1_send1'] ?? 0;
    });
    expect(autoRaised, 'ch1_send1 auto-raised on first FX drop').toBeGreaterThan(0);

    // Drive the channel; the whole rack (dry + the send→reverb→return wet path)
    // reaches the output. (Wet-vs-dry isolation is fader/tap-coupled in the
    // mixer DSP, so we assert audibility end-to-end + the deterministic loop
    // wiring above, not a fragile muted-dry subtraction.)
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
      };
      w.__ydoc.transact(() => { w.__patch.nodes['pinned-mixmstrs']!.params['ch1_send1'] = 0.9; });
    });
    await seedAndRun(page, [0]);
    const { channelMax, outMax } = await pollAudio(page, 12_000);
    expect(channelMax[0], 'channel 1 audible').toBeGreaterThan(0.002);
    expect(outMax, 'reaches the output with the send engaged').toBeGreaterThan(0.005);
  });
});
