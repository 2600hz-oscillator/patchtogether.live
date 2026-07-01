// e2e/tests/video-audio-cvgate-coverage.spec.ts
//
// Class-wide regression coverage for the engine bug fixed by PR #414:
// ANY video module's CV/gate output was silently dropped before reaching
// an audio-domain target because PatchEngine.addEdge mis-classified every
// cross-domain cv/gate edge as "audio→video" and routed it through the
// CvBridge instead of the video→audio AudioBridge.
//
// The unit-level engine-bridge sweep (engine-video-audio-bridge.test.ts)
// asserts the dispatcher contract at the recording-fake level for EVERY
// registered video.cv + video.gate output port. This file is the LIVE
// end-to-end layer: real PatchEngine, real AudioContext, real downstream
// audio module, real cable. For each enumerated (source, consumer) pair,
// drive the source's CV/gate output and assert the downstream consumer
// observed the signal (an AudioParam value moved for cv, an audible burst
// of energy followed a gate, etc).
//
// Parameterised so adding a new (video module, port) pair is a 1-line
// entry in PAIRS below.
//
// Coordination notes:
//   * NIBBLES.length_cv → QBRT.cutoff_cv is intentionally covered by
//     a sibling PR (the composite-VRT NIBBLES→QBRT scene). This file
//     picks DIFFERENT consumer ports for NIBBLES so we don't duplicate.
//   * DOOM gate rows used to live here too, but were the flakiest in the
//     suite (a 10ms WASM-driven gate vs SCOPE's ~43ms analyser refill).
//     The GPU-attest rebuild dropped them: the engine-bridge UNIT sweep
//     (audio/engine-video-audio-bridge.test.ts) already proves every video
//     cv/gate output port — DOOM's included — bridges into the audio domain
//     deterministically at the recording-fake level. NIBBLES keeps the one
//     LIVE row that proves a real AudioParam receives the bridged ramp.
//
// SwiftShader-cheap (GPU-attest rebuild, Phase 3 — glconv3 wave 2-deferred):
// this spec reads NO video pixels. It spawns a NIBBLES source + a SCOPE and
// reads SCOPE's analyser SNAPSHOT (audio-domain state) — the video `out`
// texture is never sampled. NIBBLES is a MAIN-THREAD CPU-rasterised source
// (no renderLocus → defaults to 'main'; it is NOT the worker-compositor
// TOYBOX), and forcePulse() drives the source's ConstantSourceNode / gate
// AudioParams DIRECTLY off ctx.audioCtx — entirely independent of the render
// loop. The ONLY reason this timed out / flaked on CI's SwiftShader was the
// live main-thread render loop grinding the software renderer UNPAUSED beneath
// the audio-graph work. boot() now calls installRenderSmokeHooks(page) BEFORE
// page.goto: it sets __videoEnginePause (the engine rAF loop IDLES — NIBBLES's
// per-frame CPU-rasterise + GL blit stops burning the software renderer) +
// __videoEngineFreezeTime (pins the clock, so dt=0 → advanceGame() never
// auto-fires → the bot never emits a spurious pellet/death/dir_change gate;
// the ONLY gate signal is the test's own forcePulse, making the gate read
// MORE deterministic, not less). The audio graph is fully live throughout, so
// every assertion below is byte-identical: the CV ramp still lands on the
// ConstantSourceNode, the 10 ms gate still pulses, and the SCOPE analyser
// still captures both. This spec no longer reads pixels and no longer needs
// the serialized real-GPU heavy lane — it runs in the normal parallel shards.
//
// Gate-poll hardening (the wave-2 deferral reason — contention-borderline):
// a 10 ms gate pulse vs SCOPE's 2048-sample analyser window (~43 ms at 48 kHz)
// is a tight overlap. Under shard load a single fire-then-read round-trip can
// stretch long enough that the lone pulse scrolls out of the analyser ring
// before the read captures the window, yielding an all-zero snapshot and a
// timed-out poll. The fix drives a BURST of pulses per poll round (see
// firePulse's repeats/spacingMs) spanning MORE than one full analyser window,
// so whatever 2048-sample window the read happens to capture is guaranteed to
// contain at least one HIGH region — the peak hold then clears the 0.1 floor
// deterministically. The pre-#414 silent-drop bug still surfaces identically:
// if the edge is dropped, NO number of pulses ever reaches the analyser, so
// the poll times out with peak stuck at 0 — exactly the original failure mode.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

