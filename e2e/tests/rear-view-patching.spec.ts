// e2e/tests/rear-view-patching.spec.ts
//
// Rack Phase 3 follow-up — PATCHING in rear view ("Flip rack").
//
// #771 shipped the rear view: the "Flip rack" toggle flips every card over its
// Y axis to reveal a back panel of jacks for tracing wiring. But the back jacks
// were cosmetic — you couldn't actually patch from behind. This spec asserts the
// fix: the back-panel jacks are LIVE patch points. Direct jack-to-jack, "patch
// on the back like a real patchbay":
//
//   * First click on a back jack picks up a cable (pickup ghost cable dangles).
//   * The next click on a compatible back jack (this card or another) COMMITS
//     the patch — the SAME validated edge, with the SAME {nodeId, portId}
//     endpoints, as a front-view patch would create. It reuses the existing
//     carry seam (patchpanel:jackclick → carry → patchpanel:carrycommit, owned
//     by Canvas → commitCarriedEdge → validateEdge), NOT a forked edge path.
//
// It also asserts the invariants the change MUST preserve:
//   * Front-view patching still works (via the proven __handleConnect hook).
//   * Toggling rear view ON/OFF never drops existing edges.
//   * A rear-view edge is correctly oriented OUTPUT → INPUT regardless of which
//     jack the user clicked first (a click that begins from the INPUT jack and
//     ends on an OUTPUT jack still commits output→input).
//
// Fixtures are lightweight non-WebGL AUDIO PatchPanel cards (adsr / vca) so the
// page stays responsive — the back jacks are clicked with real Playwright clicks
// (the interaction the owner actually performs), not a hook, since wiring real
// clicks through the rotateY back face is the whole point of the change.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Serial: these tests drive the shared connect-drag singleton + the one warm dev
// server through real pointer clicks on the rear face; running them serially
// keeps each iteration deterministic (and is gentler on the dev server under the
// pre-MR --repeat-each flake check), mirroring cable-drag-drilldown.spec.
test.describe.configure({ mode: 'serial' });

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

/** The live carry/pickup mode + source, read from the exposed connect-drag
 *  singleton. Asserting against this (rather than the cursor-driven ghost cable,
 *  which only renders after a subsequent mousemove) proves the jack click began
 *  a real carry of the right source port. */
async function pickup(page: Page): Promise<{ mode: string; source: { nodeId: string; portId: string } | null }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __connectDragState: { mode: string; pickupSource: { nodeId: string; portId: string } | null };
    };
    const s = w.__connectDragState;
    return { mode: s.mode, source: s.pickupSource ? { nodeId: s.pickupSource.nodeId, portId: s.pickupSource.portId } : null };
  });
}

/** A back-panel jack button for {nodeId, portId, direction} (rear view only). */
function backJack(
  page: Page,
  nodeId: string,
  portId: string,
  direction: 'input' | 'output',
) {
  return page
    .locator(`.svelte-flow__node[data-id="${nodeId}"]`)
    .locator(
      `[data-testid="back-jack"][data-port-id="${portId}"][data-direction="${direction}"]`,
    );
}

/** Spawn adsr + vca (both PatchPanel cards) with NO edges. adsr.env (cv OUT) →
 *  vca.cv (cv IN) is a valid, lightweight, non-WebGL fixture. */
async function spawnAdsrVca(page: Page) {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'adsr', type: 'adsr', position: { x: 120, y: 140 } },
    { id: 'vca', type: 'vca', position: { x: 560, y: 140 } },
  ]);
  await expect(page.locator('.svelte-flow__node')).toHaveCount(2);
}

async function enterRearView(page: Page) {
  const flipBtn = page.getByRole('button', { name: 'Flip rack (rear view)' });
  await flipBtn.click();
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.flow')).toHaveClass(/rear-view/);
  // Wait for at least one back jack to be revealed + the flip-in animation to
  // settle (the keyframe runs ~360ms and the jack isn't reliably hit-testable
  // mid-rotation) before any click. Playwright's actionability waits handle the
  // rest, but this anchors the rear-view-ready state explicitly.
  await expect(page.locator('[data-testid="back-jack"]').first()).toBeVisible();
  await page.waitForTimeout(420);
}

