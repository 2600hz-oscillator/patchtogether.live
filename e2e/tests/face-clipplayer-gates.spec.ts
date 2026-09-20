import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';

type RecordedNote = { step: number; midi: number; lengthSteps: number; gateLen?: number };
interface TestWindow {
  __patch: { nodes: Record<string, { params: Record<string, number>; data: Record<string, any> }> };
  __ydoc: { transact: (f: () => void) => void };
  __engine: () => {
    read: (node: unknown, key: string) => unknown;
    getDomain: (domain: string) => { ctx: AudioContext; getOutputNode: (id: string, port: string) => { node: AudioNode; output: number } | null };
  };
  __launchpadTestInstallSingle: (id: string) => Promise<boolean>;
  __launchpadSingleSim: { press: (x: number, y: number) => void; release: (x: number, y: number) => void; cc: (cc: number, v: number) => void; state: () => { mode: string } };
}

async function buildChain(page: Page) {
  await spawnPatch(page, [
    { id: 'cp', type: 'clipplayer', domain: 'audio', position: { x: 40, y: 40 }, params: { stepDiv: 1, quantize: 0, gateLength: 0.1 } },
    { id: 'tl', type: 'timelorde', domain: 'audio', position: { x: 40, y: 350 }, params: { running: 0, bpm: 120 } },
    { id: 'vco', type: 'analogVco', domain: 'audio', position: { x: 350, y: 40 } },
    { id: 'vca', type: 'vca', domain: 'audio', position: { x: 650, y: 40 }, params: { base: 0, cvAmount: 1 } },
    { id: 'cube', type: 'cube', domain: 'audio', position: { x: 350, y: 350 }, params: { attack: 0.001, decay: 0.001, sustain: 1, release: 0.001 } },
  ], [
    { id: 'pitch', from: { nodeId: 'cp', portId: 'pitch1' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'polyPitchGate', targetType: 'pitch' },
    { id: 'audio', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
    { id: 'gate', from: { nodeId: 'cp', portId: 'gate1' }, to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'gate', targetType: 'cv' },
    { id: 'poly', from: { nodeId: 'cp', portId: 'pitch1' }, to: { nodeId: 'cube', portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
  ]);
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__ydoc.transact(() => {
      w.__patch.nodes.cp.data = { clips: { '0': { kind: 'note', lengthSteps: 16, root: 60, scale: 'major', loop: true, steps: [] } }, playing: [0, null, null, null, null, null, null, null] };
    });
  });
}

// Read actual sample edges after a silent transport control, on both shipped voice paths.
async function playbackDurations(page: Page, notes: number) {
  return page.evaluate(async (count) => {
    const w = window as unknown as TestWindow;
    const audio = w.__engine().getDomain('audio');
    const ctx = audio.ctx;
    const ports = [audio.getOutputNode('vca', 'audio'), audio.getOutputNode('cube', 'L')];
    if (ports.some((p) => !p)) throw new Error('Missing audible output port');
    const name = 'note-duration-' + crypto.randomUUID();
    const source = `class Probe extends AudioWorkletProcessor {
      constructor() { super(); this.blocks = 0; this.quiet = 0; this.ready = false; this.start = [-1, -1]; this.last = [-1, -1]; }
      process(inputs, outputs) {
        outputs[0][0].fill(0);
        let peak = 0;
        for (let ch = 0; ch < 2; ch++) {
          const samples = inputs[ch]?.[0];
          if (!samples) continue;
          for (let i = 0; i < samples.length; i++) {
            const frame = currentFrame + i;
            const amplitude = Math.abs(samples[i]);
            peak = Math.max(peak, amplitude);
            if (amplitude > 0.00001) {
              if (this.start[ch] < 0) this.start[ch] = frame;
              this.last[ch] = frame;
            } else if (this.start[ch] >= 0 && frame - this.last[ch] >= 128) {
              this.port.postMessage({ ch, duration: (this.last[ch] - this.start[ch] + 1) / sampleRate });
              this.start[ch] = -1;
            }
          }
        }
        this.blocks++;
        if (!this.ready) {
          this.quiet = peak < 0.00001 ? this.quiet + 1 : 0;
          if (this.quiet === 128) {
            this.ready = true;
            this.start = [-1, -1]; this.last = [-1, -1];
            this.port.postMessage({ ready: true, peak, samples: this.blocks * 128 });
          }
        }
        return true;
      }
    } registerProcessor(${JSON.stringify(name)}, Probe);`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const tap = new AudioWorkletNode(ctx, name, { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
    const durations: number[][] = [[], []];
    let silencePeak = -1;
    let samples = 0;
    const started = performance.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`audio duration capture: ${JSON.stringify({ durations, samples, elapsedMs: performance.now() - started })}`)), 15000);
        tap.port.onmessage = ({ data }) => {
          if (data.ready) {
            silencePeak = data.peak;
            samples = data.samples;
            durations[0] = []; durations[1] = [];
            w.__ydoc.transact(() => { w.__patch.nodes.tl.params.running = 1; });
          } else if (samples > 0) {
            durations[data.ch]!.push(data.duration);
            if (durations.every((v) => v.length >= count)) { clearTimeout(timer); resolve(); }
          }
        };
        ports.forEach((port, i) => port!.node.connect(tap, port!.output, i));
        tap.connect(ctx.destination);
      });
      return { durations: durations.map((d) => d.slice(0, count)), silencePeak, samples, elapsedMs: performance.now() - started };
    } finally {
      w.__ydoc.transact(() => { w.__patch.nodes.tl.params.running = 0; });
      ports.forEach((port, i) => port!.node.disconnect(tap, port!.output, i));
      tap.disconnect(); tap.port.close();
    }
  }, notes);
}

