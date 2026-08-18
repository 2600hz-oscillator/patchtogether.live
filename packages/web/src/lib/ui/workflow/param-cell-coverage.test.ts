// packages/web/src/lib/ui/workflow/param-cell-coverage.test.ts
//
// WHAT `faces-parity` IS STRUCTURALLY UNABLE TO SEE — stated inside a gate
// instead of in a comment.
//
// `faces-parity` drives every rendered cell of every STRICT_FACES module and
// is the reason a dead control cannot ship. But it is REGISTRY-DRIVEN off the
// faces that exist: a primitive no promoted module has adopted yet is never
// rendered, so its `driveCell` branch is never entered, and the whole thing
// reports green having exercised nothing. That is not hypothetical — it is the
// normal state of a PLATFORM PR, which by design lands one cycle before its
// first consumer (ParamGrid shipped a PR ahead of dx7's algorithm picker;
// ColorField ships a PR ahead of wavesculpt's face).
//
// The failure that follows is quiet and expensive: the branch is written, the
// suite is green, and the first thing that actually runs it is a red CI job on
// the face PR — with the platform author gone.
//
// So THREE things are asserted here, all pure:
//
//   1. WIRING — every `ParamCellKind` has a render branch in ModuleShell and a
//      matching arm in faces-parity's `CellControl` union AND its `driveCell`.
//      A new primitive whose e2e branch was forgotten fails HERE, in the unit
//      lane, in ~20 ms, instead of in a shard 25 minutes later.
//
//   2. COVERAGE, RATCHETED BOTH WAYS — how many STRICT_FACES modules actually
//      render each kind. A kind with ZERO live adopters must be NAMED in
//      `UNEXERCISED_BY_FACES_PARITY` with the reason and what covers it
//      meanwhile; a kind that IS adopted must NOT be listed. So an uncovered
//      primitive is a DECLARATION rather than an omission, and the day
//      wavesculpt's face lands, this test fails until the stale entry is
//      dropped — which is exactly when someone should be re-reading it.
//
//   3. THE SUBSTITUTE IS REAL — every named entry points at a spec file that
//      exists. An exemption whose justification has been deleted is an
//      exemption nobody is watching.
//
// The source greps are textual because there is no other way to see across the
// unit/e2e boundary (the e2e is a Playwright spec; importing it here would pull
// in @playwright/test). Each pattern is negative-controlled at the bottom.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ParamDef } from '$lib/graph/types';
import { STRICT_FACES } from './strict-faces';
import {
  declaredParamCells,
  momentaryParamIds,
  paramCellKind,
  type ParamCellKind,
} from './shell-control-kind';

/** Every kind the resolver can return. Listed literally so a widening of the
 *  union without a corresponding entry here is a TYPE error, not a silent
 *  hole: the `satisfies` below makes TS check the two agree. */
const ALL_KINDS = [
  'knob',
  'momentary',
  'toggle',
  'segmented',
  'selector',
  'grid',
  'color',
  'fader',
  'xy',
] as const satisfies readonly ParamCellKind[];

// A total map from the union to this list — if `ParamCellKind` grows a member
// that ALL_KINDS omits, this assignment fails to typecheck.
const _EXHAUSTIVE: Record<ParamCellKind, true> = Object.fromEntries(
  ALL_KINDS.map((k) => [k, true]),
) as Record<ParamCellKind, true>;
void _EXHAUSTIVE;

/**
 * Kinds NO promoted face renders yet, each with the reason and the spec that
 * covers the primitive meanwhile.
 *
 * ⚠ THIS RATCHETS IN BOTH DIRECTIONS. Unlisted-and-unexercised is a silent
 * gap; listed-and-exercised is a stale entry. Both fail. Adding a primitive
 * means adding a row; landing its first face means deleting one.
 */
