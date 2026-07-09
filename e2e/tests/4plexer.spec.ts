// e2e/tests/4plexer.spec.ts
//
// End-to-end coverage for 4PLEXER — 4-in / 4-out discrete signal router
// with a per-output gate-advanced selector.
//
// Strategy:
//   * A JOYSTICK gives four distinguishable DC levels (x=+0.3, y=+0.7,
//     nx=-0.3, ny=-0.7) — patched into in1..in4. Each 4PLEXER output goes
//     into a SCOPE channel; we read the DC level back via the engine's
//     read(node,'snapshot') interface and assert it matches the SELECTED
//     input. This proves discrete routing (no blend).
//   * A second JOYSTICK acts as a manual GATE source: flipping pos_x 0→1
//     produces a single rising edge into a 4PLEXER gate input; we assert
//     that output advances to the next input, and that 4 pulses wrap back
//     (4→1).
//   * Independence: each output carries its own selection + responds only
//     to its own gate.
//   * Audio source: an ANALOG VCO sine into in1 routes through to the
//     output as audible (non-zero RMS) signal, proving audio AND cv both
//     patch + route identically.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface ChStats { peak: number; rms: number; mean: number; nonzero: number; total: number; }

/** Read one scope channel's summarised stats. ch is 'ch1' | 'ch2'. */
async function readScopeChannel(page: Page, scopeNodeId: string, ch: 'ch1' | 'ch2'): Promise<ChStats> {
  return await page.evaluate(({ id, ch }) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    function summarize(buf: Float32Array | undefined): { peak: number; rms: number; mean: number; nonzero: number; total: number } {
      if (!buf) return { peak: 0, rms: 0, mean: 0, nonzero: 0, total: 0 };
      let peak = 0, energy = 0, sum = 0, nonzero = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        energy += v * v;
        sum += v;
        if (a > 1e-5) nonzero++;
      }
      return {
        peak,
        rms: Math.sqrt(energy / Math.max(1, buf.length)),
        mean: sum / Math.max(1, buf.length),
        nonzero,
        total: buf.length,
      };
    }
    const eng = w.__engine?.();
    if (!eng) return summarize(undefined);
    const node = w.__patch.nodes[id];
    if (!node) return summarize(undefined);
    const snap = eng.read(node, 'snapshot') as { ch1: Float32Array; ch2: Float32Array } | undefined;
    if (!snap) return summarize(undefined);
    return summarize(ch === 'ch1' ? snap.ch1 : snap.ch2);
  }, { id: scopeNodeId, ch });
}

/** Set a node param at runtime (mirrors the UI knob → store write). */
async function setParam(page: Page, nodeId: string, key: string, value: number): Promise<void> {
  await page.evaluate(({ id, key, value }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (n) n.params[key] = value;
    });
  }, { id: nodeId, key, value });
}

async function readParam(page: Page, nodeId: string, key: string): Promise<number | null> {
  return await page.evaluate(({ id, key }) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        readParam: (node: { id: string; type: string; domain: string }, paramId: string) => number | undefined;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const v = eng.readParam(node, key);
    return typeof v === 'number' ? v : null;
  }, { id: nodeId, key });
}

/** Fire one rising-edge gate pulse from a JOYSTICK's `x` output by toggling
 *  its pos_x 0 → 1 → 0. The worklet edge-detects the 0→1 crossing. */
async function fireGate(page: Page, joyNodeId: string): Promise<void> {
  await setParam(page, joyNodeId, 'pos_x', 0);
  await page.waitForTimeout(40);
  await setParam(page, joyNodeId, 'pos_x', 1);
  await page.waitForTimeout(60);
  await setParam(page, joyNodeId, 'pos_x', 0);
  await page.waitForTimeout(40);
}

