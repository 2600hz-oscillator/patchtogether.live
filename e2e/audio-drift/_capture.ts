// e2e/audio-drift/_capture.ts
//
// Audio-drift research helper: drives a Page to install a MediaStreamAudioDestinationNode
// + ScriptProcessor tap on the engine's audioOut module so we can record N seconds of
// PCM samples from the live AudioContext and pull them back to Node for comparison.
//
// Why this approach (vs the scope module's analyser):
//   - Scope's analyser only exposes the LATEST 2048 samples; we'd have to poll at
//     >= sampleRate/2048 Hz which is hard to do reliably from page.evaluate().
//   - ScriptProcessor (deprecated but ubiquitous) is the simplest cross-browser way
//     to accumulate samples into a JS array without an AudioWorklet round-trip.
//   - We accept the ~50ms latency added by the SP node — both contexts add the same
//     amount, so it cancels out in the A vs B comparison.
//
// Capture is mono (L channel only). The user's question is about engine determinism,
// not stereo image; mono is sufficient and halves the data volume.

import type { Page } from '@playwright/test';

export interface CapturedAudio {
  samples: Float32Array;
  sampleRate: number;
  /** ms timestamp from performance.now() when capture started. */
  startedAt: number;
}

/**
 * Install a tap on the audioOut node with id `audioOutId` and accumulate
 * `durationSec` seconds of mono samples (L channel). Returns once the buffer
 * is full. The page must already have spawnPatch'd a graph terminating in
 * an audioOut module with that id.
 *
 * Implementation: reach into the engine via __engine() to get the audioOut
 * handle, find its gainL via inputs.get('L'), and patch a ScriptProcessor
 * tap onto it. Samples accumulate in window.__audioDriftBuf.
 */
export async function recordAudio(
  page: Page,
  audioOutId: string,
  durationSec: number,
): Promise<CapturedAudio> {
  // Phase 1: install the tap and start recording.
  const startInfo = await page.evaluate(
    async ({ id, dur }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain: (d: string) => {
            ctx: AudioContext;
            nodes: Map<
              string,
              {
                inputs: Map<string, { node: AudioNode; input: number }>;
              }
            >;
          };
        } | null;
        __audioDriftBuf?: Float32Array;
        __audioDriftIdx?: number;
        __audioDriftDone?: boolean;
        __audioDriftStartedAt?: number;
        __audioDriftSampleRate?: number;
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
      if (!handle) throw new Error(`no audioOut node with id ${id}`);
      const lInput = handle.inputs.get('L');
      if (!lInput) throw new Error(`no L input on ${id}`);

      // ScriptProcessor: 4096-sample blocks, 1 input ch, 0 output ch (sink-only).
      // Deprecated but works everywhere and doesn't need a separate worklet file.
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
      // Connect the tap source. lInput.node IS gainL (the audioOut input gain).
      // We tap it by connecting gainL -> sp. ScriptProcessor needs a non-zero
      // sink so its callback fires; route sp.output -> a muted sink.
      const muteSink = ctx.createGain();
      muteSink.gain.value = 0;
      sp.connect(muteSink);
      muteSink.connect(ctx.destination);
      // Tap: source already feeds gainL; we re-connect gainL -> sp by tapping
      // its output. GainNodes can have multiple .connect() targets.
      lInput.node.connect(sp);

      w.__audioDriftBuf = buf;
      w.__audioDriftIdx = 0;
      w.__audioDriftDone = false;
      w.__audioDriftStartedAt = performance.now();
      w.__audioDriftSampleRate = sr;
      w.__audioDriftCleanup = () => {
        try { lInput.node.disconnect(sp); } catch { /* ok */ }
        try { sp.disconnect(); } catch { /* ok */ }
        try { muteSink.disconnect(); } catch { /* ok */ }
      };
      return { startedAt: w.__audioDriftStartedAt, sampleRate: sr, totalSamples };
    },
    { id: audioOutId, dur: durationSec },
  );

  // Phase 2: poll until done. Worst-case wait = durationSec + buffer for latency.
  const deadline = Date.now() + Math.ceil(durationSec * 1000) + 5000;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => {
      const w = globalThis as unknown as { __audioDriftDone?: boolean };
      return w.__audioDriftDone === true;
    });
    if (done) break;
    await page.waitForTimeout(100);
  }

  // Phase 3: pull the buffer back. Convert to a regular array for transport
  // (Float32Array doesn't survive structured clone in older Playwright), then
  // back to Float32Array on the Node side.
  const samples = await page.evaluate(() => {
    const w = globalThis as unknown as { __audioDriftBuf?: Float32Array };
    if (!w.__audioDriftBuf) return null;
    return Array.from(w.__audioDriftBuf);
  });
  if (!samples) throw new Error('no captured buffer on page');

  // Cleanup the tap before returning so the next capture starts from a clean slate.
  await page.evaluate(() => {
    const w = globalThis as unknown as { __audioDriftCleanup?: () => void };
    w.__audioDriftCleanup?.();
  });

  return {
    samples: new Float32Array(samples),
    sampleRate: startInfo.sampleRate,
    startedAt: startInfo.startedAt,
  };
}