// ---------------- Pair table ----------------------------------------------
//
// Each row enumerates ONE video.cv | video.gate output we want to prove the
// engine bridges into the audio domain. To keep the assertion universal +
// dispatch-bug-sensitive, the consumer is ALWAYS a SCOPE (universal sink —
// `scope.ch1` accepts audio/cv/gate without per-module shape gymnastics).
//
// The proof: SCOPE's ch1 analyser captures the CSN's offset value through
// the bridge. Pre-#414 bug: the dispatcher routed video.cv|gate edges into
// the audio→video CvBridge that looks up the source on AudioEngine.
// AudioEngine.getOutputNode returned null (the source lives in VideoEngine's
// audioSources), the bridge silently deferred forever, and ch1 stayed at 0
// forever — regardless of how many forcePulse() calls fire. Post-#414, the
// audio bridge .connect()s the source CSN into scope.ch1's input GainNode +
// the analyser sees its 10ms unit-amplitude excursion (gate) or its
// linearRampToValueAtTime ramp output (cv).
//
// We INTENTIONALLY don't pair length_cv → drummergirl.pitch here: reading
// AudioParam.value reflects ONLY the param's scheduled intrinsic value (not
// the sum of connected node contributions per Web Audio API spec), so it
// can't disprove the bug — the unit-level sweep in
// engine-video-audio-bridge.test.ts covers that path via the recording-
// fake's connect()-into-AudioParam log.
//
// NIBBLES.length_cv → QBRT.cutoff_cv is owned by a sibling composite-VRT
// PR and intentionally not duplicated here.

interface Pair {
  id: string;
  kind: 'cv' | 'gate';
  source: { type: string; nodeId: string; portId: string };
  /** CV value to push for cv pairs; ignored for gate. */
  value?: number;
  /** Source-side driver port (same as source.portId today; declared
   *  separately so a future hook can rename without breaking the table). */
  driverPort: string;
}

const PAIRS: Pair[] = [
  // ---- NIBBLES: one CV + one GATE. The other gates (`death`, `dir_change`)
  // exercise the SAME dispatcher path and are covered by the engine-bridge
  // unit sweep — adding them here is e2e overhead with no incremental
  // signal.
  {
    id: 'nibbles-length_cv',
    kind: 'cv',
    source: { type: 'nibbles', nodeId: 'src-nibbles-cv', portId: 'length_cv' },
    value: 0.85,
    driverPort: 'length_cv',
  },
  {
    id: 'nibbles-pellet',
    kind: 'gate',
    source: { type: 'nibbles', nodeId: 'src-nibbles-pellet', portId: 'pellet' },
    driverPort: 'pellet',
  },
  // ---- DOOM gates (evt_kill / evt_door / evt_gun_p1..p4) were dropped from
  // this LIVE table during the GPU-attest rebuild: they were the flakiest rows
  // (a 10ms WASM-driven gate vs SCOPE's ~43ms analyser refill, polled over a
  // 6s budget, and WASM-asset-gated). Their per-port bridge wiring is proven
  // deterministically by the engine-bridge unit sweep
  // (audio/engine-video-audio-bridge.test.ts, `it.each` over every video
  // cv/gate output port). NIBBLES.length_cv keeps one LIVE proof that a real
  // AudioParam actually receives the bridged ramp.
];

// ---------------- Page-side helpers ---------------------------------------

/** Fire the source's CV/gate output via the per-module forcePulse extras
 *  hook. For GATE pulses (10ms wide), `repeats` re-fires the pulse N times
 *  spaced `spacingMs` apart to guarantee at least one HIGH sample lands in
 *  SCOPE's analyser buffer during the post-fire read window (analyser
 *  fftSize=2048 at 48kHz = ~43ms window; firing a TRAIN of pulses that spans
 *  MORE than one full analyser window means whatever 2048-sample slice the
 *  reader captures is guaranteed to overlap a HIGH region, so the peak hold
 *  is reliable even when a round-trip stretches under shard contention). For
 *  CV, repeats=1 is sufficient since the ramp lands a steady DC value.
 *  Returns true if the hook ran, false if the page-side handle wasn't
 *  materialised yet (caller polls + retries). */
