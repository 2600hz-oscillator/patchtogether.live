// e2e/tests/cable-drag-drilldown.spec.ts
//
// Cable-drag → drill-down menu (NO hover action, NO auto-patch).
//
// Owner report: dragging a cable from a card's OUTPUT onto a PatchPanel card
// (hidden, stacked handles) used to AUTO-PATCH to an arbitrary stacked handle
// the moment SvelteFlow's connection-radius snapped — hover did a leftover
// snap, and the release/click committed a patch the user never chose. Worse,
// dropping near the hidden handle stack picked a port at random.
//
// INTENDED (and asserted here):
//   1. A cable dragged from an OUTPUT and RELEASED over a PatchPanel target
//      opens that card's DRILL-DOWN port picker (the patch-to menu pre-drilled
//      into the dropped-on module) — and creates NO edge yet.
//   2. Picking a compatible port in that menu commits the edge.
//   3. The reverse direction — grabbing the target's INPUT and dragging back to
//      an OUTPUT-bearing card — still patches correctly (no "snag"), with the
//      committed edge correctly oriented OUTPUT → INPUT.
//   4. A native drag dropped on a raw-handle target (two visible handles) keeps
//      the precise direct commit (we only divert the ambiguous stacked-handle
//      case).
//
// The drill-down redirect (tests 1–3) is DOMAIN-AGNOSTIC — it triggers on the
// DROP target being a hidden-handle PatchPanel card, regardless of the cable's
// signal type — so these cases drive LIGHTWEIGHT AUDIO modules (analogVco /
// filter). The earlier video-module version (videovarispeed → quadralogical)
// pegged CI's SwiftShader software renderer and starved Playwright's hit-test /
// `elementFromPoint` / `evaluate`, so the picker click timed out on CI even
// though the behaviour was correct (the documented CI-SwiftShader-video-jank
// class). Audio PatchPanel cards exercise the identical suppress-snap +
// open-drill-down path on a responsive page — the same way the proven
// patch-menu-redesign spec drives this picker on CI — so a plain Playwright
// `.click()` works (no force / elementFromPoint instrumentation needed).
//
// Tests 4 and 3b legitimately need RAW-handle cards (two visible handles): the
// direct-commit path applies only to non-PatchPanel targets. Those are the
// video cards (videovarispeed / videoOut); they're hook-driven (no fine pointer
// interaction) so they stay green on CI and are left unchanged.
//
// The drag lifecycle is driven through the dev-only __handleConnectStart /
// __handleConnectEnd hooks — the SAME production functions SvelteFlow's pointer
// drag calls (connectstart → connectend) — so we exercise the real
// suppress-snap + open-drill-down path without pixel-perfect pointer moves on a
// stacked-handle card. The drop point passed to __handleConnectEnd is a real
// screen coordinate inside the target card, so handleConnectEnd's
// elementFromPoint resolves the dropped-on card exactly as a real release does.

import { test, expect } from './_fixtures';
import { type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Serial (not parallel): this spec shares a shard with heavy WebGL video specs
// (e.g. backdraft) that can crash the SwiftShader browser under contention on
// CI; running these few cable-drag cases serially keeps the worker stable and
// avoids inheriting a dead browser from a parallel sibling.
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

/** Centre screen point of a card (where a real release would land). */
async function cardCenter(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(`.svelte-flow__node[data-id="${nodeId}"]`).boundingBox();
  expect(box, `card ${nodeId} must be mounted`).toBeTruthy();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** The `data-port-id`s the drilled-down picker currently offers. */
async function offeredPortIds(menu: Locator): Promise<string[]> {
  return menu
    .locator('[data-testid="patch-to-port"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-port-id') ?? ''));
}

/** Pick a port in the drill-down picker. With audio PatchPanel cards the page
 *  stays responsive (no WebGL render starving the hit-test), so a plain
 *  Playwright click works — the same interaction the proven patch-menu-redesign
 *  spec uses for this picker on CI. */
async function pickPort(menu: Locator, portId: string): Promise<void> {
  const opt = menu.locator(`[data-testid="patch-to-port"][data-port-id="${portId}"]`);
  await expect(opt).toBeVisible();
  await opt.click();
}

/** Drive a native cable DRAG: grab a handle, release over a screen point —
 *  exactly the connectstart → connectend lifecycle a pointer drag fires. */
async function dragHandleTo(
  page: Page,
  source: { nodeId: string; handleId: string; handleType: 'source' | 'target' },
  drop: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    ({ source, drop }) => {
      const w = window as unknown as {
        __handleConnectStart: (p: {
          nodeId: string;
          handleId: string;
          handleType: 'source' | 'target';
        }) => void;
        __handleConnectEnd: (d: { x: number; y: number }) => void;
      };
      w.__handleConnectStart(source);
      w.__handleConnectEnd(drop);
    },
    { source, drop },
  );
}

/** analogVco (audio OUTPUTs) + filter (PatchPanel, hidden handle stack, audio
 *  IN + OUT) — lightweight, non-WebGL cards that exercise the same drill-down
 *  redirect as the video pair without janking the page on CI. */
async function spawnVcoFilter(page: Page) {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'vco', type: 'analogVco', position: { x: 80, y: 120 } },
    { id: 'flt', type: 'filter', position: { x: 760, y: 120 } },
  ]);
}

// ── (1) drag onto a PatchPanel card opens the drill-down picker, no edge yet ──

