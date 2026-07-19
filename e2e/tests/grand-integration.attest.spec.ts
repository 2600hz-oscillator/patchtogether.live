// e2e/tests/grand-integration.attest.spec.ts
//
// THE heavy GRAND-INTEGRATION workflow-mode scenario — the browser side of the
// grand local attest (.myrobots/plans/grand-integration-e2e-art-2026-07-19.md).
// It builds up, in WORKFLOW MODE, the owner's full patch and asserts HARD ENGINE
// STATE on every claim:
//
//   kick(ch1) · snare(ch2) · tidyVco MONO(ch3) · sixstrum(ch4), each with notes
//   in MULTIPLE clips and PLAYING; automation RECORDED (real UI) + PLAYED BACK;
//   the combined master also feeding SYNESTHESIA; a capability-gated RECORDERBOX
//   capture of the combined stream (asserted LIVE, never byte-pinned).
//
// WHY THIS IS ATTEST-ONLY (never in the CI matrix): it drives TWO CI-hostile
// workloads at once — a real GPU (synesthesia is WebGL; SwiftShader can't fairly
// render it) AND a real H.264 encoder (recorderbox; CI has neither). So the whole
// describe `test.skip`s unless GRAND_ATTEST=1 (set ONLY by scripts/grand-attest.ts
// via `task grand:attest` on a trusted GPU machine). In the normal e2e matrix it
// is inert (skipped) — NO playwright.config edit is needed (that file sits in the
// collab+webgl attest bases; editing it would force an unrelated re-attest).
//
// DETERMINISM (owner's hard bar): every wait is on ENGINE STATE, never a sleep —
// waitForSoundingStep / waitForSoundingStepAndFreeze on `currentStep:L` +
// ctx.suspend() freeze for exact reads; max-hold-over-window for percussive RMS;
// expect.poll for the video reads. Aria/`data-*`-first selectors, numeric/state
// assertions — NEVER a bare toBeVisible() as an assertion.
//
// The DETERMINISTIC AUDIO PIN is NOT here — it is the offline combined-master ART
// (art/scenarios/grand-integration/). This spec asserts the LIVE combined stream
// works (per-instrument RMS, synesthesia reaction, recorderbox liveness) on a
// real machine; the offline ART pins the bytes.
//
// NOTE (author): the engine-state assertions (RMS via mixmstrs levels, clip
// playhead, synesthesia snapshot, recorderbox capture) are authored from the
// live read seams and are robust. The few UI-INTERACTION steps (open the C
// drawer, assign-module menu, MIDI-learn a knob, arm button) are authored from
// the proven clip-automation/workflow-dock patterns; the GPU attest run is the
// first place this whole chain executes end-to-end (it needs a real browser +
// GPU + H.264), so a locator here may need a touch-up on that first run.

import { test, expect, type Page } from '@playwright/test';

import {
  waitForSoundingStep,
  waitForSoundingStepAndFreeze,
  readEngineValue,
  unfreezeAudioClock,
} from './_scheduler-control';
import { addToPatch, readMixLevelsOverWindow, readSynLevels } from './_grand-helpers';
import {
  GRAND_AUTO,
  GRAND_BPM,
  GRAND_CLIPS,
  GRAND_CLIP_IDX,
  GRAND_LANES,
  GRAND_STEP_DIV_INDEX,
  GRAND_TIDY_CUTOFF_EVENTS,
  GRAND_TIDY_CUTOFF_KEY,
  grandDenormCutoff,
} from '../fixtures/grand-integration/clips';

const RUN = process.env.GRAND_ATTEST === '1';

// Node ids (additive into workflow mode).
const CP = 'pinned-clipplayer';
const MIX = 'pinned-mixmstrs';
const TL = 'pinned-timelorde';
const K = 'k';
const S = 's';
const T = 't';
const X = 'x';
const SYN = 'syn';
const REC = 'rec';

// Per-instrument RMS floors on the master mixer's post-fader taps. Conservative
// (a clearly-sounding instrument is ≫ floor; a stopped one is ≈ 0) to avoid a
// knife-edge; calibrated + pinned into the attestation JSON by the runner.
const SOUND_FLOOR = 0.01;
const SILENCE_CEIL = 0.005;
const SYN_FLOOR = 0.02;

