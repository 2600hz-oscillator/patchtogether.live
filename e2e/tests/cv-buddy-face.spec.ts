// e2e/tests/cv-buddy-face.spec.ts
//
// THE CV BUDDY FACE, driven for real — and specifically the seams no other gate
// can see.
//
// `rack-status-model.test.ts` proves the predicate exhaustively.
// `cv-buddy-face-model.test.ts` proves the platform's "primary" is the module's
// "clock owner", over every kind-combination.
// `cv-buddy-status-model.test.ts` proves every string the status surface can
// produce, painted or not.
// `face-rack-status-source.test.ts` proves the declaration is wired and that
// every extension body declares what it paints.
//
// None of them can see:
//
//  1. THAT THE BAND ACTUALLY LEAVES when a SECOND instance exists. Every gate
//     above reads source or pure functions; the suppression happens in Svelte
//     markup against a live patch, and a filter wired to the wrong list would
//     pass all four.
//  2. ⚠ THAT THE PLATE IS NOT BLANK WHEN IT DOES. This is the failure mode the
//     whole `extBody` precondition exists to prevent, and it is the reason this
//     spec exists at all: cvBuddy's ONLY two params are both in the suppressed
//     band, so if the status body ever stopped painting, a non-primary
//     faceplate would be an empty rectangle. `faceMonitorPlan`'s equivalent
//     hazard is milder — those modules still have a picture.
//  3. THAT THE MEASUREMENTS ARE UNPAINTED BUT PRESENT. The resting-text ruling
//     moved the skip count and the ES-9 sentences into `aria-label`/`title`.
//     A source gate cannot tell whether they survived the move; here the DOM
//     is asked for both halves — the painted text has no measurement in it, and
//     the accessible name does.
//
// Runs on /rack (no DB, no relay). The faceplate shell is the DEFAULT rack.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** ⚠ IDS ARE COMPARED AS STRINGS, so `n-a` < `n-b` decides the primary. Named
 *  rather than numbered precisely so nobody reads them as an ordering by
 *  spawn — the rule is lexicographic, and `cv-b` sorting before `cv-c` is the
 *  same comparison the allocator makes. */
const FIRST = 'cv-b';
const SECOND = 'cv-c';

/**
 * ⚠ THE TWO NODES MUST BE SPAWNED APART, and this is a real failure rather than
 * a style point: `spawnPatch` defaults both to the same canvas position, the
 * tiles overlap, and the upper one's EXPAND label intercepts the click meant
 * for the lower one — measured as a 30 s "element intercepts pointer events"
 * timeout on the first run of this spec, in the two tests that spawn a pair.
 * The distance is arbitrary; only the separation matters.
 */
const PAIR_POS = [
  { x: 80, y: 80 },
  { x: 560, y: 80 },
] as const;

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/**
 * Open a node's dock faceplate and return a locator scoped to THAT NODE's dock
 * shell.
 *
 * ⚠ SCOPED BY `data-shell-node`, NOT BY "the dock". Opening a second node's
 * faceplate SWAPS the dock's occupant, so a locator that only said
 * "the dock shell" would keep resolving after the swap and quietly assert the
 * WRONG NODE's bands — and on this module the two plates differ by exactly the
 * band under test, so a stale locator produces a plausible, wrong pass. This is
 * also why the pair tests below need no explicit close step.
 */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/** The clock band, by its DECLARED page id — the same string
 *  `face.rackStatus.primaryOnlyBands` names, so this asserts on the thing the
 *  declaration actually controls rather than on a position in a list. */
const clockBand = (dock: Locator) => dock.locator('[data-face-page="clock"]');

