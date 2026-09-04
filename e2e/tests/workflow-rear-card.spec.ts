// e2e/tests/workflow-rear-card.spec.ts
//
// REAR CARD — the RACKLINE flip-side patch field in the dock full-view
// (RearCard.svelte). What this pins:
//
//   1) THE FLIP KEY flips the OPEN dock full-view to the rear card
//      (data-flipped attr, the jack FIELD visible, the control face GONE) and
//      again returns — the front face is HIDDEN, not remounted, so flipping
//      back restores the same controls. The flip rides
//      dockStore.fullViewFlipped — the ONE view-global flip seam the
//      dock-unification split landed — so with the 50/50 side-by-side BOTH
//      panes flip together (asserted below).
//
//      ⚠ The flip key is BARE TAB by owner ruling (#1629 — the #1508→#1599
//      rebind to `f` was reversed): the flip gesture deliberately consumes
//      Tab outside typing targets. `pressFlipKey` reads the binding from the
//      app source (_flip-key.ts → RACK_FLIP_KEY); `pressShiftTab` below is
//      the NEGATIVE case, asserted to flip nothing.
//   2) EVERY declared port renders exactly ONE hole (count + id ↔ the live
//      def via window.__moduleSpecs — the no-orphan-holes guarantee), each
//      hole domain-classed off its cable type and PAINTED with the live
//      --cable-* palette hue (color = cable domain only).
//   2b) DIRECTION READS WITHOUT COLOUR (#1800): both rails share one compact
//      row grammar now, so the cues are measured — rows MIRROR (jack on the
//      row's outer edge), the two ZONES split left/right, every section
//      heading carries its ←/→ — and, the inverse, one cable domain resolves
//      to one hue on BOTH rails.
//   3) The holes drive the SHIPPED click-click carry seam VERBATIM: click →
//      pickup (connectDragState + PickupCable ghost), incompatible holes DIM
//      while carrying (the Bitwig pre-highlight, inverted), click a lit hole
//      → the SAME validated edge a front-view patch creates.
//   4) SINGLE-OWNER FLIP KEY: exactly ONE flip handler acts per keystroke. The
//      dock owns it while the full-view is open, the canvas-wide "Flip rack"
//      rear view owns it when it's closed, and Shift-TAB owns neither — so
//      the two flip states can never phase-diverge.
//
// Runs on /rack (no DB/relay) — the normal e2e lane,
// same recipe as workflow-shell-faces.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { REGISTRY } from './_registry';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';
// The cartesian grid size, imported from the APP SOURCE for the same
// reason `_flip-key.ts` imports RACK_FLIP_KEY: section (6) needs the LAST cell
// of the grid (the one where nav declines and the flip must still fire), and
// re-typing it here would leave the control pointing at the wrong cell —
// silently passing — the day the grid size changes.
import { CELL_COUNT } from '../../packages/web/src/lib/audio/modules/cartesian';

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
  await page.goto('/rack');
  // 15s FIRST-LOAD budget — the SAME number workflow-shell.spec.ts and
  // workflow-dock-occupancy.spec.ts already use for this exact route, so it is
  // CI-validated rather than guessed.
  //
  // ROOT CAUSE of the cold-server flake this replaces: SvelteKit dev compiles
  // /rack?shell=legacy&seed=none ON DEMAND. The very FIRST navigation of a run — a fresh
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

/** SHIFT-TAB — reverse focus traversal, deliberately left native (#1629).
 *  Must flip NOTHING, in either occupancy state. */
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

/** Drop focus back to <body>. A traversal key that (correctly) flips nothing
 *  DOES move focus, and the flip key is INERT in a text field / select
 *  (isTypingTarget) — so a later flip press swallowed that way would silently
 *  pass for the wrong reason. Park focus somewhere harmless first. */
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

// ── (1) FLIP KEY: rear card in, controls gone; press again restores ────────

