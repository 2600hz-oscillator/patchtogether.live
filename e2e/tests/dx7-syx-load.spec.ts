// e2e/tests/dx7-syx-load.spec.ts
//
// Regression: "uploading a .syx makes every patch sound like the bundled
// E.PIANO 1". Root cause was that SYX-loaded voices live in the
// SyncedStore Y.Doc; reading them returns Yjs PROXY arrays that fail to
// structured-clone through `worklet.port.postMessage`, so the patch
// message never made it to the worklet.
//
// This spec uploads a self-contained synthesized 32-voice SYX cartridge
// (built in the page context — no filesystem fixture) into the live DX7
// card, selects two distinct uploaded patches, and asserts:
//   1. The preset selector dropdown surfaces all 32 named user voices.
//   2. The scope captures DIFFERENT waveforms when patch 1 and patch 16
//      are selected (proves different patches actually produce different
//      sounds, NOT a silent fall-back to E.PIANO 1).
//
// Self-contained fixture: we synthesize a SYX bank in-memory inside
// `page.evaluate` and feed it to the card's hidden file input via a
// DataTransfer-style File. No user-filesystem dependency.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'serial' });

/** Read scope channel-1 RMS via the dev __engine global. */
async function readScopeRms(page: Page, scopeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return 0;
    const node = w.__patch.nodes[id];
    if (!node) return 0;
    const snap = eng.read(node, 'snapshot') as { ch1?: Float32Array } | undefined;
    if (!snap || !snap.ch1) return 0;
    let s = 0;
    for (let i = 0; i < snap.ch1.length; i++) s += snap.ch1[i]! * snap.ch1[i]!;
    return Math.sqrt(s / snap.ch1.length);
  }, scopeId);
}

/** Read full scope channel-1 frame as number[]. */
async function readScopeFrame(page: Page, scopeId: string): Promise<number[]> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return [];
    const node = w.__patch.nodes[id];
    if (!node) return [];
    const snap = eng.read(node, 'snapshot') as { ch1?: Float32Array } | undefined;
    if (!snap || !snap.ch1) return [];
    return Array.from(snap.ch1);
  }, scopeId);
}

