// e2e/tests/faces-parity.spec.ts
//
// FACES RENDER-PARITY — the authoritative DOM gate for the workflow-mode
// UI-curation system: A REDESIGN MUST NEVER LOSE A CONTROL, and EVERY
// RENDERED CELL MUST BE A REAL, OPERABLE CONTROL.
//
// Born from the tidyVco tune/fine loss (the face ranked `detune`/`oct2` below
// the lane fit-plan's whole-cell cap, so the redesigned face surfaced ZERO
// tuning controls in-lane and the schema-level face-lint gate never noticed —
// schema coverage ≠ rendered coverage), then WIDENED by the P1 batch-2
// adversarial render verify, which found the complementary hole: the shell
// rendered every family/static cell as a DASHED LABEL and every param as a
// rotary, so
//   * dx7's PRESET selector (its hero, `face.order[0]`) and its .syx import
//     were DEAD TEXT — the DX7's voice could not be changed at all, and
//   * tomtom's MOMENTARY strike pad rendered as a LATCHING knob that masked
//     the TRIG jack and persisted a stuck value into the Y.Doc,
// while this spec only ever counted family cells and drove ONE spec-chosen
// param. Presence is not function, and a per-module operability probe cannot
// see a per-cell failure.
//
// REGISTRY-DRIVEN: enumerates STRICT_FACES (imported straight from the web
// source — the same set the lint gate and the migration bridge read), so
// every FUTURE promoted face auto-enrolls in this sweep with zero test
// edits. For each migrated module, the dock full-view (`?shell=1` →
// EXPAND) must satisfy:
//
//   1. EXACTLY one interactive control per def PARAM id — matched by the
//      card-kit's `control-<paramId>` testid binding, asserted as full
//      id-multiset equality against the LIVE def (window.__moduleSpecs):
//      a dropped control fails, a duplicated control fails, and an extra
//      control with no def backing fails.
//   2. one family cell per DECLARED control family, ZERO dead 'static'
//      cells, and ZERO cells marked `data-cell-inert` — the shell's loud
//      marker for a family/static key with no registered cell spec.
//   3. PER-CELL OPERABILITY: every rendered cell — param, family AND static
//      — is driven by its OWN natural interaction and asserted to have an
//      observable effect:
//        knob      → pointer-drag commits a new param value into the graph
//        momentary → press writes the pad HIGH, release returns it to REST
//                    (no latch, nothing stuck persisted)
//        toggle    → click flips the switch's aria-checked state
//        selector  → choosing another option changes the displayed value
//        action    → the button fires (a real enabled <button>, pressed)
//        file      → a real <input type=file> that ACCEPTS a file and runs
//                    its import action (asserted via the cell's status line)
//      An inert cell has no natural interaction, so it fails by construction.
//
// The browser-free pre-gates are module-face-lint's dockFacePlan parity +
// momentary/compact-cap tests and shell-cells' coverage test; the deliberate
// in-lane top-N curation is covered by workflow-shell-faces. Runs on
// /rack?mode=workflow (no DB/relay) — the normal e2e lane.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { STRICT_FACES } from '../../packages/web/src/lib/ui/workflow/strict-faces';

// CI (and a local E2E_SWIFTSHADER=1 flake-check) rasterizes on the SwiftShader
// SOFTWARE renderer with 4 workers on a 4-vCPU runner. Mirrors the SLOW_RENDER
// idiom in workflow-shell-video / workflow-lane-add-safety / videovarispeed-
// switch / workflow-master-transport.
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

