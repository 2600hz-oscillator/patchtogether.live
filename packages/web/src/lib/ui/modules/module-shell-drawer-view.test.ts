// packages/web/src/lib/ui/modules/module-shell-drawer-view.test.ts
//
// #1739 — THE SOURCE-LEVEL HALF OF THE `'drawer'` VIEW, because no runtime gate
// in this repo can see it.
//
// The change added a third member to `ShellView`. The failure mode of adding a
// member to a union that ~30 `if`s branch on is not a crash and not a type
// error: it is a SILENT DEFAULT. Every one of those sites read
// `view === 'dock-full'`, and each one that stayed that way would answer NO for
// the drawer and take the LANE branch — a 192×180 tile's plan (six of
// mixmstrs' ninety-one controls, lane knob sizes, lane cell captions) painted
// inside a full-width tray. That renders. It looks like a face. It is the
// #1681 class in a different costume: the declaration is fine and the VALUE is
// wrong.
//
// ⚠ WHY A SOURCE GATE AND NOT A UNIT TEST. This repo's unit lane is
// `environment: 'node'` and mounts no Svelte components, so there is no way to
// assert "the drawer shell rendered the dock band plan" without a browser. The
// e2e (`e2e/tests/workflow-drawer-face.spec.ts`) does assert exactly that — for
// MIXMSTRS, at the DOM level. What it CANNOT do is stop the next edit from
// re-introducing a `view === 'dock-full'` at cell site #17, on a branch that
// only some other face reaches. That is what this file is for: DENY THE SHAPE,
// not audit the outcomes.
//
// ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE, stated inside it:
//   * CSS. `.rl-tile.dock-full` and the rear-view reveal rule are stylesheets;
//     this reads one component's source.
//   * Whether `DockCardHost` mounts the shell at all, or with which view — that
//     is `dockRailRendersFace` (unit) plus the e2e.
//   * Any OTHER file that might branch on the union. It names its subject and
//     asserts only about it.
//   * Semantics: it cannot tell a correct `faceplateView` from an incorrect
//     one, only that the re-typed comparison is gone.

import { describe, expect, it } from 'vitest';

