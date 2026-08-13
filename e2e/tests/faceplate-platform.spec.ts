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
import {
  LANE_CELL_H,
  LANE_KNOB_READOUT_H,
  PLATE_ROW_H,
} from '../../packages/web/src/lib/ui/workflow/module-shell-model';

const TYPE = 'kickdrum';

interface SidebarSpec {
  type: string;
  strictFace?: boolean;
  faceSidebar?: { kind: string; label: string }[];
  faceAnnotations?: { title: number; pageHint: number; bandHints: number };
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
 *  /rack?shell=legacy&seed=none route compile before the chrome mounts. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
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

/** Every MIGRATED face, with its declared annotation counts — the roster the
 *  annotation sweep walks. Migrated only: the dock renders a curated face (and
 *  therefore any annotation at all) exactly for STRICT_FACES modules. */
async function migratedFaces(page: Page): Promise<SidebarSpec[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __moduleSpecs?: SidebarSpec[] };
    return (w.__moduleSpecs ?? []).filter((s) => s.strictFace === true);
  });
}

/**
 * THE BUDGET FOR A REGISTRY-DRIVEN SWEEP MUST SCALE WITH THE ROSTER IT SWEEPS.
 *
 * Both sweeps below cost ONE FULL SHELL BOOT per adopter — `gotoShell()` (a
 * real navigation plus the topbar/pane waits) then `spawnPatch` then
 * `openFaceplate` — and the adopter roster GROWS every time a face is authored.
 * Face batch 3 took it from **1 to 5** in a single PR (kickdrum was the only
 * adopter; clap, drummergirl, pentemelodica and sixstrum joined at once), i.e.
 * a 5x cost increase against a per-test timeout that did not move.
 *
 * A fixed budget is therefore not one assertion — it is a weaker assertion
 * after every batch, silently approaching its own edge until a loaded shard
 * tips it. MEASURED on this branch: the annotation sweep runs 6.1 s on a real
 * GPU but **14.4 s under `E2E_SWIFTSHADER=1`** (the software renderer CI
 * actually uses) and the sidebar sweep 11.9 s — 48 % and 40 % of the old
 * 30 000 ms default consumed *before* the ten-way parallel shard contention CI
 * adds on top. That is what reddened `e2e (shard 3/10)` on #1332.
 *
 * ⚠ The reported failure named `gotoShell`'s `getByTestId('workflow-topbar')`
 * wait — which reads like a broken app boot and is NOT one. It is simply where
 * the outer test budget happened to expire, on a later loop iteration.
 * Verified against the real page: the `?shell=1` route mounts its topbar in
 * 828 ms with ZERO pageerrors, and all four batch-3 faces mount and render, so
 * "one of the new faces throws during shell boot" is disproven.
 *
 * This is a CAP, not a duration: the sweeps still finish in 6-15 s, so a
 * generous per-adopter allowance costs no CI wall time at all. 20 s each leaves
 * ~8x headroom over the measured SwiftShader cost per adopter.
 */
function sweepBudgetMs(adopterCount: number): number {
  return 30_000 + adopterCount * 20_000;
}

