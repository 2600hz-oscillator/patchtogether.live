// packages/web/src/lib/ui/canvas-ssr-stub.test.ts
//
// THE GATE UNDER THE `<Canvas>` SSR STUB (#2088).
//
// `vite.config.ts`'s `ssrDropBrowserOnlyGraph()` replaces `Canvas.svelte` with a
// component that renders NOTHING in the SSR build. That removed ~5.9 MB raw
// (`chunks/Canvas.js` plus everything hanging off it) from the deployed
// Cloudflare Worker, which had gone 177 KiB over Cloudflare's hard 3 MiB
// gzipped ceiling and was failing every deploy — including `main`'s.
//
// ⚠ THE STUB IS SAFE FOR EXACTLY ONE REASON, AND IT IS A REACHABILITY CLAIM:
// **no route server-renders `<Canvas>`.** `/rack` has been `ssr = false` since
// it moved off `/`; `/r/[id]` now matches it. A component never rendered on the
// server cannot contribute a byte to server HTML, so there is nothing to diff
// and nothing to lose.
//
// THAT CLAIM IS ONE COMMIT AWAY FROM BEING FALSE, AND NOTHING ELSE WOULD NOTICE.
// Add a route that imports `<Canvas>` and leaves SSR on and the stub silently
// blanks it: the server sends an empty `<div>` where the canvas belongs, the
// client hydrates over it, and in a browser it very likely LOOKS FINE. No type
// error, no build error, no size regression — the failure is invisible to every
// other gate in the repo, and it is a *correctness* failure introduced by a
// *size* optimisation. This test is that gate.
//
// ⚠ WHAT THIS GATE CANNOT SEE, stated inside the gate as the blind-gates rule
// requires:
//   * It reads SOURCE with a regex, not a module graph. A route that reaches
//     `<Canvas>` INDIRECTLY — importing a component that imports Canvas — is
//     invisible here. The Worker size ratchet (`task worker:size:check`) is the
//     backstop for that: any such edge drags Canvas.js back in and blows the
//     budget loudly.
//   * It cannot tell you the stub renders correctly, only that nobody depends
//     on it rendering at all.
//   * It only reads `src/routes/**`. A `<Canvas>` mounted from `src/lib/**` and
//     reached by a server-rendered route falls to the same size backstop.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { SSR_CANVAS_STUB } from '../../../vite.config';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(HERE, '../../routes');

/** A REAL import of Canvas.svelte — not a mention in a comment or a CSS rule. */
const CANVAS_IMPORT = /^\s*import\s+\w+\s+from\s+['"][^'"]*Canvas\.svelte['"]/m;

/** Route modules that statically import `<Canvas>`. */
function canvasImportingRoutes(): string[] {
  const files = globSync('**/*.svelte', { cwd: ROUTES }) as string[];
  return files
    .filter((rel) => CANVAS_IMPORT.test(readFileSync(resolve(ROUTES, rel), 'utf8')))
    .sort();
}

/** Does the route that owns `rel` disable SSR? Checks the page module beside it. */
function disablesSsr(rel: string): boolean {
  const dir = resolve(ROUTES, dirname(rel));
  for (const sibling of ['+page.ts', '+page.js', '+layout.ts', '+layout.js']) {
    try {
      const src = readFileSync(resolve(dir, sibling), 'utf8');
      if (/export\s+const\s+ssr\s*=\s*false/.test(src)) return true;
    } catch {
      // no such sibling — keep looking
    }
  }
  return false;
}

describe('#2088 — the <Canvas> SSR stub rests on nothing server-rendering it', () => {
  it('finds the Canvas-importing routes at all (vacuity control)', () => {
    // A gate over an empty set is green and proves nothing. If the glob, the
    // routes dir or the import pattern broke, THIS fails rather than the sweep
    // below passing silently.
    const found = canvasImportingRoutes();
    expect(found.length, `route modules importing Canvas.svelte: ${found.join(', ') || '(none)'}`)
      .toBeGreaterThan(0);
  });

  it('EVERY route that imports <Canvas> disables SSR', () => {
    const offenders = canvasImportingRoutes()
      .filter((rel) => !disablesSsr(rel))
      .sort();
    expect(
      offenders,
      'a route imports <Canvas> and still server-renders. `ssrDropBrowserOnlyGraph()` in ' +
        'vite.config.ts replaces Canvas.svelte with an EMPTY component in the SSR build, so this ' +
        'route now serves a blank canvas region as its server HTML — and it will still look ' +
        'correct in a browser once the client hydrates, which is why nothing else catches it. ' +
        'Either add `export const ssr = false` beside the route (see src/routes/rack/+page.ts ' +
        'and src/routes/r/[id]/+page.ts, which explain why the canvas cannot be server-rendered ' +
        'at all), or remove the Canvas stub and accept ~5.9 MB back into the Worker.',
    ).toEqual([]);
  });

  it('the stub renders nothing and takes any props', () => {
    // The shape claim: it must be a component (so the import site still type-
    // checks) that emits no markup (so it cannot contribute server HTML).
    expect(SSR_CANVAS_STUB).toMatch(/\$props\(\)/);
    const markup = SSR_CANVAS_STUB
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .trim();
    expect(markup, `the SSR Canvas stub must emit NO markup, got: ${JSON.stringify(markup)}`)
      .toBe('');
  });

  // ── The instrument's own negative controls ──────────────────────────────
  it('the import predicate REJECTS a mention and ACCEPTS a real import', () => {
    // Both directions. Without this, a pattern that matched nothing would look
    // identical to a tree with no offenders — and every match under
    // src/routes/** other than the two real importers IS a comment or a CSS
    // selector, so this is the exact confusion at hand.
    expect(CANVAS_IMPORT.test("  import Canvas from '$lib/ui/Canvas.svelte';")).toBe(true);
    expect(CANVAS_IMPORT.test('  // Same gate Canvas.svelte uses for the flag')).toBe(false);
    expect(CANVAS_IMPORT.test(' *     styled inline through `labelStyle` in Canvas.svelte')).toBe(false);
    expect(CANVAS_IMPORT.test('<code>Canvas.svelte</code> were rewritten')).toBe(false);
  });

  it('the ssr predicate REJECTS a route with no flag and ACCEPTS one with it', () => {
    // `disablesSsr` is the half that decides whether an offender is reported,
    // so it needs to be able to say NO. Driven through the real files rather
    // than a fixture: /rack carries the flag, and the routes root does not.
    expect(disablesSsr('rack/+page.svelte'), '/rack declares ssr = false').toBe(true);
    expect(disablesSsr('+page.svelte'), 'the landing route does NOT disable ssr').toBe(false);
  });
});
