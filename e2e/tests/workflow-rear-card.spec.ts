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
//   4) SINGLE-OWNER TAB: exactly ONE flip handler acts per keystroke. The dock
//      owns bare TAB while the full-view is open, the canvas-wide "Flip rack"
//      rear view owns it when it's closed, and Shift-TAB owns neither — so the
//      two flip states can never phase-diverge.
//
// Runs on /rack (no DB/relay) — the normal e2e lane,
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
  await page.goto('/rack?shell=legacy');
  // 15s FIRST-LOAD budget — the SAME number workflow-shell.spec.ts and
  // workflow-dock-occupancy.spec.ts already use for this exact route, so it is
  // CI-validated rather than guessed.
  //
  // ROOT CAUSE of the cold-server flake this replaces: SvelteKit dev compiles
  // /rack ON DEMAND. The very FIRST navigation of a run — a fresh
  // `task e2e:serve`, or a cleared node_modules/.vite — pays that compile
  // before the topbar can mount, blowing the 5s expect default; every later
  // load hits the warm module graph, which is why ONLY the first invocation
  // ever reddened. Measured on a cleared-.vite cold server: first test 14.8s
  // wall (~12s of it the compile) vs 2.6-3.3s for each subsequent test.
  //
  // A budget, not a retry: a genuine regression still fails, just 10s later.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
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

/** SHIFT-TAB — reverse focus traversal. Must flip NOTHING, in either state. */
async function pressShiftTab(page: Page): Promise<void> {
  await page.keyboard.press('Shift+Tab');
}

/** The CANVAS-wide rear view container ("Flip rack"): `div.flow.rear-view`.
 *  `div.` qualified because PatchPanel's rail also renders a `span.flow`. */
function canvasFlow(page: Page) {
  return page.locator('div.flow');
}

/** The canvas rear view's semantic surface — the Controls "Flip rack" toggle. */
function flipRackBtn(page: Page) {
  return page.getByTestId('flip-rack-btn');
}

/** Drop focus back to <body>. A Shift-TAB that (correctly) flips nothing DOES
 *  move focus, and a later bare TAB read as "typing" if it landed in an input
 *  would silently pass for the wrong reason. */
