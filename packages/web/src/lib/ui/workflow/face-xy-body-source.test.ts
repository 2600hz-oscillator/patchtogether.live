// packages/web/src/lib/ui/workflow/face-xy-body-source.test.ts
//
// `face.xyPads[].surface: 'body'` — THE CLAIM THAT THE MODULE'S OWN BODY PAINTS
// THE PAD, CHECKED RATHER THAN RECORDED.
//
// ── WHAT THE DECLARATION DOES ──────────────────────────────────────────────
//
// A pad declaring `surface: 'body'` is DROPPED from the dock band plan —
// `curatedFace`/`resolvePage` filter BOTH axes at the dock tier — on the
// strength of one word in a def. The compensating half is that the module's own
// `fullViewBody` paints it instead. If that half is missing, the declaration is
// not a no-op: it is a CONTROL DELETION, and every def-reading gate stays green
// while it happens, because every def-reading gate reads the same def that says
// the body has it covered.
//
// `module-face-lint` already holds two legs of this:
//   * the dock plan must render EXACTLY ZERO cells for both axes (the inverted
//     assertion, the shape `noUserControl` established), and
//   * the face must declare an `extension` at all.
// Neither can see whether the COMPONENT that extension resolves actually paints
// a pad. That is this file.
//
// ── THE SHAPE OF THE CHECK ─────────────────────────────────────────────────
//
// DENY BY DEFAULT, in BOTH directions, because either alone is blind:
//
//   FORWARD  every def declaring a `'body'` pad must resolve a `fullViewBody`
//            component whose SOURCE emits the pad: a `data-control-params`
//            attribute naming BOTH axis ids, and the `control-<x>` anchor
//            testid `faces-parity` reads. Without this the axes render nowhere.
//   INVERSE  a `fullViewBody` that emits `data-control-params` must belong to a
//            def that DECLARES the pad it is emitting. This is the half that
//            catches the opposite mistake — a body painting a pad the dock is
//            ALSO painting, i.e. two cells for one param and a `faces-parity`
//            multiset failure that would otherwise only surface in the browser
//            lane, twenty-five minutes later.
//
// MEMBERSHIP IS DERIVED, never listed: the subject is "every registered def
// whose face declares a pad with `surface: 'body'`", read off the live
// registries, plus "every `shell-extension.ts` in the modules directory that
// fills `fullViewBody`", read off the DIRECTORY. So the population cannot go
// stale — the property `face-rack-status-source.test.ts` documents about itself
// after being caught by three unrelated merges in as many rounds.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ───────────────────────────────
//
//   * IT READS SOURCE, NOT A RENDER. It cannot tell you the pad is visible,
//     draggable, correctly ranged, or that dragging it commits anything. That
//     is `faces-parity`'s job (it drags the real element and asserts the graph
//     moved) and the dock VRT baseline's.
//   * IT CANNOT PROVE THE ATTRIBUTES LAND ON THE SAME ELEMENT. The two legs
//     grep one file for two strings; a body that put `data-control-params` on a
//     wrapper and the testid on a child would pass here and fail
//     `faces-parity`'s "the visible thing and the operable thing are two
//     different elements" rule there. Recorded rather than fixed, because the
//     honest fix is a DOM assertion and this lane has no DOM.
//   * IT SAYS NOTHING ABOUT THE LANE. A `'body'` pad is dropped at the DOCK
//     only; every lane tier keeps the generic `XyPad` by construction
//     (`curatedFace`'s tier test). `module-face-lint`'s completeness sweep is
//     what proves the axes are still ranked at all.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { FaceXyPad, ModuleFace } from '$lib/graph/types';
import '$lib/audio/modules';
import '$lib/video/modules';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = resolve(HERE, '../modules');

interface DefLike {
  type: string;
  face?: ModuleFace;
}

