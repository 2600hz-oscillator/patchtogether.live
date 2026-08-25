// e2e/tests/cartesian-face.spec.ts
//
// THE TYPED-ENTRY PROOF (#1509) — cartesian's faceplate, driven by TYPING.
//
// ⚠ WHY THIS SPEC EXISTS RATHER THAN A faces-parity ROW. cartesian reaches the
// `TextEntry` primitive through a PF-14 PANEL (its 4×4 pad grid), and
// faces-parity drives a panel by its declared click/drag probe — it cannot type.
// So the panel's probe asserts a GATE click moves `node.data.cells`, and the
// TYPED half is here. The `entry` ShellCell wrapper has no faces-parity sweep
// adopter yet; the first will be a band-shaped field (recorderbox's filename,
// once #1511 deletes `needs-media-controller`).
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

import { test, expect } from './_fixtures';
import {
  bootWithFace,
  foldViewportFor,
  frameMember,
  openDock,
  unfoldDockPane,
} from '../vrt/_shell-faces';

test.describe.configure({ mode: 'parallel' });

/** Pad 0's stored MIDI value, read straight off the live graph. */
async function padMidi(page: import('@playwright/test').Page, nodeId: string, i = 0) {
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
  await page.setViewportSize(foldViewportFor('cartesian'));
  const memberId = await bootWithFace(page, 'cartesian');
  await frameMember(page, memberId, 0.7, 'full');
  await openDock(page, memberId, 2);
  await unfoldDockPane(page);

  // ⚠ SCOPED TO THE DOCK. The same grid paints in the lane tile too, so an
  // unscoped locator is a strict-mode violation rather than a defect.
  const field = page
    .getByTestId('faceplate-editor')
    .locator('[data-testid="cart-face-pitch-0"]');
  await expect(field, 'the pad grid paints a writable note box on the FACE').toBeVisible();
  await expect(field, 'and it is not a disabled readout').toBeEnabled();

  // ── LEG 1 · a valid note COMMITS ────────────────────────────────────────
  await field.focus();
  await field.fill('c#3');
  await field.blur();
  await expect
    .poll(() => padMidi(page, memberId), {
      message: 'typing c#3 into the faceplate commits MIDI 49 into node.data.cells[0]',
    })
    .toBe(49);
  await expect(field, 'and the box shows the canonical spelling back').toHaveValue('c#3');

  // ── LEG 2 · a REFUSED note writes NOTHING ───────────────────────────────
  // `c9` is note-SHAPED and out of the module's declared c0..c8 span, so it
  // proves the RANGE check runs — `zzz` would only prove the grammar does.
  await field.focus();
  await field.fill('c9');
  await field.blur();
  await expect
    .poll(() => padMidi(page, memberId), {
      message:
        'a refused note must leave the pad EXACTLY as it was — no clamp to c8, no rounding, ' +
        'no partial write',
    })
    .toBe(49);
  await expect(field, 'and the box reverts rather than keeping the refused text').toHaveValue('c#3');

  // ── LEG 3 · clearing is a REST, not a refusal ───────────────────────────
  await field.focus();
  await field.fill('');
  await field.blur();
  await expect
    .poll(() => padMidi(page, memberId), {
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
  await page.setViewportSize(foldViewportFor('cartesian'));
  const memberId = await bootWithFace(page, 'cartesian');
  await frameMember(page, memberId, 0.7, 'full');
  await openDock(page, memberId, 2);
  await unfoldDockPane(page);

  const pane = page.getByTestId('faceplate-editor');
  const readCell = () =>
    page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<string, { data?: { cells?: Array<{ on: boolean; chord?: string }> } }>;
        };
      };
      const c = w.__patch.nodes[id]?.data?.cells?.[1];
      return { on: c?.on ?? false, chord: c?.chord ?? 'mono' };
    }, memberId);

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
