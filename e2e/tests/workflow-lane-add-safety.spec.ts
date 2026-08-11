// e2e/tests/workflow-lane-add-safety.spec.ts
//
// LANE-ADD SAFETY — the two P0 regressions from the owner's ?shell=1 preview
// pass (fix/shell-lane-cellshade-and-gate):
//
//   BUG A — adding a VIDEO module (cellshade) to an AUDIO channel lane froze
//   the UI (needs-refresh, export disabled). Contract under test: ANY module
//   class added to a lane lands unwired-but-functional — NEVER a freeze:
//     * the UI stays responsive after the add (a subsequent real interaction
//       completes within a bounded timeout),
//     * the reconciler plans ZERO wcol edges for a video member (a video
//       module in an audio lane never wires nonsense),
//     * the graph stays QUIESCENT (no janitor write-loop after settling), and
//     * File → Save performance (export) stays enabled.
//   Swept across cellshade / backdraft / synesthesia through BOTH reachable
//   gestures: the real palette-drop path into the lane band and the real
//   "Assign to channel N" commit.
//
//   BUG B — a lane-added tidyVco only auto-wired PITCH (pitch{n}→poly); the
//   clip's GATE was never patched. Contract: the lane wires the clip's pitch
//   AND gate — poly bus + the mono note-gate for a poly instrument — and a
//   noteSink-CLASS member (adsr: a note gate, no audio role) gets the gate
//   tap too. Swept across the six P1 batch-1 faces.
//
// Runs on /rack (the owner's preview surface) in the
// normal e2e lane (no DB/relay). Drives the REAL palette-drop + assign paths
// via the dev hooks (__setSpawnFlowPos/__spawnFromPalette/__assignNodeToChannel)
// — the actual wcolDropTarget → membership → reconcile pipeline, not raw
// graph writes.

import { test, expect, type Page } from '@playwright/test';

// CI (and a local E2E_SWIFTSHADER=1 flake-check) rasterize WebGL on the
// SwiftShader SOFTWARE renderer: every live video engine steals raster/main-
// thread time from the rAF-gated click-actionability checks, so the BUG-A
// responsiveness probe slows roughly LINEARLY with the engine count. Measured
// on CI shard 10 (run 30179147114, both attempts): the File-trigger click took
// ~1.45s with one engine (cellshade), ~2.4s with two (+backdraft), and blew a
// flat 5s bound with three (+synesthesia) — while `evaluate(() => 1+1)` kept
// answering (35ms → 317ms → 989ms), i.e. SLOW, not frozen. Repo rule
// (ci-swiftshader-video-e2e-timeouts): scale timeouts by the video-engine
// count, never flat. The guard stays REAL — a genuine reconcile freeze NEVER
// recovers, so the scaled bound still fails deterministically; it just stops
// reading "slow software raster" as "dead UI". A real-GPU local run keeps the
// tight 5s. (Mirrors the SLOW_RENDER idiom in videovarispeed-switch.spec.ts.)
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
/** BUG-A probe bound with `videoEngines` SwiftShader engines churning. */
function probeTimeoutMs(videoEngines: number): number {
  return SLOW_RENDER ? 5_000 + videoEngines * 10_000 : 5_000;
}

/** channel-columns.ts geometry under `?shell=1` (SHELL_COLUMN_W). */
const SHELL_COLUMN_W = 216;

const PINNED_MIXER = 'pinned-mixmstrs';
const PINNED_CLIP = 'pinned-clipplayer';

/** A flow-space spawn anchor inside channel column `ch` at the SHELL pitch. */
function colPos(ch: number): { x: number; y: number } {
  return { x: (ch - 1) * SHELL_COLUMN_W + 30, y: 40 };
}

