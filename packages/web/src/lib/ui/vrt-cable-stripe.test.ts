// packages/web/src/lib/ui/vrt-cable-stripe.test.ts
//
// THE CABLE-STRIPE PALETTE GATE.
//
// Asserts that every committed single-card VRT baseline whose card pins its top
// `.stripe` to a `--cable-*` design token actually PAINTS that token's current
// value. Pure: source text + PNG bytes, no browser, no Playwright.
//
// It exists because the VRT gate is STRUCTURALLY BLIND to this class of drift
// (full writeup on vrt-cable-stripe.ts). Short version: the stripe is ~0.38 %
// of a card's pixels and `maxDiffPixelRatio` is 1 %, so a whole palette
// generation can rot in the baselines while `toHaveScreenshot` passes — and
// since Playwright only rewrites a snapshot on FAILURE, `--update-snapshots`
// cannot repair it either. Measured on this repo: #1159 recoloured every
// cable token and re-pinned a handful of PNGs; 76 of the token-pinned
// baselines were still on the OLD hues nine days later, on both of the
// baseline sets that existed then, with a green required lane the whole time.
//
// WHERE IT RUNS. The PNGs are git-LFS objects and the `unit` lane checks out
// `lfs: false`, so there the files are pointer stubs and this gate would
// self-skip into decoration. It is therefore ALSO wired into the `vrt-strict`
// job (the REQUIRED lane that runs `git lfs pull --include
// "e2e/vrt/__screenshots__/**"`) with `VRT_STRIPE_PALETTE_REQUIRED=1`, which
// turns "cannot read the bytes" from a skip into a FAILURE. Same shape as the
// ART fingerprint drift gate's `ART_FINGERPRINTS_REQUIRED=1`.
//
// ── THE ACCEPT LOOP (read this BEFORE changing a `--cable-*` token) ─────────
// Because it runs in a REQUIRED lane, editing `_cables.ts` turns this red on
// every baseline pinned to the changed token — by design, that is the drift it
// exists to catch — and unlike `docs:accept` / `art:update` there is no one
// command that re-pins it, because the artifacts are SCREENSHOTS. The path is:
//
//   1. `git rm` every baseline the failure lists. This step is not optional and
//      not a shortcut: a ~2px stripe is ~0.4 % of a card against a 1 %
//      `maxDiffPixelRatio`, so the recapture PASSES the comparison and
//      Playwright — which only rewrites a snapshot on FAILURE — writes nothing.
//      A MISSING snapshot is always written. (CLAUDE.md, the A2/#1213 hole.)
//   2. `gh workflow run vrt-update.yml -f ref=<branch>` (or `task vrt:commit`),
//      UNSCOPED, and NEVER a hand edit on macOS. Linux CI is the only baseline
//      author — a local darwin render is a smoke test, not a capture.
//
// A palette change that cannot follow those two steps must not be landed by
// relaxing this gate.
//
// ⚠ THE `quarantined` BUCKET IS GONE (2026-08-10) and that is a coverage
// INCREASE, not a deletion. It held baselines listed in EXEMPT_BASELINE_PAIRS:
// `test.skip()`-ed unconditionally, therefore compared by nothing, therefore
// neither assertable nor repairable. With the platform dimension collapsed
// there is no such set and no such state — every committed baseline is
// compared, so every one of them is held to the current palette.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CABLE_VARS } from '$lib/ui/skins/palettes/_cables';
import {
  CABLE_EDGE_DIRS,
  CABLE_HUES_ALL_GENERATIONS,
  CARD_CAPTURE_DIRS,
  NON_CARD_CAPTURE_DIRS,
  conventionalCardBasename,
  findStripeBand,
  hexToRgb,
  parseCssCableTokens,
  repaintStripeRow,
  STRIPE_ALPHA_SPREAD,
  stripeMatchesToken,
  stripeSourceToken,
} from '$lib/ui/vrt-cable-stripe';
import { readCardSourceWithDelegates } from '$lib/ui/card-source';
// This file lives at packages/web/src/lib/ui/. Five `..` hops = repo root.
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const CARD_DIR = resolve(REPO_ROOT, 'packages/web/src/lib/ui/modules');

/** A card's source INCLUDING any sibling body it delegates to. CvBuddyCard and
 *  CvBuddyMiniCard are four-line wrappers around CvBuddyBody, so reading the
 *  wrapper alone reported a token-pinned stripe as unpinned. See card-source.ts. */
const readCard = (cardPath: string): string =>
  readCardSourceWithDelegates(cardPath, CARD_DIR, { readFileSync, existsSync }, (...p) =>
    resolve(...p),
  );
const SCREENSHOT_ROOT = resolve(REPO_ROOT, 'e2e/vrt/__screenshots__');
const SPEC_DIR = resolve(REPO_ROOT, 'e2e/vrt');
const DEF_DIRS = [
  'packages/web/src/lib/audio/modules',
  'packages/web/src/lib/video/modules',
  'packages/web/src/lib/meta/modules',
].map((p) => resolve(REPO_ROOT, p));

const REQUIRED = process.env.VRT_STRIPE_PALETTE_REQUIRED === '1';
const LFS_POINTER_PREFIX = 'version https://git-lfs';

