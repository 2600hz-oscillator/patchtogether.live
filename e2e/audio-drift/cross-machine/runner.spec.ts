// e2e/audio-drift/cross-machine/runner.spec.ts
//
// One side of the cross-machine drift test. A single Playwright Chromium
// context loads the rack URL, attaches via the existing share-URL flow
// (?invite=<code>), waits for the patch to be present (or authors it if
// role=author), captures audio, and writes:
//
//   <out>/audio-drift-<scenario>-<role>.pcm        Float32Array, mono
//   <out>/audio-drift-<scenario>-<role>.json       metadata
//
// Required env vars:
//   AUDIO_DRIFT_SCENARIO   Scenario name (must exist in scenarios.ts).
//   AUDIO_DRIFT_ROLE       'author' or 'listener'.
//   AUDIO_DRIFT_RACK_URL   Full URL: https://autotest.../r/<id>?invite=<code>.
//   AUDIO_DRIFT_OUT_DIR    Where to write artifacts.
//
// Optional:
//   AUDIO_DRIFT_SECONDS    Recording duration (default 5).
//   AUDIO_DRIFT_AUTHOR_HEADSTART_MS  How long the author waits AFTER patching
//                                    before recording, giving the listener
//                                    time to converge (default 3000).
//   AUDIO_DRIFT_LISTENER_PATCH_TIMEOUT_MS  Listener patience for sync (default
//                                          15000).

import { test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getScenario } from './scenarios';
import type { PatchSpec } from '../_collab';

const SCENARIO_NAME = process.env.AUDIO_DRIFT_SCENARIO;
const ROLE = process.env.AUDIO_DRIFT_ROLE as 'author' | 'listener' | undefined;
const RACK_URL = process.env.AUDIO_DRIFT_RACK_URL;
const OUT_DIR = process.env.AUDIO_DRIFT_OUT_DIR;
const SECONDS = Number(process.env.AUDIO_DRIFT_SECONDS ?? '5');
const AUTHOR_HEADSTART_MS = Number(process.env.AUDIO_DRIFT_AUTHOR_HEADSTART_MS ?? '3000');
const LISTENER_PATCH_TIMEOUT_MS = Number(
  process.env.AUDIO_DRIFT_LISTENER_PATCH_TIMEOUT_MS ?? '15000',
);

if (!SCENARIO_NAME || !ROLE || !RACK_URL || !OUT_DIR) {
  throw new Error(
    'Missing env: AUDIO_DRIFT_SCENARIO, AUDIO_DRIFT_ROLE, AUDIO_DRIFT_RACK_URL, AUDIO_DRIFT_OUT_DIR are all required',
  );
}

