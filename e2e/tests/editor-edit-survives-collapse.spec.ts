// e2e/tests/editor-edit-survives-collapse.spec.ts
//
// #1583 — collapsing a code editor's faceplate must not discard the edit it is holding.
//
// LIVECODE and CLOCKED RUNNER debounce their commit by 250 ms, and `scheduleCommit` is the
// ONLY writer of `node.data.text` / `node.data.source`. Their onDestroy did:
//
//     if (commitTimer) clearTimeout(commitTimer);   // <- the pending edit died here
//
// So typing and then collapsing within the debounce window silently discarded the edit:
// the module kept running the PREVIOUS script and re-expanding showed the old text, with
// nothing to indicate anything was lost. Under the faceplate shell an un-migrated module's
// card exists only inside the dock full-view, so COLLAPSE unmounts it — and the dock also
// LRU-evicts a pane when a third module is expanded, which fires the same teardown with no
// user action against the editor at all.
//
// ── Why this test is DETERMINISTIC and not a race ────────────────────────────
//
// The obvious spelling — type, then click collapse and hope both land inside 250 ms — is a
// race whose flakiness would scale with CI load, and a green run would prove nothing
// because passing "just in time" and passing "because it was flushed" look identical.
//
// Instead the keystroke and the collapse happen in ONE synchronous page task, so zero time
// passes between them and the pending write is guaranteed to still be pending. The test
// asserts a LOGICAL property (a held edit is flushed, not dropped), not a timing one.
//
// ── HOW TO NEGATIVE-CONTROL THIS, and the trap in doing it ───────────────────
//
// Deleting `draft.flush()` from onDestroy does NOT turn this test red, and that first
// attempt passing is not evidence the test works — it nearly shipped a vacuous gate.
// The reason is worth knowing: `createDebouncedCommit` has no `cancel`, so with flush
// merely absent the setTimeout is STILL ARMED and fires ~250 ms later, committing the edit
// anyway even though the card is gone. The fix is doubly safe by construction.
//
// The original defect was not "forgot to flush", it was `clearTimeout(commitTimer)` —
// actively KILLING the pending write. So a faithful control must restore that shape: a raw
// timer that onDestroy cancels. Done that way this spec fails with
// "the edit held by the debounce was DISCARDED by the collapse", while the positive
// control below stays green. Verified 2026-08-13.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

interface LivecodeHook {
  __livecode: Record<string, { type(text: string): void }>;
}

/** The committed value on the node — the thing the module actually runs. */
async function storedText(page: import('@playwright/test').Page, id: string): Promise<string> {
  return page.evaluate(
    (n) => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { text?: string } }> } };
      return w.__patch.nodes[n]?.data?.text ?? '';
    },
    id,
  );
}

const SCRIPT = "spawn('analogVco'); // edit made just before collapsing";

test('LIVECODE: an edit made inside the debounce window survives a collapse', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }], [], { mountTimeout: 30_000 });

  await page.evaluate((id) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(id), 'lc');
  await expect(page.getByTestId('faceplate-collapse')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => !!(globalThis as unknown as Partial<LivecodeHook>).__livecode?.['lc']);

  const before = await storedText(page, 'lc');
  expect(before, 'baseline: the edit is not already stored').not.toContain('just before collapsing');

  // ── THE ACT UNDER TEST ──
  // Keystroke and collapse in ONE synchronous task: no time passes, so the debounced
  // write is definitely still pending when the card unmounts. If onDestroy drops it
  // instead of flushing, the edit is gone.
  await page.evaluate((src) => {
    const w = globalThis as unknown as LivecodeHook;
    w.__livecode['lc']!.type(src);
    (document.querySelector('[data-testid="faceplate-collapse"]') as HTMLButtonElement).click();
  }, SCRIPT);

  await expect(page.getByTestId('faceplate-collapse')).toHaveCount(0, { timeout: 15_000 });

  await expect
    .poll(() => storedText(page, 'lc'), {
      timeout: 15_000,
      message: 'the edit held by the debounce was DISCARDED by the collapse — this is the #1583 regression',
    })
    .toContain('just before collapsing');

  // And it is really there on re-expand, not merely written once and then clobbered by
  // the remounting editor pushing its stale doc back down.
  await page.evaluate((id) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(id), 'lc');
  await expect(page.getByTestId('faceplate-collapse')).toBeVisible({ timeout: 20_000 });
  expect(await storedText(page, 'lc'), 're-expanding must not resurrect the pre-edit text').toContain('just before collapsing');
});

test('POSITIVE CONTROL: the ordinary debounce still commits without any collapse', async ({ page }) => {
  // Without this leg, the test above would pass just as happily if `type()` wrote through
  // synchronously — i.e. if there were no debounce to lose anything in the first place.
  // This proves the write is genuinely deferred, which is what makes the collapse case a
  // real hazard rather than a hypothetical one.
  test.setTimeout(120_000);
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await spawnPatch(page, [{ id: 'lc', type: 'livecode', position: { x: 100, y: 100 } }], [], { mountTimeout: 30_000 });

  await page.evaluate((id) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(id), 'lc');
  await expect(page.getByTestId('faceplate-collapse')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => !!(globalThis as unknown as Partial<LivecodeHook>).__livecode?.['lc']);

  // Immediately after the keystroke, nothing is committed yet — the write is DEFERRED.
  const immediate = await page.evaluate((src) => {
    const w = globalThis as unknown as LivecodeHook & { __patch: { nodes: Record<string, { data?: { text?: string } }> } };
    w.__livecode['lc']!.type(src);
    return w.__patch.nodes['lc']?.data?.text ?? '';
  }, SCRIPT);
  expect(immediate, 'the commit is debounced, so it cannot have landed in the same task').not.toContain('just before collapsing');

  // ...and it lands on its own once the window elapses, with the card still mounted.
  await expect
    .poll(() => storedText(page, 'lc'), { timeout: 15_000 })
    .toContain('just before collapsing');
});