async function resetFocus(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
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

test('every declared port is addressed by exactly one domain-mapped hole (tidyVco, 27 in + 2 out)', async ({
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

  // COUNT. ⚠ A hole is no longer 1:1 with a port (PR-4, owner Q5): a derived
  // stereo pair renders as ONE hole addressing TWO ports, so tidyVco's
  // `out_l`+`out_r` cost one hole between them. 29 declared ports → 28 holes.
  // The number is DERIVED from the collapsed pairs actually on screen, not
  // hardcoded, so a genuinely DROPPED jack cannot hide inside the shortfall.
  const stereoHoles = rearCard(page).locator('[data-testid="back-jack"][data-stereo-sibling]');
  await expect(stereoHoles, 'tidyVco has exactly one collapsed pair (out_l+out_r)').toHaveCount(1);
  const collapsed = await stereoHoles.count();
  await expect(rearCard(page).locator('[data-testid="back-jack"]')).toHaveCount(
    inputs.length + outputs.length - collapsed,
  );

  // ID + DIRECTION + DOMAIN: each declared port has its one hole, classed by
  // its cable type (pitch folds to cv-green, poly to pink — spec §1.4).
  for (const [dir, ports] of [
    ['input', inputs],
    ['output', outputs],
  ] as const) {
    for (const p of ports) {
      // A collapsed pair's RIGHT leg has no hole of its own — it is addressed
      // by its partner's `data-stereo-sibling`. Assert that explicitly rather
      // than skipping it, so "collapsed into its sibling" stays distinguishable
      // from "silently missing".
      const jack = rearJack(page, p.id, dir);
      const asSibling = rearCard(page).locator(
        `[data-testid="back-jack"][data-stereo-sibling="${p.id}"][data-direction="${dir}"]`,
      );
      if ((await jack.count()) === 0) {
        await expect(asSibling, `${dir} ${p.id}: addressed by its collapsed partner`).toHaveCount(1);
        continue;
      }
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
  // menus, no elision): the busiest field still shows every patch point.
  // (Scoped INSIDE the rear card — the hidden front face keeps its legacy
  // back-panel buttons in the DOM.)
  //
  // 28 holes for tidyVco's 29 declared ports: `out_l`+`out_r` are a derived
  // stereo pair and render as ONE hole (PR-4, owner Q5). Derived from the
  // collapsed pairs actually present, so a genuinely dropped jack cannot hide
  // inside the shortfall.
  const tvRear = paneOf(page, 'tv').getByTestId('rear-card');
  await expect(
    tvRear.locator('[data-testid="back-jack"][data-stereo-sibling]'),
    'tidyVco has exactly one collapsed pair (out_l+out_r)',
  ).toHaveCount(1);
  // Derived from the DEF and the collapsed pairs measured on the page — not a
  // literal `29 - 1`, which would silently stop tracking the def if a port
  // were ever added or removed.
  const tvPorts = await portsOf(page, 'tidyVco');
  const tvCollapsed = await tvRear
    .locator('[data-testid="back-jack"][data-stereo-sibling]')
    .count();
  await expect(
    tvRear.locator('[data-testid="back-jack"]'),
    `tidyVco: ${tvPorts.inputs.length + tvPorts.outputs.length} declared ports minus ${tvCollapsed} collapsed pair(s)`,
  ).toHaveCount(tvPorts.inputs.length + tvPorts.outputs.length - tvCollapsed);

  // TAB again → both fronts restored.
  await pressTab(page);
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  await expect(page.getByTestId('rear-card')).toHaveCount(0);
  for (const nodeId of ['tv', 'env'] as const) {
    await expect(paneOf(page, nodeId).getByTestId('faceplate-editor')).toBeVisible();
  }
});

// ── (5) SINGLE-OWNER TAB: exactly ONE flip handler acts per keystroke ───────
//
// Bare TAB has TWO consumers in Canvas: the dock keymap (flips the open
// full-view to its rear card) and the older canvas-wide "Flip rack" rear view.
// Both are plain `window` keydown listeners, so preventDefault in one does NOT
// stop the other — ONE keystroke used to toggle BOTH flip states, and the two
// then phase-diverged (flip in the dock, close it, TAB on the canvas → the
// canvas came up already inverted, i.e. TAB appeared to do nothing). And the
// dock branch screened only meta/ctrl/alt, so SHIFT-TAB flipped it too while
// stealing reverse focus traversal. Ownership is now decided by full-view
// OCCUPANCY, not by listener-registration order:
//
//   full-view OPEN   → the DOCK owns bare TAB; the canvas rear view is inert.
//   full-view CLOSED → the CANVAS owns bare TAB (original behavior, unchanged).
//   Shift-TAB        → neither; native focus traversal.

test('full-view OPEN: bare TAB flips ONLY the dock panes — the canvas rear view never moves', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);

  const drawer = page.getByTestId('dock-fullview-drawer');
  await expect(canvasFlow(page), 'canvas starts front-side').not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');

  await openFullView(page, 'tv');
  await pressTab(page);

  // The DOCK flipped…
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
  await expect(rearCard(page)).toBeVisible();
  // …and the canvas did NOT flip behind it (the double-handler bug: the whole
  // rack silently turned around under the open drawer).
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');

  // TAB back — still only the dock moves, so the two states can't drift apart.
  await pressTab(page);
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  await expect(rearCard(page)).toHaveCount(0);
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');
});

test('Shift-TAB flips NOTHING — full-view open or closed (reverse focus nav is not hijacked)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);
  const drawer = page.getByTestId('dock-fullview-drawer');

  // (a) full-view CLOSED — the canvas predicate already excluded shift; pinned
  //     so a regression there can't slip in either.
  await pressShiftTab(page);
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');

  // (b) full-view OPEN — ONE press is the whole assertion: pre-fix a single
  //     Shift-TAB set fullViewFlipped=true (a second would have masked it).
  await resetFocus(page);
  await openFullView(page, 'tv');
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  await pressShiftTab(page);
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  await expect(rearCard(page)).toHaveCount(0);
  await expect(faceplate(page).getByTestId('faceplate-editor')).toBeVisible();
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
});

test('no phase divergence: open → flip → close → bare TAB flips the canvas ON (not pre-inverted)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);
  const drawer = page.getByTestId('dock-fullview-drawer');

  await openFullView(page, 'tv');
  await pressTab(page); // flip the DOCK
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);

  // ESC closes the whole full-view (which also resets the dock's own flip).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dock-full-view')).toHaveCount(0);

  // The canvas rear view was never touched by any of the above, so the very
  // next bare TAB flips it ON — the direction the user expects. Pre-fix the
  // dock flip had silently flipped the canvas too, so this TAB flipped it OFF
  // and the rack appeared unresponsive.
  await resetFocus(page);
  await pressTab(page);
  await expect(canvasFlow(page)).toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'true');

  // And the canvas-owned TAB still toggles cleanly from there (unchanged
  // legacy behavior once the full-view is out of the way).
  await pressTab(page);
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');
});