async function notes(page: Page): Promise<RecordedNote[]> {
  return page.evaluate(() => (window as unknown as TestWindow).__patch.nodes.cp.data.clips['0'].steps);
}

test('Shift-click ties selected notes into a solid, audible held bar', async ({ page, rack, errorWatch }, info) => {
  await buildChain(page);
  const tile = page.locator('.svelte-flow__node[data-id="cp"] [data-testid="module-shell"]');
  await tile.getByTestId('shell-open-dock').click();
  const pane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="cp"]');
  await pane.getByTestId('faceplate-tab-editor').click();
  const roll = pane.getByTestId('clipplayer-pianoroll');
  const cell = (step: number) => roll.getByTestId(`clipplayer-cell-28-${step}`);
  await cell(2).click();
  await cell(5).click();
  await cell(2).click(); // Select an existing note without deleting it.
  expect(await notes(page)).toHaveLength(2);
  await cell(5).click({ modifiers: ['Shift'] });
  expect(await notes(page)).toEqual([expect.objectContaining({ step: 2, lengthSteps: 4 })]);
  for (let step = 2; step < 6; step++) await expect(cell(step)).toHaveAttribute('data-note-start', '2');
  for (let step = 2; step < 5; step++) {
    const a = await cell(step).boundingBox();
    const b = await cell(step + 1).boundingBox();
    expect(Math.abs(a!.x + a!.width - b!.x), 'held cells meet without grid gaps').toBeLessThan(0.5);
    await expect(cell(step)).toHaveCSS('border-right-width', '0px');
  }
  await roll.screenshot({ path: info.outputPath('held-note-bar.png') });
  const audio = await playbackDurations(page, 1);
  expect(audio.samples).toBeGreaterThan(0);
  expect(audio.silencePeak, JSON.stringify(audio)).toBeLessThan(0.00001);
  for (const channel of audio.durations) expect(channel[0], JSON.stringify(audio)).toBeCloseTo(0.998, 1);
  await cell(3).click({ modifiers: ['Shift'] });
  expect((await notes(page))[0].lengthSteps).toBe(2);
  const velocity = (await notes(page))[0] as RecordedNote & { velocity: number };
  await cell(2).click({ modifiers: ['Alt'] });
  expect((await notes(page))[0]).not.toEqual(velocity);
  await cell(3).click(); // Any part of the selected bar erases its onset.
  expect(await notes(page)).toHaveLength(0);
});

