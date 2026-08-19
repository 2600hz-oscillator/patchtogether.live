// packages/web/src/lib/audio/mono-normal-not-defeated.test.ts
//
// A FACTORY CAN SILENTLY DISAGREE WITH ITS DSP.
//
// Five modules shipped a stereo input whose RIGHT channel was digital silence
// for every mono patch the app can build. In each case the DSP was CORRECT: it
// declared a mono normal (`inputs[1]?.[0] ?? inputs[0]?.[0]`, cofefve even
// commenting "// R normals to L") so an unpatched R would follow L. The
// FACTORY then defeated it, two different ways:
//
//   * clouds / shimmershine / charlottes-echos / cofefve pinned a 0-valued
//     ConstantSource to worklet input 1 for "liveness". A connected input is
//     never absent, so Chrome handed the processor a permanently-silent
//     channel and the `??` fallback could never fire.
//   * resofilter carries its stereo on two CHANNELS of ONE input and set
//     `channelInterpretation: 'discrete'`, whose up-mix ZERO-FILLS channel 1
//     for a mono source — so `inAudio[1] ?? inAudio[0]` likewise never fell
//     through.
//
// Measured OUT R peak for a mono source into L, before → after:
//   clouds 0.0000e+0 → 6.8858e-1 | shimmershine 0.0000e+0 → 4.4212e-1
//   charlottes-echos 0.0000e+0 → 8.5852e-1 | cofefve 0.0000e+0 → 9.3254e-1
//   resofilter 0.0000e+0 → 4.9990e-1
//
// WHY NOTHING CAUGHT IT. Every existing gate reads the side that was right.
// The ART scenarios drive the DSP class DIRECTLY and never call `def.factory()`;
// the per-port sweep measures against a fixed floor and never compares a
// module's own L to its own R; the docs gate reads prose, and cofefve's and
// resofilter's docs PROMISED the normal while the code delivered silence.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND THEN THIS GATE — the one written to stop a SIXTH module joining that
// class — SHIPPED BLIND TO 46 % OF THE POPULATION IT GUARDS.
//
// The detector it shipped with (#1343) was a single regex matching a single
// expression on a single line:
//
//     /inputs\[(\d+)\]\?\.\[0\]\s*\?\?\s*inputs\[(\d+)\]\?\.\[0\]/
//
// Run verbatim over all 63 files in packages/dsp/src it finds 7 normals.
// THERE ARE 13. It missed six, in five modules, every one of which spells the
// same fallback through intermediate consts:
//
//     stereovca.ts:65,66        const inR = inRRaw ?? inLBuf;          (×2)
//     samsloop-tap.ts:67        const rNorm = rRaw ?? lRaw;
//     ringback.ts:72            const inR = inputs[1]?.[0] ?? inL;
//     twotracks.ts:606          const inR = inputs[inputOffset + 1]?.[0] ?? inL;
//     recorderbox-capture.ts:53 const r = input?.[1] ?? l;
//
// It reported "0 violations" and every assertion it made was TRUE — about the
// 54 % it could see. This is the repo's signature defect, for the fifth
// recorded time: A FILTER APPLIED BEFORE THE CHECK SILENTLY REDEFINES THE
// CHECK'S SUBJECT. `RAW_PARAM_WRITE` matched only the bracket form (3 of 99);
// `RANGE_BOUND_CARDS` was an opt-in filename list (7 of 193); `if (!p.edge)
// continue` skipped 299 of 362 ports; `Math.max(90_000, …)` was flat for 74 of
// 78. Here the filter was a regex literal.
//
// The shipped NEGATIVE CONTROLS did not help, because they only ever fed the
// detector the shape it could already see — `findMonoNormals('x.ts',
// 'const inR = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;')`. A control built
// from the instrument's own assumptions cannot discover the instrument's blind
// spot. The matrix below feeds it EVERY supported spelling, in both polarities,
// and feeds it the REAL source of every module that was missed.
//
// The blindness was also masking a CRASH: the shipped `factoryFor()` assumed
// "same basename for every module today", but samsloop-tap.ts's worklet is
// built by samsloop.ts and recorderbox-capture.ts's by a VIDEO module. The
// moment the detector could see either normal, the gate would have thrown
// ENOENT. Factory resolution is now DERIVED from the registered processor name
// across both module directories.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW THIS IS NOW HELD OPEN. The scan itself lives in ./mono-normal-scan.ts and
// resolves NAMES to input references, so spelling stopped mattering. But a
// resolver is still a finite set of forms, so the gate does not rely on it
// alone. Three independent legs, each blind in a DIFFERENT way:
//
//   1. THE RESIDUAL AUDIT. Every fallback expression in the tree is classified;
//      one whose left operand denotes a worklet input but whose fallback the
//      resolver cannot account for is `unclassified` → RED. A new unmatchable
//      spelling reddens instead of shrinking the subject.
//   2. THE DEF-ANCHORED POPULATION. Independently of any DSP text, a module
//      whose DEF declares an L/R audio input pair AND an L/R audio output pair
//      is in the defect class by construction. Each must have a normal or a
//      named reason. A normal spelled unreadably shows up HERE.
//   3. THE E2E ROSTER PARITY. The behavioural spec's hand-written SUTS roster
//      is checked against the found-set, so it cannot drift the way the VRT
//      FACES set did — which is exactly how stereovca went unmeasured.
//
// The behavioural counterpart is e2e/tests/stereo-mono-normal.spec.ts, which
// measures the real factory through the real engine.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  scanDspTree, scanSource, factoriesFor, defeatReason, normalKey, moduleTypeOf,
  findStereoModules, isLiteralIdx, lrPairs, lrSplit, blankNonCode, blankComments,
  resolveOperand, buildEnv, SCOPE, DSP_DIR,
  type MonoNormal, type Spelling,
} from './mono-normal-scan';

