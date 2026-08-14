// e2e/tests/card-producer-lifetime.spec.ts
//
// #1587 — "wavesculpt + timelorde render BLACK unless the card happens to be
// open." THE REGRESSION GUARD, and it is NOT collapse-shaped.
//
// These modules produce their picture from a rAF loop that lives on the CARD.
// Under the faceplate shell an un-migrated module's card exists only inside the
// dock full-view, so in the common case the card is NEVER MOUNTED: a SAVED rack
// with `WAVESCULPT.video_out → VIDEO OUT` is solid black ON LOAD, before the
// user touches anything. Collapse is merely how you notice it. The fix keeps the
// real card alive in <HeadlessSourceHost> — CARD_PRODUCER_LANE_TYPES, the
// producer half of the DOM-source rule.
//
// ── THE INSTRUMENT, AND WHY THIS ONE ─────────────────────────────────────────
// The issue's own confirming probe was BLIND and is recorded there as such: it
// scanned every canvas ≥32px in the page and returned BYTE-IDENTICAL readings
// with the card never-mounted and with it expanded
// (`{"w":340,"h":304,"nonBlack":2496,"max":38}` both times). Two independent
// reasons, both since confirmed: a GL-backed canvas returns null from
// `getContext('2d')` and is silently skipped, and — measured here —
// `__openDockFullView('wavesculpt')` mounted NOTHING at all, because
// WavesculptCard's bare `useStore()` threw outside the SvelteFlow provider. So
// "expanded" was not a different state.
//
// This probe cannot fail that way:
//   * it calls the MODULE'S OWN `drawFrame` — the exact callback the
//     cross-domain video-texture bridge invokes each video frame, reached
//     through the public `getVideoSource(nodeId, portId)` — into a 2D canvas
//     THIS TEST owns. No canvas scan, no GL readback, no guessing which element
//     is the output;
//   * it clears that canvas before every draw, so a producer that draws NOTHING
//     reads as black rather than as the previous sample;
//   * it requires the picture to CHANGE, so a frozen surface FAILS rather than
//     reading as a picture. That matters concretely for TIMELORDE: its
//     `drawFrame` keeps blitting the LAST bitmap the card ever pushed, so after
//     a card has once been mounted, "not black" alone cannot tell a live
//     producer from a stale leftover;
//   * the accumulator lives IN THE PAGE (one evaluate per phase, not one
//     round-trip per sample), so a loaded runner cannot starve the subject with
//     the measurement, and every assertion message carries frames / elapsedMs /
//     the values seen.
//
// ── FRAMES, NEVER MILLISECONDS — AND THE ONE PLACE THAT BIT ──────────────────
// Sampling is per-rAF-frame and the movement check EXITS ON THE EVENT (first
// changed frame), with a frame CAP that only bounds the failure. An earlier
// draft used a fixed 20-frame window instead and failed on TIMELORDE for a
// reason worth recording: its owl pulses on the beat, and `beatPulse` returns a
// FLAT 0 for the last 40 % of every beat — 200 ms at the default 120 bpm. On a
// 120 Hz display 20 frames is 166 ms, so every sample landed inside that flat
// stretch and a perfectly live producer read as frozen. A fixed frame budget is
// a different assertion on every refresh rate when the SUBJECT's period is in
// milliseconds. Waiting for the event is not.
//
// ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
//   1. NEVER-MOUNTED: spawn the rack, expand NOTHING, and require live moving
//      picture on every port that carries one. This is the owner's report.
//   2. POSITIVE CONTROL (permanent): the identical probe while the card IS
//      mounted in the dock full-view. The two live-port SETS must be EQUAL —
//      which is the causal claim in both directions, and is what stops the
//      never-mounted leg passing vacuously.
//   3. CONTINUITY: collapse, sampling EVERY frame across the handoff so the
//      re-init blip is measured rather than assumed, then require picture again.
//   4. DELETE: the node leaves the graph → the card is unmounted from every
//      host (that unmount is what runs disposeGl) and the engine handle is gone.
//
// REGISTRY-DRIVEN: subjects are DERIVED from CARD_PRODUCER_LANE_TYPES (itself
// held exhaustive by dom-source-modules.test.ts's seam gate) and each subject's
// DOMAIN and OUTPUT PORTS come from the generated registry manifest. Nothing
// here is a hand-typed module list, so a fourth producer module enrols itself.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { REGISTRY } from './_registry';