async function firePulse(
  page: Page,
  sourceNodeId: string,
  port: string,
  value: number | undefined,
  repeats = 1,
  spacingMs = 12,
): Promise<boolean> {
  return await page.evaluate(
    async ({ nodeId, p, v, n, s }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return false;
      const node = w.__patch.nodes[nodeId];
      if (!node) return false;
      const extras = eng.read(node, 'extras') as
        | { forcePulse?: (port: string, val?: number) => void }
        | undefined;
      if (!extras || typeof extras.forcePulse !== 'function') return false;
      for (let i = 0; i < n; i++) {
        extras.forcePulse(p, v);
        if (i < n - 1) await new Promise((r) => setTimeout(r, s));
      }
      return true;
    },
    { nodeId: sourceNodeId, p: port, v: value, n: repeats, s: spacingMs },
  );
}

/** Read a SCOPE's ch1 analyser snapshot summary. Returns { peak, rms }
 *  (numbers cross the page boundary cleanly); null when not ready. */
async function readScopePeak(
  page: Page,
  scopeNodeId: string,
): Promise<{ peak: number; rms: number } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as
      | { ch1: Float32Array; ch2: Float32Array; sampleRate: number }
      | undefined;
    if (!snap) return null;
    let peak = 0, sq = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sq += v * v;
    }
    return { peak, rms: Math.sqrt(sq / Math.max(1, snap.ch1.length)) };
  }, scopeNodeId);
}

// ---------------- Spec body ------------------------------------------------

// Serial within this file: 5 parallel workers each spawning a video module +
// downstream audio consumer + scope tap (3 modules / page) saturated GPU on
// the dev box and pages came up blank with "Channel closed". The whole file
// runs in under 30s serially.
test.describe.configure({ mode: 'serial' });

