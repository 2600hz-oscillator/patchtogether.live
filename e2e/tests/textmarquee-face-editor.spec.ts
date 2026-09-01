// e2e/tests/textmarquee-face-editor.spec.ts
//
// THE TEXTMARQUEE FACE (2026-08-31) — the DEFAULT-shell legs for a promotion
// whose failure mode is a document that silently changes meaning.
//
// ── WHY THIS FILE IS MANDATORY RATHER THAN NICE TO HAVE ────────────────────
//
// `textmarquee.spec.ts` and `textmarquee-render-smoke.spec.ts` both boot
// `?shell=legacy` and both survive this promotion completely unchanged — which
// is exactly why neither is evidence about the face. 377 of 431 e2e specs boot
// the legacy shell; after a promotion they keep passing over a surface no
// player meets.
//
// What this file covers is the one thing that could go wrong QUIETLY:
//
//   ⚠ `serializeEditor` READS `getComputedStyle`, SO THE EDITOR'S CASCADE IS
//   PART OF THE PERSISTED DOCUMENT. Every run with no inline style of its own
//   serializes whatever the editor element's cascade resolved to, and that goes
//   into `node.data.richText` — Y.Doc-persisted, synced to collaborators,
//   rasterized into the video texture, and read back by the still-live legacy
//   card. `TextmarqueeCard.svelte`'s `.editor` rule set `color:#ffffff`;
//   `.dock-ext-body` sets nothing and inherits the faceplate's
//   `var(--text, #eef1f5)`. A body that simply copied the card's markup would
//   have recoloured every untouched run of every rack anyone opened the dock
//   on, would have stamped `bold:true` under any ancestor at `font-weight >=
//   600`, and would have stamped `center` under any centred ancestor.
//
//   `packages/web/src/lib/graph/textmarquee-editor.test.ts` covers the DECISION
//   logic in a node environment, and `textmarquee-face-model.test.ts` proves
//   both surfaces call `applyEditorBaseStyle` at the source. NEITHER can see
//   which values a real cascade actually hands over. Only a browser can, and
//   only on the promoted surface. That is this file.
//
// ⚠ EVERY TEST CARRIES A `pageerror` GUARD. A shared derivation repaired on
// `ModuleShellPlaceholder` can still throw inside `ModuleShell`, and only
// promoting reveals it — a body that throws on mount leaves the dock empty and
// the locator assertions below would fail with a confusing message instead of
// the exception that caused it.
//
// ⚠ NO WALL-CLOCK WAIT DECIDES ANYTHING. Every wait is an auto-retrying
// `expect` / `expect.poll` on the real subject. The only wall-clock numbers are
// BUDGETS from the one export site in `_helpers/boot-budget.ts`, and they bound
// a failure rather than gating one. The ONE `waitForTimeout` in this file is
// the module's own 250 ms persist DEBOUNCE — a product constant, not a render
// wait — and it is followed by an assertion that would fail if the write never
// arrived, so a short wait cannot make a test pass.

import { test, expect, type Page } from '@playwright/test';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { spawnPatch } from './_helpers';

const TM_ID = 'tm-face';

const NODES = [
  { id: TM_ID, type: 'textmarquee', position: { x: 120, y: 80 }, domain: 'video' as const },
];

/** The persisted rich-text model for `TM_ID`, straight off the patch store. */
interface StoredRun { text?: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string }
interface StoredPara { runs?: StoredRun[]; align?: string }
interface StoredModel { paragraphs?: StoredPara[]; fg?: string; bg?: string; fontPx?: number; fontFamily?: string }

async function readModel(page: Page): Promise<StoredModel | null> {
  return page.evaluate((nodeId) => {
    const w = window as unknown as {
      __patch?: { nodes?: Record<string, { data?: { richText?: unknown } }> };
    };
    return (w.__patch?.nodes?.[nodeId]?.data?.richText ?? null) as never;
  }, TM_ID);
}

/** Every run across every paragraph, flattened. */
function allRuns(m: StoredModel | null): StoredRun[] {
  return (m?.paragraphs ?? []).flatMap((p) => p.runs ?? []);
}
function plain(m: StoredModel | null): string {
  return (m?.paragraphs ?? []).map((p) => (p.runs ?? []).map((r) => r.text ?? '').join('')).join('\n');
}

/**
 * Boot the DEFAULT shell and spawn one textmarquee node.
 *
 * ⚠ `?shell=1` RATHER THAN A BARE `/rack`, matching the fleet's face specs. The
 * v2 shell is the default either way, and the dock full view switches on
 * STRICT_FACES membership alone — so the flag is documentation of intent here,
 * not the thing making the face appear.
 */
async function bootRack(page: Page, errors: string[]) {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/rack?shell=1&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, NODES, []);
}

