import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BEADS_CONTROLS } from "./lib/beads-contract";
import type { BeadsProcessor } from "./beads";

let Processor: typeof BeadsProcessor;
let wasm: WebAssembly.Module;
beforeAll(async () => {
  Object.assign(globalThis, {
    sampleRate: 48000,
    AudioWorkletProcessor: class { port = { onmessage: null }; },
    registerProcessor: () => {},
  });
  Processor = (await import("./beads")).BeadsProcessor;
  wasm = new WebAssembly.Module(readFileSync(new URL("../dist/beads.wasm", import.meta.url)));
});

class Rack {
  readonly processor: BeadsProcessor;
  readonly params: Record<string, Float32Array>;
  frame = 0;
  constructor(readonly rate = 48000, overrides: Record<string, number> = {}) {
    Object.assign(globalThis, { sampleRate: rate });
    this.processor = new Processor({ processorOptions: { wasm, seed: 12345 } });
    this.params = Object.fromEntries(BEADS_CONTROLS.map(p => [p.id, new Float32Array([overrides[p.id] ?? p.defaultValue])]));
  }
  set(id: string, value: number) { this.params[id]![0] = value; }
  render(seconds: number, signal?: (frame: number, channel: number) => number, channels: number[] = [0]) {
    const length = Math.ceil(seconds * this.rate / 128) * 128;
    const result = [new Float32Array(length), new Float32Array(length)];
    const inputs: Float32Array[][] = Array.from({ length: 10 }, () => []);
    if (signal) for (const channel of channels) inputs[channel] = [new Float32Array(128)];
    const outputs = [[new Float32Array(128)], [new Float32Array(128)]];
    for (let block = 0; block < length; block += 128) {
      if (signal) for (const channel of channels) for (let i = 0; i < 128; ++i) inputs[channel]![0]![i] = signal(this.frame + i, channel);
      this.processor.process(inputs, outputs, this.params);
      for (let ch = 0; ch < 2; ++ch) result[ch]!.set(outputs[ch]![0]!, block);
      this.frame += 128;
    }
    for (const samples of result) expect(samples.every(Number.isFinite), "native output must remain finite").toBe(true);
    return result;
  }
}
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const difference = (a: Float32Array, b: Float32Array) => rms(a.map((v, i) => v - b[i]!));
const sine = (rate: number, frequency = 440) => (n: number) => 0.2 * Math.sin(2 * Math.PI * frequency * n / rate);
function frequency(x: Float32Array, rate: number) {
  let crossings = 0;
  for (let i = 1; i < x.length; ++i) if (x[i - 1]! <= 0 && x[i]! > 0) ++crossings;
  return crossings * rate / x.length;
}

