// e2e/tests/es9-hardware.spec.ts
//
// HARDWARE-IN-THE-LOOP checks for the es9 module — OPT-IN ONLY (ES9_HW=1).
// Never runs in CI: it needs a physical Expert Sleepers ES-9 attached AND the
// es9-bridge native app (repo patchtogether.es9) serving ws://127.0.0.1:9209,
// plus live signal patched into the hardware:
//
//   ES-9 input 1+2 ← a changing AUDIO source (VCO/mixer output, music, …)
//   ES-9 input 3+4 ← a changing CV source (LFO, envelope, random)
//
// Run:  ES9_HW=1 flox activate -- task e2e:one -- es9-hardware --workers=1
//
// --workers=1 is REQUIRED: the bridge accepts a single client, so parallel
// pages would fight over it (later connections get status "busy").
//
// The output direction (browser → ES-9 jacks) is intentionally untested here:
// asserting voltage at a physical jack needs a human (or a patched loopback
// cable + a second listening channel — a future extension).

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
  await expect(page.locator('.svelte-flow__node-es9')).toBeVisible();
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

test('hardware CV on inputs 3+4 arrives on the cv twins, class-scaled ×2', async ({ page, rack, errorWatch }) => {
  void rack;
  void errorWatch;
  // Raw jack 3 on one scope, its cv twin on another: the twin must carry the
  // SAME signal scaled by the cv class (±5 V → ±1, i.e. exactly ×2 vs the
  // raw ±10 V-full-scale port). Polling both over the same span makes the
  // peak ratio robust to the CV's own movement.
  const edges: SpawnEdge[] = [
    { id: 'e1', from: { nodeId: 'sut', portId: 'in3' }, to: { nodeId: 'scpraw', portId: 'ch1' } },
    {
      id: 'e2',
      from: { nodeId: 'sut', portId: 'in3_cv' },
      to: { nodeId: 'scpcv', portId: 'ch1' },
      sourceType: 'cv',
      targetType: 'audio',
    },
    {
      id: 'e3',
      from: { nodeId: 'sut', portId: 'in4_cv' },
      to: { nodeId: 'scpcv2', portId: 'ch1' },
      sourceType: 'cv',
      targetType: 'audio',
    },
  ];
  await spawnPatch(
    page,
    [ES9_NODE, scopeNode('scpraw', 0), scopeNode('scpcv', 200), scopeNode('scpcv2', 400)],
    edges,
  );
  await waitConnected(page);

  // Long SHARED window: CV can be slow (a 0.1 Hz LFO needs seconds to
  // swing), and the ratio check wants raw + twin sampled over the same span.
  const stats = await pollScopes(page, ['scpraw', 'scpcv', 'scpcv2'], 10_000);
  const raw = stats['scpraw']!;
  const cv = stats['scpcv']!;
  const cv4 = stats['scpcv2']!;

  expect(cv.peak, `in3_cv peak — is CV actually patched into ES-9 input 3? (${JSON.stringify(cv)})`).toBeGreaterThan(0.02);
  expect(cv4.peak, `in4_cv peak — is CV actually patched into ES-9 input 4? (${JSON.stringify(cv4)})`).toBeGreaterThan(0.02);

  // Class scaling: cv twin ≈ raw ×2 (default in3_class = cv). Wide tolerance:
  // the two scopes sample the same span but not the same instants.
  const ratio = cv.peak / Math.max(raw.peak, 1e-6);
  expect(ratio, `in3_cv/in3 peak ratio ≈ 2 (raw=${raw.peak.toFixed(4)} cv=${cv.peak.toFixed(4)})`).toBeGreaterThan(1.5);
  expect(ratio, `in3_cv/in3 peak ratio ≈ 2 (raw=${raw.peak.toFixed(4)} cv=${cv.peak.toFixed(4)})`).toBeLessThan(2.5);
});
