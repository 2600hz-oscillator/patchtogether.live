// e2e/tests/page-error-filter.spec.ts
//
// The self-test for `_page-errors.ts` — the console-error policy every registry
// sweep asserts on.
//
// WHAT IT IS DEFENDING. Until 2026-08-12 the two registry sweeps each dropped
// every `Failed to load resource` unconditionally. That message is IDENTICAL
// for every failed resource in the product and the specs never recorded
// `location()`, so a 404'd AudioWorklet — the module simply not loading — was
// indistinguishable from a missing optional game asset, and both were silently
// discarded. 173 live `inputs accept signal` rows had no other assertion able
// to see it (their edge check reads the patch store, which fills in whether or
// not the engine came up), 58 module types had no other live per-port row at
// all, and the sweep went green.
//
// So the thing under test here is an INSTRUMENT, and it is negative-controlled
// in BOTH directions on every run rather than once at authoring time:
//
//   * a resource that fails and is NOT named  → must go RED,
//   * a resource that fails and IS named      → must go GREEN, and must still
//                                               be RECORDED (so "nothing
//                                               failed" and "we exempted it"
//                                               are never the same output),
//   * nothing failing                         → must go GREEN.
//
// A predicate that returned `true` for everything would pass the third leg and
// fail the first; one that returned `false` for everything fails the second.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OPTIONAL_RUNTIME_ASSETS,
  assetGitignorePath,
  assetUrlPath,
  collectPageErrors,
  formatEntry,
  isBenign,
  optionalAssetForUrl,
  type PageErrorEntry,
} from './_page-errors';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** The exact console event Chrome raises for a failed subresource load.
 *  MEASURED 2026-08-12 by 404ing packages/dsp/dist/lfo.js with a Playwright
 *  route and spawning `lfo`: this text, with the worklet url in
 *  `location().url`. The text carries no url — that is the whole reason the
 *  old substring filter could not tell a dead worklet from an absent WAD. */
const LOAD_FAILURE_TEXT =
  'Failed to load resource: the server responded with a status of 404 (Not Found)';

function loadFailure(url: string): PageErrorEntry {
  return { kind: 'console', text: LOAD_FAILURE_TEXT, url };
}

// ────────── The predicate, in isolation ──────────

test.describe('page-error filter: a failed resource load is DENIED unless named', () => {
  test('a 404 worklet is significant — the case the old filter could not see', () => {
    const worklet = loadFailure(
      'http://localhost:5173/@fs/repo/packages/dsp/dist/lfo.js?url',
    );
    expect(
      isBenign(worklet),
      'a 404 on a DSP worklet must be significant — this is the exact event measured when '
      + 'packages/dsp/dist/lfo.js was 404ed, and the module does not load without it',
    ).toBe(false);
  });

  test('an UNNAMED static asset 404 is significant', () => {
    expect(isBenign(loadFailure('http://localhost:5173/wavetables/basic.bin'))).toBe(false);
    expect(isBenign(loadFailure('http://localhost:5173/blood/blood.wasm'))).toBe(false);
  });

  test('each NAMED optional asset is benign — at its url, and only there', () => {
    for (const asset of OPTIONAL_RUNTIME_ASSETS) {
      const url = `http://localhost:5173${assetUrlPath(asset)}`;
      expect(
        isBenign(loadFailure(url)),
        `${asset.staticPath} is a named optional runtime asset, so a 404 on it is benign`,
      ).toBe(true);
    }
  });

  test('NEGATIVE CONTROL: the exemption is keyed on the URL, never on the message', () => {
    // The failure this rules out: an exemption that matches the SENTENCE would
    // green a dead worklet the moment any doom-shaped word appeared in it. The
    // load-failure text is a fixed string, so the only discriminator is the url
    // — assert the same text with a non-exempt url is still significant, and
    // that an exempt-looking url in a DIFFERENT position (query, prefix) does
    // not smuggle a resource through.
    expect(isBenign(loadFailure('http://localhost:5173/dsp/doom.js.map'))).toBe(false);
    expect(isBenign(loadFailure('http://localhost:5173/x.js?fallback=/doom/doom.js'))).toBe(false);
    expect(isBenign(loadFailure('http://localhost:5173/mirror/doom/DOOM1.WAD'))).toBe(false);
    expect(optionalAssetForUrl('http://localhost:5173/doom/DOOM1.WAD.bak')).toBeNull();
  });

  test('a failure that NAMES an optional asset in its own text is benign; an unnamed one is not', () => {
    // A 404 on an optional asset raises TWO events, not one: the loader's
    // "Failed to load resource" (handled by url, above) and — when the asset
    // was reached through a dynamic `import()` — a TypeError whose message
    // carries the url inline. DOOM's shim is loaded exactly that way
    // ($lib/doom/doom-runtime.ts), and it also throws a hand-written
    // "DOOM WASM not built. Run `bash …` to generate /doom/doom.js + doom.wasm."
    // Both are the `doom.js` / `DOOM1.WAD` clause the private filters already
    // carried — kept, but keyed on the same named list rather than on a bare
    // filename nobody owns.
    expect(isBenign({
      kind: 'pageerror',
      text: 'TypeError: Failed to fetch dynamically imported module: http://localhost:5173/doom/doom.js',
      url: '',
    })).toBe(true);
    expect(isBenign({
      kind: 'pageerror',
      text: 'DOOM WASM not built. Run `bash packages/web/native/build-doom-wasm.sh` to generate /doom/doom.js + doom.wasm.',
      url: '',
    })).toBe(true);
    // …and the same shape for a resource nobody named must still be red — this
    // is the leg that stops the clause above from becoming a second blanket.
    expect(isBenign({
      kind: 'pageerror',
      text: 'TypeError: Failed to fetch dynamically imported module: http://localhost:5173/blood/blood.js',
      url: '',
    })).toBe(false);
  });

  test('the OTHER benign classes are unchanged', () => {
    // Carried verbatim from the two private filters this replaces, so the
    // change is confined to the resource-load clause.
    expect(isBenign({ kind: 'console', text: 'The AudioContext was not allowed to start', url: '' })).toBe(true);
    expect(isBenign({ kind: 'console', text: '[vite] hot updated', url: '' })).toBe(true);
    expect(isBenign({
      kind: 'console',
      text: '[reconciler] reconcile failed: disconnect (output 0) is not connected',
      url: '',
    })).toBe(true);
    // …and a plain page error still is not.
    expect(isBenign({ kind: 'pageerror', text: 'TypeError: x is not a function', url: '' })).toBe(false);
  });

  test('ANCHORED TO THE TREE: every named asset is still gitignored', () => {
    // A ledger entry naming something that no longer exists is RED. These are
    // exempt BECAUSE they are optional developer/CI-supplied artifacts; the
    // machine-checkable form of "optional" is "the repo declines to track it".
    // Commit one, rename it, or move its ignore rule, and the exemption that
    // names it fails here instead of quietly covering a resource the product is
    // now entitled to expect. (CI DOES have these files — build-web builds
    // doom.js/doom.wasm and downloads DOOM1.WAD — so the anchor deliberately
    // checks the ignore RULE, not the file's presence.)
    const gitignore = readFileSync(
      resolve(REPO_ROOT, 'packages', 'web', '.gitignore'),
      'utf8',
    ).split('\n').map((l) => l.trim());
    const unanchored = OPTIONAL_RUNTIME_ASSETS
      .filter((a) => !gitignore.includes(assetGitignorePath(a)))
      .map((a) => `${a.staticPath} (expected the line "${assetGitignorePath(a)}" in packages/web/.gitignore)`);
    expect(
      unanchored,
      'a named optional-asset exemption whose gitignore rule is gone is either stale (the asset '
      + 'is now committed → delete the exemption) or misspelled (→ fix the path)',
    ).toEqual([]);
  });
});