test('the flip key flips the open dock full-view to the rear card and back (controls GONE ⇄ restored)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'tv');

  // FRONT: the curated dock face is up, no rear card, no flip attr.
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'false');
  await expect(faceplate(page).getByTestId('faceplate-editor')).toBeVisible();
  await expect(rearCard(page)).toHaveCount(0);

  // FLIP → the rear card: data-attr flips, the jack field is up, the control
  // face (tab rail + editor + every knob cell) is GONE, the REAR·PATCH chip
  // stamps the title bar. The faceplate frame itself stays (same object,
  // turned around).
  await pressFlipKey(page);
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'true');
  await expect(rearCard(page)).toBeVisible();
  await expect(faceplate(page).getByTestId('rear-chip')).toBeVisible();
  await expect(faceplate(page).getByTestId('faceplate-editor')).toBeHidden();
  await expect(faceplate(page).getByTestId('faceplate-tabrail')).toBeHidden();
  expect(
    await faceplate(page).locator('[data-testid^="control-"]:visible').count(),
    'zero control cells render on the rear (patch points only)',
  ).toBe(0);
  // The rear is a patch FIELD: two direction ZONES of section COLUMNS (#1800).
  await expect(
    rearCard(page).locator('[data-testid="rear-zone"][data-direction="input"]'),
  ).toBeVisible();
  await expect(
    rearCard(page).locator('[data-testid="rear-zone"][data-direction="output"]'),
  ).toBeVisible();
  expect(await rearCard(page).getByTestId('rear-section').count()).toBeGreaterThan(0);

  // FLIP again → front restored (same mounted face, controls visible again).
  await pressFlipKey(page);
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'false');
  await expect(rearCard(page)).toHaveCount(0);
  await expect(faceplate(page).getByTestId('faceplate-editor')).toBeVisible();
  await expect(faceplate(page).locator('[data-testid="control-shape1"]')).toBeVisible();
});

// ── (2) one hole per declared port + domain color = the live cable palette ──

test('every declared port is addressed by exactly one domain-mapped hole (tidyVco)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'tv');
  await pressFlipKey(page);
  await expect(rearCard(page)).toBeVisible();

  const { inputs, outputs } = await portsOf(page, 'tidyVco');
  // NON-VACUITY, not a port census: the two literals that used to sit here
  // (`27` in, `2` out) were hand-typed population counts of a def this spec
  // does not own, and every assertion below already reads the live lists.
  expect(inputs.length, 'the live def reported inputs').toBeGreaterThan(0);
  expect(outputs.length, 'the live def reported outputs').toBeGreaterThan(0);

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

// ── (2b) DIRECTION IS LEGIBLE WITHOUT COLOUR (#1800) ────────────────────────
//
// The redesign gave both rails ONE row grammar, and the shipped card had named
// the input/output shape difference as one of its three direction cues. This is
// the DOM/geometry half of the replacement — `rear-direction.test.ts` reads the
// component SOURCE and can only prove the rules exist, never that they produce
// a difference on screen. Measured in CSS px off real boxes.
//
// ⚠ AND THE INVERSE, in the same test: the same CABLE TYPE resolves to the SAME
// HUE on both rails. That is what "colour means cable domain only" means
// operationally, and it is the property the four direction channels exist to
// avoid spending. adsr is the fixture because it declares cv on BOTH rails
// (attack/decay/… in, env/env_inv out) — a module with no shared domain would
// make this leg vacuous.

test('direction reads without colour: rows MIRROR, zones split, glyphs point — and the hue does not move', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'env');
  await pressFlipKey(page);
  await expect(rearCard(page)).toBeVisible();

  // CHANNEL: ROW MIRROR — the jack rides the row's OUTER edge. Measured in the
  // PAGE (one evaluate, not a poll loop): for each row, is the hole's centre
  // left or right of the label's centre?
  const rows = await rearCard(page).evaluate((card) =>
    Array.from(card.querySelectorAll('[data-testid="back-jack"]')).map((j) => {
      const hole = j.querySelector('.hole')!.getBoundingClientRect();
      const lab = j.querySelector('[data-testid="jack-label"]')!.getBoundingClientRect();
      return {
        portId: j.getAttribute('data-port-id'),
        direction: j.getAttribute('data-direction'),
        // CSS px, both centres, so the sign IS the mirror.
        deltaPx: hole.left + hole.width / 2 - (lab.left + lab.width / 2),
        hue: getComputedStyle(j).getPropertyValue('--rcd').trim(),
        cable: j.getAttribute('data-domain'),
      };
    }),
  );
  const ins = rows.filter((r) => r.direction === 'input');
  const outs = rows.filter((r) => r.direction === 'output');
  // The probe read something on BOTH rails — otherwise "every row mirrors" is
  // a statement about an empty set.
  expect(ins.length, 'input rows sampled').toBeGreaterThan(0);
  expect(outs.length, 'output rows sampled').toBeGreaterThan(0);
  expect(
    ins.filter((r) => r.deltaPx >= 0).map((r) => `${r.portId} +${r.deltaPx.toFixed(1)}px`),
    'every INPUT row puts its jack LEFT of its label (CSS px, hole centre − label centre)',
  ).toEqual([]);
  expect(
    outs.filter((r) => r.deltaPx <= 0).map((r) => `${r.portId} ${r.deltaPx.toFixed(1)}px`),
    'every OUTPUT row puts its jack RIGHT of its label (CSS px, hole centre − label centre)',
  ).toEqual([]);

  // CHANNEL: ZONE — the output zone sits to the RIGHT of the input zone.
  const zones = await rearCard(page).evaluate((card) => {
    const box = (dir: string) =>
      card.querySelector(`[data-testid="rear-zone"][data-direction="${dir}"]`)!.getBoundingClientRect();
    return { inLeft: box('input').left, outLeft: box('output').left };
  });
  expect(zones.outLeft, 'the OUT zone starts right of the IN zone (CSS px)').toBeGreaterThan(
    zones.inLeft,
  );

  // CHANNEL: SECTION GLYPH — every section heading carries an arrow, and the
  // arrow agrees with the section's declared direction.
  const glyphs = await rearCard(page).evaluate((card) =>
    Array.from(card.querySelectorAll('[data-testid="rear-section"]')).map((s) => ({
      id: s.getAttribute('data-section-id'),
      direction: s.getAttribute('data-direction'),
      glyph: s.querySelector('.rsec-dir')?.textContent?.trim() ?? '',
    })),
  );
  expect(glyphs.length, 'sections sampled').toBeGreaterThan(0);
  expect(
    glyphs.filter((g) => g.glyph !== (g.direction === 'input' ? '←' : '→')),
    'a section heading whose arrow disagrees with its direction (or has none)',
  ).toEqual([]);

  // THE INVERSE: hue is a pure function of cable domain, not of direction.
  const byDomain = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!byDomain.has(r.cable!)) byDomain.set(r.cable!, new Set());
    byDomain.get(r.cable!)!.add(r.hue);
  }
  // The fixture really does put one domain on both rails — assert it, so this
  // leg cannot quietly become vacuous if adsr's ports ever change.
  const shared = [...new Set(ins.map((r) => r.cable))].filter((d) =>
    outs.some((r) => r.cable === d),
  );
  expect(shared, 'adsr is still the both-rails-one-domain fixture').not.toEqual([]);
  for (const [domain, hues] of byDomain) {
    expect([...hues], `${domain}: one hue across both rails`).toHaveLength(1);
  }
  // NEGATIVE CONTROL for that probe: two DIFFERENT domains must read two
  // different hues, or "one hue per domain" would also be true of a card that
  // painted everything the same.
  expect(byDomain.size, 'more than one domain on this card').toBeGreaterThan(1);
  const allHues = new Set([...byDomain.values()].flatMap((s) => [...s]));
  expect(allHues.size, 'the hues actually differ between domains').toBe(byDomain.size);
});

