// e2e/tests/matrixmix.spec.ts
//
// MATRIXMIX — the full live patch-matrix loop against the REAL graph store:
//   1. spawn the matrix + two real modules (ADSR + VCA).
//   2. pick ADSR on the X axis + VCA on the Y axis from the dropdowns →
//      the grid materializes (jacks become rows/cols).
//   3. a legal cell (ADSR.env cv-out  ×  VCA.cv cv-in) is clickable →
//      clicking it CREATES the edge in patch.edges via the SHARED
//      validateEdge seam, and the cell flips to a filled "direct" dot.
//   4. patch a CONFLICT from OUTSIDE the matrix (a 3rd module → VCA.cv) and
//      assert the matrix reflects it LIVE: a different legal cell whose input
//      is now taken reads as inputTaken (red ✕) without any matrix interaction.
//
// This exercises the real source→matrix→graph chain (not the pure core in
// isolation): the card reads patch.edges every render, classifies cells, and
// writes through createMatrixEdge → validateEdge → patch.edges, the same path
// the drag-connect + patch-to flows use.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const MM = 'mm-1';
const ADSR = 'adsr-1'; // X axis: outputs env (cv), env_inv (cv); inputs gate/attack/decay/sustain/release
const VCA = 'vca-1'; // Y axis: inputs audio (audio), cv (cv); outputs audio/audio_inv (audio)
const LFO = 'lfo-1'; // 3rd module — its phase0 (cv) feeds the conflict edge into VCA.cv

// Edge ids follow the canonical `e-<src>-<srcPort>-<dst>-<dstPort>` convention
// (matrixEdgeId) — the matrix addresses the SAME edge the drag/patch-to paths do.
const LEGAL_EDGE_ID = `e-${ADSR}-env-${VCA}-cv`;

async function readEdges(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, unknown> } };
    return { ...w.__patch.edges };
  });
}

/** A connectivity fingerprint of the patch — sorted "src.port→dst.port" strings,
 *  edge-id-independent so it survives a re-patch that addresses the same wire by
 *  a different id. Used to assert the undo round-trip lands on the EXACT start. */
function normEdges(edges: Record<string, unknown>): string[] {
  return Object.values(edges)
    .map((e) => {
      const x = e as { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } };
      return `${x.source.nodeId}.${x.source.portId}→${x.target.nodeId}.${x.target.portId}`;
    })
    .sort();
}

/** Current LOCAL_ORIGIN undo-stack depth (dev hook exposed by Canvas). */
function undoDepth(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __undoManager: { undoStack: unknown[] } }).__undoManager.undoStack.length,
  );
}

async function setup(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: MM, type: 'matrixMix', position: { x: 520, y: 80 }, domain: 'meta' },
    { id: ADSR, type: 'adsr', position: { x: 60, y: 80 }, domain: 'audio' },
    { id: VCA, type: 'vca', position: { x: 60, y: 340 }, domain: 'audio' },
    { id: LFO, type: 'lfo', position: { x: 60, y: 560 }, domain: 'audio' },
  ]);
}

