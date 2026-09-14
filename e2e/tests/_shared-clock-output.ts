import type { Page } from '@playwright/test';

/** Samples actual worklet output in the audio thread, timestamped by its render
 * frame. No host polling of audio values and no independently implemented LFO. */
export async function captureLfoAlignment(page: Page, poisonAnchor = false) {
  return page.evaluate(async (poison) => {
    const w = window as unknown as {
      __engine: () => { getDomain: (domain: string) => {
        ctx: AudioContext;
        getOutputNode: (id: string, port: string) => { node: AudioWorkletNode; output: number } | null;
      } };
      __sharedClock: () => { epoch_ms: number; sharedTimeAt: (time: number) => number; snapshot: { uncertaintyMs: number } };
    };
    const engine = w.__engine().getDomain('audio');
    const clock = w.__sharedClock();
    const ctx = engine.ctx;
    const sine = engine.getOutputNode('shared-lfo', 'phase0');
    const cosine = engine.getOutputNode('shared-lfo', 'phase90');
    if (!sine || !cosine) throw new Error('Real LFO output ports are missing');
    const probeName = 'clock-output-' + crypto.randomUUID();
    const source = `class ClockOutputProbe extends AudioWorkletProcessor {
      process(inputs, outputs) {
        for (const channel of outputs[0]) channel.fill(0);
        if (inputs[0]?.[0]?.length && inputs[1]?.[0]?.length) {
          this.port.postMessage({frame: currentFrame, sine: inputs[0][0][0], cosine: inputs[1][0][0]});
        }
        return true;
      }
    }
    registerProcessor(${JSON.stringify(probeName)}, ClockOutputProbe);`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const tap = new AudioWorkletNode(ctx, probeName, { numberOfInputs: 2, numberOfOutputs: 1 });
    const before = performance.now();
    const stamp = ctx.getOutputTimestamp();
    if (!stamp.performanceTime) throw new Error('Audio output timestamp is not ready');
    const sharedStart = clock.sharedTimeAt(stamp.performanceTime);
    const audioStart = stamp.contextTime!;
    const bracketMs = performance.now() - before;
    if (poison) sine.node.port.postMessage({ type: 'init', epoch_ms: clock.epoch_ms,
      sharedNow_ms: sharedStart + 250, audioOrigin_s: audioStart, smoothing_ms: 0 });
    const errors: number[] = [];
    const magnitudes: number[] = [];
    const started = performance.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`LFO output samples=${errors.length}, elapsed=${performance.now() - started}ms`)), 8000);
        tap.port.onmessage = ({ data }: MessageEvent<{ frame: number; sine: number; cosine: number }>) => {
          const time = sharedStart + (data.frame / ctx.sampleRate - audioStart) * 1000;
          const expected = ((time - clock.epoch_ms) / 1000 % 1 + 1) % 1;
          const actual = (Math.atan2(data.sine, data.cosine) / (2 * Math.PI) + 1) % 1;
          const delta = Math.abs(actual - expected);
          errors.push(Math.min(delta, 1 - delta));
          magnitudes.push(Math.hypot(data.sine, data.cosine));
          if (errors.length >= 128) { clearTimeout(timeout); resolve(); }
        };
        sine.node.connect(tap, sine.output, 0);
        cosine.node.connect(tap, cosine.output, 1);
        tap.connect(ctx.destination);
      });
      return { anchors: (window as any).__clockAnchors, stamp, endStamp: ctx.getOutputTimestamp(), baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency, clock: clock.snapshot, samples: errors.length, elapsedMs: performance.now() - started,
        meanPhaseError: errors.reduce((a, b) => a + b, 0) / errors.length,
        minMagnitude: Math.min(...magnitudes), uncertaintyMs: clock.snapshot.uncertaintyMs,
        tolerance: (4 * 128 / ctx.sampleRate) + (clock.snapshot.uncertaintyMs + bracketMs) / 1000 };
    } finally {
      sine.node.disconnect(tap, sine.output, 0);
      cosine.node.disconnect(tap, cosine.output, 1);
      tap.disconnect(); tap.port.close();
    }
  }, poisonAnchor);
}