test.describe('PF-20 dock faceplate platform (kickdrum)', () => {
  test('the faceplate is a designed panel: header, hero picture, big readouts, hints, sidebar rail', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'k', type: TYPE, position: { x: 460, y: 240 } }]);
    const fp = await openFaceplate(page, 'k');
    const shell = fp.locator('[data-testid="module-shell"]');

    // ── 1. THE PAGE HEADER — ABSENT at rest, in full. ──
    //
    // The title ("Voice") is a description of the PAGE, not the module's name,
    // so it is annotation along with the sentence under it (owner 2026-08-02).
    // §6 below owns the both-directions proof; this is the resting state, which
    // is what the VRT baselines pin.
    await expect(
      shell.getByTestId('face-head'),
      'the DEFAULT faceplate carries no section title and no prose',
    ).toHaveCount(0);

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

    // ⚠ THE READOUT STRIP SITS BELOW THE HERO GRAPHIC (owner, 2026-08-02), and
    // this is the DOM gate for it — a pure-CSS ordering claim is otherwise
    // visible only to the VRT baseline, which cannot say WHY it moved.
    // Measured in CSS px: the dock drawer is outside xyflow's zoom transform,
    // so `boundingBox()` here is unscaled (unlike the in-canvas card sweeps —
    // see the getBoundingClientRect-under-zoom note in CLAUDE.md).
    const picBox = (await hero.getByTestId('kickdrum-hero').boundingBox())!;
    const stripBox = (await heroReadouts.boundingBox())!;
    expect(
      stripBox.y,
      `the readout strip starts BELOW the hero graphic (CSS px): strip top ${stripBox.y} ` +
        `vs graphic bottom ${picBox.y + picBox.height}`,
    ).toBeGreaterThanOrEqual(picBox.y + picBox.height);
    // …and it is a FULL-WIDTH strip, not a column parked beside the picture:
    // it starts at the graphic's left edge rather than to its right.
    expect(
      stripBox.x,
      `the strip starts at the hero's left edge (CSS px): strip x ${stripBox.x} vs graphic x ${picBox.x}`,
    ).toBeLessThanOrEqual(picBox.x + 1);

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

    // ── 6. THE SECTION TITLE AND EVERY HINT ARE ANNOTATION: OUT of the DOM
    //      until the toggle is on. ──
    //
    // Owner (2026-08-02): "this text is still here, i said this is annotation
    // mode text but otherwise we don't want it. in all cases. no 'voice' etc
    // section, no text on the module" — and, clarifying: "the name of the
    // module as text is fine, it's the type/description text that needs to go
    // away. so 'shimmershine' should show but not 'halo' or the text below it."
    //
    // So the MODULE NAME stays (the dock title bar, asserted below) and the
    // page's own title goes with the prose. Asserted in BOTH directions in one
    // test, because either half alone is satisfied by a bug: "absent when off"
    // passes against text that never renders at all, and "present when on"
    // passes against text that is always there.
    const subBand = shell.locator('[data-face-page="sub"]');
    await expect(
      subBand.locator('.page-label'),
      'BAND LABELS STAY — a fieldset legend, and with the hints gone it is the ' +
        'only thing naming the group of knobs under it',
    ).toContainText('1 · sub');
    await expect(
      shell.locator('.page-hint'),
      'NOT rendered by default — not merely hidden, or the a11y tree would ' +
        'disagree with the pixels the VRT baseline pins',
    ).toHaveCount(0);
    await expect(
      shell.getByTestId('face-head'),
      'and the whole page header is gone with it — no “Voice”, no sentence',
    ).toHaveCount(0);

    // THE MODULE'S NAME IS UNTOUCHED, and this is the half of the owner's
    // direction a "remove the text" change is most likely to overshoot. It is
    // the dock TITLE BAR's identity, outside the shell entirely — asserted here
    // so the two halves are pinned by ONE test and cannot be satisfied
    // separately.
    await expect(
      fp.locator('.face-id'),
      'the module still names itself at rest — “shimmershine should show”',
    ).toContainText(/kickdrum/i);

    const annot = fp.getByTestId('faceplate-annotations');
    await expect(annot, 'the faceplate offers the toggle — it HAS prose to show').toBeVisible();
    await expect(annot).toHaveAttribute('aria-pressed', 'false');

    await annot.click();
    await expect(annot).toHaveAttribute('aria-pressed', 'true');
    await expect(subBand.locator('.page-hint')).toHaveText('depth sine at TUNE — always mono');
    await expect(
      shell.locator('.page-hint'),
      'every band that declares one paints it — this face declares five',
    ).toHaveCount(5);
    await expect(
      shell.locator('.face-title'),
      'and the section title comes back with them (the same layer)',
    ).toHaveText('Voice');
    await expect(
      shell.locator('.face-hint'),
      'as does the page-level sentence',
    ).toContainText(/three decoupled generators/i);

    // …and OFF again returns the clean card, so the switch is a switch.
    await annot.click();
    await expect(shell.locator('.page-hint')).toHaveCount(0);
    await expect(shell.getByTestId('face-head')).toHaveCount(0);

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
    await expect(side.getByTestId('side-presets')).toBeVisible();
    await expect(side.getByTestId('side-readouts')).toBeVisible();
    await expect(side.getByTestId('sidebar-panel-stereo-crossover')).toBeVisible();
    // …and NOTHING draws a signal-flow chain any more. The kind was removed
    // (hand-authored DSP models nothing verified against the DSP), so this is
    // the standing negative control: re-adding a renderer for it turns this
    // red rather than quietly repopulating twelve faceplates.
    await expect(
      side.getByTestId('side-flow'),
      'the signal-flow sidebar kind is gone — see FaceSidebarBlock in graph/types.ts',
    ).toHaveCount(0);
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

