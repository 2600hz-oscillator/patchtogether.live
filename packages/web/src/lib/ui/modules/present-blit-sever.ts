// present-blit-sever.ts
//
// THE NEGATIVE CONTROL FOR THE PROJECTOR CONTINUITY GATE — a committed,
// env-gated way to cut the opener→sink blit so a test can prove its probe is
// capable of going RED.
//
// WHY THIS EXISTS. The continuity assertion for "the projector is still live"
// was, everywhere it was written down, a FRAME COUNTER — and the blit it counts
// black-fills the sink canvas unconditionally (present-window.ts) and swallows
// draw errors by design (a lost GL context is something the pipeline absorbs on
// purpose; node-present-registry.test.ts pins that). So a projector that is
// open, correctly identified, pulling frames on schedule and painting PURE
// BLACK satisfied every visual assertion in the system. The gate could not fail.
//
// A probe you have never seen fail is not an instrument, it is a decoration.
// This is the lever that makes it fail on demand: with `__severPresentBlit(true)`
// the frame loop reads a null source, so the sink goes black and STAYS black
// through any change to the graph. A continuity test that still passes with the
// blit cut is measuring something other than the projector.
//
// ⚠ IT IS COMMITTED, NOT SKIPPED. A forced-failure path that lives only in a
// disabled test rots invisibly; this one is compiled into every dev / e2e build
// and exercised by the gate on every run. In a real production build
// `testHooksEnabled()` is false, `severed` can never be set, and the read below
// is a constant-false branch.
//
// ⚠ THE `typeof window` GUARD IS NOT SUFFICIENT IN THIS REPO — the web package's
// vitest runs under `environment: 'node'`, where sibling suites install PARTIAL
// window stubs on globalThis, and a module-scope side effect that assumes
// `addEventListener`/property assignment works has taken four files down at
// IMPORT before now (see node-present-registry.svelte.ts's header). Probe the
// capability, never the object, and never throw during import.

// ⚠ RELATIVE, NOT `$lib/…`. present-window.ts (which imports this) is also
// loaded by `scripts/present-shell-features-contract.test.ts` under the ROOT
// vitest config, where no `$lib` alias exists — an aliased import here fails
// that suite at module load with "Does the file exist?", nowhere near the
// change that caused it.
import { testHooksEnabled } from '../../dev/test-hooks';

let severed = false;

/** True while the forced-failure hook has cut the blit. Always false in a build
 *  without test hooks — the setter is never installed there. */
export function presentBlitSevered(): boolean {
  return severed;
}

/** Direct seam for unit tests, which drive `startPresent` in node with no
 *  window at all. The e2e drives the window global installed below. */
export function setPresentBlitSevered(on: boolean): void {
  if (!testHooksEnabled()) return;
  severed = on;
}

export interface PresentSeverHost {
  __severPresentBlit?: (on?: boolean) => void;
}

if (testHooksEnabled()) {
  try {
    const host = globalThis as unknown as PresentSeverHost;
    Object.defineProperty(host, '__severPresentBlit', {
      value: (on = true) => {
        severed = on === true;
      },
      configurable: true,
      writable: true,
    });
  } catch {
    /* an exotic realm that refuses property definition — the seam above still works */
  }
}
