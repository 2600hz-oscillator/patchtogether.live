// HARDWARE-IN-THE-LOOP checks for the es9 module — OPT-IN ONLY (ES9_HW=1).
// Never runs in CI: it needs a physical Expert Sleepers ES-9 attached AND the
// es9-bridge native app (repo patchtogether.es9) serving ws://127.0.0.1:9209,
// plus live signal patched into the hardware:
//
//   ES-9 input 1+2 ← a changing AUDIO source (VCO/mixer output, music, …)
//   ES-9 input 3+4 ← a changing CV source (LFO, envelope, random)
//   ES-9 output 1  → ES-9 input 5 (a LOOPBACK patch cable)
//   ES-9 input 6   ← NOTHING (leave the jack empty: the negative control)
//
// Run:  ES9_HW=1 flox activate -- task e2e:one -- es9-hardware --workers=1
//
// --workers=1 is REQUIRED: the bridge accepts a single client, so parallel
// pages would fight over it (later connections get status "busy").
//
// The output direction (browser → ES-9 jacks) is covered by the loopback
// test at the bottom: out1 → in5 through a real cable is the round trip
// ×0.5 (app ±1 → ±5 V) then ×2 (±5 V → app ±1), so an internal VCO at ~1.0
// must come back at ~1.0 (ADR-019). Absolute volts at a jack still need a
// meter — see the hardware-verify checklist on the ADR-019 PR.

import { test, expect } from './_fixtures';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopeSnapshot, summarize, runFor } from './_module-coverage-helpers';

test.describe.configure({ mode: 'serial' });
// Long polls by design: CV sources can be slow (a 0.1 Hz LFO needs seconds
// to swing), and the first connect can ride out one busy-retry cycle.
test.setTimeout(90_000);

test.skip(
  process.env.ES9_HW !== '1',
  'hardware-in-the-loop: needs a real ES-9 + es9-bridge on ws://127.0.0.1:9209 (opt in with ES9_HW=1)',
);

/** Wait until the card reports a live bridge connection (deviceInfo landed).
 *  Generous timeout: a just-closed previous session can bounce one "busy"
 *  retry cycle (~5 s backoff) before the new socket wins. */
async function waitConnected(page: import('@playwright/test').Page): Promise<void> {
  await expect(
    page.getByTestId('es9-status-sut'),
    'es9 card connects to the real bridge and shows the device name',
  ).toContainText('ES-9', { timeout: 20_000 });
}

interface ScopeStats {
  peak: number;
  rmsMin: number;
  rmsMax: number;
}

/** Poll SEVERAL scopes' analysers over ONE shared `totalMs` window (so the
 *  per-scope stats cover the same span of the live signal — needed for the
 *  ratio check — and the wall-clock stays inside the test timeout).
 *  Returns per-scope running peak + the spread of windowed RMS values (a
 *  changing source has spread; a stuck one doesn't). */
async function pollScopes(
  page: import('@playwright/test').Page,
  scopeIds: string[],
  totalMs: number,
): Promise<Record<string, ScopeStats>> {
  const pollMs = 40;
  const out: Record<string, ScopeStats> = {};
  for (const id of scopeIds) {
    out[id] = { peak: 0, rmsMin: Number.POSITIVE_INFINITY, rmsMax: 0 };
  }
  for (let elapsed = 0; elapsed < totalMs; elapsed += pollMs) {
    await runFor(page, pollMs);
    for (const id of scopeIds) {
      const snap = await readScopeSnapshot(page, id);
      if (!snap) continue;
      const sum = summarize(snap.ch1);
      const s = out[id]!;
      if (sum.peak > s.peak) s.peak = sum.peak;
      if (sum.rms < s.rmsMin) s.rmsMin = sum.rms;
      if (sum.rms > s.rmsMax) s.rmsMax = sum.rms;
    }
  }
  for (const id of scopeIds) {
    const s = out[id]!;
    if (!Number.isFinite(s.rmsMin)) s.rmsMin = 0;
  }
  return out;
}

const ES9_NODE: SpawnNode = {
  id: 'sut',
  type: 'es9',
  position: { x: 380, y: 60 },
  domain: 'audio',
};

function scopeNode(id: string, y: number): SpawnNode {
  return { id, type: 'scope', position: { x: 760, y }, domain: 'audio' };
}

