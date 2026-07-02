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
// Per the cross-platform protocol used by sibling VRT specs, only darwin
// baselines are captured here; linux baselines are skipped (deferred via
// EXEMPT_BASELINE_PAIRS-style runtime skip) until a `task vrt:update` run
// on linux CI ships them. NIBBLES rasterises on the CPU so its frames are
// platform-agnostic; DOOM is gated on the WASM asset (skip-clean when
// missing).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

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
      // Linux baselines deferred — these scenes mix CPU-rasterised NIBBLES
      // / DOOM cards with the consumer card's analyser-driven canvas, and
      // the analyser slice's exact pixel values can drift sub-thresholdly
      // across the AudioContext sine-table + Float32 path per platform.
      // darwin captured here; linux pending a `task vrt:update` run on
      // linux CI.
      test.skip(
        VRT_PLATFORM === 'linux',
        `${pair.id} on linux: composite baseline pending (capture on linux CI)`,
      );

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

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

      await page.locator(`.svelte-flow__node-${pair.source.type}`).first()
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('.svelte-flow__node-scope').first()
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
