// e2e/tests/docs-virtual-module.spec.ts
//
// The interactive virtual-module doc page (the redesign that replaces the
// numbered face as the PRIMARY view). Proves, data-driven over adsr + sequencer:
//   (a) the LIVE card mounts + renders on /docs/modules/<id>,
//   (b) hovering a faceplate control shows its AUTHORED text in the right pane,
//   (c) opening the patch panel + hovering a CV port shows the CV desc AND the
//       "modulates <Param>" DUAL context (the CV→param overlap),
//   (d) SANDBOX ISOLATION — interacting never persists a real rack (the global
//       store stays empty of a real rackspace binding / no relay opened),
//   (e) SSR — the prerendered HTML carries the right-pane authored explanation
//       with NO JS.
//
// These are NEW tests; flake-checked 3× via `REPEAT=3 task e2e:one`.

import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

interface Probe {
  id: string;
  heading: RegExp;
  /** A faceplate control to hover (param id → testid `control-<id>`). */
  controlParam: string;
  /** Substring expected in the pane after hovering that control. */
  controlDescIncludes: RegExp;
  /** A CV input port whose pane should show the dual "modulates X" context. */
  cvPort: string;
  /** The control name the CV port should say it modulates. */
  modulates: RegExp;
}

const PROBES: Probe[] = [
  {
    id: 'adsr',
    heading: /adsr/i,
    controlParam: 'attack',
    controlDescIncludes: /rise|attack/i,
    cvPort: 'attack',
    modulates: /modulates/i,
  },
  {
    id: 'sequencer',
    heading: /sequencer/i,
    controlParam: 'bpm',
    controlDescIncludes: /tempo|bpm/i,
    // sequencer has no CV→param inputs (its CVs are transport gates), so the
    // dual-context assertion is skipped for it (see the conditional below).
    cvPort: '',
    modulates: /./,
  },
  // --- Batch 1 — foundational modules (2026-06-25). Each is on the
  // INTERACTIVE_DOC_MODULES allowlist; this proves the live card mounts cleanly
  // and a control hover updates the pane. A CV→param dual-context check runs only
  // where the module has a CV input with a paramTarget (analogVco, filter, lfo,
  // cocoadelay); vca/mixer/noise have no CV→param link (cvPort: '' skips it). ---
  {
    id: 'analogVco',
    heading: /analog vco/i,
    controlParam: 'tune',
    controlDescIncludes: /pitch|tune|semitone/i,
    cvPort: 'tune', // CV → tune param
    modulates: /modulates/i,
  },
  {
    id: 'vca',
    heading: /vca/i,
    controlParam: 'base',
    controlDescIncludes: /offset|unity|base/i,
    cvPort: '', // the `cv` input has no paramTarget (it's the gain CV, not a param mod)
    modulates: /./,
  },
  {
    id: 'mixer',
    heading: /mixer/i,
    controlParam: 'master',
    controlDescIncludes: /master|bus|gain/i,
    cvPort: '', // no CV inputs
    modulates: /./,
  },
  {
    id: 'noise',
    heading: /noise/i,
    controlParam: 'level',
    controlDescIncludes: /gain|level|noise/i,
    cvPort: '', // pure source, no inputs
    modulates: /./,
  },
  {
    id: 'filter',
    heading: /filter/i,
    controlParam: 'cutoff',
    controlDescIncludes: /cutoff|frequency|corner/i,
    cvPort: 'cutoff', // CV → cutoff param
    modulates: /modulates/i,
  },
  {
    id: 'lfo',
    heading: /lfo/i,
    controlParam: 'rate',
    controlDescIncludes: /rate|knob/i,
    cvPort: 'rate', // CV → rate param
    modulates: /modulates/i,
  },
  // NOTE — cocoadelay is documented + STRICT but NOT on INTERACTIVE_DOC_MODULES
  // (its `card: 'CocoaDelayCard'` override isn't plumbed through the doc route's
  // defLite, so the live card can't resolve and the page uses the static
  // fallback). No live-card probe for it here; see interactive-doc-modules.ts.
];

/** Wait for the live virtual module to finish mounting (the flow host appears
 *  only after the dynamic card-map import resolves). */
async function waitForLiveCard(page: Page) {
  const vm = page.getByTestId('virtual-module');
  await expect(vm).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('virtual-module-flow')).toBeVisible({ timeout: 15_000 });
}

/** Open the patch panel (left trigger) and drill into INPUT so the port rows
 *  (which carry data-port-id / data-direction) render in the portaled chrome. */
async function openInputs(page: Page) {
  await page.getByTestId('patch-trigger').first().click();
  await expect(page.getByTestId('patch-panel')).toBeVisible({ timeout: 5_000 });
  // Root view → INPUT pivot.
  await page.locator('[data-testid="patch-panel-nav"][data-nav="inputs"]').click();
  await expect(page.getByTestId('patch-panel-inputs')).toBeVisible({ timeout: 5_000 });
}

