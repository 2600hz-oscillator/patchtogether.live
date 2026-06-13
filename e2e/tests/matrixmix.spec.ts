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

async function setup(page: Page): Promise<void> {
  await page.goto('/');
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