// ── THE BUDGET IS PER-FACE AND SCALES WITH THAT FACE'S CELL COUNT ──
//
// This sweep's cost is DOMINATED by the per-cell operability loop: every cell
// costs a `scrollIntoViewIfNeeded` + a `boundingBox` + ~11 CDP input dispatches
// (`mouse.move`/`down`/`move{steps:8}`/`up`) + a graph poll — ~14 protocol
// round-trips EACH, against a live SvelteFlow rack whose video zone is being
// software-rasterized the whole time. So a face's wall-clock is essentially
// `fixed boot/spawn/dock + k × cells`, and the flat 30s default was a budget
// for the SMALLEST face applied to the LARGEST one.
//
// Measured (this worktree, warm dev server, 1 worker):
//   real GPU     ≈ 1.2s + 0.12s/cell   (cloudseed's 46 cells → 6.7s)
//   SwiftShader  ≈ 2.0s + 0.19s/cell   (cloudseed → 10.8s)
// CI run 30190844866 (shard 3/10) failed EXACTLY the four biggest faces —
// cloudseed (46 cells), kickdrum (25), tidyVco (25), snaredrum (22) — on both
// attempts, always mid-`dragKnob` and always still PROGRESSING, never on a
// failed assertion; sixstrum (19) was the largest to squeak through. That
// cutoff pins CI at roughly `10s + 0.8s/cell`, i.e. ~4× the local software-
// renderer per-cell cost.
//
// The FIXED term is sized off the COLD boot, not the warm one: on a freshly
// started dev server (vite cache cleared) under SwiftShader the 4-cell `adsr`
// row — the alphabetically first, so the one that pays SvelteKit's on-demand
// /rack compile — measured 13.2s all-in vs 3.2s warm.
//
// So the ceiling is DERIVED from the cells the face actually rendered rather
// than bumped by a flat constant: batch 3 adds five more faces (and any face
// can grow params) without re-breaking this, and a face that shrinks gives its
// budget back. Costs NOTHING on the green path — a raised ceiling is only ever
// spent by a test that was going to fail anyway.
//
// Repo rule (ci-swiftshader-video-e2e-timeouts / CLAUDE.md): scale by the work,
// never flat; grow failure bounds only — no assertion or window below moves.
const FACE_FIXED_MS = SLOW_RENDER ? 45_000 : 30_000;
const FACE_PER_CELL_MS = SLOW_RENDER ? 1_800 : 600;

interface SpecParam {
  id: string;
  curve: string;
  defaultValue: number;
  min: number;
  max: number;
}
interface SpecShape {
  type: string;
  params: SpecParam[];
  controlFamilies?: string[];
  strictFace?: boolean;
}

/** The shell's per-cell interaction contract (`data-cell-control`). */
type CellControl =
  | 'knob'
  | 'momentary'
  | 'toggle'
  | 'segmented'
  | 'selector'
  | 'action'
  | 'file'
  | 'inert';

interface RenderedCell {
  control: CellControl;
  kind: string;
  key: string;
}

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow&shell=1');
  // 15 s (not the 5 s default): this is the BOOT wait, and the FIRST test of a
  // run pays SvelteKit's on-demand /rack route compilation before the workflow
  // chrome mounts — which overran 5 s on a cold dev server and failed only the
  // alphabetically-first module. The sibling workflow specs (camera-input,
  // dock-pane-close-chrome, workflow-dock-occupancy) already carry this exact
  // bound; it still fails hard if the topbar genuinely never mounts. Doubled
  // under SLOW_RENDER: on CI that cold compile lands on a 4-vCPU runner already
  // running three other workers' software-rasterized racks.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function readSpec(page: Page, type: string): Promise<SpecShape> {
  const spec = await page.evaluate((t) => {
    const w = globalThis as unknown as { __moduleSpecs?: SpecShape[] };
    return w.__moduleSpecs?.find((s) => s.type === t) ?? null;
  }, type);
  expect(spec, `${type}: registered in the live registry (__moduleSpecs)`).toBeTruthy();
  return spec!;
}

