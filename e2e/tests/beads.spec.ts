import { test, expect } from "./_fixtures";
import { spawnPatch } from "./_helpers";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "parallel" });

async function audio(page: Page, audible: boolean) {
  await page.waitForFunction(() => {
    const w = window as unknown as { __engine?: () => { getDomain: (d: string) => { getOutputNode: (id: string, port: string) => unknown } } };
    return !!w.__engine?.().getDomain("audio").getOutputNode("beads", "out_r");
  });
  return page.evaluate(async wantAudio => {
    type Ref = { node: AudioNode; output: number };
    const w = window as unknown as { __engine: () => { getDomain: (d: string) => { getOutputNode: (id: string, port: string) => Ref } } };
    const engine = w.__engine().getDomain("audio");
    const refs = [engine.getOutputNode("beads", "out_l"), engine.getOutputNode("beads", "out_r")];
    if (refs[0]!.node === refs[1]!.node && refs[0]!.output === refs[1]!.output) throw new Error("Stereo jacks share one edge");
    const probes = refs.map(ref => {
      const analyser = (ref.node.context as AudioContext).createAnalyser();
      analyser.fftSize = 2048;
      ref.node.connect(analyser, ref.output);
      return analyser;
    });
    const buffer = new Float32Array(2048);
    const peak = [0, 0];
    let samples = 0;
    const began = performance.now();
    const ctx = refs[0]!.node.context;
    const firstAudioTime = ctx.currentTime;
    try {
      while (performance.now() - began < 8000) {
        for (let ch = 0; ch < 2; ++ch) {
          probes[ch]!.getFloatTimeDomainData(buffer);
          let energy = 0;
          for (const value of buffer) energy += value * value;
          peak[ch] = Math.max(peak[ch]!, Math.sqrt(energy / buffer.length));
        }
        ++samples;
        if (wantAudio && peak.every(v => v > 0.005)) break;
        // Audio time defines the silence window. Wall time bounds failure.
        if (!wantAudio && ctx.currentTime - firstAudioTime >= 0.5) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!samples || ctx.currentTime <= firstAudioTime) throw new Error("Audio probe did not observe rendered audio");
      return { peak, samples, elapsedMs: performance.now() - began };
    } finally {
      refs.forEach((ref, i) => ref.node.disconnect(probes[i]!));
      probes.forEach(probe => probe.disconnect());
    }
  }, audible);
}

async function patch(page: Page, source: boolean, params: Record<string, number>) {
  await spawnPatch(page, [
    { id: "osc", type: "analogVco", position: { x: 40, y: 100 } },
    { id: "beads", type: "beads", position: { x: 320, y: 100 }, params },
    { id: "out", type: "audioOut", position: { x: 620, y: 100 }, params: { master: 0 } },
  ], [
    ...(source ? [{ id: "input", from: { nodeId: "osc", portId: "saw" }, to: { nodeId: "beads", portId: "in_l" }, sourceType: "audio" as const, targetType: "audio" as const }] : []),
    { id: "left", from: { nodeId: "beads", portId: "out_l" }, to: { nodeId: "out", portId: "L" }, sourceType: "audio", targetType: "audio" },
    { id: "right", from: { nodeId: "beads", portId: "out_r" }, to: { nodeId: "out", portId: "R" }, sourceType: "audio", targetType: "audio" },
  ]);
}

test("Beads real factory: silent audio buffer and audible stereo wet grains", async ({ page, rack }) => {
  void rack;
  const params = { source: 1, blend: 1, reverb: 0, time: 0.1, density: 0.1 };
  await patch(page, false, params);
  const silent = await audio(page, false);
  expect(Math.max(...silent.peak), JSON.stringify(silent)).toBeLessThan(1e-6);
  await patch(page, true, params);
  const grains = await audio(page, true);
  expect(Math.min(...grains.peak), JSON.stringify(grains)).toBeGreaterThan(0.005);
});

test("Beads default unpatched source renders the firmware wavetable voice", async ({ page, rack }) => {
  void rack;
  await patch(page, false, {});
  const sound = await audio(page, true);
  expect(Math.min(...sound.peak), JSON.stringify(sound)).toBeGreaterThan(0.005);
});

test("Beads face exposes its controls and credits Émilie Gillet", async ({ page, rack }, testInfo) => {
  void rack;
  await page.setViewportSize({ width: 1280, height: 1200 });
  await patch(page, false, {});
  const tile = page.locator('.svelte-flow__node[data-id="beads"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  const freeze = tile.getByTestId("control-freeze");
  await expect(freeze).toHaveAttribute("aria-checked", "false");
  await freeze.click();
  await expect(freeze).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } }).__patch.nodes.beads!.params.freeze)).toBe(1);
  await freeze.click();
  await tile.getByTestId("shell-open-dock").click();
  const dock = page.getByTestId("dock-full-view");
  await expect(dock.getByTestId("oss-attribution")).toContainText("Émilie Gillet");
  await expect(dock.getByTestId("control-time")).toBeVisible();
  for (const id of ["time_random", "size_random", "shape_random", "pitch_random"]) await expect(dock.getByTestId("control-" + id)).toBeVisible();
  for (const id of ["blend", "feedback", "reverb", "quality", "source", "mono"]) await expect(dock.getByTestId("control-" + id)).toBeVisible();
  await dock.screenshot({ path: testInfo.outputPath("beads-face.png") });
});
