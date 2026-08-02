// e2e/tests/faceplate-platform.spec.ts
//
// PF-20 — the DOM gate for the dock faceplate PLATFORM: the value readouts, the
// page header, the band hints, the hero slot and the sidebar.
//
// WHY AN E2E AND NOT ONLY UNITS. The pure model
// (dock-faceplate-model.test.ts) proves the ARITHMETIC — the hero split is
// total, a preset's writes are in range, an empty block is dropped. It is
// structurally blind to whether any of it reaches the screen: a `{#if}` that
// never fires, a CSS rule that hides the column, a prop that is never threaded
// through. Those are exactly the failures this platform is meant to end, so
// they get a DOM assertion.
//
// TWO SCOPES, deliberately:
//
//   * the STRUCTURE tests below run against kickdrum — the platform's first
//     adopter and the face the owner put next to its mock — because a mock has
//     a subject and asserting its actual content is the point;
//   * the SIDEBAR RENDER sweep at the bottom is REGISTRY-DRIVEN over every
//     module that declares `face.sidebar`, because the sidebar mounts OUTSIDE
//     `[data-testid="module-shell"]` and is therefore invisible to
//     faces-parity's per-cell operability sweep. Without a registry-driven
//     gate here, adopter #2 could ship a sidebar that renders blank and nothing
//     in the suite would notice — which is precisely the failure class this
//     platform exists to end, reintroduced one layer up.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { setNodeParams } from './_module-coverage-helpers';

const TYPE = 'kickdrum';

interface SidebarSpec {
  type: string;
  strictFace?: boolean;
  faceSidebar?: { kind: string; label: string }[];
}

/** Set the viewport ZOOM and wait for the LOD tier to settle on `nodeId` — the
 *  same walk `workflow-shell-faces.spec.ts` uses to cross tier boundaries. */
