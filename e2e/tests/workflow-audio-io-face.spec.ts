// e2e/tests/workflow-audio-io-face.spec.ts
//
// THE 🎧 AUDIO-I/O PANEL, ON THE DEFAULT SHELL — the arm a promotion moves.
//
// ── WHY THIS FILE EXISTS, WHICH IS THE FINDING ─────────────────────────────
//
// A dock-rail occupant used to CHOOSE between its promoted faceplate and its
// pre-promotion surface. `AudioIoSurface.svelte` — which hosts the pinned AUDIO
// IN and AUDIO OUT through the same `DockCardHost` the dock rails use — never
// asked. Both mounts passed six props and no `face`, so the host's
// `face = false` default won and it mounted
// `nodeTypes[node.type]` unconditionally.
//
// That matters more here than anywhere else, because of what those two nodes
// are. `legacy-fallback.ts`'s own header states it:
//
//   *"a PINNED occupant is canvas-hidden (`isCanvasHiddenNode`), so it has NO
//   lane tile, NO EXPAND pill and no route to `DockFullView`. The tray is its
//   ONLY surface, and it is therefore the only place its face can appear."*
//
// `pinned-audioIn` / `pinned-audioOut` are exactly that, and this panel is
// their tray. Promoting either module without the prop would have merged green
// and changed nothing a normal user can reach: the ADDED-on-canvas instance
// would get a face, and the pinned one — the one `workflow-pins.ts` spawns into
// every rackspace, the one every user has in every session — would keep the old
// surface forever.
//
// ── AND THE PANEL'S OWN WATCHER COULD NOT SEE IT ───────────────────────────
//
// `e2e/vrt/workflow-audio-io-composite.spec.ts` is the scene written for this
// exact surface, for the owner-reported class *"this should have been caught
// with vrt analysis"*. It was written against the PRE-INVERSION renderer, under
// which the panel's own rule was false **even with the prop threaded** — so
// that scene could never show a face in this panel, before or after the fix.
//
// `legacy-fallback.ts:200-204` already records this exact shape for the
// NEIGHBOURING surface — *"the three shipped drawer specs cannot see this
// change … New coverage for the `true` arm must drive the DEFAULT shell"* —
// and prescribes `workflow-drawer-face.spec.ts`. This file is that prescription
// applied to the audio-I/O panel, which had the identical condition and no such
// warning.
//
// ── WHAT IT ASSERTS, AND WHY IT IS NOT A TYPED EXPECTATION ─────────────────
//
// Nothing here names a surface by hand. It says: EACH OCCUPANT RENDERS WHAT
// ITS MIGRATION SAYS IT SHOULD, with the migration read off the registry
// manifest's own `strictFace` — the same
// property `migrated()` keys on (`STRICT_FACES` is "every def that declares a
// `face`", asserted both ways in the unit lane).
//
// On the day this landed both occupants were un-migrated, and the two-armed
// shape was what made it the leg that MOVED when either was promoted: a
// promotion that failed to reach the pinned instance was a red test rather than
// a silent no-op. Both are migrated now, so the branch is gone and the
// migration is ASSERTED instead — a demotion has to say so by name rather than
// quietly take the other arm.
//
// ⚠ THE FACE ARM IS STILL EXERCISED FROM A SECOND DIRECTION — by the POSITIVE
// control at the end of the first test, which drives the SAME `DockCardHost`
// through the drawer rather than the panel, on the SAME kind of occupant (a pinned,
// canvas-hidden singleton) that IS migrated today. Without it, "the face arm
// renders a face" would be an untested claim in a file whose whole subject is
// the face arm.
//
// ── WHAT THIS SPEC STRUCTURALLY CANNOT SEE ────────────────────────────────
//
//   * PIXELS. The only baseline over this panel is the one named above; there
//     is deliberately no shipping-shell capture, because a
//     page-level shot of `/rack` includes the seeded video zone painting live
//     faceplate glyphs (the enumerated VRT-entropy class), and `?seed=none` —
//     which would make it deterministic — suppresses the pinned ensure at
//     `Canvas.svelte`, so the panel would have no occupants to photograph.
//   * AUDIO IN's `getUserMedia` lifecycle. This file never grants, denies or
//     asserts a capture; it only asserts which COMPONENT is mounted, which is
//     capability-independent by construction.

import { test, expect, type Page } from '@playwright/test';
import { REGISTRY } from './_registry';
import { canvasPane } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// Cold boot on the DEFAULT shell (faceplates + the seeded video zone) is the
// slowest goto in the suite; the flat 30 s default is the #1875 lottery. A
// bound, not an assertion — see ../_helpers/boot-budget.ts.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