const UNEXERCISED_BY_FACES_PARITY: Readonly<Record<string, { why: string; coveredBy: string }>> = {
  color: {
    why:
      'ColorField lands one PR before its first consumer (wavesculpt has no `face` yet), so no ' +
      'STRICT_FACES dock renders a colour cell and faces-parity never enters its driveCell arm.',
    coveredBy: 'e2e/tests/color-field.spec.ts',
  },
  // ⚠ THE `xy` ROW IS GONE, and its deletion is the point of the ratchet's
  // second direction. It said "No shipped def declares `face.xyPads`" — true
  // until backdraft's face, which declares two (camTiltX/Y and camPosX/Y). The
  // kind is now exercised by a real adopter, so faces-parity DOES enter its
  // driveCell arm and a listed-and-exercised row would be a stale entry that
  // fails. Left as a comment rather than silently removed because "the first
  // adopter deletes the row" is the mechanism, not an accident.
};

interface FaceDefLike {
  type: string;
  params?: readonly ParamDef[];
  face?: {
    momentary?: readonly string[];
    paramCells?: Readonly<Record<string, 'grid' | 'color' | 'fader'>>;
    xyPads?: readonly { x: string; y: string; label?: string }[];
  };
}

function allDefs(): FaceDefLike[] {
  return [
    ...(listModuleDefs() as unknown as FaceDefLike[]),
    ...(listVideoModuleDefs() as unknown as FaceDefLike[]),
    ...(listMetaModuleDefs() as unknown as FaceDefLike[]),
  ];
}

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../../../../../${rel}`, import.meta.url));

const PARITY_SPEC = repoFile('e2e/tests/faces-parity.spec.ts');
const SHELL = fileURLToPath(new URL('../modules/ModuleShell.svelte', import.meta.url));

/** Strip HTML + `//` line comments so a kind merely NAMED in prose does not
 *  read as a rendered branch. This is the guard's own blind spot closed: the
 *  word 'color' appears a dozen times in ModuleShell's comments. */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const shellSrc = stripComments(readFileSync(SHELL, 'utf8'));
const paritySrc = stripComments(readFileSync(PARITY_SPEC, 'utf8'));

/** ModuleShell paints this kind (`data-cell-control="<kind>"` on a real cell). */
const shellRenders = (kind: string) =>
  new RegExp(`data-cell-control="${kind}"`).test(shellSrc);
/** faces-parity's closed union admits it. */
const parityUnionHas = (kind: string) => new RegExp(`\\|\\s*'${kind}'`).test(paritySrc);
/** faces-parity's driveCell has an arm for it. */
const parityDrives = (kind: string) =>
  new RegExp(`cell\\.control === '${kind}'`).test(paritySrc);

/**
 * How many STRICT_FACES modules render at least one cell of each kind, at the
 * DOCK — which is what faces-parity opens and sweeps.
 */
function liveDockCoverage(): Map<ParamCellKind, string[]> {
  const out = new Map<ParamCellKind, string[]>(ALL_KINDS.map((k) => [k, []]));
  for (const def of allDefs()) {
    if (!STRICT_FACES.has(def.type)) continue;
    const momentary = momentaryParamIds(def);
    const declared = declaredParamCells(def);
    const seen = new Set<ParamCellKind>();
    for (const p of def.params ?? []) seen.add(paramCellKind(p, momentary, 'dock', declared));
    for (const k of seen) out.get(k)!.push(def.type);
  }
  return out;
}

describe('param cell coverage — every primitive is WIRED end to end', () => {
  it.each(ALL_KINDS)('%s: ModuleShell paints it', (kind) => {
    expect(
      shellRenders(kind),
      `no \`data-cell-control="${kind}"\` cell in ModuleShell.svelte — the resolver can return ` +
        `'${kind}' and the shell would fall through to the knob branch`,
    ).toBe(true);
  });

  it.each(ALL_KINDS)('%s: faces-parity admits it AND knows how to drive it', (kind) => {
    expect(
      parityUnionHas(kind),
      `'${kind}' is missing from faces-parity's CellControl union — the sweep would read it as ` +
        `an unrecognised control and THROW, killing every face row`,
    ).toBe(true);
    expect(
      parityDrives(kind),
      `faces-parity has no \`cell.control === '${kind}'\` branch. A primitive whose e2e arm was ` +
        `forgotten is found by a red CI shard 25 minutes later, or — if no face uses it yet — ` +
        `not at all`,
    ).toBe(true);
  });
});