// ────────── The instrument, in a real browser ──────────

/** Append a <script src>, resolve when the browser has finished with it either
 *  way. A 404 here raises exactly the console event a 404'd worklet raises. */
async function requestUrl(page: Page, url: string): Promise<void> {
  await page.evaluate(
    (u) =>
      new Promise<void>((done) => {
        const s = document.createElement('script');
        s.src = u;
        s.onerror = () => done();
        s.onload = () => done();
        document.head.appendChild(s);
      }),
    url,
  );
}

const PROBE_URL = '/__page-error-instrument-probe.js';

test('page-error collector: a 404 moves the needle, a NAMED 404 does not, and both are recorded', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);

  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');

  // ── Leg 1 (control): nothing injected, nothing significant. ──────────────
  // Without this leg the other two prove only that the predicate can say
  // "red" — not that a quiet page reads as green.
  expect(
    errors.significant(),
    'CONTROL: a bare /rack boot must produce no significant page errors — if this is red the '
    + 'other two legs say nothing about the injected resources',
  ).toEqual([]);

  // The 404s are SERVED BY THE TEST, not by the server, so this leg means the
  // same thing on a dev server, on `vite preview`, and on CI — where the DOOM
  // assets are genuinely present and would otherwise return 200. Routes are
  // registered AFTER the initial navigation: a route installed before `goto`
  // disables the HTTP cache for the whole boot, which on the dev server takes
  // the /rack mount from ~2 s to over two minutes (measured).
  await page.route(`**${PROBE_URL}`, (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }),
  );
  for (const asset of OPTIONAL_RUNTIME_ASSETS) {
    await page.route(`**${assetUrlPath(asset)}`, (route) =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }),
    );
  }

  // ── Leg 2: an UNNAMED resource 404s → the sweep must see it. ─────────────
  await requestUrl(page, PROBE_URL);
  await expect
    .poll(
      () => errors.significant().filter((l) => l.includes(PROBE_URL)),
      {
        message:
          'NEGATIVE CONTROL of the instrument: a 404 on a resource nobody exempted MUST reach '
          + 'the assertion the sweeps make. If this stays empty the sweeps are blind again, '
          + 'exactly as they were before 2026-08-12, and every "no console errors" row below '
          + 'them is vacuous for load failures.',
        timeout: 15_000,
      },
    )
    .not.toEqual([]);

  // ── Leg 3: a NAMED resource 404s → benign, but still RECORDED. ───────────
  const significantBefore = errors.significant().length;
  for (const asset of OPTIONAL_RUNTIME_ASSETS) {
    await requestUrl(page, assetUrlPath(asset));
  }
  for (const asset of OPTIONAL_RUNTIME_ASSETS) {
    const urlPath = assetUrlPath(asset);
    await expect
      .poll(
        () => errors.all.filter((e) => e.url.endsWith(urlPath)).map(formatEntry),
        {
          message:
            `${asset.staticPath} must be RECORDED even though it is exempt — "no resource `
            + `failed" and "one failed and we named it" must not print the same thing`,
          timeout: 15_000,
        },
      )
      .not.toEqual([]);
  }
  expect(
    errors.significant().length,
    'the named optional assets must add NOTHING to the significant set — they are the exemption, '
    + `and the only significant line should still be the ${PROBE_URL} probe from leg 2`,
  ).toBe(significantBefore);
});
