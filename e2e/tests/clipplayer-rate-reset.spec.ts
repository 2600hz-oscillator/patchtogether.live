// e2e/tests/clipplayer-rate-reset.spec.ts
//
// CLIP PLAYER per-lane clock RATE (mult/div) + RESET, through the REAL chain:
// TIMELORDE (the rack transport) drives the engine's tick loop; the CARD's
// per-lane rate dropdowns + RST button write the synced node state the engine
// consumes; the `reset` gate INPUT is driven by a real cable from a sequencer's
// clock output (the controlled-edge pattern — the source spawns STOPPED so we
// decide exactly when edges arrive).
//
//   1. rate ratio — lanes at 1/2 : 1 : 2x advance in a 1:2:4 step ratio (read
//      atomically off the engine's audio-accurate per-lane playhead).
//   2. RST button — all ACTIVE clips snap back to step 1, proved from an
//      in-page playhead trace as a BACKWARD JUMP too fast to be a loop wrap.
//   3. reset gate input — clock edges into `reset` hold the playhead near the
//      top; removing them lets it climb again (proves the cable, not a stall).

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch, seedKriaGate, seedKriaWith, buildKriaMidiData } from './_helpers';
// The reset instrument is SHARED with launchpad-perf-controls.spec.ts — see
// the header of _clip-reset-trace.ts for why that matters.
import {
  CLIP_STEPS,
  startStepTrace,
  stopStepTrace,
  waitForResetSnap,
  type EngineW,
} from './_clip-reset-trace';

test.describe.configure({ mode: 'parallel' });


/** Read one engine key for a node (null when the engine isn't up yet). */
async function readEngine(page: Page, nodeId: string, key: string): Promise<number | null> {
  return await page.evaluate(
    ({ id, k }) => {
      const w = globalThis as unknown as EngineW;
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return null;
      const v = eng.read(node, k);
      return typeof v === 'number' ? v : null;
    },
    { id: nodeId, k: key },
  );
}

/** Poll an engine key until `pred` holds (or time out). Returns the last value. */
async function waitForEngine(
  page: Page,
  nodeId: string,
  key: string,
  pred: (v: number) => boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; last: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < deadline) {
    last = await readEngine(page, nodeId, key);
    if (typeof last === 'number' && pred(last)) return { ok: true, last };
    await page.waitForTimeout(50);
  }
  return { ok: false, last };
}


/** Seed DENSE 128-step note clips (a note every step, so the playhead tracks)
 *  in slot 0 of the given lanes, and queue them — via the same Y.Doc path the
 *  card/grid use. */
async function seedDenseClips(page: Page, nodeId: string, lanes: number[]) {
  await page.evaluate(
    ({ id, ls, len }) => {
      const w = globalThis as unknown as EngineW;
      // Flat clip key is stride-64 (schema v2): clipIndex(slot=0, lane) = lane*64.
      // (The old stride-8 key `lane*8` only matched for lane 0 → lanes 1/2 were
      // never found → "saw -1"; the seed must match the engine's stride.)
      const SCENE_STRIDE = 64;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (!n.data) n.data = {};
        const clips: Record<string, unknown> = {};
        const queued: (number | null)[] = new Array(8).fill(null);
        for (const lane of ls) {
          clips[String(lane * SCENE_STRIDE)] = {
            kind: 'note',
            lengthSteps: len,
            root: 48,
            loop: true,
            steps: Array.from({ length: len }, (_, s) => ({ step: s, midi: 72, velocity: 127, lengthSteps: 1 })),
          };
          queued[lane] = 0;
        }
        n.data.clips = clips;
        n.data.sv = 2; // already stride-64 → skip the legacy re-key migration
        n.data.queued = queued;
      });
    },
    { id: nodeId, ls: lanes, len: CLIP_STEPS },
  );
}

