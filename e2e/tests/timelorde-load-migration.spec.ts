// e2e/tests/timelorde-load-migration.spec.ts
//
// THE LOAD-STALENESS FIX FOR THE TRANSPORT (fleet audit 2026-09-06, finding 7).
//
// v1 TIMELORDE patches saved `isPlaying`; v2 split it into muteOutputs +
// running. The v1→v2 migration ran ONLY at spawn — and a v1 patch loaded over
// a live TIMELORDE at a REUSED id re-runs no factory (loadEnvelopeIntoStore
// deletes + re-inserts in one transaction; same id + type → the reconciler
// only diffs the param keys the loaded patch carries, and a v1 patch carries
// neither v2 key). So the PREVIOUS session's mute/run state silently stayed in
// force over the loaded patch's, on the module every sequencer in the rack
// rides. The fix is a scheduler-tick migration watch in the factory
// (syncLegacyTransportMigration, timelorde.ts) that converts a legacy-shaped
// LIVE node once per legacy load and write-throughs the v2 pair to the store.
//
// What a unit test cannot see is the REAL load route end-to-end (persistence
// envelope → store swap → reconciler → migration watch → worklet) and the
// jacks themselves — so every leg here asserts BOTH the named engine state and
// the 1x output's actual pulses (presence AND liveness; modules have shipped
// green-and-silent on param-only assertions).
//
// ── The pulse instrument ─────────────────────────────────────────────────
// A tiny e2e-only AudioWorkletProcessor (blob URL) taps TIMELORDE's 1x output
// and posts the AUDIO-CLOCK time of every rising edge, computed per-sample ON
// THE AUDIO THREAD. Per-sample compare in a worklet is the edge-detection form
// that is correct by construction (AGENTS.md boundary 7 — the main-thread
// analyser-rescan trap does not exist here), and the stamps are immune to
// main-thread stalls: a busy load can DELAY delivery but never lose or shift a
// stamp. That is what lets the continuity leg assert the pulse grid to tight
// tolerances ACROSS the load itself.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const TL = 'tl';
const BPM = 120; // 1x period = 0.5 s
const PERIOD_S = 60 / BPM;

/** What the ENGINE thinks the transport state is — read('transportState') off
 *  the live handle (the shared four-state derivation; see
 *  timelorde-transport-state.spec.ts). */
async function engineState(page: Page): Promise<unknown> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read?: (node: { id: string; domain: string }, key: string) => unknown;
      } | undefined;
      __patch?: { nodes: Record<string, { id: string; domain: string } | undefined> };
    };
    const engine = w.__engine?.();
    const node = w.__patch?.nodes[id];
    if (!engine?.read || !node) return null;
    return engine.read(node, 'transportState') ?? null;
  }, TL);
}

async function spawnClock(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: TL, type: 'timelorde', position: { x: 200, y: 80 }, domain: 'audio', params: { bpm: BPM } }],
    [],
  );
}

/**
 * Attach the audio-thread edge-stamp probe to TIMELORDE's 1x jack and TAG the
 * engine handle so a later leg can prove the node was NOT re-materialized by
 * the load (re-materialization is the one mechanism that could reset the
 * clock's phase; the migration itself only writes k-rate params, and only on
 * actual change — pinned in timelorde.test.ts).
 *
 * Waits for the PORT to resolve first: a worklet-backed module's AudioNode
 * only exists after its addModule settles (the stereo-mono-normal lesson —
 * probing on the frame after spawnPatch reads null and prints as a broken
 * module).
 */
async function installPulseProbe(page: Page): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain(d: string): {
            getOutputNode(nodeId: string, portId: string): { node: AudioNode; output: number } | null;
          };
        };
      };
      try {
        return !!w.__engine?.().getDomain('audio').getOutputNode(id, '1x');
      } catch {
        return false;
      }
    },
    TL,
    { timeout: 15_000 },
  );

  await page.evaluate(async (id) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain(d: string): {
          nodes: Map<string, Record<string, unknown>>;
          getOutputNode(nodeId: string, portId: string): { node: AudioNode; output: number } | null;
        };
      };
      __tlProbe?: { stamps: number[]; now: () => number };
    };
    const audio = w.__engine().getDomain('audio');
    const ref = audio.getOutputNode(id, '1x');
    if (!ref) throw new Error('1x port has no audio node');
    const ctx = ref.node.context as AudioContext;

    // Per-sample rising-edge stamper, on the audio thread. `currentTime` and
    // `sampleRate` are AudioWorkletGlobalScope globals; the posted stamp is
    // the edge's own audio-clock time, so main-thread stalls can delay
    // DELIVERY but never move a stamp.
    const code = `registerProcessor('e2e-edge-stamp', class extends AudioWorkletProcessor {
      constructor() { super(); this.prev = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) for (let i = 0; i < ch.length; i++) {
          const v = ch[i];
          if (this.prev < 0.5 && v >= 0.5) this.port.postMessage(currentTime + i / sampleRate);
          this.prev = v;
        }
        return true;
      }
    });`;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const probe = new AudioWorkletNode(ctx, 'e2e-edge-stamp', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const stamps: number[] = [];
    probe.port.onmessage = (e: MessageEvent) => stamps.push(e.data as number);
    ref.node.connect(probe, ref.output, 0);
    // Keep the probe pulled by the rendering graph, inaudibly.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    probe.connect(mute);
    mute.connect(ctx.destination);

    // Identity tag for the no-re-materialization proof.
    const handle = audio.nodes.get(id);
    if (!handle) throw new Error('no engine handle for timelorde');
    handle.__e2eProbeTag = 'pre-load';

    w.__tlProbe = { stamps, now: () => ctx.currentTime };
  }, TL);
}