test('connects to the real bridge and reports the ES-9', async ({ page, rack, errorWatch }) => {
  void rack;
  void errorWatch;
  await spawnPatch(page, [ES9_NODE]);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="es9"])')).toBeVisible();
  await waitConnected(page);
});

test('hardware audio on inputs 1+2 reaches the graph (raw jacks)', async ({ page, rack, errorWatch }) => {
  void rack;
  void errorWatch;
  const edges: SpawnEdge[] = [
    { id: 'e1', from: { nodeId: 'sut', portId: 'in1' }, to: { nodeId: 'scp1', portId: 'ch1' } },
    { id: 'e2', from: { nodeId: 'sut', portId: 'in2' }, to: { nodeId: 'scp2', portId: 'ch1' } },
  ];
  await spawnPatch(page, [ES9_NODE, scopeNode('scp1', 0), scopeNode('scp2', 260)], edges);
  await waitConnected(page);

  const stats = await pollScopes(page, ['scp1', 'scp2'], 5_000);
  const ch1 = stats['scp1']!;
  const ch2 = stats['scp2']!;

  // Live audio: solid peaks…
  expect(ch1.peak, `in1 peak (${JSON.stringify(ch1)})`).toBeGreaterThan(0.02);
  expect(ch2.peak, `in2 peak (${JSON.stringify(ch2)})`).toBeGreaterThan(0.02);
  // …and CHANGING levels (the patched source varies over the window).
  expect(ch1.rmsMax - ch1.rmsMin, `in1 rms spread (${JSON.stringify(ch1)})`).toBeGreaterThan(0.002);
});

test('hardware CV on inputs 3+4 arrives on the cv twins: cv twin ≈ audio port (same ±5 V → ±1 scale), pitch twin ≈ ×5', async ({ page, rack, errorWatch }) => {
  void rack;
  void errorWatch;
  // Jack 3's audio port on one scope, its cv twin on another: since ADR-019
  // the audio port is ±5 V → ±1 (Eurorack nominal), the SAME scale as the cv
  // class, so the two must carry the same signal at a peak ratio ≈ 1. That
  // alone would pass with NO scaling anywhere, so jack 4 is the
  // discriminator: its twin is set to PITCH (×10 of the wire) against its
  // audio port (×2 of the wire) — ratio ≈ 5. Polling every scope over the
  // same span makes the ratios robust to the CV's own movement.
  const sut: SpawnNode = { ...ES9_NODE, params: { in4_class: 2 /* pitch */ } };
  const edges: SpawnEdge[] = [
    { id: 'e1', from: { nodeId: 'sut', portId: 'in3' }, to: { nodeId: 'scpraw', portId: 'ch1' } },
    {
      id: 'e2',
      from: { nodeId: 'sut', portId: 'in3_cv' },
      to: { nodeId: 'scpcv', portId: 'ch1' },
      sourceType: 'cv',
      targetType: 'audio',
    },
    { id: 'e3', from: { nodeId: 'sut', portId: 'in4' }, to: { nodeId: 'scpraw4', portId: 'ch1' } },
    {
      id: 'e4',
      from: { nodeId: 'sut', portId: 'in4_cv' },
      to: { nodeId: 'scpcv4', portId: 'ch1' },
      sourceType: 'cv',
      targetType: 'audio',
    },
  ];
  await spawnPatch(
    page,
    [sut, scopeNode('scpraw', 0), scopeNode('scpcv', 200), scopeNode('scpraw4', 400), scopeNode('scpcv4', 600)],
    edges,
  );
  await waitConnected(page);

  // Long SHARED window: CV can be slow (a 0.1 Hz LFO needs seconds to
  // swing), and the ratio checks want port + twin sampled over the same span.
  const stats = await pollScopes(page, ['scpraw', 'scpcv', 'scpraw4', 'scpcv4'], 10_000);
  const raw = stats['scpraw']!;
  const cv = stats['scpcv']!;
  const raw4 = stats['scpraw4']!;
  const cv4 = stats['scpcv4']!;

  expect(cv.peak, `in3_cv peak — is CV actually patched into ES-9 input 3? (${JSON.stringify(cv)})`).toBeGreaterThan(0.02);
  expect(cv4.peak, `in4_cv peak — is CV actually patched into ES-9 input 4? (${JSON.stringify(cv4)})`).toBeGreaterThan(0.02);

  // Same scale (default in3_class = cv): ratio ≈ 1. Tolerance: the two
  // scopes sample the same span but not the same instants.
  const ratio3 = cv.peak / Math.max(raw.peak, 1e-6);
  expect(ratio3, `in3_cv/in3 peak ratio ≈ 1 (audio=${raw.peak.toFixed(4)} cv=${cv.peak.toFixed(4)})`).toBeGreaterThan(0.8);
  expect(ratio3, `in3_cv/in3 peak ratio ≈ 1 (audio=${raw.peak.toFixed(4)} cv=${cv.peak.toFixed(4)})`).toBeLessThan(1.25);

  // The discriminator: pitch twin (×10) over audio port (×2) = 5.
  const ratio4 = cv4.peak / Math.max(raw4.peak, 1e-6);
  expect(ratio4, `in4_cv(pitch)/in4 peak ratio ≈ 5 (audio=${raw4.peak.toFixed(4)} pitch=${cv4.peak.toFixed(4)})`).toBeGreaterThan(4);
  expect(ratio4, `in4_cv(pitch)/in4 peak ratio ≈ 5 (audio=${raw4.peak.toFixed(4)} pitch=${cv4.peak.toFixed(4)})`).toBeLessThan(6.25);
});