/**
 * ⚠ `MIN_TOKEN_PINNED_BASELINES` (200) IS GONE (2026-08-10) — a hand-typed
 * population count, the species CLAUDE.md now forbids outright.
 *
 * WHAT IT CLAIMED TO PROTECT, checked before deleting rather than assumed:
 * "one bad regex away from vacuity — a `.stripe` markup change would silently
 * move every card into not-token-pinned and the suite would stay green".
 * Traced against the tests that remain, that exact failure is caught THREE
 * times over, each by a NAME rather than a number:
 *
 *   * every card falling out of `pinned` puts every scene into `skipped`, so
 *     `dropped` explodes and `toEqual(NOT_TOKEN_PINNED_SCENES)` — 26 named
 *     scenes, asserted in BOTH directions — fails naming the newcomers;
 *   * a spec directory vanishing from the walk is caught by the
 *     classification test, which anchors to `readdirSync(SCREENSHOT_ROOT)` and
 *     fails on a table entry for a directory that no longer exists;
 *   * a directory being silently EXCLUDED from the walk means it is in
 *     `NON_CARD_CAPTURE_DIRS`, and every claim in that table is separately
 *     asserted true (no cable band in the scan window).
 *
 * And the degenerate case a floor is really for — the PNG loop reading zero
 * files — makes `dropped` empty against a non-empty declared list, which is
 * red. A floor could add nothing except slack: it carried ~20 baselines of it,
 * which the test below it already says out loud is enough room for a card to
 * quietly stop being token-pinned.
 */
/**
 * Baselines that are token-pinned, COMPARED by a test, and still painting a
 * pre-#1159 hue — because the PR that regenerates them is a different one.
 *
 * This is an EXACT SET, not a ceiling: `toEqual` fails if an entry is missing
 * (someone regenerated it and forgot to drain this list) AND if an entry is
 * added (new drift). A ceiling would let a drain pass silently, which is the
 * exact failure mode CLAUDE.md calls out for the linux-deficit ratchet.
 *
 * DRAINED 2026-08-02, and the mechanism worked EXACTLY as designed — this is
 * the record of it firing for real, kept because the prediction and the
 * outcome matching is the evidence that the EXACT-SET choice was right.
 *
 * #1279 (`test/vrt-font-settle-sweep`) regenerated precisely 40 of these. The
 * simulation run before either PR landed predicted, in merge order
 * #1272 → #1281 → #1279:
 *
 *   main + #1272                 37/37 green
 *   main + #1272 + #1281         48/48 green
 *   + #1279                      51/52 — the ONE failure is this assertion,
 *                                reporting exactly the 40 entries #1279
 *                                regenerates; the 16 `vrt-toybox` entries stay
 *   + drain those 40             52/52 green
 *
 * OBSERVED when #1279 actually merged and this branch merged `main`: this
 * assertion, and ONLY this assertion, went red — declared 56 vs actual 16.
 * Dropping the 40 non-toybox entries returned the file to green. Note what
 * carries the proof: because this is `toEqual` on a SET and not a ceiling, the
 * drain passing is itself the evidence that the 16 survivors are exactly the
 * `vrt-toybox` rows and that all 40 others really were regenerated — no
 * separate verification step is needed or trusted.
 *
 * A `<=`-style ceiling would have gone green through that same merge with a
 * 40-wide hole and nobody would have known. That is the whole argument for
 * paying the one-edit cost, and it is now measured rather than reasoned.
 *
 * ⚠ DRAINED TO EMPTY 2026-08-10 — BY PAYMENT, NOT BY DELETION, and the
 * distinction is the whole point of keeping this note.
 *
 * The 16 survivors were all `vrt-toybox.spec.ts/darwin/*`. They were stale
 * because `vrt-toybox` was blanket-`test.skip`-ed on linux and CI renders on
 * linux, so NOTHING on any CI run had ever compared them — they were carrying a
 * pre-#1159 `--cable-video` frame with no mechanism that could notice. The
 * standing plan was "a darwin recapture, in a separate PR", which never came.
 *
 * The single-baseline collapse pays it outright: the blanket skip is gone, the
 * darwin PNGs are deleted, and the vrt-update capture writes fresh LINUX
 * baselines for all 27 toybox scenes — rendered against the CURRENT palette by
 * construction. There is no deferred work left to name, so the list is empty
 * rather than carrying entries that describe files which no longer exist.
 *
 * ⚠ AN EMPTY EXACT SET IS STILL A REAL ASSERTION here, unlike an empty ceiling:
 * `toEqual([])` fails the moment ANY committed baseline paints a retired hue.
 * That is strictly stronger than what it replaced. If the capture ever lands a
 * stale-looking toybox frame, this reddens naming it.
 */
const PENDING_PALETTE_REGEN: readonly string[] = [];

/**
 * Scene stems whose card does NOT pin `.stripe` to a `--cable-*` token, and is
 * therefore excused from the pixel assertion. EXACT SET — see the test.
 *
 * `audioOut`/`mixer` paint `var(--text-dim)`; `wavesculpt` a 3-hex gradient;
 * the `moog*` family + `electraControl` + `sticky` render no `.stripe` at all.
 *
 * `chromaconsole` is the same "no `.stripe` at all" case, for a structural
 * reason rather than a styling one: it is a control surface for an EXTERNAL
 * device, so it declares zero ports and there is no cable for a stripe to
 * colour. A card with nothing to patch cannot pin a cable token.
 *
 * ⚠ `matrixMix` IS THE SAME STRUCTURAL CASE AS `chromaconsole`, AND IT ARRIVED
 * BY A ROUTE WORTH RECORDING: it is not a new card, and nothing about it
 * changed. It became a SCENE because bespoke wave 4 DRAINED its
 * `EXEMPT_FROM_VRT` entry, which enrolled it in `vrt.spec.ts` for the first
 * time. So this list grew without any card being edited, which is exactly the
 * event the exact-set assertion exists to force somebody to look at.
 *
 * It belongs here on the merits: matrixMix is a META-domain module declaring
 * `inputs: []` and `outputs: []` and binding to no engine, so like
 * `chromaconsole` it has no cable for a stripe to colour — the card genuinely
 * renders no `.stripe` element (the gate's own probe says so:
 * "card renders no .stripe element"). It is NOT the hardcoded-hex divergence
 * this list warns about; there is no hex, and no stripe.
 */
