// Exercise the registered worklet itself, including its five input indices,
// parameter/message seam and telemetry. The pure engine tests cannot detect a
// miswired worklet wrapper; real factory/cable coverage lives in web/e2e.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface State {
  type: 'state';
  position: number;
  playing: boolean;
  loop: boolean;
  reverse: boolean;
  modeRevision: number;
  effectiveLength: number;
  lengthCvPatched: boolean;
}

interface Processor {
  port: {
    onmessage: (event: { data: unknown }) => void;
    postMessage: ReturnType<typeof vi.fn>;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

type ProcessorConstructor = (new () => Processor) & {
  parameterDescriptors: { name: string; defaultValue: number; minValue: number; maxValue: number }[];
};

let PhasesProcessor: ProcessorConstructor;
const SAMPLE_RATE = 48000;
const FRAMES = 128;

beforeAll(async () => {
  vi.stubGlobal('sampleRate', SAMPLE_RATE);
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { onmessage: null, postMessage: vi.fn() };
  });
  vi.stubGlobal('registerProcessor', (name: string, constructor: ProcessorConstructor) => {
    expect(name).toBe('phases');
    PhasesProcessor = constructor;
  });
  await import('./phases');
});

afterAll(() => vi.unstubAllGlobals());

function send(processor: Processor, data: unknown): void { processor.port.onmessage({ data }); }
function state(processor: Processor): State { return processor.port.postMessage.mock.calls.at(-1)![0] as State; }

function processor(): Processor {
  const result = new PhasesProcessor();
  send(result, { type: 'vertices', vertices: [{ x: 0, y: 0, shape: 0 }, { x: 1, y: 1, shape: 0 }] });
  return result;
}

function render(
  processor: Processor,
  inputs: Float32Array[][] = [],
  overrides: Record<string, number> = {},
): Float32Array {
  const parameters: Record<string, Float32Array> = {};
  for (const descriptor of PhasesProcessor.parameterDescriptors) {
    parameters[descriptor.name] = new Float32Array([overrides[descriptor.name] ?? descriptor.defaultValue]);
  }
  const output = new Float32Array(FRAMES);
  expect(processor.process(inputs, [[output]], parameters)).toBe(true);
  return output;
}

function signal(value: number): Float32Array[] { return [new Float32Array(FRAMES).fill(value)]; }