/** SwiftShader (CI, or a local E2E_SWIFTSHADER=1 flake-check) rasterizes WebGL
 *  in software at roughly an eighth of a real GPU's frame rate, and WAVESCULPT
 *  is a full 3-D pass. Every budget below is in FRAMES; only the whole-test
 *  wall-clock ceiling needs the software-renderer scale. */
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** Probe canvas size, in CSS px. Small on purpose: the question is "is there a
 *  changing picture", not "what does it look like", and every extra pixel is
 *  getImageData cost on the same main thread as the subject. */
const PROBE_W = 64;
const PROBE_H = 48;
/** Per-pixel luma (0-255) above which a pixel counts as NON-BLACK. Chosen so
 *  each module's IDLE frame reads as fully black: WAVESCULPT's undriven
 *  drawFrame fills #000 (luma 0) and TIMELORDE's fills #07090d (luma 8). */
const BLACK_LUMA = 8;
/** Frames a port is sampled to decide "does it carry a picture at all". A few,
 *  not one: WAVESCULPT's ribbon is thin and its per-frame non-black count
 *  swings (measured 78-170 of 3072), so one unlucky frame must not decide. */
const LIVE_SAMPLE_FRAMES = 5;
/** Frame CAP on the movement check. It BOUNDS THE FAILURE; the check exits on
 *  the first changed frame, so the normal cost is 1-2 frames for WAVESCULPT and
 *  at most one beat for TIMELORDE. */
const CHANGE_CAP_FRAMES = 300;
/** Frames sampled around the dock→headless handoff, every frame. */
const HANDOFF_FRAMES = 90;
/** How long the picture may be absent across that handoff, in FRAMES. The card
 *  really does re-mount (WAVESCULPT re-runs initGl), so a short gap is expected
 *  and is the thing being bounded; a picture that never comes back is the bug. */
const MAX_BLACK_RUN_FRAMES = 30;

const LANE_SETS_SRC = readFileSync(
  fileURLToPath(
    new URL('../../packages/web/src/lib/ui/workflow/dom-source-modules.ts', import.meta.url),
  ),
  'utf8',
);

/** One `export const <NAME>: ReadonlySet<string> = new Set<string>([...])`
 *  literal from the shared source. ANCHORED ON THE EXPORT: a bare
 *  `/<NAME>[^[]*\[/` matches the first PROSE mention of the name in the file
 *  header and then runs on to the WRONG array — which is exactly what it did on
 *  the first run here, silently substituting the DOM-source set for the producer
 *  set and enrolling nine modules nobody asked for. */
function parseLaneSet(name: string): string[] {
  const re = new RegExp(`export const ${name}[^[]*\\[([\\s\\S]*?)\\]`);
  const block = re.exec(LANE_SETS_SRC);
  if (!block) throw new Error(`could not parse ${name} — has the shape changed?`);
  const types = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (types.length === 0) throw new Error(`${name} parsed EMPTY — refusing to pass vacuously`);
  return types;
}

/** The producer subjects, derived from the shared source. */
function cardProducerTypes(): string[] {
  const producers = parseLaneSet('CARD_PRODUCER_LANE_TYPES');
  // PARSE SELF-CHECK, and it is not decoration: the two sets are asserted
  // DISJOINT by dom-source-modules.test.ts, so any overlap here means this
  // parse grabbed the wrong array literal — the one failure mode a regex over
  // source has, and one that otherwise shows up as nine mysterious subjects.
  const domSource = new Set(parseLaneSet('DOM_SOURCE_LANE_TYPES'));
  const overlap = producers.filter((t) => domSource.has(t));
  if (overlap.length > 0) {
    throw new Error(
      `CARD_PRODUCER_LANE_TYPES parse returned DOM-source types (${overlap.join(', ')}) — ` +
        'the regex matched the wrong array literal',
    );
  }
  return producers;
}

const SUBJECTS = cardProducerTypes().map((type) => {
  const mod = REGISTRY.find((m) => m.type === type);
  if (!mod) throw new Error(`${type} is in CARD_PRODUCER_LANE_TYPES but not in the registry manifest`);
  return {
    type,
    domain: mod.domain,
    /** Every video-carrying OUTPUT port. Which of them actually carries the
     *  card-produced picture is DERIVED at runtime (a port that shows nothing
     *  even with the card mounted — SYNESTHESIA's per-band rasters with no
     *  video patched in — is not this test's subject), never declared here. */
    videoOuts: mod.outputs
      .filter((p) => p.type === 'video' || p.type === 'mono-video')
      .map((p) => p.id),
  };
});

