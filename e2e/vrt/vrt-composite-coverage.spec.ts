// e2e/vrt/vrt-composite-coverage.spec.ts
//
// Composite-card VRT baselines for the video→audio CV/gate routing class
// (PR #414 regression coverage). For each (source, consumer) pair from the
// e2e spec we snap TWO frames per pair:
//
//   * <pair-id>-idle   — both cards visible BEFORE the CV/gate fires.
//   * <pair-id>-driven — both cards visible AFTER the CV/gate fires.
//
// What the diff proves: under the pre-#414 bug, the dispatcher silently
// dropped every video→audio cv/gate edge, so the consumer card's visual
// state (filter cutoff slider, drum-voice flash, scope trace) was IDENTICAL
// in both shots. With the fix, the consumer responds — the driven frame
// differs visibly.
//
// Determinism: AudioContext is SUSPENDED after the fire, so the analyser-
// derived parts of each card freeze on their last buffer. The CV ramp / gate
// pulse is scheduled via the existing `extras.forcePulse()` test hook (also
// used by the e2e spec) — exact same pulse-width path on every run.
//
// ⚠ THAT PARAGRAPH WAS TRUE AND INCOMPLETE, AND THE GAP MADE A BASELINE
// NONDETERMINISTIC FOR MONTHS. It covers the CONSUMER (SCOPE's analyser) and
// says nothing about the SOURCE, whose card is half the framed area. NIBBLES is
// a running snake game: it seeds from `Date.now()` unless `__nibblesVrtSeed` is
// set, and it steps whenever `frame.time` advances. Neither was pinned here.
//
// MEASURED, by classifying the two PNGs rather than reasoning from the code —
// the committed baseline against the frame a full sweep captured:
//   LEN 4 → LEN 5 · pellet moved (495,167) → (374,133) · snake moved
// i.e. a different RNG draw AND a different number of elapsed game ticks. It is
// a GAME-STATE difference, not the analyser-phase difference the determinism
// note above would lead you to suspect.
//
// It went unnoticed because the scene usually lands inside the diff tolerance,
// and because VRT captures are scoped by default — a full sweep, which is what
// finally compared this baseline, is rare. The sibling spec `vrt-composite.spec.ts`
// had the same exposure and does NOT have the bug: its scenes go through
// `vrt-composite-scenes.ts`, which has pinned `__nibblesVrtSeed` all along. Two
// composite specs, one pinned, one not.
//
// Both halves are now pinned for the NIBBLES pairs only — see the per-pair
// branch in the test body, and ⚠ note the DOOM pairs are deliberately excluded.
//
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.
// NIBBLES rasterises on the CPU so its frames are
// platform-agnostic; DOOM is gated on the WASM asset (skip-clean when
// missing).

import { pinVrtFonts, awaitVrtFonts } from './_fonts';
import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, canvasNode } from '../tests/_helpers';

// Every composite pair lands on SCOPE.ch1 as the consumer — its analyser-
// driven canvas renders the bridged signal as a visible trace excursion
// (CV: steady DC offset; gate held HIGH: solid line at top). DRUMMERGIRL +
// other audio modules are valid receivers (covered by the live e2e + the
// engine-bridge unit sweep) but their knob UIs don't visually reflect
// AudioParam-summed CV — the slider tracks knob STATE, not the param's
// modulated value — so a VRT diff against drummergirl would be vacuous.
//
// For gate pairs we use forceHold(port, true) to lock the source CSN at
// offset=1 indefinitely. forcePulse() (a 10ms pulse) would be gone by the
// time audio is suspended for the snapshot.

interface CompositePair {
  id: string;
  source: { type: 'nibbles' | 'doom'; portId: string };
  kind: 'cv' | 'gate';
  driverPort: string;
  /** CV value to push for cv pairs; ignored for gate. */
  value?: number;
  /** When true (DOOM source), skip on missing WASM asset rather than fail. */
  gatedOnDoomWasm?: boolean;
}

const COMPOSITE_PAIRS: CompositePair[] = [
  {
    id: 'nibbles-length_cv',
    source: { type: 'nibbles', portId: 'length_cv' },
    kind: 'cv',
    driverPort: 'length_cv',
    value: 0.85,
  },
  {
    id: 'nibbles-pellet',
    source: { type: 'nibbles', portId: 'pellet' },
    kind: 'gate',
    driverPort: 'pellet',
  },
  {
    id: 'doom-evt_kill',
    source: { type: 'doom', portId: 'evt_kill' },
    kind: 'gate',
    driverPort: 'evt_kill',
    gatedOnDoomWasm: true,
  },
  {
    id: 'doom-evt_door',
    source: { type: 'doom', portId: 'evt_door' },
    kind: 'gate',
    driverPort: 'evt_door',
    gatedOnDoomWasm: true,
  },
];