const E2E_SPEC = fileURLToPath(
  new URL('../../../../../e2e/tests/stereo-mono-normal.spec.ts', import.meta.url),
);

// ---------------------------------------------------------------------------
// THE PINNED POPULATION. Anchored to the artifact: each entry must still be
// found in the source, and the found-set must contain nothing unpinned. Add a
// row when you add a mono normal.
//
// 13 entries. The shipped gate pinned 7 — see the header for the six it could
// not see.
// ---------------------------------------------------------------------------

const KNOWN_MONO_NORMALS: readonly string[] = [
  'charlottes-echos.ts:input:1',
  'clouds.ts:input:1',
  'cofefve.ts:input:1',
  'recorderbox-capture.ts:channel:1',   // capture tap: R channel ← L channel
  'resofilter.ts:channel:1',
  'ringback.ts:input:1',
  'samsloop-tap.ts:input:1',
  'shimmershine.ts:input:1',
  'sidecar.ts:input:1',                 // MAIN  audio_r → audio_l
  'sidecar.ts:input:3',                 // SIDECHAIN sc_r → sc_l
  'stereovca.ts:input:1',               // MAIN  in_r → in_l
  'stereovca.ts:input:3',               // STRENGTH strength_r → strength_l
  'twotracks.ts:input:inputOffset + 1', // symbolic — see SYMBOLIC_INDEX_EXPANSIONS
  'vst-bridge.ts:input:IN_R',           // symbolic — see SYMBOLIC_INDEX_EXPANSIONS
];

/**
 * A normal whose worklet-input index is a computed expression rather than a
 * literal. The scanner still FINDS it (that is the point — a symbolic index
 * must not make a normal invisible), but it cannot check a factory pin without
 * knowing which concrete inputs the symbol takes. So the concrete set is
 * declared here, with the evidence, and every one of them is checked.
 *
 * DENY BY DEFAULT: a symbolic normal that is not listed here is RED.
 */
const SYMBOLIC_INDEX_EXPANSIONS: Readonly<Record<string, { indices: number[]; why: string }>> = {
  'twotracks.ts:input:inputOffset + 1': {
    indices: [1, 3],
    why: 'twotracks runs ONE reel routine twice — `processReel(…, inputs, 0, …)` for reel A '
      + '(twotracks.ts:904) and `…, inputs, 2, …` for reel B (twotracks.ts:916) — so '
      + '`inputOffset + 1` is worklet input 1 and input 3. Both are checked.',
  },
  'vst-bridge.ts:input:IN_R': {
    indices: [1],
    why: 'vst-bridge names its worklet input indices as consts (IN_L = 0, IN_R = 1, … — the '
      + 'header I/O map); `inputs[IN_R]?.[0] ?? inL` is worklet input 1, the fx right channel. '
      + 'The normal feeds BOTH the bridge ring write and the not-connected local bypass.',
  },
};

/**
 * Mono normals allowed to stay defeated, keyed by `normalKey`, with the reason.
 * DENY BY DEFAULT — a module is not exempt because its file is listed, only
 * that exact normal is.
 *
 * EMPTY, and it should stay that way: a defeated normal is a silent channel.
 */
const DEFEAT_EXEMPT: Readonly<Record<string, string>> = {};

/**
 * Modules whose DEF is a true L/R stereo pair in AND out — so they are in the
 * silent-OUT-R class by construction — but which declare NO mono normal at all.
 *
 * This is the def-anchored leg (#2), and it found two the text scan never
 * could, because there is no fallback expression to find. Each needs a reason.
 *
 * ⚠ Neither is fixed here: changing what a module renders is an audio behaviour
 * change needing an owner ear and an ART re-pin, and this PR is a gate fix.
 */
const STEREO_WITHOUT_NORMAL: Readonly<Record<string, string>> = {
  'cloudseed.ts': 'SUSPECTED SIXTH MEMBER OF THE CLASS, by a THIRD mechanism. cloudseed.ts:1510-11 '
    + 'reads `const inL = inputs[0]?.[0]; const inR = inputs[1]?.[0];` with NO `??` fallback, so a '
    + 'mono patch into in_l leaves inR undefined rather than normalled. Its factory pins nothing, '
    + 'so this is not a DEFEATED normal — it is a MISSING one, which is outside what this gate '
    + 'asserts (that a DECLARED normal stays reachable). Flagged for a follow-up that measures '
    + 'OUT R through the real engine BEFORE any DSP change.',
  'qbrt.ts': 'FAUST module: its DSP is packages/dsp/src/qbrt.dsp and this scanner reads only '
    + '*.ts. A Faust-generated processor cannot express the TS normal shape at all, so this is a '
    + 'stated blind spot rather than a defect claim — see SCOPE.notScanned.',
};

/**
 * Modules that DO declare a normal but are deliberately absent from the
 * behavioural roster of e2e/tests/stereo-mono-normal.spec.ts, with the reason.
 * Keyed by registry type. DENY BY DEFAULT: a normal-bearing module missing from
 * both the roster and this list is RED.
 */
