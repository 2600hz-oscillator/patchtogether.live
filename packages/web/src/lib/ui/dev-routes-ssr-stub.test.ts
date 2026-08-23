// packages/web/src/lib/ui/dev-routes-ssr-stub.test.ts
//
// THE GATE UNDER THE `/dev/**` SSR STUB (#2094).
//
// `vite.config.ts`'s `ssrDropBrowserOnlyGraph()` replaces every `.svelte` file
// under `src/routes/dev/` with the empty component in the SSR build. That
// removed the largest single ROUTE input from the deployed Cloudflare Worker
// (`entries/pages/dev/video-patch-drop/_page.svelte.js`, 222 KiB, plus the
// `chunks/peakstate.js` graph behind it).
//
// ⚠ THE STUB IS SAFE FOR EXACTLY ONE REASON, AND IT IS A REACHABILITY CLAIM:
// `src/routes/dev/+layout.ts` declares `ssr = false` for the WHOLE subtree, so
// no /dev page component is ever rendered on the server. Delete or weaken that
// flag and the stub silently blanks every /dev page's server render — no type
// error, no build error, no size change. This test pins the PAIR: the flag and
// the stub stand together or the gate goes red naming the coupling.
//
// ⚠ WHAT THIS GATE CANNOT SEE, stated inside the gate as the blind-gates rule
// requires:
//   * It reads SOURCE, not the built bundle. Whether the stub actually kept the
//     dev graph out of the Worker is the size ratchet's job
//     (`task worker:size:check`) — a new server-reachable edge into a dev page
//     blows the 630 KiB budget loudly.
//   * A dev page reached from a NON-dev, server-rendered route (importing a
//     dev component directly) bypasses both the flag and this test; the same
//     size backstop is the net.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../../..');

describe('the /dev/** SSR stub and its precondition stand together (#2094)', () => {
  it('routes/dev/+layout.ts declares ssr = false for the whole subtree', () => {
    const src = readFileSync(resolve(WEB, 'src/routes/dev/+layout.ts'), 'utf8');
    expect(src).toMatch(/export\s+const\s+ssr\s*=\s*false/);
  });

  it('vite.config.ts stubs .svelte files under the dev routes dir in the SSR build', () => {
    const src = readFileSync(resolve(WEB, 'vite.config.ts'), 'utf8');
    // The dir constant and the stub branch — both, so neither half can be
    // deleted while the other silently keeps (or loses) the behavior.
    expect(src).toMatch(/DEV_ROUTES_DIR\s*=\s*'src\/routes\/dev'/);
    expect(src).toMatch(/DEV_ROUTES_TARGET.*\.svelte.*SSR_CANVAS_STUB|startsWith\(DEV_ROUTES_TARGET\)/);
  });

  it("NEGATIVE CONTROL: a dev page component exists for the stub to apply to", () => {
    // If /dev/** is ever deleted wholesale, both halves above become
    // decoration — this leg makes the whole gate fail RED so it is removed
    // together with the routes it guards, not left green and meaningless.
    const probe = resolve(WEB, 'src/routes/dev/video-patch-drop/+page.svelte');
    expect(() => readFileSync(probe, 'utf8')).not.toThrow();
  });
});