test('4PLEXER routes the SELECTED input to each output (discrete, cv source)', async ({ page, rack, errorWatch }) => {
  // JOYSTICK: x=+0.3, y=+0.7, nx=-0.3, ny=-0.7 → four distinguishable DCs.
  await spawnPatch(
    page,
    [
      { id: 'joy', type: 'joystick',   position: { x: 40,  y: 60 },  params: { pos_x: 0.3, pos_y: 0.7 } },
      { id: 'plx', type: 'fourplexer', position: { x: 360, y: 60 },  params: { sel1: 0, sel2: 1, sel3: 2, sel4: 3 } },
      { id: 'sc1', type: 'scope',      position: { x: 720, y: 60 } },
      { id: 'out', type: 'audioOut',   position: { x: 1080, y: 60 }, params: { master: 0 } },
    ],
    [
      { id: 'i1', from: { nodeId: 'joy', portId: 'x'  }, to: { nodeId: 'plx', portId: 'in1' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'i2', from: { nodeId: 'joy', portId: 'y'  }, to: { nodeId: 'plx', portId: 'in2' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'i3', from: { nodeId: 'joy', portId: 'nx' }, to: { nodeId: 'plx', portId: 'in3' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'i4', from: { nodeId: 'joy', portId: 'ny' }, to: { nodeId: 'plx', portId: 'in4' }, sourceType: 'cv', targetType: 'cv' },
      // out1 → scope ch1 so we can read whatever out1 currently carries.
      { id: 'o1', from: { nodeId: 'plx', portId: 'out1' }, to: { nodeId: 'sc1', portId: 'ch1' }, sourceType: 'cv', targetType: 'audio' },
      // Keep the graph pulled by Web Audio: scope.ch1_out → audioOut.L.
      // master=0 so nothing is actually audible during the test.
      { id: 'oo', from: { nodeId: 'sc1', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await page.waitForTimeout(500);

  const levels = [0.3, 0.7, -0.3, -0.7]; // in1..in4
  // Sweep out1's selector through all four inputs; the scope's DC mean must
  // track the selected input's level (within tolerance — declick + analyser
  // averaging).
  for (let sel = 0; sel < 4; sel++) {
    await setParam(page, 'plx', 'sel1', sel);
    await page.waitForTimeout(250);
    const st = await readScopeChannel(page, 'sc1', 'ch1');
    expect(
      Math.abs(st.mean - levels[sel]),
      `sel1=${sel}: out1 mean ${st.mean.toFixed(3)} should ≈ in${sel + 1} level ${levels[sel]}`,
    ).toBeLessThan(0.08);
  }

});

test('4PLEXER gate advances a selector to the next input and wraps 4→1', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'joy', type: 'joystick',   position: { x: 40,  y: 60 },  params: { pos_x: 0.3, pos_y: 0.7 } },
      { id: 'gj',  type: 'joystick',   position: { x: 40,  y: 300 }, params: { pos_x: 0 } },
      { id: 'plx', type: 'fourplexer', position: { x: 360, y: 60 },  params: { sel1: 0, sel2: 1, sel3: 2, sel4: 3 } },
      { id: 'sc1', type: 'scope',      position: { x: 720, y: 60 } },
      { id: 'out', type: 'audioOut',   position: { x: 1080, y: 60 }, params: { master: 0 } },
    ],
    [
      { id: 'i1', from: { nodeId: 'joy', portId: 'x'  }, to: { nodeId: 'plx', portId: 'in1' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'i2', from: { nodeId: 'joy', portId: 'y'  }, to: { nodeId: 'plx', portId: 'in2' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'i3', from: { nodeId: 'joy', portId: 'nx' }, to: { nodeId: 'plx', portId: 'in3' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'i4', from: { nodeId: 'joy', portId: 'ny' }, to: { nodeId: 'plx', portId: 'in4' }, sourceType: 'cv', targetType: 'cv' },
      // Gate source → out1's gate input.
      { id: 'g1', from: { nodeId: 'gj', portId: 'x' }, to: { nodeId: 'plx', portId: 'gate1' }, sourceType: 'cv', targetType: 'gate' },
      { id: 'o1', from: { nodeId: 'plx', portId: 'out1' }, to: { nodeId: 'sc1', portId: 'ch1' }, sourceType: 'cv', targetType: 'audio' },
      // Keep the graph pulled (master=0 → silent).
      { id: 'oo', from: { nodeId: 'sc1', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await page.waitForTimeout(500);

  // out1 starts on in1 (sel1=0, level +0.3).
  let st = await readScopeChannel(page, 'sc1', 'ch1');
  expect(Math.abs(st.mean - 0.3), `start: out1 carries in1 (+0.3), got ${st.mean.toFixed(3)}`).toBeLessThan(0.08);

  // One gate pulse → advance to in2 (+0.7). The worklet posts the new
  // selector back into the param so it persists like a UI click.
  await fireGate(page, 'gj');
  await page.waitForTimeout(250);
  st = await readScopeChannel(page, 'sc1', 'ch1');
  expect(Math.abs(st.mean - 0.7), `after 1 pulse: out1 carries in2 (+0.7), got ${st.mean.toFixed(3)}`).toBeLessThan(0.08);
  expect(await readParam(page, 'plx', 'sel1'), 'sel1 persisted as 1').toBe(1);

  // Three more pulses → in3 (-0.3), in4 (-0.7), then wrap to in1 (+0.3).
  await fireGate(page, 'gj');
  await page.waitForTimeout(250);
  st = await readScopeChannel(page, 'sc1', 'ch1');
  expect(Math.abs(st.mean - (-0.3)), `after 2 pulses: out1 carries in3 (-0.3), got ${st.mean.toFixed(3)}`).toBeLessThan(0.08);

  await fireGate(page, 'gj');
  await page.waitForTimeout(250);
  st = await readScopeChannel(page, 'sc1', 'ch1');
  expect(Math.abs(st.mean - (-0.7)), `after 3 pulses: out1 carries in4 (-0.7), got ${st.mean.toFixed(3)}`).toBeLessThan(0.08);

  // Fourth pulse wraps back to in1.
  await fireGate(page, 'gj');
  await page.waitForTimeout(250);
  st = await readScopeChannel(page, 'sc1', 'ch1');
  expect(Math.abs(st.mean - 0.3), `after 4 pulses (wrap): out1 back to in1 (+0.3), got ${st.mean.toFixed(3)}`).toBeLessThan(0.08);
  expect(await readParam(page, 'plx', 'sel1'), 'sel1 wrapped to 0').toBe(0);

});

test('4PLEXER outputs are independent (own selection + own gate)', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'joy', type: 'joystick',   position: { x: 40,  y: 60 },  params: { pos_x: 0.3, pos_y: 0.7 } },
      { id: 'gj',  type: 'joystick',   position: { x: 40,  y: 300 }, params: { pos_x: 0 } },
      // out1 selects in2 (+0.7), out2 selects in4 (-0.7) — distinct.
      { id: 'plx', type: 'fourplexer', position: { x: 360, y: 60 },  params: { sel1: 1, sel2: 3, sel3: 2, sel4: 3 } },
      { id: 'sc1', type: 'scope',      position: { x: 720, y: 60 } },
      { id: 'out', type: 'audioOut',   position: { x: 1080, y: 60 }, params: { master: 0 } },
    ],
    [
      { id: 'i1', from: { nodeId: 'joy', portId: 'x'  }, to: { nodeId: 'plx', portId: 'in1' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'i2', from: { nodeId: 'joy', portId: 'y'  }, to: { nodeId: 'plx', portId: 'in2' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'i3', from: { nodeId: 'joy', portId: 'nx' }, to: { nodeId: 'plx', portId: 'in3' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'i4', from: { nodeId: 'joy', portId: 'ny' }, to: { nodeId: 'plx', portId: 'in4' }, sourceType: 'cv', targetType: 'cv' },
      // Gate source → out2's gate only (gate2). out1 must NOT move.
      { id: 'g2', from: { nodeId: 'gj', portId: 'x' }, to: { nodeId: 'plx', portId: 'gate2' }, sourceType: 'cv', targetType: 'gate' },
      // out1 → scope ch1, out2 → scope ch2 (read both simultaneously).
      { id: 'o1', from: { nodeId: 'plx', portId: 'out1' }, to: { nodeId: 'sc1', portId: 'ch1' }, sourceType: 'cv', targetType: 'audio' },
      { id: 'o2', from: { nodeId: 'plx', portId: 'out2' }, to: { nodeId: 'sc1', portId: 'ch2' }, sourceType: 'cv', targetType: 'audio' },
      // Keep the graph pulled — both scope channels → audioOut (master=0).
      { id: 'oL', from: { nodeId: 'sc1', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'oR', from: { nodeId: 'sc1', portId: 'ch2_out' }, to: { nodeId: 'out', portId: 'R' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await page.waitForTimeout(500);

  // Initial: out1=in2 (+0.7), out2=in4 (-0.7).
  let c1 = await readScopeChannel(page, 'sc1', 'ch1');
  let c2 = await readScopeChannel(page, 'sc1', 'ch2');
  expect(Math.abs(c1.mean - 0.7), `out1 = in2 (+0.7), got ${c1.mean.toFixed(3)}`).toBeLessThan(0.08);
  expect(Math.abs(c2.mean - (-0.7)), `out2 = in4 (-0.7), got ${c2.mean.toFixed(3)}`).toBeLessThan(0.08);

  // Fire gate2: out2 advances in4 → in1 (wrap, +0.3); out1 stays on in2.
  await fireGate(page, 'gj');
  await page.waitForTimeout(250);
  c1 = await readScopeChannel(page, 'sc1', 'ch1');
  c2 = await readScopeChannel(page, 'sc1', 'ch2');
  expect(Math.abs(c1.mean - 0.7), `out1 UNCHANGED on in2 (+0.7), got ${c1.mean.toFixed(3)}`).toBeLessThan(0.08);
  expect(Math.abs(c2.mean - 0.3), `out2 advanced to in1 (+0.3), got ${c2.mean.toFixed(3)}`).toBeLessThan(0.08);
  expect(await readParam(page, 'plx', 'sel1'), 'sel1 untouched by gate2').toBe(1);
  expect(await readParam(page, 'plx', 'sel2'), 'sel2 advanced 3→0').toBe(0);

});

test('4PLEXER routes an AUDIO source identically to a CV source', async ({ page, rack, errorWatch }) => {
  // NOISE white into in1; in2 left silent. Selecting in1 ⇒ audible
  // (non-zero RMS); selecting the silent in2 ⇒ ~silence. Proves an AUDIO
  // cable patches + routes through the same path the CV cables use above.
  await spawnPatch(
    page,
    [
      { id: 'noi', type: 'noise',      position: { x: 40,  y: 60 },  params: { level: 0.5 } },
      { id: 'plx', type: 'fourplexer', position: { x: 360, y: 60 },  params: { sel1: 0 } },
      { id: 'sc1', type: 'scope',      position: { x: 720, y: 60 } },
      { id: 'out', type: 'audioOut',   position: { x: 720, y: 300 }, params: { master: 0.3 } },
    ],
    [
      // AUDIO cable into a 4PLEXER signal input.
      { id: 'a1', from: { nodeId: 'noi', portId: 'white' }, to: { nodeId: 'plx', portId: 'in1' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'o1', from: { nodeId: 'plx', portId: 'out1' }, to: { nodeId: 'sc1', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'oo', from: { nodeId: 'sc1', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await page.waitForTimeout(600);

  // sel1=0 → out1 carries the noise: audible.
  await setParam(page, 'plx', 'sel1', 0);
  await page.waitForTimeout(300);
  let st = await readScopeChannel(page, 'sc1', 'ch1');
  expect(st.rms, `out1=in1 (white noise) should be audible, rms=${st.rms.toFixed(4)}`).toBeGreaterThan(0.02);
  expect(st.nonzero, 'noise produces many non-zero samples').toBeGreaterThan(50);

  // sel1=1 → out1 carries the unpatched (silent) in2: near-silence.
  await setParam(page, 'plx', 'sel1', 1);
  await page.waitForTimeout(300);
  st = await readScopeChannel(page, 'sc1', 'ch1');
  expect(st.rms, `out1=in2 (unpatched) should be silent, rms=${st.rms.toFixed(4)}`).toBeLessThan(0.01);

});