test('dx7: uploading a 32-voice SYX populates the dropdown + selecting different patches changes the audible waveform', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, isPlaying: 1, length: 4 } },
      { id: 'dx',  type: 'dx7',       params: { voiceCount: 5, level: 1.0 } },
      { id: 'scp', type: 'scope' },
      { id: 'out', type: 'audioOut' },
    ],
    [
      { id: 'poly-edge', from: { nodeId: 'seq', portId: 'pitch' },   to: { nodeId: 'dx',  portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'audio-tap', from: { nodeId: 'dx',  portId: 'out' },     to: { nodeId: 'scp', portId: 'ch1'  }, sourceType: 'audio',         targetType: 'audio'         },
      { id: 'audio-out', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L'    }, sourceType: 'audio',         targetType: 'audio'         },
    ],
  );

  // Drive a steady C4 through the sequencer.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['seq'];
      if (!t) return;
      if (!t.data) t.data = {};
      const steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
      (t.data as Record<string, unknown>).steps = steps;
    });
  });

  // Build a synthetic 32-voice SYX cartridge in-page (avoids filesystem
  // dependency). Each voice gets a distinct algorithm + distinct operator
  // ratios so the rendered audio is unambiguously different patch-to-patch.
  // Then upload it via the hidden file input on the DX7 card.
  await page.evaluate(() => {
    const out = new Uint8Array(4104);
    out[0] = 0xf0; out[1] = 0x43; out[2] = 0x00; out[3] = 0x09;
    out[4] = 0x20; out[5] = 0x00; out[4103] = 0xf7;
    const payload = out.subarray(6, 4102);
    for (let v = 0; v < 32; v++) {
      const base = v * 128;
      // Each voice: algo (v % 32), op6 stored first (idx 0) → op1 stored last
      // (idx 5). For varied sound, we set per-op coarse = ((opStorageIdx +
      // v) % 7) + 1 so different voices have different op-frequency ratios.
      for (let op = 0; op < 6; op++) {
        const o = base + op * 17;
        payload[o + 0] = 99; payload[o + 1] = 50; payload[o + 2] = 30; payload[o + 3] = 60;
        payload[o + 4] = 99; payload[o + 5] = 70; payload[o + 6] = 50; payload[o + 7] = 0;
        payload[o + 12] = 7 << 3; // detune = 7 (no detune)
        payload[o + 13] = 4 << 2; // velocity sens = 4
        payload[o + 14] = 80;     // op output level
        const coarse = ((op + v) % 7) + 1;
        payload[o + 15] = coarse << 1;
        payload[o + 16] = 0;
      }
      for (let k = 0; k < 4; k++) {
        payload[base + 102 + k] = 99;
        payload[base + 106 + k] = 50;
      }
      payload[base + 110] = v % 32; // algorithm
      payload[base + 111] = 4;      // feedback
      payload[base + 112] = 35;     // lfo speed
      payload[base + 117] = 24;     // transpose neutral
      const name = `USER_${String(v).padStart(2, '0')}`.slice(0, 10);
      for (let i = 0; i < 10; i++) {
        payload[base + 118 + i] = i < name.length ? name.charCodeAt(i) : 32;
      }
    }
    // Yamaha checksum.
    let s = 0;
    for (let i = 0; i < payload.length; i++) s = (s + payload[i]!) & 0xff;
    out[4102] = (-s) & 0x7f;
    // Stash on window for the upload step.
    (globalThis as unknown as { __testSyx: Uint8Array }).__testSyx = out;
  });

  // Use the file input handle to upload the synthesized SYX.
  const fileInput = page.locator('[data-testid="dx7-syx-input"]');
  const buffer = await page.evaluate(() => {
    const bytes = (globalThis as unknown as { __testSyx: Uint8Array }).__testSyx;
    return Array.from(bytes);
  });
  await fileInput.setInputFiles({
    name: 'test-bank.syx',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(buffer),
  });

  // Status should report 32 voices loaded.
  const status = page.locator('[data-testid="dx7-syx-status"]');
  await expect(status).toContainText('loaded 32 voices', { timeout: 5000 });

  // The preset selector should now show the 32 user voices (in addition to
  // the 9 builtins). Count <option> elements.
  const presetSel = page.locator('[data-testid="dx7-preset-select"]');
  const optionCount = await presetSel.locator('option').count();
  expect(optionCount, '32 user voices + 9 builtins = 41 options').toBeGreaterThanOrEqual(32);

  // After upload, Card auto-selects USER_00. Wait for audio to settle.
  await expect(presetSel).toHaveValue('USER_00', { timeout: 5000 });
  let frameUser00: number[] = [];
  let deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    frameUser00 = await readScopeFrame(page, 'scp');
    let energy = 0;
    for (const v of frameUser00) energy += v * v;
    if (Math.sqrt(energy / Math.max(1, frameUser00.length)) > 0.005) break;
    await page.waitForTimeout(100);
  }
  expect(frameUser00.length, 'USER_00 scope frame is non-empty').toBeGreaterThan(0);
  const rmsUser00 = await readScopeRms(page, 'scp');
  expect(rmsUser00, 'USER_00 audible RMS').toBeGreaterThan(0.005);

  // Switch to USER_15 — a deliberately-different patch (different algorithm,
  // different operator ratios per the synthetic generator above).
  await presetSel.selectOption('USER_15');
  await expect(presetSel).toHaveValue('USER_15');

  // Give the worklet ~1.5s to clear voices, retrigger, and refill the scope.
  await page.waitForTimeout(1500);
  let frameUser15: number[] = [];
  deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    frameUser15 = await readScopeFrame(page, 'scp');
    let energy = 0;
    for (const v of frameUser15) energy += v * v;
    if (Math.sqrt(energy / Math.max(1, frameUser15.length)) > 0.005) break;
    await page.waitForTimeout(100);
  }
  expect(frameUser15.length, 'USER_15 scope frame is non-empty').toBeGreaterThan(0);

  // Compare the two captures. Bug's symptom: both render IDENTICAL audio
  // (everything falls back to E.PIANO 1) → L2 distance ≈ 0. Real fix:
  // measurably different waveform.
  const len = Math.min(frameUser00.length, frameUser15.length);
  let diffSq = 0;
  let normSq = 0;
  for (let i = 0; i < len; i++) {
    const d = frameUser00[i]! - frameUser15[i]!;
    diffSq += d * d;
    normSq += frameUser00[i]! * frameUser00[i]! + frameUser15[i]! * frameUser15[i]!;
  }
  const ratio = Math.sqrt(diffSq) / Math.max(Math.sqrt(normSq), 1e-9);
  expect(
    ratio,
    `USER_00 vs USER_15 scope frame normalized L2 distance (got ${ratio.toFixed(3)}; bug renders identical audio → distance ≈ 0)`,
  ).toBeGreaterThan(0.1);
});
