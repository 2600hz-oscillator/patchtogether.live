// e2e/vrt/vrt-platform-gaps.ts
//
// THE ONE PLACE that enumerates how a VRT scene is declared MISSING on a
// platform — and the instrument the vrt-meta linux-deficit ratchet reads.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// CI renders on LINUX. A scene captured on darwin but skipped on linux is
// NEVER diffed on the platform that gates, so it contributes ZERO protection
// while still looking "covered" in every either-platform check. That gap is
// the linux DEFICIT, and vrt-meta.test.ts ratchets it toward zero.
//
// The ratchet used to count ONE declaration mechanism (the shared
// EXEMPT_BASELINE_PAIRS set) and reported it as "the deficit". Measured
// 2026-08-01 against the committed baselines on `main` (77cd1bbc):
//
//   ground truth (a darwin PNG with no linux sibling)  151
//   counted by the old ratchet                          89   (59 %)
//   INVISIBLE to it                                     62   (41 %)
//
// and the number it PRINTED was 119 — not 89 — because 30 of its entries name
// scenes that are not gaps at all (15 whose linux PNG is committed, 15 with no
// PNG on either platform). It was wrong in BOTH directions at once, which is
// the tell of a metric measuring the wrong thing rather than measuring badly:
// a count of DECLARATIONS masquerading as a count of GAPS.
//
// ---------------------------------------------------------------------------
// THE FOUR MECHANISMS
// ---------------------------------------------------------------------------
// Every linux gap in the repo is declared through exactly one of these. They
// are enumerated here so no future gate can read one and claim to speak for
// all four.
//
//  A. 'shared-pairs'            e2e/vrt/vrt-exemptions.ts → EXEMPT_BASELINE_PAIRS
//     A `linux/<scene>` string in the shared Set. ~19 spec files import it and
//     `test.skip()` on a hit. This is the one the old ratchet counted.
//
//  B. 'spec-local-pairs'        a PRIVATE `const EXEMPT_BASELINE_PAIRS` inside
//     a spec file. Same name, same shape, same `linux/<scene>` keys — but a
//     module-local binding that SHADOWS the shared one, so importing the
//     shared set tells you nothing about it. Four specs do this today
//     (dashboard, groups, interactions, landing).
//
//  C. 'hardcoded-platform-skip' `test.skip(VRT_PLATFORM === 'linux', …)`
//     A blanket, list-free skip written straight into the spec. There is no
//     Set to read at all — the declaration is a control-flow expression, so
//     it can only be found by reading the SOURCE. Eight specs are dark on
//     linux this way, and they are the single biggest contributor (49 scenes,
//     27 of them toybox).
//
//  D. 'scene-darwin-only'       `darwinOnly: true` on a CompositeVrtScene
//     A DATA flag on the scene record (e2e/vrt/vrt-composite-scenes.ts),
//     consumed by a second `test.skip()` in vrt-composite.spec.ts. Not an
//     exemption list and not in a spec file — a third shape again.
//
// ---------------------------------------------------------------------------
// HOW EACH IS READ (and why the two halves differ)
// ---------------------------------------------------------------------------
// A is IMPORTED — `vrt-exemptions.ts` is a plain data module, so we get the
// exact values with no parsing and no chance of a regex drifting from source.
//
// B, C and D are SOURCE-SCANNED. For B and C that is forced: a Playwright spec
// calls `test.describe()` at module scope, so importing one from vitest throws
// outside the Playwright runner — the declaration is only reachable as text.
// D is scanned for a different reason: `vrt-composite-scenes.ts` value-imports
// `spawnPatch` from `../tests/_helpers`, which imports `@playwright/test`, so
// importing it would drag the whole Playwright runner graph into the `unit`
// lane just to read three booleans. (It did, briefly — that is the defect this
// scan removes.) Its parse is anchored on FIELD INDENTATION: a scene's own
// `id:` and its `darwinOnly:` sit at the same depth, node ids sit deeper.
//
// Three guards keep the scans honest, because a parser that silently matches
// nothing returns a clean-looking zero:
//   * `assertParsersSeeSomething()` fails if any scan comes back empty.
//   * a scanned `darwinOnly` id that is not a real gap shows up in
//     `dead['scene-darwin-only']`, which is asserted empty — so a mis-parse
//     that returned a NODE id instead of a SCENE id fails loudly.
//   * a spec flagged as linux-dark (C) must have ZERO committed linux
//     baselines — if one appears, the blanket skip is lying and we say so.
//
// ⚠ MECHANISM C IS DETECTED PER FILE BUT WRITTEN PER TEST. One
// `test.skip(VRT_PLATFORM === 'linux', …)` anywhere promotes the whole file to
// "linux-dark", yet in all 8 specs the skip lives inside individual `test()`
// bodies. A NEW test added to such a file with NO skip would be silently
// attributed to C and stay invisible to the UNDECLARED gate. `darkSpecCoverage`
// closes that: a linux-dark spec must carry at least as many linux skips as it
// has `test()` sites (or hold the skip in a `test.beforeEach`, which covers all
// of them). Anything else is PARTIALLY dark and is reported, not absorbed.
//
// ---------------------------------------------------------------------------
// GROUND TRUTH IS ON DISK, NOT IN THE DECLARATIONS
// ---------------------------------------------------------------------------
// The deficit is computed from the committed PNGs — a darwin baseline with no
// linux sibling — and the four mechanisms are then required to EXPLAIN each
// one. That inversion is the whole fix:
//   * a gap nobody declared is UNDECLARED and fails the gate (silent rot);
//   * a declaration that matches no gap is DEAD and is reported (list rot);
//   * the printed number cannot drift from what is actually on disk.
//
// Everything here is fs + string work: no Playwright, no browser, no renderer.
// It runs in the ~1 s vitest unit lane on any platform. ⚠ It says nothing
// about whether a committed linux PNG still MATCHES the linux render — only
// linux CI can answer that.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