async function doomWasmPresent(page: Page): Promise<boolean> {
  // Same pattern doom-launch.spec.ts uses — HEAD probe for the runtime.
  return await page.evaluate(async () => {
    try { return (await fetch('/doom/doom.js', { method: 'HEAD' })).ok; }
    catch { return false; }
  });
}

async function firePulse(
  page: Page,
  sourceNodeId: string,
  port: string,
  value: number | undefined,
): Promise<boolean> {
  return await page.evaluate(
    ({ id, p, v }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return false;
      const node = w.__patch.nodes[id];
      if (!node) return false;
      const extras = eng.read(node, 'extras') as
        | { forcePulse?: (p: string, v?: number) => void }
        | undefined;
      if (!extras || typeof extras.forcePulse !== 'function') return false;
      extras.forcePulse(p, v);
      return true;
    },
    { id: sourceNodeId, p: port, v: value },
  );
}

/** Hold a gate output HIGH (or LOW) indefinitely — overrides the 10ms
 *  auto-fall-back of forcePulse so a suspended-audio snapshot freezes the
 *  gate signal in a known state. Required for the gate VRT pairs: a 10ms
 *  pulse is otherwise gone by the time the snapshot is captured. */
async function forceHold(
  page: Page,
  sourceNodeId: string,
  port: string,
  high: boolean,
): Promise<boolean> {
  return await page.evaluate(
    ({ id, p, h }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return false;
      const node = w.__patch.nodes[id];
      if (!node) return false;
      const extras = eng.read(node, 'extras') as
        | { forceHold?: (p: string, h: boolean) => void }
        | undefined;
      if (!extras || typeof extras.forceHold !== 'function') return false;
      extras.forceHold(p, h);
      return true;
    },
    { id: sourceNodeId, p: port, h: high },
  );
}

async function suspendAudio(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
    const eng = w.__engine?.();
    if (eng) {
      try { await eng.ctx.suspend(); } catch { /* */ }
    }
  });
}

async function resumeAudio(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
    const eng = w.__engine?.();
    if (eng) {
      try { await eng.ctx.resume(); } catch { /* */ }
    }
  });
}

test.describe.configure({ mode: 'default' });