test('select both axes → click a legal cell creates the edge + a dot; an external conflict shows live', async ({
  page,
}) => {
  await setup(page);

  // The matrix card mounts. Scope every selector to THIS node id.
  const card = page.locator('[data-testid="matrixmix-card"][data-node-id="' + MM + '"]');
  await expect(card).toBeVisible();
  // Fresh matrix = empty-state prompt (no axes picked → no grid).
  await expect(card.locator('[data-testid="matrixmix-empty"]')).toBeVisible();

  // Pick ADSR on X, VCA on Y. The options are keyed by node id (value = nodeId).
  await card.locator('[data-testid="matrixmix-x-select"]').selectOption(ADSR);
  await card.locator('[data-testid="matrixmix-y-select"]').selectOption(VCA);

  // Grid materializes; the empty prompt is gone.
  await expect(card.locator('[data-testid="matrixmix-grid"]')).toBeVisible();
  await expect(card.locator('[data-testid="matrixmix-empty"]')).toHaveCount(0);

  // The legal cell: row = VCA.cv (cv input), col = ADSR.env (cv output).
  // testid pattern: matrixmix-cell-<rowDir>-<rowPort>-<colDir>-<colPort>.
  const legalCell = card.locator(
    '[data-testid="matrixmix-cell-input-cv-output-env"]',
  );
  await expect(legalCell).toBeVisible();
  await expect(legalCell).toHaveAttribute('data-kind', 'legalEmpty');
  // No edge exists yet.
  expect(await readEdges(page)).not.toHaveProperty(LEGAL_EDGE_ID);

  // Click it → createMatrixEdge runs through the shared validateEdge seam.
  await legalCell.click();

  // The edge now exists in the live patch, with the right endpoints + types.
  await expect
    .poll(async () => Object.keys(await readEdges(page)))
    .toContain(LEGAL_EDGE_ID);
  const edges = await readEdges(page);
  const created = edges[LEGAL_EDGE_ID] as {
    source: { nodeId: string; portId: string };
    target: { nodeId: string; portId: string };
    sourceType: string;
    targetType: string;
  };
  expect(created.source).toEqual({ nodeId: ADSR, portId: 'env' });
  expect(created.target).toEqual({ nodeId: VCA, portId: 'cv' });
  expect(created.sourceType).toBe('cv');
  expect(created.targetType).toBe('cv');

  // The cell re-classifies LIVE to a filled "direct" dot (cable colour).
  await expect(legalCell).toHaveAttribute('data-kind', 'direct');
  await expect(legalCell.locator('[data-testid="matrixmix-dot"]')).toBeVisible();

  // ── Unpatch: clicking the now-GREEN (direct) cell REMOVES the edge ─────────
  // The same cell is now a direct connection between the two matrixed modules.
  // Clicking it toggles it OFF — removeMatrixEdge deletes that exact edge, and
  // the cell flips back to a clickable empty (legalEmpty) cell with no dot.
  await legalCell.click();
  await expect
    .poll(async () => Object.keys(await readEdges(page)))
    .not.toContain(LEGAL_EDGE_ID);
  await expect(legalCell).toHaveAttribute('data-kind', 'legalEmpty');
  await expect(legalCell.locator('[data-testid="matrixmix-dot"]')).toHaveCount(0);

  // ── Live external conflict ───────────────────────────────────────────────
  // Patch LFO.phase0 (cv out) → VCA.audio (audio... NO). Use a DIFFERENT legal
  // target so we don't collide with the cell we just made: feed VCA's `cv`
  // input is already taken by us, so instead we prove the LIVE-reflect on a
  // cell whose input becomes externally taken. Patch LFO.phase0 → VCA.cv would
  // REPLACE our edge; to show inputTaken cleanly, first remove our edge, then
  // add the external one, then re-read the same cell.
  await page.evaluate(
    ({ legalId, lfo, vca }) => {
      const w = window as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        // Remove the matrix-made edge so the cell's input is free…
        delete w.__patch.edges[legalId];
        // …then patch a THIRD module (LFO.phase0 cv-out) into VCA.cv from
        // OUTSIDE the matrix entirely (no matrix interaction).
        const id = `e-${lfo}-phase0-${vca}-cv`;
        w.__patch.edges[id] = {
          id,
          source: { nodeId: lfo, portId: 'phase0' },
          target: { nodeId: vca, portId: 'cv' },
          sourceType: 'cv',
          targetType: 'cv',
        };
      });
    },
    { legalId: LEGAL_EDGE_ID, lfo: LFO, vca: VCA },
  );

  // The SAME cell now reads inputTaken (red ✕) — the matrix reflected the
  // external patch live, with no click on the matrix.
  await expect(legalCell).toHaveAttribute('data-kind', 'inputTaken');
  await expect(legalCell.locator('[data-testid="matrixmix-dot"]')).toHaveCount(0);
});

