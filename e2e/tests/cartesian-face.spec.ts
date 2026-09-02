// e2e/tests/cartesian-face.spec.ts
//
// THE TYPED-ENTRY PROOF (#1509) — cartesian's faceplate, driven by TYPING.
//
// ⚠ WHY THIS SPEC EXISTS RATHER THAN A faces-parity ROW. cartesian reaches the
// `TextEntry` primitive through a PF-14 PANEL (its 4×4 pad grid), and
// faces-parity drives a panel by its declared click/drag probe — it cannot type.
// So the panel's probe asserts a GATE click moves `node.data.cells`, and the
// TYPED half is here. The `entry` ShellCell wrapper has no faces-parity sweep
// adopter yet.
//
// ⚠ THE PREDICTION THAT USED TO END THAT SENTENCE IS NOW WRONG, and it is
// corrected rather than left to be inherited: it said the first adopter would be
// "a band-shaped field (recorderbox's filename, once #1511 deletes
// `needs-media-controller`)". recorderbox IS promoted now and its blocker is
// gone — and its FILE field is deliberately NOT a `ShellEntryCell`. That kind
// forbids clamping, while the shipped save path SANITIZES
// (`recorderbox-store.sanitizeRecordingFilename`), so an entry cell's rejections
// would disagree with the name actually written to disk. A refusal the model
// then silently overrides is the exact class leg 2 below exists to catch, which
// is why that module keeps a real `<input type="text">` in its extension body.
// So this spec remains the ONLY typed-entry proof, and is not waiting on a
// sweep adopter that is not coming from there.
//
// ⚠ IT BOOTS THE LANE'S OWN WAY, NOT `bootWithFace`, AND THAT IS A FIX RATHER
// THAN A PREFERENCE. The first version imported `bootWithFace` /
// `unfoldDockPane` from `e2e/vrt/_shell-faces.ts`. Those are budgeted by the VRT
// config (which sets generous per-scene timeouts via `faceSceneTimeout`); this
// lane's default is 30 s for the WHOLE test. MEASURED: it passed locally in ~5 s
// and 10/10 under `E2E_SWIFTSHADER=1`, then timed out on CI shard 9/10 and
// PASSED ON RETRY — i.e. it lost the runner lottery under ten parallel shards,
// which is a RED here (a recovered flake fails the job). The reported error was
// `locator.blur: Test timeout of 30000ms exceeded`, which names what it was
// doing when the budget expired, NOT a broken call — the expensive part was the
// boot. `gotoWorkflow` + `spawnPatch` + `__openDockFullView` is what every other
// dock spec in this directory uses, is CI-validated at these budgets, and skips
// the VRT font-pinning / frame-settling / audio-freeze machinery this test does
// not need.
//
// ⚠ THE THREE LEGS ARE PERMANENT, NOT SCAFFOLDING, and the middle one is the
// entire argument for the parse contract's shape:
//
//   1. a valid note COMMITS               — the cell is live at all;
//   2. a REFUSED note writes NOTHING      — not clamped to the nearest legal
//      value, not rounded, not partially applied. This is the backdraft class
//      (a control writing what the contract forbids while the model quietly
//      corrects it, with every def-reading gate blind) asserted as an ABSENCE
//      OF CHANGE, which is the only way to see it;
//   3. clearing the box is a REST         — an ACCEPTED value whose stored form
//      is `null`. Under the obvious `(text) => T | null` validator signature
//      this is indistinguishable from a refusal, and the safe reading would
//      make the rest UNREACHABLE from the faceplate while the legacy card still
//      offered it — a silent functional-parity loss inside the cell built to
//      prevent silent parity losses. That is why `EntryParse` is a tagged union.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

test.describe.configure({ mode: 'parallel' });

// ⚠ THIS FILE DECLARED NO BUDGET AND RODE THE INVISIBLE 30 s DEFAULT, which is
// the failure its own header above already describes once ("timed out on CI
// shard 9/10 and PASSED ON RETRY — it lost the runner lottery"). That round was
// answered by making the boot CHEAPER; this one could not be, because nothing
// about the spec changed. It lost the lottery again when a cost-artifact re-pin
// re-binned the shards and moved it, with a MEASURED cost of 17.6 CPU-s against a
// 30 s ceiling — twelve seconds of headroom on a lane whose whole design is that
// shard membership moves.
//
// ⚠ NOT A FLAT BUMP. The number is the ONE export site every other dock spec in
// this directory uses, so it tracks the lane's own slow-boot budget instead of
// becoming a second opinion about it — and it BOUNDS the failure rather than
// gating anything: every wait below is still an auto-retrying assertion on the
// real subject.
test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

