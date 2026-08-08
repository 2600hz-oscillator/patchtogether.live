// e2e/tests/es9-per-leg-patching.spec.ts
//
// RECONSTRUCT THE OWNER'S ES-9 SEND/RETURN RACK THROUGH REAL UI GESTURES.
//
// He had this patch saved and working. It still LOADS — every port it names
// exists. What was impossible was BUILDING or REPAIRING it: "recreating it
// right now is not possible though, and it needs to be trivial."
//
// THE EIGHT EDGES (decoded from his `es-9_sends.zip`):
//
//     mixmstrs.send1L → es9.out3        es9.in14 → mixmstrs.ret1L
//     mixmstrs.send1R → es9.out4        es9.in13 → mixmstrs.ret1R
//     mixmstrs.send2L → es9.out5        es9.in11 → mixmstrs.ret2L
//     mixmstrs.send2R → es9.out6        es9.in12 → mixmstrs.ret2R
//
// ⚠ THE RETURN MAPPING IS THE WHOLE POINT. `in14`→**L** with `in13`→**R** is
// REVERSED, and `in11`/`in12` is not adjacent to it. Those are physical holes on
// the front of a rack unit, chosen by hand. Any "spread L to the next adjacent
// point" convenience would silently swap his channels — explicitly rejected. So
// this spec asserts the edge set MATCHES EXACTLY, including which return lands
// on which side; a test that merely counted eight edges would pass with his
// channels crossed.
//
// ⚠ WHY THIS HAS TO BE AN E2E, and why the unit tests do not cover it.
// `planAudioCommit` ALREADY honoured `channelMode` before this work — measured
// on the real defs, not assumed. The bug was that **no UI gesture could ever
// set it for a mono source**: the picker's "patch only L / only R" rows require
// the SOURCE to carry a stereo image, and an ES-9 jack is a mono point. A unit
// test that calls the planner directly is structurally blind to a menu that
// never offers the choice. So the subject here is the GESTURE, and the verdict
// is the resulting EDGE SET.
//
// ⚠ AND IT ASSERTS THE COUNT, NOT JUST PRESENCE. Offering a per-side menu item
// while the planner writes both legs anyway is the failure this repo names the
// backdraft class — "an edge appeared" cannot see it. Every expectation below
// is a full, sorted, exact-equality comparison of the whole edge set.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';

const ES9 = 'es9';
const MIX = 'mix';

/** THE EIGHT, in the sorted form `readEdges` returns. */
const EIGHT_EDGES = [
  'es9.in11->mix.ret2L',
  'es9.in12->mix.ret2R',
  'es9.in13->mix.ret1R',
  'es9.in14->mix.ret1L',
  'mix.send1L->es9.out3',
  'mix.send1R->es9.out4',
  'mix.send2L->es9.out5',
  'mix.send2R->es9.out6',
];

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

/** Every edge in the live graph as `srcNode.srcPort->dstNode.dstPort`, sorted.
 *  Read off the store rather than the DOM: a stereo leg group draws ONE bezier
 *  for two edges, so counting cables would systematically under-report exactly
 *  the thing under test. */
async function readEdges(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __patch: {
        edges: Record<
          string,
          | {
              source: { nodeId: string; portId: string };
              target: { nodeId: string; portId: string };
            }
          | undefined
        >;
      };
    };
    return Object.values(w.__patch.edges)
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => `${e.source.nodeId}.${e.source.portId}->${e.target.nodeId}.${e.target.portId}`)
      .sort();
  });
}

/** ES-9 + MIXMSTRS on an empty rack. Nothing is pre-wired: every edge this
 *  spec asserts has to come out of a gesture, or it is not evidence. */
async function spawnRig(page: Page) {
  await spawnPatch(page, [
    { id: ES9, type: 'es9', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: MIX, type: 'mixmstrs', position: { x: 900, y: 80 }, domain: 'audio' },
  ]);
  await expect(page.locator(`.svelte-flow__node[data-id="${ES9}"]`)).toBeVisible();
  await expect(page.locator(`.svelte-flow__node[data-id="${MIX}"]`)).toBeVisible();
}