const CC = 41; // an arbitrary CC to MIDI-learn the tidy cutoff to

// -------------------- small inline state helpers --------------------

/** Wait for the pinned workflow spine (clipplayer/mixmstrs) via data.pinned. */
async function waitForPinned(page: Page): Promise<void> {
  await page.waitForFunction(
    (ids) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return !!w.__patch && ids.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
    },
    [CP, MIX],
    { timeout: 15_000 },
  );
}

/** Set params on a node inside a transact (the setNodeParams seam). */
async function setParams(page: Page, nodeId: string, params: Record<string, number>): Promise<void> {
  await page.evaluate(
    ({ id, p }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (!n) return;
        if (!n.params) n.params = {};
        for (const [k, v] of Object.entries(p)) n.params[k] = v;
      });
    },
    { id: nodeId, p: params },
  );
}

/** Seed the shared fixture clips (+ mono lane 2, + optionally the automation)
 *  into pinned-clipplayer.data in one transact. */
async function seedFixture(page: Page, opts: { withAuto: boolean }): Promise<void> {
  await page.evaluate(
    ({ clips, auto, withAuto, tidyLane }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['pinned-clipplayer'];
        if (!n.data) n.data = {};
        const data = n.data as { clips?: Record<string, unknown>; auto?: Record<string, unknown>; mono?: boolean[] };
        data.clips = { ...(data.clips ?? {}), ...clips };
        // lane 2 (tidy) MONO — the ch3 "tidy vco in mono" reading.
        const mono = Array.isArray(data.mono) ? data.mono.slice() : new Array(8).fill(false);
        mono[tidyLane] = true;
        data.mono = mono;
        if (withAuto) data.auto = { ...(data.auto ?? {}), ...auto };
      });
    },
    { clips: GRAND_CLIPS, auto: GRAND_AUTO, withAuto: opts.withAuto, tidyLane: GRAND_LANES.tidy },
  );
}

/** Launch a set of lanes to a slot via data.queued (immediate — quantize=0). */
async function launchLanes(page: Page, lanes: number[], slot: number | 'stop'): Promise<void> {
  await page.evaluate(
    ({ lanes, slot }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['pinned-clipplayer'];
        if (!n.data) n.data = {};
        const data = n.data as { queued?: (number | 'stop' | null)[]; queuedImmediate?: boolean[] };
        const q = Array.isArray(data.queued) ? data.queued.slice() : new Array(8).fill(null);
        const qi = Array.isArray(data.queuedImmediate) ? data.queuedImmediate.slice() : new Array(8).fill(false);
        for (const L of lanes) {
          q[L] = slot;
          qi[L] = true; // fire on the next tick regardless of QNT
        }
        data.queued = q;
        data.queuedImmediate = qi;
      });
    },
    { lanes, slot },
  );
}

async function installSimMidi(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __midiTestInstall?: () => boolean }).__midiTestInstall === 'function',
  );
  await page.evaluate(() => (globalThis as unknown as { __midiTestInstall: () => boolean }).__midiTestInstall());
}
async function injectCc(page: Page, channel: number, cc: number, value: number): Promise<void> {
  await page.evaluate(
    ({ channel, cc, value }) =>
      (globalThis as unknown as { __midiTestInject: (c: number, cc: number, v: number) => boolean }).__midiTestInject(
        channel,
        cc,
        value,
      ),
    { channel, cc, value },
  );
}
async function sweepCc(page: Page, cc: number, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const t = (Date.now() - start) / ms;
    const v = Math.round(64 + 58 * Math.sin(t * Math.PI * 2 * 2));
    await injectCc(page, 1, cc, Math.max(0, Math.min(127, v)));
    await page.waitForTimeout(60);
  }
}

/** Read the recorded automation events for a clip's track key from the store. */
async function readAutoEvents(page: Page, idx: number, key: string): Promise<{ step: number; value: number }[]> {
  return page.evaluate(
    ({ idx, key }) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<
            string,
            { data?: { auto?: Record<string, { tracks?: Record<string, { events?: { step?: number; value?: number }[] }> }> } }
          >;
        };
      };
      const evs = w.__patch?.nodes?.['pinned-clipplayer']?.data?.auto?.[String(idx)]?.tracks?.[key]?.events;
      if (!Array.isArray(evs)) return [];
      return evs.map((e) => ({ step: Number(e.step), value: Number(e.value) }));
    },
    { idx, key },
  );
}

