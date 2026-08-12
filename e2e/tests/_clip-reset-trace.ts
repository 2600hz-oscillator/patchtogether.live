// e2e/tests/_clip-reset-trace.ts
//
// THE SHARED RESET INSTRUMENT for the clip player's playheads.
//
// WHY IT IS SHARED, and why that is the point rather than tidiness: TWO specs
// assert "the reset snapped every active lane back to the top" — the CARD's RST
// button (`clipplayer-rate-reset.spec.ts`) and the LAUNCHPAD's hardware RESET
// pad (`launchpad-perf-controls.spec.ts`). They make the same claim about the
// same engine and they had DIFFERENT instruments: the card test was rebuilt
// around an in-page trace with arithmetic wrap exclusion (#1173), and the
// launchpad test was left on the CDP-poll absolute band that #1173 had just
// measured as unsound — its comment even said "same tolerance as the card RST
// test" while the card test no longer used a tolerance at all.
//
// That is how a load-sensitive test survives two hardenings: the LOUD half of a
// fix travels (the numbers were copied) and the QUIET half does not (the shape
// was not). One predicate, called by both, is the only version of "same as the
// card test" that stays true.
//
// A `_`-prefixed file registers no tests, so importing it from a spec is safe;
// importing the sibling SPEC would register its tests twice.
//
// ---------------------------------------------------------------------------

import type { Page } from '@playwright/test';

/** The engine/patch surface these helpers read. Matches the shape both specs
 *  already declare locally. */
export type EngineW = {
  __engine?: () => {
    read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
  } | null;
  __patch: {
    nodes: Record<
      string,
      {
        id: string;
        type: string;
        domain: string;
        params?: Record<string, number>;
        data?: Record<string, unknown>;
      }
    >;
  };
  __ydoc: { transact: (fn: () => void) => void };
};

/** The seeded clip length. This is `MAX_CLIP_STEPS` (clip-types.ts): the engine
 *  coerces every clip through `clampStepCount`, so a longer clip CANNOT be
 *  seeded to push the loop-wrap horizon further out — the reset proof below
 *  excludes a wrap arithmetically instead of by out-running it. */
export const CLIP_STEPS = 128;
/** Nominal lane clock: stepDiv 2 = a 1/16 grid, @240 bpm = 62.5 ms/step. */
export const NOMINAL_STEPS_PER_S = 16;

// ── RESET PROOF: an IN-PAGE playhead trace, not a CDP poll ──────────────────
//
// WHY (measured 2026-07, after two failed hardenings): the RST test used to
// click reset and then POLL the engine over CDP for an ABSOLUTE "step <= 6"
// band. Under load a single `page.evaluate` round-trip costs ~1.5 s, so the
// FIRST read after `click()` landed long after the reset had already fired and
// the playhead had climbed back OUT of the band. Back-projecting a failing
// run's own numbers (15.65 steps/s — the nominal 16 for a 1/16 grid @240 bpm)
// put the playhead at ≈22 when `click()` returned, i.e. the reset had fired
// ~1.4 s earlier. Widening the band (2→6) and then the timeout (2500→5000)
// both failed because NEITHER is the binding constraint: the constraint is the
// latency between the reset FIRING and the first READ, and a longer timeout
// only buys more chances to read a playhead that is now climbing AWAY.
//
// The absolute band is not even SOUND under load. Injecting pre-read latency
// on an idle machine (the old assertion, same patch):
//     +0 ms    pass          +6000 ms  "pass" — on a natural LOOP WRAP
//     +1500 ms FAIL (103)    +9000 ms  FAIL (95)
//     +3000 ms FAIL (127)    +14000 ms "pass" — on a natural LOOP WRAP
// i.e. past the 8 s / 128-step wrap horizon it can go green WITHOUT the reset
// happening at all. A longer clip cannot fix that: `MAX_CLIP_STEPS` = 128 and
// the engine coerces every clip through `clampStepCount`, so a 512-step seed
// is silently clamped back to 128.
//
// So: record the playheads INSIDE the page on a 10 ms interval (no CDP in the
// detection path — measured max sampler gap ~30 ms even with 14 s of injected
// latency) and prove a BACKWARD JUMP that is arithmetically TOO FAST to be a
// loop wrap. `currentStep` is monotone between wraps and resets, so a decrease
// has exactly two causes and the wrap is EXCLUDED BY ARITHMETIC rather than by
// hoping the observation window is short. Strictly stronger than "happened to
// read low", and it has no wall-clock race left to widen.