describe('param cell coverage — what faces-parity CANNOT currently see', () => {
  const coverage = liveDockCoverage();

  it('every kind with ZERO live adopters is DECLARED, with what covers it instead', () => {
    const undeclared: string[] = [];
    for (const kind of ALL_KINDS) {
      if (coverage.get(kind)!.length > 0) continue;
      if (UNEXERCISED_BY_FACES_PARITY[kind]) continue;
      undeclared.push(
        `'${kind}' is rendered by NO STRICT_FACES module, so faces-parity's branch for it never ` +
          `runs and the gate is green having exercised nothing. Declare it in ` +
          `UNEXERCISED_BY_FACES_PARITY with the spec that covers the primitive meanwhile.`,
      );
    }
    expect(undeclared.join('\n')).toBe('');
  });

  it('…and every DECLARED entry is still true (a stale exemption is one nobody is watching)', () => {
    const stale: string[] = [];
    for (const [kind, entry] of Object.entries(UNEXERCISED_BY_FACES_PARITY)) {
      const adopters = coverage.get(kind as ParamCellKind);
      if (!adopters) {
        stale.push(`'${kind}' is not a ParamCellKind — the entry names nothing`);
        continue;
      }
      if (adopters.length > 0) {
        stale.push(
          `'${kind}' IS now exercised by faces-parity (${adopters.join(', ')}). Delete its ` +
            `UNEXERCISED_BY_FACES_PARITY entry — the real gate covers it and the substitute ` +
            `(${entry.coveredBy}) is no longer the only thing that does.`,
        );
      }
    }
    expect(stale.join('\n')).toBe('');
  });

  it('…and every substitute spec it points at EXISTS', () => {
    const missing = Object.entries(UNEXERCISED_BY_FACES_PARITY)
      .filter(([, e]) => !existsSync(repoFile(e.coveredBy)))
      .map(([k, e]) => `'${k}' names ${e.coveredBy}, which does not exist`);
    expect(missing.join('\n')).toBe('');
  });

  it('prints the live coverage, so the shape of the gap is readable at a glance', () => {
    // Not an assertion about the numbers — a record of them. The one thing it
    // DOES assert is that the sweep found faces at all, so a broken registry
    // import cannot make every kind look "unexercised" and quietly demand
    // exemptions for all seven.
    const total = ALL_KINDS.reduce((n, k) => n + coverage.get(k)!.length, 0);
    expect(total, 'no STRICT_FACES module resolved ANY cell — the registry did not load').toBeGreaterThan(0);
    expect(coverage.get('knob')!.length, 'every face has knobs; zero means the resolver is broken').toBeGreaterThan(0);
  });
});

describe('param cell coverage — NEGATIVE CONTROLS on the source greps', () => {
  // A textual gate that matches nothing looks exactly like a clean codebase.

  it('the shell grep fires on a real cell and NOT on a mention in prose', () => {
    expect(shellRenders('color'), 'the real branch').toBe(true);
    expect(shellRenders('definitely-not-a-cell-kind')).toBe(false);
    // The comment-stripping half: ModuleShell's own prose says "colour" and
    // "color" repeatedly. Prove a commented-out branch does not count.
    const commented = stripComments('<!-- data-cell-control="ghost" -->\n// data-cell-control="ghost"');
    expect(/data-cell-control="ghost"/.test(commented)).toBe(false);
  });

  it('the parity greps fire on a real arm and NOT on a mention in prose', () => {
    expect(parityUnionHas('color') && parityDrives('color')).toBe(true);
    expect(parityDrives('ghost')).toBe(false);
    expect(parityUnionHas('ghost')).toBe(false);
  });

  it('the coverage sweep can report a kind as UNEXERCISED (it is not always non-empty)', () => {
    // The clause that would rot first: if `liveDockCoverage` ever returned a
    // non-empty list for everything — a resolver bug, a widened default — the
    // "declare your gaps" test would pass forever with nothing to declare.
    const coverage = liveDockCoverage();
    const empties = ALL_KINDS.filter((k) => coverage.get(k)!.length === 0);
    expect(
      empties.length,
      'the sweep found an adopter for EVERY kind, including the ones this file declares as ' +
        'unexercised — the coverage function is not measuring what it claims',
    ).toBeGreaterThan(0);
  });
});
