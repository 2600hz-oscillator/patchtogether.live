// e2e/tests/workflow-rear-card.spec.ts
//
// REAR CARD — the RACKLINE flip-side patch field in the dock full-view
// (rear-card-spec.md). What this pins:
//
//   1) TAB flips the OPEN dock full-view to the rear card (data-flipped attr,
//      the jack FIELD visible, the control face GONE) and TAB again returns —
//      the front face is HIDDEN, not remounted, so flipping back restores the
//      same controls. The flip rides dockStore.fullViewFlipped — the ONE
//      view-global TAB seam the dock-unification split landed — so with the
//      50/50 side-by-side BOTH panes flip together (asserted below).
//   2) EVERY declared port renders exactly ONE hole (count + id ↔ the live
//      def via window.__moduleSpecs — the no-orphan-holes guarantee), each
//      hole domain-classed off its cable type and PAINTED with the live
//      --cable-* palette hue (color = cable domain only).
//   3) The holes drive the SHIPPED click-click carry seam VERBATIM: click →
//      pickup (connectDragState + PickupCable ghost), incompatible holes DIM
//      while carrying (the Bitwig pre-highlight, inverted), click a lit hole
//      → the SAME validated edge a front-view patch creates.
//
// Runs on /rack?mode=workflow&shell=1 (no DB/relay) — the normal e2e lane,
// same recipe as workflow-shell-faces.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Serial: these tests drive the shared connect-drag singleton through real
// pointer clicks (the rear-view-patching.spec precedent).
test.describe.configure({ mode: 'serial' });

/** Cable type → RACKLINE domain class (mirror of domainClassForCable — the
 *  UI contract this spec pins, restated so a mapping regression can't hide). */
function domainOf(cable: string): string {
  switch (cable) {
    case 'gate':
      return 'gate';
    case 'cv':
    case 'pitch':
      return 'cv';
    case 'polyPitchGate':
    case 'keys':
      return 'poly';
    case 'video':
    case 'image':
    case 'mono-video':
      return 'video';
    default:
      return 'audio';
  }
}

async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow&shell=1');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open a node's TRANSIENT dock full-view via the same dockStore call the
 *  shell tiles' EXPAND buttons make (the shipped __openDockFullView hook).
 *  Waits on the node's OWN pane (a second call = the 50/50 split). */
async function openFullView(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
  );
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
    nodeId,
  );
  await expect(paneOf(page, nodeId)).toBeVisible();
}

/** The full-view faceplate PANE hosting `nodeId`. */
function paneOf(page: Page, nodeId: string) {
  return page.locator(`[data-testid="dock-full-view"][data-fullview-node="${nodeId}"]`);
}

/** Bare TAB — the rack-flip shortcut (Canvas consumes it; no modifiers). */
async function pressTab(page: Page): Promise<void> {
  await page.keyboard.press('Tab');
}

function faceplate(page: Page) {
  return page.getByTestId('dock-full-view');
}
function rearCard(page: Page) {
  return faceplate(page).getByTestId('rear-card');
}
function rearJack(page: Page, portId: string, direction: 'input' | 'output') {
  return rearCard(page).locator(
    `[data-testid="back-jack"][data-port-id="${portId}"][data-direction="${direction}"]`,
  );
}

/** Live pickup mode + source from the exposed connect-drag singleton. */
async function pickup(page: Page): Promise<{ mode: string; source: { nodeId: string; portId: string } | null }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __connectDragState: { mode: string; pickupSource: { nodeId: string; portId: string } | null };
    };
    const s = w.__connectDragState;
    return {
      mode: s.mode,
      source: s.pickupSource ? { nodeId: s.pickupSource.nodeId, portId: s.pickupSource.portId } : null,
    };
  });
}

interface SpecPort {
  id: string;
  type: string;
}
async function portsOf(page: Page, type: string): Promise<{ inputs: SpecPort[]; outputs: SpecPort[] }> {
  return page.evaluate((t) => {
    const w = window as unknown as {
      __moduleSpecs: Array<{ type: string; inputs: { id: string; type: string }[]; outputs: { id: string; type: string }[] }>;
    };
    const spec = w.__moduleSpecs.find((s) => s.type === t);
    if (!spec) throw new Error(`no module spec for ${t}`);
    return { inputs: spec.inputs.map((p) => ({ id: p.id, type: p.type })), outputs: spec.outputs.map((p) => ({ id: p.id, type: p.type })) };
  }, type);
}

// ── (1) TAB ⇄ flip: rear card in, controls gone; TAB again restores ─────────

