// e2e/tests/writeseq.spec.ts
//
// WRITESEQ end-to-end coverage. WRITESEQ is the recording step-sequencer:
//   1. card renders the grid (PAGE_SIZE cells) + RECORD + OVERDUB buttons.
//   2. a programmed sequence plays back through a SCOPE (sequenced output).
//   3. live PASS-THROUGH: a held gate+cv on the inputs drives the outputs
//      even when stopped + record off.
//
// The deterministic no-off-by-one DRUMMERGIRL alignment proof lives in the
// unit test (packages/web/src/lib/audio/modules/writeseq-alignment.test.ts) —
// e2e timing is less deterministic, so that unit test stays the gate. This
// spec proves the real card + engine wire up + emit/pass-through end to end.
//
// Card hooks (gated on VITE_E2E_HOOKS=1 — autotest + dev), on WriteseqCard:
//   __writeseqStepAt(id, step)            → WriteseqStep | null
//   __writeseqSetStep(id, step, {on?,midi?})

import { test, expect } from './_fixtures';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopeSnapshot, summarize, runFor } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

test('writeseq: card renders the step grid + RECORD + OVERDUB buttons', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'ws', type: 'writeseq', params: { isPlaying: 0 } }]);

  // 16 cells in the first page of the grid.
  const cellCount = await page.locator('[data-testid="writeseq-grid-ws"] [data-step]').count();
  expect(cellCount).toBe(16);

  await expect(page.getByTestId('writeseq-play-ws')).toBeVisible();
  await expect(page.getByTestId('writeseq-record-ws')).toBeVisible();
  await expect(page.getByTestId('writeseq-overdub-ws')).toBeVisible();
});

test('writeseq: a programmed sequence plays back through a downstream SCOPE', async ({ page, rack, errorWatch }) => {
  // WRITESEQ.gate → ADSR.gate → VCA, WRITESEQ.pitch → an oscillator so the
  // SCOPE sees real audio. Simpler: route WRITESEQ.gate into a SCOPE as a CV
  // signal — the sequenced gate is a 0/1 ConstantSource, which the scope reads
  // as a non-trivial waveform when the sequence runs.
  const nodes: SpawnNode[] = [
    { id: 'ws', type: 'writeseq', params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.6 } },
    { id: 'scp', type: 'scope', params: { timeMs: 50 } },
  ];
  const edges: SpawnEdge[] = [
    { id: 'e_gate', from: { nodeId: 'ws', portId: 'gate' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'gate', targetType: 'audio' },
  ];
  await spawnPatch(page, nodes, edges);

  // Program 4 on-steps via the card hook.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __writeseqSetStep?: unknown };
    return typeof w.__writeseqSetStep === 'function';
  });
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __writeseqSetStep: (id: string, step: number, cell: { on?: boolean; midi?: number | null }) => boolean;
    };
    for (let i = 0; i < 4; i++) w.__writeseqSetStep('ws', i, { on: true, midi: 60 + i * 3 });
  });

  // Let the 4-step loop run a couple times (240 BPM 16th = 62.5 ms/step).
  await runFor(page, 600);

  const snap = await readScopeSnapshot(page, 'scp');
  expect(snap, 'scope snapshot present').toBeTruthy();
  const s = summarize(snap!.ch1);
  // The sequenced gate toggles 0↔1 → a non-trivial signal (peak ≈ 1).
  expect(s.peak, `gate-out should be sounding; summary ${JSON.stringify(s)}`).toBeGreaterThan(0.5);

});