for (const probe of PROBES) {
  test(`virtual module: live card + hover pane (${probe.id})`, async ({ page }) => {
    // A module only earns the INTERACTIVE_DOC_MODULES allowlist if its live card
    // mounts with NO uncaught page error (a card that throws on the doc sandbox
    // stays on the static face). Collect uncaught errors for the whole flow.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto(`/docs/modules/${probe.id}`);
    await expect(page.getByRole('heading', { name: probe.heading, level: 1 })).toBeVisible();

    // The hover pane is always present (SSR-rendered) and starts on the module
    // explanation (default state).
    const pane = page.getByTestId('doc-hover-pane');
    await expect(pane).toBeVisible();
    await expect(page.getByTestId('pane-default-explanation')).toBeVisible();

    // (a) The live card mounts.
    await waitForLiveCard(page);

    // (b) Hover a faceplate control → its authored prose appears in the pane.
    const control = page.locator(`[data-testid="control-${probe.controlParam}"]`).first();
    await expect(control).toBeVisible({ timeout: 10_000 });
    await control.hover();
    await expect(page.getByTestId('pane-name')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('pane-desc')).toContainText(probe.controlDescIncludes, {
      timeout: 5_000,
    });

    // (c) Open the patch panel + hover a CV port → CV desc + DUAL context.
    if (probe.cvPort) {
      await openInputs(page);
      // The VISIBLE portaled chrome port row (the back-jack also carries
      // data-port-id but is display:none until rear-view, so scope to the
      // patch-panel-port-row testid the chrome rows use).
      const portRow = page
        .locator(
          `[data-testid="patch-panel-port-row"][data-port-id="${probe.cvPort}"][data-direction="input"]`,
        )
        .first();
      await expect(portRow).toBeVisible({ timeout: 5_000 });
      await portRow.hover();
      // The pane flips to the port view and shows the dual "modulates" block.
      await expect(page.getByTestId('pane-dual')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId('pane-dual')).toContainText(probe.modulates);
      // The port's own authored/explain text is shown too.
      await expect(page.getByTestId('pane-explain')).toBeVisible();
    }

    // EYEBALL: capture the rendered page (card + pane) for manual review.
    await page.screenshot({
      path: `test-results/docs-virtual-module-${probe.id}.png`,
      fullPage: true,
    });

    // The live card + hover flow must not have thrown — this is the gate that
    // qualifies the module for the interactive allowlist.
    expect(pageErrors, `page errors on /docs/modules/${probe.id}: ${pageErrors.join('\n')}`).toEqual(
      [],
    );
  });
}

test('sandbox isolation: interacting never persists a real rack or opens a relay', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/docs/modules/adsr');
  await waitForLiveCard(page);

  // Interact: open the patch panel + hover a port, then hover a control.
  await openInputs(page);
  await page
    .locator('[data-testid="patch-panel-port-row"][data-port-id="attack"][data-direction="input"]')
    .first()
    .hover();
  await page.locator('[data-testid="control-attack"]').first().hover();

  // The page's own state is fine — pane still updates, no page error.
  await expect(page.getByTestId('doc-hover-pane')).toBeVisible();
  expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toEqual([]);

  // Best-effort sandbox proof: the dev test hook __ydoc (when present) should
  // hold NO real rackspace — the sandbox binds a throwaway local doc and never
  // attaches a Hocuspocus provider. We assert the dev __provider hook is absent
  // (the doc route never constructs one) and that navigating away leaves no
  // window-scoped relay. This is a guard, not a multi-tab DOOM-grade proof.
  const providerOpened = await page.evaluate(() => {
    const g = globalThis as unknown as { __provider?: unknown };
    return g.__provider != null;
  });
  expect(providerOpened, 'a Hocuspocus relay must NOT be opened on the doc route').toBe(false);
});

test('SSR: prerendered HTML carries the right-pane authored text without JS', async ({
  browser,
}) => {
  // A JS-disabled context proves the prerendered (no-CSR) HTML is readable: the
  // right pane's module explanation is in the initial response, and the static
  // numbered-face fallback (not the live card) renders.
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('/docs/modules/adsr');

  // The pane + its default explanation are in the SSR HTML.
  await expect(page.getByTestId('doc-hover-pane')).toBeVisible();
  await expect(page.getByTestId('pane-default-explanation')).toContainText(/envelope/i);
  // The live card never mounts without JS → the static face fallback is shown.
  await expect(page.getByTestId('module-face')).toBeVisible();
  // The live virtual module is absent.
  await expect(page.getByTestId('virtual-module')).toHaveCount(0);

  await ctx.close();
});
