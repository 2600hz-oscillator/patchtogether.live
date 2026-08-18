// e2e/tests/_doom-helpers.ts
//
// ⚠ DOOM SPECS ARE NORMALLY OFF-LIMITS. The standing owner ruling is:
//     "do not fuck with doom in any way without specific approval"
//   This file — and the DOOM specs that import it — exist under a SPECIFIC,
//   NARROWER approval given by the owner on 2026-08-18, verbatim:
//     "okay see if you can go make the doom tests blurrier and less flakey,
//      just knowing doom renders and our kb logic and basic game nav works
//      is fine"
//   That approval covers the SPECS ONLY. It does NOT extend to
//   packages/web/src/lib/video/modules/doom.ts, the WASM/WAD assets, or the
//   netcode. If you are here for anything else, stop and ask the owner.
//
// ── WHY DOOM SPECS FLAKE, MECHANICALLY ─────────────────────────────────────
//
// `video/modules/doom.ts` calls `runtime.runTic()` inside `surface.draw`, and
// `runTic` runs exactly one `dgpt_tick`. So DOOM'S GAME CLOCK IS THE FRAME
// CLOCK: one rendered frame is one game tic.
//
// A wall-clock wait is therefore A DIFFERENT NUMBER OF GAME TICS ON EVERY
// RENDERER — `waitForTimeout(1200)` is ~72 tics on a real GPU and ~9 under
// SwiftShader, and CI runs ten shards in parallel on top of that. Any assertion
// about WHERE THE MARINE ENDED UP is really an assertion about HOW MANY TICS
// ELAPSED, which is renderer- and load-dependent by construction. You cannot
// fix that by waiting differently. The PRECISION OF THE ASSERTION is the defect.
//
// ── THE TWO TOOLS THIS FILE GIVES YOU ──────────────────────────────────────
//
// 1. `waitTics` — wait in GAME TICS, read off DOOM's own clock inside the page.
//    This is the DOOM-native unit. `waitFrames` (e2e/_helpers/frames.ts) counts
//    the page's rAF, which is *usually* the same thing but is one inference
//    removed; `getTics().gametic` is the actual number the assertion cares
//    about. Renderer-independent by construction on both counts.
//
// 2. `pressUntilInLevel` — SELF-CORRECTING menu nav. The old `for (4) { press
//    Enter; waitForTimeout(300) }` assumed each Enter lands in a window that
//    contains enough tics for DOOM to process it; on a slow renderer some
//    presses fall in windows with ~2 tics and the walk stalls halfway. Pressing
//    until the observable is true needs no such guess. ⚠ It still issues the
//    canonical walk FIRST — read its `minPresses` note before "simplifying"
//    that away, because DOOM's attract demo makes the observable true while
//    the game is playing itself.
//
// ── AND THE RULE FOR THRESHOLDS ────────────────────────────────────────────
//
// A threshold must encode "DISTINGUISHABLE FROM A STATIONARY MARINE", never
// "the marine walked far enough". Combine a tiny epsilon with a POLL that waits
// as long as the renderer needs: the epsilon stays non-vacuous (a frozen sim
// never crosses it) while the poll absorbs any tic rate. See MOVE_EPS/TURN_EPS.
//
// ⚠ DO NOT BLUR INTO VACUITY. Every surviving assertion in the DOOM specs is
// paired with a NEGATIVE CONTROL in the same test — a leg that proves the
// probe reads red when the thing under test is absent (no input held, an
// unpatched sink). A blurry test with no control is worse than a flaky one: it
// is a green light wired to nothing.

import { expect, type Page } from '@playwright/test';

/** DOOM's fixed-point map units are 16.16 — one map unit is 65_536 raw. */
export const MAP_UNIT = 65_536;

/**
 * "The marine is not where it was" — ONE map unit of travel.
 *
 * NOT a distance the marine is expected to cover. A stationary marine holds x/y
 * EXACTLY constant (they are integers off the C mobj struct, and nothing writes
 * them without a ticcmd), so the honest noise floor here is literally zero and
 * any positive epsilon is a real witness. One map unit is 65_536× that floor
 * and is crossed by a SINGLE tic of walking (forwardmove 25 ⇒ ~25 map units per
 * tic ⇒ ~1.6 M raw), which is what makes it tic-rate-insensitive: the poll needs
 * one tic to succeed, not seventy.
 *
 * The old spec threshold was 100_000 raw AFTER A FIXED 1200 ms HOLD — same
 * order of magnitude, but the *fixed hold* is what made it renderer-dependent.
 */
