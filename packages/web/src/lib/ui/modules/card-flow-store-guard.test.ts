// packages/web/src/lib/ui/modules/card-flow-store-guard.test.ts
//
// THE SOURCE-LEVEL GUARD FOR "A CARD CALLS `useStore()` BARE".
//
// `useStore()` from `@xyflow/svelte` reads component context and THROWS when
// the component is not inside a `<SvelteFlow>` provider. In a card's init that
// throw aborts the Svelte flush mid-render, and the observable is never a
// stack trace in a test report — it is a surface that quietly renders the
// wrong thing:
//
//   * DockFullView's occupant swap keeps the PREVIOUS module ("expand B while
//     A is open switched nothing") — the case `card-kit.captureFlowStore`'s
//     docstring was written for;
//   * a plain-mounted video card mounts with no picture at all;
//   * a card kept alive by `HeadlessSourceHost` for its DOM source never runs
//     its `onMount`, so the source it exists to attach is never attached.
//
// THREE PLAIN-MOUNT SURFACES EXIST TODAY — DockFullView's un-migrated branch,
// DockCardHost (the dock rail), and the AudioIoSurface/CameraSurface hosts —
// so "this card is only ever on the canvas" is a claim about the whole app's
// routing, not about the card, and it goes stale the day a module is faced.
// `captureFlowStore()` is the self-gate: identical inside a provider, `null`
// outside, and every consumer downstream (card-resize) already types the null.
//
// WHY A TEXT GATE. There is no runtime gate that can see this. A throw in init
// is caught by whatever renders the card, so the card simply is not there —
// and no snapshot, parity sweep or typecheck can distinguish "mounted and
// empty" from "never mounted". The divergence is only visible in the SOURCE,
// which is the same argument `card-range-source.test.ts` makes for the
// literal-range class, and this file is deliberately its sibling in shape.
//
// DENY BY DEFAULT, NO POPULATION COUNT. The assertion is unconditional
// (`toEqual([])`), so there is no ceiling to go stale and no literal for a
// concurrent merge to get wrong. A card that genuinely must throw would need a
// NAMED (file, why) exemption added here; none exists, and the empty list is
// the honest statement that none is warranted.
//
// ⚠ WHAT THIS GATE CANNOT SEE, stated rather than assumed: it reads
// `lib/ui/modules/**.svelte` only. A component OUTSIDE that tree that a card
// mounts (a `<X>Surface.svelte` under `lib/ui/workflow`, say) can call
// `useStore()` bare and is invisible here — `FlowBridge.svelte` and
// `PatchPanel.svelte` both live outside it, and PatchPanel already carries its
// own hand-rolled self-gate for exactly this reason. Widening the scan is the
// obvious next move if a defect ever lands there; it has not, so the scope is
// declared instead of pre-emptively widened.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CARD_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * A BARE `useStore()` CALL. Matches the call, not the import: importing the
 * type (`type FlowStore = ReturnType<typeof useStore>` in card-resize) is
 * fine, and so is `card-kit`'s own single guarded call — which is why the
 * helper's own file is the one named exemption below.
 *
 * ⚠ THE `\(` IS LOAD-BEARING. An earlier draft of this predicate matched the
 * bare identifier, which made `ReturnType<typeof useStore>` an offender and
 * would have pushed the next author to weaken the whole rule rather than the
 * one false positive. The negative control below feeds it both forms.
 */
const BARE_USE_STORE = /(?<![.\w])useStore\s*\(/;

/**
 * THE NAMED EXEMPTIONS, as `(file, why)` pairs rather than a filename list —
 * deny-by-default, so a NEW bare call in an already-listed file is still red,
 * and the anchor below fails the moment a name stops needing its exemption.
 * There is no count here and there must never be one.
 */
const ALLOWED: readonly { file: string; why: string }[] = [
  {
    file: 'card-kit.ts',
    why: 'captureFlowStore() IS the try/catch self-gate — the one call that is allowed to throw, because it catches',
  },
  {
    // ⚠ THE ONE PIECE OF REAL DEBT HERE, and it is the narrow legitimate kind:
    // it cannot be paid without a trusted-machine GPU window. MEASURED by
    // bisecting the real basis on 2026-08-11 — bare, the tree hashes
    // `9fc8fd6f…` (a committed record in ci-webgl-attest/); with
    // `captureFlowStore()` it hashes `e9e72c88…` (no record, and CI's
    // webgl-attest prints exactly that refusal). A one-line hardening swap is
    // not worth a ~10-minute re-attest inside a face PR, and the defect is not
    // currently reachable for this module: wavesculpt is in STRICT_FACES, so
    // DockFullView renders the faceplate rather than plain-mounting the card,
    // and HeadlessSourceHost mounts it inside its own <SvelteFlow>. Probed
    // with console + pageerror listeners in both `?shell=1` and
    // `?shell=legacy`, single pane and split: zero errors.
    //
    // DELETION CRITERIA: the next PR that legitimately re-attests WebGL swaps
    // the call and deletes this entry. The anchor below is what makes that
    // mechanical — it goes RED if the entry outlives the bare call.
    file: 'WavesculptCard.svelte',
    why: 'in the WebGL attest basis: swapping to captureFlowStore() moves the hash 9fc8fd6f… → e9e72c88… and demands a trusted-machine GPU re-attest; not reachable today (STRICT_FACES ⇒ the dock renders the faceplate, HeadlessSourceHost provides a provider)',
  },
];

function sourcesUnder(dir: string, exts: readonly string[]): { file: string; src: string }[] {
  return readdirSync(dir)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .sort()
    .map((file) => ({ file, src: readFileSync(resolve(dir, file), 'utf8') }));
}

/**
 * THE PREDICATE. One function, called by the check AND by every control — a
 * re-typed copy in the self-test is how the previous generation of these gates
 * went blind.
 *
 * ⚠ IT STRIPS COMMENT LINES FIRST, and finding out why is worth the four
 * lines. The first draft matched raw source and immediately flagged
 * `WavesculptCard.svelte` — on the comment ABOVE the fix, which explains what
 * a bare `useStore()` does. A gate that reddens on prose describing the bug it
 * prevents trains the next author to weaken the rule.
 *
 * ⚠ AND IT STRIPS WHOLE LINES, NEVER MID-LINE. CLAUDE.md's warning is exact —
 * a `//`-stripping regex eats `'https://x'`, `` `a // b` `` and `/[//]/`. A
 * line whose TRIMMED start is `//` cannot be code, so dropping it needs no
 * parser. The residue is an inline trailing comment (`const x = 1; //
 * useStore()`), which would still read as an offender; that is the safe
 * direction (a false positive on a comment, never a miss on a call) and no
 * source in the tree has one.
 */
function callsUseStoreBare(src: string): boolean {
  const code = src
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--'));
    })
    .join('\n');
  return BARE_USE_STORE.test(code);
}