async function setZoomTier(page: Page, nodeId: string, zoom: number, tier: string): Promise<void> {
  await page.evaluate((z) => {
    const f = (
      globalThis as unknown as {
        __flow: {
          getViewport: () => { x: number; y: number; zoom: number };
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      }
    ).__flow;
    const vp = f.getViewport();
    f.setViewport({ x: vp.x, y: vp.y, zoom: z }, { duration: 0 });
  }, zoom);
  await page.waitForFunction(
    ({ nodeId, tier }) => {
      const el = document.querySelector(
        `.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`,
      );
      return !!el && el.getAttribute('data-shell-tier') === tier;
    },
    { nodeId, tier },
    { timeout: 10_000 },
  );
}

/** Boot workflow mode with the migrated shell. Same 15 s boot bound the other
 *  workflow specs carry — the FIRST test of a run pays SvelteKit's on-demand
 *  /rack route compile before the chrome mounts. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow&shell=1');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open the dock full-view for node `id` and return the faceplate root. */
async function openFaceplate(page: Page, id: string) {
  const tile = page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`);
  await expect(tile).toBeVisible();
  await tile.getByTestId('shell-open-dock').click();
  const fp = page.getByTestId('dock-full-view');
  await expect(fp).toBeVisible();
  await expect(fp.locator('[data-testid="module-shell"][data-shell-tier="dock"]')).toBeVisible();
  return fp;
}

/** The live value of a param on node `id`, straight out of the patch store —
 *  the durable truth the UI claims to be showing. `undefined` when untouched
 *  (node.params is a SPARSE overlay, which is the trap the width test below
 *  exists for). */
async function paramValue(page: Page, id: string, paramId: string): Promise<number | undefined> {
  return page.evaluate(
    ({ id, paramId }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch.nodes[id]?.params?.[paramId];
    },
    { id, paramId },
  );
}

/** Every registered module that DECLARES a dock sidebar — read from the live
 *  registry projection, never from a list in this file. */
async function sidebarAdopters(page: Page): Promise<SidebarSpec[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __moduleSpecs?: SidebarSpec[] };
    return (w.__moduleSpecs ?? []).filter((s) => (s.faceSidebar?.length ?? 0) > 0);
  });
}

test.describe('PF-20 dock faceplate platform (kickdrum)', () => {
  test('the faceplate is a designed panel: header, hero picture, big readouts, hints, sidebar rail', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'k', type: TYPE, position: { x: 460, y: 240 } }]);
    const fp = await openFaceplate(page, 'k');
    const shell = fp.locator('[data-testid="module-shell"]');

    // ── 1. THE PAGE HEADER — a title and a sentence, not a bare knob grid. ──
    const head = shell.getByTestId('face-head');
    await expect(head, 'the faceplate declares a page header').toBeVisible();
    await expect(head).toContainText('Voice');
    await expect(head, 'the hint says what the instrument IS').toContainText(
      /three decoupled generators/i,
    );

    // ── 2. A VALUE UNDER EVERY KNOB (the largest single share of the drift). ──
    //
    // Registry-driven: count the KNOB cells the dock rendered and require the
    // same number of readouts. A hardcoded list would go stale the moment the
    // face is re-ranked, and — worse — would still pass if the readout stopped
    // rendering for a param nobody listed.
    const knobCells = shell.locator('[data-cell-control="knob"]');
    const knobCount = await knobCells.count();
    expect(knobCount, 'the dock renders kickdrum’s dials').toBeGreaterThan(15);
    const readouts = shell.locator('[data-cell-control="knob"] [data-testid^="readout-"]');
    await expect(
      readouts,
      'EVERY dock dial prints its value — bare labels were the mock’s biggest complaint',
    ).toHaveCount(knobCount);
    // …and in the MOCK'S OWN UNITS, through the def's declared `format`, not
    // the generic ladder. `450 ms` not `450.00 ms`; `2.8 kHz` not `2.80k Hz`;
    // `+3.0 dB` not `3.00 dB` (an EQ move always carries its sign).
    await expect(shell.getByTestId('readout-sub_decay')).toHaveText('450 ms');
    await expect(shell.getByTestId('readout-tune')).toHaveText('50 Hz');
    await expect(shell.getByTestId('readout-click_tone')).toHaveText('2.8 kHz');
    await expect(shell.getByTestId('readout-body_eq')).toHaveText('+3.0 dB');
    // A PF-10 landmark NAME wins over the numeric ladder. SHAPE's default is
    // 0.3, whose nearest landmark is TRI (0.5) — not SINE (0.0). Pinning the
    // NEAREST name rather than the first one is the whole point of landmarks
    // over `options`: the knob's useful travel is the blend between them.
    await expect(shell.getByTestId('readout-body_shape'), 'a landmark NAME wins').toHaveText('TRI');

    // ── 3. THE HERO — the picture, the promoted dial, and DERIVED readouts. ──
    const hero = shell.getByTestId('face-hero');
    await expect(hero).toBeVisible();
    await expect(
      hero.getByTestId('kickdrum-hero'),
      'the module’s own picture is promoted INTO the hero, where the mock puts it',
    ).toBeVisible();
    await expect(
      shell.locator('[data-testid="control-tune"]'),
      'TUNE was PROMOTED into the hero, not COPIED — a second cell would fail faces-parity',
    ).toHaveCount(1);
    await expect(
      hero.locator('[data-testid="control-tune"]'),
      'and the one cell is the hero’s',
    ).toBeVisible();
    await expect(
      hero.getByTestId('shell-cell-kickdrum-strike'),
      'the audition rides beside it — this voice is silent until something strikes it',
    ).toBeVisible();

    // ⚠ THE TAIL IS 398 ms, NOT 450. 450 is the SUB DEC knob. The voice's real
    // −60 dB tail is the sum of three layers at their own mix levels, and a
    // readout that printed the knob would be invariant to SUB LEVEL — the
    // blind-metric trap this readout's `valueId` source exists to avoid. This
    // assertion is what makes the difference visible from the DOM.
    const heroReadouts = shell.getByTestId('face-hero-readouts');
    await expect(heroReadouts.locator('[data-hero-readout="kickdrum-tail"]')).toHaveText(
      /tail\s*398 ms/i,
    );
    await expect(heroReadouts).toContainText('+24 st');
    await expect(heroReadouts).toContainText('50 Hz');

    // …and the hero VALUE is typeset as a hero value, not at the 9 px lane
    // size. "A big dial with a big readout" was the claim; this measures it.
    const heroValueFs = await hero
      .getByTestId('readout-tune')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const bandValueFs = await shell
      .locator('[data-face-page="sub"]')
      .getByTestId('readout-sub_decay')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(
      heroValueFs,
      `the hero readout is typographically LARGE (CSS px): hero ${heroValueFs} vs band ${bandValueFs}`,
    ).toBeGreaterThan(bandValueFs * 1.5);

    // ── 4. THE VU METER — PEAK / ACCENT / V·OCT, and PEAK is a LEVEL. ──
    const meter = hero.getByTestId('kickdrum-meter');
    await expect(meter).toBeVisible();
    await expect(hero.getByTestId('kickdrum-vu')).toBeVisible();
    await expect(
      hero.getByTestId('kickdrum-peak'),
      'PEAK prints a level in dB — it used to print the literal “out L”, a SOURCE label',
    ).toHaveText(/(−∞|-?\d+\.\d) dB/);
    await expect(hero.getByTestId('kickdrum-accent')).toHaveText(/^(CV|FIXED)$/);

    // ── 5. THE SCOPE GLYPH IS GONE FROM THE DOCK HERO. ──
    // It flatlines with no audio, so a faceplate that painted it beside the
    // graph showed an EMPTY BLACK RECTANGLE exactly where the mock puts the
    // envelope picture. It is untouched in the lane (asserted below).
    await expect(
      shell.locator('.dock-hero [data-glyph-kind]'),
      'a face that brings its own hero picture does not also paint the live-trace glyph',
    ).toHaveCount(0);

    // ── 6. BAND HINTS — a header that describes its group, typeset apart. ──
    const subBand = shell.locator('[data-face-page="sub"]');
    await expect(subBand.locator('.page-label')).toContainText('1 · sub');
    await expect(subBand.locator('.page-hint')).toHaveText('depth sine at TUNE — always mono');

    // ── 7. THE SIDEBAR IS A RIGHT RAIL — a real grid column, not a band. ──
    const side = fp.getByTestId('face-sidebar');
    await expect(side).toBeVisible();
    const editorBox = (await fp.getByTestId('faceplate-editor').boundingBox())!;
    const sideBox = (await side.boundingBox())!;
    expect(
      sideBox.x,
      'the sidebar starts to the RIGHT of the editor column (screen px)',
    ).toBeGreaterThanOrEqual(editorBox.x + editorBox.width - 2);
    await expect(
      side.locator('[data-testid^="control-"]'),
      'a sidebar block must NEVER emit a control-<paramId> testid (faces-parity multiset)',
    ).toHaveCount(0);
    await expect(side.getByTestId('side-flow')).toBeVisible();
    await expect(side.getByTestId('side-presets')).toBeVisible();
    await expect(side.getByTestId('side-readouts')).toBeVisible();
    await expect(side.getByTestId('sidebar-panel-stereo-crossover')).toBeVisible();
    // The chain names the three generators as generators, and marks the ONE
    // parallel stage as parallel — TRANSLATE taps the raw sub pre-drive, and a
    // diagram that drew it inline would teach the wrong chain.
    await expect(side.locator('[data-flow-role="generator"]')).toHaveCount(3);
    await expect(side.locator('[data-flow-parallel="true"]')).toHaveCount(1);
    await expect(side.locator('[data-flow-parallel="true"]')).toContainText('TRANSLATE');
  });

  test('the COMPACT lane tile keeps its live glyph — the dock suppression is DOCK-ONLY', async ({ page }) => {
    // The NEGATIVE CONTROL for §5 above, and it ships permanently: "the glyph
    // is gone at the dock" must not be able to pass by the glyph being gone
    // everywhere. The COMPACT tile is the tier that genuinely wants a live
    // trace (at 'full' the 6-cell plate claims both rows and `laneBodyPlan`
    // drops the glyph on its own — a different rule, and not this one).
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'k', type: TYPE, position: { x: 460, y: 240 } }]);
    const tile = page.locator('.svelte-flow__node[data-id="k"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible();
    await setZoomTier(page, 'k', 0.45, 'compact');
    await expect(
      tile.locator('[data-glyph-kind="scope"]'),
      'the compact LANE tile still paints the scope glyph',
    ).toBeVisible();
  });

  test('the crossover panel reads the DEFAULT width, not zero (node.params is SPARSE)', async ({ page }) => {
    // REGRESSION. The panel read `node.params.width` bare and fell back to 0,
    // so a freshly spawned kickdrum printed `WIDTH 0%` beside a dial reading
    // 0.20 — a picture contradicting the control next to it. Nothing else could
    // see it: the param is genuinely untouched, so the store IS empty, and the
    // pure model has no opinion about defaults.
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'k', type: TYPE, position: { x: 460, y: 240 } }]);
    const fp = await openFaceplate(page, 'k');

    expect(
      await paramValue(page, 'k', 'width'),
      'precondition: width is UNTOUCHED, so node.params has no entry for it',
    ).toBeUndefined();
    await expect(
      fp.getByTestId('sidebar-panel-width'),
      'the picture shows the def default (0.20 → 20%), not a bare-store zero',
    ).toHaveText('width 20%');
  });

  test('a PRESET writes, stays lit, and gains a MODIFIED marker when you edit off it', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'k', type: TYPE, position: { x: 460, y: 240 } }]);
    const fp = await openFaceplate(page, 'k');
    const shell = fp.locator('[data-testid="module-shell"]');
    const side = fp.getByTestId('face-sidebar');

    const boom = side.getByTestId('face-preset-sub-boom');
    await expect(boom, 'a fresh module sits on NO preset').toHaveAttribute('aria-pressed', 'false');

    await boom.click();

    // (a) it WROTE — the durable graph moved, not just a highlight.
    await expect
      .poll(() => paramValue(page, 'k', 'tune'), { message: 'SUB BOOM tunes to 38 Hz' })
      .toBe(38);
    expect(await paramValue(page, 'k', 'sub_decay'), 'and stretches the tail to 720 ms').toBe(720);

    // (b) the DIAL followed, so the panel and the control agree.
    await expect(shell.getByTestId('readout-tune')).toHaveText('38 Hz');

    // (c) it LIGHTS — and only it — with NO modified marker yet.
    await expect(boom).toHaveAttribute('aria-pressed', 'true');
    await expect(side.locator('[aria-pressed="true"]'), 'exactly one row is lit').toHaveCount(1);
    await expect(side.locator('[data-preset-modified="true"]')).toHaveCount(0);

    // (d) …and moving ONE knob off it keeps the row LIT and marks it MODIFIED.
    //
    // ⚠ THIS IS THE OWNER'S DECISION, and both alternatives are wrong in one
    // direction. Un-lighting throws away the only record of which voice this
    // sound started as. Staying silently lit asserts a voice the patch no
    // longer is. So the row keeps the provenance AND states that the values
    // moved. Asserting BOTH halves is what stops a later edit from quietly
    // collapsing it back to either one.
    await setNodeParams(page, 'k', { tune: 44 });
    await expect(shell.getByTestId('readout-tune')).toHaveText('44 Hz');
    await expect(boom, 'still lit: this is where the sound came from').toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      side.getByTestId('face-preset-sub-boom-modified'),
      'and marked MODIFIED: the values have moved off it',
    ).toBeVisible();

    // (e) re-recalling clears the marker — the marker tracks the VALUES, not a
    //     one-way "has been touched" flag.
    await boom.click();
    await expect
      .poll(() => paramValue(page, 'k', 'tune'), { message: 're-recall restores 38 Hz' })
      .toBe(38);
    await expect(side.locator('[data-preset-modified="true"]')).toHaveCount(0);
  });
});

// ── THE REGISTRY-DRIVEN SIDEBAR SWEEP ───────────────────────────────────────
//
// Answers the hole the sidebar's placement opens: it mounts as a SIBLING of
// `.editor`, outside `[data-testid="module-shell"]`, which is what lets a
// preset row be an ordinary button instead of a new cell kind faces-parity has
// to learn — and which also puts every block beyond that sweep's reach. This
// closes it WITHOUT moving the sidebar: enumerate the declaration off the live
// registry (`__moduleSpecs[].faceSidebar`) and require every declared block to
// have actually painted, with its label, for every adopter.
test.describe('PF-20 sidebar — every DECLARED block paints, for every adopter', () => {
  test('declared sidebar blocks render, in order, with their labels', async ({ page }) => {
    await gotoShell(page);
    const adopters = await sidebarAdopters(page);

    // The sweep must not be able to go vacuous by everyone dropping their
    // sidebar — an empty roster passing silently is the whole failure mode a
    // registry-driven gate is supposed to remove.
    expect(
      adopters.map((a) => a.type),
      'at least one module declares a dock sidebar (an empty sweep proves nothing)',
    ).not.toHaveLength(0);

    for (const spec of adopters) {
      expect(
        spec.strictFace,
        `${spec.type}: declares a sidebar, so it must be a migrated STRICT_FACES module ` +
          `(the sidebar is dock-only and the dock only renders a migrated face)`,
      ).toBe(true);

      // A fresh boot per adopter: a dock pane left open on a node the next
      // `spawnPatch` deletes would leave two `dock-full-view` roots and turn a
      // real failure into a strict-mode locator error.
      await gotoShell(page);
      await spawnPatch(page, [{ id: 'sb', type: spec.type, position: { x: 460, y: 240 } }]);
      const fp = await openFaceplate(page, 'sb');
      const side = fp.getByTestId('face-sidebar');
      await expect(side, `${spec.type}: the sidebar column mounts`).toBeVisible();

      const blocks = side.locator('[data-side-block]');
      const declared = spec.faceSidebar ?? [];
      await expect(
        blocks,
        `${spec.type}: every declared sidebar block painted (declared ${declared.length})`,
      ).toHaveCount(declared.length);

      for (let i = 0; i < declared.length; i++) {
        const b = blocks.nth(i);
        const want = declared[i]!;
        await expect(b, `${spec.type} block ${i}: kind '${want.kind}'`).toHaveAttribute(
          'data-side-block',
          want.kind,
        );
        await expect(b.locator('.side-h'), `${spec.type} block ${i}: its label`).toHaveText(
          want.label,
        );
        // A block that painted a HEADER over nothing is a labelled void — worse
        // than no block, and exactly what `sidebarPlan`'s empty-drop exists to
        // prevent. Assert the body has content of its own.
        const bodyLen = await b.evaluate(
          (el) => (el.textContent ?? '').replace(el.querySelector('.side-h')?.textContent ?? '', '').trim().length,
        );
        expect(
          bodyLen,
          `${spec.type} block ${i} ('${want.label}'): renders a BODY, not just a header`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