test('RED ✕ (inputTaken) is clickable: cancel no-ops; accept REPLACES the foreign source, and ONE undo restores it', async ({
  page,
}) => {
  await setup(page);
  const card = page.locator('[data-testid="matrixmix-card"][data-node-id="' + MM + '"]');
  await card.locator('[data-testid="matrixmix-x-select"]').selectOption(ADSR);
  await card.locator('[data-testid="matrixmix-y-select"]').selectOption(VCA);
  await expect(card.locator('[data-testid="matrixmix-grid"]')).toBeVisible();

  // External conflict from OUTSIDE the matrix: LFO.phase0 (cv) → VCA.cv.
  const foreignId = `e-${LFO}-phase0-${VCA}-cv`;
  await page.evaluate(
    ({ foreignId, lfo, vca }) => {
      const w = window as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges[foreignId] = {
          id: foreignId,
          source: { nodeId: lfo, portId: 'phase0' },
          target: { nodeId: vca, portId: 'cv' },
          sourceType: 'cv',
          targetType: 'cv',
        };
      });
    },
    { foreignId, lfo: LFO, vca: VCA },
  );

  // The cell (VCA.cv input × ADSR.env output) now reads inputTaken (RED ✕).
  const cell = card.locator('[data-testid="matrixmix-cell-input-cv-output-env"]');
  await expect(cell).toHaveAttribute('data-kind', 'inputTaken');
  const matrixId = `e-${ADSR}-env-${VCA}-cv`;

  // CANCEL the confirm → nothing changes (foreign intact, no matrix edge).
  page.once('dialog', (d) => d.dismiss());
  await cell.click();
  await expect(cell).toHaveAttribute('data-kind', 'inputTaken');
  expect(Object.keys(await readEdges(page))).toContain(foreignId);
  expect(Object.keys(await readEdges(page))).not.toContain(matrixId);

  // Isolate the next op as its own undo entry (so the captureTimeout can't
  // coalesce it with the earlier axis-pick edits), then ACCEPT the confirm.
  await page.evaluate(() =>
    (window as unknown as { __undoManager: { stopCapturing: () => void } }).__undoManager.stopCapturing(),
  );
  page.once('dialog', (d) => d.accept());
  await cell.click();

  // The foreign cable is REPLACED by the matrix edge — one atomic transaction.
  await expect.poll(async () => Object.keys(await readEdges(page))).toContain(matrixId);
  expect(Object.keys(await readEdges(page))).not.toContain(foreignId);
  await expect(cell).toHaveAttribute('data-kind', 'direct');

  // ONE Cmd-Z reverts the WHOLE displacing re-patch: matrix edge removed AND
  // the foreign edge restored (createMatrixEdge did remove+add in ONE txn).
  await page.evaluate(() =>
    (window as unknown as { __undoManager: { undo: () => void } }).__undoManager.undo(),
  );
  await expect.poll(async () => Object.keys(await readEdges(page))).toContain(foreignId);
  expect(Object.keys(await readEdges(page))).not.toContain(matrixId);
  await expect(cell).toHaveAttribute('data-kind', 'inputTaken');
});

test('GRAY ✕ (outputFanout) is clickable: accept ADDS a cable, the foreign consumer stays', async ({
  page,
}) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: MM, type: 'matrixMix', position: { x: 520, y: 80 }, domain: 'meta' },
    { id: 'vco-1', type: 'analogVco', position: { x: 60, y: 80 }, domain: 'audio' },
    { id: VCA, type: 'vca', position: { x: 60, y: 340 }, domain: 'audio' },
    { id: 'out-1', type: 'audioOut', position: { x: 60, y: 560 }, domain: 'audio' },
  ]);
  const card = page.locator('[data-testid="matrixmix-card"][data-node-id="' + MM + '"]');
  await card.locator('[data-testid="matrixmix-x-select"]').selectOption('vco-1');
  await card.locator('[data-testid="matrixmix-y-select"]').selectOption(VCA);
  await expect(card.locator('[data-testid="matrixmix-grid"]')).toBeVisible();

  // External consumer: VCO.sine (audio out) → OUT.L, so VCO.sine fans out.
  const foreignId = 'e-vco-1-sine-out-1-L';
  await page.evaluate(
    ({ foreignId }) => {
      const w = window as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges[foreignId] = {
          id: foreignId,
          source: { nodeId: 'vco-1', portId: 'sine' },
          target: { nodeId: 'out-1', portId: 'L' },
          sourceType: 'audio',
          targetType: 'audio',
        };
      });
    },
    { foreignId },
  );

  // Cell (VCA.audio input × VCO.sine output): the output already fans out → GRAY ✕.
  const cell = card.locator('[data-testid="matrixmix-cell-input-audio-output-sine"]');
  await expect(cell).toHaveAttribute('data-kind', 'outputFanout');
  const matrixId = `e-vco-1-sine-${VCA}-audio`;

  // ACCEPT → the matrix edge is ADDED; the foreign consumer is UNTOUCHED.
  page.once('dialog', (d) => d.accept());
  await cell.click();
  await expect.poll(async () => Object.keys(await readEdges(page))).toContain(matrixId);
  expect(Object.keys(await readEdges(page))).toContain(foreignId); // still there — additive
  await expect(cell).toHaveAttribute('data-kind', 'direct');
});