/** Open the module's dock full-view and return the dock-tier shell locator. */
async function openDock(page: Page, nodeId: string) {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/** Read the live graph value of one param (null when unset). */
function readParam(page: Page, nodeId: string, pid: string): Promise<number | null> {
  return page.evaluate(
    ({ nodeId, pid }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch.nodes[nodeId]?.params?.[pid] ?? null;
    },
    { nodeId, pid },
  );
}

/** Every cell the dock faceplate rendered, in DOM order. */
async function renderedCells(dockShell: Locator): Promise<RenderedCell[]> {
  return dockShell.locator('[data-cell-kind]').evaluateAll((els) =>
    els.map((el) => ({
      control: (el.getAttribute('data-cell-control') ?? 'inert') as CellControl,
      kind: el.getAttribute('data-cell-kind') ?? '',
      key: el.getAttribute('data-cell-key') ?? '',
    })),
  );
}

/**
 * Drag a knob cell vertically — the KnobConic gesture, sized so EVERY param
 * shape actually moves. The dial maps 200 px to the full arc and a `discrete`
 * curve SNAPS to the nearest step, so the old fixed 48 px nudge could never
 * move a coarse switch-like param (`hard` 0..1, `oct2` -1..1, `strumDir`
 * 0..2 all round straight back). Travel is therefore derived from the param's
 * own step count, and the direction runs AWAY from whichever end the value
 * currently sits at (a param resting at its max, e.g. dx7 `voiceCount`, cannot
 * go up) while staying inside the viewport.
 *
 * That direction rule is load-bearing, not a nicety: a FIXED upward drag is a
 * guaranteed FALSE FAILURE on any param already at its ceiling — nothing moves,
 * nothing commits, and a perfectly operable control reads as LOST. Batch 3's
 * MIXER is the sharpest case (it ships all four channel levels AND the master
 * at max — a summing mixer is a unity pass-through out of the box), and the
 * same bite recurs on every attenuator-shaped module.
 */
async function dragKnob(page: Page, knob: Locator, p: SpecParam, current: number): Promise<void> {
  await knob.scrollIntoViewIfNeeded();
  const box = (await knob.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Travel (px): a discrete param must cross its rounding midpoint (1 step =
  // 200/steps px, so 0.6 of a step + slack always lands on a new integer); a
  // continuous one moves with any real gesture.
  const steps = p.curve === 'discrete' ? Math.max(1, Math.round(p.max - p.min)) : 0;
  const travel = steps ? Math.min(190, (200 * 0.6) / steps + 30) : 60;

  // Which way: 'up' raises the value. Start from the end the value is NOT at.
  const frac = (current - p.min) / (p.max - p.min || 1);
  let up = frac <= 0.5;
  const vh = page.viewportSize()?.height ?? 720;
  if (up && cy - travel < 8) up = false;
  else if (!up && cy + travel > vh - 8) up = true;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, up ? cy - travel : cy + travel, { steps: 8 });
  await page.mouse.up();
}

/**
 * Drive ONE rendered cell and assert an observable effect. Returns a short
 * description of what it proved, so a failure names the exact cell.
 */
async function driveCell(
  page: Page,
  dockShell: Locator,
  nodeId: string,
  spec: SpecShape,
  cell: RenderedCell,
): Promise<void> {
  const where = `${spec.type} cell '${cell.key}' (${cell.kind}/${cell.control})`;

  // An INERT cell is the failure this gate exists for — a curated control
  // rendered as dead text, with no interaction to perform at all.
  expect(cell.control, `${where}: rendered INERT (a dead label, not a control)`).not.toBe('inert');

  const host = dockShell.locator(`[data-cell-key="${cell.key}"]`);
  await expect(host, `${where}: renders`).toBeVisible();

  if (cell.control === 'knob') {
    const pid = cell.key;
    const p = spec.params.find((q) => q.id === pid);
    expect(p, `${where}: backed by a real ParamDef`).toBeTruthy();
    const before = await readParam(page, nodeId, pid);
    await dragKnob(page, host.locator(`[data-testid="control-${pid}"]`), p!, before ?? p!.defaultValue);
    await expect
      .poll(() => readParam(page, nodeId, pid), {
        message: `${where}: dragging the knob commits a param change into the graph`,
      })
      .not.toBe(before);
    return;
  }

  if (cell.control === 'momentary') {
    // A press-pad must go HIGH while held and RETURN TO REST on release —
    // never latch, and never leave a stuck value behind in the Y.Doc.
    const pid = cell.key;
    const rest = spec.params.find((p) => p.id === pid)?.defaultValue ?? 0;
    const pad = host.locator(`[data-testid="control-${pid}"]`);
    await pad.scrollIntoViewIfNeeded();
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect
      .poll(() => readParam(page, nodeId, pid), { message: `${where}: press drives the pad HIGH` })
      .toBeGreaterThanOrEqual(0.5);
    await expect(pad, `${where}: reports its held state`).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.up();
    await expect
      .poll(() => readParam(page, nodeId, pid) ?? rest, {
        message: `${where}: release RETURNS TO REST — a momentary pad must not latch`,
      })
      .toBe(rest);
    await expect(pad, `${where}: not left pressed`).toHaveAttribute('aria-pressed', 'false');
    return;
  }

  if (cell.control === 'toggle') {
    const sw = host.locator('[role="switch"]');
    const before = await sw.getAttribute('aria-checked');
    await sw.click();
    await expect(sw, `${where}: clicking flips the switch`).not.toHaveAttribute(
      'aria-checked',
      before ?? '',
    );
    return;
  }

  if (cell.control === 'segmented') {
    // A NAMED-STATE row (PF-1 `ParamDef.options`). Operating it means picking
    // a DIFFERENT state and seeing that state land in the graph — the same bar
    // the knob branch meets, not merely "a button was clickable".
    const pid = cell.key;
    const group = host.locator(`[data-testid="control-${pid}"]`);
    await expect(group, `${where}: a real radiogroup`).toHaveAttribute('role', 'radiogroup');
    const segs = group.locator('[role="radio"]');
    const n = await segs.count();
    expect(n, `${where}: the row offers more than one state`).toBeGreaterThan(1);

    // Pick a segment that is NOT the active one. `aria-checked` is authored
    // off the nearest-segment snap, so this works for an off-detent value too.
    let target = -1;
    for (let i = 0; i < n; i++) {
      if ((await segs.nth(i).getAttribute('aria-checked')) !== 'true') { target = i; break; }
    }
    expect(target, `${where}: some state other than the current one is offered`).toBeGreaterThanOrEqual(0);

    const before = await readParam(page, nodeId, pid);
    await segs.nth(target).scrollIntoViewIfNeeded();
    await segs.nth(target).click();
    await expect
      .poll(() => readParam(page, nodeId, pid), {
        message: `${where}: choosing a state commits it into the graph`,
      })
      .not.toBe(before);
    await expect(segs.nth(target), `${where}: the chosen state lights up`).toHaveAttribute(
      'aria-checked',
      'true',
    );
    return;
  }

  if (cell.control === 'selector') {
    // Open the roster and choose a DIFFERENT option; the chip's displayed
    // value must follow (proving the selection was actually committed).
    const chip = host.locator('[role="button"][aria-haspopup="listbox"]');
    const shown = (await chip.locator('.val').innerText()).trim();
    await chip.click();
    const options = page.locator('[role="listbox"] [role="option"]');
    const n = await options.count();
    expect(n, `${where}: the roster offers options`).toBeGreaterThan(1);
    let picked = -1;
    for (let i = 0; i < n; i++) {
      if ((await options.nth(i).innerText()).trim() !== shown) { picked = i; break; }
    }
    expect(picked, `${where}: the roster offers an option other than the current one`).toBeGreaterThanOrEqual(0);
    const want = (await options.nth(picked).innerText()).trim();
    await options.nth(picked).click();
    await expect(chip.locator('.val'), `${where}: choosing another option changes the selection`).toHaveText(want);
    return;
  }

  if (cell.control === 'action') {
    const btn = host.locator('button');
    await expect(btn, `${where}: a real enabled button`).toBeEnabled();
    await btn.click();
    return;
  }

  if (cell.control === 'file') {
    // A real <input type="file"> wired to a real import action: feed it a
    // file and assert the cell REPORTS a result (status or error). Either
    // way the action RAN — which is what "not inert" means here. (The
    // content-level import behaviour is covered by dx7-syx-load.spec.ts.)
    const input = host.locator('input[type="file"]');
    await expect(input, `${where}: a real file input`).toBeAttached();
    await expect(input, `${where}: declares an accept filter`).not.toHaveAttribute('accept', '');
    await input.setInputFiles({
      name: 'probe.syx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(64, 0),
    });
    await expect(
      host.locator('[data-testid$="-status"]'),
      `${where}: the import action ran and reported back`,
    ).toBeVisible();
    return;
  }

  throw new Error(`${where}: unknown cell control kind — teach this gate how to drive it`);
}

test.describe('faces render-parity: every STRICT_FACES dock full-view carries the def’s FULL control surface', () => {
  for (const type of [...STRICT_FACES].sort()) {
    test(`${type}: dock control set === def param set (+families, no extras) and EVERY cell operates`, async ({ page }) => {
      // Stage 1 of the derived budget (see FACE_FIXED_MS): covers boot + spawn
      // + dock open + the parity reads, i.e. everything before the cell count
      // is even knowable.
      test.setTimeout(FACE_FIXED_MS);
      await gotoShell(page);
      await spawnPatch(page, [{ id: 'm', type, position: { x: 460, y: 240 } }]);

      const spec = await readSpec(page, type);
      // The imported STRICT_FACES set and the live registry agree this module
      // is migrated (guards a stale import path / set drift).
      expect(spec.strictFace, `${type}: __moduleSpecs agrees it is STRICT_FACES-migrated`).toBe(true);

      const dockShell = await openDock(page, 'm');

      // ── 1. PARAM PARITY: exact id-multiset equality, DOM vs live def. ──
      const domIds = await dockShell
        .locator('[data-testid^="control-"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.slice('control-'.length)));
      const defIds = spec.params.map((p) => p.id);
      expect(
        [...domIds].sort(),
        `${type}: dock full-view renders EXACTLY one interactive control per def param ` +
          `(missing = a lost control, duplicate/unknown = an unbacked extra)`,
      ).toEqual([...defIds].sort());

      // ── 2. FAMILY CELLS, no dead statics, and NO INERT CELLS. ──
      await expect(
        dockShell.locator('[data-cell-kind="family"]'),
        `${type}: one rendered cell per declared control family`,
      ).toHaveCount(spec.controlFamilies?.length ?? 0);
      await expect(
        dockShell.locator('[data-cell-kind="static"]'),
        `${type}: no dead static cells — every rendered control is def-backed`,
      ).toHaveCount(0);
      const inert = await dockShell.locator('[data-cell-inert]').evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-cell-key') ?? '?'),
      );
      expect(
        inert,
        `${type}: INERT cell(s) — a curated control rendered as a dead label. Register a ` +
          `shell-cell spec (packages/web/src/lib/ui/workflow/shell-cells.ts).`,
      ).toEqual([]);

      // ── 3. PER-CELL OPERABILITY: drive every cell, not one sampled knob. ──
      const cells = await renderedCells(dockShell);
      expect(
        cells.length,
        `${type}: the dock renders one cell per curated control ` +
          `(params ${defIds.length} + families ${spec.controlFamilies?.length ?? 0})`,
      ).toBe(defIds.length + (spec.controlFamilies?.length ?? 0));
      const keys = cells.map((c) => c.key);
      expect(new Set(keys).size, `${type}: every rendered cell carries a UNIQUE data-cell-key`).toBe(keys.length);

      // Stage 2: now that the face's REAL size is known, extend the ceiling by
      // its own cell count (Playwright counts a re-`setTimeout` from the test's
      // start, so this SUPERSEDES stage 1 rather than stacking on it). The
      // per-cell loop below is the whole cost — a 46-cell reverb gets ~7× the
      // driving budget of a 2-cell VCA because it does ~7× the driving.
      test.setTimeout(FACE_FIXED_MS + FACE_PER_CELL_MS * cells.length);

      for (const cell of cells) {
        await driveCell(page, dockShell, 'm', spec, cell);
      }
    });
  }
});

test.describe('tidyVco tune-cluster regression (the owner control-loss report)', () => {
  test('the tune cluster (detune + oct2) renders in the LANE full face AND the dock oscillator band', async ({ page }) => {
    // Same boot + spawn + dock-open fixed cost as a face row (it drives no
    // cells, so it needs no per-cell term).
    test.setTimeout(FACE_FIXED_MS);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);

    const shell = page.locator('.svelte-flow__node[data-id="tv"] [data-testid="module-shell"]');
    await expect(shell).toBeVisible();
    // The spawn reveal parks the zoom at 0.6 — the LOD 'full' band: the
    // richest IN-LANE face. The redesign must keep the tuning controls
    // visible here (the loss: detune ranked below the 6-cell plate cap and
    // oct2 outside the top-8 left the lane with ZERO tuning controls).
    await expect(shell).toHaveAttribute('data-shell-tier', 'full');
    await expect(shell.locator('[data-testid="control-detune"]'), 'lane full face: FINE (detune ¢)').toBeVisible();
    await expect(shell.locator('[data-testid="control-oct2"]'), 'lane full face: TUNE (oct2)').toBeVisible();

    // And the dock full-view keeps them in the OSCILLATOR section band (the
    // gallery-mock tune cluster placement).
    const dockShell = await openDock(page, 'tv');
    const oscBand = dockShell.locator('[data-face-page="oscillator"]');
    await expect(oscBand.locator('[data-testid="control-detune"]'), 'dock oscillator band: detune').toBeVisible();
    await expect(oscBand.locator('[data-testid="control-oct2"]'), 'dock oscillator band: oct2').toBeVisible();
  });
});

test.describe('param vocabulary: a NAMED discrete param reads as its name at BOTH tiers', () => {
  // PF-1's two halves are different primitives answering the SAME question, so
  // the only assertion worth making spans both: the dock lays the states out
  // as a row, the lane keeps the dial (a 46 px knob column cannot hold a row)
  // and earns a persistent readout instead — and they must NAME THE SAME
  // STATE. A per-tier test would pass while the two disagreed, which is the
  // failure a player actually notices when they zoom out.
  //
  // filter.mode is the case: three parallel two-pole sections, `curve:
  // 'discrete'`, and the one control that decides whether CUTOFF sounds dark,
  // thin or narrow. Pre-PF-1 it rendered as a rotary printing "0.00".
  test('filter.mode: Segmented in the dock, dial + persistent readout in the lane, same state', async ({ page }) => {
    test.setTimeout(FACE_FIXED_MS);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'f', type: 'filter', position: { x: 460, y: 240 } }]);

    // ── LANE (the spawn reveal parks zoom at 0.6 = LOD 'full', the richest
    //    in-lane face; filter's 5 ranked controls all fit the 6-cell plate). ──
    const shell = page.locator('.svelte-flow__node[data-id="f"] [data-testid="module-shell"]');
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-shell-tier', 'full');
    const laneCell = shell.locator('[data-cell-key="mode"]');
    await expect(laneCell, 'lane: mode keeps the DIAL — a lane column has no room for a row')
      .toHaveAttribute('data-cell-control', 'knob');
    const laneReadout = laneCell.locator('[data-testid="readout-mode"]');
    await expect(laneReadout, 'lane: the dial earns a PERSISTENT readout naming the state').toBeVisible();
    await expect(laneReadout).toHaveText('LP');

    // ── DOCK: the same param, laid out as its three named states. ──
    const dockShell = await openDock(page, 'f');
    const dockCell = dockShell.locator('[data-cell-key="mode"]');
    await expect(dockCell, 'dock: mode becomes a named-state ROW').toHaveAttribute(
      'data-cell-control',
      'segmented',
    );
    const segs = dockCell.locator('[data-testid="control-mode"] [role="radio"]');
    await expect(segs, 'dock: one button per declared option').toHaveCount(3);
    await expect(segs, 'dock: the states are NAMED, not numbered').toHaveText(['LP', 'HP', 'BP']);
    await expect(segs.nth(0), 'dock: the default state is lit').toHaveAttribute('aria-checked', 'true');

    // ── AGREEMENT: pick BP in the dock; the lane dial must say BP too. ──
    await segs.nth(2).click();
    await expect
      .poll(() => readParam(page, 'f', 'mode'), { message: 'picking BP commits mode=2' })
      .toBe(2);
    await expect(segs.nth(2), 'dock: BP is now the lit state').toHaveAttribute('aria-checked', 'true');
    await expect(laneReadout, 'lane: the dial readout follows the dock selection').toHaveText('BP');
  });
});