// ── (5) Canvas rear view must NOT hijack the dock full-view (owner P0) ──────
//
// The drawer sits inside `.flow`, so with the canvas-wide rear view left ON a
// docked LEGACY card inherited `.rear-view`: the ancestor-generic reveal rule
// painted its OLD back panel (`.card-back-panel`, absolute inset:0 z-index:8)
// OVER the pane front while the dock-sized front-inert mirror hid the front —
// and with TAB dock-owned while the full-view is open, there was NO route back
// to the front ("no way to see the front of the panel", 2026-07-26). The fix
// scopes a drawer exemption in _module-card.css (the .rl-tile precedent): the
// full-view's ONLY rear is the RearCard, driven by dockStore.fullViewFlipped.
test('canvas rear view left ON: a docked LEGACY pane still shows its FRONT, and dock-TAB round-trips front⇄RearCard', async ({
  page,
}) => {
  await gotoWorkflow(page);
  // scope: NOT in STRICT_FACES ⇒ the un-migrated/legacy dock path under test.
  await spawnPatch(page, [{ id: 'sc', type: 'scope', position: { x: 460, y: 240 } }]);

  // Arm the trap: flip the CANVAS to rear view BEFORE docking.
  await resetFocus(page);
  await pressTab(page);
  await expect(canvasFlow(page)).toHaveClass(/rear-view/);

  await openFullView(page, 'sc');

  // THE FIX — the pane shows its FRONT even though an ancestor is .rear-view:
  // the legacy card's front content is visible (not visibility:hidden'd by the
  // dock-sized mirror rule) and its OLD back panel is suppressed entirely.
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'false');
  const frontCard = faceplate(page).locator(
    '.fp-card-mount :is(.mod-card, .card, .moog-panel)',
  ).first();
  await expect(frontCard).toBeVisible();
  await expect(faceplate(page).locator('.card-back-panel')).toBeHidden();

  // TAB (dock-owned): the flip side is the NEW RearCard — never the old panel.
  await resetFocus(page);
  await pressTab(page);
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'true');
  await expect(rearCard(page)).toBeVisible();
  await expect(faceplate(page).locator('.card-back-panel')).toBeHidden();

  // TAB again: the round trip the bug made impossible — FRONT restored.
  await pressTab(page);
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'false');
  await expect(frontCard).toBeVisible();

  // Single-owner intact: none of that touched the canvas flip state.
  await expect(canvasFlow(page)).toHaveClass(/rear-view/);
});
