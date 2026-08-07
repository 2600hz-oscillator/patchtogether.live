// packages/web/src/lib/ui/card-source.ts
//
// READING A CARD'S SOURCE WHEN THE CARD IS A THIN WRAPPER.
//
// Several source-level gates judge a module by grepping its card `.svelte`:
// `modules-card-map.test.ts` (no raw <Handle>, ports go through PatchPanel) and
// `vrt-cable-stripe.test.ts` (the stripe pins a --cable-* token). Both were
// written when one module meant one self-contained card file.
//
// ⚠ THE BLIND SPOT. The moment two modules share a body — `CvBuddyCard` and
// `CvBuddyMiniCard` are both four lines around `CvBuddyBody` — the wrapper
// contains no markup at all, and a gate reading only the wrapper concludes
// whatever "no markup" happens to mean for it. That is wrong in BOTH
// directions, which is what makes it worth a shared fix rather than a
// per-gate exemption:
//
//   FALSE POSITIVE — the stripe gate saw no `.stripe` in CvBuddyMiniCard and
//     reported the card as not-token-pinned. It is pinned; the pin is one
//     import away. (Caught 2026-08-07 while adding CV BUDDY MINI.)
//   FALSE NEGATIVE — the far worse one. A raw <Handle> moved into a shared
//     body becomes INVISIBLE to the PatchPanel gate, so the ban silently stops
//     applying to every module that delegates.
//
// Exempting the wrapper would have silenced the first and entrenched the
// second. Following the import closes both at once.
//
// SCOPE, stated inside the helper per the repo rule: it follows LOCAL sibling
// `./Foo.svelte` imports exactly ONE level deep. A body that itself delegates
// is not followed, and an import from another directory is not followed. It
// also concatenates rather than resolving which branch actually renders — so a
// wrapper is credited with everything its body could render, whether or not
// this `kind` renders it. Both are deliberate: a gate that over-reads a shared
// body errs toward CHECKING more, never toward checking less.

/** Minimal fs surface, injectable so the helper is testable without a disk. */
export interface CardSourceFs {
  readFileSync: (path: string, enc: 'utf8') => string;
  existsSync: (path: string) => boolean;
}

/** Sibling `./Foo.svelte` imports — the delegation form these wrappers use. */
const LOCAL_SVELTE_IMPORT = /from\s+'\.\/([A-Za-z0-9_]+\.svelte)'/g;

/**
 * Read a card's source together with any sibling `.svelte` components it
 * imports, one level deep, concatenated.
 *
 * `join` is passed in so callers keep using their own path module (the tests
 * live in different directories and already import one).
 */
export function readCardSourceWithDelegates(
  cardPath: string,
  cardDir: string,
  fs: CardSourceFs,
  join: (...parts: string[]) => string,
): string {
  const own = fs.readFileSync(cardPath, 'utf8');
  let combined = own;
  for (const m of own.matchAll(LOCAL_SVELTE_IMPORT)) {
    const sibling = join(cardDir, m[1]!);
    // Never re-read the card itself: a self-import would double the source and
    // silently double every count a caller takes off it.
    if (sibling === cardPath) continue;
    if (fs.existsSync(sibling)) combined += '\n' + fs.readFileSync(sibling, 'utf8');
  }
  return combined;
}

/** The sibling `.svelte` files a card delegates to. Exposed so a gate can say
 *  WHICH file it followed when it reports a finding — a delegated hit reported
 *  against the four-line wrapper is unactionable. */
export function delegatedSiblings(cardSource: string): string[] {
  return [...cardSource.matchAll(LOCAL_SVELTE_IMPORT)].map((m) => m[1]!);
}