async function gotoShellWorkflow(page: Page): Promise<void> {
  await page.goto('/rack?shell=legacy');
  // 15s: first paint pays SvelteKit's on-demand route compile on a cold dev
  // server (and SwiftShader contention on CI) — same budget the sibling
  // first-visibility asserts use.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
        __setSpawnFlowPos?: unknown;
        __spawnFromPalette?: unknown;
        __assignNodeToChannel?: unknown;
      };
      return (
        typeof w.__setSpawnFlowPos === 'function' &&
        typeof w.__spawnFromPalette === 'function' &&
        typeof w.__assignNodeToChannel === 'function' &&
        !!w.__patch &&
        ['pinned-mixmstrs', 'pinned-clipplayer'].every((id) => w.__patch!.nodes[id]?.data?.pinned === true)
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Drive the REAL palette-drop path; returns the new node id. */
async function dropInLane(page: Page, type: string, ch: number): Promise<string> {
  return page.evaluate(
    ({ type, pos }) => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
        __patch: { nodes: Record<string, unknown> };
      };
      const before = new Set(Object.keys(w.__patch.nodes));
      w.__setSpawnFlowPos(pos);
      w.__spawnFromPalette(type);
      const added = Object.keys(w.__patch.nodes).find((id) => !before.has(id));
      if (!added) throw new Error(`spawn of ${type} added no node`);
      return added;
    },
    { type, pos: colPos(ch) },
  );
}

/** Every wcol- edge as `src.port->dst.port`, for structural assertions. */
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

/** BUG-A watchdog: the UI must answer a REAL interaction within a bounded
 *  timeout — the File menu must open on a real click, then close on Escape. A
 *  frozen main thread or a dead reactive tree fails this within the bound
 *  instead of hanging the run. `videoEngines` = how many video engines are
 *  live at this point in the test; the bound scales with it under SwiftShader
 *  (see SLOW_RENDER above) and stays a tight 5s on a real GPU. */
async function expectUiResponsive(page: Page, videoEngines: number): Promise<void> {
  const bound = probeTimeoutMs(videoEngines);
  // Main thread answers.
  const t0 = Date.now();
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  expect(Date.now() - t0, 'main thread must answer fast (not wedged)').toBeLessThan(bound);
  // The reactive tree answers: a real click opens the File menu (state flip +
  // render), Escape closes it. A dead reactive tree (the owner-reported freeze
  // symptom) fails this within the bound instead of hanging the run.
  await page.getByTestId('workflow-file-trigger').click({ timeout: bound });
  await expect(page.getByTestId('workflow-file-menu')).toBeVisible({ timeout: bound });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('workflow-file-menu')).toBeHidden({ timeout: bound });
}

/** BUG-A quiescence probe: after settling, the Y.Doc must not be churning (a
 *  janitor write-loop shows up as a continuous update stream). */
async function expectDocQuiescent(page: Page): Promise<void> {
  const updates = await page.evaluate(async () => {
    const w = globalThis as unknown as { __ydoc?: { on: (e: string, f: () => void) => void; off: (e: string, f: () => void) => void } };
    if (!w.__ydoc) return 0;
    let n = 0;
    const h = () => n++;
    w.__ydoc.on('update', h);
    await new Promise((r) => setTimeout(r, 700));
    w.__ydoc.off('update', h);
    return n;
  });
  expect(updates, 'no janitor write-loop after the add settles').toBeLessThan(10);
}

test.describe('BUG A — video modules added to an audio lane: unwired-but-functional, never a freeze', () => {
  test('cellshade / backdraft / synesthesia via palette-drop AND assign-to-channel stay sane', async ({ page }) => {
    // Three engines' worth of scaled probe bounds don't fit the default 30s
    // budget on the software renderer; a REAL freeze still fails at the FIRST
    // probe (≤ ~40s in), long before this ceiling.
    test.setTimeout(SLOW_RENDER ? 150_000 : 30_000);
    await gotoShellWorkflow(page);

    const videoTypes = ['cellshade', 'backdraft', 'synesthesia'];
    const nodeIds: string[] = [];

    for (let i = 0; i < videoTypes.length; i++) {
      const type = videoTypes[i]!;
      const ch = i + 2; // lanes 2..4

      // Gesture 1 — the owner's repro: right-click a lane → add the module
      // (the palette-drop path with the spawn anchored inside the lane band).
      const nid = await dropInLane(page, type, ch);
      nodeIds.push(nid);

      // Gesture 2 — the one path that CAN make a non-audio module a channel
      // MEMBER: the real "Assign to channel N" commit (0-based channel).
      await page.evaluate(
        ({ nid, lane }) => {
          (globalThis as unknown as { __assignNodeToChannel: (id: string, ch: number) => void })
            .__assignNodeToChannel(nid, lane);
        },
        { nid, lane: ch - 1 },
      );

      // The UI must remain fully alive after EACH add (the owner-reported
      // freeze was immediate). i+1 video engines are churning by now.
      await expectUiResponsive(page, i + 1);
    }

    // Membership landed (sane state)…
    for (let i = 0; i < videoTypes.length; i++) {
      const ch = await page.evaluate(
        (nid) =>
          (globalThis as unknown as { __patch: { nodes: Record<string, { data?: { channel?: number } } | undefined> } })
            .__patch.nodes[nid]?.data?.channel,
        nodeIds[i]!,
      );
      expect(ch, `${videoTypes[i]} joined its channel`).toBe(i + 2);
    }

    // …but the reconciler wired NOTHING to/from any video member (a video
    // module in an audio lane never wires nonsense).
    const edges = await wcolEdges(page);
    for (const nid of nodeIds) {
      expect(
        edges.filter((e) => e.includes(nid)),
        `no wcol edges may touch ${nid}`,
      ).toEqual([]);
    }

    // No write-loop after settling.
    await expectDocQuiescent(page);

    // Export stays available (the owner-reported symptom was a dead, export-
    // disabled app): File → Save performance is enabled. All three engines
    // still churn here — same scaled bound as the probes.
    const finalBound = probeTimeoutMs(videoTypes.length);
    await page.getByTestId('workflow-file-trigger').click({ timeout: finalBound });
    await expect(page.getByTestId('workflow-file-save-performance')).toBeEnabled({ timeout: finalBound });
    await page.keyboard.press('Escape');
  });
});