describe('no card calls useStore() bare — it throws outside the SvelteFlow provider', () => {
  it('every card and helper in lib/ui/modules routes through captureFlowStore()', () => {
    const allowed = new Set(ALLOWED.map((a) => a.file));
    const offenders = sourcesUnder(CARD_DIR, ['.svelte', '.ts'])
      .filter(({ file }) => !file.endsWith('.test.ts'))
      .filter(({ file, src }) => !allowed.has(file) && callsUseStoreBare(src))
      .map(({ file }) => file);
    expect(
      offenders,
      'these mount OUTSIDE a <SvelteFlow> provider on the dock full-view / rail / headless-source paths, where a bare useStore() throws in init and the surface renders the WRONG occupant with no error anywhere. Use captureFlowStore() from ./card-kit.',
    ).toEqual([]);
  });

  it('ANCHOR — every named exemption still exists and still needs the exemption', () => {
    const byFile = new Map(sourcesUnder(CARD_DIR, ['.svelte', '.ts']).map((s) => [s.file, s.src]));
    for (const { file, why } of ALLOWED) {
      const src = byFile.get(file);
      expect(src, `exemption names ${file}, which no longer exists — a stale exemption is one nobody is watching`).toBeDefined();
      expect(callsUseStoreBare(src!), `${file} no longer calls useStore() bare (${why}) — drop the exemption`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL — the predicate fires on a bare call and NOT on the type-only use', () => {
    // Both directions, on every run, through the SAME predicate the check calls.
    expect(callsUseStoreBare('  const flowStore = useStore();')).toBe(true);
    expect(callsUseStoreBare('const s = useStore()')).toBe(true);
    // …and the two shapes that must stay legal, or the rule gets weakened
    // instead of the false positive getting fixed.
    expect(callsUseStoreBare('type FlowStore = ReturnType<typeof useStore>;')).toBe(false);
    expect(callsUseStoreBare("import { useStore } from '@xyflow/svelte';")).toBe(false);
    expect(callsUseStoreBare('const flowStore = captureFlowStore();')).toBe(false);
    // …and the shape that actually reddened the first draft: PROSE about the
    // bug, in the file that fixed it. This leg is why the stripper exists.
    expect(callsUseStoreBare('  // a bare useStore() THROWS outside the provider')).toBe(false);
    expect(callsUseStoreBare('   *  An un-guarded useStore() in a card init THREW')).toBe(false);
    // …but a comment must not be able to HIDE a call on a later line.
    expect(
      callsUseStoreBare('// useStore() is dangerous\nconst flowStore = useStore();'),
    ).toBe(true);
  });

  it('POSITIVE CONTROL — the sweep CAN see a real bare call in a real file', () => {
    // Without this the sweep's green is ambiguous: "no offenders" and "the scan
    // matched nothing at all" print identically. `WavesculptCard.svelte` is a
    // real tracked source that really does call it bare (see its exemption
    // above), so the predicate is proven against the tree and not only against
    // the synthetic strings in the leg before this one.
    //
    // ⚠ THIS LEG INVERTS THE DAY THE DEBT IS PAID, and that is intended: when
    // the re-attest lands and the card swaps to captureFlowStore(), the ANCHOR
    // goes red first and points at the exemption. Re-aim this leg at whatever
    // file is then the honest positive control, or delete it with the entry.
    const src = readFileSync(resolve(CARD_DIR, 'WavesculptCard.svelte'), 'utf8');
    expect(callsUseStoreBare(src), 'the scan reads real files, not just fixtures').toBe(true);
  });
});