/** Open textmarquee's dock faceplate and return the dock shell locator. */
async function openDock(page: Page) {
  const shell = page.locator(`.svelte-flow__node[data-id="${TM_ID}"] [data-testid="module-shell"]`);
  await expect(shell, 'the promoted face renders a ModuleShell tile in the lane')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

/** Select the whole editor's contents through the DOM Selection API, scoped to
 *  the element (robust against a page-wide Ctrl+A). */
async function selectAll(editor: ReturnType<Page['locator']>) {
  await editor.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
}

/** The module's own persist debounce. A PRODUCT constant, not a render wait —
 *  and every use is followed by an auto-retrying assertion that fails if the
 *  write never lands, so waiting too little cannot turn a red test green. */
const PERSIST_DEBOUNCE_MS = 250;

test.describe('TEXTMARQUEE face — the editor moved, and it still means the same thing', () => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS);

  test('⚠ typing into the FACE persists WHITE runs — not the faceplate\'s inherited colour', async ({ page }) => {
    const errors: string[] = [];
    await bootRack(page, errors);
    const dockShell = await openDock(page);

    const body = dockShell.getByTestId('textmarquee-editor-body');
    await expect(body, 'the fullViewBody paints at the dock').toBeVisible();

    // Before anything is typed the model is absent — so the assertion after the
    // typing is about text this test put there, not about a seeded default.
    expect(plain(await readModel(page)), 'a fresh node carries no document').toBe('');

    const editor = body.getByTestId('textmarquee-editor');
    await editor.click();
    await page.keyboard.type('HELLO FACE');

    await expect
      .poll(async () => plain(await readModel(page)), {
        message: 'typed text never reached node.data.richText from the FACE body',
      })
      .toContain('HELLO FACE');

    // ── THE ASSERTION THIS WHOLE FILE EXISTS FOR ──────────────────────────
    //
    // Every run must carry the CARD's colour. If the body had inherited the
    // faceplate's `--text` instead of stamping `EDITOR_BASE_STYLE`, this reads
    // `#eef1f5` — a value nothing would ever go red on except this line, and one
    // that would have been written into every rack whose dock anyone opened.
    const runs = allRuns(await readModel(page));
    expect(runs.length, 'the model has runs to check').toBeGreaterThan(0);
    for (const r of runs) {
      expect(
        r.color,
        'a run serialized with the faceplate\'s INHERITED colour instead of the editor\'s own. ' +
          'The body must call applyEditorBaseStyle (see $lib/graph/textmarquee-editor) — ' +
          '.dock-ext-body sets no colour and inherits var(--text, #eef1f5), and serializeEditor ' +
          'reads getComputedStyle, so the cascade IS the persisted document.',
      ).toBe('#ffffff');
    }

    // …and nothing arrived pre-bolded or pre-centred from an ancestor either —
    // the same hole, on the other three properties the serializer reads.
    for (const r of runs) {
      expect(r.bold, 'a run inherited BOLD from an ancestor').toBeUndefined();
      expect(r.italic, 'a run inherited ITALIC from an ancestor').toBeUndefined();
      expect(r.underline, 'a run inherited UNDERLINE from an ancestor').toBeUndefined();
    }
    for (const p of (await readModel(page))?.paragraphs ?? []) {
      expect(p.align, 'a paragraph inherited its alignment from an ancestor').toBe('left');
    }

    expect(errors, 'page errors on the promoted surface').toEqual([]);
  });

  test('the FACE toolbar formats a selection — BOLD and ALIGN reach the model', async ({ page }) => {
    const errors: string[] = [];
    await bootRack(page, errors);
    const dockShell = await openDock(page);
    const body = dockShell.getByTestId('textmarquee-editor-body');

    const editor = body.getByTestId('textmarquee-editor');
    await editor.click();
    await page.keyboard.type('boldme');
    // Let the debounced persist settle before selecting, so its re-render
    // cannot collapse the selection mid-gesture. The poll below is what
    // actually decides; this only avoids a self-inflicted race.
    await page.waitForTimeout(PERSIST_DEBOUNCE_MS + 150);
    await editor.click();
    await selectAll(editor);
    await body.getByTestId('textmarquee-bold').click();

    await expect
      .poll(async () => allRuns(await readModel(page)).some((r) => r.bold === true), {
        message:
          'the face toolbar\'s BOLD produced no bold run. It acts on a live DOM Selection, which ' +
          'is why it can only live beside the editor and cannot be a face cell — if this fails ' +
          'the mousedown preventDefault that keeps the selection alive is probably gone.',
      })
      .toBe(true);

    await selectAll(editor);
    await body.getByTestId('textmarquee-align-center').click();

    await expect
      .poll(async () => ((await readModel(page))?.paragraphs ?? []).some((p) => p.align === 'center'), {
        message: 'the face toolbar\'s ALIGN CENTER never reached the persisted model',
      })
      .toBe(true);

    expect(errors, 'page errors on the promoted surface').toEqual([]);
  });

  test('the FACE writes the LAYER settings the card owned — background, size, font', async ({ page }) => {
    const errors: string[] = [];
    await bootRack(page, errors);
    const dockShell = await openDock(page);
    const body = dockShell.getByTestId('textmarquee-editor-body');

    // Something has to be typed first: an empty document is still persisted, but
    // asserting on layer settings over an empty model would not prove the model
    // survives an edit.
    const editor = body.getByTestId('textmarquee-editor');
    await editor.click();
    await page.keyboard.type('LAYER');
    await expect
      .poll(async () => plain(await readModel(page)), { message: 'seed text never persisted' })
      .toContain('LAYER');

    // ⚠ `<input type="color">` CANNOT BE CLICKED OPEN IN A HEADLESS BROWSER —
    // the OS picker is not a DOM surface. Setting `.value` and dispatching the
    // same `input` event the widget fires is the supported route, and it drives
    // the module's real handler rather than reaching past it into the store.
    await body.getByTestId('textmarquee-bg').evaluate((el) => {
      (el as HTMLInputElement).value = '#123456';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await body.getByTestId('textmarquee-size').evaluate((el) => {
      (el as HTMLInputElement).value = '120';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await body.getByTestId('textmarquee-font').selectOption('monospace');

    await expect
      .poll(async () => {
        const m = await readModel(page);
        return { bg: m?.bg, fontPx: m?.fontPx, fontFamily: m?.fontFamily };
      }, {
        message:
          'a layer setting did not reach node.data.richText. These three live in component state ' +
          'seeded from the model on mount and are written back through every serializeEditor ' +
          'call — a body that forgot to seed them would silently reset all three on the first ' +
          'keystroke instead.',
      })
      .toEqual({ bg: '#123456', fontPx: 120, fontFamily: 'monospace' });

    // …and the TEXT survived all three, which is what makes them layer settings
    // rather than a document rewrite.
    expect(plain(await readModel(page))).toContain('LAYER');

    expect(errors, 'page errors on the promoted surface').toEqual([]);
  });

  test('⚠ the persist DEBOUNCE flushes when the dock closes — the last keystrokes are not lost', async ({ page }) => {
    const errors: string[] = [];
    await bootRack(page, errors);
    const dockShell = await openDock(page);
    const body = dockShell.getByTestId('textmarquee-editor-body');

    const editor = body.getByTestId('textmarquee-editor');
    await editor.click();
    await page.keyboard.type('FLUSHME');

    // ⚠ NO WAIT HERE, DELIBERATELY. The point is to tear the pane down while
    // the 250 ms timer is still pending: the dock LRU-evicts a pane at the
    // third expand, so this component unmounts under the player's hands far
    // more readily than a card ever did.
    //
    // ⚠ WHAT THIS TEST CAN AND CANNOT SEPARATE, stated rather than implied.
    // TWO seams protect the pending write — `onblur` → `flushPersist()` and
    // `onDestroy` → `flushPersist()` — and clicking ANY button moves focus out
    // of the `contenteditable` first, so the blur fires before the unmount and
    // a body with no `onDestroy` flush would still pass this. The isolating
    // gesture would be a keystroke that tears the pane down without moving
    // focus, and there is none: MEASURED, `Escape` typed into the focused
    // editor leaves the dock pane mounted (the editor consumes it), so the
    // first draft of this test asserted `toHaveCount(0)` and failed on its own
    // instrument rather than on the product.
    //
    // So this leg asserts the PLAYER-VISIBLE property — the last keystrokes
    // survive closing the dock — and the `onDestroy` seam itself is held at the
    // source by `textmarquee-face-model.test.ts`. Neither alone is enough:
    // a source probe cannot see that the write actually lands, and this cannot
    // see which of the two seams landed it.
    await page.getByTestId('faceplate-close').first().click();
    await expect(
      body,
      'closing the dock did not tear down the pane — this test is measuring nothing if the body ' +
        'is still mounted; fix the gesture rather than relaxing the assertion below.',
    ).toHaveCount(0);

    await expect
      .poll(async () => plain(await readModel(page)), {
        message:
          'the last typed characters never persisted. TextmarqueeEditorBody must flush its ' +
          'pending debounced write on blur AND in onDestroy — the dock evicts panes, so neither ' +
          'is a rare path.',
      })
      .toContain('FLUSHME');

    expect(errors, 'page errors on the promoted surface').toEqual([]);
  });
});