test(`@audio-drift-cross ${SCENARIO_NAME} (${ROLE})`, async ({ page }) => {
  const scenario = getScenario(SCENARIO_NAME);
  if (!scenario) throw new Error(`unknown scenario: ${SCENARIO_NAME}`);

  await page.goto(RACK_URL);
  await page.waitForLoadState('networkidle');

  // The /r/[id] page boots the engine and provider once data.isMember is true
  // (anon-via-invite or authed). The engine + ydoc + patch hooks (__engine,
  // __ydoc, __patch) come online once Canvas mounts — gated on VITE_E2E_HOOKS=1
  // in production builds. Wait for them to exist.
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __engine?: unknown;
        __ydoc?: unknown;
        __patch?: unknown;
      };
      return (
        typeof w.__engine === 'function' &&
        !!w.__ydoc &&
        !!w.__patch
      );
    },
    undefined,
    { timeout: 30_000 },
  );

  // The audio gate (B5) blocks ctx.resume() until a user gesture. Click the
  // gate first if visible, otherwise body — the autoplay flag lets ctx start
  // suspended/running but the gate's reactive `state.unlocked` flag still
  // wants a real gesture.
  const gate = page.locator('[data-testid="audio-gate"]');
  if ((await gate.count()) > 0) {
    await gate.click({ timeout: 5000 }).catch(() => {});
  } else {
    await page.click('body').catch(() => {});
  }

  // Wait until the engine has at least started — read sampleRate to ensure
  // ctx exists and is running.
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { ctx: AudioContext } } | null;
      };
      const eng = w.__engine?.();
      if (!eng) return false;
      try {
        const ctx = eng.getDomain('audio').ctx;
        return ctx.state === 'running' || ctx.state === 'suspended';
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 15_000 },
  );

  if (ROLE === 'author') {
    // Author the patch via Yjs transact — same code path as the local
    // harness's authorPatchAndAwaitSync, inlined so we don't depend on a
    // helper that opens two contexts.
    await page.evaluate((patch: PatchSpec) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
        for (const n of patch.nodes) {
          w.__patch.nodes[n.id] = {
            id: n.id,
            type: n.type,
            domain: 'audio',
            position: n.position ?? { x: 100, y: 100 },
            params: n.params ?? {},
            ...(n.data ? { data: n.data } : {}),
          };
        }
        for (const e of patch.edges) {
          w.__patch.edges[e.id] = {
            id: e.id,
            source: e.from,
            target: e.to,
            sourceType: e.sourceType ?? 'audio',
            targetType: e.targetType ?? 'audio',
          };
        }
      });
    }, scenario.patch);

    // Wait for the local engine to spawn all nodes (reconciler is async).
    const expectedIds = scenario.patch.nodes.map((n) => n.id).sort();
    await page.waitForFunction(
      (ids) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain: (d: string) => { nodes: Map<string, unknown> };
          } | null;
        };
        const eng = w.__engine?.();
        if (!eng) return false;
        const have = [...eng.getDomain('audio').nodes.keys()].sort();
        if (have.length !== ids.length) return false;
        for (let i = 0; i < ids.length; i++) if (have[i] !== ids[i]) return false;
        return true;
      },
      expectedIds,
      { timeout: 20_000 },
    );

    // Give the listener a head start to receive + reconcile the patch over
    // Hocuspocus. Without this, the author records 3s of audio while the
    // listener is still waiting for the doc to sync, and timestamps end up
    // misaligned by the full headstart amount.
    await page.waitForTimeout(AUTHOR_HEADSTART_MS);
    if (scenario.warmupMs) await page.waitForTimeout(scenario.warmupMs);
  } else {
    // Listener: wait for the patch to appear in the local engine, then warmup.
    const expectedIds = scenario.patch.nodes.map((n) => n.id).sort();
    await page.waitForFunction(
      (ids) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain: (d: string) => { nodes: Map<string, unknown> };
          } | null;
        };
        const eng = w.__engine?.();
        if (!eng) return false;
        const have = [...eng.getDomain('audio').nodes.keys()].sort();
        if (have.length !== ids.length) return false;
        for (let i = 0; i < ids.length; i++) if (have[i] !== ids[i]) return false;
        return true;
      },
      expectedIds,
      { timeout: LISTENER_PATCH_TIMEOUT_MS },
    );
    if (scenario.warmupMs) await page.waitForTimeout(scenario.warmupMs);
  }

  // Capture: install the same ScriptProcessor tap that ../_capture.ts uses.
  // Inlined here so the runner doesn't import the same-machine helper (which
  // assumes a CollabPair).
  const startInfo = await page.evaluate(
    async ({ id, dur }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            ctx: AudioContext;
            nodes: Map<string, { inputs: Map<string, { node: AudioNode; input: number }> }>;
          };
        } | null;
        __audioDriftBuf?: Float32Array;
        __audioDriftDone?: boolean;
        __audioDriftStartedAtMs?: number;
        __audioDriftStartedAtCtx?: number;
        __audioDriftCleanup?: () => void;
      };
      const eng = w.__engine?.();
      if (!eng) throw new Error('no engine');
      const audio = eng.getDomain('audio');
      const ctx = audio.ctx;
      const sr = ctx.sampleRate;
      const totalSamples = Math.ceil(dur * sr);
      const buf = new Float32Array(totalSamples);
      const handle = audio.nodes.get(id);
      if (!handle) throw new Error(`no audioOut node ${id}`);
      const lInput = handle.inputs.get('L');
      if (!lInput) throw new Error(`no L input on ${id}`);

      const sp = ctx.createScriptProcessor(4096, 1, 1);
      let idx = 0;
      let done = false;
      sp.onaudioprocess = (e) => {
        if (done) return;
        const ch = e.inputBuffer.getChannelData(0);
        const remaining = totalSamples - idx;
        const n = Math.min(remaining, ch.length);
        for (let i = 0; i < n; i++) buf[idx + i] = ch[i];
        idx += n;
        if (idx >= totalSamples) {
          done = true;
          w.__audioDriftDone = true;
        }
      };
      const muteSink = ctx.createGain();
      muteSink.gain.value = 0;
      sp.connect(muteSink);
      muteSink.connect(ctx.destination);
      lInput.node.connect(sp);

      w.__audioDriftBuf = buf;
      w.__audioDriftDone = false;
      // Two timestamps: wall-clock (Date.now()) for cross-machine alignment,
      // and ctx.currentTime for within-runner audio-clock reference.
      w.__audioDriftStartedAtMs = Date.now();
      w.__audioDriftStartedAtCtx = ctx.currentTime;
      w.__audioDriftCleanup = () => {
        try { lInput.node.disconnect(sp); } catch { /* ok */ }
        try { sp.disconnect(); } catch { /* ok */ }
        try { muteSink.disconnect(); } catch { /* ok */ }
      };
      return {
        startedAtMs: w.__audioDriftStartedAtMs,
        startedAtCtx: w.__audioDriftStartedAtCtx,
        sampleRate: sr,
        totalSamples,
      };
    },
    { id: 'out', dur: SECONDS },
  );

  // Block until full.
  const deadline = Date.now() + Math.ceil(SECONDS * 1000) + 8000;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => {
      const w = globalThis as unknown as { __audioDriftDone?: boolean };
      return w.__audioDriftDone === true;
    });
    if (done) break;
    await page.waitForTimeout(100);
  }

  const samples = await page.evaluate(() => {
    const w = globalThis as unknown as { __audioDriftBuf?: Float32Array };
    if (!w.__audioDriftBuf) return null;
    return Array.from(w.__audioDriftBuf);
  });
  if (!samples) throw new Error('no captured buffer on page');
  await page.evaluate(() => {
    const w = globalThis as unknown as { __audioDriftCleanup?: () => void };
    w.__audioDriftCleanup?.();
  });

  // Write artifacts. PCM as raw little-endian Float32 so the comparator can
  // mmap-style-load it; metadata as JSON for timestamps + sample rate.
  await mkdir(OUT_DIR!, { recursive: true });
  const pcmPath = join(OUT_DIR!, `audio-drift-${SCENARIO_NAME}-${ROLE}.pcm`);
  const metaPath = join(OUT_DIR!, `audio-drift-${SCENARIO_NAME}-${ROLE}.json`);
  const f32 = new Float32Array(samples);
  await writeFile(pcmPath, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        scenario: SCENARIO_NAME,
        role: ROLE,
        rackUrl: RACK_URL,
        sampleRate: startInfo.sampleRate,
        startedAtMs: startInfo.startedAtMs,
        startedAtCtx: startInfo.startedAtCtx,
        durationSec: SECONDS,
        capturedSamples: samples.length,
        runnerHostname: process.env.RUNNER_NAME ?? null,
        githubRunId: process.env.GITHUB_RUN_ID ?? null,
        githubJob: process.env.GITHUB_JOB ?? null,
        githubRunner: process.env.RUNNER_OS ?? null,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${pcmPath} (${samples.length} samples) + ${metaPath}`);
});