// ── (3) the click-click carry seam + compatibility dim + a validated commit ──

test('clicking holes patches through the shipped carry seam (pickup ghost, compat dim, validated edge)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'env', type: 'adsr', position: { x: 460, y: 240 } }]);
  await openFullView(page, 'env');
  await pressFlipKey(page);
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

// ── (4) the 50/50 side-by-side split: ONE press flips BOTH panes together ──

test('50/50 split: the flip key flips BOTH panes to their rear cards together (one global flip seam)', async ({
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

  // ONE flip-key press → the view-global flip seam → BOTH panes carry the rear.
  await pressFlipKey(page);
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
  for (const nodeId of ['tv', 'env'] as const) {
    await expect(paneOf(page, nodeId)).toHaveAttribute('data-flipped', 'true');
    await expect(paneOf(page, nodeId).getByTestId('rear-card')).toBeVisible();
    await expect(paneOf(page, nodeId).getByTestId('faceplate-editor')).toBeHidden();
  }
  // Half-width panes stay FLAT (section columns wrap — no menus, no elision,
  // and since #1800 no disclosure either): the busiest field still shows every
  // patch point.
  // (Scoped INSIDE the rear card — the hidden front face keeps its legacy
  // back-panel buttons in the DOM.)
  //
  // `out_l`+`out_r` are a derived stereo pair and render as ONE hole (PR-4,
  // owner Q5), so the rendered count is the declared count minus the collapsed
  // pairs actually present — read off the live def and the live page, never a
  // literal, so a genuinely dropped jack cannot hide inside the shortfall.
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

  // FLIP again → both fronts restored.
  await pressFlipKey(page);
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  await expect(page.getByTestId('rear-card')).toHaveCount(0);
  for (const nodeId of ['tv', 'env'] as const) {
    await expect(paneOf(page, nodeId).getByTestId('faceplate-editor')).toBeVisible();
  }
});

// ── (5) SINGLE-OWNER FLIP KEY: exactly ONE handler acts per keystroke ──────
//
// The flip key has TWO consumers in Canvas: the dock keymap (flips the open
// full-view to its rear card) and the older canvas-wide "Flip rack" rear view.
// Both are plain `window` keydown listeners, so preventDefault in one does NOT
// stop the other — ONE keystroke used to toggle BOTH flip states, and the two
// then phase-diverged (flip in the dock, close it, press on the canvas → the
// canvas came up already inverted, i.e. the key appeared to do nothing).
// Ownership is decided by full-view OCCUPANCY, not by listener-registration
// order, so it holds whichever listener happens to be registered first:
//
//   full-view OPEN   → the DOCK owns the flip key; the canvas view is inert.
//   full-view CLOSED → the CANVAS owns the flip key.
//   TAB / Shift-TAB  → neither; native focus traversal, both directions.

test('full-view OPEN: the flip key flips ONLY the dock panes — the canvas rear view never moves', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);

  const drawer = page.getByTestId('dock-fullview-drawer');
  await expect(canvasFlow(page), 'canvas starts front-side').not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');

  await openFullView(page, 'tv');
  await pressFlipKey(page);

  // The DOCK flipped…
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
  await expect(rearCard(page)).toBeVisible();
  // …and the canvas did NOT flip behind it (the double-handler bug: the whole
  // rack silently turned around under the open drawer).
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');

  // FLIP back — still only the dock moves, so the two states can't drift apart.
  await pressFlipKey(page);
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  await expect(rearCard(page)).toHaveCount(0);
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');
});

