// packages/web/src/lib/audio/modules/vrt-meta.test.ts
//
// Coverage self-test for the Playwright FACE VRT scenes.
//
// Asserts, in the vitest pass (~1 s) rather than the Playwright pass, that
//   1. every face-scene AudioContext freeze opt-out is NAMED and not stale, and
//      every opt-out says what makes the scene deterministic instead;
//   2. the FACES roster equals the promoted set in BOTH directions, and every
//      rostered face has a committed baseline for every tier it captures.
//
// It used to assert the same shape for the per-module LANE sweep. That half is
// gone with the sweep — see the tombstone below.
//
// ── THERE IS ONE BASELINE SET (2026-08-10) ──────────────────────────────────
// `snapshotPathTemplate` dropped its `{platform}` segment, so a baseline is a
// single PNG authored by linux CI. That deleted, in one move, everything this
// file used to carry about platform coverage:
//
//   * `EXEMPT_BASELINE_PAIRS` (the `<platform>/<scene>` skip set),
//   * `LINUX_DEFICIT_CEILING` / `SHARED_LINUX_PAIR_CEILING` /
//     `STALE_PAIR_CEILING` — the three hand-typed population counts Phase 1
//     deferred to this PR (see CLAUDE.md, "NEVER hand-type a population
//     count"); they had no successor and none was written,
//   * `e2e/vrt/vrt-platform-gaps.ts`, the 617-line enumerator of the FOUR ways
//     a scene could be declared dark on the platform that gates.
//
// The whole apparatus existed to measure divergence between two baseline
// populations. With one population there is nothing to measure: "the baseline
// matches on the platform CI runs" is the entire property, and Playwright
// asserts it directly.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
// ⚠ THE SIDE-EFFECT IMPORTS ARE LOAD-BEARING, AND THEIR ABSENCE WAS A LATENT
// BLIND SPOT IN THIS FILE. `list*ModuleDefs()` reads a registry that is
// populated by IMPORTING the module barrels; without these three lines this
// file was relying on some TRANSITIVE import to have registered them first.
// That held for the full-file run and BROKE under a `-t` filter, where
// `listVideoModuleDefs()` returned an EMPTY array.
//
// An empty registry does not fail — it makes every sweep keyed on it cover
// NOTHING and pass, which is the blind-gate shape exactly. Four pre-existing
// sweeps in this file already depended on it (the registered-vs-exempt
// reconciliation, the mask reconciliation, and the STRICT_VRT cross-checks), so
// this hardens them too rather than only the video-face gate added below.
// Caught by that gate's own vacuity control, which is what a vacuity control is
// for. `push-card-schema.test.ts` and `video-face-screen-source.test.ts` both
// already do this; this file was the copy that did not.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';
import { listVideoModuleDefs } from '$lib/video/module-registry';

// vitest's `resolve.alias` doesn't reach across the /e2e/ workspace without
// explicit config, so these use relative paths.
import { VRT_SCENES } from '../../../../../../e2e/vrt/vrt-scenes';
// The hand-maintained face-scene roster + the promoted set it must equal.
import {
  EXEMPT_FACE_TYPES,
  FACES,
  ROSTERED_FACE_TYPES,
  faceTiers,
} from '../../../../../../e2e/vrt/_shell-faces';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';

function repoRoot(): string {
  // This file lives at packages/web/src/lib/audio/modules/. Six `..`
  // hops up = repo root. Resolved from import.meta.dirname so the
  // result is invariant to vitest's working directory.
  return resolve(import.meta.dirname, '../../../../../..');
}