test.describe('BUG B — lane note wiring: pitch AND gate (+vel where present)', () => {
  test('tidyVco gets pitch{n}→poly AND gate{n}→gate; adsr gets the gate tap; batch-1 sweep', async ({ page }) => {
    await gotoShellWorkflow(page);

    // tidyVco into lane 3 — the reported gap: gate must be patched too.
    const vco = await dropInLane(page, 'tidyVco', 3);
    await expect
      .poll(async () => await wcolEdges(page), { timeout: 5_000 })
      .toEqual(
        expect.arrayContaining([
          `${PINNED_CLIP}.pitch3->${vco}.poly`,
          `${PINNED_CLIP}.gate3->${vco}.gate`,
          `${vco}.out_l->${PINNED_MIXER}.ch3L`,
          `${vco}.out_r->${PINNED_MIXER}.ch3R`,
        ]),
      );

    // adsr into the SAME lane — a noteSink-class member (note gate, no audio
    // role): it gets the lane's gate tapped, and never reaches the mixer.
    const env = await dropInLane(page, 'adsr', 3);
    await expect
      .poll(async () => await wcolEdges(page), { timeout: 5_000 })
      .toEqual(expect.arrayContaining([`${PINNED_CLIP}.gate3->${env}.gate`]));
    expect((await wcolEdges(page)).some((e) => e.startsWith(`${env}.`) && e.includes(PINNED_MIXER))).toBe(false);

    // kickdrum (lane 4): mono drum voice — pitch (v/oct pitch_cv) AND gate.
    const kick = await dropInLane(page, 'kickdrum', 4);
    await expect
      .poll(async () => await wcolEdges(page), { timeout: 5_000 })
      .toEqual(
        expect.arrayContaining([
          `${PINNED_CLIP}.pitch4->${kick}.pitch_cv`,
          `${PINNED_CLIP}.gate4->${kick}.trigger_in`,
        ]),
      );

    // vca + cloudseed (lane 5): pure FX inserts — chain-driven, NEVER
    // clip-driven (no note edges into either).
    const vca = await dropInLane(page, 'vca', 5);
    const seed = await dropInLane(page, 'cloudseed', 5);
    // The lane send materializes through the FX tail…
    await expect
      .poll(async () => (await wcolEdges(page)).some((e) => e.startsWith(`${seed}.`) && e.includes('.ch5')), {
        timeout: 5_000,
      })
      .toBe(true);
    // …with no clip note edges into the inserts.
    const all = await wcolEdges(page);
    expect(all.some((e) => e.startsWith(`${PINNED_CLIP}.`) && (e.includes(`->${vca}.`) || e.includes(`->${seed}.`)))).toBe(false);

    // lfo (lane 6): only a CONTROL gate (clock) — must NOT be note-tapped.
    const lfo = await dropInLane(page, 'lfo', 6);
    await page.waitForTimeout(400); // give the janitor a tick to (not) wire it
    expect((await wcolEdges(page)).some((e) => e.includes(`->${lfo}.`))).toBe(false);
  });
});