test.describe('VRT: video→audio CV/gate composite pairs (#414 regression coverage)', () => {
  for (const pair of COMPOSITE_PAIRS) {
    test(`composite ${pair.id} matches BEFORE/AFTER baselines`, async ({ page }) => {
      // ⚠ These scenes mix CPU-rasterised NIBBLES / DOOM cards with the
      // consumer card's analyser-driven canvas, and the analyser slice's exact
      // pixel values drift sub-thresholdly with the AudioContext sine-table +
      // Float32 path. That used to be the argument for keeping them dark on
      // linux; with one baseline set the comparison is same-platform, so the
      // drift that argument was about is no longer in it.

      await pinVrtFonts(page);

      // ── NIBBLES DETERMINISM (see the block comment above this describe) ──
      //
      // ⚠ SCOPED TO THE NIBBLES PAIRS BY NAME. The DOOM pairs' path below is
      // byte-for-byte what it was: no clock pin, no seed, nothing. DOOM's game
      // clock IS its frame clock (`surface.draw` calls `runTic`, one tic per
      // rendered frame), so pinning time on that module would re-specify how
      // far the marine walks in a suite that then asserts on where he ended up.
      // The standing ruling is not to touch DOOM's timing at all, so this
      // branch is what keeps that promise structurally rather than by comment.
      const pinsNibbles = pair.source.type === 'nibbles';

      if (pinsNibbles) {
        // (1) FREEZE THE ENGINE CLOCK, before boot. The game advances off
        //     `frame.time`: `dt = tNow - lastDrawTimeS` feeds `tickAccumS`,
        //     and the tick loop runs `advanceGame()` while that exceeds the
        //     period. Pinning `frame.time` makes `dt` identically 0, so the
        //     snake never steps and the render stops being a function of how
        //     long the runner took to get here.
        await page.addInitScript(() => {
          (globalThis as unknown as { __videoEngineFreezeTime?: number })
            .__videoEngineFreezeTime = 2.0;
        });
      }

      await page.goto('/rack?seed=none');
      await page.waitForLoadState('networkidle');
      await awaitVrtFonts(page);

      if (pinsNibbles) {
        // (2) PIN THE RNG — and it MUST land before the module is constructed,
        //     which is why it is here rather than after `spawnPatch`.
        //     `initialSeed()` reads this global inside the factory and falls
        //     back to `Date.now()`; that fallback is what made the pellet and
        //     the snake spawn somewhere new on every run.
        //
        // ⚠ THE POST-SPAWN PATH IS NOT AN ALTERNATIVE, and the difference is
        //     easy to miss: `maybeApplyVrtSeed()` does re-seed from this same
        //     global on a later frame, but it only assigns `state` — it does
        //     NOT repaint. With the clock frozen there is no tick to trigger
        //     `paintFrame()`, so the framebuffer would keep showing the
        //     ORIGINAL `Date.now()`-seeded first frame and the scene would
        //     still be nondeterministic. Setting it before spawn makes the
        //     constructor's own "paint a first frame" the pinned one.
        await page.evaluate(() => {
          (globalThis as unknown as { __nibblesVrtSeed?: number })
            .__nibblesVrtSeed = 0xC0DE;
        });
      }

      if (pair.gatedOnDoomWasm) {
        const present = await doomWasmPresent(page);
        test.skip(
          !present,
          'DOOM WASM not built — run `bash packages/web/native/build-doom-wasm.sh`',
        );
      }

      const sourceId   = `src-${pair.id}`;
      const consumerId = `cons-${pair.id}-scope`;

      await spawnPatch(
        page,
        [
          { id: sourceId,   type: pair.source.type, position: { x: 60,  y: 60 }, domain: 'video' },
          { id: consumerId, type: 'scope',          position: { x: 540, y: 60 }, domain: 'audio' },
        ],
        [
          {
            id: `e-${pair.id}-bridge`,
            from: { nodeId: sourceId,   portId: pair.source.portId },
            to:   { nodeId: consumerId, portId: 'ch1'              },
            sourceType: pair.kind,
            // scope.ch1 is declared as type:'audio' — the engine dispatcher
            // branches on sourceType not targetType, so this is fine + the
            // edge is accepted at canConnect time (audio inputs welcome
            // cv/gate sources by spec).
            targetType: 'audio',
          },
        ],
      );

      // Compose the visible-frame area: viewport region covering both
      // cards. We clip the page screenshot rather than a single
      // .svelte-flow__node — composite VRTs need BOTH cards in the same
      // frame for the BEFORE/AFTER diff to surface a regression.
      const compositeBounds = {
        x: 40, y: 40,
        width: 940,
        height: 540,
      };

      // ⚠ BY NODE ID, NOT NODE TYPE. xyflow tags a lane node with its NODE TYPE
      // and every lane node is `moduleShell`, so a per-module class matches
      // nothing (the mechanism `e2e/tests/ptzcam.spec.ts` records).
      await canvasNode(page, sourceId)
        .waitFor({ state: 'visible', timeout: 10_000 });
      await canvasNode(page, consumerId)
        .waitFor({ state: 'visible', timeout: 10_000 });

      // Engine + analyser settle.
      await resumeAudio(page);
      await page.waitForTimeout(500);

      // IDLE pose: source CSN at its construction-time offset (0 for gates,
      // lengthToCv(4) ≈ -0.93 for NIBBLES.length_cv). Suspend so the
      // analyser-driven SCOPE trace freezes on its last buffer for the
      // diff.
      await suspendAudio(page);
      await page.evaluate(
        () => new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
      );

      await expect(page).toHaveScreenshot(`composite-${pair.id}-idle.png`, {
        clip: compositeBounds,
        maskColor: '#ff00ff',
      });

      // ---- Drive the pair ----
      await resumeAudio(page);
      if (pair.kind === 'cv') {
        await expect.poll(
          async () => firePulse(page, sourceId, pair.driverPort, pair.value),
          { timeout: 5000 },
        ).toBe(true);
      } else {
        // Gate: HOLD the CSN HIGH so a post-suspend snapshot captures the
        // analyser at offset=1. A 10ms forcePulse() is gone by snapshot
        // time. forceHold cancels schedules + setValueAtTime(1) — sticky
        // until the next forcePulse / forceHold.
        await expect.poll(
          async () => forceHold(page, sourceId, pair.driverPort, true),
          { timeout: 5000 },
        ).toBe(true);
      }
      // Settle: CV linearRamp lands in 20ms, gate-hold is immediate;
      // SCOPE's 2048-sample analyser refills at ~43ms@48kHz — 250ms gives
      // it 5+ refill cycles to lock onto the new DC level.
      await page.waitForTimeout(250);

      // Snap the DRIVEN state — suspend audio so the analyser freezes on
      // a buffer FULL of the new DC level.
      await suspendAudio(page);
      await page.evaluate(
        () => new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
      );

      await expect(page).toHaveScreenshot(`composite-${pair.id}-driven.png`, {
        clip: compositeBounds,
        maskColor: '#ff00ff',
      });
    });
  }
});