const NODE = 'cart';

/** The same 15 s FIRST-LOAD budget `workflow-rear-card` and `workflow-shell`
 *  use for this route: SvelteKit dev compiles `/rack` on demand, and only the
 *  first navigation of a run pays it. A budget that bounds the failure, never a
 *  gate — a real regression still fails, just later. */
async function gotoWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open the node's dock full-view through the shipped hook the EXPAND button
 *  calls — the idiom every other dock spec in this directory uses. */
async function openFace(page: Page, nodeId: string) {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
  );
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
    nodeId,
  );
  const pane = page.locator(`[data-testid="dock-full-view"][data-fullview-node="${nodeId}"]`);
  await expect(pane).toBeVisible();
  return pane;
}

/** Pad `i`'s stored MIDI value, read straight off the live graph. */
function padMidi(page: Page, nodeId: string, i = 0) {
  return page.evaluate(
    ({ id, idx }) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<string, { data?: { cells?: Array<{ midi: number | null }> } }>;
        };
      };
      return w.__patch.nodes[id]?.data?.cells?.[idx]?.midi ?? null;
    },
    { id: nodeId, idx: i },
  );
}

test('cartesian face: a typed note reaches the graph, a REFUSED one does not, and empty is a REST', async ({
  page,
}) => {
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: NODE, type: 'cartesian', position: { x: 460, y: 240 } }]);
  const pane = await openFace(page, NODE);

  // ⚠ SCOPED TO THE PANE. The same grid paints in the lane tile too, so an
  // unscoped locator is a strict-mode violation rather than a defect.
  const field = pane.locator('[data-testid="cart-face-pitch-0"]');
  await expect(field, 'the pad grid paints a writable note box on the FACE').toBeVisible();
  await expect(field, 'and it is not a disabled readout').toBeEnabled();

  // ── LEG 1 · a valid note COMMITS ────────────────────────────────────────
  await field.fill('c#3');
  await field.blur();
  await expect
    .poll(() => padMidi(page, NODE), {
      message: 'typing c#3 into the faceplate commits MIDI 49 into node.data.cells[0]',
    })
    .toBe(49);
  await expect(field, 'and the box shows the canonical spelling back').toHaveValue('c#3');

  // ── LEG 2 · a REFUSED note writes NOTHING ───────────────────────────────
  // `c9` is note-SHAPED and out of the module's declared c0..c8 span, so it
  // proves the RANGE check runs — `zzz` would only prove the grammar does.
  await field.fill('c9');
  await field.blur();
  await expect
    .poll(() => padMidi(page, NODE), {
      message:
        'a refused note must leave the pad EXACTLY as it was — no clamp to c8, no rounding, ' +
        'no partial write',
    })
    .toBe(49);
  await expect(field, 'and the box reverts rather than keeping the refused text').toHaveValue('c#3');

  // ── LEG 3 · clearing is a REST, not a refusal ───────────────────────────
  await field.fill('');
  await field.blur();
  await expect
    .poll(() => padMidi(page, NODE), {
      message: 'clearing the box commits a REST (midi null) — an accepted value, not a rejection',
    })
    .toBe(null);
});

test('cartesian face: the pad grid writes gate and chord through the same node.data key', async ({
  page,
}) => {
  // The panel's other two affordances, which promotion would otherwise have
  // deleted with the card. Asserted here rather than trusted to the panel probe:
  // faces-parity drives ONE declared probe (the gate), so the chord badge has no
  // other coverage.
  await gotoWorkflow(page);
  await spawnPatch(page, [{ id: NODE, type: 'cartesian', position: { x: 460, y: 240 } }]);
  const pane = await openFace(page, NODE);

  const readCell = () =>
    page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<string, { data?: { cells?: Array<{ on: boolean; chord?: string }> } }>;
        };
      };
      const c = w.__patch.nodes[id]?.data?.cells?.[1];
      return { on: c?.on ?? false, chord: c?.chord ?? 'mono' };
    }, NODE);

  const before = await readCell();
  await pane.locator('[data-testid="cart-face-gate-1"]').click();
  await expect
    .poll(async () => (await readCell()).on, { message: 'the gate button lights the pad' })
    .toBe(!before.on);

  await pane.locator('[data-testid="cart-face-chord-1"]').click();
  await expect
    .poll(async () => (await readCell()).chord, {
      message: 'the chord badge CYCLES, matching the card gesture rather than opening a dropdown',
    })
    .not.toBe(before.chord);
});