/** Directory this module lives in — `<repo>/e2e/vrt/`. */
const VRT_DIR = fileURLToPath(new URL('.', import.meta.url));
const SCREENSHOT_ROOT = join(VRT_DIR, '__screenshots__');

/** The platform CI gates on. The deficit is defined relative to it. */
export const GATING_PLATFORM = 'linux';
/** The platform most baselines are authored on first. */
export const AUTHORING_PLATFORM = 'darwin';

export const VRT_GAP_MECHANISMS = [
  'shared-pairs',
  'spec-local-pairs',
  'hardcoded-platform-skip',
  'scene-darwin-only',
] as const;

export type VrtGapMechanism = (typeof VRT_GAP_MECHANISMS)[number];

/** One-line human description per mechanism, for failure messages. */
export const VRT_GAP_MECHANISM_DOC: Record<VrtGapMechanism, string> = {
  'shared-pairs': "`linux/<scene>` in EXEMPT_BASELINE_PAIRS (e2e/vrt/vrt-exemptions.ts)",
  'spec-local-pairs': 'a PRIVATE `const EXEMPT_BASELINE_PAIRS` inside a spec file',
  'hardcoded-platform-skip': "`test.skip(VRT_PLATFORM === 'linux', …)` written into a spec",
  'scene-darwin-only': '`darwinOnly: true` on a CompositeVrtScene',
};

export interface VrtPlatformGap {
  /** Spec directory under __screenshots__, e.g. `vrt.spec.ts`. */
  spec: string;
  /** Snapshot stem, e.g. `analogVco` (no `.png`). */
  scene: string;
  /** Which mechanism declares it, or null when NOTHING does. */
  mechanism: VrtGapMechanism | null;
}

export interface VrtBaselineInventory {
  spec: string;
  darwin: string[];
  linux: string[];
}

/** Committed baselines per spec dir. Pure fs read — the ground truth. */
export function listBaselineInventory(): VrtBaselineInventory[] {
  if (!existsSync(SCREENSHOT_ROOT)) return [];
  const out: VrtBaselineInventory[] = [];
  for (const spec of readdirSync(SCREENSHOT_ROOT).sort()) {
    const read = (platform: string): string[] => {
      const dir = join(SCREENSHOT_ROOT, spec, platform);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => f.slice(0, -'.png'.length))
        .sort();
    };
    out.push({ spec, darwin: read(AUTHORING_PLATFORM), linux: read(GATING_PLATFORM) });
  }
  return out;
}

