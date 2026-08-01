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
// A and D are IMPORTED — they live in plain data modules, so we get the exact
// values with no parsing and no chance of a regex drifting from the source.
//
// B and C are SOURCE-SCANNED, and that is forced, not lazy: a Playwright spec
// calls `test.describe()` at module scope, so importing one from vitest throws
// outside the Playwright runner. The declaration is only reachable as text.
// Two guards keep the scan honest, because a parser that silently matches
// nothing returns a clean-looking zero:
//   * `assertParsersSeeSomething()` fails if either scan comes back empty.
//   * a spec flagged as linux-dark (C) must have ZERO committed linux
//     baselines — if one appears, the blanket skip is lying and we say so.
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
import { COMPOSITE_VRT_SCENES } from './vrt-composite-scenes';

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

/** MECHANISM C — source-scanned. Specs whose every scene is skipped on linux
 *  by a blanket `test.skip(VRT_PLATFORM === 'linux', …)`. There is no list to
 *  read: the whole spec goes dark, so its entire darwin baseline set is the
 *  gap. */
export function hardcodedLinuxDarkSpecs(): Set<string> {
  const out = new Set<string>();
  for (const { spec, src } of specSources()) {
    if (/test\.skip\(\s*(?:\/\/[^\n]*\n\s*)*VRT_PLATFORM\s*===\s*'linux'/.test(src)) out.add(spec);
  }
  return out;
}

/** MECHANISM D — imported, exact. Composite scenes flagged darwin-only. */
export function darwinOnlySceneIds(): Set<string> {
  return new Set(COMPOSITE_VRT_SCENES.filter((s) => s.darwinOnly === true).map((s) => s.id));
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
  /** Specs flagged linux-dark that nonetheless ship a linux baseline. */
  contradictoryDarkSpecs: string[];
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

  const undeclared = gaps.filter((g) => g.mechanism === null);

  const committed = committedBaselineKeys();
  const deadShared = [...shared]
    .filter((s) => !matched['shared-pairs'].has(s))
    .map((s) =>
      committed.has(`${GATING_PLATFORM}/${s}`)
        ? `${s} (linux baseline IS committed — pair is stale, drain it)`
        : committed.has(`${AUTHORING_PLATFORM}/${s}`)
          ? `${s} (declared by another mechanism)`
          : `${s} (no baseline on EITHER platform — dead entry)`,
    )
    .sort();
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
    contradictoryDarkSpecs,
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
 * NEGATIVE CONTROL on the INSTRUMENT, not the data. The two source-scanned
 * mechanisms (B, C) return a clean, plausible EMPTY set if their regex ever
 * drifts from the source — the ratchet would then silently under-report and
 * look green. Assert both scans see something, and hand back what they saw so
 * a caller can print it.
 */
export function assertParsersSeeSomething(): { local: number; dark: number } {
  const local = [...specLocalPairScenes().values()].reduce((n, s) => n + s.size, 0);
  const dark = hardcodedLinuxDarkSpecs().size;
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
  return { local, dark };
}
