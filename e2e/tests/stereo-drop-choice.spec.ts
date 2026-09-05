// e2e/tests/stereo-drop-choice.spec.ts
//
// DROP A MONO SOURCE ON A STEREO JACK → BE ASKED WHICH SIDE.
//
// Owner (2026-08-12): "whenever we drop a mono source on a stereo jack or a
// stereo source on a mono jack, is that we prompt a quick dialog asking which
// of the 2 or both L/R to connect to, and then in the case of stereo → mono ask
// which channel we want."
//
// ⚠ THIS SPEC IS THE GATE FOR THE HALF THE UNIT TEST CANNOT SEE.
// `stereo-drop-choice.test.ts` proves the DECISION — hand it two defs and it
// says whether to ask and what the rows are. It is structurally blind to
// whether any gesture can ever reach that decision, which is the exact failure
// #1426 documented on this surface: the planner had honoured per-leg patching
// all along and no menu could reach it. So the subject here is the DROP, and
// the verdict is `__patch.edges` afterwards.
//
// ⚠ AND THE VERDICT IS THE GRAPH, NOT THE MENU. A dialog that opens, closes and
// writes the old double-patch anyway would satisfy "the dialog appears". Every
// case below asserts the exact edge set, so choosing L and choosing R are
// distinguishable from each other AND from the pre-owner behaviour.
//
// TWO GESTURES, because the chooser has to be a property of the COMMIT SEAM and
// not of one entry point:
//   * the native DRAG (`__handleConnect` — the same function xyflow's pointer
//     drop calls), and
//   * the CARRY (jack-click → "patch to" → a port row).
// The drill-down PICKER is deliberately absent from the mono → stereo cases:
// it already renders the pair's L / R / both rows itself, so it answers the
// question in place rather than raising a second dialog. That is asserted here
// too — as a NEGATIVE, since a chooser that fired there would be a regression
// in gesture count that no positive test would notice.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

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

/** `src.port -> dst.port`, sorted — the whole cable set, so an EXTRA leg fails
 *  as loudly as a missing one. That is the assertion shape this feature needs:
 *  the bug it replaces wrote one leg too many. */
function summarize(edges: PatchEdge[]): string[] {
  return edges
    .map((e) => `${e.source.nodeId}.${e.source.portId} -> ${e.target.nodeId}.${e.target.portId}`)
    .sort();
}

async function expectGraph(page: Page, expected: string[]) {
  await expect
    .poll(async () => summarize(await readEdges(page)), { timeout: 3000 })
    .toEqual([...expected].sort());
}

/**
 * A mono VCO, a stereo granular (`in_l`/`in_r`, `out_l`/`out_r` — both declared
 * pairs), and a mono filter. Lightweight non-WebGL audio cards, so the page
 * stays responsive under CI's software renderer and a plain `.click()` on a
 * menu row works without force / elementFromPoint instrumentation.
 */
async function spawnRig(page: Page) {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: 'vco', type: 'analogVco', position: { x: 80, y: 120 } },
    { id: 'vco2', type: 'analogVco', position: { x: 80, y: 520 } },
    { id: 'cld', type: 'clouds', position: { x: 760, y: 120 } },
    { id: 'flt', type: 'filter', position: { x: 1200, y: 520 } },
  ]);
  // Park the pointer somewhere sane: the chooser anchors to the last known
  // cursor position, and a menu clamped against the viewport corner is harder
  // to click and harder to read in a trace.
  await page.mouse.move(600, 360);
}

/** Commit through the REAL drag path. `__handleConnect` is the same function
 *  xyflow calls on a pointer drop; it names a precise target handle, which is
 *  exactly the gesture that used to guess a width. */
async function dropConnect(
  page: Page,
  from: { nodeId: string; portId: string },
  to: { nodeId: string; portId: string },
) {
  await page.evaluate(
    ({ from, to }) => {
      (
        window as unknown as {
          __handleConnect: (c: {
            source: string;
            sourceHandle: string;
            target: string;
            targetHandle: string;
          }) => void;
        }
      ).__handleConnect({
        source: from.nodeId,
        sourceHandle: from.portId,
        target: to.nodeId,
        targetHandle: to.portId,
      });
    },
    { from, to },
  );
}

