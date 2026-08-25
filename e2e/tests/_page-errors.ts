// e2e/tests/_page-errors.ts
//
// THE one place that decides which page/console errors a coverage sweep is
// allowed to ignore.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS: a filter that swallowed the ONLY evidence of a dead module
// ─────────────────────────────────────────────────────────────────────────────
//
// The registry sweeps (per-module-per-port, per-module-per-port-behavioral)
// each kept a private `filterErrors()` whose fifth clause was
//
//     && !e.includes('Failed to load resource')
//
// — an unconditional, unnamed drop of EVERY failed subresource load.
//
// MEASURED 2026-08-12 against the live registry (re-derive with
// `npx playwright test --list tests/per-module-per-port.spec.ts
// tests/per-module-per-port-behavioral.spec.ts` and partition the rows by
// describe block, counting the ones NOT marked `[SKIPPED:`): 173 `inputs accept
// signal` tests are live, and for ALL of them the console-error assertion is
// the ONLY assertion that could observe a module failing to LOAD (the other
// assertion, `edgeIds.toContain('e-up-sut')`, reads the patch store — a graph
// edge materialises whether or not the engine behind it ever came up). 58
// module types have no OTHER live per-port dimension at all (no live
// outputs-emit row, no live behavioral row), so for those the swallowed message
// was the entire net.
//
// The failure mode is not hypothetical. MEASURED, by 404ing exactly one worklet
// (`packages/dsp/dist/lfo.js`) with a Playwright route and spawning `lfo`:
//
//   console error : "Failed to load resource: the server responded with a
//                    status of 404 (Not Found)"
//   location().url: ".../packages/dsp/dist/lfo.js?url"
//
// The message text carries NO url — it is identical for every failed resource
// in the product. So the old filter could not have distinguished a dead worklet
// from a missing optional asset even in principle, and the two specs never
// recorded `location()`, so the url was thrown away before the filter ran. That
// is the shape audited on 2026-08-02: a filter applied before the check that
// quietly redefines the check's subject.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIX: capture the url, then exempt BY NAMED RESOURCE
// ─────────────────────────────────────────────────────────────────────────────
//
// `collectPageErrors()` records `location().url` alongside the text, so a
// resource failure is attributable. `significant()` then denies by default: a
// failed load is benign only when the resource is one of the NAMED optional
// runtime assets below. A dead worklet, a dropped static file, a mistyped
// asset path — none of them are on that list, so all of them now go red.
//
// ⚠ STATED SCOPE — what this still cannot see. The channel is Chrome's console.
// A request that fails WITHOUT Chrome reporting it there is invisible here:
// measured on the same run, an aborted SvelteKit `__data.json` navigation
// preload raises `requestfailed` and logs nothing, and `fetch()` rejections are
// reported by the calling code, not by the loader. A 404 on a `<script>`, an
// `<img>`, a stylesheet, a dynamic `import()` or an `audioWorklet.addModule()`
// IS reported (the worklet case is the one measured above and is the bug class
// this file exists for). Widening to a `response` listener was considered and
// declined: on the live registry it would have found exactly the same single
// resource (see OPTIONAL_RUNTIME_ASSETS) while adding every third-party 4xx to
// the sweep's flake surface.

import type { ConsoleMessage, Page } from '@playwright/test';

// ────────── Named optional runtime assets ──────────
//
// DENY BY DEFAULT. A failed resource load is benign ONLY if its url resolves to
// one of these, named one artifact at a time — never a substring of the
// message, which is the same for every resource in the product.
//
// Each entry is ANCHORED to the tree by `page-error-filter.spec.ts`: the asset
// must still be matched by a `.gitignore` rule, i.e. it must still be an
// OPTIONAL, developer-supplied artifact. Commit one (or rename it) and the
// exemption naming it goes RED rather than silently covering a resource that is
// now expected to be present.

export interface OptionalRuntimeAsset {
  /** Repo path of the asset, always under `STATIC_ROOT`. The url the browser
   *  requests is DERIVED from this (see `assetUrlPath`) so the two cannot
   *  drift apart. */
  staticPath: string;
  /** Why a request for this asset may legitimately 404 in a test run. */
  why: string;
}

/** Everything under here is served at the site root by SvelteKit. */
export const STATIC_ROOT = 'packages/web/static';

export const OPTIONAL_RUNTIME_ASSETS: readonly OptionalRuntimeAsset[] = [
  {
    staticPath: `${STATIC_ROOT}/doom/doom.js`,
    why:
      'DOOM emscripten shim — built on demand by packages/web/native/build-doom-wasm.sh, '
      + 'gitignored. CI builds it in the build-web job; a local checkout that has not run '
      + 'the script serves a 404 and the DOOM card shows its documented "WASM not built" '
      + 'idle state. Requested by $lib/doom/doom-runtime.ts (WASM_SHIM_URL).',
  },
  {
    staticPath: `${STATIC_ROOT}/doom/doom.wasm`,
    why:
      'DOOM WASM binary, sibling of doom.js — same build script, same gitignore, fetched '
      + 'by the emscripten shim once doom.js loads.',
  },
  {
    staticPath: `${STATIC_ROOT}/doom/DOOM1.WAD`,
    why:
      'DOOM shareware game data — user-downloaded (static/doom/DOWNLOAD_INSTRUCTIONS.md), '
      + 'gitignored. CI fetches it in build-web. Absent locally, so DOOM idles and '
      + 'GIBRIBBON falls back to its line-art figures by design (loadWad() in '
      + '$lib/doom/doom-runtime.ts). This is the ONLY resource that 404s across a '
      + 'bare-spawn sweep of the whole registry — measured 2026-08-12, one module '
      + '(gibribbon), on the dev server.',
  },
];