// ── THE REGISTRY-DRIVEN ANNOTATION SWEEP ────────────────────────────────────
//
// Annotation prose is OUT of the DOM until the viewer turns it on, which makes
// the two failures that matter INVISIBLE to a per-module spec:
//
//   * a face that declares prose the platform never offers a way to read (the
//     toggle did not render), and
//   * a toggle on a face with nothing to say (a labelled void).
//
// Both are properties of the DECLARATION, so both are swept off it. The work is
// bounded on purpose: every ADOPTER is visited (that set is what grows as faces
// are authored), plus exactly ONE non-annotating migrated face as the negative
// control — chosen off the registry, never named here, so it cannot rot.
//
// ⚠ EVERY ASSERTION IS A COUNT, PER SURFACE — never "is it present". A count is
// what makes a TABBED adopter enrol itself: the shell used to gate a band hint
// on the band LABEL, which a tab rail suppresses, so a tabbed face's prose
// rendered NOWHERE with the switch on. `toBeVisible()` on the first `.page-hint`
// would have passed that (there was no first one to be invisible); `toHaveCount(
// declared)` goes red on 0 ≠ 8. The split by surface matters for the same
// reason — one aggregate cannot tell "the title painted and a band hint did
// not" from a correct render.
test.describe('PF-20 annotations — declared prose ⇔ the toggle that reveals it', () => {
  test('every adopter offers the toggle and paints its bands; a face with no prose has no toggle', async ({ page }) => {
    await gotoShell(page);
    const faces = await migratedFaces(page);
    expect(faces.length, 'the registry publishes migrated faces').toBeGreaterThan(0);

    const adopters = faces.filter((f) => f.faceAnnotations);
    expect(
      adopters.map((a) => a.type),
      'at least one face declares annotation prose (an empty sweep proves nothing)',
    ).not.toHaveLength(0);
    // One full shell boot per adopter — the budget scales with the roster.
    // See sweepBudgetMs(): a fixed 30 s silently weakened with every authored
    // face and is what reddened e2e shard 3/10 when this went 1 -> 5 adopters.
    test.setTimeout(sweepBudgetMs(adopters.length));

    for (const spec of adopters) {
      await gotoShell(page);
      await spawnPatch(page, [{ id: 'an', type: spec.type, position: { x: 460, y: 240 } }]);
      const fp = await openFaceplate(page, 'an');
      const shell = fp.locator('[data-testid="module-shell"]');
      const { title, pageHint, bandHints } = spec.faceAnnotations!;
      const tabbed = await fp.getByTestId('faceplate-tabrail').count();

      // OFF is the default, and it is the DOM that is clean — not just CSS.
      // ALL THREE surfaces, so a title left painting at rest cannot hide behind
      // a clean band-hint count (owner 2026-08-02: "no text on the module").
      await expect(shell.locator('.page-hint'), `${spec.type}: no band prose at rest`).toHaveCount(0);
      await expect(
        shell.getByTestId('face-head'),
        `${spec.type}: no section title and no page prose at rest`,
      ).toHaveCount(0);
      const annot = fp.getByTestId('faceplate-annotations');
      await expect(annot, `${spec.type}: declares prose ⇒ offers the toggle`).toBeVisible();
      await expect(annot).toHaveAttribute('aria-pressed', 'false');

      await annot.click();
      await expect(annot).toHaveAttribute('aria-pressed', 'true');
      await expect(
        shell.locator('.page-hint'),
        `${spec.type}: every declared band hint paints — declared ${bandHints}, ` +
          `tabrail=${tabbed} (a tabbed face must paint them too: the hint answers ` +
          `to the SWITCH, not to the rail)`,
      ).toHaveCount(bandHints);
      await expect(
        shell.locator('.face-title'),
        `${spec.type}: the section title paints (declared ${title})`,
      ).toHaveCount(title);
      await expect(
        shell.locator('.face-hint'),
        `${spec.type}: the page-level sentence paints (declared ${pageHint})`,
      ).toHaveCount(pageHint);
    }

    // THE NEGATIVE CONTROL, and it ships permanently: "the toggle appears for
    // an adopter" must not be able to pass by the toggle appearing everywhere.
    const bare = faces.find((f) => !f.faceAnnotations);
    expect(bare, 'a migrated face with NO annotation prose exists to control against').toBeTruthy();
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'an', type: bare!.type, position: { x: 460, y: 240 } }]);
    const fp = await openFaceplate(page, 'an');
    await expect(
      fp.getByTestId('faceplate-annotations'),
      `${bare!.type}: declares no prose ⇒ NO toggle (a switch over nothing is noise)`,
    ).toHaveCount(0);
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
    // Same shape, same growth, same fix as the annotation sweep above.
    test.setTimeout(sweepBudgetMs(adopters.length));

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

// ── PF-21: THE ROW PLAN — two labelled sections on one row ───────────────────
//
// The pure model (dock-row-plan.test.ts) proves the GROUPING: minimum rows,
// then evenness, then the heaviest row last, with a solo row for any band
// carrying a roster or a panel. It is structurally blind to two things that
// only exist in a browser, and both are the reason the model deliberately
// carries NO pixel budget:
//
//   1. A PACKED ROW MUST NOT OVERFLOW. The ceiling is a control COUNT, not a
//      width, so the physical fit is delegated to `flex-wrap` on `.dock-row`.
//      That delegation is a claim about the browser and has to be measured in
//      one. ⚠ These are HONEST CSS PIXELS: the dock faceplate is a sibling of
//      the flow pane, NOT inside it, so xyflow's zoom transform — the thing
//      that makes `card-control-overflow`'s magnitudes viewport-scaled — does
//      not apply here.
//   2. EVERY PACKED SECTION MUST STILL SHOW ITS OWN LABEL. The label is what
//      makes two sections on one row legible rather than a jumble, and since
//      the hints became annotation-only it is the ONLY thing naming a band at
//      rest. A packing rule that quietly dropped it would still pass the model.
test.describe('PF-21 row plan — sections share a row, legibly and without overflow', () => {
  // ⚠ TWO WIDTHS, AND THE NARROW ONE IS THE TEST — with the negative control
  // stated exactly, because measuring it changed what this test asserts.
  //
  // First draft asserted only "a packed row does not overflow its column", at
  // the default 1280 px viewport. Forcing `flex-wrap: nowrap` on `.dock-row`
  // did not redden it — at ANY width. The reason is structural and worth
  // recording: `.dock-row > .dock-page` is `flex: 0 1 auto; min-width: 0`, and
  // `.page-controls` inside each section is itself `flex-wrap: wrap`. So with
  // wrapping off the sections SQUEEZE and their knobs re-wrap internally; the
  // row never spills. The overflow assertion therefore cannot fail for this
  // component as built, and is kept only as a cheap guard for a future change
  // that pins a width or drops the `min-width: 0`.
  //
  // What DOES distinguish the two behaviours is whether a section that no
  // longer fits MOVES TO THE NEXT LINE or is crushed in place — which is the
  // whole reason `.dock-row` wraps. So the live negative control is the WRAP
  // leg below: at 820 px the kit's own floors bind (`.faceplate-body` min-width
  // 900, `.page.has-sidebar` reserving 288 for the rail) and the column bottoms
  // out near 548 px, narrower than the widest packed row, so a wrap MUST be
  // observed. Measured: with `nowrap` forced on, that leg goes red and this
  // one still passes — which is exactly why it ships as a permanent leg.
  const WIDTHS = [
    { label: 'wide', size: { width: 1280, height: 900 } },
    { label: 'narrow', size: { width: 820, height: 900 } },
  ] as const;

  for (const { label, size } of WIDTHS) {
  test(`every packed row keeps its section labels and fits its column (${label} pane)`, async ({ page }) => {
    await page.setViewportSize(size);
    await gotoShell(page);
    const faces = await migratedFaces(page);
    expect(faces.length, 'the registry publishes migrated faces').toBeGreaterThan(0);
    test.setTimeout(sweepBudgetMs(faces.length));

    let packedRows = 0;
    let packedFaces = 0;
    let wrappedRows = 0;
    const shapes: string[] = [];

    for (const spec of faces) {
      await gotoShell(page);
      await spawnPatch(page, [{ id: 'rp', type: spec.type, position: { x: 460, y: 240 } }]);
      const fp = await openFaceplate(page, 'rp');
      const shell = fp.locator('[data-testid="module-shell"]');

      const rows = await shell.evaluate((root) => {
        const pages = root.querySelector('[data-testid="face-pages"]') as HTMLElement | null;
        // ⚠ THE COLUMN, not the row's own box. A flex ITEM sizes to its content,
        // so `row.scrollWidth <= row.clientWidth` is true even when the row is
        // spilling out of the faceplate — measured: with `flex-wrap: nowrap`
        // forced on, that comparison still passed. The honest question is
        // whether the row fits the COLUMN it lives in.
        const colW = pages?.clientWidth ?? 0;
        return [...(pages?.children ?? [])].map((child) => {
          const el = child as HTMLElement;
          const packed = el.matches('[data-testid="face-row"]');
          const secs = packed
            ? [...el.querySelectorAll('[data-testid="face-page"]')]
            : [el];
          return {
            packed,
            ids: secs.map((s) => s.getAttribute('data-face-page') ?? '?'),
            labels: secs.map((s) => (s.querySelector('.page-label')?.textContent ?? '').trim()),
            controls: secs.reduce((n, s) => n + s.querySelectorAll('[data-cell-key]').length, 0),
            // CSS px — see the note above.
            scrollW: el.scrollWidth,
            clientW: colW,
            // Did the row actually WRAP? Sections on one visual line share a
            // top offset; a wrapped one does not.
            wrapped: new Set(secs.map((sec) => (sec as HTMLElement).offsetTop)).size > 1,
          };
        });
      });

      shapes.push(`${spec.type}: ${rows.map((r) => r.ids.join('+')).join(' | ')}`);
      // ⚠ NOT `faceplate-tabrail` — that element ALWAYS renders (it holds the
      // single MODULE chip below the threshold), so probing it answers 'true'
      // for every face and is invariant to the dimension under test. The rail
      // is RAILED exactly when it painted per-section tab buttons.
      const tabbed = (await fp.locator('[data-face-tab]').count()) > 0;

      for (const row of rows) {
        if (!row.packed) continue;
        packedRows++;
        expect(
          tabbed,
          `${spec.type}: a TAB RAIL shows one band at a time — it must never pack`,
        ).toBe(false);
        expect(
          row.ids.length,
          `${spec.type} row ${row.ids.join('+')}: a packed row holds two or more sections`,
        ).toBeGreaterThan(1);
        for (let i = 0; i < row.ids.length; i++) {
          expect(
            row.labels[i],
            `${spec.type} row ${row.ids.join('+')}: section '${row.ids[i]}' still shows its own label`,
          ).not.toBe('');
        }
        expect(
          row.scrollW,
          `${spec.type} row ${row.ids.join('+')}: ${row.controls} cells overflow the column ` +
            `(${row.scrollW} > ${row.clientW} CSS px of column, ${label} pane) — flex-wrap did not absorb it`,
        ).toBeLessThanOrEqual(row.clientW + 1);
        if (row.wrapped) wrappedRows++;
      }
      if (rows.some((r) => r.packed)) packedFaces++;
    }

    // ⚠ THE NEGATIVE CONTROL, permanent leg. Every assertion above is inside
    // `if (!row.packed) continue`, so a rule that stopped packing ANYTHING —
    // a broken classifier, a ceiling accidentally set to 1 — would sweep 22
    // faces and assert nothing at all, in total silence. Naming the faces makes
    // a shrinking roster visible in the failure rather than invisible in a pass.
    expect(
      packedFaces,
      `no face packed a single row — the sweep asserted nothing. shapes:\n${shapes.join('\n')}`,
    ).toBeGreaterThanOrEqual(10);
    expect(packedRows, 'packed rows observed').toBeGreaterThanOrEqual(10);

    // …and the SECOND half of the negative control: at the narrow pane the
    // wrap has to have actually engaged somewhere, or the no-overflow claim
    // above is again being satisfied by rows that simply fit.
    if (label === 'narrow') {
      expect(
        wrappedRows,
        `no packed row WRAPPED at ${size.width}px — the no-overflow assertion is ` +
          `vacuous at this width, so it cannot prove flex-wrap does anything. shapes:\n${shapes.join('\n')}`,
      ).toBeGreaterThan(0);
    }
  });
  }
});

// ── THE LANE TILE'S NO-CLIP GUARANTEE, MEASURED IN A BROWSER ────────────────
//
// `laneBodyPlan` has always CLAIMED that only WHOLE cells render inside the
// fixed 192×180 tile. Until 2026-08-11 it computed that against ONE hardcoded
// cell height — 42px, a small knob column — which was true for every cell kind
// that existed and false the moment one did not fit.
//
// `fader` (#1464) is 96px. The plate's `grid-auto-rows` is a FIXED track and
// `align-items: start`, so an over-tall cell is NOT clipped — it paints over
// the row below. marbles' full-tier tile shipped to dev with three overlaps of
// exactly 50.0 CSS px (96 − the 46px row pitch): two thumbs in every column,
// row 1's labels buried under row 2's tracks, and `t_model`'s `COIN ▾` grid
// chip floating on top of the T BIAS fader.
//
// ⚠ WHY THIS EXISTS AS AN E2E WHEN THE UNIT GATE IS EXHAUSTIVE.
// `module-shell-model.test.ts` sweeps the whole `ParamCellKind` union and is
// the stronger gate for the ARITHMETIC. It is structurally blind to exactly one
// thing: whether `LANE_CELL_H`'s numbers are the heights the browser actually
// paints. A model that agrees with itself proves nothing about the DOM — the
// planner/renderer split IS the bug class, so the two sides have to be measured
// against each other rather than each against itself.
//
// ⚠ STATED SCOPE. This sweeps the faces that declare a non-default param cell
// plus plain-knob controls, and it discovers the KIND of every cell from the
// DOM rather than from a list here. What it does NOT do is boot all ~29 faced
// modules × 3 tiers: the unit sweep covers the kind union, and this covers the
// kinds that actually paint.
/** One measured plate tile — the shape both the sweep and its negative control
 *  hand to `plateOverruns`. */
interface PlateTile {
  rowTracks: number[];
  cells: { kind: string; x: number; y: number; w: number; h: number }[];
}

/**
 * Split a plate's over-tall cells into the two cases that need OPPOSITE
 * responses — the distinction the whole per-row rule rests on.
 *
 * `willCollide` — the cell outgrows its own row's track AND some cell sits
 *   below it sharing horizontal extent. That is a real collision (or one gap
 *   away from one) and is a failure.
 * `harmless` — it outgrows its track with NOTHING beneath it, so it paints into
 *   empty grid space. Measured over the live roster under the OLD per-face
 *   track, this was FOUR of the eleven readout-bearing faces (cofefve, filter,
 *   resofilter, tidyVco) — and they are exactly the faces a per-face track
 *   would have evicted rows from for no reason. Flagging them is how the next
 *   reader ends up back in that trap, so the split is the gate, not a softening.
 *
 * ONE function, called by the sweep and by the negative control below, so the
 * control cannot go blind separately from the check (the re-typed-copy failure
 * CLAUDE.md records).
 */
function plateOverruns(tile: PlateTile): { willCollide: string[]; harmless: string[] } {
  const willCollide: string[] = [];
  const harmless: string[] = [];
  const hasLowerNeighbour = (c: PlateTile['cells'][number]) =>
    tile.cells.some(
      (o) =>
        o !== c &&
        o.y > c.y + 0.5 &&
        Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x) > 0.5,
    );
  // Rows are laid out top-down in `rowTracks` order, so rank the distinct y
  // offsets and index by that.
  const rowYs = [...new Set(tile.cells.map((c) => Math.round(c.y)))].sort((a, b) => a - b);
  for (const c of tile.cells) {
    const rowIdx = rowYs.indexOf(Math.round(c.y));
    const track = tile.rowTracks[rowIdx];
    if (track === undefined || c.h <= track + 0.5) continue;
    const where =
      `a '${c.kind}' cell measures ${c.h.toFixed(1)} CSS px in row ${rowIdx}'s ${track} px track`;
    if (hasLowerNeighbour(c)) {
      willCollide.push(`${where} AND has a cell beneath it — it will paint ${(c.h - track).toFixed(1)} px over that row`);
    } else {
      harmless.push(`${where}, nothing beneath it`);
    }
  }
  return { willCollide, harmless };
}