export interface VrtBaselineTotals {
  specs: number;
  darwin: number;
  linux: number;
}

/** How many baselines the enumerator can actually see, by platform. */
export function baselineTotals(): VrtBaselineTotals {
  const inv = listBaselineInventory();
  return {
    specs: inv.length,
    darwin: inv.reduce((n, i) => n + i.darwin.length, 0),
    linux: inv.reduce((n, i) => n + i.linux.length, 0),
  };
}

/**
 * VACUITY TRIPWIRE for the whole file.
 *
 * Every number here is derived from `__screenshots__`. With that tree ABSENT
 * the enumerator returns `total = 0`, `undeclared = []`, `stale = 0` — and a
 * ceiling of "≤ 151" and a set assertion of "== []" both PASS. Measured: with
 * the tree deleted, all four vrt-meta ratchets go green. The only thing
 * standing between a `lfs:false`/partial checkout and a fully green,
 * fully vacuous gate was an incidental property of git-LFS (pointer stubs keep
 * the FILENAMES), which nothing asserted.
 *
 * So assert it. Floors are tripwires with headroom, not coverage targets:
 * measured 2026-08-01 = 30 spec dirs / 280 darwin / 129 linux.
 */
export const MIN_BASELINE_SPECS = 25;
export const MIN_DARWIN_BASELINES = 240;
export const MIN_LINUX_BASELINES = 100;

export function assertBaselineTreeIsReadable(): VrtBaselineTotals {
  const totals = baselineTotals();
  const why =
    'the linux-deficit ratchet, the UNDECLARED gate and the stale-pair ratchet are ALL ' +
    'derived from this tree; with it unreadable they every one pass while measuring nothing';
  if (totals.specs < MIN_BASELINE_SPECS) {
    throw new Error(
      `only ${totals.specs} spec dirs found under ${SCREENSHOT_ROOT} (floor ` +
        `${MIN_BASELINE_SPECS}) — ${why}.`,
    );
  }
  if (totals.darwin < MIN_DARWIN_BASELINES || totals.linux < MIN_LINUX_BASELINES) {
    throw new Error(
      `only ${totals.darwin} darwin / ${totals.linux} linux baselines readable (floors ` +
        `${MIN_DARWIN_BASELINES}/${MIN_LINUX_BASELINES}) — ${why}. If the drop is REAL ` +
        '(baselines were deliberately deleted) lower the floors deliberately; if it is a ' +
        'partial checkout, this lane cannot run the gate and must not pretend otherwise.',
    );
  }
  return totals;
}

/** `<platform>/<scene>` keys for every committed baseline, any spec dir. */
export function committedBaselineKeys(): Set<string> {
  const keys = new Set<string>();
  for (const { darwin, linux } of listBaselineInventory()) {
    for (const s of darwin) keys.add(`${AUTHORING_PLATFORM}/${s}`);
    for (const s of linux) keys.add(`${GATING_PLATFORM}/${s}`);
  }
  return keys;
}

/** Drop `//` comment lines before harvesting string literals, so a commented-
 *  out entry (or a `'linux/foo'` mentioned in prose) is never counted. */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
}

/** MECHANISM A — imported, exact. Scene stems of the `linux/*` shared pairs. */
export function sharedPairScenes(): Set<string> {
  const out = new Set<string>();
  for (const pair of EXEMPT_BASELINE_PAIRS) {
    if (pair.startsWith(`${GATING_PLATFORM}/`)) out.add(pair.slice(GATING_PLATFORM.length + 1));
  }
  return out;
}

function specSources(): Array<{ spec: string; src: string }> {
  return readdirSync(VRT_DIR)
    .filter((f) => f.endsWith('.spec.ts'))
    .sort()
    .map((spec) => ({ spec, src: readFileSync(join(VRT_DIR, spec), 'utf8') }));
}

