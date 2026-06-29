// e2e/tests/perf-glitches-audio-capture.spec.ts
//
// GROUND-TRUTH MEASUREMENT (owner directive): "monitor/record the AUDIO OUTPUT
// while loading glitches and vigorously dragging — the degradation is obvious and
// glaring." The earlier specs measured PROXIES (step counters) and found the
// clock 'healthy' — but the owner HEARS obvious glitching/tempo-slowdown when
// dragging a real significant patch. So this captures the ACTUAL master audio on
// the AUDIO THREAD (a capture AudioWorklet tapping audioOut's input), which is
// immune to the main-thread saturation that was blinding the proxy specs, and
// looks for the artifacts you actually hear:
//   - audio-thread RENDER STALLS: the wall-clock gap between successive audio
//     render blocks. Normal ≈ 2.9 ms (128/44100). A spike (>12/30 ms) means the
//     audio thread was descheduled = a buffer underrun = an audible glitch.
//   - RMS DROPOUTS: blocks whose level collapses vs the median (momentary silence).
//   - DISCONTINUITIES: large sample-to-sample jumps (clicks from underrun/repeat).
//
// It loads the REAL "glitches get riches" demo and drags a node vigorously with
// the real mouse for ~6s while capturing. The console.log is the deliverable —
// if the owner's glitch is real it shows up as render-stall spikes here.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const DRAG_MS = 6000;

const CAPTURE_WORKLET = `
class PtCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
    this.prev = 0;
    this.port.onmessage = (e) => {
      if (e && e.data === 'dump') { this.port.postMessage(this.blocks); this.blocks = []; }
    };
  }
  process(inputs) {
    const inp = inputs[0];
    let rms = 0, peak = 0, maxDelta = 0, prev = this.prev;
    const ch0 = inp && inp[0];
    if (ch0 && ch0.length) {
      const ch1 = inp[1];
      const n = ch0.length;
      for (let i = 0; i < n; i++) {
        let s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
        rms += s * s;
        const a = s < 0 ? -s : s; if (a > peak) peak = a;
        const d = s - prev; const ad = d < 0 ? -d : d; if (ad > maxDelta) maxDelta = ad;
        prev = s;
      }
      rms = Math.sqrt(rms / n);
    }
    this.prev = prev;
    let wall = -1; try { wall = performance.now(); } catch (e) { wall = -1; }
    this.blocks.push([currentTime, rms, peak, maxDelta, wall]);
    return true;
  }
}
registerProcessor('pt-capture', PtCapture);
`;