const NOT_TOKEN_PINNED_SCENES: readonly string[] = [
  'audioOut', 'chromaconsole', 'electraControl', 'matrixMix', 'mixer',
  'moog903a', 'moog904b', 'moog904c', 'moog905', 'moog907a', 'moog911a', 'moog912',
  'moog914', 'moog921a', 'moog921b', 'moog923', 'moog956', 'moog960', 'moog961',
  'moog962', 'moog984', 'moog992', 'moog993', 'moog994', 'moog995',
  'sticky', 'wavesculpt',
];

/** module type → card component basename, mirroring modules-card-map.ts. */
function cardBasenameByType(): Record<string, string> {
  const explicit: Record<string, string> = {};
  for (const dir of DEF_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      const src = readFileSync(resolve(dir, file), 'utf8');
      const type = src.match(/^\s*type:\s*'([^']+)'/m);
      const card = src.match(/^\s*card:\s*'([^']+)'/m);
      if (type && card) explicit[type[1]] = card[1];
    }
  }
  return explicit;
}

/** One token-pinned baseline, measured once. */
interface Pinned {
  /** `<spec>/<scene>` — unique across the whole screenshot tree. */
  key: string;
  spec: string;
  scene: string;
  type: string;
  card: string;
  token: string;
  /** `#rrggbb` actually painted, or undefined if no stripe band was found. */
  got?: string;
  /** `#rrggbb` of the row below the band — what a partially-covered stripe is
   *  composited over. See `stripeMatchesToken`. */
  bg?: string | null;
  y?: number;
  saturation?: number;
}

interface Measured {
  pinned: Pinned[];
  skipped: string[];
  pointers: number;
}

function baselineDirs(): string[] {
  if (!existsSync(SCREENSHOT_ROOT)) return [];
  return readdirSync(SCREENSHOT_ROOT)
    .filter((d) => statSync(resolve(SCREENSHOT_ROOT, d)).isDirectory())
    .sort();
}

/**
 * Reads every baseline ONCE.
 *
 * `readBytes` is injectable so the PIXEL-side negative control can substitute
 * perturbed bytes for one file and watch this exact pipeline react. Everything
 * else — the resolver, the decoder, the locator, the comparison — stays the
 * production path, which is the only way the control proves anything about it.
 */
function measure(readBytes: (path: string) => Buffer = readFileSync): Measured {
  const explicit = cardBasenameByType();
  const pinned: Pinned[] = [];
  const skipped: string[] = [];
  let pointers = 0;
  for (const spec of baselineDirs()) {
    const sceneType = CARD_CAPTURE_DIRS[spec];
    const edge = CABLE_EDGE_DIRS[spec];
    if (!sceneType && !edge) continue; // declared non-card, or unclassified (asserted below)
    const dir = resolve(SCREENSHOT_ROOT, spec);
    {
      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith('.png')) continue;
        const scene = file.replace(/\.png$/, '');
        const key = `${spec}/${scene}`;
        const type = edge ? edge.type : sceneType!(scene);
        const card = explicit[type] ?? conventionalCardBasename(type);
        let token: string;
        if (edge) {
          // The token comes from the declared table, not from `.stripe` — the
          // captured element is framed by card chrome, not by the stripe. The
          // table's claim is proved against the card source in its own test.
          token = edge.token;
        } else {
          const cardPath = resolve(CARD_DIR, `${card}.svelte`);
          if (!existsSync(cardPath)) {
            skipped.push(`${key}: no card component (${card}.svelte)`);
            continue;
          }
          const source = stripeSourceToken(readCard(cardPath));
          if (source.kind !== 'token') {
            skipped.push(`${key}: ${source.reason}`);
            continue;
          }
          token = source.token;
        }
        const bytes = readBytes(resolve(dir, file));
        if (bytes.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8') === LFS_POINTER_PREFIX) {
          pointers++;
          continue;
        }
        const band = findStripeBand(new Uint8Array(bytes));
        pinned.push({
          key, spec, scene, type, card, token,
          got: band?.hex, bg: band?.bgHex, y: band?.y, saturation: band?.saturation,
        });
      }
    }
  }
  return { pinned, skipped, pointers };
}

/** Which of the measured baselines disagree with a given palette? */
/** The ONE comparison both assertions use. Coverage-aware: see
 *  `stripeMatchesToken` for why exact equality was the wrong test. */
function paintsToken(p: Pinned, tokens: Record<string, string>): boolean {
  return p.got !== undefined && stripeMatchesToken(p.got, p.bg ?? null, tokens[p.token]);
}

function offPalette(pinned: Pinned[], tokens: Record<string, string>): string[] {
  return pinned
    .filter((p) => !paintsToken(p, tokens))
    .map(
      (p) =>
        `${p.key}.png (${p.card}, ${p.token}): expected ${tokens[p.token]}, ` +
        `baseline paints ${p.got ?? '<no stripe band found>'}` +
        (p.y === undefined ? '' : ` at row y=${p.y} (saturation ${p.saturation})`),
    );
}

/** Just the keys, for set comparison against PENDING_PALETTE_REGEN. */
function offPaletteKeys(pinned: Pinned[], tokens: Record<string, string>): string[] {
  return pinned.filter((p) => !paintsToken(p, tokens)).map((p) => p.key).sort();
}

const MIS_EXCLUDED_MSG =
  'these directories are EXCLUDED from the palette gate, yet their committed pixels paint a ' +
  'cable colour in the scan window — so the exclusion is false and their baselines rot unseen. ' +
  'An exclusion is a claim about pixels and must be checked against pixels; asking the table is ' +
  'circular. Move the directory to CARD_CAPTURE_DIRS (it screenshots one card) or to ' +
  'CABLE_EDGE_DIRS (a cable token frames the captured element), in vrt-cable-stripe.ts.';

/**
 * Which of `dirs` paint a cable colour — of ANY generation — in the top rows?
 *
 * The instrument for the exclusion claim, deliberately pixel-side: it reads the
 * PNGs the gate refuses to read, which is the only evidence that can falsify
 * "there is nothing here to check".
 */