test('KEYS records exact holds and stabs, replaying their lengths through mono and poly voices', async ({ page, rack, errorWatch }) => {
  test.setTimeout(60000);
  await buildChain(page);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__launchpadTestInstallSingle('cp'))).toBe(true);
  const captured = await page.evaluate(async () => {
    const w = window as unknown as TestWindow;
    const sim = w.__launchpadSingleSim;
    const engine = w.__engine();
    const ctx = engine.getDomain('audio').ctx;
    const waitUntil = (condition: () => boolean) => new Promise<void>((resolve, reject) => {
      const start = performance.now();
      const frame = () => {
        if (condition()) resolve();
        else if (performance.now() - start > 10000) reject(new Error('Recording condition did not arrive'));
        else requestAnimationFrame(frame);
      };
      frame();
    });
    sim.cc(59, 127); sim.cc(59, 0);
    await waitUntil(() => sim.state().mode === 'keys');
    sim.press(2, 0); sim.release(2, 0); // Overdub keeps the recording open.
    sim.press(1, 0); sim.release(1, 0); // Queue record starts transport.
    const elapsed: { min: number; max: number }[] = [];
    for (const [step, hold] of [[2, 0.35], [6, 0.075]]) {
      await waitUntil(() => engine.read(w.__patch.nodes.cp, 'currentStep:0') === step);
      const start = ctx.currentTime;
      // Capture timestamps are sampled inside the synchronous MIDI handlers.
      // Bracket each dispatch: measuring only before it wrongly counts setup
      // work as held time, which varies under CI load.
      const onBefore = performance.now();
      sim.press(0, 1);
      const onAfter = performance.now();
      await waitUntil(() => ctx.currentTime - start >= hold);
      const offBefore = performance.now();
      sim.release(0, 1);
      const offAfter = performance.now();
      elapsed.push({ min: (offBefore - onAfter) / 1000, max: (offAfter - onBefore) / 1000 });
    }
    sim.press(0, 0); sim.release(0, 0); // Finish the take.
    w.__ydoc.transact(() => { w.__patch.nodes.tl.params.running = 0; });
    return { elapsed, steps: JSON.parse(JSON.stringify(w.__patch.nodes.cp.data.clips['0'].steps)) as RecordedNote[] };
  });
  expect(captured.steps).toHaveLength(2);
  captured.steps.forEach((note, i) => {
    const seconds = note.gateLen! * 0.25;
    const bounds = captured.elapsed[i];
    expect(seconds, JSON.stringify({ note, bounds })).toBeGreaterThanOrEqual(bounds.min - 1e-9);
    expect(seconds, JSON.stringify({ note, bounds })).toBeLessThanOrEqual(bounds.max + 1e-9);
  });
  const actual = await playbackDurations(page, 2);
  expect(actual.samples).toBeGreaterThan(0);
  expect(actual.silencePeak, JSON.stringify(actual)).toBeLessThan(0.00001);
  for (const channel of actual.durations) {
    channel.forEach((duration, i) => expect(Math.abs(duration - captured.steps[i].gateLen! * 0.25), JSON.stringify(actual)).toBeLessThan(0.025));
  }
  // Permanent defect control: strip capture metadata to exercise the old GATE duty behavior.
  await page.evaluate(() => {
    const w = window as unknown as TestWindow;
    w.__ydoc.transact(() => {
      const clip = w.__patch.nodes.cp.data.clips['0'];
      clip.steps = clip.steps.map(({ gateLen: _duration, ...note }: RecordedNote) => note);
    });
  });
  const legacy = await playbackDurations(page, 2);
  for (const channel of legacy.durations) channel.forEach((duration, i) => {
    const steps = captured.steps[i].lengthSteps;
    const expected = steps > 1 ? steps * 0.25 - 0.002 : 0.025;
    expect(Math.abs(duration - expected), JSON.stringify(legacy)).toBeLessThan(0.015);
  });
  expect(Math.abs(actual.durations[0][0] - legacy.durations[0][0]), 'probe distinguishes captured duration from legacy duty').toBeGreaterThan(0.04);
});