test.describe('lane tile geometry — no cell paints over another, at any lane tier', () => {
  /** Every migrated face — read off the live registry, never a list here. */
  async function facedTypes(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const w = globalThis as unknown as {
        __moduleSpecs?: { type: string; strictFace?: boolean }[];
      };
      return (w.__moduleSpecs ?? []).filter((s) => s.strictFace).map((s) => s.type);
    });
  }

  test('every rendered lane cell stays inside its own box, and matches LANE_CELL_H', async ({
    page,
  }) => {
    await gotoShell(page);
    const faced = await facedTypes(page);
    expect(faced.length, 'the registry publishes migrated faces').toBeGreaterThan(0);

    // marbles is the regression witness and MUST be swept — if the face is ever
    // dropped from STRICT_FACES this fails loudly rather than quietly sweeping
    // a roster that no longer contains the shape that broke.
    expect(faced, 'marbles (the fader face) is a migrated face').toContain('marbles');

    // marbles + noise are the fader faces; adsr and dx7 bring plain knob
    // columns and a declared grid, so "everything is a fader" cannot pass.
    //
    // ⚠ tidyVco IS HERE FOR THE OTHER HALF OF LEG (b), and without it that leg
    // is asserted but never exercised. adsr is the face whose tall cell HAS a
    // row beneath it (row 0, 9.0 px of overlap before the per-row fix);
    // tidyVco is the face whose tall cell (`oct2`, rank 5) is in the LAST row
    // with nothing under it, so it overruns a 42 px track by 13 px and collides
    // with nothing. A leg that only ever sees the first shape cannot show it
    // discriminates — and a "fix" that flags the second is precisely the
    // eviction trap the per-row rule exists to avoid.
    const WANT = ['marbles', 'noise', 'adsr', 'dx7', 'tidyVco'];
    const subjects = faced.filter((t) => WANT.includes(t));
    expect(subjects.sort(), 'every subject of this sweep is a migrated face').toEqual(
      [...WANT].sort(),
    );
    test.setTimeout(sweepBudgetMs(subjects.length * 3));

    await spawnPatch(
      page,
      subjects.map((type, i) => ({
        id: `t${i}`,
        type,
        position: { x: 260 + (i % 2) * 420, y: 200 + Math.floor(i / 2) * 320 },
      })),
    );

    /** node id → module type, so a failure names the FACE and not `t2`. */
    const idType = new Map(subjects.map((t, i) => [`t${i}`, t]));
    const name = (node: string) => `${idType.get(node) ?? node}`;

    const seenKinds = new Set<string>();
    const problems: string[] = [];
    /** Every cell that PAINTED a readout line, with its measured height —
     *  the population leg (e) bounds against `LANE_KNOB_READOUT_H`. */
    const readoutCells: { where: string; h: number }[] = [];
    /** Plate cells that OUTGROW their track with NOTHING BENEATH THEM — the
     *  case leg (b) deliberately does not flag. Collected so the exemption
     *  is PROVEN to be exercised rather than merely written down. */
    const innocentOverruns: string[] = [];
    /**
     * ⚠ THE knob↔knob BUCKET IS GONE, AND THAT IS THE POINT (2026-08-12).
     *
     * It used to hold a SECOND defect this sweep found and did not fix: a knob
     * cell is not the 42 px the plate's design row assumes, because `KnobConic`
     * renders an EARNED readout for any param declaring a vocabulary, making
     * the cell 55 px (57 under the VRT webfonts). Measured on adsr: 13 px of
     * track overrun and `knob overlaps knob by 36.0×9.0 CSS px`.
     *
     * ⚠ AND THE ORIGINAL COUNT WAS WRONG BECAUSE THE INSTRUMENT WAS SINGLE-AXIS.
     * A y-only overlap test reports every same-row sibling as colliding and
     * gives ELEVEN faces. Measured with x AND y over all 32 migrated faces:
     * SEVEN overlap, every one of them by exactly 9.0 CSS px (adsr, cloudseed,
     * delay, kickdrum, lfo, macrooscillator, ringback), out of 32 readout-
     * bearing cells across 11 faces — the other four (cofefve, filter,
     * resofilter, tidyVco) have NOTHING BENEATH the tall cell and collide with
     * nothing. "All exactly 9.0" is the tell that it is structural: 9 = 55 − 46,
     * the rendered cell minus the 42 px track + 4 px gap row pitch.
     *
     * The remedy shipped with this un-bucketing: the plate's tracks are sized
     * PER ROW (`plateRowTracks`), so a tall cell costs only the rows beneath it
     * instead of shrinking the whole plate. A knob↔knob overlap is therefore
     * now as unconditional a failure as every other pair.
     */

    for (const [tier, zoom] of [
      ['mini', 0.2],
      ['compact', 0.45],
      ['full', 0.7],
    ] as const) {
      // One tier settle for the whole patch — every tile crosses together.
      await setZoomTier(page, 't0', zoom, tier);

      const measured = await page.evaluate(() => {
        // ⚠ `offsetTop/Left/Width/Height`, NOT `getBoundingClientRect`.
        // The tiles live under xyflow's viewport TRANSFORM, so every rect is in
        // SCREEN px and has to be divided by the live zoom to mean anything —
        // and at zoom 0.2 that division turned a 96 px fader cell into 94.0,
        // i.e. it manufactured a 2 px "finding" out of subpixel rounding.
        // (Measured while writing this test. It is the same instrument error
        // CLAUDE.md records against card-control-overflow, which reports
        // VIEWPORT-SCALED pixels for exactly this reason.) The offset* family
        // reports the UNTRANSFORMED border box in CSS px — the units the model
        // is written in — so there is no zoom in the arithmetic at all.
        // Siblings in one `.tile-body` share an offsetParent, so their offsets
        // are directly comparable to each other.
        const out: {
          node: string;
          layout: string;
          /** The plate's PER-ROW tracks, read back off the DOM. */
          rowTracks: number[];
          cells: {
            kind: string;
            x: number;
            y: number;
            w: number;
            h: number;
            /** Is the EARNED readout line painted here? The height the plate
             *  over-ran was this line, so geometry and cause are read together. */
            readout: boolean;
          }[];
        }[] = [];
        for (const shell of document.querySelectorAll(
          '.svelte-flow__node [data-testid="module-shell"]',
        )) {
          const body = shell.querySelector('.tile-body') as HTMLElement | null;
          if (!body) continue;
          const cells = [
            ...body.querySelectorAll(':scope > [data-cell-kind], :scope > .tile-glyph'),
          ].map((el) => {
            const e = el as HTMLElement;
            return {
              kind: e.getAttribute('data-cell-control') ?? 'glyph',
              x: e.offsetLeft,
              y: e.offsetTop,
              w: e.offsetWidth,
              h: e.offsetHeight,
              readout: !!e.querySelector('.readout'),
            };
          });
          out.push({
            node: shell.closest('.svelte-flow__node')?.getAttribute('data-id') ?? '?',
            layout: body.getAttribute('data-body-layout') ?? 'row',
            // The grid tracks the plan wrote — read back off the DOM rather
            // than recomputed here, so a plan that stops threading them through
            // fails. One number per ROW since 2026-08-12.
            rowTracks: (body.getAttribute('data-plate-row-h') ?? '')
              .split(/\s+/)
              .filter(Boolean)
              .map(Number),
            cells,
          });
        }
        return out;
      });

      expect(measured.length, `${tier}: tiles were measured`).toBeGreaterThan(0);

      for (const tile of measured) {
        for (const c of tile.cells) {
          seenKinds.add(c.kind);
          // ⚠ PLATE ONLY. `LANE_KNOB_READOUT_H` is a PLATE figure — a 26 px
          // `sm` dial plus its label and readout. The ROW layout uses `md`
          // (and `lg` at mini), so its readout cells are legitimately
          // taller: measured 69 px at compact and 75 at mini on adsr. They
          // are not bounded by this constant and must not be judged by it —
          // the row has no fixed track for anything to overrun.
          if (c.readout && tile.layout === 'plate') {
            readoutCells.push({
              where: `${tier}/${name(tile.node)} '${c.kind}'`,
              h: c.h,
            });
          }
        }

        // (a) NO TWO CELLS OVERLAP — the defect, stated directly.
        for (let i = 0; i < tile.cells.length; i++) {
          for (let j = i + 1; j < tile.cells.length; j++) {
            const a = tile.cells[i];
            const b = tile.cells[j];
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            // ⚠ BOTH AXES. A y-only test calls every same-row sibling an
            // overlap and inflated this population from 7 faces to 11.
            if (ox > 0.5 && oy > 0.5) {
              // Unconditional for EVERY pair of kinds, knob↔knob included —
              // see the note on the removed bucket above.
              problems.push(
                `${tier}/${name(tile.node)} (${tile.layout}): ${a.kind} overlaps ${b.kind} by ` +
                  `${ox.toFixed(1)}×${oy.toFixed(1)} CSS px`,
              );
            }
          }
        }

        // (b) A CELL THAT OUTGROWS ITS TRACK **AND HAS A CELL BENEATH IT** —
        //     the precise precondition for (a), and the distinction is the
        //     whole rule. Only the PLATE can produce an overlap: it is the one
        //     layout with FIXED grid tracks, and `align-items: start` means an
        //     over-tall cell spills downward instead of being clipped. The ROW
        //     layout is a flex line with `align-items: center` and no track, so
        //     a tall cell there is simply a tall line — which is why marbles'
        //     compact tile was correct all along while its full tile was not.
        //
        // ⚠ "HAS A LOWER NEIGHBOUR" IS LOAD-BEARING, NOT A SOFTENING. A cell
        // that overruns its track with nothing under it paints into empty grid
        // space and collides with nothing — measured, that is FOUR of the
        // eleven readout-bearing faces (cofefve, filter, resofilter, tidyVco),
        // and they are exactly the faces a per-FACE track would have evicted
        // rows from for no reason. Flagging them here would push the next
        // reader straight back into that trap. Leg (a) stays unconditional, so
        // an actual collision is caught either way; this leg is the near-miss
        // detector, and a near-miss needs something to miss.
        if (tile.layout === 'plate') {
          const { willCollide, harmless } = plateOverruns(tile);
          innocentOverruns.push(...harmless.map((m) => `${tier}/${name(tile.node)} ${m}`));
          problems.push(...willCollide.map((m) => `${tier}/${name(tile.node)}: ${m}`));
        }

        // (c) THE CONSTANT THE PLATE ARITHMETIC RUNS ON BOUNDS THE REAL CELL.
        //     `LANE_CELL_H.fader` is what `plateRowsFor` divides the body by, so
        //     if the rendered fader ever grew past it every row count derived
        //     from it would be wrong — and the unit sweep could not notice,
        //     because it would still be agreeing with itself.
        //
        //     ⚠ ASSERTED AS A CEILING AND A FLOOR, NOT AS EQUALITY, because the
        //     cell height is FONT-DEPENDENT and this is a real measured spread,
        //     not slack: the same marbles fader is 96.0 CSS px under the VRT
        //     scenes' pinned webfonts and 94.0 in the app's own stack (the 12px
        //     label line box becomes 10px). An equality assertion here would be
        //     pinning one font environment and would go red on the other — the
        //     repo has this exact warning about where a flex row wraps.
        //     Directional is also the honest shape: over-reserving is safe,
        //     under-reserving is the overlap.
        for (const c of tile.cells) {
          if (c.kind !== 'fader') continue;
          if (c.h > LANE_CELL_H.fader) {
            problems.push(
              `${tier}/${name(tile.node)}: a fader cell measures ${c.h.toFixed(1)} CSS px, ` +
                `OVER the LANE_CELL_H.fader = ${LANE_CELL_H.fader} ceiling the plate's row ` +
                `arithmetic is derived from — the plan is now under-reserving`,
            );
          }
          // …and the floor, so the ceiling cannot be satisfied by the fader
          // quietly collapsing to a knob-sized cell (which would make the whole
          // tall-cell mechanism vacuous while every assertion stayed green).
          if (c.h <= PLATE_ROW_H) {
            problems.push(
              `${tier}/${name(tile.node)}: a fader cell measures only ${c.h.toFixed(1)} CSS px, ` +
                `at or under the ${PLATE_ROW_H} px design cell — a fader is supposed to be the ` +
                `TALL kind, so the plate's tall-cell path is no longer exercised by anything`,
            );
          }
        }
      }
    }

    expect(problems.join('\n'), 'lane tile cells painting over one another').toBe('');

    // (b′) THE EXEMPTION IS EXERCISED, NOT JUST DECLARED. Leg (b) skips a cell
    //      that overruns its track with nothing beneath it. If the sweep never
    //      MET that shape, the skip would be untested prose and a later
    //      tightening could delete it with every gate still green — which is
    //      exactly how the four innocent faces would get evicted. tidyVco is in
    //      the roster to guarantee the shape appears.
    // …and under a CORRECT plan there is nothing to exempt: every row track is
    // sized to its own tallest cell, so no cell overruns anything. Recording it
    // rather than asserting a witness, because the live roster cannot produce
    // one any more — which is the fix working. The discrimination itself is
    // proven against a FORCED overrun below.
    expect(
      innocentOverruns,
      'a correctly planned plate has no over-tall cells at all, harmless or otherwise',
    ).toEqual([]);

    // (e) THE READOUT CELL IS BOUNDED BY THE CONSTANT THE PLAN RESERVES FOR IT
    //     — the same ceiling-and-floor shape as leg (c), for the other tall
    //     cell. `faceLaneCellHeights` reserves `LANE_KNOB_READOUT_H` for any
    //     param that declares a vocabulary, and `plateRowTracks` divides the
    //     body by that, so a rendered readout cell growing past it would make
    //     every row track wrong — and the exhaustive unit sweep could not
    //     notice, because it would still be agreeing with itself. The FLOOR
    //     stops the ceiling being satisfied by the readout quietly not
    //     rendering at all, which would make this whole mechanism vacuous while
    //     every assertion stayed green.
    const overCeiling = readoutCells.filter((c) => c.h > LANE_KNOB_READOUT_H);
    expect(
      overCeiling.map((c) => `${c.where} at ${c.h.toFixed(1)} CSS px`),
      `a cell PAINTING a readout measured over the LANE_KNOB_READOUT_H = ${LANE_KNOB_READOUT_H} ` +
        `ceiling the plate's row arithmetic reserves — the plan is now under-reserving, which is ` +
        `an overlap waiting for a row beneath it`,
    ).toEqual([]);
    const underFloor = readoutCells.filter((c) => c.h <= PLATE_ROW_H);
    expect(
      underFloor.map((c) => `${c.where} at ${c.h.toFixed(1)} CSS px`),
      `a cell that PAINTS a readout measured at or under the ${PLATE_ROW_H} px design cell — a ` +
        `readout is supposed to make the column taller, so the mechanism this test exists for is ` +
        `no longer exercised by anything`,
    ).toEqual([]);
    expect(
      readoutCells.length,
      `the sweep must have measured at least one cell PAINTING a readout — that is the cell ` +
        `whose height broke adsr's plate. Seen: ${readoutCells.map((c) => c.where).join('; ') || '(none)'}`,
    ).toBeGreaterThan(0);

    // ── THE NEGATIVE CONTROL, PERMANENT ─────────────────────────────────────
    // Every assertion above is inside a loop over cells, so a shell that
    // rendered NO cells — a broken face, a selector returning nothing — would
    // sweep every tile and assert nothing at all, in total silence. Requiring
    // the kind that caused the regression to have actually painted is what
    // makes a green run mean something. `fader` is also the tallest kind, so it
    // is the one whose absence would make the height leg vacuous.
    expect(
      [...seenKinds].sort().join(','),
      `the sweep must have measured a FADER cell — that is the kind whose height ` +
        `broke the plate. kinds seen: ${[...seenKinds].sort().join(', ') || '(none)'}`,
    ).toContain('fader');
  });

  // ── LEG (b) DISCRIMINATES — BOTH DIRECTIONS, AGAINST A FORCED OVERRUN ─────
  //
  // The sweep above can no longer produce an over-tall cell at all: the plan
  // sizes every row to its own tallest cell, so `plateOverruns` returns two
  // empty lists on every face. That is the fix working, and it leaves the
  // neighbour test — the part that decides which over-tall cells MATTER —
  // asserted but never exercised. A rule nothing exercises is a rule the next
  // tightening deletes with every gate still green, and deleting THIS one puts
  // the four innocent faces (cofefve, filter, resofilter, tidyVco) back in the
  // eviction trap that per-row tracks exist to avoid.
  //
  // So force the failure the planner no longer makes: squeeze the tracks back
  // to the design row, exactly as a per-FACE track would have, and require the
  // SAME predicate the sweep calls to sort the results into the two buckets.
  // tidyVco is the subject because it has both shapes at once — three plain
  // 42 px cells over a row containing `oct2`, whose readout makes it 55.
  test('leg (b) separates a tall cell WITH a lower neighbour from one without', async ({
    page,
  }) => {
    await gotoShell(page);
    // TWO subjects, one per direction, because no single face carries both
    // shapes: a face only has a tall cell in a non-last row if its RANKING put
    // one there. macrooscillator ranks `model` FIRST (a 14-engine roster, so it
    // earns a readout) with a second row under it; tidyVco ranks `oct2` FIFTH,
    // which lands in the last row with nothing beneath.
    await spawnPatch(page, [
      { id: 't0', type: 'macrooscillator', position: { x: 300, y: 200 } },
      { id: 't1', type: 'tidyVco', position: { x: 720, y: 200 } },
    ]);
    await setZoomTier(page, 't0', 0.7, 'full');

    /** Measure one tile, optionally SQUEEZING its tracks back to the design row
     *  — the shape a per-FACE track had, and the failure the planner no longer
     *  makes on its own. */
    const measure = async (node: string, squeeze: boolean) =>
      page.evaluate(
        ({ node, squeeze }) => {
          const body = document.querySelector(
            `.svelte-flow__node[data-id="${node}"] [data-testid="module-shell"] .tile-body`,
          ) as HTMLElement;
          const planned = (body.getAttribute('data-plate-row-h') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
          if (squeeze) body.style.gridTemplateRows = planned.map(() => '42px').join(' ');
          const cells = [...body.querySelectorAll(':scope > [data-cell-kind]')].map((el) => {
            const e = el as HTMLElement;
            return {
              kind: e.getAttribute('data-cell-control') ?? '?',
              x: e.offsetLeft,
              y: e.offsetTop,
              w: e.offsetWidth,
              h: e.offsetHeight,
            };
          });
          return { rowTracks: squeeze ? planned.map(() => 42) : planned, cells };
        },
        { node, squeeze },
      );

    // AS PLANNED: tracks sized per row, so neither bucket fills on either face.
    for (const [node, type] of [
      ['t0', 'macrooscillator'],
      ['t1', 'tidyVco'],
    ] as const) {
      const planned = plateOverruns(await measure(node, false));
      expect(planned.willCollide, `${type}: as planned, no cell overruns its row track`).toEqual([]);
      expect(planned.harmless, `${type}: and therefore nothing to exempt either`).toEqual([]);
    }

    // SQUEEZED — the same predicate, on the same tiles, under the old geometry.
    const collided = plateOverruns(await measure('t0', true));
    expect(
      collided.willCollide.length,
      `macrooscillator: a 55 px cell in a 42 px track WITH a row beneath it must be FLAGGED. ` +
        `Got: ${JSON.stringify(collided)}`,
    ).toBeGreaterThan(0);

    const exempt = plateOverruns(await measure('t1', true));
    expect(
      exempt.harmless.length,
      `tidyVco: a 55 px cell in a 42 px track in the LAST row, with nothing beneath it, must be ` +
        `EXEMPT — that is the distinction the per-row rule turns on, and flagging it is how the ` +
        `four innocent faces get evicted. Got: ${JSON.stringify(exempt)}`,
    ).toBeGreaterThan(0);
    expect(
      exempt.willCollide,
      'tidyVco: and it must not ALSO be reported as a collision',
    ).toEqual([]);
  });
});