describe('Phases registered worklet', () => {
  it('has matching physical Length bounds and stays idle until stimulated', () => {
    expect(PhasesProcessor.parameterDescriptors.find((p) => p.name === 'length')).toMatchObject({ defaultValue: 0.05, minValue: 0.05, maxValue: 30 });
    const p = processor();
    expect([...render(p)]).toEqual(Array(FRAMES).fill(0));
    expect(state(p)).toMatchObject({ position: 0, playing: false, loop: false, reverse: false, lengthCvPatched: false });
  });

  it('catches a Trigger edge inside a block and does not retrigger a held gate across blocks', () => {
    const p = processor();
    const control = processor();
    const gate = new Float32Array(FRAMES);
    gate.fill(1, 47);
    const output = render(p, [[gate]]);
    expect(output.slice(0, 48).every((v) => v === 0)).toBe(true);
    expect(output[48]).toBeCloseTo(1 / (SAMPLE_RATE * 0.05), 8);
    const following = render(p, [signal(1)]);
    expect(following[0]).toBeCloseTo((FRAMES - 47) / (SAMPLE_RATE * 0.05), 7);
    expect(render(control).every((v) => v === 0)).toBe(true);
  });

  it('distinguishes patched zero on input 4 from an absent Length CV input', () => {
    const patched = processor();
    const unpatched = processor();
    const fast = render(patched, [signal(1), [], [], [], signal(0)], { length: 30 });
    const slow = render(unpatched, [signal(1)], { length: 30 });
    expect(fast[1]! / slow[1]!).toBeCloseTo(600, 3);
    expect(state(patched)).toMatchObject({ effectiveLength: 0.05, lengthCvPatched: true });
    expect(state(unpatched)).toMatchObject({ effectiveLength: 30, lengthCvPatched: false });
  });

  it('reads Length CV per sample without jumping the playhead when CV changes', () => {
    const p = processor();
    const cv = new Float32Array(FRAMES).fill(1);
    cv.fill(0, 64);
    const output = render(p, [signal(1), [], [], [], [cv]], { length: 2 });
    expect(output[64]).toBeCloseTo(64 / (SAMPLE_RATE * 30), 8);
    expect(output[65]! - output[64]!).toBeCloseTo(1 / (SAMPLE_RATE * 0.05), 8);
    expect(state(p)).toMatchObject({ effectiveLength: 0.05, lengthCvPatched: true });
  });

  it('uses input 1 for Phase Trigger and honors reverse before a manual full Trigger', () => {
    const p = processor();
    send(p, { type: 'vertices', vertices: [
      { x: 0, y: 0, shape: 0 }, { x: 0.5, y: 1, shape: 0 }, { x: 1, y: 0.2, shape: 0 },
    ] });
    send(p, { type: 'trigger' });
    const reverseStart = render(p, [], { reverse: 1 });
    expect(reverseStart[0]).toBeCloseTo(0.2);
    expect(reverseStart[1]).toBeGreaterThan(reverseStart[0]!);
    const phase = render(p, [[], signal(1)], { reverse: 1 });
    expect(phase[0]).toBeCloseTo(0.2);
    render(p, [], { reverse: 1 });
    send(p, { type: 'phase-trigger' });
    expect(render(p, [], { reverse: 1 })[0]).toBeCloseTo(0.2);
  });

  it('keeps gate-toggled modes across unchanged AudioParams and accepts same-value manual mode requests', () => {
    const p = processor();
    render(p, [signal(1), [], signal(1), signal(1)]);
    expect(state(p)).toMatchObject({ loop: true, reverse: true });
    const held = render(p, [signal(1), [], signal(1), signal(1)]);
    expect(held[1]).toBeLessThan(held[0]!);
    send(p, { type: 'mode', name: 'loop', value: false });
    send(p, { type: 'mode', name: 'reverse', value: false });
    const manual = render(p, [signal(1), [], signal(1), signal(1)]);
    expect(state(p)).toMatchObject({ loop: false, reverse: false });
    expect(manual[1]).toBeGreaterThan(manual[0]!);
    // These are real AudioParam changes, which remain absolute manual modes.
    send(p, { type: 'trigger' });
    render(p, [], { loop: 1, reverse: 1 });
    expect(state(p)).toMatchObject({ loop: true, reverse: true });
  });

  it('resolves simultaneous Reverse gates before manual audition, even with Trigger already held', () => {
    const p = processor();
    render(p, [signal(1)]);
    send(p, { type: 'trigger' });
    const reversed = render(p, [signal(1), [], [], signal(1)]);
    expect(reversed[0]).toBe(1);
    expect(reversed[1]).toBeLessThan(reversed[0]!);
    expect(state(p)).toMatchObject({ playing: true, reverse: true });
    // Another manual trigger is independent of both held-high input latches.
    send(p, { type: 'trigger' });
    expect(render(p, [signal(1), [], [], signal(1)])[0]).toBe(1);
  });

  it('acknowledges monotonically revised manual modes and does not replay an older command', () => {
    const p = processor();
    render(p);
    expect(state(p).modeRevision).toBe(0);
    send(p, { type: 'mode', name: 'loop', value: true, revision: 1 });
    send(p, { type: 'mode', name: 'reverse', value: true, revision: 2 });
    render(p);
    expect(state(p)).toMatchObject({ loop: true, reverse: true, modeRevision: 2 });
    // A delayed/repeated older intent cannot replace a newer effective mode.
    send(p, { type: 'mode', name: 'reverse', value: false, revision: 1 });
    send(p, { type: 'trigger' });
    expect(render(p)[0]).toBe(1);
    expect(state(p)).toMatchObject({ reverse: true, modeRevision: 2 });
    send(p, { type: 'mode', name: 'loop', value: false, revision: 3 });
    render(p);
    expect(state(p)).toMatchObject({ loop: false, reverse: true, modeRevision: 3 });
  });

  it('starts cycling from the Loop control alone and maps bipolar output without changing geometry', () => {
    const p = processor();
    const unipolar = render(p, [], { loop: 1 });
    expect(unipolar[0]).toBe(0);
    expect(unipolar[1]).toBeGreaterThan(0);
    const prior = state(p).position;
    const bipolar = render(p, [], { loop: 1, polarity: 1 });
    expect(bipolar[0]).toBeCloseTo(prior * 2 - 1, 7);
  });

  it('throttles playhead telemetry by rendered samples and stops cleanly on disposal', () => {
    const p = processor();
    for (let i = 0; i < 100; i++) render(p, [], { loop: 1, length: 2 });
    expect(p.port.postMessage.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(p.port.postMessage.mock.calls.length).toBeLessThanOrEqual(9);
    expect(state(p)).toMatchObject({ type: 'state', playing: true, loop: true, effectiveLength: 2 });
    send(p, { type: 'dispose' });
    const output = new Float32Array(FRAMES).fill(1);
    expect(p.process([], [[output]], {})).toBe(false);
    expect(output.every((v) => v === 0)).toBe(true);
  });
});