interface PortSample {
  port: string;
  /** Max non-black pixel count over LIVE_SAMPLE_FRAMES frames, of PROBE_W*H. */
  nonBlack: number;
  /** Max per-pixel luma seen, 0-255. */
  maxLuma: number;
  /** Present only when the port could not be probed at all. */
  reason?: string;
}

/** ONE evaluate: sample every listed port for a few frames and report the max
 *  non-black count per port. In-page accumulator — never a Playwright poll. */
async function samplePorts(page: Page, nodeId: string, ports: string[]): Promise<PortSample[]> {
  return page.evaluate(
    async ({ nodeId, ports, frames, W, H, BLACK }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            getVideoSource?: (
              id: string,
              port: string,
            ) => { drawFrame?: (c: HTMLCanvasElement | OffscreenCanvas) => void } | null;
          };
        };
      };
      const out = ports.map((port) => ({ port, nonBlack: 0, maxLuma: 0, reason: undefined as string | undefined }));
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        for (const o of out) o.reason = 'the PROBE canvas returned no 2d context';
        return out;
      }
      let n = 0;
      await new Promise<void>((resolve) => {
        const tick = () => {
          n++;
          for (const o of out) {
            let src: { drawFrame?: (c: HTMLCanvasElement | OffscreenCanvas) => void } | null = null;
            try {
              src = w.__engine!().getDomain('audio').getVideoSource!(nodeId, o.port);
            } catch (e) {
              o.reason = `no engine: ${String(e)}`;
              continue;
            }
            if (!src || typeof src.drawFrame !== 'function') {
              o.reason = `no video source for ${nodeId}.${o.port}`;
              continue;
            }
            o.reason = undefined;
            ctx.clearRect(0, 0, W, H);
            src.drawFrame(c);
            const d = ctx.getImageData(0, 0, W, H).data;
            let nonBlack = 0;
            let maxLuma = 0;
            for (let i = 0; i < d.length; i += 4) {
              const l = (d[i]! * 77 + d[i + 1]! * 151 + d[i + 2]! * 28) >> 8;
              if (l > BLACK) nonBlack++;
              if (l > maxLuma) maxLuma = l;
            }
            if (nonBlack > o.nonBlack) o.nonBlack = nonBlack;
            if (maxLuma > o.maxLuma) o.maxLuma = maxLuma;
          }
          if (n >= frames) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return out;
    },
    { nodeId, ports, frames: LIVE_SAMPLE_FRAMES, W: PROBE_W, H: PROBE_H, BLACK: BLACK_LUMA },
  );
}

/** The ports that carry a picture right now, and a printable digest. */
function livePorts(samples: PortSample[]): string[] {
  return samples.filter((s) => s.nonBlack > 0).map((s) => s.port).sort();
}
function digest(samples: PortSample[]): string {
  return samples
    .map((s) => `${s.port}: nonBlack=${s.nonBlack}/${PROBE_W * PROBE_H} maxLuma=${s.maxLuma}${s.reason ? ` (${s.reason})` : ''}`)
    .join('; ');
}

interface ChangeResult {
  changed: boolean;
  frames: number;
  elapsedMs: number;
  distinct: number;
  nonBlackMin: number;
  nonBlackMax: number;
}

/** IN-PAGE: sample one port EVERY frame until its picture CHANGES, capped in
 *  FRAMES. Exits on the event, so the cost is "frames until the producer moved"
 *  and the cap only bounds a failure. */