// PERMANENT REGRESSION LEG for #1629 (which reversed #1508→#1599). Bare Tab
// IS the flip key by owner ruling — every pressFlipKey() leg above exercises
// exactly that keystroke. What must stay INERT is SHIFT-Tab (the one
// traversal deliberately kept native), in BOTH occupancy states, because
// that is exactly where the SINGLE-OWNER guard lives and where the previous
// phase-divergence bug was.
test('Shift-TAB flips NOTHING — full-view open or closed (reverse traversal stays native)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);
  const drawer = page.getByTestId('dock-fullview-drawer');

  // (a) full-view CLOSED — the canvas-wide rear view owns the flip key here.
  await resetFocus(page);
  await pressShiftTab(page);
  await expect(canvasFlow(page), 'Shift-Tab must not flip the canvas').not.toHaveClass(
    /rear-view/,
  );
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');

  // (b) full-view OPEN — the DOCK owns the flip key here. ONE press is the
  //     whole assertion: a leaked flip would set fullViewFlipped=true (a
  //     second press would mask it by flipping back).
  await resetFocus(page);
  await openFullView(page, 'tv');
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  await pressShiftTab(page);
  await expect(drawer, 'Shift-Tab must not flip the dock panes').toHaveAttribute(
    'data-fullview-flipped',
    'false',
  );
  await expect(rearCard(page)).toHaveCount(0);
  await expect(faceplate(page).getByTestId('faceplate-editor')).toBeVisible();
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
});

test('no phase divergence: open → flip → close → the flip key turns the canvas ON (not pre-inverted)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);
  const drawer = page.getByTestId('dock-fullview-drawer');

  await openFullView(page, 'tv');
  await pressFlipKey(page); // flip the DOCK
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);

  // ESC closes the whole full-view (which also resets the dock's own flip).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dock-full-view')).toHaveCount(0);

  // The canvas rear view was never touched by any of the above, so the very
  // next flip-key press turns it ON — the direction the user expects. Pre-fix
  // the dock flip had silently flipped the canvas too, so this press turned it
  // OFF and the rack appeared unresponsive.
  await resetFocus(page);
  await pressFlipKey(page);
  await expect(canvasFlow(page)).toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'true');

  // And the canvas-owned flip still toggles cleanly from there (unchanged
  // legacy behavior once the full-view is out of the way).
  await pressFlipKey(page);
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');
});