/** The panel's two columns: the pinned node `workflow-pins.ts` spawns and the
 *  host testid `AudioIoSurface` stamps.
 *
 *  ⚠ EACH ROW CARRIED A `legacyOnly` TESTID and it is gone with its subject.
 *  The pair was `audioin-device-select` / `audioout-device-select` — ids the
 *  pre-promotion surfaces emitted and `AudioInSourceControls.svelte` still
 *  refuses BY NAME, so "the old arm rendered" could be stated positively rather
 *  than as the absence of a shell. Nothing emits either id now, so asserting
 *  their absence would be true of a host that rendered NOTHING. The migration
 *  assertion below is the anchor instead. */
const OCCUPANTS = [
  { type: 'audioIn', nodeId: 'pinned-audioIn', host: 'workflow-io-audioin-host' },
  { type: 'audioOut', nodeId: 'pinned-audioOut', host: 'workflow-io-audioout-host' },
] as const;

/**
 * The POSITIVE control's subject. `pinned-mixmstrs` is the drawer's pinned
 * singleton — the same occupant CLASS as the two above (canvas-hidden, tray is
 * its only surface, `pinned: true`) and the same `DockCardHost` `face` branch —
 * and it is migrated, so it is the one place this file can watch the arm it
 * exists to protect actually render.
 *
 * NAMED, with its precondition asserted loudly rather than assumed: if
 * mixmstrs ever stops being migrated this file must say so by name instead of
 * quietly losing its only face-arm leg.
 */
const FACE_CONTROL = {
  type: 'mixmstrs',
  nodeId: 'pinned-mixmstrs',
  why: 'the drawer’s pinned singleton — same occupant class, same DockCardHost face branch, and migrated today',
} as const;

/** MIGRATED, read off the artifact rather than typed here. `strictFace` is
 *  emitted from the def's own curated `face`, which is exactly what
 *  `STRICT_FACES` — and therefore `migrated()`, and therefore
 *  `dockRailRendersFace` — keys on. */
function isFaced(type: string): boolean {
  const mod = REGISTRY.find((m) => m.type === type);
  if (!mod) {
    throw new Error(
      `workflow-audio-io-face: '${type}' is not in the registry manifest. Either the module was ` +
        `renamed (fix this list) or the manifest is stale (flox activate -- task test:emit-manifest).`,
    );
  }
  return mod.strictFace === true;
}

/** Page errors + console errors, minus the audio/getUserMedia noise a headless
 *  runner with no microphone produces on this panel by design (the same filter
 *  the composite VRT scene applies). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}
function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !/getUserMedia|audio|mediaDevices|permission/i.test(e));
}

/** THE DEFAULT SHELL — no `shell` query at all. That is the whole file. */
async function gotoDefaultShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await canvasPane(page).waitFor({ state: 'visible', timeout: BOOT_MS });
}

/** Wait until the workflow ensure has written the pinned nodes this file reads. */
async function waitForPins(page: Page, ids: readonly string[]): Promise<void> {
  await page.waitForFunction(
    (wanted) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return wanted.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
    },
    [...ids],
    { timeout: BOOT_MS },
  );
}

/** Open the 🎧 panel and return it. */
async function openAudioIoPanel(page: Page) {
  await page.getByTestId('workflow-topbar-slot-audio-io').click();
  const panel = page.getByTestId('workflow-io-panel');
  await expect(panel).toHaveAttribute('data-open', 'true');
  return panel;
}