test('loopback out1 → in5: an internal VCO at ~1.0 comes back at ~1.0 (round-trip identity), and the empty jack 6 reads silence', async ({ page, rack, errorWatch }) => {
  void rack;
  void errorWatch;
  // out1 is class audio by default (app ±1 → ±5 V); in5's audio port is
  // ±5 V → ±1. Through a real patch cable the product is identity, so the
  // ES-9 return must peak within ±10 % of the same VCO read directly. Before
  // ADR-019 the loop was ×1/×1 as well, so this test is NOT the level pin —
  // the parity gain lives in the ART scenario and the dsp suites; this test
  // pins that the hardware path is transparent end to end, and its NEGATIVE
  // control (an unpatched jack) is what separates "the return is live" from
  // "a meter is stuck".
  const edges: SpawnEdge[] = [
    { id: 'e1', from: { nodeId: 'vco', portId: 'out' }, to: { nodeId: 'sut', portId: 'out1' } },
    { id: 'e2', from: { nodeId: 'vco', portId: 'out' }, to: { nodeId: 'scpdirect', portId: 'ch1' } },
    { id: 'e3', from: { nodeId: 'sut', portId: 'in5' }, to: { nodeId: 'scploop', portId: 'ch1' } },
    { id: 'e4', from: { nodeId: 'sut', portId: 'in6' }, to: { nodeId: 'scpempty', portId: 'ch1' } },
  ];
  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'swolevco', position: { x: 60, y: 60 }, domain: 'audio' },
      ES9_NODE,
      scopeNode('scpdirect', 0),
      scopeNode('scploop', 200),
      scopeNode('scpempty', 400),
    ],
    edges,
  );
  await waitConnected(page);

  const stats = await pollScopes(page, ['scpdirect', 'scploop', 'scpempty'], 5_000);
  const direct = stats['scpdirect']!;
  const loop = stats['scploop']!;
  const empty = stats['scpempty']!;

  expect(direct.peak, `direct VCO peak (${JSON.stringify(direct)})`).toBeGreaterThan(0.9);
  expect(loop.peak, `in5 loopback peak — is out1 cabled to in5? (${JSON.stringify(loop)})`).toBeGreaterThan(0.9);
  expect(loop.peak, `in5 loopback peak (${JSON.stringify(loop)})`).toBeLessThan(1.1);
  const ratio = loop.peak / Math.max(direct.peak, 1e-6);
  expect(ratio, `in5/direct peak ratio ≈ 1 (direct=${direct.peak.toFixed(4)} loop=${loop.peak.toFixed(4)})`).toBeGreaterThan(0.9);
  expect(ratio, `in5/direct peak ratio ≈ 1 (direct=${direct.peak.toFixed(4)} loop=${loop.peak.toFixed(4)})`).toBeLessThan(1.1);
  // Negative control: an unpatched jack must read silence (presence ≠ liveness).
  expect(empty.peak, `in6 (unpatched) peak — is something patched into ES-9 input 6? (${JSON.stringify(empty)})`).toBeLessThan(0.02);
});