/**
 * Open a card's PatchPanel and drill to one of its two flat rails.
 *
 * Escape first, because the trigger TOGGLES and the panel REMEMBERS its drill
 * view, so a second call in one test can otherwise land where the row does not
 * exist. ⚠ But Escape ALSO CANCELS AN IN-FLIGHT CARRY (`cancelPickup`), so the
 * target card of a carry gesture must be opened with `escape: false` — with it
 * on, the cable is dropped, the row click starts a fresh pickup instead of
 * committing, and the test reads exactly like "the chooser never opened".
 */
async function openPanel(
  page: Page,
  nodeId: string,
  nav: 'inputs' | 'outputs',
  opts: { escape?: boolean } = {},
) {
  if (opts.escape !== false) await page.keyboard.press('Escape');
  await page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`).click();
  const chromeEl = page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
  await expect(chromeEl).toHaveAttribute('aria-hidden', 'false');
  await chromeEl.locator(`[data-testid="patch-panel-nav"][data-nav="${nav}"]`).click();
}

function panelRow(page: Page, nodeId: string, portId: string) {
  return page
    .locator(`[data-patch-panel-chrome="${nodeId}"]`)
    .locator(`[data-testid="patch-panel-port-row"][data-port-id="${portId}"]`);
}

/** Carry a source output into the drill-down PICKER and click one of the target
 *  rows. `leg` is the row's `data-leg`: `''` is the whole-pair row, `left` /
 *  `right` the per-leg ones. */
async function pickViaPicker(
  page: Page,
  src: { nodeId: string; portId: string },
  targetNodeId: string,
  targetPortId: string,
  leg: '' | 'left' | 'right',
) {
  await openPanel(page, src.nodeId, 'outputs');
  await panelRow(page, src.nodeId, src.portId).click();
  await page.mouse.move(500, 320);
  await page
    .locator(`[data-patch-panel-chrome="${src.nodeId}"] [data-testid="patch-panel-patch-to"]`)
    .click();
  const picker = page.locator('[data-testid="port-context-menu"]');
  await expect(picker).toBeVisible();
  await picker.locator(`[data-testid="patch-to-module"][data-node-id="${targetNodeId}"]`).click();
  await picker
    .locator(`[data-testid="patch-to-port"][data-port-id="${targetPortId}"][data-leg="${leg}"]`)
    .click();
}

const chooser = (page: Page) => page.getByTestId('stereo-drop-choice');

function chooserRow(page: Page, mode: 'left' | 'right' | 'both') {
  return chooser(page).locator(`[data-testid="stereo-drop-choice-option"][data-mode="${mode}"]`);
}

/** The modes the dialog is offering, in render order. */
async function offeredModes(page: Page): Promise<string[]> {
  return chooser(page)
    .locator('[data-testid="stereo-drop-choice-option"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-mode') ?? ''));
}

test.describe('a width-mismatched drop asks which channel', () => {
  // ---- MONO → STEREO. Three answers, three different graphs. The pre-owner
  // behaviour was the third one, silently, every time.

  test('mono → stereo: choosing L writes ONLY the L leg', async ({ page, rack }) => {
    await spawnRig(page);
    await dropConnect(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'cld', portId: 'in_l' });

    await expect(
      chooser(page),
      'a mono source on a stereo jack used to double-patch silently — this dialog is the fix',
    ).toBeVisible();
    // Nothing may be written while the question is open. A dialog that commits
    // first and asks second would pass every "the L leg exists" assertion.
    expect(await readEdges(page), 'no edge may exist before the user answers').toEqual([]);
    expect(await offeredModes(page)).toEqual(['left', 'right', 'both']);

    await chooserRow(page, 'left').click();
    await expect(chooser(page)).toHaveCount(0);
    await expectGraph(page, ['vco.saw -> cld.in_l']);
  });

  test('mono → stereo: choosing R writes ONLY the R leg', async ({ page, rack }) => {
    await spawnRig(page);
    // Dropped on in_l, answered R — so the answer, not the hole, decides. A
    // chooser that just kept the clicked leg would pass an in_r/R test and
    // fail this one.
    await dropConnect(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'cld', portId: 'in_l' });
    await chooserRow(page, 'right').click();
    await expectGraph(page, ['vco.saw -> cld.in_r']);
  });

  test('mono → stereo: choosing BOTH double-patches, as it always silently did', async ({
    page,
    rack,
  }) => {
    await spawnRig(page);
    await dropConnect(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'cld', portId: 'in_l' });
    await chooserRow(page, 'both').click();
    await expectGraph(page, ['vco.saw -> cld.in_l', 'vco.saw -> cld.in_r']);
  });

  // ---- STEREO → MONO. The owner asked for a CHANNEL, so there is no BOTH row
  // at all — this is the row of the matrix that used to write dual-mono.

  test('stereo → mono asks which channel, offers no BOTH, and writes ONE leg', async ({
    page,
    rack,
  }) => {
    await spawnRig(page);
    await dropConnect(page, { nodeId: 'cld', portId: 'out_l' }, { nodeId: 'flt', portId: 'audio' });

    await expect(chooser(page)).toBeVisible();
    await expect(chooser(page)).toHaveAttribute('data-kind', 'stereo-to-mono');
    expect(
      await offeredModes(page),
      'the owner asked which channel, not which width — dual-mono is not on offer',
    ).toEqual(['left', 'right']);

    await chooserRow(page, 'right').click();
    await expectGraph(page, ['cld.out_r -> flt.audio']);
  });

  test('stereo → mono: choosing L takes the OTHER source leg', async ({ page, rack }) => {
    await spawnRig(page);
    await dropConnect(page, { nodeId: 'cld', portId: 'out_l' }, { nodeId: 'flt', portId: 'audio' });
    await chooserRow(page, 'left').click();
    await expectGraph(page, ['cld.out_l -> flt.audio']);
  });

  // ---- THE ALREADY-PATCHED JACK. The measured bug: a second source dropped on
  // a collapsed stereo jack took BOTH legs of the live cable with no notice.

  test('an occupied jack says so, and per-row what it costs', async ({ page, rack }) => {
    await spawnRig(page);
    // A real, whole-stereo cable first, made through the same gesture.
    await dropConnect(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'cld', portId: 'in_l' });
    await chooserRow(page, 'both').click();
    await expectGraph(page, ['vco.saw -> cld.in_l', 'vco.saw -> cld.in_r']);

    // Now a SECOND source onto the same jack.
    await dropConnect(page, { nodeId: 'vco2', portId: 'saw' }, { nodeId: 'cld', portId: 'in_l' });
    await expect(
      chooser(page).getByTestId('stereo-drop-choice-occupied'),
      'the drop that used to destroy both legs in silence must announce itself',
    ).toBeVisible();
    // Every row here lands on an occupied leg, so every row is marked. The
    // per-row marking is what makes it a cost and not a banner.
    for (const mode of ['left', 'right', 'both'] as const) {
      await expect(chooserRow(page, mode)).toHaveAttribute('data-replaces', 'true');
    }

    // Choosing L takes ONLY the L leg — the R leg of the first cable survives.
    await chooserRow(page, 'left').click();
    await expectGraph(page, ['vco2.saw -> cld.in_l', 'vco.saw -> cld.in_r']);
  });

  test('a row landing on a FREE leg is not marked as destructive', async ({ page, rack }) => {
    await spawnRig(page);
    await dropConnect(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'cld', portId: 'in_l' });
    await chooserRow(page, 'left').click();
    await expectGraph(page, ['vco.saw -> cld.in_l']);

    await dropConnect(page, { nodeId: 'vco2', portId: 'saw' }, { nodeId: 'cld', portId: 'in_l' });
    await expect(chooserRow(page, 'left')).toHaveAttribute('data-replaces', 'true');
    await expect(
      chooserRow(page, 'right'),
      'R is empty — marking it would make the warning mean "this card has a cable somewhere"',
    ).toHaveAttribute('data-replaces', 'false');
  });

  // ---- CANCEL. Dismissing must ABANDON the patch. A dismissal that fell back
  // to a default would be the silent double-patch with a keystroke in front.

  test('Escape abandons the patch — no default, no edge', async ({ page, rack }) => {
    await spawnRig(page);
    await dropConnect(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'cld', portId: 'in_l' });
    await expect(chooser(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(chooser(page)).toHaveCount(0);
    // Give a wrong implementation time to write something.
    await expect.poll(async () => summarize(await readEdges(page)), { timeout: 1500 }).toEqual([]);
  });

  // ---- THE CARRY PATH. Same seam, different gesture — this is what proves the
  // chooser is a property of the commit and not of one entry point.

  test('the CARRY gesture asks too — same seam, different entry point', async ({ page, rack }) => {
    await spawnRig(page);
    // Pick the mono VCO output up off its jack row (a carry, not a drag)…
    await openPanel(page, 'vco', 'outputs');
    await panelRow(page, 'vco', 'saw').click();
    await page.mouse.move(600, 360);

    // …and drop it on the granular's COLLAPSED stereo input row by clicking it.
    // This is `patchpanel:carrycommit` → `commitCarriedEdge`, a completely
    // different function from the drag path's `handleConnect`.
    await openPanel(page, 'cld', 'inputs', { escape: false });
    await panelRow(page, 'cld', 'in_l').click();

    await expect(
      chooser(page),
      'the chooser must be a property of the COMMIT, not of one gesture',
    ).toBeVisible();
    expect(await readEdges(page)).toEqual([]);
    await chooserRow(page, 'right').click();
    await expectGraph(page, ['vco.saw -> cld.in_r']);
  });

  // ---- NEGATIVE CONTROLS. Each of these would ALSO pass if the chooser fired
  // on everything, so they are what keeps the positives meaningful.

  test('stereo → stereo and mono → mono never ask', async ({ page, rack }) => {
    await spawnRig(page);

    await dropConnect(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'flt', portId: 'audio' });
    await expect(chooser(page), 'mono → mono has one shape').toHaveCount(0);
    await expectGraph(page, ['vco.saw -> flt.audio']);

    await spawnPatch(page, [
      { id: 'vco', type: 'analogVco', position: { x: 80, y: 120 } },
      { id: 'cld', type: 'clouds', position: { x: 760, y: 120 } },
      { id: 'cld2', type: 'clouds', position: { x: 1240, y: 120 } },
    ]);
    await dropConnect(page, { nodeId: 'cld', portId: 'out_l' }, { nodeId: 'cld2', portId: 'in_l' });
    await expect(chooser(page), 'stereo → stereo is L→L / R→R with nothing to choose').toHaveCount(
      0,
    );
    await expectGraph(page, ['cld.out_l -> cld2.in_l', 'cld.out_r -> cld2.in_r']);
  });

  test('the PICKER answers mono → stereo in place, without a second dialog', async ({
    page,
    rack,
  }) => {
    await spawnRig(page);
    // The WHOLE-PAIR row (`data-leg=""`), which sits between its own L and R
    // rows. Clicking it IS the answer "both", so the dialog must stay away.
    await pickViaPicker(page, { nodeId: 'vco', portId: 'saw' }, 'cld', 'in_l', '');
    await expect(
      chooser(page),
      'the picker already offers pair / L / R — a second dialog would re-ask an answered question',
    ).toHaveCount(0);
    await expectGraph(page, ['vco.saw -> cld.in_l', 'vco.saw -> cld.in_r']);
  });

  test('the PICKER per-LEG row is explicit too, and raises no dialog', async ({ page, rack }) => {
    await spawnRig(page);
    // `data-leg="left"` must write ONE edge with no dialog, or the ES-9 return
    // gesture these rows were added for grows a second click.
    await pickViaPicker(page, { nodeId: 'vco', portId: 'saw' }, 'cld', 'in_l', 'left');
    await expect(chooser(page)).toHaveCount(0);
    await expectGraph(page, ['vco.saw -> cld.in_l']);
  });
});