/** Flip every TIMELORDE's running (creating one if absent) at a fast bpm. */
async function setTransport(page: Page, running: number, bpm = 240) {
  await page.evaluate(
    ({ run, b }) => {
      const w = globalThis as unknown as EngineW;
      w.__ydoc.transact(() => {
        const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
        for (const n of tls) {
          if (!n.params) n.params = {};
          n.params.running = run;
          n.params.bpm = b;
        }
      });
    },
    { run: running, b: bpm },
  );
}

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 22 recovered-on-retry observation(s) across 11 SHA(s) / 9 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: per-lane clock multiply/divide through the REAL TIMELORDE-driven tick loop, read off the engine's audio-accurate per-lane playhead — the polyrhythm the module exists for.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('per-lane rate: card dropdowns set 1/2 : 1 : 2x lanes advancing at a 1:2:4 ratio', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 22 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
      params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio',
      params: { running: 0, bpm: 240 } },
  ]);
  const card = page.locator('.svelte-flow__node-clipplayer');
  await expect(card).toHaveCount(1);

  // Set the rates on the CARD (the owner's dropdown): lane0=1/2, lane2=2x
  // (lane1 stays at the default '1'). Values are RATE_LABELS indices.
  await page.getByTestId('clipplayer-rate-0').selectOption('2'); // 1/2
  await page.getByTestId('clipplayer-rate-2').selectOption('4'); // 2x
  // The dropdown wrote the synced per-lane state the engine consumes.
  const rate = await page.evaluate(
    () => (globalThis as unknown as EngineW).__patch.nodes['cp'].data?.rate as number[] | undefined,
  );
  expect(rate?.[0]).toBe(2);
  expect(rate?.[1] ?? 3).toBe(3);
  expect(rate?.[2]).toBe(4);

  // Launch dense clips on lanes 0..2 with the transport STOPPED, then start it:
  // the transport-start realign anchors all three lanes to one common origin.
  await seedDenseClips(page, 'cp', [0, 1, 2]);
  await setTransport(page, 1);

  // ⚠ #1569: the old gate here ("currentStep:2 >= 40 within 8 s") and the
  // one-shot atomic ratio read that followed were BOTH wall-clock bets against
  // engine-boot latency. Lanes anchor to the TRANSPORT origin, so when the
  // engine only becomes readable seconds later on a loaded runner, (a) the
  // gate times out with almost no visible advance ("saw 7", "saw 30"), and
  // (b) by read time the 1x lane has WRAPPED its 128-step clip and the
  // instantaneous ratio is garbage — run 31850032517 read ÷2=102, 1x=77
  // because 16 steps/s × 12.75 s = 204 ≡ 76 (mod 128). currentStep is CYCLIC;
  // never compare instantaneous samples of it across lanes.
  //
  // Gate instead on LIVENESS (the engine is up and the playhead is moving),
  // then measure the SUBJECT — the per-lane RATE ratio — as wrap-safe forward
  // progress accumulated in-page over one shared observation window.
  const live = await waitForEngine(page, 'cp', 'currentStep:2', (v) => v >= 1, 30_000);
  expect(
    live.ok,
    `engine never became live — currentStep:2 stayed at ${live.last} (needs >= 1 to prove ticking)`,
  ).toBe(true);

  // Accumulate forward progress per lane in the page: one setInterval sampler
  // reads all three playheads in the SAME synchronous callback (a shared
  // window by construction), credits per-lane deltas, and treats a negative
  // delta as a wrap (+CLIP_STEPS) — at 25 ms between samples the fastest lane
  // moves <1 step, so a wrap (Δ ≈ −128) is unmistakable. Stops when the 2x
  // lane has accumulated ≥40 steps of real progress; the wall-clock cap only
  // bounds the failure.
  const prog = await page.evaluate(
    ({ len }) =>
      new Promise<{ p: number[]; samples: number; elapsedMs: number }>((resolve) => {
        const w = globalThis as unknown as EngineW;
        const p = [0, 0, 0];
        let last: number[] | null = null;
        let samples = 0;
        const startedAt = performance.now();
        const CAP_MS = 30_000;
        const timer = setInterval(() => {
          const eng = w.__engine?.();
          const node = w.__patch.nodes['cp'];
          if (!eng || !node) return;
          const now = [0, 1, 2].map((L) => Number(eng.read(node, `currentStep:${L}`)));
          if (now.every(Number.isFinite)) {
            if (last) {
              for (let L = 0; L < 3; L++) {
                let d = now[L]! - last[L]!;
                if (d < 0) d += len; // loop wrap — credit the forward remainder
                p[L] += d;
              }
            }
            last = now;
            samples++;
          }
          const elapsedMs = performance.now() - startedAt;
          if (p[2]! >= 40 || elapsedMs >= CAP_MS) {
            clearInterval(timer);
            resolve({ p, samples, elapsedMs });
          }
        }, 25);
      }),
    { len: CLIP_STEPS },
  );
  const [p0, p1, p2] = prog.p as [number, number, number];
  const obs =
    `progress ÷2=${p0.toFixed(1)} 1x=${p1.toFixed(1)} 2x=${p2.toFixed(1)} steps ` +
    `over ${Math.round(prog.elapsedMs)} ms / ${prog.samples} samples`;
  expect(p2, `2x lane accumulated real progress — ${obs}`).toBeGreaterThanOrEqual(40);
  // The ratio must be 1:2:4 (÷2 : 1 : ×2), ± read slack in STEPS.
  expect(Math.abs(p1 - 2 * p0), `1x ≈ 2 × ÷2 lane — ${obs}`).toBeLessThanOrEqual(2);
  expect(Math.abs(p2 - 2 * p1), `2x ≈ 2 × 1x lane — ${obs}`).toBeLessThanOrEqual(3);
  expect(Math.abs(p2 - 4 * p0), `2x ≈ 4 × ÷2 lane — ${obs}`).toBeLessThanOrEqual(4);
});

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 1 recovered-on-retry observation(s) across 1 SHA(s) / 1 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: that the card RST button snaps every ACTIVE lane back to step 1 while playback continues — a live-performance control whose failure mode is a silent no-op.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('RST button: all active clips snap back to step 1 and keep playing', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 1 recovered-on-retry observation in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
      params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
    { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio',
      params: { running: 0, bpm: 240 } },
  ]);
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  await seedDenseClips(page, 'cp', [0, 1]);
  await setTransport(page, 1);

  // Both lanes well past the top, so a snap back to step 1 is a real jump.
  const l0 = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(l0.ok, `lane 0 mid-clip before reset (saw ${l0.last})`).toBe(true);

  // Record BOTH playheads in-page across the click (see the RESET PROOF block
  // above for why this replaced the post-click CDP poll). The recorder is
  // running before the click and keeps running regardless of how long `click()`
  // itself takes — under load it has burned 2.2-6.3 s, and the reset fires
  // somewhere INSIDE that, which is exactly what the old poll kept missing.
  await startStepTrace(page, 'cp', ['currentStep:0', 'currentStep:1']);
  await page.getByTestId('clipplayer-reset').click();

  // PROOF: both lanes jump BACKWARD, together, to the top of the clip, in far
  // less time than a natural 128-step loop wrap would need to land them there.
  // `currentStep` only ever decreases via a wrap or a reset, and the wrap is
  // ruled out arithmetically — so this is the RST button and nothing else.
  // Resolves in ~50 ms when healthy; the 8 s ceiling only pays out on a real
  // failure and absorbs a starved main-thread scheduler tick (the only place
  // resetNonce is consumed) without widening any acceptance window.
  const proved = await waitForResetSnap(page, 8000);
  const trace = await stopStepTrace(page);
  expect(
    proved,
    `both lanes snapped BACKWARD to the top on the reset, too fast to be a loop wrap — ` +
      `trace: ${JSON.stringify(trace)}`,
  ).toBe(true);
  // Still PLAYING (reset ≠ stop) and still advancing.
  expect(await readEngine(page, 'cp', 'activeLane:0')).toBe(0);
  const resumed = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 6, 4000);
  expect(resumed.ok, `lane 0 kept advancing after the reset (saw ${resumed.last})`).toBe(true);
});