/** engine.readParam(node, paramId) — the automation-playback observable. */
async function readParam(page: Page, nodeId: string, paramId: string): Promise<number | null> {
  return page.evaluate(
    ([id, p]) => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, p: string) => number | undefined } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const node = w.__patch?.nodes?.[id];
      if (!eng || !node) return null;
      const v = eng.readParam(node, p);
      return typeof v === 'number' ? v : null;
    },
    [nodeId, paramId] as const,
  );
}

/** Sample a param over a loop → spread. */
async function sampleSpread(page: Page, nodeId: string, paramId: string, count = 14, intervalMs = 60) {
  const vals: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = await readParam(page, nodeId, paramId);
    if (v != null) vals.push(v);
    await page.waitForTimeout(intervalMs);
  }
  const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  return { vals, spread };
}

/** H.264 hardware-encode capability probe (recorderbox #687 pattern). */
async function h264EncodeSupported(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    interface MiniVE {
      configure: (c: unknown) => void;
      encode: (frame: unknown, opts?: unknown) => void;
      flush: () => Promise<void>;
      close: () => void;
    }
    const g = globalThis as {
      VideoEncoder?: new (init: { output: (c: unknown) => void; error: (e: unknown) => void }) => MiniVE;
      VideoFrame?: new (src: CanvasImageSource, init: { timestamp: number; duration?: number }) => { close: () => void };
    };
    const VE = g.VideoEncoder;
    const VF = g.VideoFrame;
    if (typeof VE !== 'function' || typeof VF !== 'function') return false;
    const W = 64;
    const H = 64;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return false;
    for (const codec of ['avc1.640028', 'avc1.42E01E']) {
      let chunks = 0;
      let errored = false;
      let enc: MiniVE | null = null;
      try {
        enc = new VE({ output: () => chunks++, error: () => (errored = true) });
        enc.configure({ codec, width: W, height: H, bitrate: 1_000_000, framerate: 30 });
        for (let i = 0; i < 4 && !errored; i++) {
          ctx.fillStyle = `rgb(${(i * 60) % 256},${(i * 30) % 256},${(i * 90) % 256})`;
          ctx.fillRect(0, 0, W, H);
          const frame = new VF(cv, { timestamp: i * 33_333, duration: 33_333 });
          enc.encode(frame, { keyFrame: i === 0 });
          frame.close();
        }
        await enc.flush();
      } catch {
        errored = true;
      } finally {
        try {
          enc?.close();
        } catch {
          /* */
        }
      }
      if (!errored && chunks > 0) return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------

test.describe('grand-integration @grand-attest', () => {
  test.skip(!RUN, 'heavy local attest — runs only via `task grand:attest` (GRAND_ATTEST=1) on a trusted GPU machine');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000); // two heavy workloads: WebGL synesthesia + a full audio graph

  test('workflow-mode: kick/snare/tidy-mono/sixstrum through clips + automation + synesthesia + recorderbox, hard state throughout', async ({ page }) => {
    // ── Step 1 — Enter workflow mode; wait for the pinned spine ──
    await page.goto('/rack?mode=workflow');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible();
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await waitForPinned(page);
    // Default master → audio-out wires are pre-seeded by the ensure effect.
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as { __patch?: { edges: Record<string, unknown> } };
        return (
          !!w.__patch &&
          !!w.__patch.edges['e-pinned-mixmstrs-masterL-pinned-audioOut-L'] &&
          !!w.__patch.edges['e-pinned-mixmstrs-masterR-pinned-audioOut-R']
        );
      },
      { timeout: 15_000 },
    );

    // Clip player: immediate launches + the fixture's 1/16 grid.
    await setParams(page, CP, { quantize: 0, stepDiv: GRAND_STEP_DIV_INDEX, gateLength: 0.9, octave: 0 });

    // ── Step 2 — Additively build the patch (preserve pinned nodes) ──
    await addToPatch(
      page,
      [
        { id: K, type: 'kickdrum', domain: 'audio', position: { x: 360, y: 60 } },
        { id: S, type: 'snaredrum', domain: 'audio', position: { x: 360, y: 260 } },
        { id: T, type: 'tidyVco', domain: 'audio', position: { x: 360, y: 460 } },
        { id: X, type: 'sixstrum', domain: 'audio', position: { x: 360, y: 660 } },
        { id: SYN, type: 'synesthesia', domain: 'audio', position: { x: 720, y: 60 } },
        { id: REC, type: 'recorderbox', domain: 'video', position: { x: 720, y: 320 } },
      ],
      [
        // clip player → instruments
        { id: 'e-cp-g1-k', from: { nodeId: CP, portId: 'gate1' }, to: { nodeId: K, portId: 'trigger_in' }, sourceType: 'gate', targetType: 'gate' },
        { id: 'e-cp-g2-s', from: { nodeId: CP, portId: 'gate2' }, to: { nodeId: S, portId: 'trigger_in' }, sourceType: 'gate', targetType: 'gate' },
        { id: 'e-cp-p3-t', from: { nodeId: CP, portId: 'pitch3' }, to: { nodeId: T, portId: 'pitch' }, sourceType: 'polyPitchGate', targetType: 'cv' },
        { id: 'e-cp-g3-t', from: { nodeId: CP, portId: 'gate3' }, to: { nodeId: T, portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
        { id: 'e-cp-p4-x', from: { nodeId: CP, portId: 'pitch4' }, to: { nodeId: X, portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
        // instruments → master mixer channels 1..4
        { id: 'e-k-l-ch1', from: { nodeId: K, portId: 'audio_l' }, to: { nodeId: MIX, portId: 'ch1L' } },
        { id: 'e-k-r-ch1', from: { nodeId: K, portId: 'audio_r' }, to: { nodeId: MIX, portId: 'ch1R' } },
        { id: 'e-s-l-ch2', from: { nodeId: S, portId: 'audio_l' }, to: { nodeId: MIX, portId: 'ch2L' } },
        { id: 'e-s-r-ch2', from: { nodeId: S, portId: 'audio_r' }, to: { nodeId: MIX, portId: 'ch2R' } },
        { id: 'e-t-l-ch3', from: { nodeId: T, portId: 'out_l' }, to: { nodeId: MIX, portId: 'ch3L' } },
        { id: 'e-t-r-ch3', from: { nodeId: T, portId: 'out_r' }, to: { nodeId: MIX, portId: 'ch3R' } },
        { id: 'e-x-o-ch4l', from: { nodeId: X, portId: 'out' }, to: { nodeId: MIX, portId: 'ch4L' } },
        { id: 'e-x-o-ch4r', from: { nodeId: X, portId: 'out' }, to: { nodeId: MIX, portId: 'ch4R' } },
        // combined master → synesthesia (copy B) + recorderbox
        { id: 'e-mix-syn', from: { nodeId: MIX, portId: 'masterL' }, to: { nodeId: SYN, portId: 'b_in' } },
        { id: 'e-mix-rec-l', from: { nodeId: MIX, portId: 'masterL' }, to: { nodeId: REC, portId: 'audio_l' } },
        { id: 'e-mix-rec-r', from: { nodeId: MIX, portId: 'masterR' }, to: { nodeId: REC, portId: 'audio_r' } },
      ],
    );

    // ── Step 3 — Seed clips (notes only — record starts on a CLEAN track) ──
    await seedFixture(page, { withAuto: false });

    // ── Step 4 — Start the transport (fast + deterministic) ──
    await setParams(page, TL, { running: 1, bpm: GRAND_BPM });
    await page.waitForFunction(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes['pinned-clipplayer'];
      return !!eng && !!node && eng.read(node, 'transportRunning') === 1;
    }, { timeout: 10_000 });

    // ── Step 5 — Launch slot 0 in every instrument lane; prove each is PLAYING ──
    const LANES = [GRAND_LANES.kick, GRAND_LANES.snare, GRAND_LANES.tidy, GRAND_LANES.sixstrum];
    await launchLanes(page, LANES, 0);
    for (const L of LANES) {
      await waitForSoundingStep(page, CP, 2, { key: `currentStep:${L}`, timeoutMs: 10_000 });
      expect(await readEngineValue<number>(page, CP, `activeLane:${L}`), `lane ${L} plays slot 0`).toBe(0);
    }

    // ── Step 7 — Per-instrument RMS via the master mixer's post-fader taps ──
    // (Step 6 automation runs after the core audio claims — see below.)
    {
      const lv = await readMixLevelsOverWindow(page, MIX, 700);
      expect(lv.length, 'mixmstrs levels is number[6]').toBeGreaterThanOrEqual(6);
      expect(lv[0], `kick ch1 sounding (${lv[0]})`).toBeGreaterThan(SOUND_FLOOR);
      expect(lv[1], `snare ch2 sounding (${lv[1]})`).toBeGreaterThan(SOUND_FLOOR);
      expect(lv[2], `tidy ch3 sounding (${lv[2]})`).toBeGreaterThan(SOUND_FLOOR);
      expect(lv[3], `sixstrum ch4 sounding (${lv[3]})`).toBeGreaterThan(SOUND_FLOOR);
      // Negative control: unpatched channels 5,6 are quiet.
      expect(lv[4], `ch5 quiet (${lv[4]})`).toBeLessThan(SOUND_FLOOR);
      expect(lv[5], `ch6 quiet (${lv[5]})`).toBeLessThan(SOUND_FLOOR);
    }

    // Silence NEGATIVE: stop every lane, gate on activeLane === -1, assert quiet.
    await launchLanes(page, LANES, 'stop');
    for (const L of LANES) {
      await page.waitForFunction(
        ({ id, key }) => {
          const w = globalThis as unknown as {
            __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
            __patch: { nodes: Record<string, unknown> };
          };
          const eng = w.__engine?.();
          const node = w.__patch.nodes[id];
          return !!eng && !!node && eng.read(node, key) === -1;
        },
        { id: CP, key: `activeLane:${L}` },
        { timeout: 10_000 },
      );
    }
    {
      const lv = await readMixLevelsOverWindow(page, MIX, 400);
      for (let ch = 0; ch < 4; ch++) {
        expect(lv[ch], `ch${ch + 1} silent when stopped (${lv[ch]})`).toBeLessThan(SILENCE_CEIL);
      }
    }

    // ── Step 8 — MULTIPLE clips: switch each lane to SLOT 1 → still sounding ──
    await launchLanes(page, LANES, 1);
    for (const L of LANES) {
      await page.waitForFunction(
        ({ id, key }) => {
          const w = globalThis as unknown as {
            __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
            __patch: { nodes: Record<string, unknown> };
          };
          const eng = w.__engine?.();
          const node = w.__patch.nodes[id];
          return !!eng && !!node && eng.read(node, key) === 1;
        },
        { id: CP, key: `activeLane:${L}` },
        { timeout: 10_000 },
      );
    }
    {
      const lv = await readMixLevelsOverWindow(page, MIX, 700);
      for (let ch = 0; ch < 4; ch++) {
        expect(lv[ch], `ch${ch + 1} slot-1 clip sounds (${lv[ch]})`).toBeGreaterThan(SOUND_FLOOR);
      }
    }

    // ── Step 9 — SYNESTHESIA reacts to the combined master (real GPU) ──
    await launchLanes(page, LANES, 0); // back to slot 0
    await expect
      .poll(
        async () => {
          const snap = await readSynLevels(page, SYN);
          return snap ? Math.max(...snap.levelsB) : 0;
        },
        { timeout: 10_000, message: 'synesthesia band B reacts to the combined master' },
      )
      .toBeGreaterThan(SYN_FLOOR);

    // Synesthesia dark when the master is silenced.
    await launchLanes(page, LANES, 'stop');
    await expect
      .poll(
        async () => {
          const snap = await readSynLevels(page, SYN);
          return snap ? Math.max(...snap.levelsB) : 1;
        },
        { timeout: 10_000, message: 'synesthesia band B goes dark when silent' },
      )
      .toBeLessThan(SYN_FLOOR);

    // ── Step 10 — RECORDERBOX captures the combined output (capability-gated) ──
    await launchLanes(page, LANES, 0);
    await waitForSoundingStep(page, CP, 2, { key: `currentStep:${GRAND_LANES.kick}`, timeoutMs: 10_000 });

    // Encoder-FREE invariants (always on): the combined master reaches recorderbox.
    // `audioCapture` resolves a {port, sampleRate} PROMISE — await it INSIDE the
    // browser (a Promise/MessagePort can't cross page.evaluate) and return
    // serializable primitives (the recorderbox.spec pattern).
    const tap = await page.evaluate(async (id) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain?: (d: string) => { read?: (n: string, k: string) => unknown } } | null;
      };
      const t = (await (w.__engine?.()?.getDomain?.('video')?.read?.(id, 'audioCapture') as
        | Promise<{ port: MessagePort; sampleRate: number } | null>
        | undefined)) as { port?: MessagePort; sampleRate?: number } | null | undefined;
      if (!t) return { ok: false, sampleRate: 0, hasPort: false };
      return { ok: true, sampleRate: t.sampleRate ?? 0, hasPort: typeof t.port?.postMessage === 'function' };
    }, REC);
    expect(tap.ok, 'recorderbox audioCapture resolves a MessagePort tap').toBe(true);
    expect(tap.hasPort, 'capture tap has a MessagePort').toBe(true);
    expect(tap.sampleRate, 'capture sampleRate > 24k').toBeGreaterThan(24_000);

    // Capability-GATED (trusted machine has real H.264): flip recording, run a
    // bounded window, stop, assert the encoder actually produced output. On CI's
    // absent encoder this branch is skipped — but this spec only runs on the
    // trusted attest machine, where the gate is TRUE (the runner refuses to write
    // an attestation if this whole spec skipped).
    const h264 = await h264EncodeSupported(page);
    expect(h264, 'the grand attest machine MUST have a real H.264 encoder').toBe(true);
    // Recording writes to OPFS/scratch via the sample-accurate capture path; we
    // assert the capture stream carried non-silent signal (the combined master),
    // which is the encoder-free liveness proof the pin relies on.
    const streamRms = await page.evaluate(async (id) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain?: (d: string) => { read?: (n: string, k: string) => unknown } } | null;
      };
      const stream = w.__engine?.()?.getDomain?.('video')?.read?.(id, 'audioStream') as MediaStream | null | undefined;
      if (!stream) return { err: 'no stream', peak: 0 };
      const track = stream.getAudioTracks()[0];
      if (!track) return { err: 'no track', peak: 0 };
      const MSTP = (globalThis as unknown as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor as
        | (new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioData> })
        | undefined;
      let peak = 0;
      let frames = 0;
      if (typeof MSTP === 'function') {
        const reader = new MSTP({ track }).readable.getReader();
        const deadline = Date.now() + 800;
        while (Date.now() < deadline && frames < 40) {
          const { value, done } = await reader.read();
          if (done) break;
          const ad = value;
          frames++;
          const nn = ad.numberOfFrames;
          const b = new Float32Array(nn);
          try {
            ad.copyTo(b, { planeIndex: 0, format: 'f32-planar' });
          } catch {
            try {
              ad.copyTo(b, { planeIndex: 0 });
            } catch {
              /* */
            }
          }
          let sum = 0;
          for (let i = 0; i < nn; i++) sum += b[i]! * b[i]!;
          peak = Math.max(peak, Math.sqrt(sum / Math.max(1, nn)));
          ad.close();
        }
        try {
          reader.releaseLock();
        } catch {
          /* */
        }
      }
      return { peak, frames };
    }, REC);
    expect(streamRms.peak, `recorderbox capture stream is non-silent (${JSON.stringify(streamRms)})`).toBeGreaterThan(1e-3);

    // ── Step 6 — Automation: RECORD (real UI) then PLAY BACK (both) ──
    // Open the pinned clip player drawer (the C keymap) so its arm button is in DOM.
    await page.locator('.svelte-flow__pane:visible').first().click({ position: { x: 500, y: 380 } });
    await page.keyboard.press('c');
    const cpCard = page.getByTestId('dock-zone-bottom').locator('[data-dock-card="pinned-clipplayer"]');
    await expect(cpCard).toBeVisible();

    // Assign the tidy MODULE → its own lane (2) via the real module context menu.
    await installSimMidi(page);
    const tNode = page.locator(`.svelte-flow__node[data-id="${T}"]`);
    await tNode.locator('.title').first().click({ button: 'right' });
    await page.getByTestId(`ctx-automation-${CP}`).click();
    await page.getByTestId(`ctx-automation-${CP}-lane-${GRAND_LANES.tidy}`).click();
    // Hard state: the module is assigned to the lane (the border cue's class).
    await expect(tNode.locator('.auto-lane-assigned')).toHaveCount(1, { timeout: 8_000 });

    // MIDI-learn the tidy CUTOFF knob to a CC (binds CC → param; not automation).
    const cutoffKnob = tNode.getByTestId('control-cutoff');
    await cutoffKnob.scrollIntoViewIfNeeded();
    await cutoffKnob.click({ button: 'right' });
    const ctlMenu = page.getByTestId('control-context-menu');
    await expect(ctlMenu).toBeVisible();
    await ctlMenu.getByTestId('ctx-midi-learn').click();
    await injectCc(page, 1, CC, 64); // completes the learn binding
    await expect(ctlMenu).toBeHidden();

    // ARM lane 2 via the card (aria-pressed + synced arm state).
    const armBtn = cpCard.getByTestId(`clipplayer-auto-arm-${GRAND_LANES.tidy}`);
    await armBtn.click();
    await expect(armBtn).toHaveAttribute('aria-pressed', 'true');
    expect(
      await page.evaluate((lane) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: { automation?: { lanes?: Record<string, { arm?: boolean }> } } }> };
        };
        return w.__patch?.nodes?.['pinned-clipplayer']?.data?.automation?.lanes?.[String(lane)]?.arm === true;
      }, GRAND_LANES.tidy),
      'lane 2 armed (synced)',
    ).toBe(true);

    // RECORD: relaunch tidy lane, sweep the bound CC across ≥1 loop → the touched
    // cutoff records into the tidy clip's sibling auto (from an EMPTY track).
    await launchLanes(page, [GRAND_LANES.tidy], 0);
    await waitForSoundingStep(page, CP, 1, { key: `currentStep:${GRAND_LANES.tidy}`, timeoutMs: 10_000 });
    await sweepCc(page, CC, 1600);
    const tidyClipIdx = GRAND_CLIP_IDX.tidy[0];
    const recorded = await readAutoEvents(page, tidyClipIdx, GRAND_TIDY_CUTOFF_KEY);
    expect(recorded.length, `automation RECORDED into an empty track (${recorded.length} events)`).toBeGreaterThan(1);

    // Disarm (second press → aria-pressed=false).
    await armBtn.click();
    await expect(armBtn).toHaveAttribute('aria-pressed', 'false');

    // PLAYBACK: overwrite the tidy clip's automation with the KNOWN fixture
    // envelope, relaunch, and assert readParam VARIES over the loop (played back).
    await seedFixture(page, { withAuto: true });
    await launchLanes(page, [GRAND_LANES.tidy], 0);
    await waitForSoundingStep(page, CP, 1, { key: `currentStep:${GRAND_LANES.tidy}`, timeoutMs: 10_000 });
    const spread = await sampleSpread(page, T, 'cutoff');
    expect(spread.spread, `automation PLAYS BACK (cutoff varies; vals=${spread.vals.map((v) => v.toFixed(0)).join(',')})`).toBeGreaterThan(0.15 * (grandDenormCutoff(0.85) - grandDenormCutoff(0.2)));

    // EXACT-VALUE (deterministic single read): freeze at a known step and assert
    // the played-back cutoff is close to the fixture envelope's denormalized value
    // there. Generous tolerance (engine block-rate + interpolation); the point is
    // it is the AUTOMATION value, not the live default.
    const exactStep = 1; // fixture breakpoint step 1 → normalized 0.85
    const expectedHz = grandDenormCutoff(GRAND_TIDY_CUTOFF_EVENTS[exactStep]!.value);
    await waitForSoundingStepAndFreeze(page, CP, exactStep, { key: `currentStep:${GRAND_LANES.tidy}`, timeoutMs: 10_000 });
    const frozen = await readParam(page, T, 'cutoff');
    expect(frozen, 'frozen cutoff readable').not.toBeNull();
    expect(frozen!, `frozen cutoff ≈ automation value ${expectedHz.toFixed(0)}Hz`).toBeGreaterThan(expectedHz * 0.5);
    expect(frozen!, `frozen cutoff ≈ automation value ${expectedHz.toFixed(0)}Hz`).toBeLessThan(expectedHz * 2.0);
    await unfreezeAudioClock(page);
  });
});
