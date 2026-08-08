// packages/web/src/lib/ui/modules-card-components.ssr-stub.test.ts
//
// Guards the SSR card-drop seam (vite.config.ts `ssrDropCardComponents()`).
//
// The plugin replaces `modules-card-components.ts` with
// `export const componentByName = {}` in the SERVER build, which is worth
// ~490 KiB gzipped in the Cloudflare Worker. Two things have to stay true for
// that to be safe, and neither is visible to any other gate:
//
//   1. The eager `./modules/*Card.svelte` glob has EXACTLY ONE home. A second
//      importer anywhere in `src/` would pull all ~210 cards straight back into
//      the Worker through whatever server-reachable module referenced it, and
//      the size regression would be silent.
//   2. The stub's shape matches the real module's public shape — one named
//      export, `componentByName`. A rename on one side alone yields either a
//      build error at the far end of a 25-minute CI run, or (worse) a live map
//      that is quietly always empty.
//
// This is a SOURCE-level gate on purpose: the plugin only fires in the SSR
// build, so nothing at unit-test runtime can observe it. That is the same
// reasoning as the card-range grep in module-docs-lint.test.ts — a gate that
// reads only the runtime side of a build-time contract proves nothing.

import { describe, it, expect } from 'vitest';
import { componentByName } from './modules-card-components';
import { SSR_CARD_COMPONENTS_STUB } from '../../../vite.config';

// Every source file in src/, read at build time by Vite. Same idiom as
// mutate.guard.test.ts — no fs access, works identically in CI.
const SOURCES = import.meta.glob('../**/*.{ts,svelte}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The one file allowed to hold the eager card glob. */
const GLOB_HOME = 'modules-card-components.ts';

describe('SSR card-drop seam', () => {
  it('reads a non-trivial number of source files (the glob itself is not broken)', () => {
    // Negative control for this file's own instrument: if the glob silently
    // matched nothing, every assertion below would vacuously pass.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(500);
  });

  it('the eager *Card.svelte glob lives in exactly one module', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith(GLOB_HOME) && !path.includes('.test.'))
      .filter(([, src]) => /import\.meta\.glob[\s\S]{0,200}?\*Card\.svelte/.test(src))
      .map(([path]) => path);

    expect(
      offenders,
      `A second eager card glob defeats the SSR card-drop in vite.config.ts and puts ` +
        `~490 KiB gzipped back into the Cloudflare Worker (3 MiB ceiling). Import ` +
        `\`componentByName\` from $lib/ui/${GLOB_HOME} instead.`,
    ).toEqual([]);
  });

  it('the real module exports the card map the stub replaces', () => {
    expect(typeof componentByName).toBe('object');
    // The unit lane is a CLIENT-side resolve, so the real glob is in effect
    // here; the stub only ever applies to `vite build`'s ssr environment.
    expect(Object.keys(componentByName).length).toBeGreaterThan(150);
  });

  it('the SSR stub declares the same public shape as the real module', () => {
    const exported = [...SSR_CARD_COMPONENTS_STUB.matchAll(/export const (\w+)/g)].map(
      (m) => m[1],
    );
    expect(exported).toEqual(['componentByName']);

    const realSource = SOURCES[`../ui/${GLOB_HOME}`] ?? SOURCES[`./${GLOB_HOME}`];
    expect(realSource, `could not read ${GLOB_HOME} through the source glob`).toBeTruthy();
    const realExports = [...realSource.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
    expect(realExports).toEqual(exported);
  });
});