test('perf-glitches-audio-capture: record master audio while vigorously dragging', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.selectOption('[data-testid="load-example-select"]', 'glitches');
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
      return !!w.__patch && Object.keys(w.__patch.nodes).length >= 20;
    },
    undefined,
    { timeout: 20_000 },
  );
  // Let audio + video spin up so the master bus is actually producing sound.
  await page.waitForTimeout(2000);

  // Install the capture worklet + tap audioOut's input(s) on the audio thread.
  const tap = await page.evaluate(async (workletCode) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { ctx: AudioContext; nodes: Map<string, { inputs?: Map<string, { node: AudioNode; input: number }> }> } } | null;
      __patch: { nodes: Record<string, { id: string; type: string } | undefined> };
      __ptCapture?: AudioWorkletNode;
    };
    const top = w.__engine?.();
    const eng = top?.getDomain?.('audio');
    if (!eng || !eng.ctx) return { ok: false, reason: 'no audio engine/ctx' };
    const ctx = eng.ctx;
    // Chrome's AudioRenderCapacity directly reports audio-thread load +
    // underrunRatio (the fraction of render quanta that missed their deadline =
    // the audible glitch). Events queue on the main thread but report the audio
    // thread's TRUE load even if delivered late. This is the real underrun signal.
    const rc = (ctx as unknown as { renderCapacity?: { start: (o: { updateInterval: number }) => void; stop: () => void; addEventListener: (t: string, cb: (e: { averageLoad: number; peakLoad: number; underrunRatio: number }) => void) => void } }).renderCapacity;
    const ww = globalThis as unknown as { __rc?: Array<{ avg: number; peak: number; under: number }> };
    ww.__rc = [];
    if (rc) {
      try {
        rc.addEventListener('update', (e) => { ww.__rc!.push({ avg: e.averageLoad, peak: e.peakLoad, under: e.underrunRatio }); });
        rc.start({ updateInterval: 0.05 });
      } catch { /* unsupported */ }
    }
    const url = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const cap = new AudioWorkletNode(ctx, 'pt-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
    // Keep it pulled by the render graph without adding audible output.
    const sink = ctx.createGain(); sink.gain.value = 0;
    cap.connect(sink); sink.connect(ctx.destination);
    // Tap every audioOut module's input node(s) → the master mix.
    let taps = 0;
    for (const [id, n] of Object.entries(w.__patch.nodes)) {
      if (!n || n.type !== 'audioOut') continue;
      const handle = eng.nodes.get(id);
      if (!handle?.inputs) continue;
      for (const entry of handle.inputs.values()) {
        try { entry.node.connect(cap); taps++; } catch { /* */ }
      }
    }
    w.__ptCapture = cap;
    return { ok: taps > 0, taps };
  }, CAPTURE_WORKLET);

  if (!tap.ok) {
    // eslint-disable-next-line no-console
    console.log(`[perf-glitches-audio-capture] could not tap audioOut (${JSON.stringify(tap)}) — skipping`);
    test.skip(true, 'no audioOut tap available');
    return;
  }

  // Vigorous, sustained real-mouse drag of a node for ~DRAG_MS (the owner's
  // action). Under the heavy-video main-thread load each move is slow, so we
  // loop on wall-time, not move-count.
  const node = page.locator('.svelte-flow__node').first();
  const box = await node.boundingBox();
  if (!box) throw new Error('no node to drag');
  const cx = box.x + box.width / 2;
  const cy = box.y + 10;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < DRAG_MS) {
    const dx = 120 * Math.sin(k * 0.4);
    const dy = 80 * Math.cos(k * 0.55);
    await page.mouse.move(cx + dx, cy + dy, { steps: 1 });
    k++;
  }
  await page.mouse.up();

  // Dump the captured blocks + analyze.
  const blocks = (await page.evaluate(async () => {
    const w = globalThis as unknown as { __ptCapture?: AudioWorkletNode };
    const cap = w.__ptCapture;
    if (!cap) return [];
    return await new Promise<number[][]>((resolve) => {
      const onMsg = (e: MessageEvent) => { cap.port.removeEventListener('message', onMsg); resolve(e.data as number[][]); };
      cap.port.addEventListener('message', onMsg);
      cap.port.start?.();
      cap.port.postMessage('dump');
      setTimeout(() => resolve([]), 4000);
    });
  })) as number[][];

  // blocks: [audioTime, rms, peak, maxDelta, wall]
  const wall = blocks.map((b) => b[4]).filter((x) => x >= 0);
  const haveWall = wall.length > 10;
  let stall12 = 0, stall30 = 0, maxGap = 0;
  if (haveWall) {
    for (let i = 1; i < wall.length; i++) {
      const g = wall[i] - wall[i - 1];
      if (g > maxGap) maxGap = g;
      if (g > 12) stall12++;
      if (g > 30) stall30++;
    }
  }
  const rmsArr = blocks.map((b) => b[1]);
  const sorted = [...rmsArr].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const loud = median > 1e-4;
  // Dropouts: blocks that collapse to <10% of median while the track is loud.
  const dropouts = loud ? rmsArr.filter((r) => r < median * 0.1).length : 0;
  const clicks = blocks.filter((b) => b[3] > 0.5).length; // big sample jumps
  const span = blocks.length ? blocks[blocks.length - 1][0] - blocks[0][0] : 0;

  // Audio-thread render capacity (the direct underrun signal).
  const rc = (await page.evaluate(() => {
    const ww = globalThis as unknown as { __rc?: Array<{ avg: number; peak: number; under: number }> };
    const c = (globalThis as unknown as { __engine?: () => { getDomain: (d: string) => { ctx: { renderCapacity?: { stop: () => void } } } } }).__engine?.()?.getDomain('audio')?.ctx?.renderCapacity;
    try { c?.stop(); } catch { /* */ }
    return ww.__rc ?? [];
  })) as Array<{ avg: number; peak: number; under: number }>;
  const rcN = rc.length;
  const peakLoadMax = rcN ? Math.max(...rc.map((x) => x.peak)) : -1;
  const avgLoadMax = rcN ? Math.max(...rc.map((x) => x.avg)) : -1;
  const underrunMax = rcN ? Math.max(...rc.map((x) => x.under)) : -1;
  const underrunSamples = rc.filter((x) => x.under > 0).length;

  // eslint-disable-next-line no-console
  console.log(
    `[perf-glitches-audio-capture] mouseMoves=${k} blocks=${blocks.length} audioSpan=${span.toFixed(2)}s ` +
      `medianRMS=${median.toFixed(4)} loud=${loud} | ` +
      `RENDER-CAPACITY(n=${rcN}): peakLoadMax=${peakLoadMax.toFixed(2)} avgLoadMax=${avgLoadMax.toFixed(2)} ` +
      `underrunMax=${underrunMax.toFixed(3)} underrunSamples=${underrunSamples} | ` +
      `dropouts(<10%median)=${dropouts} clicks(Δ>0.5)=${clicks}`,
  );

  expect(blocks.length, 'capture produced no blocks — tap not pulled').toBeGreaterThan(100);
  // This is a measurement; the console line is the deliverable. We only require
  // that audio actually played (so the capture is meaningful).
  expect(loud, 'master RMS ~0 — glitches produced no audio to analyze').toBe(true);
});