test.describe('dx7 hero controls are REACHABLE in the shell (the inert-cell P0)', () => {
  // The headline finding: dx7's PRESET selector — the one control that swaps
  // the whole sound — and its .syx cartridge import rendered as dashed text
  // under `?shell=1`, so the DX7's voice could not be changed. This pins the
  // fix at the level the user experiences it: pick a voice, the graph loads it.
  test('the dock PRESET cell actually loads a different voice into node.data', async ({ page }) => {
    // Same boot + spawn + dock-open fixed cost as a face row; the one selector
    // it drives is well inside the fixed term.
    test.setTimeout(FACE_FIXED_MS);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'dx', type: 'dx7', position: { x: 460, y: 240 } }]);
    const dockShell = await openDock(page, 'dx');

    const preset = dockShell.locator('[data-cell-key="dx7-preset-select-{n}"]');
    await expect(preset, 'the preset cell renders').toBeVisible();
    await expect(preset, 'and is NOT the old dead label').toHaveAttribute('data-cell-control', 'selector');

    const before = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> } };
      return (w.__patch.nodes['dx']?.data?.preset as string | undefined) ?? null;
    });

    await preset.locator('[role="button"][aria-haspopup="listbox"]').click();
    const options = page.locator('[role="listbox"] [role="option"]');
    await expect(options.first()).toBeVisible();
    // Pick the LAST built-in so the choice is unambiguous vs the default.
    const want = (await options.last().innerText()).trim();
    await options.last().click();

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> } };
            return (w.__patch.nodes['dx']?.data?.preset as string | undefined) ?? null;
          }),
        { message: 'choosing a voice writes node.data.preset (the factory polls it)' },
      )
      .toBe(want);
    expect(want, 'and it is a DIFFERENT voice than before').not.toBe(before);
  });
});