test('reset gate input: clock edges hold the playhead at the top; removing them frees it', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'tl', type: 'timelorde', position: { x: 520, y: 80 }, domain: 'audio',
        params: { running: 0, bpm: 240 } },
      // ⚠ KRIA follows TIMELORDE's run state when one exists — its own
      // `running` param is overridden the moment setTransport(1) starts the
      // rack. So edge start/stop is controlled via the PATTERN instead:
      // spawn with NO trigs (silent even while running), then seed/clear
      // trigs to start/stop the 16th-note reset train.
      { id: 'rstSeq', type: 'kria', position: { x: 80, y: 460 }, domain: 'audio',
        params: { bpm: 240 } },
    ],
    [
      { id: 'e_rst', from: { nodeId: 'rstSeq', portId: 'gate1' }, to: { nodeId: 'cp', portId: 'reset' },
        sourceType: 'gate', targetType: 'gate' },
    ],
  );
  // All-rest pattern: the kria runs with the transport but emits nothing.
  await seedKriaWith(page, 'rstSeq', buildKriaMidiData([null, null, null, null], { duration: 0.5 }));
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);

  await seedDenseClips(page, 'cp', [0]);
  await setTransport(page, 1);

  const before = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(before.ok, `lane 0 mid-clip before edges arrive (saw ${before.last})`).toBe(true);

  // Start the reset train: seed trigs — a rising edge per 16th snaps the
  // lane back.
  await seedKriaWith(page, 'rstSeq', buildKriaMidiData([60, 60, 60, 60], { duration: 0.5 }));
  const snapped = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 0 && v <= 2, 3000);
  expect(snapped.ok, `reset edge snapped lane 0 to step 1 (saw ${snapped.last})`).toBe(true);
  // While edges keep arriving (every ~4 base steps), the playhead stays pinned
  // near the top — it can never climb anywhere near where it was.
  let maxSeen = -1;
  const holdUntil = Date.now() + 1500;
  while (Date.now() < holdUntil) {
    const v = await readEngine(page, 'cp', 'currentStep:0');
    if (typeof v === 'number' && v > maxSeen) maxSeen = v;
    await page.waitForTimeout(50);
  }
  expect(maxSeen, `playhead held near the top under repeated resets (max ${maxSeen})`).toBeLessThanOrEqual(6);

  // Stop the reset train: clear the trigs — the lane climbs freely again
  // (the wire's edges were the cause).
  await seedKriaWith(page, 'rstSeq', buildKriaMidiData([null, null, null, null], { duration: 0.5 }));
  const freed = await waitForEngine(page, 'cp', 'currentStep:0', (v) => v >= 8, 6000);
  expect(freed.ok, `playhead climbed again once edges stopped (saw ${freed.last})`).toBe(true);
});