async function framesToChange(page: Page, nodeId: string, port: string): Promise<ChangeResult> {
  return page.evaluate(
    async ({ nodeId, port, cap, W, H, BLACK }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            getVideoSource?: (id: string, p: string) => { drawFrame?: (c: HTMLCanvasElement | OffscreenCanvas) => void } | null;
          };
        };
      };
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      const seen = new Set<number>();
      let nonBlackMin = Number.POSITIVE_INFINITY;
      let nonBlackMax = 0;
      const t0 = performance.now();
      let n = 0;
      await new Promise<void>((resolve) => {
        const tick = () => {
          n++;
          try {
            const src = w.__engine!().getDomain('audio').getVideoSource!(nodeId, port);
            ctx.clearRect(0, 0, W, H);
            src?.drawFrame?.(c);
          } catch { /* handle briefly absent — records as a black frame */ }
          const d = ctx.getImageData(0, 0, W, H).data;
          let nonBlack = 0;
          let hash = 2166136261;
          for (let i = 0; i < d.length; i += 4) {
            const l = (d[i]! * 77 + d[i + 1]! * 151 + d[i + 2]! * 28) >> 8;
            if (l > BLACK) nonBlack++;
            hash = Math.imul(hash ^ d[i]!, 16777619);
            hash = Math.imul(hash ^ d[i + 1]!, 16777619);
            hash = Math.imul(hash ^ d[i + 2]!, 16777619);
          }
          if (nonBlack < nonBlackMin) nonBlackMin = nonBlack;
          if (nonBlack > nonBlackMax) nonBlackMax = nonBlack;
          seen.add(hash >>> 0);
          if (seen.size > 1 || n >= cap) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return {
        changed: seen.size > 1,
        frames: n,
        elapsedMs: Math.round(performance.now() - t0),
        distinct: seen.size,
        nonBlackMin: nonBlackMin === Number.POSITIVE_INFINITY ? 0 : nonBlackMin,
        nonBlackMax,
      };
    },
    { nodeId, port, cap: CHANGE_CAP_FRAMES, W: PROBE_W, H: PROBE_H, BLACK: BLACK_LUMA },
  );
}

function fmtChange(r: ChangeResult): string {
  return (
    `changed=${r.changed} after ${r.frames} rAF frames (${r.elapsedMs} ms wall, cap ${CHANGE_CAP_FRAMES} frames), ` +
    `distinct signatures=${r.distinct}, nonBlack px (of ${PROBE_W * PROBE_H}) min=${r.nonBlackMin} max=${r.nonBlackMax}`
  );
}

/** IN-PAGE: sample one port EVERY frame for a fixed window, so a transient gap
 *  is MEASURED. Started before the collapse click and awaited after it, so the
 *  handoff happens inside the sampling window. */
async function probeEveryFrame(page: Page, nodeId: string, port: string) {
  return page.evaluate(
    async ({ nodeId, port, frames, W, H, BLACK }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            getVideoSource?: (i: string, p: string) => { drawFrame?: (c: HTMLCanvasElement | OffscreenCanvas) => void } | null;
          };
        };
      };
      const series: number[] = [];
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      const t0 = performance.now();
      let n = 0;
      await new Promise<void>((resolve) => {
        const tick = () => {
          n++;
          let nonBlack = 0;
          try {
            const src = w.__engine!().getDomain('audio').getVideoSource!(nodeId, port);
            ctx.clearRect(0, 0, W, H);
            if (src?.drawFrame) {
              src.drawFrame(c);
              const d = ctx.getImageData(0, 0, W, H).data;
              for (let i = 0; i < d.length; i += 4) {
                const l = (d[i]! * 77 + d[i + 1]! * 151 + d[i + 2]! * 28) >> 8;
                if (l > BLACK) nonBlack++;
              }
            }
          } catch { /* handle briefly absent — records as a black frame */ }
          series.push(nonBlack);
          if (n >= frames) { resolve(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      let longest = 0;
      let run = 0;
      let black = 0;
      for (const v of series) {
        if (v === 0) { run++; black++; if (run > longest) longest = run; } else run = 0;
      }
      return {
        frames: n,
        elapsedMs: Math.round(performance.now() - t0),
        blackFrames: black,
        longestBlackRun: longest,
        series,
      };
    },
    { nodeId, port, frames: HANDOFF_FRAMES, W: PROBE_W, H: PROBE_H, BLACK: BLACK_LUMA },
  );
}

/** Where the node's REAL card is mounted right now, and how many times. */
async function cardMounts(page: Page, nodeId: string): Promise<{ headless: number; dock: number }> {
  return page.evaluate((id) => ({
    headless: document.querySelectorAll(`[data-testid="headless-source-host"][data-node-id="${id}"]`).length,
    dock: document.querySelectorAll('[data-testid="dock-full-view"]').length,
  }), nodeId);
}

/** Is the module's engine handle still publishing this video source? */
async function hasVideoSource(page: Page, nodeId: string, port: string): Promise<boolean> {
  return page.evaluate(({ id, p }) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { getVideoSource?: (i: string, p: string) => unknown } };
    };
    try { return !!w.__engine!().getDomain('audio').getVideoSource!(id, p); } catch { return false; }
  }, { id: nodeId, p: port });
}

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT faceplate shell, which is the whole point: under
  // `?shell=legacy` the real card renders in the lane and the bug is invisible.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
}

