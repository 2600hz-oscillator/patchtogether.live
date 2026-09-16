import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface Chunk { l: Float32Array; r: Float32Array; channels: number }
interface Tap {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
  process: (inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) => boolean;
}
let TapProcessor: new () => Tap;
beforeAll(async () => {
  vi.stubGlobal('AudioWorkletProcessor', class {
    port = { onmessage: () => {}, postMessage: vi.fn() };
  });
  vi.stubGlobal('registerProcessor', (_name: string, ctor: new () => Tap) => { TapProcessor = ctor; });
  // @ts-expect-error the shipping worklet registers itself; it exports no module
  await import('./samsloop-tap');
});
afterAll(() => vi.unstubAllGlobals());

function capture(inputs: Float32Array[][], enabled = true): Chunk | undefined {
  const tap = new TapProcessor();
  tap.port.onmessage({ data: { type: 'enable', enabled } });
  expect(tap.process(inputs, [], {})).toBe(true);
  return tap.port.postMessage.mock.calls[0]?.[0] as Chunk | undefined;
}

describe('the shipping SAMSLOOP record tap', () => {
  const left = new Float32Array([0.25, -0.5, 0]);
  const right = new Float32Array([-0.75, 0.125, 1]);
  it('does not capture disabled or unwired inputs', () => {
    expect(capture([[left], [right]], false)).toBeUndefined();
    expect(capture([[], []])).toBeUndefined();
  });
  it('normalizes an absent right input from left, copying the buffers', () => {
    const chunk = capture([[left], []])!;
    expect(chunk.l).toEqual(left);
    expect(chunk.r).toEqual(left);
    expect(chunk.l).not.toBe(left);
    expect(chunk.r).not.toBe(left);
    expect(chunk.channels).toBe(1);
  });
  it('records right-only input with a silent left channel', () => {
    const chunk = capture([[], [right]])!;
    expect(chunk.l).toEqual(new Float32Array(right.length));
    expect(chunk.r).toEqual(right);
    expect(chunk.channels).toBe(2);
  });
  it('preserves distinct stereo channels and connected silence', () => {
    const chunk = capture([[left], [right]])!;
    expect(chunk.l).toEqual(left);
    expect(chunk.r).toEqual(right);
    expect(capture([[new Float32Array(128)], []])?.l.length).toBe(128);
  });
});
