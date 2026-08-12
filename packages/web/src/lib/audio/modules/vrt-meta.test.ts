// packages/web/src/lib/audio/modules/vrt-meta.test.ts
//
// Coverage self-test for the Playwright VRT suite.
//
// Asserts every registered audio + video + meta module has:
//   1. either a VRT baseline (via auto-enrollment from the registry
//      manifest) OR an explicit entry in EXEMPT_FROM_VRT with a reason
//   2. a baseline PNG under e2e/vrt/__screenshots__/vrt.spec.ts/.
//
// Catches the "added a new module, forgot the baseline" case in the
// vitest pass (~1s) rather than in the Playwright pass (~3min on CI),
// and well before the gallery deploys.
//
// EXEMPT_FROM_VRT lives in the shared e2e/vrt/vrt-exemptions.ts so vrt.spec.ts
// and this self-test agree on the source of truth — no risk of skew between a
// spec entry and an unaware self-test allowlist.
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
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

// Single source of truth (also imported by e2e/vrt/vrt.spec.ts).
// vitest's `resolve.alias` doesn't reach across the /e2e/ workspace
// without explicit config, so we use a relative path here.
import {
  EXEMPT_FROM_VRT,
  ALLOWED_PERMANENT_EXEMPT,
  STRICT_VRT_MODULES,
  VRT_MODULE_MASKS,
} from '../../../../../../e2e/vrt/vrt-exemptions';
import { VRT_SCENES } from '../../../../../../e2e/vrt/vrt-scenes';
import { VRT_LIVE_SURFACES } from '../../../../../../e2e/vrt/vrt-live-surfaces';

function repoRoot(): string {
  // This file lives at packages/web/src/lib/audio/modules/. Six `..`
  // hops up = repo root. Resolved from import.meta.dirname so the
  // result is invariant to vitest's working directory.
  return resolve(import.meta.dirname, '../../../../../..');
}

// ONE path per scene — no {platform} segment, matching vrt.config.ts's
// snapshotPathTemplate. If that template ever regrows a segment this resolves
// to a file that does not exist and every baseline test below goes red, which
// is the correct direction for the two to drift in.
function baselinePath(type: string): string {
  return resolve(repoRoot(), `e2e/vrt/__screenshots__/vrt.spec.ts/${type}.png`);
}