// ── (5) Canvas rear view must NOT hijack the dock full-view (owner P0) ──────
//
// The drawer sits inside `.flow`, so with the canvas-wide rear view left ON a
// docked LEGACY card inherited `.rear-view`: the ancestor-generic reveal rule
// painted its OLD back panel (`.card-back-panel`, absolute inset:0 z-index:8)
// OVER the pane front while the dock-sized front-inert mirror hid the front —
// and with the flip key dock-owned while the full-view is open, there was NO route back
// to the front ("no way to see the front of the panel", 2026-07-26). The fix
// scopes a drawer exemption in _module-card.css (the .rl-tile precedent): the
// full-view's ONLY rear is the RearCard, driven by dockStore.fullViewFlipped.
test('canvas rear view left ON: a docked LEGACY pane still shows its FRONT, and the dock flip round-trips front⇄RearCard', async ({
  page,
}) => {
  // ── THE INSTRUMENT FIRST, THEN THE MIGRATION (the `deriveFixture` order) ──
  // A scan that recognises none of its candidates has gone BLIND, and a blind
  // scan reports itself as a finished migration — so it must red here, before
  // the skip below can absorb it. See `pickLegacyDockType`.
  expect(
    LEGACY_DOCK.kind === 'no-candidate' ? LEGACY_DOCK.why : null,
    'the legacy-dock candidate scan recognised nothing',
  ).toBeNull();
  // An exhausted candidate set is the DESIGNED end state, not a failure: the
  // `.fp-card-mount` branch this case is about is deleted with the legacy card
  // fleet. A NAMED skip carrying the reason — never a silent pass, and never a
  // throw that reads like a product regression (#2295).
  test.skip(LEGACY_DOCK.kind === 'migration-complete', LEGACY_DOCK.why);

  await gotoWorkflow(page);
  // ⚠ THE SUBJECT IS DERIVED, AND IT USED TO BE THE HARD-CODED `scope`.
  //
  // This test's subject is A DOCKED LEGACY PANE — `DockFullView.svelte` renders
  // `.fp-card-mount` only in its `{:else}` (un-migrated) branch — so the whole
  // assertion is CONDITIONAL ON THE OCCUPANT NOT BEING FACED. `scope` was named
  // here with the comment "NOT in STRICT_FACES", and promoting it (2026-08-23)
  // made that comment false and `.fp-card-mount` count 0: the test went red on a
  // change that broke nothing it was written to protect.
  //
  // Fixed at the SUBJECT rather than the threshold, and DERIVED rather than
  // re-typed, because re-typing another module's name only moves the same trap
  // to whoever promotes THAT one next. `LEGACY_DOCK_CANDIDATES` is a small
  // ordered set of plain panel cards; the first one still un-faced wins, so this
  // self-heals through the next several promotions and fails LOUDLY (naming the
  // condition) rather than mysteriously if the fleet ever finishes them all.
  //
  // ⚠ The candidates are NAMED rather than "first un-faced module in the
  // registry" on purpose: a bare registry scan would happily wander onto a
  // device module needing hardware, or onto DOOM.
  //
  // ⚠ AND EXHAUSTION IS NO LONGER A THROW (#2295). It used to `throw new Error`
  // from inside this body when every candidate was faced — a hard RED, in a
  // migration state that is DESIGNED, on whichever unrelated PR happened to
  // promote the last one. `moog960` and `cartesian` are already spent; the
  // runway is one. The three outcomes are resolved above.
  const legacyType = LEGACY_DOCK.type!;
  await spawnPatch(page, [{ id: 'sc', type: legacyType, position: { x: 460, y: 240 } }]);

  // Arm the trap: flip the CANVAS to rear view BEFORE docking.
  await resetFocus(page);
  await pressFlipKey(page);
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

  // FLIP (dock-owned): the flip side is the NEW RearCard — never the old panel.
  await resetFocus(page);
  await pressFlipKey(page);
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'true');
  await expect(rearCard(page)).toBeVisible();
  await expect(faceplate(page).locator('.card-back-panel')).toBeHidden();

  // FLIP again: the round trip the bug made impossible — FRONT restored.
  await pressFlipKey(page);
  await expect(faceplate(page)).toHaveAttribute('data-flipped', 'false');
  await expect(frontCard).toBeVisible();

  // Single-owner intact: none of that touched the canvas flip state.
  await expect(canvasFlow(page)).toHaveClass(/rear-view/);
});

/**
 * Plain audio panel cards that make good stand-ins for "an un-faced module with
 * an ordinary legacy card", in preference order. Each must render one of the
 * front-card classes the test selects on (`.mod-card` / `.card` /
 * `.moog-panel`) and must need no hardware, no ROM and no file load.
 *
 * ⚠ NOT a registry scan. "The first module with `strictFace !== true`" would
 * also match device modules that want hardware and, worse, DOOM — which is
 * untouchable by owner ruling. A named set cannot wander.
 */
