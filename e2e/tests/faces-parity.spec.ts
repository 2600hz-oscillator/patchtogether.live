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
type CellControl = 'knob' | 'momentary' | 'toggle' | 'selector' | 'action' | 'file' | 'inert';

interface RenderedCell {
  control: CellControl;
  kind: string;
  key: string;
}

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow&shell=1');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
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

      for (const cell of cells) {
        await driveCell(page, dockShell, 'm', spec, cell);
      }
    });
  }
});

test.describe('tidyVco tune-cluster regression (the owner control-loss report)', () => {
  test('the tune cluster (detune + oct2) renders in the LANE full face AND the dock oscillator band', async ({ page }) => {
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

test.describe('dx7 hero controls are REACHABLE in the shell (the inert-cell P0)', () => {
  // The headline finding: dx7's PRESET selector — the one control that swaps
  // the whole sound — and its .syx cartridge import rendered as dashed text
  // under `?shell=1`, so the DX7's voice could not be changed. This pins the
  // fix at the level the user experiences it: pick a voice, the graph loads it.
  test('the dock PRESET cell actually loads a different voice into node.data', async ({ page }) => {
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