/** One round trip: the accumulated stamps + the audio clock now. The stamps
 *  accumulate IN the page (worklet → onmessage); this only reads. */
async function readProbe(page: Page): Promise<{ stamps: number[]; now: number }> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __tlProbe: { stamps: number[]; now: () => number } };
    return { stamps: [...w.__tlProbe.stamps], now: w.__tlProbe.now() };
  });
}

async function probeTagIntact(page: Page): Promise<boolean> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain(d: string): { nodes: Map<string, Record<string, unknown>> } };
    };
    return w.__engine().getDomain('audio').nodes.get(id)?.__e2eProbeTag === 'pre-load';
  }, TL);
}

/**
 * Capture a V1-SHAPED envelope of the current rack: flip the TIMELORDE node's
 * params to the legacy shape (`isPlaying`, NO v2 keys), save, and put the live
 * shape back — all inside ONE synchronous evaluate, so the factory's
 * scheduler-tick migration watch (an interval callback) can never observe the
 * transient legacy shape on the LIVE store. This is exactly how real v1
 * envelopes look: legacy-shaped at rest in the file, never in a live v2 rack.
 */
async function saveV1Envelope(page: Page, isPlaying: 0 | 1): Promise<unknown> {
  return page.evaluate(
    ({ id, playing }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number | undefined> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
        __persistence: { save: () => unknown };
      };
      const params = w.__patch.nodes[id]!.params;
      const hadMute = params.muteOutputs;
      const hadRunning = params.running;
      w.__ydoc.transact(() => {
        delete params.muteOutputs;
        delete params.running;
        params.isPlaying = playing;
      });
      const env = w.__persistence.save();
      w.__ydoc.transact(() => {
        delete params.isPlaying;
        if (hadMute !== undefined) params.muteOutputs = hadMute;
        if (hadRunning !== undefined) params.running = hadRunning;
      });
      return env;
    },
    { id: TL, playing: isPlaying },
  );
}

/** Same-session load at the REUSED id — the exact route the bug lived on.
 *  Returns the audio-clock time just before the store swap. */
async function loadEnvelope(page: Page, env: unknown): Promise<number> {
  return page.evaluate((e) => {
    const w = globalThis as unknown as {
      __persistence: { load: (env: unknown) => unknown };
      __tlProbe: { now: () => number };
    };
    const t = w.__tlProbe.now();
    w.__persistence.load(e);
    return t;
  }, env);
}

/** Set a param through the store (the UI's write path — the reconciler pushes
 *  it to the engine). */
async function setParam(page: Page, key: string, value: number): Promise<void> {
  await page.evaluate(
    ({ id, k, v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const target = w.__patch.nodes[id];
        if (target) target.params[k] = v;
      });
    },
    { id: TL, k: key, v: value },
  );
}

/** In-page timed capture window (the stereo-mono-normal `measure` shape): the
 *  wait lives in the page as a measurement DURATION, not a readiness delay —
 *  readiness is always polled on observable state first. */
async function captureWindow(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);
}

/** Poll until at least `n` stamps sit after audio-time `t`. */
async function waitForStampsAfter(page: Page, t: number, n: number, message: string): Promise<void> {
  await expect
    .poll(async () => (await readProbe(page)).stamps.filter((s) => s > t).length, {
      timeout: 10_000,
      message,
    })
    .toBeGreaterThanOrEqual(n);
}