/** ModuleShell's raw source — the artifact this gate is anchored to. */
const MODULE_SHELL_SRC = Object.values(
  import.meta.glob('./ModuleShell.svelte', {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
)[0] as string;

/**
 * Strip Svelte markup comments, block comments and line comments, so PROSE
 * ABOUT a comparison can never satisfy — or violate — an anchor about the
 * comparison. The header of this very file quotes `view === 'dock-full'`
 * several times; without the stripper this gate would fail on its own
 * documentation. Mirrors `shell-extensions.test.ts`'s.
 */
function stripSourceComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every `view <op> 'dock-full'` comparison in a comment-stripped source. */
function dockFullComparisons(src: string): string[] {
  return [...src.matchAll(/view\s*[!=]==\s*'dock-full'/g)].map((m) => m[0]);
}

/**
 * THE ONE SANCTIONED COMPARISON, named by its exact declaration rather than by
 * its file.
 *
 * `jackRail` is the single question in this component whose answer really is
 * "everything except the full view": `DockFullView` owns a better patch surface
 * (flip-to-`RearCard`), the lane and the tray do not. Exempting the DECLARATION
 * — not the file, and not the identifier — means a second, un-named
 * `view !== 'dock-full'` anywhere else still reddens, and means the exemption
 * itself goes red if the declaration is renamed or deleted (asserted below).
 */
const SANCTIONED = {
  what: "let jackRail = $derived(view !== 'dock-full')",
  why:
    'the JACK RAIL is the one thing the lane and the pinned tray share and the ' +
    'full view deliberately drops — the full view has RearCard instead, the tray ' +
    'has no title bar to hang one on.',
  pattern: /let\s+jackRail\s*=\s*\$derived\(\s*view\s*!==\s*'dock-full'\s*\);?/,
} as const;

describe('ModuleShell: the faceplate question is `view !== lane`, never `=== dock-full` (#1739)', () => {
  it('the source really loaded (a glob that resolved to nothing would green everything below)', () => {
    expect(typeof MODULE_SHELL_SRC).toBe('string');
    expect(MODULE_SHELL_SRC.length).toBeGreaterThan(10_000);
    expect(MODULE_SHELL_SRC).toContain('data-testid="module-shell"');
  });

  it('the ONE sanctioned comparison still RESOLVES — an exemption naming something that is gone is RED', () => {
    const code = stripSourceComments(MODULE_SHELL_SRC);
    expect(
      SANCTIONED.pattern.test(code),
      `the named exemption ${SANCTIONED.what} no longer exists in ModuleShell. ` +
        `Delete the exemption (and check the jack rail is still gated) rather than ` +
        `leaving a ledger entry that names nothing. Why it existed: ${SANCTIONED.why}`,
    ).toBe(true);
    expect(SANCTIONED.why.length, 'an exemption without a reason is a filename').toBeGreaterThan(40);
  });

  it('NO OTHER `view === / !== \'dock-full\'` comparison survives in CODE — each one is a drawer that silently paints a lane tile', () => {
    const code = stripSourceComments(MODULE_SHELL_SRC).replace(SANCTIONED.pattern, '');
    expect(
      dockFullComparisons(code),
      'each of these is a site where the DRAWER view falls into the LANE branch. ' +
        "Use `faceplateView` (isFaceplateView — `view !== 'lane'`) for the " +
        "faceplate/tile question, or `jackRail` (`view !== 'dock-full'`) for the " +
        'jack-rail one. If you genuinely need "the full view and not the tray", ' +
        'say so with a NAMED derived flag and add it here.',
    ).toEqual([]);
  });

  it('…and the two named flags are the ones actually declared', () => {
    const code = stripSourceComments(MODULE_SHELL_SRC);
    // Anchored to the DECLARATIONS, so renaming either flag without updating
    // this gate is red rather than silently unguarded.
    expect(code, 'the faceplate flag must be derived from the shared predicate').toMatch(
      /let\s+faceplateView\s*=\s*\$derived\(\s*isFaceplateView\(view\)\s*\)/,
    );
    expect(code, 'the jack-rail flag must exclude ONLY the full view').toMatch(
      /let\s+jackRail\s*=\s*\$derived\(\s*view\s*!==\s*'dock-full'\s*\)/,
    );
    expect(code, 'the jack rail must actually be GATED on that flag').toMatch(/\{#if\s+jackRail\}/);
    // The tab roster is asked with the VIEW, so "is this face tabbed" keeps one
    // authority (a hide with no rail is a blank faceplate — dock-tabs-model).
    expect(code, 'dockTabPlan must receive the view').toMatch(/dockTabPlan\(\s*dockBands\s*,\s*view\s*\)/);
    // The host is identifiable from the DOM, which is what the e2e selects on.
    expect(code).toContain('data-shell-view={view}');
  });

  it('NEGATIVE CONTROL (both directions): the detector fires on a re-typed comparison and the stripper really strips', () => {
    // Direction 1 — the predicate CAN find offenders. Without this the clause
    // above would pass identically if the regex matched nothing ever.
    const reIntroduced = `let x = $derived(view === 'dock-full' ? 'dock' : 'lane');
      let y = $derived(view !== 'dock-full');`;
    expect(dockFullComparisons(reIntroduced)).toHaveLength(2);

    // Direction 2 — and it does NOT fire on prose, which is why the real check
    // strips first. (This file's own header is full of the phrase.)
    const proseOnly = `// the old form was view === 'dock-full', do not re-add it
      <!-- view === 'dock-full' in markup prose -->
      /* view !== 'dock-full' in a block comment */
      let ok = $derived(isFaceplateView(view));`;
    expect(dockFullComparisons(stripSourceComments(proseOnly))).toEqual([]);
    // …and the stripper is not a no-op on the real file either.
    expect(stripSourceComments(MODULE_SHELL_SRC).length).toBeLessThan(MODULE_SHELL_SRC.length);
    // The real file DOES still discuss the old form in prose, so the two
    // directions above are both exercised by the artifact and not only by
    // fixtures.
    expect(dockFullComparisons(MODULE_SHELL_SRC).length).toBeGreaterThan(0);

    // Direction 3 — the EXEMPTION is a hole of exactly one shape. A second
    // `view !== 'dock-full'` beside the sanctioned declaration still reddens,
    // which is what "deny by default with a named exemption" has to mean.
    const twoOfThem = `let jackRail = $derived(view !== 'dock-full');
      let sneaky = $derived(view !== 'dock-full');`;
    expect(dockFullComparisons(twoOfThem.replace(SANCTIONED.pattern, ''))).toHaveLength(1);
  });
});