/** The url path the browser requests for an optional asset — DERIVED from
 *  `staticPath`, never typed twice. */
export function assetUrlPath(asset: OptionalRuntimeAsset): string {
  return asset.staticPath.slice(STATIC_ROOT.length);
}

/** The `.gitignore`-relative path for an optional asset — also derived. The
 *  DOOM rules live in `packages/web/.gitignore`, so the prefix comes off. */
export function assetGitignorePath(asset: OptionalRuntimeAsset): string {
  return asset.staticPath.replace(/^packages\/web\//, '');
}

/** The optional asset a url refers to, or null. Matches on PATH so a query
 *  string, a dev-server `/@fs/` prefix or a hashed origin cannot smuggle a
 *  different resource in under an exempt name. */
export function optionalAssetForUrl(url: string): OptionalRuntimeAsset | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  return OPTIONAL_RUNTIME_ASSETS.find((a) => pathname === assetUrlPath(a)) ?? null;
}

// ────────── Captured events ──────────

export interface PageErrorEntry {
  kind: 'console' | 'pageerror';
  text: string;
  /** `location().url` for a console error — for a failed subresource load this
   *  IS the resource that failed. Empty for `pageerror`. */
  url: string;
}

/** One-line rendering used in assertion messages. The url is included so a red
 *  run names the resource instead of printing the same generic sentence every
 *  failed load produces. */
export function formatEntry(e: PageErrorEntry): string {
  return e.url ? `${e.kind}: ${e.text} [${e.url}]` : `${e.kind}: ${e.text}`;
}

// ────────── The predicate ──────────
//
// Benign classes OTHER than resource loads, unchanged from the two private
// copies this replaces:
//   * AudioContext autoplay warnings.
//   * Vite HMR chatter.
//   * the reconciler's "disconnect (output 0) is not connected" teardown error
//     — a known race when spawnPatch wipes + rebuilds the graph mid-tick (the
//     reconciler disconnects an already-disconnected AudioNode). The
//     reconcile-failed path re-syncs on the next tick. Pinned by the
//     reconciler-disconnect-* unit tests in packages/web.

const RESOURCE_LOAD_FAILURE = 'Failed to load resource';

export function isBenign(entry: PageErrorEntry): boolean {
  const { text } = entry;
  if (text.includes('AudioContext')) return true;
  if (text.includes('[vite]')) return true;
  if (text.includes('[reconciler] reconcile failed') && text.includes('disconnect')) return true;

  // A FAILED RESOURCE LOAD is benign only when the resource is named above.
  if (text.includes(RESOURCE_LOAD_FAILURE)) return optionalAssetForUrl(entry.url) !== null;

  // A message that NAMES an optional asset in its own text — e.g. DOOM's
  // "DOOM WASM not built. Run `bash …` to generate /doom/doom.js + doom.wasm."
  // This is the `doom.js` / `DOOM1.WAD` clause the two private filters already
  // carried; it is kept verbatim in EFFECT but re-homed onto the same named,
  // gitignore-anchored list, so it can no longer be a bare substring nobody
  // owns. It deliberately does NOT apply to `Failed to load resource`, whose
  // text never contains a url (handled above, by url).
  return OPTIONAL_RUNTIME_ASSETS.some((a) => text.includes(assetUrlPath(a)));
}

// ────────── The collector ──────────

export interface PageErrorCollector {
  /** EVERYTHING captured, benign included — so "no resource failed" and "one
   *  failed and we exempted it" stay distinguishable from the outside. */
  readonly all: readonly PageErrorEntry[];
  /** The lines a sweep asserts `toEqual([])` on. */
  significant(): string[];
  /**
   * Detach the listeners this collector attached.
   *
   * ⚠ REQUIRED WHEN THE PAGE OUTLIVES THE TEST. On a test-scoped page the page
   * is discarded at teardown and the listeners go with it, so nothing ever
   * needed this. A worker-scoped rack session (support/rack-session.ts) reuses
   * ONE page across every row in the file, and there an un-disposed collector
   * is two compounding bugs rather than a leak: the Nth row runs with N
   * listener pairs attached, and — the part that changes a RESULT — row N's
   * `all` keeps growing from rows N+1.., so a later row's error is attributed
   * to an earlier row that had already passed. That reads as a flaky assertion
   * in a test that is not the one at fault.
   */
  dispose(): void;
}

/** Attach console + pageerror listeners and return the collector. Call BEFORE
 *  the first `page.goto`. Dispose it when the page outlives the test. */
export function collectPageErrors(page: Page): PageErrorCollector {
  const all: PageErrorEntry[] = [];
  const onPageError = (e: Error): void => {
    all.push({ kind: 'pageerror', text: e.message, url: '' });
  };
  const onConsole = (m: ConsoleMessage): void => {
    if (m.type() !== 'error') return;
    all.push({ kind: 'console', text: m.text(), url: m.location()?.url ?? '' });
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  return {
    all,
    significant: () => all.filter((e) => !isBenign(e)).map(formatEntry),
    dispose: () => {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
    },
  };
}