test.describe('workflow · the 🎧 audio-I/O panel honours the migration rule (default shell)', () => {
  test('each hosted occupant renders the surface its MIGRATION says it should', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await gotoDefaultShell(page);
    await waitForPins(page, [...OCCUPANTS.map((o) => o.nodeId), FACE_CONTROL.nodeId]);
    const panel = await openAudioIoPanel(page);

    for (const occ of OCCUPANTS) {
      const host = panel.getByTestId(occ.host);
      await expect(host, `${occ.type}: the panel must host it at all`).toBeVisible();
      const card = host.locator(`[data-dock-card="${occ.nodeId}"]`);
      await expect(card, `${occ.type}: DockCardHost must mount the pinned node`).toBeVisible();

      const shell = card.locator('[data-testid="module-shell"]');

      // ⚠ THE MIGRATION IS ASSERTED, NOT BRANCHED ON. This loop used to pick an
      // arm from `isFaced(occ.type)`, which made a DEMOTION indistinguishable
      // from a pass: the un-migrated arm would simply have run instead. Both
      // occupants are migrated and the panel is their only surface, so the
      // honest shape is a claim.
      expect(
        isFaced(occ.type),
        `${occ.type} is no longer in STRICT_FACES. This panel is its ONLY surface, so a demotion ` +
          `deletes the module for every workflow user — fix the demotion, do not re-branch here.`,
      ).toBe(true);

      // `view='drawer'` specifically — a shell that fell back to the lane view
      // would still be "a module-shell" while painting a fraction of the
      // faceplate.
      await expect(
        shell,
        `${occ.type} declares a curated face, so this panel — its ONLY surface — must render it`,
      ).toBeVisible();
      await expect(shell).toHaveAttribute('data-shell-type', occ.type);
      await expect(shell).toHaveAttribute('data-shell-view', 'drawer');
    }

    // ── POSITIVE CONTROL: the face arm of this very rule, on this very host ──
    //
    // A THIRD occupant of the same class (pinned, canvas-hidden), reached
    // through a DIFFERENT route — the `m` drawer rather than the 🎧 panel — so
    // this file still fails if the shared host stops rendering faceplates for a
    // reason specific to one panel's plumbing rather than to the host.
    expect(
      isFaced(FACE_CONTROL.type),
      `the face-arm control is '${FACE_CONTROL.type}' (${FACE_CONTROL.why}). It is no longer ` +
        `migrated, so this file has lost its only leg that exercises the face arm — pick another ` +
        `PINNED migrated occupant rather than deleting the control.`,
    ).toBe(true);

    // Close the 🎧 menu, then open the pinned drawer with its keymap.
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    await expect(panel).toHaveAttribute('data-open', 'false');
    // (500,560): the old (500,380) lands on slot-repacked zone chrome
    // (SYNESTHESIA's patch-trigger) and opens a PatchPanel as a side effect —
    // see workflow-drawer-face `openTray`.
    await canvasPane(page).click({ position: { x: 500, y: 560 } });
    await page.keyboard.press('m');
    const drawer = page.getByTestId('dock-zone-bottom');
    await expect(drawer).toBeVisible();
    const controlCard = drawer.locator(`[data-dock-card="${FACE_CONTROL.nodeId}"]`);
    await expect(controlCard).toBeVisible();
    const controlShell = controlCard.locator('[data-testid="module-shell"]');
    await expect(
      controlShell,
      `POSITIVE CONTROL: a pinned MIGRATED occupant must render its face through DockCardHost, ` +
        `reached from the drawer rather than from the 🎧 panel.`,
    ).toBeVisible();
    await expect(controlShell).toHaveAttribute('data-shell-view', 'drawer');

    expect(realErrors(errors), `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('AUDIO OUT keeps its "receive from" source picker on the DEFAULT shell', async ({ page }) => {
    // §2.2 of the build spec: the receive rows are the PANEL's own markup,
    // outside `DockCardHost`, derived from the live def through the same
    // `collapseStereoPorts` the PatchPanel uses — so promotion must not touch
    // them in either direction. The shipped assertion for this
    // (`audio-in.spec.ts`, "the pinned AUDIO OUT exposes a source picker") was
    // written against the PRE-PROMOTION renderer, i.e. an arm promotion never
    // moves. It proves nothing about the surface this PR changes; this is that
    // same claim on the arm that does move.
    const errors = collectErrors(page);
    await gotoDefaultShell(page);
    await waitForPins(page, [...OCCUPANTS.map((o) => o.nodeId)]);
    const panel = await openAudioIoPanel(page);

    const rows = panel.getByTestId('workflow-io-patchin');
    await expect(rows, 'the pinned AUDIO OUT must offer a discoverable source pick').toBeVisible();
    // ONE row, not two: `L`/`R` are a derived stereo pair and collapse to a
    // single row addressed to the LEFT leg (the commit writes both legs).
    // Asserting R's ABSENCE keeps a regression that re-splits the pair red.
    await expect(panel.getByTestId('workflow-io-patchin-L')).toBeVisible();
    await expect(panel.getByTestId('workflow-io-patchin-R')).toHaveCount(0);
    await expect(panel.getByTestId('workflow-io-patchin-L')).toHaveAttribute(
      'data-stereo-sibling',
      'R',
    );

    // And it still REACHES the picker — the affordance, not just the markup.
    await panel.getByTestId('workflow-io-patchin-L').click();
    await expect(page.getByTestId('port-context-menu')).toBeVisible({ timeout: BOOT_MS });

    expect(realErrors(errors), `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });
});