test('drag from an OUTPUT onto a PatchPanel card opens the drill-down picker and creates NO edge', async ({
  page,
}) => {
  await spawnVcoFilter(page);
  expect(await readEdges(page)).toHaveLength(0);

  // Drag VCO.saw (an audio OUTPUT) and release over FILTER (a hidden-handle
  // PatchPanel card).
  await dragHandleTo(
    page,
    { nodeId: 'vco', handleId: 'saw', handleType: 'source' },
    await cardCenter(page, 'flt'),
  );

  // The drill-down picker is OPEN (overlay-replace, body-portaled), pre-drilled
  // into FILTER so the user is on its compatible-port list.
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-testid="patch-to-ports"]')).toBeVisible();
  // It lists FILTER's audio input (`audio`) — compatible with an audio source —
  // and crucially NO edge has been written yet.
  const portIds = await offeredPortIds(menu);
  expect(portIds).toContain('audio');
  expect(await readEdges(page)).toHaveLength(0);
});

// ── (2) picking a port in that menu commits the edge ─────────────────────────

test('picking a port in the drilled-down picker commits the chosen edge', async ({ page }) => {
  await spawnVcoFilter(page);

  await dragHandleTo(
    page,
    { nodeId: 'vco', handleId: 'saw', handleType: 'source' },
    await cardCenter(page, 'flt'),
  );

  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  // Wait for the drilled-in port list to render before picking — on CI's slower
  // runner the body-portaled sublist mounts a beat after the menu container,
  // and clicking before it exists raced the commit.
  await expect(menu.locator('[data-testid="patch-to-ports"]')).toBeVisible();

  // Pick the first compatible port the picker offers (read it back rather than
  // hardcoding, then assert the edge targets exactly that port).
  const offered = await offeredPortIds(menu);
  expect(offered.length).toBeGreaterThan(0);
  const picked = offered[0]!;
  await pickPort(menu, picked);

  // Exactly the edge the user chose lands — vco.saw → flt.<picked>.
  await expect.poll(async () => (await readEdges(page)).length, { timeout: 5000 }).toBe(1);
  const edges = await readEdges(page);
  expect(edges[0]!.source).toEqual({ nodeId: 'vco', portId: 'saw' });
  expect(edges[0]!.target).toEqual({ nodeId: 'flt', portId: picked });
  // The picker closed after the commit.
  await expect(menu).toHaveCount(0);
});

// ── (3) reverse-direction drag onto a PatchPanel card opens the picker for the
//        card's OUTPUTS, and the committed edge is correctly oriented ──────────

test('reverse drag — grab an INPUT, drop on a PatchPanel card — picker offers the card OUTPUTS and orients the edge', async ({ page, rack }) => {
  // FILTER (audio `audio` INPUT) ← VCO (PatchPanel, audio OUTPUTs). Grabbing the
  // input and dragging to the output is the reverse direction the owner reported
  // as snagging; the picker must offer VCO's compatible OUTPUTS and the
  // resulting edge must run vco.<out> (OUTPUT) → flt.audio (INPUT).
  // VCO is the DROP target, so place it where the forward-drag test drops
  // (x:760) — a proven-visible region away from the left viewport edge.
  await spawnPatch(page, [
    { id: 'flt', type: 'filter', position: { x: 80, y: 120 } },
    { id: 'vco', type: 'analogVco', position: { x: 760, y: 120 } },
  ]);
  expect(await readEdges(page)).toHaveLength(0);

  // Grab FILTER's `audio` (a target/INPUT handle) and release over VCO.
  await dragHandleTo(
    page,
    { nodeId: 'flt', handleId: 'audio', handleType: 'target' },
    await cardCenter(page, 'vco'),
  );

  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-testid="patch-to-ports"]')).toBeVisible();
  // The source is an INPUT, so the picker offers VCO's compatible OUTPUTS (its
  // audio waveform outs, e.g. `saw`) — and NO edge yet.
  const portIds = await offeredPortIds(menu);
  expect(portIds).toContain('saw');
  expect(await readEdges(page)).toHaveLength(0);

  // Pick the first offered OUTPUT → edge runs vco.<out> (OUTPUT) → flt.audio
  // (INPUT), correctly oriented.
  const picked = portIds[0]!;
  await pickPort(menu, picked);
  await expect.poll(async () => (await readEdges(page)).length, { timeout: 5000 }).toBe(1);
  const edges = await readEdges(page);
  expect(edges[0]!.source).toEqual({ nodeId: 'vco', portId: picked });
  expect(edges[0]!.target).toEqual({ nodeId: 'flt', portId: 'audio' });
  // The picker closed after the commit.
  await expect(menu).toHaveCount(0);
});

// ── (3b/4) raw→raw direct-commit — REMOVED, no card fixture left ─────────────
//
// Two tests used to live here: a reverse raw→raw drag and a forward raw→raw
// drag, both asserting a PRECISE visible-handle drop commits the edge DIRECTLY
// (no drill-down picker). Their only fixture was `chroma`, the last video card
// with visible raw side-jacks. THIS PR migrates chroma (and the rest of the
// exposed-jack video cards) to the PatchPanel drill-down, so:
//   • no card renders raw handles any more — the `card patch-surface invariants`
//     test in modules-card-map.test.ts now BANS raw <Handle> jacks outright
//     (allowlist: clockedRunner/livecode/sticky, all zero-port by design) — so
//     there is no module the raw→raw direct-commit path can be exercised against;
//   • dropping onto ANY card is now a PatchPanel target → it opens the picker,
//     never the direct commit. The direct-commit branch is vestigial fallback.
// Deleting (not skipping) per reconcile-means-fix-or-delete: the behaviour these
// tests covered no longer has a fixture. Reverse-drag ORIENTATION is still
// covered by test (3) `reverse drag … PatchPanel … orients the edge`, and edge
// commit via the picker by test (3a) `picking a port … commits the chosen edge`.