for (const subject of SUBJECTS) {
  const { type, domain, videoOuts } = subject;
  const nodeId = `producer-${type}`;

  test(`${type}: its card is kept alive off-screen when the shell swaps the lane card away`, async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 120_000 : 60_000);
    await boot(page);
    await spawnPatch(page, [{ id: nodeId, type, domain }], [], { mountTimeout: 30_000 });

    // The lane shows the uniform tile (this module is un-migrated under the
    // shell) — i.e. its real card is NOT in the lane…
    await expect(
      page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell-placeholder"]`),
    ).toHaveCount(1, { timeout: 20_000 });

    // …and the headless host is holding it, exactly once. This leg carries the
    // whole claim for a producer whose output is not a picture (SYNESTHESIA
    // writes per-band levels to its AUDIO outs), so no subject is uncovered.
    await expect
      .poll(async () => (await cardMounts(page, nodeId)).headless, {
        message: `${type}'s real card must be mounted in <HeadlessSourceHost> exactly once`,
        timeout: 20_000,
      })
      .toBe(1);
  });

  if (videoOuts.length === 0) continue;

  test(`${type}: live picture with the card NEVER expanded, across expand → collapse → delete`, async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 240_000 : 120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page);
    const canvasesBefore = await page.evaluate(() => document.querySelectorAll('canvas').length);

    // The owner's rack: the producer patched straight into the video monitor.
    await spawnPatch(
      page,
      [
        { id: nodeId, type, domain },
        { id: 'producer-out', type: 'videoOut', domain: 'video' },
      ],
      [
        {
          id: 'producer-edge',
          from: { nodeId, portId: videoOuts[0]! },
          to: { nodeId: 'producer-out', portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        },
      ],
      { mountTimeout: 30_000 },
    );

    // ── 1. NEVER MOUNTED — nothing has been expanded, clicked or docked ──────
    const neverSamples = await samplePorts(page, nodeId, videoOuts);
    const liveNever = livePorts(neverSamples);

    // ── 2. POSITIVE CONTROL — the identical probe while the card IS mounted ──
    // Permanent, and it is also the regression guard for the dock mount itself,
    // which THREW (bare useStore outside the SvelteFlow provider) and rendered
    // nothing at all — the reason the issue's own expanded/collapsed readings
    // were identical.
    await page.evaluate((id) => {
      (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id);
    }, nodeId);
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 30_000 });
    // Exactly ONE mount at a time: the headless host stands down while the dock
    // holds the card, so two GL contexts / two producers never race.
    expect(
      await cardMounts(page, nodeId),
      `${type} must be mounted in the dock and NOT also in the headless host`,
    ).toEqual({ headless: 0, dock: 1 });
    // The SAME port list in both states — the set comparison below is only
    // meaningful if the probe looked at the same thing twice.
    const mountedSamples = await samplePorts(page, nodeId, videoOuts);
    const liveMounted = livePorts(mountedSamples);

    // THE CAUSAL CLAIM, both directions: a port lights up when the card is
    // mounted IF AND ONLY IF it lights up when the card was never mounted.
    // Before the fix WAVESCULPT read `[]` never-mounted and `['video_out']`
    // mounted; that inequality IS the bug.
    expect(
      liveNever,
      `#1587: the ports carrying a picture must be the same whether or not ${type}'s card is ` +
        `mounted.\n  never-mounted: ${digest(neverSamples)}\n  card mounted:  ${digest(mountedSamples)}`,
    ).toEqual(liveMounted);

    // A subject whose ports show nothing even WITH the card mounted is not
    // carrying pixel coverage here — SYNESTHESIA's per-band rasters need a video
    // source patched in before they render anything. Skip LOUDLY, and only
    // AFTER the dock-mount assertions above, so a broken mount fails rather
    // than quietly turning into a skip.
    test.skip(
      liveMounted.length === 0,
      `${type} shows no picture on any video output even with its card mounted, so there is ` +
        `nothing here to lose: ${digest(mountedSamples)}. Its producer lifetime is covered by ` +
        'the headless-mount test above and by dom-source-modules.test.ts.',
    );

    // MOVEMENT, on the state that matters. "Not black" alone is not enough for
    // TIMELORDE: its drawFrame keeps blitting the last bitmap the card ever
    // pushed, so a dead producer can read non-black forever.
    for (const port of liveNever) {
      const moved = await framesToChange(page, nodeId, port);
      expect(
        moved.changed,
        `#1587: ${type}.${port} must emit a MOVING picture — a frozen surface is exactly how ` +
          `the issue's own probe read a dead producer as a live one. ${fmtChange(moved)}`,
      ).toBe(true);
    }

    // ── 3. CONTINUITY — collapse, sampling EVERY frame across the handoff ────
    // The card MOVES from the dock back to the headless host, which for
    // WAVESCULPT re-runs initGl(). Measure the gap instead of assuming it away.
    const witness = liveNever[0]!;
    const pending = probeEveryFrame(page, nodeId, witness);
    await page.getByTestId('faceplate-collapse').first().click();
    const handoff = await pending;
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, { timeout: 20_000 });
    expect(
      handoff.longestBlackRun,
      `${type}.${witness} lost its picture across the dock→headless handoff for ` +
        `${handoff.longestBlackRun} consecutive frames (of ${handoff.frames} sampled, ` +
        `${handoff.blackFrames} black in total, ${handoff.elapsedMs} ms wall). ` +
        `Series (nonBlack px/frame): ${handoff.series.join(',')}`,
    ).toBeLessThan(MAX_BLACK_RUN_FRAMES);

    await expect
      .poll(async () => (await cardMounts(page, nodeId)).headless, {
        message: 'the headless host takes the card back when the full-view closes',
        timeout: 20_000,
      })
      .toBe(1);
    const afterSamples = await samplePorts(page, nodeId, videoOuts);
    expect(
      livePorts(afterSamples),
      `${type} must still carry the same picture after the collapse: ${digest(afterSamples)}`,
    ).toEqual(liveNever);
    for (const port of liveNever) {
      const moved = await framesToChange(page, nodeId, port);
      expect(
        moved.changed,
        `${type}.${port} must still emit a MOVING picture after the collapse — a frozen last ` +
          `frame is what a producer that never restarted looks like. ${fmtChange(moved)}`,
      ).toBe(true);
    }

    // ── 4. DELETE — the node leaves the graph, the card goes with it ─────────
    // The card's onDestroy is what releases the GL context (disposeGl) and its
    // frame drawer, so what this asserts is that the card really did unmount
    // and the module handle really did go with the node.
    await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const [eid, e] of Object.entries(w.__patch.edges)) {
          const edge = e as { source?: { nodeId?: string }; target?: { nodeId?: string } } | undefined;
          if (edge?.source?.nodeId === id || edge?.target?.nodeId === id) delete w.__patch.edges[eid];
        }
        delete w.__patch.nodes[id];
      });
    }, nodeId);

    await expect
      .poll(async () => (await cardMounts(page, nodeId)).headless, {
        message:
          `${type}'s card must be unmounted from every host when its node is deleted ` +
          '(that unmount is what runs disposeGl + drops the frame drawer)',
        timeout: 20_000,
      })
      .toBe(0);
    await expect
      .poll(async () => hasVideoSource(page, nodeId, witness), {
        message: `${type}'s engine handle must be gone after the node is deleted`,
        timeout: 20_000,
      })
      .toBe(false);
    // No detached card canvas left behind in the document.
    await expect
      .poll(async () => page.evaluate(() => document.querySelectorAll('canvas').length), {
        message: `canvas count must return to the pre-spawn baseline (${canvasesBefore})`,
        timeout: 20_000,
      })
      .toBeLessThanOrEqual(canvasesBefore);

    // The dock mount used to throw a provider error and render nothing; nothing
    // in this whole flow may raise one.
    const providerErrors = errors.filter((e) => /useStore|SvelteFlowProvider/i.test(e));
    expect(providerErrors, `provider throw(s) during the lifecycle: ${providerErrors.join(' | ')}`).toEqual([]);
  });
}