test.describe('TIMELORDE v1 patch loaded over a live clock (reused id)', () => {
  test('un-mute direction: a v1 PLAYING patch loaded over a MUTED clock un-mutes it — and the gates fire', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await spawnClock(page);
    await installPulseProbe(page);

    // The envelope FIRST, from the pristine rack: v1, playing.
    const envPlaying = await saveV1Envelope(page, 1);

    // Live state: MUTED (the state the loaded patch must override).
    await setParam(page, 'muteOutputs', 1);
    await expect.poll(() => engineState(page), { timeout: 5000 }).toBe('muted');
    // Liveness of the negative side: muted gates go silent at the jack.
    const preLoad = await readProbe(page);
    await captureWindow(page, 3 * PERIOD_S * 1000);
    const muted = await readProbe(page);
    expect(
      muted.stamps.filter((s) => s > preLoad.now + 0.3).length,
      'muted gates must be SILENT before the load (else the un-mute assertion below proves nothing)',
    ).toBe(0);

    // THE LOAD. Same session, reused id — no factory re-run.
    const loadT = await loadEnvelope(page, envPlaying);

    // The LOADED patch's state wins: v1 isPlaying=1 → gates live, clock
    // running (the same conversion a fresh boot of that patch applies).
    await expect.poll(() => engineState(page), { timeout: 5000 }).toBe('running');
    // …and the jack agrees (liveness, not just params).
    await waitForStampsAfter(page, loadT, 2, 'the un-muted 1x jack must actually pulse after the load');

    expect(errors).toEqual([]);
  });

  test('mute direction: a v1 STOPPED patch loaded over a PLAYING clock mutes it — gates silent, clock still turning', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await spawnClock(page);
    await installPulseProbe(page);
    const envStopped = await saveV1Envelope(page, 0);

    // POSITIVE control: the live clock is audibly pulsing before the load.
    const t0 = await readProbe(page);
    await waitForStampsAfter(page, t0.now, 2, 'the live clock must pulse before the load');

    const loadT = await loadEnvelope(page, envStopped);

    // v1 "stopped" maps to v2 MUTED (gates silent, clock alive for LIVECODE) —
    // NOT to a transport halt. The named state is the only place the two are
    // distinguishable; assert it exactly.
    await expect.poll(() => engineState(page), { timeout: 5000 }).toBe('muted');

    // The jack goes silent: after a short apply margin (the migration fires on
    // the next scheduler tick; one in-flight pulse may straddle the load), NO
    // further stamps arrive across a 4-period window.
    const settleT = loadT + 2 * PERIOD_S;
    await captureWindow(page, 6 * PERIOD_S * 1000);
    const after = await readProbe(page);
    expect(
      after.stamps.filter((s) => s > settleT).length,
      'a muted transport must stop pulsing at the jacks',
    ).toBe(0);
    expect(after.now, 'the capture window must actually cover the settle point').toBeGreaterThan(
      settleT + 3 * PERIOD_S,
    );

    expect(errors).toEqual([]);
  });

  test('run direction: a v1 PLAYING patch loaded over a STOPPED clock resumes it (fresh-boot equivalence)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await spawnClock(page);
    await installPulseProbe(page);
    const envPlaying = await saveV1Envelope(page, 1);

    // Live state: transport HALTED (running=0 — a real stop, phase frozen).
    await setParam(page, 'running', 0);
    await expect.poll(() => engineState(page), { timeout: 5000 }).toBe('stopped');

    const loadT = await loadEnvelope(page, envPlaying);

    // A fresh boot of a v1 patch runs (running defaults to 1); the same patch
    // loaded same-session must land in the same state — that is the whole
    // staleness class under test.
    await expect.poll(() => engineState(page), { timeout: 5000 }).toBe('running');
    await waitForStampsAfter(page, loadT, 2, 'the resumed 1x jack must actually pulse after the load');

    expect(errors).toEqual([]);
  });

  test('TRANSPORT CONTINUITY: a same-state v1 load neither halts, resets, nor re-materializes the clock', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await spawnClock(page);
    await installPulseProbe(page);
    // v1, playing — migrates to exactly the state the live clock is already
    // in, so the migration must write NOTHING to the AudioParams (pinned at
    // the unit level too) and the pulse grid must sail through the load.
    const envPlaying = await saveV1Envelope(page, 1);

    // Collect a pre-load baseline of ≥3 pulses.
    const t0 = await readProbe(page);
    await waitForStampsAfter(page, t0.now, 3, 'pre-load pulse baseline');

    const loadT = await loadEnvelope(page, envPlaying);

    // Let the clock run well past the load…
    await waitForStampsAfter(page, loadT + PERIOD_S, 3, 'post-load pulses must keep arriving');

    const { stamps } = await readProbe(page);

    // …the load moment is INSIDE the capture (else this proves nothing)…
    expect(Math.min(...stamps), 'capture must start before the load').toBeLessThan(loadT);
    expect(Math.max(...stamps), 'capture must extend past the load').toBeGreaterThan(loadT + PERIOD_S);

    // …the clock kept advancing MONOTONICALLY on its own grid: every
    // consecutive inter-pulse gap — including the pair that BRACKETS the load
    // — stays a period. Stamps are sample-accurate audio-thread times, so the
    // tolerance is real slack, not measurement noise: a halt, a thrash, or a
    // phase reset ≥ 100 ms across the load lands outside it.
    const gaps = stamps.slice(1).map((s, i) => s - stamps[i]!);
    for (const [i, g] of gaps.entries()) {
      expect(
        g,
        `inter-pulse gap ${i} (${stamps[i]!.toFixed(3)} → ${stamps[i + 1]!.toFixed(3)}, load at ${loadT.toFixed(3)})`,
      ).toBeGreaterThan(PERIOD_S - 0.1);
      expect(g).toBeLessThan(PERIOD_S + 0.1);
    }

    // …the engine handle is the SAME object the probe tagged before the load:
    // the reconciler did not re-materialize the node, which is the one
    // mechanism that could restart the worklet's phase from zero.
    expect(await probeTagIntact(page), 'the load must not re-materialize the transport').toBe(true);

    // …and the named state never left 'running'.
    expect(await engineState(page)).toBe('running');

    expect(errors).toEqual([]);
  });
});