test('TAB flips the open dock full-view to the rear card and back (controls GONE ⇄ restored)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'tv');

  // FRONT: the curated dock face is up, no rear card, no flip attr.
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'false');
  await expect(faceplate(page).getByTestId('faceplate-editor')).toBeVisible();
  await expect(rearCard(page)).toHaveCount(0);

  // TAB → the rear card: data-attr flips, the jack field is up, the control
  // face (tab rail + editor + every knob cell) is GONE, the REAR·PATCH chip
  // stamps the title bar. The faceplate frame itself stays (same object,
  // turned around).
  await pressTab(page);
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'true');
  await expect(rearCard(page)).toBeVisible();
  await expect(faceplate(page).getByTestId('rear-chip')).toBeVisible();
  await expect(faceplate(page).getByTestId('faceplate-editor')).toBeHidden();
  await expect(faceplate(page).getByTestId('faceplate-tabrail')).toBeHidden();
  expect(
    await faceplate(page).locator('[data-testid^="control-"]:visible').count(),
    'zero control cells render on the rear (patch points only)',
  ).toBe(0);
  // The rear is a patch FIELD: input bands + the fixed OUTPUTS rail.
  await expect(rearCard(page).getByTestId('rear-rail')).toBeVisible();
  expect(await rearCard(page).getByTestId('rear-band').count()).toBeGreaterThan(0);

  // TAB again → front restored (same mounted face, controls visible again).
  await pressTab(page);
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'false');
  await expect(rearCard(page)).toHaveCount(0);
  await expect(faceplate(page).getByTestId('faceplate-editor')).toBeVisible();
  await expect(faceplate(page).locator('[data-testid="control-shape1"]')).toBeVisible();
});

// ── (2) one hole per declared port + domain color = the live cable palette ──

test('every declared port renders exactly one domain-mapped hole (tidyVco, 27 in + 2 out)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'tv');
  await pressTab(page);
  await expect(rearCard(page)).toBeVisible();

  const { inputs, outputs } = await portsOf(page, 'tidyVco');
  expect(inputs.length, 'the def declares 27 inputs').toBe(27);
  expect(outputs.length, 'the def declares 2 outputs').toBe(2);

  // COUNT: exactly one hole per declared port, nothing extra.
  await expect(rearCard(page).locator('[data-testid="back-jack"]')).toHaveCount(
    inputs.length + outputs.length,
  );

  // ID + DIRECTION + DOMAIN: each declared port has its one hole, classed by
  // its cable type (pitch folds to cv-green, poly to pink — spec §1.4).
  for (const [dir, ports] of [
    ['input', inputs],
    ['output', outputs],
  ] as const) {
    for (const p of ports) {
      const jack = rearJack(page, p.id, dir);
      await expect(jack, `${dir} ${p.id}: exactly one hole`).toHaveCount(1);
      await expect(jack, `${dir} ${p.id}: domain class`).toHaveAttribute('data-domain', domainOf(p.type));
    }
  }

  // PAINT: the hole ring takes the LIVE --cable-* hue for its domain (the
  // RACKLINE domain tokens track the live cable palette; committed cable hues
  // untouched). Sample one hole per present domain.
  const ringColor = async (portId: string, dir: 'input' | 'output') =>
    rearJack(page, portId, dir)
      .locator('.hole')
      .evaluate((el) => getComputedStyle(el).borderColor);
  const resolved = async (token: string) =>
    page.evaluate((t) => {
      const probe = document.createElement('div');
      probe.style.color = `var(${t})`;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }, token);
  expect(await ringColor('cutoff_cv', 'input'), 'cv hole = --cable-cv').toBe(await resolved('--cable-cv'));
  expect(await ringColor('gate', 'input'), 'gate hole = --cable-gate').toBe(await resolved('--cable-gate'));
  expect(await ringColor('poly', 'input'), 'poly hole = --cable-polyPitchGate').toBe(
    await resolved('--cable-polyPitchGate'),
  );
});

// ── (3) the click-click carry seam + compatibility dim + a validated commit ──