const LEGACY_DOCK_CANDIDATES = ['moog956', 'moog960', 'cartesian'] as const;

/**
 * What the candidate scan found — THREE outcomes, deliberately, and the shape
 * is `_face-fixtures.ts`'s `deriveFixture` rather than a fourth invention:
 *
 *   * `ok` — `type` is an un-faced candidate; run the case.
 *   * `migration-complete` — every candidate is REGISTERED and every one of
 *     them is FACED. That is the designed end state of the face programme, not
 *     a defect: `DockFullView`'s `{:else}` branch (`.fp-card-mount`) has no
 *     occupant left to prove, and the branch itself is scheduled for deletion
 *     with the legacy card fleet. A NAMED SKIP, never a silent pass.
 *   * `no-candidate` — the scan recognises NONE of the names. That cannot be a
 *     migration state (promotion moves a module between the two sets above; it
 *     never removes it from the registry), so it means the list has rotted or
 *     the manifest stopped loading. RED, with the names printed.
 *
 * ⚠ THE INSTRUMENT CHECK COMES FIRST, for the reason `deriveFixture` states at
 * length: a scan that recognises nothing presents itself as a finished
 * migration, and that failure is silent and green — the worse of the two.
 */
type LegacyDockPick =
  | { kind: 'ok'; type: string; why: string }
  | { kind: 'migration-complete' | 'no-candidate'; type: null; why: string };

function pickLegacyDockType(): LegacyDockPick {
  const faced = new Set(REGISTRY.filter((m) => m.strictFace === true).map((m) => m.type));
  const known = new Set(REGISTRY.map((m) => m.type));
  const registered = LEGACY_DOCK_CANDIDATES.filter((t) => known.has(t));
  const unfaced = registered.filter((t) => !faced.has(t));

  if (registered.length === 0) {
    return {
      kind: 'no-candidate',
      type: null,
      why:
        `workflow-rear-card: the registry manifest knows NONE of the LEGACY_DOCK_CANDIDATES ` +
        `(${LEGACY_DOCK_CANDIDATES.join(', ')}). That is not a migration state — promotion moves ` +
        'a module from un-faced to faced, it never unregisters one — so either these names were ' +
        'renamed/deleted, or the manifest did not load. FIX THE LIST (or the manifest); do not ' +
        'read a finished migration into it.',
    };
  }
  if (unfaced.length === 0) {
    return {
      kind: 'migration-complete',
      type: null,
      why:
        `workflow-rear-card: every LEGACY_DOCK_CANDIDATES entry (${registered.join(', ')}) is now ` +
        'in STRICT_FACES, so the LEGACY dock pane has NO OCCUPANT LEFT, BY DESIGN. This case\'s ' +
        "subject is the un-migrated branch of DockFullView (`.fp-card-mount`), which the face " +
        'programme is finishing: when the last module is faced the branch is deleted and this ' +
        'case goes with it. ⚠ DO NOT re-point it at a faced module — a faced occupant renders ' +
        '<ModuleShell>, and the flip it would then exercise is the RearCard round-trip already ' +
        'covered by sections (1) and (4) above. Delete this case with the branch instead.',
    };
  }
  const type = unfaced[0]!;
  return {
    kind: 'ok',
    type,
    why: `legacy dock occupant: ${type} — first un-faced of ${registered.join(', ')}`,
  };
}

const LEGACY_DOCK = pickLegacyDockType();