/** MECHANISM B — source-scanned. spec file → scene stems in its PRIVATE set. */
export function specLocalPairScenes(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { spec, src } of specSources()) {
    // Anchored on the local DECLARATION (`const … = new Set`), never on a
    // bare identifier use — a spec that IMPORTS the shared set must not be
    // mistaken for one that declares its own.
    const decl = /const\s+EXEMPT_BASELINE_PAIRS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/.exec(src);
    if (!decl) continue;
    const scenes = new Set<string>();
    for (const m of stripLineComments(decl[1]).matchAll(/'([^']+)'/g)) {
      if (m[1].startsWith(`${GATING_PLATFORM}/`)) scenes.add(m[1].slice(GATING_PLATFORM.length + 1));
    }
    out.set(spec, scenes);
  }
  return out;
}

const LINUX_SKIP_RE = /test\.skip\(\s*(?:\/\/[^\n]*\n\s*)*VRT_PLATFORM\s*===\s*'linux'/g;
/** `test(` call sites — not `test.skip(`, `test.describe(`, `test.beforeEach(`. */
const TEST_SITE_RE = /(?<![.\w])test\(/g;

/** MECHANISM C — source-scanned. Specs whose every scene is skipped on linux
 *  by a blanket `test.skip(VRT_PLATFORM === 'linux', …)`. There is no list to
 *  read: the whole spec goes dark, so its entire darwin baseline set is the
 *  gap. */
export function hardcodedLinuxDarkSpecs(): Set<string> {
  const out = new Set<string>();
  for (const { spec, src } of specSources()) {
    if (new RegExp(LINUX_SKIP_RE.source).test(src)) out.add(spec);
  }
  return out;
}

export interface DarkSpecCoverage {
  spec: string;
  /** `test.skip(VRT_PLATFORM === 'linux', …)` occurrences. */
  skips: number;
  /** `test(` call sites in the file. */
  tests: number;
  /** True when a skip sits in the `test.beforeEach` that precedes every test. */
  viaBeforeEach: boolean;
  /** Is EVERY test in this file actually dark on linux? */
  complete: boolean;
}

/**
 * Is a "linux-dark" spec really dark for ALL of its tests?
 *
 * Detection (above) is per FILE; the skip is written per TEST. That asymmetry
 * means one skip makes the whole file look dark, so a new test with no skip is
 * silently attributed to mechanism C and never reaches the UNDECLARED gate.
 * Measured 2026-08-01: all 8 dark specs carry `skips === tests` (toybox 10/10,
 * the other seven 1/1), so this is a pure tightening today.
 */
export function darkSpecCoverage(): DarkSpecCoverage[] {
  const out: DarkSpecCoverage[] = [];
  for (const { spec, src } of specSources()) {
    const skipIdx = [...src.matchAll(new RegExp(LINUX_SKIP_RE.source, 'g'))].map((m) => m.index ?? -1);
    if (skipIdx.length === 0) continue;
    const testIdx = [...src.matchAll(new RegExp(TEST_SITE_RE.source, 'g'))].map((m) => m.index ?? -1);
    const beforeEach = src.indexOf('test.beforeEach(');
    const firstTest = testIdx.length ? testIdx[0] : Number.MAX_SAFE_INTEGER;
    const viaBeforeEach =
      beforeEach >= 0 && skipIdx.some((i) => i > beforeEach && i < firstTest);
    out.push({
      spec,
      skips: skipIdx.length,
      tests: testIdx.length,
      viaBeforeEach,
      complete: viaBeforeEach || skipIdx.length >= testIdx.length,
    });
  }
  return out;
}

/** MECHANISM D — source-scanned (see the header: importing the scene module
 *  would pull `@playwright/test` into the unit lane). A scene's own `id:` and
 *  its `darwinOnly:` share an indentation level; node ids are nested deeper,
 *  so the id is the nearest preceding `id:` at the SAME depth. */
export function darwinOnlySceneIds(): Set<string> {
  const src = readFileSync(join(VRT_DIR, 'vrt-composite-scenes.ts'), 'utf8');
  const out = new Set<string>();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const flag = /^(\s*)darwinOnly:\s*true\s*,?\s*$/.exec(lines[i]);
    if (!flag) continue;
    const depth = flag[1].length;
    for (let j = i - 1; j >= 0; j--) {
      const id = new RegExp(`^\\s{${depth}}id:\\s*'([^']+)'`).exec(lines[j]);
      if (id) {
        out.add(id[1]);
        break;
      }
    }
  }
  return out;
}

/**
 * Scene stems that exist in MORE THAN ONE spec dir on the same platform.
 *
 * Mechanisms A and D key on the bare stem, so a shared pair written for
 * `vrt.spec.ts` would silently explain a gap of the same name under another
 * spec dir — a free pass for the first collision. Measured 2026-08-01: zero
 * collisions across all 30 dirs, so this stays a tripwire.
 */
export function collidingSceneStems(): string[] {
  const seen = new Map<string, string[]>();
  for (const { spec, darwin, linux } of listBaselineInventory()) {
    for (const platform of [AUTHORING_PLATFORM, GATING_PLATFORM]) {
      for (const s of platform === AUTHORING_PLATFORM ? darwin : linux) {
        const key = `${platform}/${s}`;
        seen.set(key, [...(seen.get(key) ?? []), spec]);
      }
    }
  }
  return [...seen]
    .filter(([, specs]) => specs.length > 1)
    .map(([key, specs]) => `${key} in ${specs.join(' + ')}`)
    .sort();
}

export interface VrtGapReport {
  /** Total linux-deficit scenes — the number the ratchet caps. */
  total: number;
  gaps: VrtPlatformGap[];
  byMechanism: Record<VrtGapMechanism, number>;
  /** Gaps NO mechanism declares. Must always be empty. */
  undeclared: VrtPlatformGap[];
  /** Declarations naming a scene that is not a gap (list rot), by mechanism. */
  dead: Record<VrtGapMechanism, string[]>;
  /**
   * The `shared-pairs` rot, CLASSIFIED — never re-derived by grepping the
   * prose in `dead['shared-pairs']`. A test that filters those strings for
   * `'IS committed'` goes vacuously green the day somebody rewords the
   * message, and nothing pins the wording.
   */
  deadShared: {
    /** Pair listed AND its linux PNG is committed — stale, drain it. */
    stale: string[];
    /** Pair naming a scene with no PNG on EITHER platform — pure noise. */
    phantom: string[];
    /** Pair whose gap is attributed to a higher-precedence mechanism. */
    otherMechanism: string[];
  };
  /** Specs flagged linux-dark that nonetheless ship a linux baseline. */
  contradictoryDarkSpecs: string[];
  /** Linux-dark specs where SOME tests carry no skip (see darkSpecCoverage). */
  partiallyDarkSpecs: DarkSpecCoverage[];
  /**
   * Scenes claimed by more than one mechanism. Attribution uses a precedence
   * order, so an overlap makes the per-mechanism counts a function of that
   * order — and the negative control ("drop a mechanism, its gaps resurface as
   * UNDECLARED") stops holding, because they would fall through to whichever
   * mechanism was next in line instead. Empty today; asserted empty.
   */
  mechanismOverlaps: string[];
  /** Human-readable per-mechanism breakdown for an assertion message. */
  format(prefix?: string): string;
}

/**
 * Compute the linux deficit and attribute every gap to a mechanism.
 *
 * @param omit  drop ONE mechanism from the attribution pass — the negative
 *              control. With a mechanism omitted, its gaps must resurface as
 *              UNDECLARED; if they do not, the report is not actually reading
 *              that mechanism and the ratchet is decoration.
 */
export function collectLinuxGapReport(
  opts: { omit?: VrtGapMechanism } = {},
): VrtGapReport {
  const { omit } = opts;
  const enabled = (m: VrtGapMechanism): boolean => m !== omit;

  const shared = enabled('shared-pairs') ? sharedPairScenes() : new Set<string>();
  const local = enabled('spec-local-pairs') ? specLocalPairScenes() : new Map<string, Set<string>>();
  const dark = enabled('hardcoded-platform-skip')
    ? hardcodedLinuxDarkSpecs()
    : new Set<string>();
  const darwinOnly = enabled('scene-darwin-only') ? darwinOnlySceneIds() : new Set<string>();

  const inventory = listBaselineInventory();
  const gaps: VrtPlatformGap[] = [];
  const byMechanism = Object.fromEntries(VRT_GAP_MECHANISMS.map((m) => [m, 0])) as Record<
    VrtGapMechanism,
    number
  >;
  const matched = Object.fromEntries(VRT_GAP_MECHANISMS.map((m) => [m, new Set<string>()])) as Record<
    VrtGapMechanism,
    Set<string>
  >;
  const contradictoryDarkSpecs: string[] = [];

  for (const { spec, darwin, linux } of inventory) {
    const linuxSet = new Set(linux);
    // A spec declared wholly dark on linux cannot also ship linux baselines.
    // If it does, the blanket skip is stale and the darkness is fiction.
    if (dark.has(spec) && linux.length > 0) contradictoryDarkSpecs.push(spec);

    for (const scene of darwin) {
      if (linuxSet.has(scene)) continue; // compared on the gating platform ✓

      // Attribution precedence, most-specific declaration first. A whole-spec
      // blanket skip subsumes any per-scene entry in the same file.
      let mechanism: VrtGapMechanism | null = null;
      if (dark.has(spec)) mechanism = 'hardcoded-platform-skip';
      else if (local.get(spec)?.has(scene)) mechanism = 'spec-local-pairs';
      else if (darwinOnly.has(scene)) mechanism = 'scene-darwin-only';
      else if (shared.has(scene)) mechanism = 'shared-pairs';

      if (mechanism) {
        byMechanism[mechanism] += 1;
        matched[mechanism].add(mechanism === 'hardcoded-platform-skip' ? spec : scene);
      }
      gaps.push({ spec, scene, mechanism });
    }
  }

  // OVERLAP DETECTION, independent of the precedence order above: which gaps
  // would MORE THAN ONE enabled mechanism have claimed? Precedence hides that,
  // and the negative control silently stops working when it happens.
  const mechanismOverlaps: string[] = [];
  for (const { spec, darwin, linux } of inventory) {
    const linuxSet = new Set(linux);
    for (const scene of darwin) {
      if (linuxSet.has(scene)) continue;
      const claims: VrtGapMechanism[] = [];
      if (dark.has(spec)) claims.push('hardcoded-platform-skip');
      if (local.get(spec)?.has(scene)) claims.push('spec-local-pairs');
      if (darwinOnly.has(scene)) claims.push('scene-darwin-only');
      if (shared.has(scene)) claims.push('shared-pairs');
      if (claims.length > 1) mechanismOverlaps.push(`${spec}/${scene}: ${claims.join(' + ')}`);
    }
  }

  const undeclared = gaps.filter((g) => g.mechanism === null);

  const committed = committedBaselineKeys();
  // CLASSIFY FIRST, format second. The three buckets are the API; the prose is
  // only for humans. (They used to be one array of sentences and the hygiene
  // test recovered the buckets with `.includes('IS committed')` — a bare
  // substring against an unpinned message, which goes vacuously green on any
  // reword.)
  const sharedRot = [...shared].filter((s) => !matched['shared-pairs'].has(s)).sort();
  const deadSharedStale = sharedRot.filter((s) => committed.has(`${GATING_PLATFORM}/${s}`));
  const deadSharedOther = sharedRot.filter(
    (s) => !committed.has(`${GATING_PLATFORM}/${s}`) && committed.has(`${AUTHORING_PLATFORM}/${s}`),
  );
  const deadSharedPhantom = sharedRot.filter(
    (s) => !committed.has(`${GATING_PLATFORM}/${s}`) && !committed.has(`${AUTHORING_PLATFORM}/${s}`),
  );
  const deadShared = sharedRot.map((s) =>
    deadSharedStale.includes(s)
      ? `${s} (linux baseline IS committed — pair is stale, drain it)`
      : deadSharedOther.includes(s)
        ? `${s} (declared by another mechanism)`
        : `${s} (no baseline on EITHER platform — dead entry)`,
  );
  const deadLocal: string[] = [];
  for (const [spec, scenes] of local) {
    for (const s of scenes) if (!matched['spec-local-pairs'].has(s)) deadLocal.push(`${spec}:${s}`);
  }
  const deadDark = [...dark].filter((s) => !matched['hardcoded-platform-skip'].has(s)).sort();
  const deadDarwinOnly = [...darwinOnly]
    .filter((s) => !matched['scene-darwin-only'].has(s))
    .sort();

  const report: VrtGapReport = {
    total: gaps.length,
    gaps,
    byMechanism,
    undeclared,
    dead: {
      'shared-pairs': deadShared,
      'spec-local-pairs': deadLocal.sort(),
      'hardcoded-platform-skip': deadDark,
      'scene-darwin-only': deadDarwinOnly,
    },
    deadShared: {
      stale: deadSharedStale,
      phantom: deadSharedPhantom,
      otherMechanism: deadSharedOther,
    },
    contradictoryDarkSpecs,
    partiallyDarkSpecs: darkSpecCoverage().filter((d) => !d.complete),
    mechanismOverlaps,
    format(prefix = ''): string {
      const lines: string[] = [];
      if (prefix) lines.push(prefix);
      lines.push(
        `LINUX-DEFICIT BREAKDOWN — ${gaps.length} scene(s) captured on ${AUTHORING_PLATFORM} ` +
          `and NEVER diffed on ${GATING_PLATFORM} (the platform CI gates on):`,
      );
      for (const m of VRT_GAP_MECHANISMS) {
        const n = byMechanism[m];
        const flag = m === omit ? '  [OMITTED by negative control]' : '';
        lines.push(`  ${String(n).padStart(4)}  ${m} — ${VRT_GAP_MECHANISM_DOC[m]}${flag}`);
      }
      if (undeclared.length) {
        lines.push(
          `  ${String(undeclared.length).padStart(4)}  UNDECLARED — no mechanism explains these; ` +
            'a scene going dark on linux with nothing saying so:',
        );
        for (const g of undeclared.slice(0, 25)) lines.push(`          ${g.spec} → ${g.scene}`);
        if (undeclared.length > 25) lines.push(`          …and ${undeclared.length - 25} more`);
      }
      const worst = [...gaps.reduce((m2, g) => m2.set(g.spec, (m2.get(g.spec) ?? 0) + 1), new Map<string, number>())]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      lines.push(`  top spec files: ${worst.map(([s, n]) => `${s}=${n}`).join(', ')}`);
      lines.push(
        'Capture linux baselines (`gh workflow run vrt-update.yml -f platform=linux`, ' +
          'UNSCOPED, after DRAINING the pending pairs) and lower the ceiling by the same count. ' +
          'Mechanisms are enumerated in e2e/vrt/vrt-platform-gaps.ts.',
      );
      return lines.join('\n');
    },
  };
  return report;
}

/**
 * NEGATIVE CONTROL on the INSTRUMENT, not the data. The three source-scanned
 * mechanisms (B, C, D) return a clean, plausible EMPTY set if their pattern
 * ever drifts from the source — the ratchet would then silently under-report
 * and look green. Assert every scan sees something, and hand back what it saw
 * so a caller can print it.
 */
export function assertParsersSeeSomething(): { local: number; dark: number; darwinOnly: number } {
  const local = [...specLocalPairScenes().values()].reduce((n, s) => n + s.size, 0);
  const dark = hardcodedLinuxDarkSpecs().size;
  const darwinOnly = darwinOnlySceneIds().size;
  if (darwinOnly === 0) {
    throw new Error(
      'darwinOnlySceneIds() found NOTHING. Either no CompositeVrtScene carries ' +
        '`darwinOnly: true` any more (great — delete this parser) or the indentation-anchored ' +
        'scan drifted from vrt-composite-scenes.ts and the ratchet is now blind to mechanism D.',
    );
  }
  if (local === 0) {
    throw new Error(
      'specLocalPairScenes() found NOTHING. Either every spec-local ' +
        'EXEMPT_BASELINE_PAIRS is gone (great — delete this parser) or the regex drifted ' +
        'from the source and the ratchet is now blind to mechanism B.',
    );
  }
  if (dark === 0) {
    throw new Error(
      'hardcodedLinuxDarkSpecs() found NOTHING. Either no spec hardcodes ' +
        "`test.skip(VRT_PLATFORM === 'linux', …)` any more (great — delete this parser) or " +
        'the regex drifted and the ratchet is now blind to mechanism C.',
    );
  }
  return { local, dark, darwinOnly };
}