// ⚠ THE CARD-SWEEP HALF OF THIS FILE IS GONE, AND SO IS ITS SUBJECT.
//
// Two describes lived here: `VRT coverage self-test` (every registered module
// has a `vrt.spec.ts/<type>.png` baseline or an `EXEMPT_FROM_VRT` reason, plus
// the `STRICT_VRT_MODULES` cross-checks) and `EXEMPT_FROM_VRT is
// DENY-BY-DEFAULT` (the frozen allowlist that stopped a new module
// self-exempting). Both were gates on `e2e/vrt/vrt.spec.ts` — the per-module
// LANE sweep — and on the four tables in `e2e/vrt/vrt-exemptions.ts`
// that only it applied. The sweep is deleted, the tables with it, and a gate
// whose artifact does not exist cannot be re-pointed: there is no card baseline
// for it to be about.
//
// What survives is everything below, and it is the half that guards the surface
// players actually meet: the face-scene audio freeze, and the face roster's
// equality with the promoted set plus a committed baseline per captured tier.
//
describe('vrt-meta — the face-scene AUDIO FREEZE is deny-by-default', () => {
  const VRT_DIR = resolve(repoRoot(), 'e2e/vrt');

  /** Every `(file → count of freeze-opt-out call sites)` that is ALLOWED, with
   *  the reason. Anything else — a new file, or a new occurrence in a listed
   *  file — is RED. */
  const FREEZE_OPT_OUTS: Record<string, { count: number; why: string }> = {
    'workflow-shell-faces.spec.ts': {
      count: 1,
      why:
        'the PERMANENT negative control ("a sounding face is unstable RUNNING, identical ' +
        'FROZEN") boots once with the graph deliberately live, so it can show the freeze ' +
        'assertion is capable of failing and that the tile really does move without it.',
    },
    'vrt-fold-probe.spec.ts': {
      count: 1,
      why:
        'the dock exact-diff audit takes AUDIT_NO_FREEZE=1 as its within-subject control, so a ' +
        'non-zero baseline row can be attributed to the freeze or to pre-existing drift. ' +
        'VRT_PROBE lane only — not in FULL_MATCH, so no gate captures through it.',
    },
    'vrt-face-audio-probe.spec.ts': {
      count: 3,
      why:
        'the measurement probe: the per-face RUNNING-then-FROZEN comparison, the compact ' +
        'exact-diff audit control (AUDIT_NO_FREEZE), and the reboot probe PROBE_FREEZE_LATE ' +
        'ordering check. VRT_PROBE lane only — not in FULL_MATCH.',
    },
  };

  /** Strip comments so a property written in PROSE cannot inflate (or, by being
   *  reworded, deflate) a count that is supposed to track real call sites. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  const OPT_OUT_RE = /freezeAudio\s*:/g;

  function vrtSources(): { file: string; src: string }[] {
    return readdirSync(VRT_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((file) => ({ file, src: readFileSync(resolve(VRT_DIR, file), 'utf8') }));
  }

  /** Files that CALL bootWithFace — the scan's subject. `_shell-faces.ts`
   *  DEFINES the option and is excluded by construction (it is the callee). */
  function bootWithFaceCallers(): { file: string; code: string }[] {
    return vrtSources()
      .filter((f) => f.file !== '_shell-faces.ts')
      .map((f) => ({ file: f.file, code: stripComments(f.src) }))
      .filter((f) => f.code.includes('bootWithFace('));
  }

  it('the scan can SEE a bootWithFace caller at all (instrument control)', () => {
    const callers = bootWithFaceCallers();
    expect(
      callers.length,
      `the freeze guard found NO file calling bootWithFace under ${VRT_DIR}. Either the scene ` +
        `machinery was renamed or this scan is reading the wrong directory — in both cases ` +
        `every assertion below is vacuous.`,
    ).toBeGreaterThan(0);
    // ...and that _shell-faces.ts still declares the option it is guarding.
    const shell = readFileSync(resolve(VRT_DIR, '_shell-faces.ts'), 'utf8');
    expect(
      /freezeAudio\?: boolean/.test(shell),
      '_shell-faces.ts no longer declares the `freezeAudio?: boolean` opt-out. If it was ' +
        'renamed or removed, retire this guard deliberately — do not leave it scanning for a ' +
        'token that cannot occur, which is a permanently green check.',
    ).toBe(true);
  });

  it('every bootWithFace freeze opt-out is NAMED, and no named one is stale', () => {
    const found = new Map<string, number>();
    for (const { file, code } of bootWithFaceCallers()) {
      const n = (code.match(OPT_OUT_RE) ?? []).length;
      if (n > 0) found.set(file, n);
    }
    const listed = Object.keys(FREEZE_OPT_OUTS).sort();
    const actual = [...found.keys()].sort();
    expect(
      actual,
      `UNDECLARED audio-freeze opt-out. A VRT face scene may only skip the AudioContext ` +
        `suspend with a named reason in FREEZE_OPT_OUTS (vrt-meta.test.ts) — a scene that ` +
        `captures off a running graph is green today only because no faced module sounds at ` +
        `spawn. Conversely a LISTED file with no occurrence is STALE: the entry exempts ` +
        `something that no longer exists, so it silently re-exempts the next one. ` +
        `listed=[${listed.join(', ')}] found=[${actual.join(', ')}]`,
    ).toEqual(listed);
    for (const [file, n] of found) {
      expect(
        n,
        `${file} has ${n} freeze-opt-out call site(s); FREEZE_OPT_OUTS declares ` +
          `${FREEZE_OPT_OUTS[file]?.count}. A NEW opt-out in an already-listed file must be ` +
          `declared too — that is the difference between this and a filename allowlist. ` +
          `Reason on record: ${FREEZE_OPT_OUTS[file]?.why}`,
      ).toBe(FREEZE_OPT_OUTS[file]?.count);
    }
    for (const [file, entry] of Object.entries(FREEZE_OPT_OUTS)) {
      expect(entry.why.length, `${file}: every opt-out carries a reason`).toBeGreaterThan(40);
    }
  });

  it('...and that check can actually SEE an unlisted opt-out (negative control)', () => {
    // Feed the SAME matcher a synthetic caller. Without this the guard could be
    // matching nothing at all and would read identically green — the exact
    // failure the RAW_PARAM_WRITE self-test had (it only ever fed itself the
    // one form it already matched).
    const synthetic = [
      '// freezeAudio: false   <- a comment must NOT count',
      "const id = await bootWithFace(page, 'tidyVco', { freezeAudio: false });",
      "const other = await bootWithFace(page, 'vca', { freezeAudio : someFlag });",
    ].join('\n');
    const code = stripComments(synthetic);
    expect(code.includes('bootWithFace('), 'the synthetic caller is recognised as a caller').toBe(
      true,
    );
    expect(
      (code.match(OPT_OUT_RE) ?? []).length,
      'the matcher must count BOTH the literal-false and the computed form, and must NOT count ' +
        'the commented one — a scan that only saw the literal false would miss every ' +
        'variable-driven opt-out, which is how a filtered guard goes blind.',
    ).toBe(2);
  });

  it('no VRT source builds the freeze opt-out DYNAMICALLY (the scan cannot see those)', () => {
    const offenders: string[] = [];
    for (const { file, src } of vrtSources()) {
      const code = stripComments(src);
      if (/\.freezeAudio\s*=/.test(code) || /\[['"]freezeAudio['"]\]/.test(code)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `these files set the freeze opt-out through a form the property scan above cannot see ` +
        `(assignment or computed key). Either write it as an inline property so the guard ` +
        `counts it, or teach the guard this shape — a scope left unstated reads as full ` +
        `coverage: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  // MECHANISM B, read off the artifact rather than the source text.
  it('every VRT_SCENES freeze opt-out declares WHAT makes it deterministic instead', () => {
    const off = Object.entries(VRT_SCENES).filter(([, s]) => s.freezeAudio === false);
    const undeclared = off
      .filter(([, s]) => ((s as { freezeAudioWhy?: string }).freezeAudioWhy ?? '').length <= 40)
      .map(([type]) => type)
      .sort();
    expect(
      undeclared,
      `these VRT_SCENES entries capture with the AudioContext RUNNING and do not say what ` +
        `pins them instead. The type already requires \`freezeAudioWhy\` on \`freezeAudio: ` +
        `false\`, so reaching this assertion means the reason is a placeholder. Every real one ` +
        `names its own freeze — a seed flag, a paused <video>, a module-side freeze param.`,
    ).toEqual([]);
    // …and a stale WHY is refused in the other direction: a scene that got a
    // real suspend back must not keep the licence lying around.
    const orphanWhy = Object.entries(VRT_SCENES)
      .filter(([, s]) => s.freezeAudio !== false && (s as { freezeAudioWhy?: string }).freezeAudioWhy)
      .map(([type]) => type);
    expect(
      orphanWhy,
      'these scenes declare freezeAudioWhy but DO freeze — delete the reason, or it will ' +
        'silently license the next opt-out on that scene.',
    ).toEqual([]);
  });

  it('...and that check can SEE an undeclared opt-out (negative control on the same predicate)', () => {
    // The `toEqual([])` above reads identically green whether every scene
    // declares a reason or the filter is broken. Run the SAME predicate over a
    // synthetic table where the answer is known.
    type Probe = { freezeAudio?: boolean; freezeAudioWhy?: string };
    const synthetic: Record<string, Probe> = {
      good: { freezeAudio: false, freezeAudioWhy: 'x'.repeat(41) },
      bare: { freezeAudio: false },
      placeholder: { freezeAudio: false, freezeAudioWhy: 'TODO' },
      frozen: { freezeAudio: true },
    };
    const undeclared = Object.entries(synthetic)
      .filter(([, s]) => s.freezeAudio === false)
      .filter(([, s]) => (s.freezeAudioWhy ?? '').length <= 40)
      .map(([type]) => type)
      .sort();
    expect(undeclared).toEqual(['bare', 'placeholder']);
    // …and the live table is actually non-empty, so the real run is not vacuous.
    expect(
      Object.values(VRT_SCENES).filter((s) => s.freezeAudio === false).length,
      'no VRT_SCENES entry opts out of the freeze at all — if that is now true the guard ' +
        'should be retired deliberately, not left scanning for a shape that cannot occur.',
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FACE SCENE COVERAGE — the roster was HAND-MAINTAINED and nothing checked it
// ---------------------------------------------------------------------------
//
// ⚠ THE GAP THIS CLOSES IS ONE THE SKILL DOCUMENTS AND NO GATE ENFORCED.
// `module-faceplates.md` lists `e2e/vrt/_shell-faces.ts`'s `FACES` roster under
// "NOT registry-driven — you must edit them by hand", and states the
// consequence outright: **"A promoted module missing from this list simply has
// no VRT scene, silently."**
//
// Promotion itself is already airtight in both directions — `module-face-lint`
// asserts STRICT_FACES equals the set of defs declaring a `face`. The PIXEL side
// was not: a module could be promoted, ship a live faceplate to every
// workflow-mode user, and have zero baseline behind it, with every other gate
// green. That is the same shape as the defect this suite exists for, one layer
// out.
//
// ⚠ AND IT IS NOT HYPOTHETICAL — it was hit while landing moog904a (2026-08-19).
// A local branch merged `main` while BEHIND its own origin, silently dropping
// the capture bot's baseline commit. The roster entry stayed, the two PNGs
// vanished, and nothing failed: the face lint was green (the def still declares
// a face), the promotion set was green, and the VRT lane does not fail on a
// baseline it was never told to expect. It was caught by a hand-run audit.
//
// Three assertions, deny-by-default in both directions, so neither list can
// drift from the other or from the committed pixels.
describe('face VRT scenes — every promoted face is rostered AND captured', () => {
  const faceBaseline = (type: string, tier: 'compact' | 'dock'): string =>
    resolve(
      repoRoot(),
      'e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts',
      `face-${type}-${tier}.png`,
    );

  // `Set<string>`, deliberately: `STRICT_FACES` is a narrow union type, so an
  // inferred set of literals refuses `.has(someString)` at the type level.
  const rostered = new Set<string>(FACES.map((f) => f.type));

  it('the FACES roster is EXACTLY the promoted set (both directions)', () => {
    // ⚠ THE SUBJECT IS "ACCOUNTED FOR", NOT "HAS A SCENE" — and this gate used
    // to conflate them. A face can be accounted for by a captured scene OR by a
    // named `FACES_WITHOUT_SCENES` exemption (a renderer that cannot be
    // baselined at all; `milkdrop`/#2083 is the first). When that exemption
    // landed, `workflow-shell-faces.spec.ts` learned about it and THIS FILE DID
    // NOT — two gates asserting one relationship off two lists — so a correctly
    // exempted face reported as PROMOTED BUT NOT ROSTERED here.
    //
    // Both gates now read `ROSTERED_FACE_TYPES`, which is the union, defined
    // once beside the rosters it unions. Do not re-derive it locally.
    const promoted = new Set<string>(STRICT_FACES);
    const unaccounted = [...promoted].filter((t) => !ROSTERED_FACE_TYPES.has(t)).sort();
    const unpromoted = [...ROSTERED_FACE_TYPES].filter((t) => !promoted.has(t)).sort();

    expect(
      unaccounted,
      'PROMOTED BUT NOT ACCOUNTED FOR — these modules render a live faceplate to every ' +
        'workflow-mode user with NO VRT scene behind them, and nothing else can see it: ' +
        'module-face-lint only checks that the def declares a face. Either add ' +
        '{ type, pages } to FACES in e2e/vrt/_shell-faces.ts and capture the baselines, or — ' +
        'if the RENDERER genuinely cannot be baselined — add a named FACES_WITHOUT_SCENES ' +
        `entry carrying the measurement and its replacement coverage: ${unaccounted.join(', ')}`,
    ).toEqual([]);

    // ⚠ THE REVERSE DIRECTION SPLITS, because the two halves are different
    // mistakes and deserve different sentences. A stale SCENE captures a legacy
    // card under a face-scene name; a stale EXEMPTION silently pre-approves
    // whatever takes that name next. Telling an author to "remove the scene" for
    // an entry that has no scene is the kind of misdirection that costs a
    // debugging session.
    const staleScenes = unpromoted.filter((t) => !EXEMPT_FACE_TYPES.has(t));
    const staleExemptions = unpromoted.filter((t) => EXEMPT_FACE_TYPES.has(t));

    expect(
      staleScenes,
      'ROSTERED BUT NOT PROMOTED — a scene naming a module that is not in STRICT_FACES ' +
        'captures an unpromoted surface under a face-scene name, which is a baseline nobody can ' +
        `interpret. Remove it or promote the module: ${staleScenes.join(', ')}`,
    ).toEqual([]);

    expect(
      staleExemptions,
      'EXEMPTED BUT NOT PROMOTED — a FACES_WITHOUT_SCENES entry names a module that is not ' +
        'faced. It has no scene BY DESIGN, so there is nothing to remove and nothing to ' +
        'capture; the entry itself is what is stale. An unpromoted module needs no exemption, ' +
        'and leaving one behind quietly pre-approves whatever takes that name next — delete ' +
        `it, or promote the module and re-argue its coveredBy: ${staleExemptions.join(', ')}`,
    ).toEqual([]);
  });

  // ── EVERY FACED VIDEO MODULE DECLARES `videoFaceWhy` ─────────────────────
  //
  // ⚠ THE GAP THIS CLOSES COST A FULL CI SHARD AND A 90-SECOND HANG. `FACES`
  // and the video registry were joined by NOTHING: a video module could be
  // promoted, rostered, and pass every unit gate in this file while its scene
  // was structurally incapable of booting.
  //
  // The mechanism, from `bootWithFace`: without `videoFaceWhy` a face takes the
  // AUDIO boot path, which spawns the node and then waits — with NO explicit
  // timeout, so it inherits the 90 s TEST timeout — for it to appear in
  // `pinned-mixmstrs.data.columns['1']`. A VIDEO module never joins a mixer
  // channel column; it joins the video zone. The predicate can therefore never
  // become true, and the scene dies at `page.waitForFunction: Test timeout of
  // 90000ms exceeded` WITHOUT EVER REACHING THE SCREENSHOT.
  //
  // ⚠ AND IT IS INDISTINGUISHABLE FROM A SLOW SCENE FROM THE OUTPUT ALONE — a
  // timeout at a `waitForFunction` reads as "CI is slow, raise the budget",
  // and raising it buys another 90 s of waiting for a condition that cannot
  // become true. That is why this is a UNIT gate: it answers "never" vs
  // "slower" before a shard is spent, which no e2e budget change can do.
  //
  // `backdraft` hit this as the first video face and the option's own
  // doc-comment records it in caps; `4plexvid` hit it again anyway, by reading
  // the `freezeFaceVideo` helper (which the flag ALSO gates) and concluding the
  // flag was a freeze opt-in it could decline. A doc-comment is not a gate, so
  // two independent agents made the same call. This is the gate.
  //
  // DENY BY DEFAULT with a NAMED, ANCHORED exemption — empty, and it should
  // stay empty: there is no such thing as a video face that boots into a mixer
  // column, so an entry here is almost certainly a misdiagnosis of some other
  // failure.
  const NO_VIDEO_FACE_WHY: readonly { type: string; why: string }[] = [];

  it('every faced VIDEO module declares `videoFaceWhy` on its roster entry', () => {
    const videoTypes = new Set(listVideoModuleDefs().map((d) => d.type));
    const exempt = new Set(NO_VIDEO_FACE_WHY.map((e) => e.type));
    const offenders = FACES.filter((f) => videoTypes.has(f.type) && !exempt.has(f.type))
      .filter((f) => !(f as { videoFaceWhy?: string }).videoFaceWhy?.trim())
      .map((f) => f.type)
      .sort();
    expect(
      offenders,
      'a VIDEO module is rostered without `videoFaceWhy`, so `bootWithFace` will send it down '
        + 'the AUDIO path and wait out the full 90 s test timeout for a mixer-column membership '
        + 'a video node never acquires. Both of its scenes fail, and they fail as a TIMEOUT '
        + 'rather than an error. Declare it — the field is the video-zone boot selector first '
        + 'and the freeze opt-in second.',
    ).toEqual([]);
  });

  it('the videoFaceWhy check has a SUBJECT, and its predicate can FAIL', () => {
    // Vacuity: a gate over an empty set is green and proves nothing. If the
    // video registry or the roster stopped resolving, THIS fails rather than
    // the sweep above passing silently.
    const videoTypes = new Set(listVideoModuleDefs().map((d) => d.type));
    const facedVideo = FACES.filter((f) => videoTypes.has(f.type)).map((f) => f.type);
    expect(facedVideo.length, 'faced VIDEO modules found in the roster').toBeGreaterThan(0);

    // ...and the predicate must be able to say NO. A rostered video entry with
    // the field absent, or blank, is the exact shape that shipped.
    const bad = [{ type: facedVideo[0]!, pages: 1 }, { type: facedVideo[0]!, pages: 1, videoFaceWhy: '  ' }];
    for (const entry of bad) {
      expect(
        !(entry as { videoFaceWhy?: string }).videoFaceWhy?.trim(),
        `a ${JSON.stringify((entry as { videoFaceWhy?: string }).videoFaceWhy)} videoFaceWhy must be REFUSED`,
      ).toBe(true);
    }
    // ...and a real declaration must be ACCEPTED, or the gate would refuse
    // everything and be equally useless.
    const good = { type: facedVideo[0]!, pages: 1, videoFaceWhy: 'a real reason, stated' };
    expect(!good.videoFaceWhy.trim()).toBe(false);
  });

  it('every videoFaceWhy exemption still names a faced video module', () => {
    const videoTypes = new Set(listVideoModuleDefs().map((d) => d.type));
    const dead = NO_VIDEO_FACE_WHY.filter(
      (e) => !videoTypes.has(e.type) || !rostered.has(e.type),
    ).map((e) => e.type);
    expect(
      dead,
      'an exemption naming a module that is no longer a rostered video face is stale — delete '
        + 'it, or it will quietly permit the next module that takes the same name.',
    ).toEqual([]);
  });

  it('every rostered face has a committed baseline for every tier it captures', () => {
    // ⚠ ANCHORED TO THE ARTIFACT, not to the list — the rule this repo applies
    // to every ledger. A roster entry whose PNGs are absent is exactly the
    // moog904a case above, and it is invisible to a comparison run that was
    // never told the file should exist.
    //
    // ⚠ "BOTH" BECAME "EVERY TIER IT CAPTURES" (2026-08-26), and that is not a
    // loosening: the subject is the same `faceTiers` list that decides which
    // scenes `workflow-shell-faces.spec.ts` REGISTERS. A face that captures one
    // tier has one test and needs one PNG; asserting two would demand a baseline
    // for a scene that does not exist. The direction that would be a loosening —
    // a PNG surviving for a tier nobody compares — is asserted in that spec,
    // against the same list.
    const missing: string[] = [];
    for (const type of [...rostered].sort()) {
      for (const tier of faceTiers(type)) {
        if (!existsSync(faceBaseline(type, tier))) missing.push(`face-${type}-${tier}.png`);
      }
    }
    expect(
      missing,
      'a rostered face scene has no committed baseline. Capture with ' +
        '`flox activate -- task vrt:commit` (vrt-update.yml on linux CI) and check the bot ' +
        'commit actually landed on the branch you are pushing — a merge of main onto a ' +
        `STALE local branch drops it silently: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the checks can FAIL — on a fabricated roster and a fabricated name', () => {
    // Without this, "no gaps" is indistinguishable from a predicate that cannot
    // find one. Both legs are exercised against synthetic inputs so the real
    // ones stay untouched.
    const promoted = new Set<string>(STRICT_FACES);
    // ⚠ FABRICATED FROM THE UNION, NOT FROM `FACES` — this control was the THIRD
    // site asserting promoted↔accounted-for, and it went red on the first
    // correctly-exempted face for the same reason the real check did: it
    // subtracted a set that had never heard of `FACES_WITHOUT_SCENES`, so
    // `milkdrop` read as a gap in a fabricated roster that was supposed to have
    // none. The control's INTENT is unchanged — an invented name must be caught,
    // and the real set must show no gaps — but it now measures that against the
    // same `ROSTERED_FACE_TYPES` the two live gates read.
    const fakeRoster = new Set([...ROSTERED_FACE_TYPES, 'definitelyNotAPromotedModule']);
    expect([...fakeRoster].filter((t) => !promoted.has(t))).toEqual([
      'definitelyNotAPromotedModule',
    ]);
    expect([...promoted].filter((t) => !fakeRoster.has(t))).toEqual([]);
    expect(existsSync(faceBaseline('definitelyNotAPromotedModule', 'dock'))).toBe(false);
    // ...and the positive half: a REAL rostered face resolves a real file, so
    // the existence probe is reading the right directory.
    //
    // ⚠ THIS USED TO PIN `[...rostered].sort()[0]`, AND THAT MEASURED THE WRONG
    // THING. The claim here is "the probe reads the right DIRECTORY". Pinning
    // the alphabetically-first entry instead asks "does that ONE face have a
    // baseline yet" — a different question, and one whose answer is legitimately
    // NO during the documented window in which a face is rostered but its
    // capture has not landed. Every new face passes through that window by
    // design (`--update-snapshots` cannot write a baseline the roster has not
    // asked for yet), so this control was one sort order away from failing for a
    // reason that has nothing to do with the instrument.
    //
    // It survived only by luck: the previous new faces did not sort first.
    // `4plexvid` does — a leading digit sorts before every letter — so it became
    // the subject of the control the moment it was rostered, and the control
    // reported "the existence probe is reading the wrong directory" about a
    // probe that was working perfectly.
    //
    // ⚠ AND THE FALSE DIAGNOSIS IS THE REAL COST. The sweep above ALREADY
    // reports an uncaptured baseline, by name, with the command that fixes it.
    // This leg firing too says the opposite thing — that the harness is
    // misconfigured — and sends the next author to the wrong place.
    //
    // Fixed at the SUBJECT: resolve across the WHOLE roster and require that at
    // least one real face resolves. That is exactly the "right directory" claim
    // and it stays falsifiable — a wrong directory resolves NOTHING, so this
    // goes red on the condition it names. It is a vacuity floor with enormous
    // slack (one, against the whole faced population), not a population count.
    const resolvable = [...rostered]
      .sort()
      .filter((t) => existsSync(faceBaseline(t, 'dock')));
    expect(
      resolvable.length,
      'the existence probe resolved NO rostered face at all. That is the DIRECTORY being wrong ' +
        '(a moved snapshot root, a bad faceBaseline join) — not a missing capture, which the ' +
        '"every rostered face has a committed baseline for every tier it captures" test above ' +
        'reports by name.',
    ).toBeGreaterThan(0);
  });
});