test('writeseq: PASS-THROUGH — a live gate+cv source drives the outputs (stopped, record off)', async ({ page, rack, errorWatch }) => {
  // A SEQUENCER provides a steady gate+pitch source. Wire its gate+pitch into
  // WRITESEQ.gate/cv; WRITESEQ is STOPPED + record OFF; its gate-out feeds a
  // SCOPE. Pure pass-through must surface the live gate on the WRITESEQ output.
  const nodes: SpawnNode[] = [
    { id: 'src', type: 'sequencer', params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.9 } },
    { id: 'ws', type: 'writeseq', params: { isPlaying: 0, recArm: 0, overdub: 0 } },
    { id: 'scp', type: 'scope', params: { timeMs: 50 } },
  ];
  const edges: SpawnEdge[] = [
    { id: 'e_g', from: { nodeId: 'src', portId: 'gate' }, to: { nodeId: 'ws', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
    { id: 'e_p', from: { nodeId: 'src', portId: 'pitch' }, to: { nodeId: 'ws', portId: 'cv' }, sourceType: 'pitch', targetType: 'pitch' },
    { id: 'e_out', from: { nodeId: 'ws', portId: 'gate' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'gate', targetType: 'audio' },
  ];
  await spawnPatch(page, nodes, edges);

  // Seed the SEQUENCER source with all-on steps so its gate is high a lot.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['src'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.steps = Array.from({ length: 4 }, () => ({ on: true, midi: 60, chord: 'mono' }));
    });
  });

  await runFor(page, 600);

  // WRITESEQ is stopped + not recording, but the live gate passes through:
  // the gate-out feeding the SCOPE must show signal.
  const snap = await readScopeSnapshot(page, 'scp');
  expect(snap, 'scope snapshot present').toBeTruthy();
  const s = summarize(snap!.ch1);
  expect(s.peak, `pass-through gate should sound while stopped; summary ${JSON.stringify(s)}`).toBeGreaterThan(0.5);

  // Confirm WRITESEQ never started playing (no transport auto-start).
  const isPlaying = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> }> } };
    return w.__patch.nodes['ws']?.params?.isPlaying ?? -1;
  });
  expect(isPlaying).toBe(0);

});

test('writeseq: armed + internal clock captures live gates onto steps', async ({ page, rack, errorWatch }) => {
  // WRITESEQ on its INTERNAL clock (no clock-in patched) — deterministic
  // recording: the internal pulses are always available, so an armed WRITESEQ
  // records the incoming gates. A SEQUENCER source drives WRITESEQ.gate/cv.
  // (The sample-accurate external-clock alignment is proven by the unit test;
  // e2e real-time clock coincidence is intentionally NOT relied on here.)
  const nodes: SpawnNode[] = [
    { id: 'src', type: 'sequencer', params: { isPlaying: 1, length: 4, bpm: 240, gateLength: 0.5 } },
    { id: 'ws', type: 'writeseq', params: { isPlaying: 1, length: 8, recArm: 1, overdub: 0, bpm: 240 } },
  ];
  const edges: SpawnEdge[] = [
    { id: 'e_g', from: { nodeId: 'src', portId: 'gate' }, to: { nodeId: 'ws', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
    { id: 'e_p', from: { nodeId: 'src', portId: 'pitch' }, to: { nodeId: 'ws', portId: 'cv' }, sourceType: 'pitch', targetType: 'pitch' },
  ];
  await spawnPatch(page, nodes, edges);

  // All-on source so gates land on most steps.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['src'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.steps = Array.from({ length: 4 }, () => ({ on: true, midi: 64, chord: 'mono' }));
    });
  });

  // Run long enough for the internal clock to land several steps + records.
  await runFor(page, 1200);

  // At least one WRITESEQ step recorded ON via the incoming gate.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __writeseqStepAt?: (id: string, step: number) => { on: boolean; midi: number | null } | null;
    };
    return typeof w.__writeseqStepAt === 'function';
  });
  const recordedOn = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __writeseqStepAt: (id: string, step: number) => { on: boolean; midi: number | null } | null;
    };
    let count = 0;
    for (let i = 0; i < 8; i++) {
      const s = w.__writeseqStepAt('ws', i);
      if (s?.on) count++;
    }
    return count;
  });
  expect(recordedOn, 'at least one step recorded from the live gate').toBeGreaterThanOrEqual(1);

});