describe('VRT coverage self-test', () => {
  // Force-import the registration barrels so the registries are
  // populated. The web app's UI does this on first page load; in the
  // vitest pass we have to import them explicitly.
  // EXPLICIT TIMEOUT, measured. This is the first test to pull the three module
  // barrels, so it alone pays the whole registry-population cost: 1.48 s in
  // isolation, against vitest's 5 s DEFAULT. That is only ~3.4x headroom, and
  // the unit lane runs ~2.5x slower under parallel load (CLAUDE.md), which puts
  // the worst case within noise of the budget — it went red exactly once in a
  // full-suite run here and passed alone and in two re-runs, the signature of a
  // budget race rather than a hang. 30 s still BOUNDS a genuine hang (20x the
  // measured cost) while removing the false failure. The later tests in this
  // file re-import the same barrels from cache and cost nothing.
  it('imports module barrels so registries are populated', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const total =
      listModuleDefs().length + listVideoModuleDefs().length + listMetaModuleDefs().length;
    expect(total, 'at least one module is registered').toBeGreaterThan(0);
  }, 30_000);

  it('every registered module is covered by VRT or exempt with a reason', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const registered = [
      ...listModuleDefs().map((d) => d.type as string),
      ...listVideoModuleDefs().map((d) => d.type as string),
      ...listMetaModuleDefs().map((d) => d.type as string),
    ];
    // After the manifest-driven rewrite of vrt.spec.ts, "in spec" =
    // "in the registry AND not in EXEMPT_FROM_VRT". The spec derives
    // its iteration list from exactly this rule — keeping the test in
    // lockstep means no module can slip through both gates.
    const missing: string[] = [];
    for (const t of registered) {
      if (EXEMPT_FROM_VRT[t]) continue;
      // Auto-enrollment via the manifest pass — module shows up in the
      // VRT spec the moment it's registered. The only way a module
      // ends up here as "missing" is if vrt-meta + vrt-exemptions
      // were edited out of sync (the spec ignores an EXEMPT_FROM_VRT
      // entry, or someone deleted EXEMPT_FROM_VRT without committing
      // the baselines). Either way, the message points the reader at
      // the exemption file.
      if (!existsSync(baselinePath(t))) missing.push(t);
    }
    expect(
      missing,
      `capture a baseline (\`task vrt:commit\`, which dispatches vrt-update.yml on linux CI) ` +
        `or add an EXEMPT_FROM_VRT entry in e2e/vrt/vrt-exemptions.ts for: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every exempted module has a SUBSTANTIVE reason', () => {
    // Raised 10 → 40 (2026-08-10) when PERMANENT_EXEMPT_CEILING was deleted.
    // With the count gone, the NAME plus its reason is the whole review surface
    // for "this module ships with no visual coverage", so the reason has to
    // carry weight. 40 is not arbitrary: it is the same bar every other `why`
    // in the VRT gates already meets, and the shortest live reason today is 46
    // (cameraInput), so it is a floor under the existing corpus rather than a
    // migration. A ten-character reason is "no baseline" — the placeholder this
    // list grew 76 → 81 on.
    for (const [t, reason] of Object.entries(EXEMPT_FROM_VRT)) {
      expect(
        reason.length,
        `${t}: an EXEMPT_FROM_VRT entry needs a reason that says what covers the ` +
          `module instead, or why it cannot be captured. Got ${reason.length} chars.`,
      ).toBeGreaterThan(40);
    }
  });

  it('every VRT_SCENES key is a registered module type (no drift)', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const registered = new Set([
      ...listModuleDefs().map((d) => d.type as string),
      ...listVideoModuleDefs().map((d) => d.type as string),
      ...listMetaModuleDefs().map((d) => d.type as string),
    ]);
    for (const sceneType of Object.keys(VRT_SCENES)) {
      expect(
        registered.has(sceneType),
        `${sceneType} has a VRT scene but isn't a registered module`,
      ).toBe(true);
    }
  });

  it('VRT_SCENES module-under-test id is always "vrt-1" (matches vrt.spec.ts selector)', () => {
    for (const [type, scene] of Object.entries(VRT_SCENES)) {
      const hasVrt1 = scene.nodes.some((n) => n.id === 'vrt-1' && n.type === type);
      expect(hasVrt1, `${type}: scene.nodes must include {id:'vrt-1', type:'${type}'}`).toBe(true);
    }
  });

  // -------------------------------------------------------------------
  // STRICT_VRT_MODULES coverage — the deterministic subset is the gate
  // inside `task ci`. These invariants keep the gate honest:
  //   * a strict module MUST ship a committed baseline.
  //   * a strict module MUST NOT be in VRT_MODULE_MASKS (a mask means
  //     the canvas is non-deterministic; if we mask it the diff is no
  //     longer end-to-end semantic — covered by the full lane instead).
  //   * a strict module MUST NOT be in EXEMPT_FROM_VRT (can't both
  //     skip + gate).
  //   * a strict module MUST be a registered module (no drift).
  // -------------------------------------------------------------------
  it('every STRICT_VRT_MODULES entry has a committed baseline', () => {
    const missing = [...STRICT_VRT_MODULES].filter((t) => !existsSync(baselinePath(t)));
    expect(
      missing,
      `STRICT_VRT_MODULES entries gate the required vrt-strict lane, so each needs a ` +
        `committed baseline. Capture via \`task vrt:commit\` (vrt-update.yml on linux CI): ` +
        `${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('no STRICT_VRT_MODULES entry has a canvas mask (defeats the diff)', () => {
    // BOTH mask tables, deliberately. This check used to read only
    // VRT_MODULE_MASKS; once masks could also come from the live-surface
    // registry (e2e/vrt/vrt-live-surfaces.ts) that made it a gate reading one
    // side of a two-sided contract — a strict module could be masked via the
    // registry and this test would have stayed green. Every source of masking
    // has to be enumerated here or the invariant is fiction.
    const masked: string[] = [];
    for (const t of STRICT_VRT_MODULES) {
      if (t in VRT_MODULE_MASKS) masked.push(`${t} (VRT_MODULE_MASKS)`);
      if (t in VRT_LIVE_SURFACES) masked.push(`${t} (VRT_LIVE_SURFACES)`);
    }
    expect(
      masked,
      `STRICT_VRT_MODULES entries with a mask entry have a masked region — the strict-lane ` +
        `diff would skip semantic content. Either remove the mask (the card is actually ` +
        `deterministic) or remove the module from STRICT_VRT_MODULES: ${masked.join(', ')}`,
    ).toEqual([]);
  });

  it('...and that check can actually SEE a registry mask (negative control)', () => {
    // Guard the guard. The test above passes when nothing is masked, which is
    // also what it would do if the VRT_LIVE_SURFACES half were dropped in a
    // refactor. Run the same predicate over a synthetic strict set that DOES
    // contain a registry-masked module and require it to flag it.
    const registryMasked = Object.keys(VRT_LIVE_SURFACES);
    expect(
      registryMasked.length,
      'the live-surface registry is empty, so this control proves nothing',
    ).toBeGreaterThan(0);
    const syntheticStrict = new Set<string>([registryMasked[0]]);
    const flagged = [...syntheticStrict].filter(
      (t) => t in VRT_MODULE_MASKS || t in VRT_LIVE_SURFACES,
    );
    expect(flagged).toEqual([registryMasked[0]]);
  });

  it('no STRICT_VRT_MODULES entry is also in EXEMPT_FROM_VRT', () => {
    const conflict: string[] = [];
    for (const t of STRICT_VRT_MODULES) {
      if (EXEMPT_FROM_VRT[t]) conflict.push(t);
    }
    expect(
      conflict,
      `STRICT_VRT_MODULES + EXEMPT_FROM_VRT conflict (can't both skip + gate): ${conflict.join(', ')}`,
    ).toEqual([]);
  });

  it('every STRICT_VRT_MODULES entry is a registered module type', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const registered = new Set([
      ...listModuleDefs().map((d) => d.type as string),
      ...listVideoModuleDefs().map((d) => d.type as string),
      ...listMetaModuleDefs().map((d) => d.type as string),
    ]);
    const ghosts: string[] = [];
    for (const t of STRICT_VRT_MODULES) {
      if (!registered.has(t)) ghosts.push(t);
    }
    expect(
      ghosts,
      `STRICT_VRT_MODULES entries not in the module registry (typo or unregistered module): ${ghosts.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * ⚠ `STRICT_VRT_MODULES.size >= 48` IS GONE (2026-08-12, the no-ratchets sweep).
 *
 * WHAT IT PROTECTED, traced before deleting rather than assumed: DEMOTION. A
 * card quietly removed from STRICT_VRT_MODULES stops gating the required
 * `vrt-strict` lane, which is a way to make a red visual diff green. None of
 * the four surviving checks above catch that — "every entry has a committed
 * baseline", "no entry has a canvas mask", "no entry is also in
 * EXEMPT_FROM_VRT" and "every entry is a registered module type" all quantify
 * over the set, so every one of them is trivially satisfied by a SMALLER set.
 *
 * WHY IT GOES ANYWAY, and why no successor counter is written. Unlike
 * STRICT_DOCS and STRICT_FACES — whose membership is now DERIVED from a
 * property of the def (complete docs / a declared `face`), so un-promotion is
 * red by construction — strict-VRT membership is an editorial judgement about
 * DETERMINISM that nothing in the tree records, so there is no artifact to
 * anchor to. And the floor was not doing the job anyway: the set was 48 against
 * a floor of 48 at deletion, but the same file's history shows it lagging
 * (49 → 48 for a real deletion), which is the slack that hides the next
 * demotion. What remains is the diff: a demotion is one deleted name in
 * vrt-exemptions.ts, a file the post-merge conflict sweep already watches.
 * This is pre-authorised coverage loss, named in the sweep PR's body rather
 * than absorbed silently.
 *
 * ⚠ IF a DECLARED determinism property ever lands on a def or a VrtScene, this
 * is the check to re-derive membership from — not a new floor.
 */

/**
 * ⚠ `PERMANENT_EXEMPT_CEILING` (81) IS GONE (2026-08-10). It counted the
 * entries of a list this file ALREADY pins name-for-name: the last assertion in
 * this block asserts `[...ALLOWED_PERMANENT_EXEMPT].sort()` EQUALS
 * `Object.keys(EXEMPT_FROM_VRT).sort()`, so the deny-by-default property the
 * ceiling was credited with — "a new module cannot self-exempt" — is carried by
 * the ALLOWLIST, not by the number. Adding an exemption already costs two named
 * edits plus a >40-char reason, all of which appear in the diff; the count added
 * a third place to notice the same thing and a hand-typed literal in a file
 * three concurrent face branches edit. Verified before deleting: with the
 * ceiling removed, the synthetic `someBrandNewModule` in the negative control
 * below is still refused.
 */
describe('vrt-meta — EXEMPT_FROM_VRT is DENY-BY-DEFAULT (frozen allowlist)', () => {
  // EXEMPT_FROM_VRT used to be a pure OPT-OUT: any module could remove itself
  // from visual coverage by adding a key with a >10-char reason. That gate
  // proved the string was long, never that skipping was justified — so the list
  // grew 76 → 81 with nothing able to notice. These four assertions are the
  // brake the vrt-zero-exemptions campaign always assumed existed.

  it('every exempted module is on the frozen allowlist (a new module CANNOT self-exempt)', () => {
    const unlisted = Object.keys(EXEMPT_FROM_VRT).filter((t) => !ALLOWED_PERMANENT_EXEMPT.has(t));
    expect(
      unlisted,
      `these modules exempted themselves from VRT without an allowlist entry: ${unlisted.join(', ')}.\n` +
        'Shipping a module with NO visual coverage is a reviewed decision. Either give it a ' +
        'VRT baseline (the strongly preferred path — see vrt-update.yml), or add it to ' +
        'ALLOWED_PERMANENT_EXEMPT in e2e/vrt/vrt-exemptions.ts with a reason that says what ' +
        'covers the module instead, so the exemption shows up in review by NAME.',
    ).toEqual([]);
  });

  it('no allowlist entry is STALE (anchored to the artifact, not the list)', () => {
    // A drained module must not leave a licence to silently re-exempt itself.
    const stale = [...ALLOWED_PERMANENT_EXEMPT].filter((t) => !(t in EXEMPT_FROM_VRT));
    expect(
      stale,
      `ALLOWED_PERMANENT_EXEMPT names modules that are no longer in EXEMPT_FROM_VRT: ${stale.join(', ')}. ` +
        'Delete them from the allowlist — a stale licence silently re-exempts the next module ' +
        'that reuses the name.',
    ).toEqual([]);
  });

  it('...and that check can actually SEE an unlisted exemption (negative control)', () => {
    // Guard against the gate silently reading an empty/short-circuited set —
    // the exact "green gate that checked nothing" failure this brake exists for.
    const syntheticExempt = { ...EXEMPT_FROM_VRT, someBrandNewModule: 'a plausible-looking ten-plus-character reason' };
    const unlisted = Object.keys(syntheticExempt).filter((t) => !ALLOWED_PERMANENT_EXEMPT.has(t));
    expect(unlisted).toEqual(['someBrandNewModule']);
    // ...and the stale check must see a phantom allowlist entry too.
    const syntheticAllow = new Set([...ALLOWED_PERMANENT_EXEMPT, 'aModuleThatWasDrained']);
    const stale = [...syntheticAllow].filter((t) => !(t in EXEMPT_FROM_VRT));
    expect(stale).toEqual(['aModuleThatWasDrained']);
  });

  it('the allowlist is non-empty and matches the live list exactly (no drift in either direction)', () => {
    expect(ALLOWED_PERMANENT_EXEMPT.size).toBeGreaterThan(0);
    expect([...ALLOWED_PERMANENT_EXEMPT].sort()).toEqual(Object.keys(EXEMPT_FROM_VRT).sort());
  });
});

// ── THE AUDIO FREEZE IS DENY-BY-DEFAULT ──────────────────────────────────────
//
// `bootWithFace` (e2e/vrt/_shell-faces.ts) suspends the AudioContext before it
// hands the scene back, because a face glyph is an AnalyserNode view of the
// module's own output and a running graph makes it a moving target. Modules in
// the roster today are all struck or silent, so a scene that skipped the freeze
// would look EXACTLY as green as one that took it — right up until the first
// free-running voice, which then cannot baseline at all.
//
// That is a gate whose green run means nothing unless opting out is loud. So
// the opt-out is DENIED BY DEFAULT and enumerated here, per file, with the
// exact occurrence count — the blind-gates inversion. A filename allowlist
// would exempt a whole file forever; a count means a NEW opt-out in an
// ALREADY-LISTED file still reddens.
//
// TWO MECHANISMS can capture a VRT scene off a running graph, and both are
// counted here rather than one being left to prose:
//
//   A. `bootWithFace(…, { freezeAudio: <not true> })` — source-scanned, below.
//   B. `VRT_SCENES[type].freezeAudio === false` — read STRUCTURALLY off the
//      imported table (anchored to the artifact, not to source text).
//
// ⚠ STATED SCOPE. The mechanism-A scan reads only files that CALL
// `bootWithFace`, with comments stripped, and matches the property form. It
// cannot see an options object assembled dynamically (`o.freezeAudio = false`,
// `o['freezeAudio']`), so those forms are separately asserted at ZERO rather
// than assumed absent.
//
// ⚠ `SCENE_FREEZE_OFF_CEILING = 7` IS GONE (2026-08-10). It counted mechanism
// B and could say nothing about any individual entry. Mechanism B is now
// deny-by-default IN THE TYPE — `VrtScene` makes `freezeAudioWhy` required
// whenever `freezeAudio: false`, so `tsc` refuses an undeclared opt-out before
// a test ever runs — and the assertion below checks the reason is substantive
// rather than checking how many there are.
//
// ⚠ AND THE TWO MECHANISMS ARE NOT REDUNDANT WITH EACH OTHER, contrary to the
// plan that scheduled this deletion. `FREEZE_OPT_OUTS` below enumerates
// `bootWithFace` CALL SITES in the e2e/vrt specs (3 files, 5 sites); the
// ceiling counted VRT_SCENES TABLE ENTRIES (7 scenes). Disjoint populations,
// disjoint mechanisms — measured before deleting either.

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