test('Sequenced VCO: matrix unpatch + re-patch, then Cmd-Z all the way back to the exact starting patch', async ({
  page,
}) => {
  // CI-load robustness: loads a 5-module example then drives a long multi-step
  // matrix patch/unpatch + full Cmd-Z undo chain (each step polls the edge
  // store). The flat 30s default timed out under CI load (main run 1b897a3c,
  // cleared on rerun → flake, not a real break). Give it room.
  test.setTimeout(90_000);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  // Load the REAL "Sequenced VCO" example (5 modules, 6 edges) — the example
  // load is a single NON-undoable transaction, so it is the undo FLOOR.
  await page.locator('[data-testid="load-example-select"]').selectOption('sequenced-vco');
  await expect
    .poll(async () => Object.keys(await readEdges(page)).length, { timeout: 20_000 })
    .toBe(6);
  await page.waitForFunction(
    () => document.querySelector('.svelte-flow__node[data-id="vd-out"]') !== null,
    undefined,
    { timeout: 20_000 },
  );

  const startEdges = normEdges(await readEdges(page));
  expect(startEdges).toHaveLength(6);

  // Inject a MATRIXMIX node + stop the auto-playing sequencer — BOTH via a
  // non-LOCAL_ORIGIN (floor) write so neither lands on the undo stack.
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      (w.__patch.nodes as Record<string, unknown>)['mm-x'] = {
        id: 'mm-x',
        type: 'matrixMix',
        domain: 'meta',
        position: { x: 1500, y: 60 },
        params: {},
        data: {},
      };
      if (w.__patch.nodes['vd-seq']) w.__patch.nodes['vd-seq'].params.isPlaying = 0;
    });
  });
  const card = page.locator('[data-testid="matrixmix-card"][data-node-id="mm-x"]');
  await expect(card).toBeVisible();

  // SEAL the undo floor: close any open capture group (e.g. the auto-spawned
  // TIMELORDE singleton) so our matrix edits below form FRESH, discrete undo
  // entries instead of coalescing into a pre-existing one.
  const seal = () =>
    page.evaluate(() =>
      (window as unknown as { __undoManager: { stopCapturing: () => void } }).__undoManager.stopCapturing(),
    );
  await seal();

  const x = card.locator('[data-testid="matrixmix-x-select"]');
  const y = card.locator('[data-testid="matrixmix-y-select"]');

  // NB we deliberately operate on MONO cables (cv / pitch), not the VCA→AUDIO-OUT
  // stereo pair — patching one side of a stereo pair auto-wires the other, which
  // would confound a per-cell unpatch assertion.

  // ── Unpatch + RE-PATCH via the matrix (ADSR × VCA) ──
  await x.selectOption('vd-adsr');
  await y.selectOption('vd-vca');
  await seal();
  // unpatch adsr.env → vca.cv (a direct cable)
  await card.locator('[data-testid="matrixmix-cell-input-cv-output-env"]').click();
  await seal();
  // make a NEW patch: adsr.env_inv → vca.cv (the freed input)
  await card.locator('[data-testid="matrixmix-cell-input-cv-output-env_inv"]').click();
  await seal();
  // ── Cross-pair unpatch (SEQ × VCO): drop seq.pitch → vco.pitch ──
  await x.selectOption('vd-seq');
  await y.selectOption('vd-vco');
  await seal();
  await card.locator('[data-testid="matrixmix-cell-input-pitch-output-pitch"]').click();
  await seal();

  // The matrix WORKS: the new cable exists, the unpatched ones are gone, the
  // untouched ones remain.
  await expect
    .poll(async () => {
      const ids = Object.keys(await readEdges(page));
      return (
        ids.includes('e-vd-adsr-env_inv-vd-vca-cv') && // new patch
        !ids.includes('e-vd-adsr-env-vd-vca-cv') && // unpatched
        !ids.includes('e-vd-seq-pitch-vd-vco-pitch') && // unpatched
        ids.includes('e-vd-seq-gate-vd-adsr-gate') && // untouched
        ids.includes('e-vd-vco-sine-vd-vca-audio') && // untouched
        ids.includes('e-vd-vca-audio-vd-out-L') && // untouched (stereo)
        ids.includes('e-vd-vca-audio-vd-out-R')
      );
    })
    .toBe(true);

  // ── Hit Cmd-Z (the REAL keybinding) until we're back at the starting point ──
  const startKey = JSON.stringify(startEdges);
  let guard = 0;
  while (guard++ < 30 && JSON.stringify(normEdges(await readEdges(page))) !== startKey) {
    const before = await undoDepth(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => undoDepth(page), { timeout: 5000 }).toBeLessThan(before);
  }

  // Back to the EXACT starting patch — same 6 wires, same endpoints.
  expect(normEdges(await readEdges(page))).toEqual(startEdges);
});