export const MOVE_EPS = MAP_UNIT;

/**
 * "The marine is not facing where it was" — ~0.33° in angle_t units.
 *
 * angle_t is uint32 over a full turn (2^32 = 360°). DOOM's SLOW turn rate
 * (angleturn[2] = 320, used for the first ~6 tics of a held turn) is
 * 320 << 16 = 20_971_520 per tic, so this epsilon is crossed by ONE slow tic
 * with 5× headroom. The old threshold was 50_000_000 — MORE than one slow tic
 * (≈ 2.4 of them), so it silently required a minimum tic count to pass.
 */
export const TURN_EPS = 4_000_000;

/**
 * A CAP for a transition DOOM's own sim has to run — never a relay budget.
 *
 * ⚠ THE CATEGORY ERROR THIS EXISTS TO STOP. `SYNC_BUDGET_MS` (20 s,
 * `_collab-helpers.ts`) is calibrated for CROSS-CONTEXT YJS CONVERGENCE — A
 * mutates, the relay ships it, B observes. It is paced by the relay's event
 * loop. A DOOM level relaunch (`G_InitNew` + the joiner's marine spawning at
 * its coop start) is paced by the FRAME CLOCK, because DOOM's game clock is the
 * frame clock — and the peer waiting for it is very often a BACKGROUNDED
 * Playwright context, where rAF is throttled hard. Spending a relay budget on a
 * sim-paced transition makes the cap the gate, which is exactly the shape that
 * flakes.
 *
 * So: sync waits keep SYNC_BUDGET_MS; anything the SIM has to run gets this,
 * and it BOUNDS THE FAILURE rather than gating it. It stays well under the
 * specs' own `test.setTimeout` so a genuine hang still surfaces as a named
 * assertion rather than an opaque test timeout.
 */
export const SIM_BUDGET_MS = 60_000;

/** Manhattan distance in raw fixed-point units. */
export function manhattan(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * DOOM's angle_t is uint32 over a full rotation. Shortest SIGNED delta, so a
 * turn across zero doesn't read as a near-360° swing.
 */
export function angleDelta(before: number, after: number): number {
  const TWO32 = 4_294_967_296;
  let d = after - before;
  if (d > TWO32 / 2) d -= TWO32;
  if (d < -TWO32 / 2) d += TWO32;
  return d;
}

/**
 * WAIT IN GAME TICS — the renderer-independent unit for anything DOOM.
 *
 * Reads `__doomCards[nodeId].getTics().gametic` (→ `dgpt_get_gametic`) inside
 * the page and resolves when it has advanced by `tics`. Returns the ACTUAL
 * advance observed, so a caller can assert the sim moved at all rather than
 * discovering a frozen runtime as a downstream mystery.
 *
 * ⚠ `capMs` BOUNDS THE FAILURE — it is never the gate. When the cap wins, the
 * return value is short of `tics` and the caller's assertion (with the real
 * number in its message) is what goes red.
 *
 * The whole loop runs in ONE page.evaluate: a per-tic CDP round trip would be
 * one round trip per sample ON THE SAME MAIN THREAD AS THE SUBJECT, which on a
 * loaded runner costs several times what it measures (CLAUDE.md's instrument
 * rule names this exact shape). rAF paces the loop because a rAF IS a tic; a
 * 50 ms timer races it so a fully stalled renderer still reaches the cap
 * instead of hanging.
 *
 * @returns tics advanced, or -1 when the card hook is not present.
 */
export async function waitTics(
  page: Page,
  nodeId: string,
  tics: number,
  capMs = 30_000,
): Promise<number> {
  return await page.evaluate(
    async (args) => {
      const [id, want, cap] = args as [string, number, number];
      const read = (): number => {
        const w = globalThis as unknown as {
          __doomCards?: Record<string, { getTics?: () => { gametic: number } }>;
        };
        const t = w.__doomCards?.[id]?.getTics?.();
        return t ? t.gametic : -1;
      };
      const start = read();
      if (start < 0) return -1;
      const deadline = performance.now() + cap;
      for (;;) {
        const now = read();
        if (now < 0) return -1;
        if (now - start >= want) return now - start;
        if (performance.now() >= deadline) return now - start;
        await new Promise<void>((resolve) => {
          let done = false;
          const fire = (): void => {
            if (done) return;
            done = true;
            resolve();
          };
          requestAnimationFrame(fire);
          setTimeout(fire, 50);
        });
      }
    },
    [nodeId, tics, capMs] as const,
  );
}

/** Current gametic, or -1 when the card hook / runtime is not up yet. */
export async function gametic(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __doomCards?: Record<string, { getTics?: () => { gametic: number } }>;
    };
    const t = w.__doomCards?.[id]?.getTics?.();
    return t ? t.gametic : -1;
  }, nodeId);
}

