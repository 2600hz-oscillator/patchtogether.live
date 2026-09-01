// e2e/tests/scaler-cv-connect.spec.ts
//
// THE GESTURE, THROUGH THE REAL UI: patch a CV into SCALER, then patch SCALER's
// output into a CV jack.
//
// The owner's report was three words long — *"scaler's output wont patch to cv
// ins, it seems like"* — and it was exact. `PortDef.adoptsUpstreamFrom` says
// "this output emits whatever is patched into that input", and it was honoured
// in ONE place: `buildPatchSnapshot`, which re-types an edge that ALREADY
// EXISTS. CREATING a cable goes through `canConnect(srcType, dstType)`, which is
// handed two cable types and no graph, so it saw SCALER's DECLARED `audio` — and
// `audio → cv` is refused by design. The jack was type-transparent for READING
// and opaque for PATCHING, so the cable could never be made and the adoption
// never got the chance to apply.
//
// ⚠ WHY THIS SPEC EXISTS ALONGSIDE THE UNIT TESTS. The validator, the shared
// upstream walk and the type decisions are pinned exhaustively in
// `graph/validate-edge.test.ts` and `audio/modules/attenumix.test.ts`, with a
// positive control. What NO unit test can see is whether Canvas actually HANDS
// the validator the live graph — the fix threads an adoption graph through five
// `validateEdge` call sites, the carry pickup and the patch-to cascade, and
// forgetting any one of them leaves every unit test green and the product still
// refusing the cable. That is this repo's "shipped green and silent" class, so
// the gesture is asserted where the user makes it.
//
// AUDIO DOMAIN ONLY — no video module, no canvas read, no renderer wait, so it
// is deterministic on a real GPU and on CI's software renderer alike, and it
// needs no arbitrary settle delay: every step waits on an observable locator.
//
// THE CHAIN:  LFO.phase0 (cv) → SCALER.in        [seeded]
//             SCALER.out      → FILTER.cutoff    [the gesture under test]

import { test, expect, type Page } from './_fixtures';
import { spawnPatch, type SpawnEdge, type SpawnNode } from './_helpers';

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

/** Right-click an OUTPUT port row to reach the patch picker. Resets to a known
 *  state first: the patch trigger TOGGLES and the panel remembers its drill
 *  view, so every call walks the same path (the es9-per-leg-patching recipe). */
async function openPickerOnOutput(page: Page, nodeId: string, portId: string) {
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
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu, `right-clicking ${nodeId}.${portId} must reach the patch picker`).toBeVisible();
  return menu;
}

/** Every edge in the live patch, as endpoint strings. */
async function edgeEndpoints(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        edges: Record<string, { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined>;
      };
    };
    return Object.values(w.__patch.edges)
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => `${e.source.nodeId}.${e.source.portId}→${e.target.nodeId}.${e.target.portId}`)
      .sort();
  });
}

const SEED: SpawnNode[] = [
  { id: 'lfo', type: 'lfo', position: { x: 60, y: 80 }, params: { rate: 2, depth: 1 } },
  // The subject: `in` accepts the CV family, `out` adopts `in`.
  { id: 'sc', type: 'scaler', position: { x: 380, y: 80 }, params: { amount: 2 } },
  // A SECOND scaler, deliberately left UNFED — the unpatched-case control.
  { id: 'sc_bare', type: 'scaler', position: { x: 380, y: 340 }, params: { amount: 2 } },
  // FILTER declares `audio` (audio) and `cutoff`/`res` (cv) — one jack of each
  // class on ONE module, which is what makes the picker's offer set a sharp
  // instrument rather than a module-level yes/no.
  { id: 'flt', type: 'filter', position: { x: 700, y: 80 } },
];

const SEED_EDGES: SpawnEdge[] = [
  {
    id: 'e_lfo_sc',
    from: { nodeId: 'lfo', portId: 'phase0' },
    to: { nodeId: 'sc', portId: 'in' },
    sourceType: 'cv',
    targetType: 'audio',
  },
];

test.describe('SCALER: a scaled CV patches into a CV input', () => {
  test('the patch picker OFFERS filter.cutoff and the cable commits', async ({ page, rack, errorWatch }) => {
    void rack;
    void errorWatch; // armed: the fixture asserts a clean page at teardown
    await spawnPatch(page, SEED, SEED_EDGES);

    const menu = await openPickerOnOutput(page, 'sc', 'out');
    await menu.locator('[data-testid="patch-to-module"][data-node-id="flt"]').click();

    const cutoff = menu.locator('[data-testid="patch-to-port"][data-port-id="cutoff"]');
    await expect(
      cutoff,
      'SCALER.out is fed a CV, so it EMITS cv and the picker must offer the ' +
        'cv-typed FILTER.cutoff. Zero rows here is the shipped bug: the cascade ' +
        'judging the jack on its declared `audio` fallback.',
    ).toHaveCount(1);
    await cutoff.click();

    await expect
      .poll(() => edgeEndpoints(page), {
        message: 'the committed cable must appear in the live patch',
      })
      .toContain('sc.out→flt.cutoff');

    // The seeded cable is untouched — the commit added, it did not replace.
    expect(await edgeEndpoints(page)).toContain('lfo.phase0→sc.in');
  });

  test('an UNFED scaler is offered filter.audio but NOT filter.cutoff', async ({ page, rack, errorWatch }) => {
    void rack;
    void errorWatch;
    // The instrument's negative control AND the documented unpatched decision in
    // one gesture. `sc_bare` has nothing on its `in`, so there is no adopted
    // type and the declared `audio` stands: it reaches the audio input and is
    // refused by the CV one. A picker that offered `cutoff` here would mean the
    // fix had widened `canConnect` rather than resolved a truer source type —
    // and an audio-rate signal would be landing on a CV param.
    await spawnPatch(page, SEED, SEED_EDGES);

    const menu = await openPickerOnOutput(page, 'sc_bare', 'out');
    await menu.locator('[data-testid="patch-to-module"][data-node-id="flt"]').click();

    await expect(
      menu.locator('[data-testid="patch-to-port"][data-port-id="audio"]'),
      'the picker is working — an unfed scaler still reaches the AUDIO input',
    ).toHaveCount(1);
    await expect(
      menu.locator('[data-testid="patch-to-port"][data-port-id="cutoff"]'),
      'with nothing upstream there is no adopted type, so the cv jack must NOT ' +
        'be offered — patch the source first',
    ).toHaveCount(0);
  });
});
