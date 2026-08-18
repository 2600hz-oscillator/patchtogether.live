// packages/web/src/lib/ui/controls/one-fader-source.test.ts
//
// THERE IS ONE THROW, AND A NEW FACE CANNOT QUIETLY GO BACK TO THE OLD ONE.
//
// Owner directive, 2026-08-17: *"we should be using our new mxmsters faders for
// everything like this, in all cases"* … *"all the old style faders need to be
// replaced with the new ones, new faces we do should always have the new fader
// style"* (#1794).
//
// ── WHY A SOURCE GATE, WHEN THE OLD FILE IS DELETED ───────────────────────
//
// Deleting `Fader.svelte` makes a stale `import Fader from …` a build error, and
// that covers the careless case. It does NOT cover the two ways this actually
// comes back:
//
//   1. A new control file named `Fader.svelte` (or a card-local `<Fader>`
//      component) re-created from the git history because someone wanted "the
//      simple grey one" for a dense card. Nothing about that fails to compile.
//   2. The DEAD TOKEN class. `console.css` fed `--fader-track-bg` /
//      `--fader-thumb-bg` / … to the old control; `NeonFader` reads none of
//      them. A rule re-declaring one paints NOTHING, and — measured on the real
//      tree — an assertion READING one still passed, because custom properties
//      inherit to an element that ignores them. That is a green assertion about
//      a variable with no consumer, and it survived in
//      `workflow-drawer-face.spec.ts` until #1794 went looking.
//
// ── THE SHAPE, LIFTED FROM `card-range-source.test.ts` ────────────────────
//
// Deny by default; a NAMED exemption per instance carrying its `why`; anchored
// to the ARTIFACT so an entry naming a file that no longer exists is RED. And,
// as there, the read goes through the SHARED quote-aware comment stripper: this
// gate forbids `<Fader`, and "we replaced the `<Fader>` mounts" is the natural
// way to WRITE DOWN that a card was migrated. A raw grep flags the explanation
// as the offence — and this file's own header would be the first casualty.
//
// ⚠ STATED SCOPE — WHAT THIS GATE STRUCTURALLY CANNOT SEE:
//   * A HAND-ROLLED throw. A card that draws its own `<div>` slot with a
//     pointerdown handler is a fader to a user and is invisible here. The gate
//     reads TAG NAMES, so it can only police the named primitives.
//   * RENDERED PIXELS. A `<NeonFader>` styled back to grey by a card-local rule
//     passes every clause below. VRT is that check.
//   * NON-SVELTE surfaces. Push 2 / Electra / Launchpad render their own
//     controls; "the fader style" is a screen concept and does not reach them.
//   * WHETHER A PARAM SHOULD BE A THROW AT ALL. That is `face.paramCells`, and
//     `module-face-lint.test.ts` is where it is argued.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSourceComments } from '$lib/source-guards/strip-source-comments';

/** `packages/web/src` — every Svelte surface the app ships. */
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTROLS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Files allowed to mount the retired control, each with its reason.
 *
 * EMPTY, and that is the intended steady state: the migration was complete when
 * it landed, so there is nothing to grandfather. It exists as the named seam —
 * an exemption is a `(file, why)` pair somebody has to write and defend, not a
 * regex someone widens.
 */
const ALLOWED_LEGACY_FADER: Readonly<Record<string, string>> = {};