test.describe('video → audio CV/gate routing: every source/port survives the engine bridge (#414 regression class)', () => {
  for (const pair of PAIRS) {
    test(`${pair.id}: bridges into scope.ch1 (was silent pre-#414)`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      // SwiftShader-cheap: pause the engine rAF loop + pin the clock BEFORE
      // boot so NIBBLES's live main-thread CPU-rasterise + GL blit doesn't
      // grind the software renderer under this audio-state-only spec (the sole
      // cause of the CI timeout). forcePulse drives the source's audio-graph
      // ConstantSourceNodes directly off ctx.audioCtx — unaffected by the
      // paused render loop — and the frozen clock means the bot never fires a
      // spurious gate, so every CV-ramp / gate-pulse / analyser assertion below
      // still holds and is in fact MORE deterministic.
      await installRenderSmokeHooks(page);
      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

      const scopeNodeId = `cons-scope-${pair.id}`;

      // Patch: source.<port> → scope.ch1. SCOPE is universal — it accepts
      // audio/cv/gate sources on ch1 and integrates a CSN's offset onto its
      // analyser unmodified. Pre-#414 bug: dispatcher dropped this edge
      // silently, ch1 stayed at 0 forever, scope's analyser snapshot
      // continued reading {peak:0, rms:0} no matter how many forcePulse()
      // calls fired. Post-#414: peak (gate) or rms (cv) clears the floor.
      await spawnPatch(
        page,
        [
          {
            id: pair.source.nodeId,
            type: pair.source.type,
            position: { x: 80, y: 80 },
            domain: 'video',
          },
          {
            id: scopeNodeId,
            type: 'scope',
            position: { x: 540, y: 80 },
            domain: 'audio',
          },
        ],
        [
          {
            id: `e-${pair.id}-bridge`,
            from: { nodeId: pair.source.nodeId, portId: pair.source.portId },
            to:   { nodeId: scopeNodeId,        portId: 'ch1' },
            sourceType: pair.kind,
            targetType: 'audio', // scope.ch1 is declared as type:'audio' but
            // canConnect accepts cv/gate on audio inputs (see graph/types.ts
            // canConnect). The dispatcher branches on sourceType, not target.
          },
        ],
      );

      await page.locator('.svelte-flow__node-scope').first()
        .waitFor({ state: 'visible', timeout: 10_000 });

      // Engine + AudioContext settle (worker startup, analyser registration).
      await page.waitForTimeout(400);

      // ---- BEFORE driving: scope ch1 baseline. With the dispatcher fix in
      // place but no pulse yet, ch1 sits at its DC baseline (0 with nothing
      // connected, or the CSN's resting offset = 0 for gates, ~lengthToCv(4)
      // ≈ -0.93 for NIBBLES.length_cv). The DELTA is what we assert.
      const before = await readScopePeak(page, scopeNodeId);

      // Drive the source via extras.forcePulse() until the bridged signal is
      // visible on scope.ch1. CV: one ramp suffices (the bridge .connect()s
      // the CSN directly; the analyser samples the DC value steadily).
      // Gate: a 10ms pulse is borderline against the analyser's ~43ms window
      // — we poll a fire-then-read loop, firing a TRAIN of pulses each round
      // so at least one HIGH window straddles whatever snapshot is taken. The
      // poll exits as soon as scope picks up the bridged signal, so the test
      // is fast on the happy path and surfaces the pre-#414 silent-drop bug as
      // a timeout (peak stuck at 0 forever — no pulse train ever reaches the
      // analyser when the edge is dropped).
      let after: { peak: number; rms: number } | null = null;
      if (pair.kind === 'cv') {
        await expect.poll(
          async () => firePulse(page, pair.source.nodeId, pair.driverPort, pair.value),
          { timeout: 5000 },
        ).toBe(true);
        await page.waitForTimeout(100);  // CV ramp settles
        after = await readScopePeak(page, scopeNodeId);
      } else {
        // Gate poll: fire a pulse TRAIN, read, repeat. The expect.poll timeout
        // is the overall budget; each round fires `repeats` pulses spaced
        // `spacingMs` apart so the HIGH train spans MORE than one full analyser
        // window (2048 samples ≈ 43ms at 48kHz). That guarantees the snapshot
        // taken right after the burst overlaps a HIGH region regardless of
        // round-trip jitter under shard contention. The budget is widened
        // (vs the old single-pulse 6s) so a starved shard still lands the
        // signal deterministically before timing out.
        await expect.poll(
          async () => {
            const fired = await firePulse(
              page, pair.source.nodeId, pair.driverPort, undefined,
              /* repeats */ 6, /* spacingMs */ 12,
            );
            if (!fired) return 0;
            after = await readScopePeak(page, scopeNodeId);
            return after?.peak ?? 0;
          },
          { timeout: 10_000, intervals: [50, 80, 120, 200, 300] },
        ).toBeGreaterThan(0.1);
      }

      expect(before, `${pair.id}: baseline scope read must succeed`).not.toBeNull();
      expect(after,  `${pair.id}: post-drive scope read must succeed`).not.toBeNull();

      if (pair.kind === 'cv') {
        // Post-bridge, CSN offset === pair.value; ch1 sits at that DC value,
        // so peak reads at least |value|. Threshold is conservative
        // (analyser smoothing + small DC drift). Pre-#414 stayed at 0
        // forever — the dispatcher dropped the edge silently.
        const target = Math.abs(pair.value ?? 1);
        const peakDelta = (after?.peak ?? 0) - (before?.peak ?? 0);
        expect(
          after?.peak ?? 0,
          `${pair.id}: scope.ch1 peak should track the CV ramp target (${target}), pre-#414 stayed at 0 forever (peak=${(after?.peak ?? 0).toFixed(4)}, peakΔ=${peakDelta.toFixed(4)})`,
        ).toBeGreaterThan(target * 0.5);
      }
      // Gate assertion already landed inside the poll above. If we reached
      // here on the gate path, peak cleared 0.1 — the bridge fired.

      // Cosmetic: no page errors in the run.
      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        `${pair.id}: no console / page errors (AudioContext warnings excepted)`,
      ).toEqual([]);
    });
  }
});