// ── (5b) A CANVAS-HIDDEN OCCUPANT'S PICKUP STILL DRAWS A GHOST ─────────────
//
// THE DEFECT THIS GUARDS, which SHIPPED and was invisible: `PickupCable`
// anchors its ghost to `.svelte-flow__node[data-id]`, and falls back to
// `[data-dock-card] [data-dock-card-frame]` for — in its own words — "a PINNED
// drawer/panel card [that] has NO canvas element at all (no stub, no handles),
// so a pickup started from its port rows / back jacks rendered no ghost".
//
// Those dock anchors were emitted ONLY by `DockFullView`'s un-migrated branch,
// so a FACED occupant's pane carried neither — and a canvas-hidden node has no
// `.svelte-flow__node` to fall back to. Both lookups missed and the ghost path
// came back as the empty string: flip the built-in clip player's pane (Tab),
// click a back jack, and NOTHING attaches to your cursor. `Canvas.cardRectFor`
// lost the same rect, which is the owner-reported "patch to is a mess in terms
// of where the menu spawns" arriving by a second route.
//
// ⚠ THE EXISTING CARRY-SEAM CASE CANNOT SEE IT, and that is why this is a
// separate test rather than one more assertion there. Its subject is a spawned
// `adsr` — a CANVAS node — so `PickupCable` resolves the FIRST selector and
// never reaches the fallback at all. The bug exists only where a node has no
// canvas element, so the subject has to be one that has none, or the new case
// simply repeats the old blind spot.
//
// `pinned-clipplayer` is that node: canvas-hidden by `isCanvasHiddenNode`, a
// shipped always-on singleton, and the very occupant the fallback's own
// comment describes.
test('a CANVAS-HIDDEN occupant renders a pickup ghost from its rear card (dock-frame anchor)', async ({
  page,
}) => {
  await gotoWorkflow(page);
  // Wait for the workflow ensure to have written the pinned clip player — the
  // NODE, not a paint, so this cannot race the seeder.
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return w.__patch?.nodes['pinned-clipplayer']?.data?.pinned === true;
    },
    undefined,
    { timeout: 15_000 },
  );

  // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED: it really has no canvas
  // element. Without this the test would still pass against a node that simply
  // resolved the ordinary canvas anchor, proving nothing about the fallback
  // this case exists to guard.
  await expect(
    page.locator('.svelte-flow__node[data-id="pinned-clipplayer"]'),
    'the pinned clip player must be CANVAS-HIDDEN — if it has a canvas node, PickupCable resolves '
      + 'that and this test says nothing about the dock-frame fallback',
  ).toHaveCount(0);

  await openFullView(page, 'pinned-clipplayer');
  // …and the pane must carry the anchor the fallback looks for.
  await expect(
    paneOf(page, 'pinned-clipplayer').locator('[data-dock-card-frame]'),
    'the dock pane must expose [data-dock-card-frame] — it is the ONLY rectangle PickupCable and '
      + 'Canvas.cardRectFor can find for an occupant with no canvas element',
  ).not.toHaveCount(0);

  await pressFlipKey(page);
  await expect(rearCard(page)).toBeVisible();

  // Pick up one of the clip player's own outputs from its back jacks.
  await rearJack(page, 'gate1', 'output').click();
  expect((await pickup(page)).mode, 'the back-jack click began a carry').toBe('pickup');

  // THE ASSERTION: the ghost renders. It can only be drawn from the pane's dock
  // frame, because there is no canvas node to hang it from.
  await page.mouse.move(640, 320);
  await page.mouse.move(660, 340);
  await expect(
    page.getByTestId('pickup-cable'),
    'a carry from a canvas-hidden occupant must still draw its ghost cable — nothing here is the '
      + '"no ghost at all" defect PickupCable\'s dock-frame fallback exists to prevent',
  ).toBeVisible();

  // …and it is a REAL path, not a mounted-but-empty <path d="">. The empty
  // string is exactly what a missed anchor produces, and an element that exists
  // with no geometry is the shape `toBeVisible` alone would wave through.
  const d = await page.getByTestId('pickup-cable').locator('path').first().getAttribute('d');
  expect(
    d?.length ?? 0,
    `the ghost path must have geometry (d=${JSON.stringify(d)}) — an empty d is the anchor lookup `
      + 'returning nothing, which paints as a mounted element with no line',
  ).toBeGreaterThan(0);

  await page.keyboard.press('Escape');
  await expect.poll(async () => (await pickup(page)).mode).toBe('idle');
});