test.describe('CV BUDDY face — the rack-global status home (#2024)', () => {
  test('a LONE instance is primary: status body AND the clock band both paint', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: FIRST, type: 'cvBuddy' }]);
    const dock = await openDock(page, FIRST);

    // The module's own status surface, at the head of the dock view.
    const status = dock.getByTestId(`cv-buddy-status-${FIRST}`);
    await expect(status).toBeVisible();

    // The SLOT NAME paints — the owner's disambiguation test. A lone full
    // instance takes the first three note jacks.
    await expect(dock.getByTestId(`cv-buddy-slot-name-${FIRST}`)).toHaveText('JACKS 1–3');

    // And the clock band is here, with BOTH controls, because this instance
    // owns RUN and CLOCK.
    await expect(clockBand(dock)).toHaveCount(1);
    await expect(dock.getByTestId('control-ppqn')).toHaveCount(1);
    await expect(dock.getByTestId('control-clockOffsetMs')).toHaveCount(1);
  });

  test('⚠ a SECOND instance loses the clock band — and its plate is NOT blank', async ({ page }) => {
    await gotoShell(page);
    await spawnPatch(page, [
      { id: FIRST, type: 'cvBuddy', position: PAIR_POS[0] },
      { id: SECOND, type: 'cvBuddy', position: PAIR_POS[1] },
    ]);

    // ── the non-primary plate ────────────────────────────────────────────
    const second = await openDock(page, SECOND);
    await expect(
      clockBand(second),
      'the clock band must be GONE on a non-primary instance: RUN and CLOCK are single-source, so '
        + 'PPQN and OFFSET here would configure a scheduler this node does not drive',
    ).toHaveCount(0);
    await expect(second.getByTestId('control-ppqn')).toHaveCount(0);
    await expect(second.getByTestId('control-clockOffsetMs')).toHaveCount(0);

    // ⚠ THE HALF THAT MATTERS MOST. Both of this module's params live in the
    // band that just disappeared, so "the band left" and "the faceplate is an
    // empty rectangle" are one keystroke apart. The status body is what makes
    // the suppression legal, and it must be PAINTING.
    const status = second.getByTestId(`cv-buddy-status-${SECOND}`);
    await expect(status, 'a suppressed band may never leave a blank plate').toBeVisible();
    await expect(status.getByTestId(`cv-buddy-led-routed-${SECOND}`)).toBeVisible();
    // The second full instance takes the next free note set.
    await expect(second.getByTestId(`cv-buddy-slot-name-${SECOND}`)).toHaveText('JACKS 4–6');

    // ── NEGATIVE CONTROL, on the same rack ───────────────────────────────
    // Without this the test above passes just as well against a face that lost
    // its band everywhere — which is a broken module, not a working feature.
    const first = await openDock(page, FIRST);
    await expect(
      clockBand(first),
      'the PRIMARY instance must KEEP its clock band — it is the node that drives jacks 7 and 8',
    ).toHaveCount(1);
    await expect(first.getByTestId('control-ppqn')).toHaveCount(1);
    await expect(first.getByTestId(`cv-buddy-slot-name-${FIRST}`)).toHaveText('JACKS 1–3');
  });

  test('the MINI shares the pool and can be the clock owner', async ({ page }) => {
    // The module's own documented behaviour — "three minis and still have a
    // clock" is only true because a mini can be the id-smallest instance. A
    // face that compared against its own type alone would give BOTH plates a
    // clock band here, and two nodes would claim ES-9 jacks 7 and 8.
    await gotoShell(page);
    await spawnPatch(page, [
      { id: FIRST, type: 'cvBuddyMini', position: PAIR_POS[0] },
      { id: SECOND, type: 'cvBuddy', position: PAIR_POS[1] },
    ]);

    const mini = await openDock(page, FIRST);
    await expect(clockBand(mini), 'the mini is id-smallest, so it owns the clock').toHaveCount(1);
    await expect(mini.getByTestId(`cv-buddy-slot-name-${FIRST}`)).toHaveText('JACKS 1–2');

    const full = await openDock(page, SECOND);
    await expect(
      clockBand(full),
      'the FULL instance is not primary here — the peer set spans both kinds',
    ).toHaveCount(0);
    // …and it still shows where its own jacks are: a mini costs two, so the
    // full instance starts at 3.
    await expect(full.getByTestId(`cv-buddy-slot-name-${SECOND}`)).toHaveText('JACKS 3–5');
  });
});