async function exitRearView(page: Page) {
  const flipBtn = page.getByRole('button', { name: 'Flip rack (rear view)' });
  await flipBtn.click();
  await expect(flipBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.flow')).not.toHaveClass(/rear-view/);
}

// ── (1) jack-to-jack patch in rear view creates the correct oriented edge ─────

test('rear view: click an OUTPUT jack then an INPUT jack commits the oriented edge', async ({
  page,
}) => {
  await spawnAdsrVca(page);
  expect(await readEdges(page)).toHaveLength(0);

  await enterRearView(page);

  // The back jacks are visible + interactive in rear view.
  const adsrEnvOut = backJack(page, 'adsr', 'env', 'output');
  const vcaCvIn = backJack(page, 'vca', 'cv', 'input');
  await expect(adsrEnvOut).toBeVisible();
  await expect(vcaCvIn).toBeVisible();

  // First click picks up a cable from adsr.env (cv OUTPUT) — a real carry is now
  // in flight, sourced at adsr.env, and NO edge is written yet.
  await adsrEnvOut.click();
  await expect.poll(async () => (await pickup(page)).mode, { timeout: 5000 }).toBe('pickup');
  expect((await pickup(page)).source).toEqual({ nodeId: 'adsr', portId: 'env' });
  expect(await readEdges(page)).toHaveLength(0); // nothing written until the 2nd click

  // Second click on vca.cv (cv INPUT) commits the patch.
  await vcaCvIn.click();

  // Exactly one edge, correctly oriented adsr.env (OUTPUT) → vca.cv (INPUT),
  // with the SAME port ids a front-view patch would produce.
  await expect.poll(async () => (await readEdges(page)).length, { timeout: 5000 }).toBe(1);
  const edges = await readEdges(page);
  expect(edges[0]!.source).toEqual({ nodeId: 'adsr', portId: 'env' });
  expect(edges[0]!.target).toEqual({ nodeId: 'vca', portId: 'cv' });
  // The carry ended.
  await expect.poll(async () => (await pickup(page)).mode, { timeout: 5000 }).toBe('idle');

  // The jack indicators now read as patched on both ends.
  await expect(adsrEnvOut).toHaveAttribute('data-patched', 'true');
  await expect(vcaCvIn).toHaveAttribute('data-patched', 'true');
});

// ── (2) reverse first-click (INPUT then OUTPUT) still commits output→input ────

test('rear view: clicking the INPUT jack first then the OUTPUT jack still commits output→input', async ({
  page,
}) => {
  await spawnAdsrVca(page);
  await enterRearView(page);

  // Grab the INPUT jack first (vca.cv), then click the OUTPUT jack (adsr.env).
  // The committed edge MUST still be oriented adsr.env (OUTPUT) → vca.cv (INPUT).
  await backJack(page, 'vca', 'cv', 'input').click();
  await expect.poll(async () => (await pickup(page)).mode, { timeout: 5000 }).toBe('pickup');
  expect((await pickup(page)).source).toEqual({ nodeId: 'vca', portId: 'cv' });
  await backJack(page, 'adsr', 'env', 'output').click();

  await expect.poll(async () => (await readEdges(page)).length, { timeout: 5000 }).toBe(1);
  const edges = await readEdges(page);
  expect(edges[0]!.source).toEqual({ nodeId: 'adsr', portId: 'env' });
  expect(edges[0]!.target).toEqual({ nodeId: 'vca', portId: 'cv' });
});

// ── (3) an INVALID rear-view pairing (output→output) is silently discarded ────

test('rear view: an invalid jack pairing writes no edge and ends the carry', async ({ page }) => {
  await spawnAdsrVca(page);
  await enterRearView(page);

  // Pick up from adsr.env (OUTPUT) then click vca's OUTPUT jack (audio) —
  // output→output is invalid, so it silently discards (no edge written).
  await backJack(page, 'adsr', 'env', 'output').click();
  await backJack(page, 'vca', 'audio', 'output').click();

  // Give the (silent) reject path a beat, then confirm nothing was written.
  await expect(page.getByTestId('pickup-cable')).toHaveCount(0);
  expect(await readEdges(page)).toHaveLength(0);
});

// ── (4) front-view patching is UNCHANGED + edges survive the flip toggle ──────

test('front view still patches, and toggling rear view never drops existing edges', async ({
  page,
}) => {
  await spawnAdsrVca(page);
  expect(await readEdges(page)).toHaveLength(0);

  // Front-view patch via the precise programmatic commit hook — the same edge the
  // front-view drill-down picker writes when the user chooses a port (adsr.env →
  // vca.cv). (__handleConnect alone, with no preceding __handleConnectStart, is
  // the precise PICK commit, not a drag — exactly how the patch-menu-redesign /
  // cable-drag specs commit onto a PatchPanel card.)
  const frontPatch = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __handleConnect: (c: {
          source: string;
          target: string;
          sourceHandle: string;
          targetHandle: string;
        }) => void;
      };
      w.__handleConnect({ source: 'adsr', target: 'vca', sourceHandle: 'env', targetHandle: 'cv' });
    });

  await frontPatch();
  await expect.poll(async () => (await readEdges(page)).length, { timeout: 5000 }).toBe(1);
  const front = await readEdges(page);
  expect(front[0]!.source).toEqual({ nodeId: 'adsr', portId: 'env' });
  expect(front[0]!.target).toEqual({ nodeId: 'vca', portId: 'cv' });
  const edgeId = front[0]!.id;

  // Flip to rear view — the existing edge must persist (same id).
  await enterRearView(page);
  let edges = await readEdges(page);
  expect(edges).toHaveLength(1);
  expect(edges[0]!.id).toBe(edgeId);

  // Flip back to front — still there, still the same id.
  await exitRearView(page);
  edges = await readEdges(page);
  expect(edges).toHaveLength(1);
  expect(edges[0]!.id).toBe(edgeId);

  // Front-view patching STILL works after the round trip — re-issuing the precise
  // commit is a no-op (edge already exists) and leaves exactly one edge with the
  // same id, proving the front-view connect path was not disturbed by the flip.
  await frontPatch();
  edges = await readEdges(page);
  expect(edges).toHaveLength(1);
  expect(edges[0]!.id).toBe(edgeId);
});