// ── (6) A CARD THAT CONSUMED THE FLIP KEY MUST NOT ALSO FLIP (#1790) ───────
//
// The flip key is BARE TAB (#1629), claimed on `window`. A sequencer's GATE
// cell is a `<button>`, so `isTypingTarget` waves it through and the flip
// owner acted on the same keystroke the card had just used to advance a step:
// Tab moved the step AND turned the pane around. The PITCH side is an
// `<input>` and was never affected — which is exactly why this went unseen.
//
// SUBJECT: the DOCK FULL-VIEW, because that is the only place these cells
// exist on a shell rack — on the canvas a sequencer is a TILE (name + EXPAND
// pill), so there is no gate cell to focus there. With the full-view open the
// flip is DOCK-owned (section 4), so the leaked flip shows up as
// `data-fullview-flipped`, and the canvas legs below double as the
// single-owner check.
//
// BOTH LEGS ARE PERMANENT, and the second is the one that matters:
//
//   (a) HANDLED  → the card stopped it → NO flip.
//   (b) DECLINED → at the page bound the card returns false, the event
//       propagates, and THE PANE FLIPS. That is the global gesture working,
//       not a fallback — this repo does no keyboard-traversal work (owner
//       ruling), so there is nothing to "tab out" to.
//
// Without (b) this file would pass if someone simply swallowed Tab in the
// grid outright: a green gate certifying a dead gesture.
//
// SCOPE — what this test CANNOT see. It pins the SHARED seam
// (NoteEntry.onGateKeydown) through `cartesian`, whose gate cells reach it
// via the identical line every NoteEntry consumer uses. LINEAGE: the seam's
// original vehicles were `sequencer` (shared route) and `polyseqz` (a bespoke
// onBadgeKeydown copy with no shared seam) — both modules were DELETED
// 2026-08-24 (deprecated by CLIP PLAYER), and the bespoke badge route's code
// died with polyseqz, so only the shared-seam leg has a live subject. The
// standing caveat is unchanged and now sharper for it: a card that grows a
// NEW bespoke keydown route (the polyseqz shape) is invisible here.

test('#1790 cartesian GATE: the flip key advances the cell and does NOT flip — but still flips at the grid bound', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [
    { id: 'seq', type: 'cartesian', params: {}, position: { x: 460, y: 240 } },
  ]);
  const drawer = page.getByTestId('dock-fullview-drawer');
  await openFullView(page, 'seq');
  await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');

  // ⚠ THE SUBJECT MOVED TO THE FACE (#1509), AND THAT IS THE POINT OF THE TEST.
  // `cartesian` is now in STRICT_FACES, so `migrated()` makes the dock render
  // `ModuleShell` INSTEAD of `CartesianCard` — the card testids this used to
  // drive are not on this surface any more. Re-POINTED rather than relaxed: the
  // face grid (`CartesianPadGrid`) re-implements the same gate <button>, so it
  // inherits the same #1790 exposure, and the guard has to be proven where the
  // player actually is. A version of this test left on the card would have gone
  // GREEN AND BLIND — passing against a surface promotion had already removed.
  const gateAt = (i: number) => page.getByTestId(`cart-face-gate-${i}`);

  // (a) HANDLED — mid-grid. Focus a gate cell (a <button>: NOT a typing
  //     target, which is the whole defect) and press the flip key.
  await gateAt(0).focus();
  await expect(gateAt(0)).toBeFocused();

  await pressFlipKey(page);

  // The card consumed it: focus advanced one step. This assertion goes FIRST
  // because it is the one that cannot read EARLY — `data-fullview-flipped` is
  // a reactive attribute, so a leaked flip needs a DOM flush before it is
  // visible, while focus is moved synchronously inside the same dispatch.
  // Measured on the negative control (stopPropagation removed): this is the
  // line that reddens for the sequencer, because the leaked flip hides the
  // front face and the focused cell goes with it.
  await expect(
    gateAt(1),
    'the card handled the key AND the face survived it — a leaked flip takes the focused cell down with the front face',
  ).toBeFocused();
  // …and NOTHING ELSE acted on the same keystroke. Pre-fix the pane flipped
  // here, because the card called preventDefault (which a sibling `window`
  // listener never sees) and not stopPropagation. ONE press is the whole
  // assertion — a second would mask a leak by flipping back.
  await expect(drawer, 'a handled key must not reach the flip owner').toHaveAttribute(
    'data-fullview-flipped',
    'false',
  );
  await expect(rearCard(page)).toHaveCount(0);
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);

  // (b) POSITIVE CONTROL — the LAST cell of the grid. handleNav declines
  //     (no next cell), the event propagates, and the dock flip owner
  //     does its job. This leg is what stops (a) from being satisfied by
  //     breaking Tab handling altogether.
  const lastOnPage = CELL_COUNT - 1;
  await gateAt(lastOnPage).focus();
  await expect(gateAt(lastOnPage)).toBeFocused();

  await pressFlipKey(page);

  await expect(drawer, 'at the grid bound the flip gesture must still fire').toHaveAttribute(
    'data-fullview-flipped',
    'true',
  );
  await expect(rearCard(page)).toBeVisible();
  // Single-owner intact throughout: the canvas never moved.
  await expect(canvasFlow(page)).not.toHaveClass(/rear-view/);
  await expect(flipRackBtn(page)).toHaveAttribute('aria-pressed', 'false');
});