test.describe('CV BUDDY face — the measurements are PRESENT and UNPAINTED', () => {
  // ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and every assertion
  // in it are UNCHANGED, so un-parking is deleting one `.fixme` plus one
  // SKIP_BUDGET entry.
  //
  // ⚠ THE ENTRY CARRIES ITS UNCERTAINTY RATHER THAN HIDING IT, because this was
  // NOT triaged before parking and saying "flaky" would be a claim nobody has
  // evidence for. ONE observation: recovered-on-retry on a PR run (e2e shard
  // 6/10), first time seen. CLAUDE.md's triage rule points the OTHER way — this
  // file's git history is a single commit, the feature that created it (#2082),
  // and no flake fixes ever, which makes UNDER-BUDGETED the likelier class. Those
  // two classes need opposite responses, so un-parking is a reproduce-and-measure
  // budget diagnosis, not a re-run.
  //
  // WHAT IS STILL COVERED WHILE IT SITS: the lamp itself keeps two sibling legs
  // in this same file — '⚠ the ES-9 sentences are GONE from the plate and ALIVE
  // in the lamp' and 'adding an ES-9 NODE lights the ROUTED lamp — the positive
  // control'. What is lost is narrower than the lamp: the claim that the LATE
  // lamp's caption is STATIC and that its COUNT rides the accessible name.
  test.fixme('the LATE lamp paints a static caption and carries its count in the a11y name', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — recovered-on-retry, first observation, NOT yet triaged as flake vs under-budget; git history shows no flake fixes so under-budget is the likelier class; siblings retain coverage (cv-buddy-face.spec.ts ES-9-sentences leg + ROUTED-lamp positive control); un-park = a reproduce-and-measure budget diagnosis' } }, async ({
    page,
  }) => {
    await gotoShell(page);
    await spawnPatch(page, [{ id: FIRST, type: 'cvBuddy' }]);
    const dock = await openDock(page, FIRST);

    const late = dock.getByTestId(`cv-buddy-led-late-${FIRST}`);
    await expect(late).toBeVisible();

    // PAINTED: the caption, and nothing else. `toHaveText` reads the rendered
    // text content, so a `3 skipped` beside the lamp fails here.
    await expect(late, 'a lamp paints its NAME, never its reading').toHaveText('LATE');

    // UNPAINTED but PRESENT: the state as a word and the measurement as a
    // sentence. This is the half that proves the ruling cost no information.
    await expect(late).toHaveAttribute('aria-label', /^LATE off/);
    await expect(late).toHaveAttribute('title', /No late clock pulses/);
    await expect(late).toHaveAttribute('title', /xruns on the ES-9 card/);

    // The picture is dark at rest, and it is a picture: the state reaches the
    // DOM as a flag, not as text.
    await expect(late).toHaveAttribute('data-lit', '0');
  });

  test('⚠ the ES-9 sentences are GONE from the plate and ALIVE in the lamp', async ({ page }) => {
    // The unrouted/contended collapse, checked where it is visible. The card
    // painted two prose sentences; the face paints one dark lamp and keeps both
    // sentences reachable.
    await gotoShell(page);
    await spawnPatch(page, [{ id: FIRST, type: 'cvBuddy' }]);
    const dock = await openDock(page, FIRST);

    const status = dock.getByTestId(`cv-buddy-status-${FIRST}`);
    const painted = (await status.innerText()).trim();
    expect(
      painted,
      'the status surface may paint only NAMES: the slot name and the lamp captions',
    ).not.toMatch(/es-9|add an|helper|inert|allocated/i);
    // POSITIVE CONTROL for the same read: it DID paint the things it should,
    // so the absence above is not an empty element.
    expect(painted).toMatch(/JACKS/);
    expect(painted).toMatch(/ROUTED/);

    const routed = dock.getByTestId(`cv-buddy-led-routed-${FIRST}`);
    await expect(routed, 'no ES-9 in this rack, so the lamp is dark').toHaveAttribute('data-lit', '0');
    await expect(routed).toHaveAttribute('title', /no ES-9 in this rack/i);
    await expect(routed).toHaveAttribute('title', /es9-bridge helper/);
  });

  test('adding an ES-9 NODE lights the ROUTED lamp — the positive control', async ({ page }) => {
    // The lamp must be able to move. An indicator that is dark in every
    // reachable state is decoration, and every other assertion in this file
    // observes it dark.
    await gotoShell(page);
    await spawnPatch(page, [{ id: FIRST, type: 'cvBuddy' }]);
    const dock = await openDock(page, FIRST);
    const routed = dock.getByTestId(`cv-buddy-led-routed-${FIRST}`);
    await expect(routed).toHaveAttribute('data-lit', '0');

    // Spawn the ES-9 into the SAME patch and let the reactive read see it.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
      };
      w.__setSpawnFlowPos({ x: 400, y: 400 });
      w.__spawnFromPalette('es9');
    });

    // Auto-retrying: the assertion IS the wait, so there is no wall-clock
    // budget to tune per renderer.
    await expect(routed, 'an ES-9 in the rack means this instance reaches jacks').toHaveAttribute(
      'data-lit',
      '1',
    );
    await expect(routed).toHaveAttribute('aria-label', /^ROUTED on/);
    await expect(routed).toHaveAttribute('title', /jacks 1, 2 and 3/i);
  });
});