function allDefs(): DefLike[] {
  return [
    ...(listModuleDefs() as unknown as DefLike[]),
    ...(listVideoModuleDefs() as unknown as DefLike[]),
    ...(listMetaModuleDefs() as unknown as DefLike[]),
  ];
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Every `(def, pad)` pair whose pad declares `surface: 'body'`. */
function bodyPads(): { def: DefLike; pad: FaceXyPad }[] {
  const out: { def: DefLike; pad: FaceXyPad }[] = [];
  for (const def of allDefs()) {
    for (const pad of def.face?.xyPads ?? []) {
      if (pad.surface === 'body') out.push({ def, pad });
    }
  }
  return out;
}

/** Every extension id in the tree filling `fullViewBody`, READ OFF THE
 *  DIRECTORY — the same derivation `face-rack-status-source` uses, and for the
 *  same reason: a hand-kept list of these has been wrong three times. */
function extensionsWithBody(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((id) => {
      const f = resolve(MODULES_DIR, id, 'shell-extension.ts');
      return existsSync(f) && /fullViewBody:/.test(read(f));
    })
    .sort();
}

/** The source of the component an extension names for its `fullViewBody` slot.
 *  `import.meta.glob` is LAZY, so the component object is unreachable from a
 *  node-env test; the FILE the declaration names is what can be read. */
function fullViewBodySource(extId: string): string | null {
  const ext = resolve(MODULES_DIR, extId, 'shell-extension.ts');
  if (!existsSync(ext)) return null;
  const src = read(ext);
  const m = /fullViewBody:\s*([A-Za-z0-9_]+)/.exec(src);
  if (!m) return null;
  const imported = new RegExp(`import\\s+${m[1]}\\s+from\\s+'\\./([^']+)'`).exec(src);
  if (!imported) return null;
  const file = resolve(MODULES_DIR, extId, imported[1]!);
  return existsSync(file) ? read(file) : null;
}

/** The axis pairs a body's source CLAIMS to cover, parsed out of every
 *  `data-control-params` it emits. Tolerant of Svelte's `{...}` interpolation
 *  only in the sense that it will not match one — a body that computes the
 *  attribute rather than writing it literally is INVISIBLE here and fails the
 *  forward leg, which is the correct outcome: the whole point is that the pair
 *  is legible in source. */
function declaredControlParams(src: string): string[][] {
  const out: string[][] = [];
  const re = /data-control-params\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push(m[1]!.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

describe("face.xyPads surface:'body' — the body really paints the pad", () => {
  it('has a subject at all (vacuity control)', () => {
    // Two ways this file could be green while measuring nothing: no def
    // declares a body pad, or the directory scan resolves no bodies. Both fail
    // HERE rather than letting the sweeps below pass over an empty set.
    //
    // ⚠ THE FIRST ONE IS A REAL RATCHET RISK AND IT IS DELIBERATE. If the last
    // `'body'` pad in the tree is ever removed, this leg goes red and the
    // honest response is to DELETE THIS FILE together with the mechanism —
    // not to soften the leg. A gate for a feature nobody uses is decoration.
    expect(bodyPads().length, "defs declaring a `surface: 'body'` pad").toBeGreaterThan(0);
    expect(extensionsWithBody().length, 'extensions filling `fullViewBody`').toBeGreaterThan(0);
  });

  // ── FORWARD: a declaration must be PAINTED ────────────────────────────────
  it('every body pad resolves a fullViewBody that emits BOTH of its axes', () => {
    const offenders: string[] = [];
    for (const { def, pad } of bodyPads()) {
      const extId = def.face?.extension;
      if (!extId) {
        // module-face-lint already says this; repeated here so this file's
        // forward leg is total over its own subject rather than assuming a
        // sibling ran.
        offenders.push(
          `${def.type}: pad '${pad.x}'/'${pad.y}' declares surface:'body' but the face declares `
            + 'no `extension` — nothing can paint it and the dock drops both axes',
        );
        continue;
      }
      const src = fullViewBodySource(extId);
      if (src === null) {
        offenders.push(
          `${def.type}: extension '${extId}' has no resolvable fullViewBody component, so the `
            + `pad '${pad.x}'/'${pad.y}' the dock dropped is painted by nothing`,
        );
        continue;
      }
      const covered = declaredControlParams(src);
      const hit = covered.find((axes) => axes.includes(pad.x) && axes.includes(pad.y));
      if (!hit) {
        offenders.push(
          `${def.type}: '${extId}' fullViewBody declares no data-control-params covering BOTH `
            + `'${pad.x}' and '${pad.y}'. That attribute is what faces-parity reads to credit a `
            + `2-D cell with two params (faces-parity.spec.ts, the exact-multiset assert), so `
            + `without it the promotion reads as two DROPPED controls. Found: `
            + `${covered.length ? covered.map((a) => a.join(',')).join(' | ') : '(none)'}`,
        );
        continue;
      }
      // The ANCHOR testid. Every other primitive derives `control-<paramId>`
      // itself; a body writing its own pad must write the same one, or the
      // element is invisible to the `[data-testid^="control-"]` sweep that
      // collects the multiset in the first place.
      if (!new RegExp(`control-${pad.x}\\b`).test(src)) {
        offenders.push(
          `${def.type}: '${extId}' fullViewBody covers both axes but carries no `
            + `\`control-${pad.x}\` anchor testid. faces-parity collects cells with `
            + `[data-testid^="control-"] and THEN reads data-control-params, so an element `
            + `without the anchor is never collected and both axes read as dropped.`,
        );
      }
      // ⚠ THE CELL WRAPPER, AND THIS LEG EXISTS BECAUSE THE FIRST BODY SHIPPED
      // WITHOUT IT AND EVERYTHING ELSE WAS GREEN. A `'body'` pad is still ONE
      // CELL of the faceplate, and the sweeps that walk a faceplate's cells key
      // on `[data-cell-kind]` (`renderedCells`), NOT on the testid. So a body
      // can carry both attributes above, render a perfectly working joystick,
      // satisfy the `control-*` multiset — and still be invisible to the
      // per-cell OPERABILITY sweep, which is the one that actually drags the
      // pad and proves both axes commit. Measured on the first run of the first
      // adopter: `18 param cells covering 18 of 20 params`, with the pad on
      // screen and working. The three attributes must mirror `ModuleShell`'s
      // own `xy` branch, so the body's cell is held to the same bar as a
      // shell-painted one rather than to a private one.
      for (const [attr, want] of [
        ['data-cell-kind', 'param'],
        ['data-cell-control', 'xy'],
        ['data-cell-key', pad.x],
      ] as const) {
        if (!new RegExp(`${attr}="${want}"`).test(src)) {
          offenders.push(
            `${def.type}: '${extId}' fullViewBody paints the pad but declares no `
              + `\`${attr}="${want}"\`. Without the shell's cell contract the pad is invisible `
              + `to faces-parity's per-cell operability sweep — it renders, it works, and `
              + `NOTHING drags it to prove both axes commit.`,
          );
        }
      }
    }
    expect(
      offenders.join('\n'),
      "a `surface: 'body'` pad is not actually painted by the body it names",
    ).toBe('');
  });

  // ── INVERSE: a painted pad must be DECLARED ───────────────────────────────
  it('a fullViewBody emitting a pad belongs to a def that declares it as body-painted', () => {
    const byExt = new Map<string, DefLike>();
    for (const def of allDefs()) {
      const extId = def.face?.extension;
      if (extId) byExt.set(extId, def);
    }
    const offenders: string[] = [];
    for (const extId of extensionsWithBody()) {
      const src = fullViewBodySource(extId);
      if (!src) continue;
      const covered = declaredControlParams(src);
      if (!covered.length) continue;
      const def = byExt.get(extId);
      if (!def) {
        offenders.push(
          `extension '${extId}' paints a control cell (${covered.map((a) => a.join(',')).join(' | ')}) `
            + 'but no live def declares it — the cell can never be reached, and it would be a '
            + 'phantom in any parity sweep that did reach it',
        );
        continue;
      }
      const declared = new Set(
        (def.face?.xyPads ?? [])
          .filter((p) => p.surface === 'body')
          .flatMap((p) => [p.x, p.y]),
      );
      for (const axes of covered) {
        const undeclared = axes.filter((a) => !declared.has(a));
        if (undeclared.length) {
          offenders.push(
            `${def.type}: '${extId}' fullViewBody paints ${axes.join(',')} but `
              + `${undeclared.join(', ')} ${undeclared.length === 1 ? 'is' : 'are'} not declared on `
              + `a surface:'body' pad. The dock will ALSO paint a band cell for it — two cells for `
              + `one param, which faces-parity fails as a multiset mismatch in the browser lane `
              + `~25 min later.`,
          );
        }
      }
    }
    expect(
      offenders.join('\n'),
      'an extension body paints a control the def has not handed it',
    ).toBe('');
  });

  // ── The PERMANENT negative control ────────────────────────────────────────
  it('NEGATIVE CONTROL: the probe can find a real body and a real declaration', () => {
    // Both sweeps above are ABSENCES. On a probe that reads the wrong path (a
    // renamed directory, a bad resolve, a regex that stopped matching Svelte's
    // attribute syntax) they pass vacuously and say nothing at all. This leg
    // requires the probe to be READING, in both halves, through the SAME
    // functions the sweeps call — not a re-implementation that could drift.
    const pads = bodyPads();
    expect(pads.length, 'no body pad to read').toBeGreaterThan(0);
    const { def, pad } = pads[0]!;
    const src = fullViewBodySource(def.face!.extension!);
    expect(src, `the probe could not read ${def.type}'s fullViewBody source`).not.toBeNull();
    expect(src!.length, 'the probe read an empty/missing component file').toBeGreaterThan(500);
    // And the parser really extracts a pair — a regex that matched nothing
    // would make the forward leg's `find` fail loudly rather than pass, but a
    // regex that matched EVERYTHING would make it pass on anything. Assert the
    // extracted pair is exactly the declared one.
    const covered = declaredControlParams(src!);
    expect(covered.length, 'the data-control-params parser extracted nothing').toBeGreaterThan(0);
    expect(covered.some((a) => a.length === 2 && a.includes(pad.x) && a.includes(pad.y))).toBe(true);
  });
});