export type TraceDrop = { dt: number; prev: number[]; cur: number[]; wrapMs: number };
export type TraceSummary = { samples: number; spanMs: number; maxGapMs: number; rate: number; drops: TraceDrop[] };
export type TraceW = { __cpTrace?: { stop: () => void; read: () => TraceSummary } };

/** Start the in-page recorder for `keys` on `nodeId`. Each tick also classifies
 *  a backward jump: `wrapMs` is the MINIMUM time a free-running playhead would
 *  need to read `cur` after reading `prev` via a natural wrap, so `dt ≪ wrapMs`
 *  means the jump cannot be a wrap. */
export async function startStepTrace(page: Page, nodeId: string, keys: string[]): Promise<void> {
  await page.evaluate(
    ({ id, ks, len, nominal }) => {
      const w = globalThis as unknown as EngineW & TraceW;
      const t: number[] = [];
      const s: number[][] = [];
      const drops: TraceDrop[] = [];
      let runStart = 0; // index of the first sample of the current drop-free run
      let rate = nominal;
      let maxGapMs = 0;
      const h = setInterval(() => {
        const eng = w.__engine?.();
        const node = w.__patch.nodes[id];
        if (!eng || !node || t.length >= 5000) return;
        const now = performance.now();
        const cur = ks.map((k) => {
          const v = eng.read(node, k);
          return typeof v === 'number' ? v : NaN;
        });
        if (t.length) {
          const dt = now - t[t.length - 1];
          if (dt > maxGapMs) maxGapMs = dt;
          const prev = s[s.length - 1];
          const finite = prev.every(Number.isFinite) && cur.every(Number.isFinite);
          if (finite && prev.every((p, L) => cur[L] < p)) {
            // `- 1` is ONE STEP of read quantization: `prev` may have been read
            // at the very END of its step and `cur` at the very START of its
            // own. Without it a tight 127→0 wrap looks instantaneous and is
            // misread as a reset (verified against a real wrap).
            const wrapMs = Math.min(
              ...prev.map((p, L) => (Math.max(0, len - p - 1 + Math.max(0, cur[L])) / rate) * 1000),
            );
            drops.push({ dt, prev, cur, wrapMs });
            runStart = t.length; // a fresh drop-free run starts at THIS sample
          } else if (finite && runStart < t.length) {
            // Re-measure the FREE-RUNNING rate over the current drop-free run,
            // so the wrap exclusion never trusts a hard-coded tempo. Only ever
            // raised above nominal: a FASTER assumed clock shrinks `wrapMs`,
            // which is the conservative direction (harder to call a wrap a reset).
            const dS = cur[0] - s[runStart][0];
            const dT = (now - t[runStart]) / 1000;
            if (dT > 0.4 && dS > 0) rate = Math.max(rate, dS / dT);
          }
        }
        t.push(now);
        s.push(cur);
      }, 10);
      w.__cpTrace = {
        stop: () => clearInterval(h),
        read: () => ({ samples: t.length, spanMs: t.length ? t[t.length - 1] - t[0] : 0, maxGapMs, rate, drops }),
      };
    },
    { id: nodeId, ks: keys, len: CLIP_STEPS, nominal: NOMINAL_STEPS_PER_S },
  );
}

/** Wait until the trace holds a backward jump too fast to be a wrap, that lands
 *  near the top. Polls IN-PAGE (`waitForFunction`), so no CDP round-trip sits in
 *  the detection path — that latency IS the bug this replaces. Returns on the
 *  first qualifying jump (~50 ms on a healthy run: no added wall time). */
export async function waitForResetSnap(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const drops = (globalThis as unknown as TraceW).__cpTrace?.read().drops ?? [];
        return drops.some((d) => d.dt < d.wrapMs * 0.5 && d.cur.every((c) => c <= 6));
      },
      undefined,
      { timeout: timeoutMs, polling: 25 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Stop the recorder and return everything it saw (the failure message). */
export async function stopStepTrace(page: Page): Promise<TraceSummary> {
  return await page.evaluate(() => {
    const tr = (globalThis as unknown as TraceW).__cpTrace;
    if (!tr) return { samples: 0, spanMs: 0, maxGapMs: 0, rate: 0, drops: [] };
    tr.stop();
    return tr.read();
  });
}