function scanExcluded(dirs: string[]): { banded: string[]; read: number; stubs: number } {
  const hue: Record<string, string> = { ...CABLE_HUES_ALL_GENERATIONS };
  for (const [name, value] of Object.entries(CABLE_VARS as unknown as Record<string, string>)) {
    hue[value.toLowerCase()] = `current ${name}`;
  }
  const banded: string[] = [];
  let read = 0;
  let stubs = 0;
  for (const spec of [...dirs].sort()) {
    const dir = resolve(SCREENSHOT_ROOT, spec);
    if (!existsSync(dir)) continue;
    const hits: string[] = [];
    {
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith('.png')) continue;
        const bytes = readFileSync(resolve(dir, f));
        if (bytes.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8') === LFS_POINTER_PREFIX) {
          stubs++;
          continue;
        }
        read++;
        const band = findStripeBand(new Uint8Array(bytes));
        const label = band && hue[band.hex.toLowerCase()];
        if (label) hits.push(`${f} y=${band!.y} ${band!.hex} (${label})`);
      }
    }
    if (hits.length) {
      banded.push(`${spec}: ${hits.length} baseline(s) paint a cable hue — e.g. ${hits[0]}`);
    }
  }
  return { banded, read, stubs };
}

const cableBandedDirs = (dirs: string[]): string[] => scanExcluded(dirs).banded;