/**
 * RIGHT-CLICK AN OUTPUT ROW → the patch picker. The owner's own words for the
 * gesture he expected: "when i right click the output i expect the option?"
 *
 * ⚠ RESET TO A KNOWN STATE FIRST. Two things persist between calls and each one
 * hangs this helper in turn: the patch trigger TOGGLES (a second click closes
 * the chrome), and the panel remembers its DRILL VIEW (so the chrome can be
 * open on a port list where the root nav row does not exist). Escape closes it
 * outright, so every call walks the same path — deterministic rather than
 * state-sniffing. Lifted from the same pattern in stereo-only-channel.spec.ts.
 */
async function rightClickOutput(page: Page, nodeId: string, portId: string) {
  await page.keyboard.press('Escape');
  await expect(chrome(page, nodeId)).toHaveCount(0);
  await page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`).click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
  await chrome(page, nodeId).locator('[data-testid="patch-panel-nav"][data-nav="outputs"]').click();
  const row = chrome(page, nodeId).locator(
    `[data-testid="patch-panel-port-row"][data-port-id="${portId}"]`,
  );
  await expect(row, `${nodeId}.${portId} must be a right-clickable output row`).toBeVisible();
  await row.click({ button: 'right' });

  // ⚠ AN ALREADY-PATCHED POINT OPENS THE UNPATCH MENU FIRST — that precedence
  // is deliberate and unchanged. The route on from there is its "Patch to…"
  // row, which exists because an OUTPUT fans out: the owner's two aux sends
  // leave the SAME collapsed SEND1 jack for two different ES-9 outputs, so the
  // second one is reached from a jack that already has a cable on it.
  const unpatch = page.locator('[data-testid="unpatch-menu"]');
  if (await unpatch.isVisible().catch(() => false)) {
    const patchTo = unpatch.getByTestId('unpatch-patch-to');
    await expect(
      patchTo,
      `${nodeId}.${portId} already has a cable, so the unpatch menu claims the ` +
        `right-click — it must still offer "Patch to…" or the jack can never ` +
        `carry a second cable`,
    ).toBeVisible();
    await patchTo.click();
  }

  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(
    menu,
    `right-clicking ${nodeId}.${portId} must reach the patch picker — this is the ` +
      `gesture the owner reached for, and on a MONO output it used to do nothing at all`,
  ).toBeVisible();
  return menu;
}

/** Pick the destination inside an open picker and commit. `leg` selects one
 *  side of a collapsed stereo target ("RET1 L"); omit it for a plain jack. */
async function pickTarget(
  page: Page,
  menu: ReturnType<Page['locator']>,
  nodeId: string,
  portId: string,
  leg?: 'left' | 'right',
) {
  await menu.locator(`[data-testid="patch-to-module"][data-node-id="${nodeId}"]`).click();
  const row = menu.locator(
    `[data-testid="patch-to-port"][data-port-id="${portId}"][data-leg="${leg ?? ''}"]`,
  );
  await expect(
    row,
    `the picker must offer ${nodeId}.${portId}${leg ? ` (${leg} leg)` : ''} as its own row`,
  ).toBeVisible();
  await row.click();
  await expect(menu).toHaveCount(0);
}

test.describe('ES-9 per-leg patching — the owner\'s send/return rack', () => {
  test('all EIGHT edges are reconstructible through real UI gestures, exactly', async ({
    page,
    rack,
  }) => {
    await spawnRig(page);

    // ---- THE SENDS: a STEREO source, one leg at a time, into two separate
    // hardware jacks. The channel rows appear because `send1L`/`send1R` IS a
    // derived pair, so the collapsed SEND1 jack has a side to take.
    for (const [src, mode, dst] of [
      ['send1L', 'left', 'out3'],
      ['send1L', 'right', 'out4'],
      ['send2L', 'left', 'out5'],
      ['send2L', 'right', 'out6'],
    ] as const) {
      const menu = await rightClickOutput(page, MIX, src);
      const modes = menu.locator('[data-testid="patch-channel-mode"]');
      await expect(
        modes,
        `${src} is half of a derived pair, so the picker must offer stereo/L/R — ` +
          `without the rows the click below is a no-op and the test would measure ` +
          `the stereo case while claiming to measure only-${mode}`,
      ).toHaveCount(3);
      await menu.locator(`[data-testid="patch-channel-mode"][data-mode="${mode}"]`).click();
      await expect(
        menu.locator(`[data-testid="patch-channel-mode"][data-mode="${mode}"]`),
      ).toHaveAttribute('data-selected', 'true');
      await pickTarget(page, menu, ES9, dst);
    }

    // ---- THE RETURNS: a MONO source into one named side of a collapsed
    // stereo target. This is the half that had no gesture at all.
    for (const [src, pairPort, leg] of [
      ['in14', 'ret1L', 'left'],
      ['in13', 'ret1L', 'right'],
      ['in11', 'ret2L', 'left'],
      ['in12', 'ret2L', 'right'],
    ] as const) {
      const menu = await rightClickOutput(page, ES9, src);
      // A mono hardware point has NO side of its own, so the source-side rows
      // must be absent — the side is named on the TARGET instead. Asserting
      // their absence keeps the two controls' scopes honest.
      await expect(
        menu.locator('[data-testid="patch-channel-mode"]'),
        `es9.${src} is a mono point — it has no stereo image to take a side of`,
      ).toHaveCount(0);
      await pickTarget(page, menu, MIX, pairPort, leg);
    }

    // THE VERDICT. Exact set equality — not a count, not a subset. If a
    // per-side gesture ever writes both legs again, the extra edge shows up
    // here; if the return mapping is ever "helpfully" straightened, the
    // in13/in14 rows swap and this fails too.
    await expect
      .poll(() => readEdges(page), {
        timeout: 5000,
        message:
          'the reconstructed rack must match the owner\'s saved patch edge for edge, ' +
          'including in14→ret1L with in13→ret1R (REVERSED, and deliberately so)',
      })
      .toEqual(EIGHT_EDGES);
  });

  test('the picker DRILLS a collapsed stereo target into its L and R', async ({ page, rack }) => {
    // The affordance itself, asserted where a human would look for it — no
    // modifier key, no drag, just the rows. "Trivial" is the acceptance bar.
    await spawnRig(page);
    const menu = await rightClickOutput(page, ES9, 'in14');
    await menu.locator(`[data-testid="patch-to-module"][data-node-id="${MIX}"]`).click();

    const ret1 = menu.locator('[data-testid="patch-to-port"][data-port-id="ret1L"]');
    await expect(ret1, 'RET1 must offer three rows: the pair, its L, its R').toHaveCount(3);
    await expect(ret1.and(page.locator('[data-leg=""]'))).toHaveCount(1);
    await expect(ret1.and(page.locator('[data-leg="left"]'))).toHaveCount(1);
    await expect(ret1.and(page.locator('[data-leg="right"]'))).toHaveCount(1);
    // The labels have to SAY which is which — three rows the user cannot tell
    // apart is not a discoverable gesture.
    await expect(ret1.and(page.locator('[data-leg="left"]'))).toHaveText(/\bL$/);
    await expect(ret1.and(page.locator('[data-leg="right"]'))).toHaveText(/\bR$/);
  });

  test('an UNPAIRED target is a single row — the drill-down does not fire everywhere', async ({
    page,
    rack,
  }) => {
    // Scope control. Without it, "RET1 has three rows" would be untested for
    // the case where there must be ONE, and a blanket 3× expansion of every
    // target port would satisfy the test above.
    await spawnRig(page);
    const menu = await rightClickOutput(page, MIX, 'send1L');
    await menu.locator(`[data-testid="patch-to-module"][data-node-id="${ES9}"]`).click();
    const out3 = menu.locator('[data-testid="patch-to-port"][data-port-id="out3"]');
    await expect(out3, 'es9.out3 is one physical jack, not a pair').toHaveCount(1);
    await expect(out3).toHaveAttribute('data-leg', '');
  });

  test('a STEREO patch into ONE ES-9 jack writes ONE edge, not two summed into it', async ({
    page,
    rack,
  }) => {
    // ES-9 audio ports are independent PHYSICAL JACKS (owner: "explicitly mono
    // channels when used for audio and it's in hardware"). The dual-mono rule —
    // "stereo → mono writes BOTH legs into the mono input" — would put send1L
    // AND send1R into out3, i.e. two signals summing into one hardware output.
    //
    // The gesture is deliberately the DEFAULT one: the stereo row is already
    // selected, so this is what a user gets without choosing anything.
    await spawnRig(page);
    const menu = await rightClickOutput(page, MIX, 'send1L');
    await expect(
      menu.locator('[data-testid="patch-channel-mode"][data-mode="both"]'),
      'stereo is the default selection — this test is about the UNCHOSEN path',
    ).toHaveAttribute('data-selected', 'true');
    await pickTarget(page, menu, ES9, 'out3');

    await expect
      .poll(() => readEdges(page), {
        timeout: 5000,
        message: 'two legs must never sum into one ES-9 point',
      })
      .toEqual(['mix.send1L->es9.out3']);
  });

  test('NEGATIVE CONTROL: the same stereo gesture into a non-hardware target still writes BOTH legs', async ({
    page,
    rack,
  }) => {
    // Without this, the ES-9 test above would pass just as well if dual-mono
    // had been deleted outright, and the hardware rule would be
    // indistinguishable from a global behaviour change. `vca.audio` is an
    // ordinary mono audio input.
    await spawnPatch(page, [
      { id: MIX, type: 'mixmstrs', position: { x: 80, y: 80 }, domain: 'audio' },
      { id: 'vca1', type: 'vca', position: { x: 900, y: 80 }, domain: 'audio' },
    ]);
    const menu = await rightClickOutput(page, MIX, 'send1L');
    await pickTarget(page, menu, 'vca1', 'audio');

    await expect
      .poll(() => readEdges(page), { timeout: 5000 })
      .toEqual(['mix.send1L->vca1.audio', 'mix.send1R->vca1.audio']);
  });

  test('UNPATCH takes only the cable you picked — the two returns are independent', async ({
    page,
    rack,
  }) => {
    // ⚠ THE REGRESSION THIS GUARDS. `ret1L` and `ret1R` are the two halves of
    // one stereo input, so leg-group deletion could plausibly treat the cables
    // on them as one cable. They are NOT: they come from DIFFERENT ES-9 jacks
    // (in14 and in13), which is precisely the owner's hand-chosen wiring.
    // Co-deleting them would silently remove a cable he did not select.
    await spawnRig(page);
    for (const [src, pairPort, leg] of [
      ['in14', 'ret1L', 'left'],
      ['in13', 'ret1L', 'right'],
    ] as const) {
      const menu = await rightClickOutput(page, ES9, src);
      await pickTarget(page, menu, MIX, pairPort, leg);
    }
    await expect
      .poll(() => readEdges(page), { timeout: 5000 })
      .toEqual(['es9.in13->mix.ret1R', 'es9.in14->mix.ret1L']);

    // Right-click the PATCHED ret1L point → the unpatch menu → remove that one.
    await page.keyboard.press('Escape');
    await expect(chrome(page, MIX)).toHaveCount(0);
    await page.locator(`.svelte-flow__node[data-id="${MIX}"] [data-testid="patch-trigger"]`).click();
    await expect(chrome(page, MIX)).toHaveAttribute('aria-hidden', 'false');
    await chrome(page, MIX)
      .locator('[data-testid="patch-panel-section-nav"][data-section-label="Ret1"]')
      .click();
    await chrome(page, MIX)
      .locator('[data-testid="patch-panel-port-row"][data-port-id="ret1L"]')
      .click({ button: 'right' });
    const unpatch = page.locator('[data-testid="unpatch-menu"]');
    await expect(unpatch).toBeVisible();
    // ONE row: the menu is built for the LEG the user right-clicked (`ret1L`),
    // and the other cable sits on `ret1R`. That is the load-bearing fact —
    // these are two independent cables, not one stereo cable, because they come
    // from two different ES-9 jacks. If they were grouped, this row would
    // remove both.
    const items = unpatch.getByTestId('unpatch-item');
    await expect(
      items,
      'the in14→ret1L cable must be its own removable cable, not half of a group',
    ).toHaveCount(1);
    await expect(items).toContainText('IN14');
    await items.click();

    await expect
      .poll(() => readEdges(page), {
        timeout: 5000,
        message:
          'removing the in14 cable must leave the in13 cable on ret1R alone — ' +
          'co-deleting it would silently drop a cable the user did not select',
      })
      .toEqual(['es9.in13->mix.ret1R']);
  });
});