test.describe('sixstrum PRESET is a RECALL, not a relabelled tuning switch', () => {
  // The sibling gap to dx7's: the batch-2 face carried the raw `tuning` param
  // (which only swaps the open-string set) but NOT the guitar/bass/harp PRESET
  // RECALL that the classic card's MODE knob fires — so the three calibrated
  // knob states were unreachable under `?shell=1`. The param survived the
  // redesign; the affordance did not.
  //
  // The generic per-cell sweep above already proves the cell is a real,
  // operable Selector. What it CANNOT tell apart is a recall from a renamed
  // tuning knob — both move `tuning`. So this pins the thing that makes it a
  // preset: picking BASS moves `tuning` AND the OTHER stamped params with it.
  // Then it twists one of them back, because a preset is a starting point, not
  // a lock (the classic card keeps every knob editable after a recall).
  test('picking BASS stamps the whole calibrated knob state, and the knobs stay editable', async ({ page }) => {
    test.setTimeout(FACE_FIXED_MS);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'ss', type: 'sixstrum', position: { x: 460, y: 240 } }]);
    const dockShell = await openDock(page, 'ss');

    const preset = dockShell.locator('[data-cell-key="sixstrum-preset-{n}"]');
    await expect(preset, 'the preset cell renders').toBeVisible();
    await expect(preset, 'and is a real Selector, not a dead label').toHaveAttribute(
      'data-cell-control',
      'selector',
    );

    // GUITAR is the default knob state (tuning 0 / register 0).
    const chip = preset.locator('[role="button"][aria-haspopup="listbox"]');
    await expect(chip.locator('.val'), 'starts on the default mode').toHaveText('guitar');

    await chip.click();
    const bass = page.locator('[role="listbox"] [role="option"]', { hasText: 'bass' });
    await expect(bass, 'the roster offers BASS').toBeVisible();
    await bass.click();
    await expect(chip.locator('.val'), 'the chip follows the recall').toHaveText('bass');

    // 1. the tuning it names…
    await expect
      .poll(() => readParam(page, 'ss', 'tuning'), {
        message: 'BASS recalls the bass string set (tuning → 1)',
      })
      .toBe(1);
    // 2. …AND the rest of the calibrated state. `register` is the sharpest
    //    witness (0 → −12: the bass sits an octave down), and `ring` proves it
    //    is the whole preset rather than a two-value special case.
    await expect
      .poll(() => readParam(page, 'ss', 'register'), {
        message: 'a RECALL, not a tuning switch: register moves with it (→ −12 st)',
      })
      .toBe(-12);
    await expect
      .poll(() => readParam(page, 'ss', 'ring'), {
        message: 'and the string ring too (→ 6 s, the bass long/dark decay)',
      })
      .toBe(6);

    // RECALL-THEN-EDIT: nothing is locked by the stamp. Twist RING and confirm
    // the edit commits over the recalled value.
    const spec = await readSpec(page, 'sixstrum');
    const ringDef = spec.params.find((p) => p.id === 'ring')!;
    const ringCell = dockShell.locator('[data-cell-key="ring"] [data-testid="control-ring"]');
    await dragKnob(page, ringCell, ringDef, 6);
    await expect
      .poll(() => readParam(page, 'ss', 'ring'), {
        message: 'a preset is a STARTING POINT: a knob still commits after the recall',
      })
      .not.toBe(6);
  });
});