const E2E_ROSTER_EXEMPT: Readonly<Record<string, string>> = {
  sidecar: 'PASSES and always did — it is this gate\'s positive control below (two normals, '
    + 'factory pins nothing). Adding it to the e2e roster costs ~10 s of CI wall-time to '
    + 're-prove what the source leg already proves; revisit if it ever regresses.',
  twotracks: 'Its stereo path is already measured end-to-end by e2e/tests/twotracks-stereo.spec.ts, '
    + 'which asserts out_l and out_r are separable jacks via a sample-aligned difference node. '
    + 'That spec does not drive a MONO source specifically, so this is PARTIAL coverage and a '
    + 'known follow-up.',
  ringback: 'FOLLOW-UP. A true stereo pair with a live normal (`inputs[1]?.[0] ?? inL`) and a '
    + 'factory that pins nothing, so it is expected clean — but unlike stereovca it has NOT been '
    + 'measured through the real engine, and this PR does not add an unmeasured module to a '
    + 'roster whose entire purpose is measurement.',
  samsloop: 'STRUCTURALLY OUT OF THE CLASS: the samsloop-tap normal feeds a recording TAP, and '
    + 'the samsloop def exposes a single mono `out` port — there is no OUT R jack to measure.',
  recorderbox: 'STRUCTURALLY OUT OF THE CLASS: recorderbox-capture is a video-domain capture tap '
    + 'whose def exposes no audio OUTPUT ports at all.',
};

// ---------------------------------------------------------------------------

const scan = scanDspTree();
const normals = scan.normals;

/** Concrete worklet-input indices to check a pin against. */
function concreteIndices(n: MonoNormal): number[] {
  if (isLiteralIdx(n.normalled)) return [n.normalled];
  return SYMBOLIC_INDEX_EXPANSIONS[normalKey(n)]?.indices ?? [];
}