/** Every `.svelte` under `packages/web/src`, as (relative path, source) pairs. */
function allSvelteSources(): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(p);
      } else if (entry.name.endsWith('.svelte')) {
        out.push({ file: relative(SRC_ROOT, p), src: stripSourceComments(readFileSync(p, 'utf8')) });
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

/**
 * A mount of the RETIRED control.
 *
 * ⚠ TWO THINGS THE PATTERN HAS TO GET RIGHT AT ONCE, AND THE FIRST DRAFT GOT
 * ONE OF THEM WRONG.
 *
 * (a) It must NOT match the surviving control. `<NeonFader` contains the
 *     substring `Fader`, so the `<` immediately before the name is what
 *     separates them — a bare `/Fader/` would flag every correct call site.
 * (b) It must match the MULTI-LINE form. The draft was `/<Fader(?=[\s/>])/`,
 *     which reads as "followed by a space, a slash or a close" — and the scan
 *     below walks LINE BY LINE, so on the shape nearly every real card used:
 *
 *         <Fader
 *           value={v}
 *
 *     there is nothing after `<Fader` on that line and the lookahead FAILED.
 *     The gate would have been blind to the commonest form of the regression it
 *     exists to catch, while passing its own suite. The positive control at the
 *     bottom is what surfaced it; it now carries the multi-line shape as a
 *     permanent case.
 *
 * A negative CHARACTER-CLASS lookahead answers both: `<Fader` not followed by
 * another identifier character. End-of-line satisfies it, `<FaderRow` does not,
 * and `<NeonFader` never had a `<` in the right place.
 */
const LEGACY_FADER_TAG = /<Fader(?![A-Za-z0-9_])/g;

/** The custom properties only the retired control ever read. A rule that sets
 *  one, or an assertion that reads one, is talking to nothing. */
const DEAD_FADER_TOKENS = [
  '--fader-track-bg',
  '--fader-track-bg-color',
  '--fader-track-border',
  '--fader-track-line',
  '--fader-thumb-bg',
  '--fader-thumb-border',
  '--fader-thumb-shadow',
  '--fader-thumb-tick',
  '--fader-accent',
] as const;

describe('there is ONE fader, and it is the neon one (#1794)', () => {
  it('no Svelte source mounts the retired <Fader>', () => {
    const offenders: string[] = [];
    for (const { file, src } of allSvelteSources()) {
      if (file in ALLOWED_LEGACY_FADER) continue;
      for (const line of src.split('\n')) {
        LEGACY_FADER_TAG.lastIndex = 0;
        if (LEGACY_FADER_TAG.test(line)) offenders.push(`${file}: ${line.trim().slice(0, 120)}`);
      }
    }
    expect(
      offenders.join('\n'),
      'the retired grey throw is mounted here. The app has ONE fader — `NeonFader` — and a ' +
        'face that draws the old one is the look regression #1794 removed. Use ' +
        "`import NeonFader from '$lib/ui/controls/NeonFader.svelte'`.",
    ).toBe('');
  });

  it('the retired control file itself is gone, and the barrel does not export it', () => {
    // ANCHORED TO THE ARTIFACT. Every clause above is satisfiable by a tree in
    // which `Fader.svelte` quietly exists again and nothing mounts it YET.
    const controlFiles = readdirSync(CONTROLS_DIR);
    expect(controlFiles, '`Fader.svelte` is back — delete it or exempt it, deliberately').not.toContain(
      'Fader.svelte',
    );
    expect(controlFiles, 'the surviving throw must still be here').toContain('NeonFader.svelte');
    const barrel = stripSourceComments(readFileSync(join(CONTROLS_DIR, 'index.ts'), 'utf8'));
    expect(
      /\bas Fader\b/.test(barrel),
      'the controls barrel re-exports a `Fader` — there is one throw and its name is NeonFader',
    ).toBe(false);
    expect(/\bas NeonFader\b/.test(barrel), 'the barrel must still export NeonFader').toBe(true);
  });

  it('no source sets or reads a custom property only the retired control consumed', () => {
    // The DEAD TOKEN class, gated rather than described. These paint nothing on
    // `NeonFader`, so a rule declaring one is decoration and an assertion
    // reading one is green about a variable with no consumer.
    const offenders: string[] = [];
    for (const { file, src } of allSvelteSources()) {
      for (const token of DEAD_FADER_TOKENS) {
        if (src.includes(token)) offenders.push(`${file}: ${token}`);
      }
    }
    expect(
      offenders.join('\n'),
      'these name a custom property that ONLY the retired `Fader.svelte` read. `NeonFader` ' +
        'resolves `--_ka: var(--ka, var(--domain, var(--accent)))` and consumes none of them, ' +
        'so setting one paints nothing and reading one asserts nothing. Use `--ka` for a ' +
        'per-cell accent override, or `--domain` on the host.',
    ).toBe('');
  });

  it('the exemption list is ANCHORED — an entry naming a missing file is RED', () => {
    const present = new Set(allSvelteSources().map((c) => c.file));
    expect(
      Object.keys(ALLOWED_LEGACY_FADER).filter((f) => !present.has(f)),
      'these exemptions name files that do not exist (renamed? deleted?) — an exemption ' +
        'nobody is watching is a licence',
    ).toEqual([]);
    for (const [file, why] of Object.entries(ALLOWED_LEGACY_FADER)) {
      expect(why.length, `${file}: an exemption without a reason is a diff`).toBeGreaterThan(40);
    }
  });

  it('POSITIVE CONTROL: the pattern catches the real regression shape, in both directions', () => {
    // A textual gate that matches nothing looks exactly like a clean codebase,
    // and the specific hazard here is a pattern LOOSE enough to also flag the
    // replacement — which would be a gate that fails on correct code and gets
    // widened until it stops working.
    for (const bad of [
      '<Fader value={v} min={0} max={1} />',
      // ⚠ THE MULTI-LINE FORM, AS A SINGLE LINE — the shape the line-by-line
      // scan actually sees, and the one the first pattern was blind to. Keep
      // this case: it is the whole reason the lookahead is a character class.
      '      <Fader',
      '<Fader/>',
      '<Fader>',
    ]) {
      LEGACY_FADER_TAG.lastIndex = 0;
      expect(LEGACY_FADER_TAG.test(bad), `must catch the retired mount: ${bad}`).toBe(true);
    }
    for (const ok of [
      '<NeonFader value={v} min={0} max={1} />',
      '  <NeonFader',
      '<NeonFaderRow />',
      'import NeonFader from "$lib/ui/controls/NeonFader.svelte";',
      'const FaderLike = 1;',
    ]) {
      LEGACY_FADER_TAG.lastIndex = 0;
      expect(LEGACY_FADER_TAG.test(ok), `must NOT flag the surviving control: ${ok}`).toBe(false);
    }
  });

  it('POSITIVE CONTROL: the scan really reaches the tree it claims to', () => {
    // `toBe('')` over a walk that found nothing is indistinguishable from a
    // clean tree. Prove the walk resolved, and that it reached BOTH the control
    // directory and the card directory the migration touched.
    const files = allSvelteSources().map((c) => c.file);
    expect(files.length, 'the Svelte walk found no sources — SRC_ROOT is wrong').toBeGreaterThan(100);
    expect(files, 'the walk must reach the controls directory').toContain(
      join('lib', 'ui', 'controls', 'NeonFader.svelte'),
    );
    expect(files, 'the walk must reach the card directory').toContain(
      join('lib', 'ui', 'modules', 'ModuleShell.svelte'),
    );
    // …and the tree really does mount the surviving control, so the first
    // clause is passing over a populated subject rather than an empty one.
    const mounts = allSvelteSources().filter((c) => /<NeonFader(?=[\s/>])/.test(c.src));
    expect(
      mounts.length,
      'no source mounts <NeonFader> at all — the first clause is green over a tree with no ' +
        'faders in it, which is not the same as a tree with no OLD faders in it',
    ).toBeGreaterThan(1);
  });

  it('the comment stripper is load-bearing here, both directions', () => {
    // This file's own header writes `<Fader>` repeatedly to explain what is
    // forbidden. Un-stripped, the gate's documentation is its first offence.
    const asProse = [
      '<!-- was: <Fader value={v} /> -->',
      '// every <Fader> mount became <NeonFader>',
      '/* <Fader min={0} /> — retired in #1794 */',
    ].join('\n');
    LEGACY_FADER_TAG.lastIndex = 0;
    expect(
      LEGACY_FADER_TAG.test(stripSourceComments(asProse)),
      'a retired mount quoted in PROSE is not an offence',
    ).toBe(false);
    // …and the SAME text as code still is (the stripper is not an eraser).
    LEGACY_FADER_TAG.lastIndex = 0;
    expect(
      LEGACY_FADER_TAG.test(stripSourceComments('<Fader value={v} />')),
      'the stripper must not erase real markup',
    ).toBe(true);
  });
});