test('clicking holes patches through the shipped carry seam (pickup ghost, compat dim, validated edge)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'env');
  await pressTab(page);
  await expect(rearCard(page)).toBeVisible();

  // Baseline: the default workflow patch ships pre-wired edges (master →
  // synesthesia); everything below asserts RELATIVE to this set.
  const readEdges = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __patch: { edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined> };
      };
      return Object.values(w.__patch.edges)
        .filter(Boolean)
        .map((e) => `${e!.source.nodeId}.${e!.source.portId}→${e!.target.nodeId}.${e!.target.portId}`)
        .sort();
    });
  const baseline = await readEdges();
  expect(
    baseline.filter((e) => e.includes('env.')),
    'no edge touches the spawned adsr yet',
  ).toEqual([]);

  // CLICK 1 — pick up the ENV output: the SAME patchpanel:jackclick seam the
  // legacy back panel drives (Canvas begins the carry).
  await rearJack(page, 'env', 'output').click();
  const p1 = await pickup(page);
  expect(p1.mode, 'jack click began a pickup carry').toBe('pickup');
  expect(p1.source).toEqual({ nodeId: 'env', portId: 'env' });

  // The ghost cable renders once the cursor moves (PickupCable, dock-anchor
  // fallback already shipped).
  await page.mouse.move(640, 320);
  await page.mouse.move(660, 340);
  await expect(page.getByTestId('pickup-cable')).toBeVisible();

  // COMPATIBILITY DIM (spec §2.2): while the cv ENV cable is carried, the
  // cv-family INPUT holes stay lit, the source pulses, and the incompatible
  // OUTPUT hole (a carried output can only land on an input) dims to ~35%.
  await expect(rearJack(page, 'env', 'output')).toHaveAttribute('data-compat', 'source');
  await expect(rearJack(page, 'attack', 'input')).toHaveAttribute('data-compat', 'ok');
  await expect(rearJack(page, 'gate', 'input')).toHaveAttribute('data-compat', 'ok');
  await expect(rearJack(page, 'env_inv', 'output')).toHaveAttribute('data-compat', 'dim');
  const dimOpacity = await rearJack(page, 'env_inv', 'output').evaluate(
    (el) => Number(getComputedStyle(el).opacity),
  );
  expect(dimOpacity, 'incompatible hole recedes').toBeLessThan(0.5);

  // CLICK 2 — commit on ATTACK: patchpanel:carrycommit → commitCarriedEdge →
  // validateEdge → the SAME oriented edge a front-view patch writes.
  await rearJack(page, 'attack', 'input').click();
  await expect
    .poll(readEdges)
    .toEqual([...baseline, 'env.env→env.attack'].sort());
  expect((await pickup(page)).mode, 'carry ended on commit').toBe('idle');

  // The seated plug: both endpoints read patched, with endpoint chips.
  await expect(rearJack(page, 'env', 'output')).toHaveAttribute('data-patched', 'true');
  await expect(rearJack(page, 'attack', 'input')).toHaveAttribute('data-patched', 'true');
  await expect(rearJack(page, 'attack', 'input').locator('.ep')).toBeVisible();

  // ESC drops a carry without writing (pick up the un-patched SUSTAIN CV
  // input — grabbing a PATCHED input would intentionally detach it, the
  // one-motion rewire — then drop it).
  await rearJack(page, 'sustain', 'input').click();
  expect((await pickup(page)).mode).toBe('pickup');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await pickup(page)).mode).toBe('idle');
  expect(await readEdges(), 'Esc discarded — exactly the one committed edge was added').toEqual(
    [...baseline, 'env.env→env.attack'].sort(),
  );
});

// ── (4) the 50/50 side-by-side split: TAB flips BOTH panes together ─────────

test('50/50 split: TAB flips BOTH panes to their rear cards together (one global flip seam)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [
    { id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } },
    { id: 'env', type: 'adsr', position: { x: 900, y: 240 } },
  ]);
  await openFullView(page, 'tv');
  await openFullView(page, 'env');

  const drawer = page.getByTestId('dock-fullview-drawer');
  await expect(drawer).toHaveAttribute('data-pane-count', '2');
  await expect(page.getByTestId('dock-full-view')).toHaveCount(2);

  // ONE bare TAB → the view-global flip seam → BOTH panes carry the rear.
  await pressTab(page);
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
  for (const nodeId of ['tv', 'env'] as const) {
    await expect(paneOf(page, nodeId)).toHaveAttribute('data-flipped', 'true');
    await expect(paneOf(page, nodeId).getByTestId('rear-card')).toBeVisible();
    await expect(paneOf(page, nodeId).getByTestId('faceplate-editor')).toBeHidden();
  }
  // Half-width panes stay FLAT (bands wrap via the auto-fill raster — no
  // menus, no elision): the busiest field still shows one hole per port.
  // (Scoped INSIDE the rear card — the hidden front face keeps its legacy
  // back-panel buttons in the DOM.)
  await expect(
    paneOf(page, 'tv').getByTestId('rear-card').locator('[data-testid="back-jack"]'),
  ).toHaveCount(29);

  // TAB again → both fronts restored.
  await pressTab(page);
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  await expect(page.getByTestId('rear-card')).toHaveCount(0);
  for (const nodeId of ['tv', 'env'] as const) {
    await expect(paneOf(page, nodeId).getByTestId('faceplate-editor')).toBeVisible();
  }
});