describe('mono normals are not defeated by their factory', () => {
  it('every mono normal in the DSP is REACHABLE through its factory', () => {
    const defeated: string[] = [];
    for (const n of normals) {
      if (normalKey(n) in DEFEAT_EXEMPT) continue;
      const factories = factoriesFor(n.dspFile);
      expect(
        factories.length,
        `no factory found for ${n.dspFile} — the processor-name derivation failed, so this `
        + 'normal is UNCHECKED rather than clean',
      ).toBeGreaterThan(0);
      for (const idx of concreteIndices(n)) {
        for (const f of factories) {
          const reason = defeatReason(n, f.src, idx);
          if (reason) defeated.push(`${n.dspFile}:${n.line} (via ${f.file}) — ${reason}`);
        }
      }
    }
    expect(
      defeated,
      'A DSP declared a mono normal and its factory defeats it, so the normalled '
      + 'channel renders DIGITAL SILENCE for every mono patch:\n  ' + defeated.join('\n  '),
    ).toEqual([]);
  });

  it('is ANCHORED to the artifact, and ratchets in BOTH directions', () => {
    const seen = normals.map(normalKey).sort();
    const pinned = [...KNOWN_MONO_NORMALS].sort();

    // (a) nothing pinned has vanished — a refactor that drops a normal silently
    //     re-opens the silent-channel defect.
    expect(
      pinned.filter((k) => !seen.includes(k)),
      'These mono normals are pinned but no longer present in packages/dsp/src. Restore it, '
      + 'or remove the row deliberately.',
    ).toEqual([]);

    // (b) …AND nothing found is unpinned. A ceiling can only trip by GROWING;
    //     without this direction a NEW module could join the class and the gate
    //     would quietly widen to accommodate it.
    expect(
      seen.filter((k) => !pinned.includes(k)),
      'A mono normal exists in packages/dsp/src that is NOT pinned in KNOWN_MONO_NORMALS. '
      + 'Add it, and give the module e2e coverage or an E2E_ROSTER_EXEMPT reason.',
    ).toEqual([]);

    expect(seen).toEqual(pinned);
  });

  it('every SYMBOLIC index is expanded to concrete inputs, and none is stale', () => {
    for (const n of normals) {
      if (isLiteralIdx(n.normalled)) continue;
      const k = normalKey(n);
      expect(
        SYMBOLIC_INDEX_EXPANSIONS[k],
        `${k} has a computed worklet-input index, so no factory pin can be checked for it `
        + 'until the concrete inputs are declared. Add a SYMBOLIC_INDEX_EXPANSIONS entry.',
      ).toBeDefined();
      expect(SYMBOLIC_INDEX_EXPANSIONS[k]!.indices.length).toBeGreaterThan(0);
    }
    // Anchored: a declared expansion naming a normal that no longer exists is a
    // stale entry nobody is watching.
    const symbolic = new Set(normals.filter((n) => !isLiteralIdx(n.normalled)).map(normalKey));
    for (const k of Object.keys(SYMBOLIC_INDEX_EXPANSIONS)) {
      expect(symbolic.has(k), `SYMBOLIC_INDEX_EXPANSIONS names "${k}", not a symbolic normal`).toBe(true);
    }
  });

  it('ratchets DEFEAT_EXEMPT in both directions and keeps no stale entry', () => {
    expect(Object.keys(DEFEAT_EXEMPT)).toHaveLength(0);
    const seen = new Set(normals.map(normalKey));
    for (const k of Object.keys(DEFEAT_EXEMPT)) {
      expect(seen.has(k), `DEFEAT_EXEMPT names "${k}", which is not a mono normal in the source`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // LEG 1 — THE RESIDUAL AUDIT. This is what makes the coverage PROVED rather
  // than asserted, and it is the leg the shipped gate had no analogue of.
  // -------------------------------------------------------------------------
  describe('residual audit: no fallback expression is left unaccounted for', () => {
    it('classifies every candidate; UNCLASSIFIED is zero', () => {
      const unclassified = scan.candidates.filter((c) => c.verdict === 'unclassified');
      expect(
        unclassified.map((c) => `${c.dspFile}:${c.line} \`${c.left}\` ?? \`${c.right}\` — ${c.why}`),
        'A fallback whose LEFT operand denotes a worklet input could not be accounted for. '
        + 'If it is a mono normal, this gate is BLIND to it — the exact defect this file exists '
        + 'to prevent. Teach resolveOperand the spelling, or classify it.',
      ).toEqual([]);
      // Non-vacuity, the other way: the audit must actually be looking at
      // things. A scanner that silently matched nothing would satisfy the line
      // above. (`> 300` stood here until 2026-08-12 — the tree measured ~307,
      // so it was a floor sitting ON the population and any legitimate DSP
      // deletion reddened it. Replaced with the DERIVED form, which is both
      // stronger and stable: every pinned mono normal must appear among the
      // candidates, because a normal that is not even a candidate is a normal
      // the scanner has gone blind to.)
      const candidateKeys = new Set(scan.candidates.map((c) => c.dspFile));
      expect(
        [...KNOWN_MONO_NORMALS].map((k) => k.split(':')[0]!).filter((f) => !candidateKeys.has(f)),
        'pinned mono normal(s) whose DSP file yielded NO fallback candidate at all — the ' +
          'scanner stopped seeing that file, so every "no violations" assertion above is vacuous',
      ).toEqual([]);
    });

    it('resolves every identifier unambiguously', () => {
      expect(
        scan.ambiguous,
        'These identifiers are bound to two DIFFERENT input references in one file. Resolution '
        + 'is file-global, so the scanner refuses to guess — rename, or scope the analysis.',
      ).toEqual([]);
    });

    it('scanned the whole DSP tree, not a subset', () => {
      // `scan.files.length >= 63` stood here until 2026-08-12. 63 was EXACTLY
      // the number of non-test files under packages/dsp/src, so the floor sat
      // on the population: deleting any DSP module reddened it for no reason,
      // and adding one bought slack it never spent. Both halves of what it
      // claimed are DERIVED below instead — the walk must reach every file the
      // pin list names, and the found set must equal the pinned set.
      const scanned = new Set(scan.files);
      expect(
        [...KNOWN_MONO_NORMALS].map((k) => k.split(':')[0]!).filter((f) => !scanned.has(f)),
        'the DSP walk did not reach file(s) that the pin list says carry a mono normal — ' +
          'the scan narrowed, so the assertions above are quantifying over a subset',
      ).toEqual([]);
      expect(normals.length).toBe(KNOWN_MONO_NORMALS.length);
    });
  });

  // -------------------------------------------------------------------------
  // LEG 2 — THE DEF-ANCHORED POPULATION. Blind in a different way from the text
  // scan: it never reads a fallback expression at all.
  // -------------------------------------------------------------------------
  describe('def-anchored population: every L/R stereo module is accounted for', () => {
    const stereo = findStereoModules();
    const withNormal = new Set(normals.map((n) => n.dspFile));

    it('every stereo-in/stereo-out module has a normal or a NAMED reason', () => {
      const unexplained = stereo
        .filter((m) => !(m.dspFile && withNormal.has(m.dspFile)))
        .filter((m) => !(m.file in STEREO_WITHOUT_NORMAL))
        .map((m) => `${m.file} (in ${JSON.stringify(m.inPairs)} → out ${JSON.stringify(m.outPairs)})`);
      expect(
        unexplained,
        'This module declares an L/R audio input pair AND an L/R audio output pair, so a mono '
        + 'patch into its LEFT input can leave OUT R at digital silence — but no mono normal was '
        + 'detected for it. Either it has one the scanner cannot read (this gate is then BLIND — '
        + 'fix the scanner), or it genuinely has none (a defect — measure OUT R). Do not add a '
        + 'STEREO_WITHOUT_NORMAL row without doing one of those.',
      ).toEqual([]);
    });

    it('keeps no stale STEREO_WITHOUT_NORMAL row', () => {
      const gaps = new Set(
        stereo.filter((m) => !(m.dspFile && withNormal.has(m.dspFile))).map((m) => m.file),
      );
      for (const f of Object.keys(STEREO_WITHOUT_NORMAL)) {
        expect(
          gaps.has(f),
          `STEREO_WITHOUT_NORMAL names "${f}", which either is no longer a stereo module or now `
          + 'HAS a normal. A stale exemption is one nobody is watching — remove the row.',
        ).toBe(true);
      }
      // ⚠ `CEILING` (2) IS GONE (2026-08-12, the no-ratchets sweep). It was a
      // hand-typed copy of `Object.keys(STEREO_WITHOUT_NORMAL).length`, and the
      // two properties it was credited with are both carried elsewhere on this
      // same describe: a module that needs a row and has none is RED at the
      // `unexplained → toEqual([])` above (deny-by-default), and a row naming a
      // module that no longer needs one is RED at the loop above (the artifact
      // anchor). Adding a THIRD row is therefore already a named, reasoned diff
      // — the number only added a second place to notice it, in a file two
      // concurrent stereo branches edit.
    });

    it('the def-anchored instrument is non-vacuous', () => {
      // If the def parser silently read nothing, every assertion above passes.
      // (`stereo.length >= 10` stood here until 2026-08-12; the tree measured
      // exactly 10, so it was a floor on the population, and the NAME on the
      // next line is the non-vacuity check that actually holds — a def parser
      // reading nothing cannot produce `stereovca.ts`.)
      expect(stereo.map((m) => m.file)).toContain('stereovca.ts');
      expect(stereo.every((m) => m.inPairs.length > 0 && m.outPairs.length > 0)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // LEG 3 — E2E ROSTER PARITY. The behavioural spec's SUTS list is
  // hand-maintained, exactly like the VRT FACES set; without this it drifts.
  // -------------------------------------------------------------------------
  describe('e2e roster parity: the behavioural spec cannot silently omit a module', () => {
    const specSrc = readFileSync(E2E_SPEC, 'utf8');
    const rosterSection = /const SUTS:[\s\S]*?\n\];/.exec(blankComments(specSrc))?.[0] ?? '';
    const roster = new Set(
      [...rosterSection.matchAll(/\btype:\s*'([A-Za-z0-9_$]+)'/g)].map((m) => m[1]!),
    );

    it('parsed a non-empty roster (the parser fails OPEN otherwise)', () => {
      expect(rosterSection).not.toBe('');
      // (`roster.size >= 6` stood here until 2026-08-12 with one slot of slack
      // against a roster of 7 — the NAME below is what makes a fail-open parse
      // impossible to miss, and it does not go stale when the roster grows.)
      expect(roster).toContain('clouds');
    });

    it('every normal-bearing module is in the roster or NAMED as exempt', () => {
      const missing: string[] = [];
      for (const dspFile of new Set(normals.map((n) => n.dspFile))) {
        const types = factoriesFor(dspFile)
          .map((f) => moduleTypeOf(f.src))
          .filter((t): t is string => !!t);
        if (types.length === 0) continue;
        if (types.some((t) => roster.has(t) || t in E2E_ROSTER_EXEMPT)) continue;
        missing.push(`${dspFile} → type(s) ${types.join('/')}`);
      }
      expect(
        missing,
        'This module declares a mono normal, but nothing in ANY lane measures its right channel: '
        + 'it is absent from the SUTS roster of e2e/tests/stereo-mono-normal.spec.ts and has no '
        + 'E2E_ROSTER_EXEMPT reason. This is exactly how stereovca went unseen.',
      ).toEqual([]);
    });

    it('stereovca — the specific miss — is now IN the behavioural roster', () => {
      // Not merely detected by the source scan: actually measured. Confirmed
      // clean by hand at OUT R peak 0.500000 (real Chrome, real dist) before
      // this row was added, so it is a live assertion and not a pending fix.
      expect(roster).toContain('stereovca');
    });

    it('keeps no stale E2E_ROSTER_EXEMPT row', () => {
      const liveTypes = new Set<string>();
      for (const dspFile of new Set(normals.map((n) => n.dspFile))) {
        for (const f of factoriesFor(dspFile)) {
          const t = moduleTypeOf(f.src);
          if (t) liveTypes.add(t);
        }
      }
      for (const t of Object.keys(E2E_ROSTER_EXEMPT)) {
        expect(
          liveTypes.has(t),
          `E2E_ROSTER_EXEMPT names "${t}", which no longer has a mono normal — remove the row.`,
        ).toBe(true);
        expect(
          roster.has(t),
          `"${t}" is BOTH in the e2e roster and in E2E_ROSTER_EXEMPT — drop the exemption.`,
        ).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // SCOPE — stated in the gate, and asserted rather than left as prose.
  // -------------------------------------------------------------------------
  describe('states what it CANNOT see', () => {
    it('reads only the top level of packages/dsp/src, and that is sufficient', () => {
      expect(SCOPE.dspDir).toBe('packages/dsp/src/*.ts');
      // The claim that skipping lib/** is safe: a pure core receives
      // Float32Arrays from a worklet entry, so it cannot declare a
      // worklet-input normal. If one ever does, this fails and scope must widen.
      const libDir = `${DSP_DIR}lib/`;
      const strays: string[] = [];
      for (const f of readdirSync(libDir)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
        const found = scanSource(f, readFileSync(`${libDir}${f}`, 'utf8')).normals;
        if (found.length) strays.push(`lib/${f}:${found[0]!.line}`);
      }
      expect(
        strays,
        'A mono normal was found in packages/dsp/src/lib/**, which this gate does NOT scan. '
        + 'Widen SCOPE.dspDir — until then that normal is unguarded.',
      ).toEqual([]);
    });

    it('names the defeat mechanisms it knows, and admits a third would be invisible', () => {
      expect(SCOPE.defeats).toHaveLength(2);
      expect(SCOPE.defeats).toContain('factory pin on the normalled worklet INPUT');
      // A factory that up-mixes UPSTREAM of the worklet, or feeds the normalled
      // input from a ChannelMerger, defeats a normal by a mechanism nothing here
      // models. Only the e2e counterpart can see that — which is why LEG 3
      // exists and why the roster is gated rather than advisory.
    });

    it('names the sources it does not read at all', () => {
      expect(SCOPE.notScanned).toContain('packages/dsp/src/*.dsp (Faust)');
      expect(Object.keys(STEREO_WITHOUT_NORMAL)).toContain('qbrt.ts');
    });
  });

  // =========================================================================
  // NEGATIVE-CONTROL MATRIX.
  //
  // The shipped controls fed the detector only the one shape it could see, so a
  // detector seeing 54 % of the population looked identical to one seeing all
  // of it. These fix that three ways:
  //   (a) EVERY supported spelling is fed in, and must be FOUND;
  //   (b) every spelling is fed in DEFEATED, and must go RED;
  //   (c) the REAL source of every module that was missed is fed in.
  // Plus a PERMANENT leg: the found-count may never fall below the known
  // population, so the next unmatchable spelling cannot pass silently.
  // =========================================================================
  describe('negative control: the detector can actually FAIL, in every spelling', () => {
    /** One row per supported spelling, each declaring `input:1 ← 0`. */
    const SPELLINGS: { spelling: Spelling; src: string }[] = [
      {
        spelling: 'direct',
        src: 'const inR = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;',
      },
      {
        spelling: 'alias',
        src: 'const inLBuf = inputs[0]?.[0];\nconst inRRaw = inputs[1]?.[0];\nconst inR = inRRaw ?? inLBuf;',
      },
      {
        spelling: 'mixed',
        src: 'const inL = inputs[0]?.[0];\nconst inR = inputs[1]?.[0] ?? inL;',
      },
      {
        spelling: 'destructured',
        src: 'const [l, r] = inputs[0];\nconst chR = r ?? l;',
      },
      {
        spelling: 'ternary',
        src: 'const inL = inputs[0]?.[0];\nconst inRRaw = inputs[1]?.[0];\nconst inR = inRRaw ? inRRaw : inL;',
      },
      {
        spelling: 'or',
        src: 'const inL = inputs[0]?.[0];\nconst inRRaw = inputs[1]?.[0];\nconst inR = inRRaw || inL;',
      },
    ];

    it.each(SPELLINGS)('FINDS the normal spelled $spelling', ({ spelling, src }) => {
      const found = scanSource('probe.ts', src).normals;
      expect(found.length, `spelling "${spelling}" was NOT detected:\n${src}`).toBe(1);
      expect(found[0]!.spelling).toBe(spelling);
      // `destructured` names two CHANNELS of input 0; the rest name input 1 ← 0.
      if (spelling === 'destructured') {
        expect(found[0]).toMatchObject({ kind: 'channel', normalled: 1, from: 0, onInput: 0 });
      } else {
        expect(found[0]).toMatchObject({ kind: 'input', normalled: 1, from: 0 });
      }
    });

    const PIN = 'silenceR.connect(workletNode, 0, 1);';
    const CLEAN_FACTORY = 'silenceL.connect(workletNode, 0, 0);\nsilenceClk.connect(workletNode, 0, 2);';

    it.each(SPELLINGS)('goes RED when the normal spelled $spelling is DEFEATED', ({ spelling, src }) => {
      const n = scanSource('probe.ts', src).normals[0]!;
      if (spelling === 'destructured') {
        // A CHANNEL normal is defeated by the up-mix law, not by a pin.
        expect(defeatReason(n, "channelInterpretation: 'discrete',")).toMatch(/discrete/);
        expect(defeatReason(n, "channelInterpretation: 'speakers',")).toBeNull();
        return;
      }
      expect(defeatReason(n, `${CLEAN_FACTORY}\n${PIN}`)).toMatch(/pins worklet input 1/);
      // …and does NOT fire on the fixed factory. A detector that flagged any
      // .connect() could not tell the fix from the defect: cofefve legitimately
      // pins input 0 (audio L) and input 2 (clock).
      expect(defeatReason(n, CLEAN_FACTORY)).toBeNull();
    });

    it('feeds it stereovca\'s REAL source — the specific miss — and sees BOTH normals', () => {
      const src = readFileSync(`${DSP_DIR}stereovca.ts`, 'utf8');
      const found = scanSource('stereovca.ts', src).normals;
      expect(found.map(normalKey).sort()).toEqual(['stereovca.ts:input:1', 'stereovca.ts:input:3']);
      expect(found.every((n) => n.spelling === 'alias')).toBe(true);
      // The SHIPPED regex, verbatim, on the same bytes: zero. This is the
      // measurement, kept executable so it cannot rot into a claim.
      const SHIPPED = /inputs\[(\d+)\]\?\.\[0\]\s*\?\?\s*inputs\[(\d+)\]\?\.\[0\]/;
      expect(src.split('\n').filter((l) => SHIPPED.test(l))).toEqual([]);
      // …and stereovca is CLEAN: measured OUT R peak 0.500000 in real Chrome.
      for (const n of found) {
        for (const f of factoriesFor('stereovca.ts')) expect(defeatReason(n, f.src)).toBeNull();
      }
    });

    it('feeds it samsloop-tap\'s REAL source, and resolves its NON-obvious factory', () => {
      const found = scanSource(
        'samsloop-tap.ts', readFileSync(`${DSP_DIR}samsloop-tap.ts`, 'utf8'),
      ).normals;
      expect(found.map(normalKey)).toEqual(['samsloop-tap.ts:input:1']);
      // The shipped gate assumed factory == same basename. There is no
      // modules/samsloop-tap.ts, so it would have thrown ENOENT right here.
      const factories = factoriesFor('samsloop-tap.ts');
      expect(factories.map((f) => f.file)).toEqual(['samsloop.ts']);
      expect(defeatReason(found[0]!, factories[0]!.src, 1)).toBeNull();
    });

    it('feeds it the OTHER real misses (ringback, twotracks, recorderbox-capture)', () => {
      for (const [file, key, spelling] of [
        ['ringback.ts', 'ringback.ts:input:1', 'mixed'],
        ['twotracks.ts', 'twotracks.ts:input:inputOffset + 1', 'mixed'],
        ['recorderbox-capture.ts', 'recorderbox-capture.ts:channel:1', 'alias'],
      ] as const) {
        const found = scanSource(file, readFileSync(`${DSP_DIR}${file}`, 'utf8')).normals;
        expect(found.map(normalKey), `${file} normal not found`).toContain(key);
        expect(found.find((n) => normalKey(n) === key)!.spelling).toBe(spelling);
      }
      // recorderbox-capture's factory is a VIDEO module — a search resolving
      // only lib/audio/modules/ finds nothing and reports clean.
      expect(factoriesFor('recorderbox-capture.ts').map((f) => f.file)).toEqual(['recorderbox.ts']);
    });

    it('does not INVENT normals where there are none', () => {
      expect(scanSource('z.ts', 'const inL = inputs[0]?.[0] ?? null;').normals).toEqual([]);
      expect(scanSource('z.ts', 'const x = a ?? b;').normals).toEqual([]);
      // the same index on both sides is degenerate, not a normal
      expect(scanSource('z.ts', 'const x = inputs[0]?.[0] ?? inputs[0]?.[0];').normals).toEqual([]);
      // outputs are not inputs
      expect(scanSource('z.ts', 'const o = outputs[1]?.[0] ?? outputs[0]?.[0];').normals).toEqual([]);
      // a per-sample guard resolves to a SAMPLE, not a channel
      expect(scanSource('z.ts', 'const inL = inputs[0]?.[0];\nconst v = inL ? inL[i] : 0;').normals).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // moduleTypeOf: the leg whose ABSENCE reddened main.
    //
    // The first version took the earliest `type:` in the whole file. #1353
    // hoisted `postSampleBuffer` — which posts `{ type: 'loadSample', … }` —
    // above samsloop's def, and this function's answer flipped from 'samsloop'
    // to 'loadSample'. No `type:` was added, removed or renamed; two existing
    // ones swapped order. The roster gate then claimed samsloop had lost its
    // normal AND that an unknown module was unmeasured — both false, both red.
    //
    // So the property under test is INVARIANCE TO CODE MOTION, asserted in both
    // directions on every run, not "does it return the right string once".
    // -----------------------------------------------------------------------
    it('reads the DEF type, not whatever `type:` comes first', () => {
      const def = "export const fooDef: AudioModuleDef = {\n  type: 'foo',\n  domain: 'audio',\n};";
      const post = "port.postMessage({ type: 'loadSample', samples: b });";

      // The exact regression: a payload `type:` ABOVE the def.
      expect(moduleTypeOf(`${post}\n${def}`)).toBe('foo');
      // …and BELOW it, which is what shipped green before #1353.
      expect(moduleTypeOf(`${def}\n${post}`)).toBe('foo');
      // The whole point: the answer does not depend on the order.
      expect(moduleTypeOf(`${post}\n${def}`)).toBe(moduleTypeOf(`${def}\n${post}`));

      // Video + synced defs resolve the same way (recorderbox-capture's factory
      // is a VIDEO module, so this arm is load-bearing, not decorative).
      expect(moduleTypeOf("export const barDef: VideoModuleDef = {\n  type: 'bar',\n};")).toBe('bar');
      expect(moduleTypeOf("export const lfoDef: SyncedModuleDef = {\n  type: 'lfo',\n};")).toBe('lfo');

      // A helper file exports no def — null, never a stray `type:` from a
      // message payload or a port descriptor.
      expect(moduleTypeOf(post)).toBeNull();
      expect(moduleTypeOf("const ports = [{ id: 'in', type: 'audio' }];")).toBeNull();

      // NEGATIVE CONTROL on this very assertion: the old implementation must
      // FAIL the invariance property, or the test above proves nothing.
      const firstMatch = (s: string) =>
        /(^|[^A-Za-z0-9_$])type:\s*'([A-Za-z0-9_$]+)'/m.exec(blankComments(s))?.[2] ?? null;
      expect(firstMatch(`${post}\n${def}`)).toBe('loadSample');
      expect(firstMatch(`${def}\n${post}`)).toBe('foo');
      expect(firstMatch(`${post}\n${def}`)).not.toBe(firstMatch(`${def}\n${post}`));
    });

    it('ANCHORED: samsloop.ts really does resolve to `samsloop` in the live tree', () => {
      // Not a synthetic — the actual file whose code motion broke main. If a
      // future refactor moves the def again, this is the line that reddens.
      const hits = factoriesFor('samsloop-tap.ts');
      expect(hits.length, 'samsloop-tap.ts must resolve to a factory').toBeGreaterThan(0);
      expect(hits.map((f) => moduleTypeOf(f.src))).toContain('samsloop');
    });

    it('cannot be fooled by PROSE — comments and strings are not code', () => {
      // cofefve's real comment is "// R normals to L"; this file's own header
      // quotes the defective expression several times.
      const proseOnly = '// const inR = inputs[1]?.[0] ?? inputs[0]?.[0];\n'
        + 'const label = "inputs[1]?.[0] ?? inputs[0]?.[0]";';
      expect(scanSource('z.ts', proseOnly).normals).toEqual([]);
      // …but the real thing on the SAME line as a comment still counts.
      expect(scanSource('z.ts', 'const inR = inputs[1]?.[0] ?? inputs[0]?.[0]; // R normals to L').normals)
        .toHaveLength(1);
    });

    it('blankComments keeps the string literals that blankNonCode destroys', () => {
      // Load-bearing: factory resolution and def parsing search for string
      // LITERALS (a processor name, a port id). Running them over blankNonCode
      // output matches nothing and silently reports "clean" — the same class of
      // bug as the original regex, one level down. This was a real defect in
      // the first draft of this scanner.
      const src = "registerProcessor('stereovca', P);";
      expect(blankComments(src)).toContain('stereovca');
      expect(blankNonCode(src)).not.toContain('stereovca');
      expect(blankNonCode(src)).toHaveLength(src.length); // offsets preserved
      expect(blankComments(src)).toHaveLength(src.length);
    });

    it('the RESIDUAL AUDIT itself goes red on a spelling the resolver cannot read', () => {
      // The permanent control on LEG 1. A fallback whose LEFT side resolves to a
      // worklet input but whose right side the resolver cannot account for must
      // be FLAGGED, never silently dropped.
      const halfKnown = 'const inR = inputs[1]?.[0] ?? mysteryBuffer;';
      const flagged = scanSource('probe.ts', halfKnown).candidates
        .filter((c) => c.verdict === 'unclassified');
      expect(flagged).toHaveLength(1);
      expect(flagged[0]!.why).toMatch(/BLIND/);

      // And the other polarity: an exotic left operand yields no normal, but is
      // still VISIBLE as a candidate rather than vanishing from the accounting.
      const exotic = 'const inL = inputs[0]?.[0];\nconst inR = someUnknownHelper(inputs) ?? inL;';
      const r = scanSource('probe.ts', exotic);
      expect(r.normals).toEqual([]);
      expect(r.candidates.length).toBeGreaterThan(0);
    });

    it('PERMANENT: the found set is exactly the pinned set, in all three spellings', () => {
      // The leg that makes the next unmatchable spelling impossible to ship
      // silently. If someone rewrites a module and the scanner stops seeing its
      // normal, this is red even though every "no violations" assertion above
      // would still pass.
      //
      // ⚠ `normals.length >= 13` STOOD HERE (removed 2026-08-12, the
      // no-ratchets sweep). 13 was `KNOWN_MONO_NORMALS.length`, so the only
      // case it caught that the DERIVED line below does not is a normal being
      // deleted from the DSP *and* its pin row deleted in the SAME commit.
      // That residual is named in the sweep PR's body. Two things still catch
      // most of it: for a stereo module it reddens `unexplained` in LEG 2 (an
      // L/R-in-and-out module with no normal and no STEREO_WITHOUT_NORMAL row),
      // and the spelling identity below reddens if a whole spelling class stops
      // resolving. A count could not tell those two apart anyway — it only said
      // "fewer", never which.
      expect(normals.length).toBe(KNOWN_MONO_NORMALS.length);
      // …and the spellings actually present in-tree are pinned, so a refactor
      // that changes HOW a normal is written is a visible, reviewed diff.
      const live = [...new Set(normals.map((n) => n.spelling))].sort();
      expect(live).toEqual(['alias', 'direct', 'mixed']);
    });

    it('the L/R pairing used by LEG 2 is controlled in both directions', () => {
      expect(lrPairs(['in_l', 'in_r'])).toEqual([['in_l', 'in_r']]);
      expect(lrPairs(['inL', 'inR'])).toEqual([['inL', 'inR']]);
      expect(lrPairs(['L', 'R'])).toEqual([['L', 'R']]);
      expect(lrPairs(['audio_l_in', 'audio_r_in'])).toEqual([['audio_l_in', 'audio_r_in']]);
      // …and does NOT invent pairs out of unrelated multi-input utilities,
      // which is what keeps the STEREO_WITHOUT_NORMAL ledger readable: 22
      // modules have 2+ audio ports each way, only 10 are real stereo pairs.
      expect(lrPairs(['in1', 'in2', 'in3', 'in4'])).toEqual([]);
      expect(lrPairs(['a_in', 'b_in'])).toEqual([]);
      expect(lrPairs(['ch1', 'ch2'])).toEqual([]);
      expect(lrSplit('out_positive')).toBeNull();
    });

    it('the alias resolver is controlled: it follows a chain and refuses a sample', () => {
      const { env } = buildEnv('const a = inputs[1];\nconst b = a;\nconst c = b[0];');
      expect(resolveOperand('c', env)).toEqual({ kind: 'channel', input: 1, channel: 0 });
      // indexing a CHANNEL yields a sample — must not resolve as a channel
      expect(resolveOperand('c[0]', env)).toBeNull();
      expect(resolveOperand('nothing', env)).toBeNull();
    });
  });
});
