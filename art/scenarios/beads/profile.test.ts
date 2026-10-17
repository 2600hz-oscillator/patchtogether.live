// Audio fingerprints of the shipping worklet + native firmware, not a mirror.
// Auto wavetable startup and fully wet stereo grains are separate signatures.
// These bypass the browser factory; e2e/tests/beads.spec.ts covers that seam.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { pinAll, repoSourceSha, SAMPLE_RATE } from "../../setup/capture";
import type { BeadsProcessor } from "../../../packages/dsp/src/beads";

let Processor: typeof BeadsProcessor;
let wasm: WebAssembly.Module;
beforeAll(async () => {
  vi.stubGlobal("sampleRate", SAMPLE_RATE);
  vi.stubGlobal("AudioWorkletProcessor", class { port = { onmessage: null }; });
  vi.stubGlobal("registerProcessor", () => {});
  Processor = (await import("../../../packages/dsp/src/beads")).BeadsProcessor;
  wasm = new WebAssembly.Module(readFileSync(new URL("../../../packages/dsp/dist/beads.wasm", import.meta.url)));
});

afterAll(() => vi.unstubAllGlobals());

function render(wet: boolean): Record<string, Float32Array> {
  const processor = new Processor({ processorOptions: { wasm, seed: 12345 } });
  const overrides: Record<string, number> = wet
    ? { source: 1, blend: 1, density: 0.1, size: 0.7, time: 0.15 } : {};
  const params = Object.fromEntries(Processor.parameterDescriptors.map(p =>
    [p.name, new Float32Array([overrides[p.name] ?? p.defaultValue])]));
  const warmup = wet ? SAMPLE_RATE * 5 : 0;
  const length = SAMPLE_RATE; // One second; both lengths divide by 128 at 48 kHz.
  const result = [new Float32Array(length), new Float32Array(length)];
  const inputs: Float32Array[][] = Array.from({ length: 10 }, () => []);
  if (wet) { inputs[0] = [new Float32Array(128)]; inputs[1] = [new Float32Array(128)]; }
  const outputs = [[new Float32Array(128)], [new Float32Array(128)]];
  for (let frame = 0; frame < warmup + length; frame += 128) {
    if (wet) for (let i = 0; i < 128; ++i) {
      inputs[0][0][i] = 0.2 * Math.sin(2 * Math.PI * 220 * (frame + i) / SAMPLE_RATE);
      inputs[1][0][i] = 0.2 * Math.sin(2 * Math.PI * 330 * (frame + i) / SAMPLE_RATE);
    }
    processor.process(inputs, outputs, params);
    if (frame >= warmup) for (let ch = 0; ch < 2; ++ch) result[ch].set(outputs[ch][0], frame - warmup);
  }
  return { [wet ? "grains-left" : "wavetable-left"]: result[0],
    [wet ? "grains-right" : "wavetable-right"]: result[1] };
}
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe("ART Beads / original firmware audio profiles", () => {
  it("pins distinct stereo grain and default wavetable signatures", async () => {
    const buffers = { ...render(false), ...render(true) };
    for (const [id, buffer] of Object.entries(buffers)) {
      expect(buffer.every(Number.isFinite), id).toBe(true);
      expect(rms(buffer), id).toBeGreaterThan(0.005);
      expect(Math.max(...buffer.map(Math.abs)), id).toBeLessThan(1);
    }
    const left = buffers["grains-left"], right = buffers["grains-right"];
    expect(rms(left.map((v, i) => v - right[i]))).toBeGreaterThan(0.01);
    expect(render(false)).toEqual(render(false)); // deterministic re-render control

    const vendor = "packages/dsp/src/native/beads/vendor/";
    const hashes = JSON.parse(readFileSync(new URL("../../../packages/dsp/src/native/beads/upstream-sha256.json", import.meta.url), "utf8"));
    const sha = await repoSourceSha(
      "packages/dsp/src/beads.ts", "packages/dsp/src/lib/beads-contract.ts",
      "packages/dsp/src/native/beads/bridge.cc", "packages/dsp/scripts/build-beads.mjs",
      "packages/web/src/lib/audio/gate-trigger.ts",
      ...Object.keys(hashes).sort().map(path => vendor + path),
    );
    await pinAll("beads", sha, buffers);
  });
});