describe("Beads official firmware host", () => {
  it("preserves every vendored source byte and needs no host imports", () => {
    const hashes = JSON.parse(readFileSync(new URL("./native/beads/upstream-sha256.json", import.meta.url), "utf8"));
    for (const [path, sha] of Object.entries(hashes)) {
      expect(createHash("sha256").update(readFileSync(new URL(`./native/beads/vendor/${path}`, import.meta.url))).digest("hex"), path).toBe(sha);
    }
    expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  });

  it.each([44100, 48000, 96000])("preserves native quality clocks at a %i Hz device rate", rate => {
    for (const quality of [0, 1, 2, 3]) {
      const rack = new Rack(rate, { source: 1, blend: 0, reverb: 0, quality });
      rack.render(0.2, sine(rate));
      const [l, r] = rack.render(0.4, sine(rate));
      expect(rms(l!), `quality ${quality}`).toBeGreaterThan(0.05);
      expect(frequency(l!, rate)).toBeCloseTo(440, -1);
      expect(difference(l!, r!)).toBeLessThan(1e-6);
    }
  });

  it("keeps distinct stereo dry channels and does not normal a connected silent R", () => {
    const rack = new Rack(48000, { source: 1, blend: 0, reverb: 0 });
    const source = (n: number, ch: number) => sine(48000, ch ? 880 : 440)(n);
    rack.render(0.2, source, [0, 1]);
    const [l, r] = rack.render(0.4, source, [0, 1]);
    expect(frequency(l!, 48000)).toBeCloseTo(440, -1);
    expect(frequency(r!, 48000)).toBeCloseTo(880, -1);
    expect(difference(l!, r!)).toBeGreaterThan(0.1);
    rack.render(0.2, (n, ch) => ch ? 0 : sine(48000)(n), [0, 1]);
    const silentRight = rack.render(0.2, (n, ch) => ch ? 0 : sine(48000)(n), [0, 1]);
    expect(rms(silentRight[0]!)).toBeGreaterThan(0.05);
    expect(rms(silentRight[1]!)).toBeLessThan(1e-7);
  });

  it("Auto follows input presence, including a connected zero signal, not signal amplitude", () => {
    const oscillator = new Rack();
    expect(rms(oscillator.render(0.5)[0]!)).toBeGreaterThan(0.01);
    const connectedSilence = new Rack();
    expect(rms(connectedSilence.render(0.5, () => 0)[0]!)).toBe(0);
    const effect = new Rack(48000, { source: 1 });
    expect(rms(effect.render(0.5)[0]!)).toBe(0);
  });

  it("renders real wet grains; held Freeze survives repeated writes and releases", () => {
    const rack = new Rack(48000, { source: 1, blend: 1, reverb: 0, density: 0.1, time: 0.15, size: 0.7 });
    rack.render(5, sine(48000));
    expect(rms(rack.render(0.5, sine(48000))[0]!)).toBeGreaterThan(0.01);
    rack.set("freeze", 1);
    rack.render(6);
    const held = rms(rack.render(0.5)[0]!);
    expect(held).toBeGreaterThan(0.01);
    rack.set("freeze", 1);
    expect(rms(rack.render(0.5)[0]!)).toBeGreaterThan(0.01);
    rack.set("freeze", 0);
    rack.render(6);
    expect(rms(rack.render(0.5)[0]!)).toBeLessThan(held / 100);
  });

  it("Seed accepts separate pulses and a held gate enables repeated grains", () => {
    const options = { source: 2, seed: 0, blend: 1, reverb: 0, density: 0.25, size: 0.6 };
    const noGate = new Rack(48000, options);
    expect(rms(noGate.render(1)[0]!)).toBe(0);
    const held = new Rack(48000, options);
    expect(rms(held.render(1, () => 1, [3])[0]!)).toBeGreaterThan(0.01);
    held.render(2);
    expect(rms(held.render(0.5)[0]!)).toBeLessThan(1e-6);
    const taps = new Rack(48000, { ...options, density: 0.5 });
    for (let i = 0; i < 3; ++i) {
      taps.render(0.006, () => 1, [3]);
      expect(rms(taps.render(0.2)[0]!)).toBeGreaterThan(0.005);
      taps.render(1);
      expect(rms(taps.render(0.2)[0]!)).toBeLessThan(1e-6);
    }
  });

  it("routes every native modulation jack, with zero-input controls", () => {
    function render(channel: number, value: number) {
      const rack = new Rack(48000, { source: 2, blend: 0.8, density: 0.2,
        time_random: 0.7, size_random: 0.7, shape_random: 0.7, pitch_random: 0.7 });
      return rack.render(0.6, () => value, [channel])[0]!;
    }
    for (const channel of [2, 5, 6, 7, 8, 9]) {
      const zero = render(channel, 0);
      expect(difference(zero, render(channel, 0))).toBe(0);
      expect(difference(zero, render(channel, 0.3)), `input ${channel}`).toBeGreaterThan(1e-4);
    }
  });

  it("Freeze gate holds and releases exactly like the persistent switch", () => {
    const options = { source: 1, blend: 1, reverb: 0, density: 0.1, time: 0.15, size: 0.7 };
    const switched = new Rack(48000, options);
    const gated = new Rack(48000, options);
    switched.render(5, sine(48000));
    gated.render(5, sine(48000));
    switched.set("freeze", 1);
    switched.render(6);
    gated.render(6, () => 1, [4]);
    const frozen = switched.render(0.5)[0]!;
    expect(rms(frozen)).toBeGreaterThan(0.01);
    expect(difference(frozen, gated.render(0.5, () => 1, [4])[0]!)).toBe(0);
    switched.set("freeze", 0);
    switched.render(6);
    gated.render(6, () => 0, [4]);
    const released = gated.render(0.5, () => 0, [4])[0]!;
    expect(rms(released)).toBeLessThan(1e-6);
    expect(difference(switched.render(0.5)[0]!, released)).toBe(0);
  });

  it("isolates native state and makes every sound control observable", () => {
    function render(overrides: Record<string, number> = {}) {
      const rack = new Rack(48000, { source: 2, blend: 0.8, density: 0.2, ...overrides });
      return rack.render(0.6)[0]!;
    }
    const original = render();
    expect(difference(original, render())).toBe(0); // determinism control
    for (const [id, value] of Object.entries({ time: 0.8, size: 0.2, shape: 0.9, pitch: 12, density: 0.8, blend: 0, feedback: 0.8, reverb: 0.8, time_random: 0.9, size_random: 0.9, shape_random: 0.9, pitch_random: 0.9, quality: 0 })) {
      expect(difference(original, render({ [id]: value })), id).toBeGreaterThan(1e-4);
    }
  });
});