test.describe('CV BUDDY face — the hardware leg', () => {
  // ⚠ THIS CANNOT RUN ON CI AND SAYS SO OUT LOUD. A CV Buddy's whole purpose is
  // voltage at a physical ES-9 jack, and neither the device nor the es9-bridge
  // helper exists on a CI runner — Chrome also caps `maxChannelCount` at 2, so
  // even a connected ES-9 cannot present its eight outputs to the page. A test
  // that silently skipped would be a green check certifying nothing, which is
  // the "gate that cannot fail on CI is decoration" shape.
  //
  // So: the probe is REAL, the skip is LOUD, and the opt-in flag names the lane
  // that promises to run it. The owner-run recipe is in the PR body.
  test('multichannel ES-9 output is reachable (owner hardware only)', async ({ page }) => {
    await gotoShell(page);
    const maxChannels = await page.evaluate(() => {
      try {
        const Ctor =
          (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
        if (!Ctor) return 0;
        const ctx = new Ctor();
        const n = ctx.destination.maxChannelCount;
        void ctx.close();
        return n;
      } catch {
        return 0;
      }
    });

    const wanted = process.env.E2E_ES9_HARDWARE === '1';
    if (maxChannels < 8) {
      const msg =
        `no multichannel output device: destination.maxChannelCount=${maxChannels} (need >= 8). `
        + 'This machine cannot host an ES-9, so the hardware leg did not run.';
      // ⚠ THE FLAG INVERTS THE OUTCOME. In the lane that PROMISES hardware,
      // a missing device is a FAILURE — otherwise "the rig is unplugged" and
      // "the code is broken" produce the same green.
      if (wanted) throw new Error(`E2E_ES9_HARDWARE=1 was set but ${msg}`);
      test.skip(true, msg);
      return;
    }

    // Reached only on a real multichannel rig. The assertion is deliberately
    // about the CAPABILITY the module depends on, not about audio content:
    // whether the right voltage lands on jack 1 is an ears-and-multimeter
    // question, and the PR body carries that recipe for the owner.
    await spawnPatch(page, [{ id: FIRST, type: 'cvBuddy' }]);
    const dock = await openDock(page, FIRST);
    await expect(dock.getByTestId(`cv-buddy-status-${FIRST}`)).toBeVisible();
    expect(maxChannels, 'an ES-9 presents eight DC-coupled outputs').toBeGreaterThanOrEqual(8);
  });
});