describe('VRT baselines paint the CURRENT --cable-* stripe', () => {
  const { pinned, skipped, pointers } = measure();
  const unreadable = pointers > 0;
  const tokens = CABLE_VARS as unknown as Record<string, string>;

  // ── "CURRENT" MUST HAVE ONE MEANING ──────────────────────────────────────
  //
  // Everything below asserts a baseline paints the CURRENT value of its token,
  // resolved from CABLE_VARS. The same nine tokens are also declared in
  // `styles/tokens.css` (the pre-JS `:root` seed) and nothing reconciled them:
  // `--cable-video: #00ff00` in tokens.css left this suite 11/11 GREEN, while
  // a ONE-LSB edit to _cables.ts reddens 46 baselines. Sharp on one definition,
  // blind to the other — see the writeup in vrt-cable-stripe.ts.
  it('tokens.css and CABLE_VARS declare the SAME cable palette', () => {
    // Pure source text; no LFS, no PNGs — runs on every lane.
    const css = readFileSync(resolve(REPO_ROOT, 'packages/web/src/lib/styles/tokens.css'), 'utf8');
    const seed = parseCssCableTokens(css);
    // Liveness: a parser that matched nothing would report perfect agreement.
    // This is the same failure the exclusion validator's `read > 0` guard ends.
    // Compared as SETS, not counts — equal counts with different names is a
    // real divergence (a token declared in only one of the two files), and a
    // count check is exactly the kind of predicate that passes through it.
    expect(
      Object.keys(seed).sort(),
      'the --cable-* token NAMES in tokens.css differ from CABLE_VARS. A name present in only ' +
      'one file is a token whose value the other never sets — and if the parse came back empty, ' +
      'the parser (or the file) moved, and a parser that finds nothing agrees with everything.',
    ).toEqual(Object.keys(tokens).sort());
    const disagree = Object.keys(tokens)
      .filter((k) => seed[k] !== tokens[k]!.toLowerCase())
      .map((k) => `${k}: tokens.css ${seed[k] ?? '(absent)'} vs CABLE_VARS ${tokens[k]}`);
    expect(
      disagree,
      'the pre-JS :root seed disagrees with the palette engine. Post-boot pixels (and therefore ' +
      'every VRT capture) follow CABLE_VARS, because applyPaletteToRoot writes it inline on ' +
      'documentElement — so a token changed ONLY in tokens.css repaints the pre-JS frame, moves ' +
      'nothing this gate measures, and stays under maxDiffPixelRatio for VRT too. Change both.',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: a tokens.css/CABLE_VARS divergence is detected', () => {
    // Perturb the SEED side by one LSB and confirm the comparison reports it —
    // otherwise the assertion above is decoration, which is what it replaced.
    const css = readFileSync(resolve(REPO_ROOT, 'packages/web/src/lib/styles/tokens.css'), 'utf8');
    const real = parseCssCableTokens(css);
    // Pick a 6-digit hue so the LSB flip below is well-defined (a `#abc`
    // shorthand would re-pad to a different literal and prove nothing).
    const entry = Object.entries(real).find(([, v]) => v.length === 7);
    expect(entry, 'precondition: a #rrggbb cable hue to perturb').toBeDefined();
    const [probe, hue] = entry!;
    const bumped = `#${(parseInt(hue.slice(1), 16) ^ 1).toString(16).padStart(6, '0')}`;
    expect(bumped, 'precondition: the perturbation must actually change the hue').not.toBe(hue);
    const perturbed = parseCssCableTokens(css.replace(`${probe}: ${hue}`, `${probe}: ${bumped}`));
    // Compared against the UNPERTURBED parse, not against CABLE_VARS: this is
    // an instrument check, so it must report the same thing whether or not the
    // real file happens to be diverged (otherwise a genuine divergence would
    // break the control that is supposed to be validating the detector).
    expect(
      Object.keys(real).filter((k) => perturbed[k] !== real[k]),
      `flipping the low bit of ${probe} in the tokens.css text must be reported as a divergence`,
    ).toEqual([probe]);
  });

  it('every baseline directory is classified as card-capture or not', () => {
    // Pure source/dir bookkeeping — safe to run even on an lfs:false checkout.
    const unclassified = baselineDirs().filter(
      (d) => !CARD_CAPTURE_DIRS[d] && !CABLE_EDGE_DIRS[d] && !NON_CARD_CAPTURE_DIRS[d],
    );
    expect(
      unclassified,
      `new VRT spec directories under e2e/vrt/__screenshots__ that this gate has never been ` +
      `told about. A gate whose scope is undeclared reads as full coverage: add each to ` +
      `CARD_CAPTURE_DIRS (single-card capture — give the stem → module type mapping), to ` +
      `CABLE_EDGE_DIRS (a cable token frames the captured element), or to ` +
      `NON_CARD_CAPTURE_DIRS (with the reason it has no cable band), in vrt-cable-stripe.ts.`,
    ).toEqual([]);
    // ...and the reverse: a table entry that describes nothing real is dead
    // weight that quietly shrinks the gate's real scope.
    //
    // ⚠ ANCHORED TO THE SPEC FILE, NOT TO THE BASELINE DIRECTORY, and the
    // difference is not cosmetic. Each table key is a claim ABOUT A SPEC
    // ("`vrt-toybox.spec.ts` captures a canvas framed in `--cable-video`"),
    // so the artifact that makes the claim live is `e2e/vrt/<key>`. Keying off
    // `__screenshots__/<key>/` instead conflates "this spec exists" with "this
    // spec has PNGs committed right this second", and those come apart for
    // ordinary reasons: a spec authored before its first capture, and — the
    // case that found this — a migration window. When the `{platform}`
    // collapse deleted the darwin tree, 21 of the 30 entries pointed at
    // directories that were absent for a few hours and then came back
    // unchanged. Re-deriving the tables against that tree would have deleted
    // 21 correct entries and then needed all 21 restored.
    //
    // A spec that is deleted or renamed still reddens here, which is the rot
    // this was written to catch.
    const dead = [
      ...Object.keys(CARD_CAPTURE_DIRS),
      ...Object.keys(CABLE_EDGE_DIRS),
      ...Object.keys(NON_CARD_CAPTURE_DIRS),
    ]
      .filter((d) => !existsSync(resolve(SPEC_DIR, d)))
      .sort();
    expect(
      dead,
      'classification entries naming a VRT spec that no longer exists under e2e/vrt/. ' +
        'Delete the entry, or restore the spec.',
    ).toEqual([]);

    // State the gate's live scope every run, green included: a classified spec
    // with no committed baselines is checking nothing right now. Informational
    // by design — the assertion that baselines EXIST belongs to vrt-meta and
    // vrt-live-surfaces, and duplicating it here would just fail twice for one
    // cause while making this gate unusable mid-migration.
    const dirs = new Set(baselineDirs());
    const unpopulated = [
      ...Object.keys(CARD_CAPTURE_DIRS),
      ...Object.keys(CABLE_EDGE_DIRS),
    ]
      .filter((d) => !dirs.has(d))
      .sort();
    if (unpopulated.length) {
      console.info(
        `[vrt-cable-stripe] ${unpopulated.length} classified spec(s) have NO committed ` +
          `baselines, so this gate currently checks nothing for them:\n    ` +
          `${unpopulated.join('\n    ')}`,
      );
    }
    // A directory may not be claimed by two tables at once — overlapping claims
    // make "which rule applied?" unanswerable and hide one of them.
    const claimed = [
      ...Object.keys(CARD_CAPTURE_DIRS),
      ...Object.keys(CABLE_EDGE_DIRS),
      ...Object.keys(NON_CARD_CAPTURE_DIRS),
    ];
    expect(claimed.length, 'a baseline dir is classified by more than one table').toBe(
      new Set(claimed).size,
    );
  });

  // ── THE CLOSURE: EXCLUSIONS ARE VALIDATED, NOT ASSERTED ───────────────────
  //
  // The gate's two controls both operate on rows `measure()` RETURNED, and
  // `measure()` skips every NON_CARD dir outright — so the excluded directories
  // were the one scan no control could reach, and 2 of the 21 claims were false
  // (`vrt-aspect-16x9` is a single-card capture; `vrt-toybox`'s canvas wrapper
  // is `border: 1px solid var(--cable-video)`, and 16 of its 27 baselines still
  // paint the pre-#1159 `#f472b6`). Both were promoted; this assertion is what
  // stops the next one.
  //
  // Reading the pixels of the dirs the gate refuses to read is the only check
  // that can falsify an exclusion — asking the table is circular.
  it('every NON_CARD_CAPTURE_DIRS claim is TRUE (no cable band in the scan window)', () => {
    if (unreadable && !REQUIRED) return;
    const { banded, read, stubs } = scanExcluded(Object.keys(NON_CARD_CAPTURE_DIRS));
    expect(banded, MIS_EXCLUDED_MSG).toEqual([]);
    // This validator reads the ONE set of PNGs no other assertion touches, so
    // it needs its own liveness guards — otherwise it reports "all claims true"
    // having opened nothing, which is the failure mode it was written to end.
    expect(
      read,
      'the exclusion validator opened ZERO baselines — it would report every claim TRUE without ' +
      'reading anything. Same shape as the hole it closes.',
    ).toBeGreaterThan(0);
    if (REQUIRED) {
      expect(
        stubs,
        `VRT_STRIPE_PALETTE_REQUIRED=1 but ${stubs} baseline(s) in EXCLUDED dirs are LFS pointer ` +
        `stubs. The pointer check above only covers card/edge dirs, so without this an excluded ` +
        `dir could be skipped unread and still pass — refusing to skip-pass.`,
      ).toBe(0);
    }
  });

  it('NEGATIVE CONTROL: a mis-declared exclusion is detected', () => {
    if (unreadable && !REQUIRED) return;
    // Put a KNOWN cable-edge dir back into the excluded set. If the validator
    // still reports nothing it is not reading those pixels, and the assertion
    // above is decoration — which is precisely the state it replaced.
    const edgeDirs = Object.keys(CABLE_EDGE_DIRS);
    expect(edgeDirs.length, 'precondition: a cable-edge dir is needed to plant').toBeGreaterThan(0);
    expect(
      cableBandedDirs([...Object.keys(NON_CARD_CAPTURE_DIRS), ...edgeDirs]).map((s) =>
        s.split(':')[0],
      ),
      'excluding a directory that demonstrably carries a cable-token band must be reported',
    ).toEqual(edgeDirs.sort());
  });

  it('CABLE_EDGE_DIRS: the card source really paints the token the table claims', () => {
    // Source-side proof, so the table is a verified claim and not more prose.
    const wrong: string[] = [];
    const explicit = cardBasenameByType();
    for (const [spec, e] of Object.entries(CABLE_EDGE_DIRS)) {
      const card = explicit[e.type] ?? conventionalCardBasename(e.type);
      const cardPath = resolve(CARD_DIR, `${card}.svelte`);
      if (!existsSync(cardPath)) {
        wrong.push(`${spec}: no card component (${card}.svelte)`);
        continue;
      }
      if (!e.evidence.test(readCard(cardPath))) {
        wrong.push(
          `${spec}: ${card}.svelte no longer matches ${e.evidence} — the frame that made these ` +
          `captures carry ${e.token} has changed, so the table's claim is stale`,
        );
      }
    }
    expect(wrong, 'CABLE_EDGE_DIRS disagrees with the card it describes').toEqual([]);
  });

  it('each card-capture directory really captures the module card it claims', () => {
    // The stem → module-type table is hand-written, so pin it to the SPEC it
    // describes: a spec that changes which card it screenshots must move the
    // table with it. `.svelte-flow__node-<type>` is the literal locator; the
    // dynamic-locator specs name their types in a scene table instead.
    const wrong: string[] = [];
    for (const [spec, toType] of Object.entries(CARD_CAPTURE_DIRS)) {
      const specPath = resolve(SPEC_DIR, spec);
      if (!existsSync(specPath)) {
        wrong.push(`${spec}: no such spec file`);
        continue;
      }
      if (spec === 'vrt.spec.ts') continue; // registry-driven: scene id IS the type
      const src = readFileSync(specPath, 'utf8');
      const dir = resolve(SCREENSHOT_ROOT, spec);
      // A classified spec with no baselines yet has no stems to check. Guard
      // the read rather than letting it throw: an unguarded readdirSync here
      // turned the whole gate into an ENOENT crash the moment the `{platform}`
      // collapse emptied the tree, which reports as a broken test file instead
      // of as the one assertion that actually has something to say. A gate
      // should fail with its own message or not at all.
      if (!existsSync(dir)) continue;
      const types = new Set<string>();
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.png')) types.add(toType(f.replace(/\.png$/, '')));
      }
      for (const t of types) {
        // The recognised ways a spec can name the module it screenshots. A spec
        // that builds its locator from a variable (`.svelte-flow__node-${x}`)
        // names the type at the declaration instead — `sinkType:` / `cardClass:`
        // in vrt-aspect-16x9 — so those key forms count too. Still a real
        // check: a spec that never mentions the type at all fails.
        const named =
          src.includes(`svelte-flow__node-${t}`) ||
          new RegExp(`moduleType:\\s*'${t}'`).test(src) ||
          new RegExp(`[A-Za-z]*[Tt]ype:\\s*'${t}'`).test(src) ||
          new RegExp(`cardClass:\\s*'${t}'`).test(src);
        if (!named) wrong.push(`${spec}: maps a scene to module '${t}', which the spec never names`);
      }
    }
    expect(wrong, 'CARD_CAPTURE_DIRS disagrees with the spec it describes').toEqual([]);
  });

  it('the baseline PNGs are materialized (LFS), not pointer stubs', () => {
    if (unreadable && !REQUIRED) {
      // Loud skip: the `unit` lane checks out lfs:false on purpose.
      console.warn(
        `[vrt-cable-stripe] SKIPPING pixel assertions: ${pointers} baseline(s) are git-LFS ` +
        `pointer stubs. Expected in the lfs:false unit lane; the gate runs for real in ` +
        `vrt-strict with VRT_STRIPE_PALETTE_REQUIRED=1.`,
      );
      return;
    }
    expect(
      pointers,
      `VRT_STRIPE_PALETTE_REQUIRED=1 but ${pointers} baseline(s) are LFS pointer stubs — this ` +
      `lane promised to materialize them, so refusing to skip-pass.`,
    ).toBe(0);
  });

  it('resolves a --cable-* token for a substantial share of the baselines', () => {
    if (unreadable && !REQUIRED) return;
    // Print what the gate is structurally unable to judge, EVERY run — green
    // included. Previously `skipped` appeared only inside a failure message, so
    // the 47 dropped rows were invisible on exactly the runs people look at,
    // and a card that stopped being token-pinned would leave silently.
    console.info(
      `[vrt-cable-stripe] compared ${pinned.length} token-pinned baselines across ` +
      `${Object.keys(CARD_CAPTURE_DIRS).length} card-capture + ` +
      `${Object.keys(CABLE_EDGE_DIRS).length} cable-edge dirs ` +
      `(${Object.keys(NON_CARD_CAPTURE_DIRS).length} excluded, each claim asserted).\n` +
      `  not token-pinned (${skipped.length}):\n    ${skipped.join('\n    ')}`,
    );
    // No floor here — see the note where MIN_TOKEN_PINNED_BASELINES used to
    // be. What this test still does is PRINT the scope every run, green
    // included, so "the gate compared almost nothing" is visible in the log of
    // the runs people actually read. The assertion that a resolver break is RED
    // lives in the exact-set test immediately below.
    expect(
      pinned.length > 0,
      `NO baseline resolved to a --cable-* stripe token at all. Either the screenshot tree is ` +
      `unreadable or the source-side resolver stopped recognising cards. Not-pinned reasons:\n  ` +
      `${skipped.join('\n  ')}`,
    ).toBe(true);
  });

  it('the set of NOT-token-pinned cards is exactly the declared one', () => {
    if (unreadable && !REQUIRED) return;
    // THE gate on the resolver, and the reason no count floor is needed above.
    // A single card converting `.stripe` from `var(--cable-audio)` to a
    // hardcoded `#38d3c8` would drop out of `pinned` — the escape hatch from
    // this gate is to STOP being token-pinned, and any count with slack in it
    // rewards that with silence. Pin the IDENTITY of the excused cards.
    const dropped = [...new Set(skipped.map((s) => s.split(': ')[0].split('/').pop()!))].sort();
    expect(
      dropped,
      `the set of scenes whose card does NOT pin .stripe to a --cable-* token changed. A card ` +
      `LEAVING this list is fine (it joined the gate). A card JOINING it means the gate silently ` +
      `stopped checking that card — hardcoding a hex where a token used to be is exactly the ` +
      `divergence this gate exists to catch, so it must be a deliberate, reviewed edit here.`,
    ).toEqual(NOT_TOKEN_PINNED_SCENES);
  });

  // ── THE TOLERANCE'S OWN GUARD ─────────────────────────────────────────────
  //
  // `stripeMatchesToken` accepts a partially-covered stripe, which is a real
  // relaxation of the old `got === token`. It is safe only while no RETIRED
  // palette generation can pose as a partial cover of a CURRENT token — that
  // is the exact drift this whole gate exists to catch, so it is asserted here
  // rather than argued in a comment. Runs on colours, needs no PNG, and so
  // cannot be skipped by the lfs:false lane.
  it('no retired generation hue can pose as a partially-covered current token', () => {
    // The card body every stripe in this repo sits on; the blend background.
    const BODY = '#1c1f24';
    const worst: string[] = [];
    const spreads: number[] = [];
    for (const [retired, label] of Object.entries(CABLE_HUES_ALL_GENERATIONS)) {
      for (const [name, current] of Object.entries(tokens)) {
        if (retired === current) continue; // a hue that came back is not drift
        expect(
          stripeMatchesToken(retired, BODY, current),
          `${retired} (${label}) is accepted as a partial cover of ${name} (${current}) over ` +
          `${BODY}. The coverage tolerance (STRIPE_ALPHA_SPREAD=${STRIPE_ALPHA_SPREAD}) is now ` +
          `wide enough to swallow real palette drift — tighten it.`,
        ).toBe(false);
        // Track the SPREAD margin so erosion is visible as a number, not just
        // as an eventual red. (The second axis, STRIPE_MAX_COVERAGE, is what
        // catches the tightest pair independently — see the constant.)
        const g = hexToRgb(retired);
        const bg = hexToRgb(BODY);
        const t = hexToRgb(current);
        const al: number[] = [];
        for (let i = 0; i < 3; i++) {
          const span = t[i] - bg[i];
          if (Math.abs(span) >= 8) al.push((g[i] - bg[i]) / span);
        }
        if (al.length >= 2) spreads.push(Math.max(...al) - Math.min(...al));
        worst.push(`${retired}->${name}`);
      }
    }
    expect(worst.length, 'the retired-hue matrix emptied out — this guard went vacuous').toBeGreaterThan(20);
    // Pin the MARGIN, not just the verdict. Measured tightest pair: #f472b6 as
    // --cable-polyPitchGate, spread 0.0494 against a 0.02 tolerance = 2.47x. A
    // future palette whose hues crowd an old generation shrinks this silently
    // until one day a real drift slips through; fail while there is still room.
    const tightest = Math.min(...spreads);
    expect(
      tightest / STRIPE_ALPHA_SPREAD,
      `the closest retired hue now sits ${tightest.toFixed(4)} from a current token against a ` +
      `${STRIPE_ALPHA_SPREAD} tolerance. Under 2x, the collinearity axis is no longer a real ` +
      'discriminator — tighten STRIPE_ALPHA_SPREAD or re-space the palette.',
    ).toBeGreaterThan(2);
  });

  // The colour-level guard above proves the PREDICATE rejects retired hues.
  // This proves the whole PIXEL PATH still does — decoder, band locator and
  // comparison — because a relaxation that is sound in isolation is still
  // worthless if the bytes never reach it. Repaints a real baseline's stripe
  // with a real RETIRED hue (not the trivially-wrong #ff0000 the batch control
  // uses) and requires exactly that baseline to go red.
  it('NEGATIVE CONTROL: a stripe repainted with a RETIRED hue still reddens', () => {
    if (unreadable && !REQUIRED) return;
    const RETIRED = '#f472b6'; // pre-#1159 video — the drift class this gate was built for
    const pendingSet = new Set(PENDING_PALETTE_REGEN);
    const target = pinned.find(
      (p) => p.token === '--cable-video' && !pendingSet.has(p.key) && p.y !== undefined,
    );
    expect(target, 'no --cable-video baseline available to control with').toBeTruthy();
    const path = resolve(SCREENSHOT_ROOT, target!.spec, `${target!.scene}.png`);
    // A fully-covered stripe can span TWO rows, and the band is chosen by
    // saturation — repainting just one leaves the other pure and winning
    // (measured: the gate still read #b57bff). #ff0000 hides this because its
    // saturation of 255 outranks everything; a REAL hue does not. So repaint
    // until the located band IS the retired hue. Bounded, and asserted below.
    let raw: Uint8Array<ArrayBufferLike> = new Uint8Array(readFileSync(path));
    for (let i = 0; i < 4; i++) {
      const band = findStripeBand(raw);
      if (!band || band.hex === RETIRED) break;
      raw = repaintStripeRow(raw, band.y, RETIRED);
    }
    const bytes = Buffer.from(raw);
    const remeasured = measure((q) => (q === path ? bytes : readFileSync(q)));
    expect(
      remeasured.pinned.find((p) => p.key === target!.key)?.got,
      'the gate did not read the repainted bytes',
    ).toBe(RETIRED);
    expect(
      offPaletteKeys(remeasured.pinned, tokens).filter((k) => !pendingSet.has(k)),
      `repainting ${target!.key} with the RETIRED ${RETIRED} must redden exactly it. If this is ` +
      'empty, the coverage tolerance has blinded the gate to genuine palette drift.',
    ).toEqual([target!.key]);
  });

  it('every token-pinned baseline paints its token', () => {
    if (unreadable && !REQUIRED) return;
    const pendingSet = new Set(PENDING_PALETTE_REGEN);
    const bad = offPalette(pinned.filter((p) => !pendingSet.has(p.key)), tokens);
    expect(
      bad,
      `${bad.length} token-pinned VRT baselines paint a STALE cable colour. ` +
      `The VRT gate cannot see this (the stripe is under maxDiffPixelRatio) and ` +
      `--update-snapshots cannot fix it (Playwright only rewrites on failure): \`git rm\` each ` +
      `baseline below, then regenerate — a MISSING snapshot is always written.`,
    ).toEqual([]);
  });

  it('PENDING_PALETTE_REGEN is EXACTLY the still-stale set (drains cannot pass silently)', () => {
    if (unreadable && !REQUIRED) return;
    expect(
      offPaletteKeys(pinned, tokens),
      `the declared still-stale list no longer matches reality. Entries that disappeared were ` +
      `regenerated (delete them from PENDING_PALETTE_REGEN — a ceiling would have let this pass ` +
      `SILENTLY, which is the whole reason this is an exact set); entries that appeared are new ` +
      `palette drift and must be regenerated, not listed.`,
    ).toEqual([...PENDING_PALETTE_REGEN].sort());
  });

  // ── NEGATIVE CONTROL, PIXEL SIDE ──────────────────────────────────────────
  //
  // A checker that cannot fail is decoration — and a control that perturbs the
  // EXPECTATION rather than the MEASUREMENT cannot tell the two apart. With the
  // baselines clean by precondition, "change tokens[X] ⇒ the X-pinned rows go
  // red" is arithmetic: an instrument that never opens a PNG and just returns
  // `CABLE_VARS[token]` satisfies it perfectly. (Demonstrated: stubbing
  // `findStripeBand` that way left the old control fully green.)
  //
  // So perturb the PIXELS. For every cable token in use, take a real baseline
  // pinned to it, repaint its located stripe row, re-encode a real PNG, and
  // push those BYTES back through `measure()` — the production resolver,
  // decoder, locator and comparison. Exactly those baselines must go red.
  //
  // ONE re-measure, all 9 tokens perturbed at once — not 9 re-measures. The
  // per-token loop cost 3.5-4.3 s (nine full 409-PNG scans) against vitest's
  // 5000 ms DEFAULT TIMEOUT, so it went red once under local load, and the unit
  // lane is ~2.5x slower on CI (CLAUDE.md) — it could not have held. Batching is
  // also the STRONGER assertion: the post-perturbation off-palette set must
  // equal the perturbed set EXACTLY, so a leak in either direction fails.
  it('NEGATIVE CONTROL: repainting baseline stripe rows reddens exactly those baselines', () => {
    if (unreadable && !REQUIRED) return;
    const PERTURBED = '#ff0000'; // saturation 255 — outranks any card chrome row
    expect(
      offPaletteKeys(pinned, tokens).filter((k) => !PENDING_PALETTE_REGEN.includes(k)),
      'precondition: the non-pending baselines must be clean before perturbation',
    ).toEqual([]);

    const pendingSet = new Set(PENDING_PALETTE_REGEN);
    const inUse = Object.keys(tokens).filter((t) => pinned.some((p) => p.token === t));
    const targets: Pinned[] = [];
    const perturbed = new Map<string, Buffer>();
    for (const token of inUse) {
      const target = pinned.find(
        (p) => p.token === token && !pendingSet.has(p.key) && p.y !== undefined,
      );
      if (!target) continue;
      targets.push(target);
      const path = resolve(SCREENSHOT_ROOT, target.spec, `${target.scene}.png`);
      perturbed.set(
        path,
        Buffer.from(repaintStripeRow(new Uint8Array(readFileSync(path)), target.y!, PERTURBED)),
      );
    }
    expect(
      targets.length,
      'every --cable-* token that any baseline pins must be pixel-controlled; a short list means ' +
      'some token is only ever asserted, never measured.',
    ).toBe(inUse.length);
    // …and the token set itself must not quietly empty out. 8 of the 9 cable
    // tokens are pinned by some card's `.stripe` today; `--cable-keys` is
    // declared but no card stripes with it, so it is legitimately impossible to
    // control from the pixel side. Pinning the SET (not a count) means a token
    // dropping out is red — a token this gate can no longer prove it measures.
    expect(
      targets.map((t) => t.token).sort(),
      'the set of pixel-controlled cable tokens changed — a token that left is a token this ' +
      'gate can no longer prove it measures.',
    ).toEqual([
      '--cable-audio', '--cable-cv', '--cable-gate', '--cable-image', '--cable-mono-video',
      '--cable-pitch', '--cable-polyPitchGate', '--cable-video',
    ]);

    const remeasured = measure((p) => perturbed.get(p) ?? readFileSync(p));

    for (const target of targets) {
      const hit = remeasured.pinned.find((p) => p.key === target.key);
      expect(
        hit?.got,
        `repainted row y=${target.y} of ${target.key}.png to ${PERTURBED}, but the gate still ` +
        `reads ${hit?.got} — it is NOT reading that file's pixels (units: #rrggbb of the modal ` +
        `colour of the most saturated uniform row in the top 12 image rows).`,
      ).toBe(PERTURBED);
    }
    expect(
      offPaletteKeys(remeasured.pinned, tokens).filter((k) => !pendingSet.has(k)),
      `perturbing the PIXELS of ${targets.length} baselines (one per cable token) must redden ` +
      'exactly those and nothing else — more means the perturbation leaked, fewer means the ' +
      'gate is not reading the bytes it was handed.',
    ).toEqual(targets.map((t) => t.key).sort());
  });
});