/** Player x/y/angle straight off the runtime, or null before the mobj spawns. */
export async function readPlayer(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number; angle: number } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { read?: (n: string, k: string) => unknown } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    const extras = ve?.read?.(id, 'extras') as
      | {
          getRuntime?: () => {
            getPlayerState?: () => { x: number; y: number; angle: number } | null;
          } | null;
        }
      | undefined;
    return extras?.getRuntime?.()?.getPlayerState?.() ?? null;
  }, nodeId);
}

/** True once the player thinker has placed the marine on the map. */
export async function inLevel(page: Page, nodeId: string): Promise<boolean> {
  return (await readPlayer(page, nodeId)) !== null;
}

/**
 * Add ONE edge to the LIVE patch without tearing anything down.
 *
 * `spawnPatch` CLEARS the graph before rebuilding it, so it cannot be used to
 * wire something into an already-booted DOOM runtime — the clear would destroy
 * the WASM instance and the level with it. This transacts a single edge into
 * `__patch.edges` exactly the way spawnPatch does, which is what makes an
 * EDGE-ABSENT / EDGE-PRESENT negative control affordable: the same marine, in
 * the same level, with the wire as the only thing that changed.
 */
export async function addEdgeLive(
  page: Page,
  edge: {
    id: string;
    from: { nodeId: string; portId: string };
    to: { nodeId: string; portId: string };
    sourceType?: string;
    targetType?: string;
  },
): Promise<void> {
  await page.evaluate((e) => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.edges[e.id] = {
        id: e.id,
        source: e.from,
        target: e.to,
        sourceType: e.sourceType ?? 'audio',
        targetType: e.targetType ?? 'audio',
      };
    });
  }, edge);
}

/**
 * BASIC GAME NAV, THE SELF-CORRECTING WAY: press Enter until the marine exists.
 *
 * DOOM's title sequence needs ~4 Enters (demo → main menu → New Game → skill →
 * E1M1), but "4 presses with a 300 ms gap" is a bet that each gap contains
 * enough tics for DOOM to consume the key. Under a slow renderer 300 ms is ~2
 * tics and some presses land in the same menu frame, so the walk stalls at the
 * skill picker and the *next* assertion fails with an unrelated message. Press
 * → wait a few TICS → re-check the observable, and the walk self-corrects at
 * any tic rate. Extra Enters once in the level are inert (Enter is unbound in
 * gameplay), so overshooting is safe.
 *
 * ⚠ `minPresses` IS NOT A COSMETIC DEFAULT — IT IS AN ANTI-VACUITY GUARD.
 * DOOM's ATTRACT DEMO is a real level with a real player mobj, so "the marine
 * exists" is TRUE while the game is playing itself. A loop that checked before
 * pressing would return 0 presses the moment the demo rolled, and hand the
 * caller a marine that MOVES ON ITS OWN — which silently passes any "an input
 * moved the marine" leg and silently fails any "nothing moved" control leg.
 * Issuing the canonical walk unconditionally aborts the demo and lands a real
 * New Game before the observable is consulted at all.
 *
 * @returns the number of Enter presses it actually took (reported in the
 *          caller's assertion message — a sudden jump is a real finding).
 */
export async function pressUntilInLevel(
  page: Page,
  nodeId: string,
  opts: { maxPresses?: number; minPresses?: number; timeoutMs?: number } = {},
): Promise<number> {
  const maxPresses = opts.maxPresses ?? 24;
  const minPresses = opts.minPresses ?? 4;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let presses = 0;
  while (presses < maxPresses && Date.now() < deadline) {
    if (presses >= minPresses && (await inLevel(page, nodeId))) return presses;
    await page.keyboard.press('Enter');
    presses++;
    // A menu selection is consumed on the next tic; 4 gives the level-load a
    // head start without pinning the walk to a wall-clock budget.
    await waitTics(page, nodeId, 4, 5_000);
  }
  await expect
    .poll(() => inLevel(page, nodeId), {
      timeout: Math.max(1_000, deadline - Date.now()),
      message:
        `DOOM never reached a level after ${presses} Enter presses. Either the ` +
        `card is not consuming keys (keyboard claim never landed) or the sim is ` +
        `frozen (gametic not advancing) — check waitTics' return value.`,
    })
    .toBe(true);
  return presses;
}
