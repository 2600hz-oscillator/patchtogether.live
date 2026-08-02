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
// baselines were still on the OLD hues nine days later, across BOTH
// platforms, with a green required lane the whole time.
//
// WHERE IT RUNS. The PNGs are git-LFS objects and the `unit` lane checks out
// `lfs: false`, so there the files are pointer stubs and this gate would
// self-skip into decoration. It is therefore ALSO wired into the `vrt-strict`
// job (the REQUIRED lane that runs `git lfs pull --include
// "e2e/vrt/__screenshots__/**"`) with `VRT_STRIPE_PALETTE_REQUIRED=1`, which
// turns "cannot read the bytes" from a skip into a FAILURE. Same shape as the
// ART fingerprint drift gate's `ART_FINGERPRINTS_REQUIRED=1`.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CABLE_VARS } from '$lib/ui/skins/palettes/_cables';
import {
  CARD_CAPTURE_DIRS,
  NON_CARD_CAPTURE_DIRS,
  conventionalCardBasename,
  findStripeBand,
  repaintStripeRow,
  stripeSourceToken,
} from '$lib/ui/vrt-cable-stripe';
// vitest's resolve.alias doesn't reach across the /e2e/ workspace, so this is a
// relative path — same as vrt-meta.test.ts.
import { EXEMPT_BASELINE_PAIRS } from '../../../../../e2e/vrt/vrt-exemptions';

// This file lives at packages/web/src/lib/ui/. Five `..` hops = repo root.
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const CARD_DIR = resolve(REPO_ROOT, 'packages/web/src/lib/ui/modules');
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
 * LOWER BOUND on how many baselines this gate must actually compare.
 *
 * Without it the gate is one bad regex away from vacuity: a `.stripe` markup
 * change would silently move every card into "not token-pinned" and the suite
 * would stay green while checking nothing. This is a VACUITY TRIPWIRE, not a
 * coverage target — it wants headroom, not precision.
 *
 * Measured 2026-08-01 with the widened directory scope: 190 token-pinned
 * baselines (128 in `vrt.spec.ts`, 62 across the other 8 single-card dirs).
 */
const MIN_TOKEN_PINNED_BASELINES = 170;

/**
 * Baselines that are token-pinned, COMPARED by a test, and still painting a
 * pre-#1159 hue — because the PR that regenerates them is a different one.
 *
 * This is an EXACT SET, not a ceiling: `toEqual` fails if an entry is missing
 * (someone regenerated it and forgot to drain this list) AND if an entry is
 * added (new drift). A ceiling would let a drain pass silently, which is the
 * exact failure mode CLAUDE.md calls out for the linux-deficit ratchet.
 *
 * DRAIN WHEN: PR #1279 (`test/vrt-font-settle-sweep`) lands — it regenerates
 * precisely these 39 files. MEASURED, not assumed: every one of the 39 blobs
 * on `origin/test/vrt-font-settle-sweep` decodes to the CURRENT token (30
 * darwin captured locally, 9 linux from the `vrt-update.yml` dispatch commit
 * 809e074a). Whichever of the two PRs merges second must merge `main`, watch
 * this assertion go red, and empty the list in the same commit. That red is
 * the point: it is the only thing tying two PRs that share no file.
 */
const PENDING_PALETTE_REGEN: readonly string[] = [
  'vrt-clap.spec.ts/darwin/clap-909-dense',
  'vrt-clap.spec.ts/darwin/clap-dry-snap',
  'vrt-clap.spec.ts/darwin/clap-linn-room',
  'vrt-clap.spec.ts/linux/clap-909-dense',
  'vrt-clap.spec.ts/linux/clap-dry-snap',
  'vrt-clap.spec.ts/linux/clap-linn-room',
  'vrt-colourofmagic.spec.ts/darwin/com-hsv',
  'vrt-colourofmagic.spec.ts/darwin/com-override',
  'vrt-colourofmagic.spec.ts/darwin/com-palette',
  'vrt-colourofmagic.spec.ts/darwin/com-pass',
  'vrt-colourofmagic.spec.ts/darwin/com-rgb',
  'vrt-colourofmagic.spec.ts/darwin/com-ycc',
  'vrt-colourofmagic.spec.ts/darwin/com-ydbdr',
  'vrt-colourofmagic.spec.ts/darwin/com-yiq',
  'vrt-colourofmagic.spec.ts/darwin/com-yiq-i-tap',
  'vrt-karplus-tomtom-states.spec.ts/darwin/karplus-bell-extreme',
  'vrt-karplus-tomtom-states.spec.ts/darwin/karplus-dark-mallet',
  'vrt-karplus-tomtom-states.spec.ts/darwin/karplus-scrape-bridge',
  'vrt-karplus-tomtom-states.spec.ts/darwin/tomtom-simmons-zap',
  'vrt-karplus-tomtom-states.spec.ts/darwin/tomtom-strike-held',
  'vrt-karplus-tomtom-states.spec.ts/darwin/tomtom-timbale-tight',
  'vrt-karplus-tomtom-states.spec.ts/linux/karplus-bell-extreme',
  'vrt-karplus-tomtom-states.spec.ts/linux/karplus-dark-mallet',
  'vrt-karplus-tomtom-states.spec.ts/linux/karplus-scrape-bridge',
  'vrt-karplus-tomtom-states.spec.ts/linux/tomtom-simmons-zap',
  'vrt-karplus-tomtom-states.spec.ts/linux/tomtom-strike-held',
  'vrt-karplus-tomtom-states.spec.ts/linux/tomtom-timbale-tight',
  'vrt-posterbox-states.spec.ts/darwin/posterbox-brutal-1bit',
  'vrt-posterbox-states.spec.ts/darwin/posterbox-dither-hatch',
  'vrt-posterbox-states.spec.ts/darwin/posterbox-subtle-565',
  'vrt-quadralogical.spec.ts/darwin/edge-add',
  'vrt-quadralogical.spec.ts/darwin/edge-chroma',
  'vrt-quadralogical.spec.ts/darwin/edge-diff',
  'vrt-quadralogical.spec.ts/darwin/edge-dissolve',
  'vrt-quadralogical.spec.ts/darwin/edge-iris',
  'vrt-quadralogical.spec.ts/darwin/edge-luma',
  'vrt-quadralogical.spec.ts/darwin/edge-multiply',
  'vrt-quadralogical.spec.ts/darwin/edge-wipe',
  'vrt-scope-modes.spec.ts/darwin/scope-intensity-dot',
];

/**
 * Scene stems whose card does NOT pin `.stripe` to a `--cable-*` token, and is
 * therefore excused from the pixel assertion. EXACT SET — see the test.
 *
 * `audioOut`/`mixer` paint `var(--text-dim)`; `wavesculpt` a 3-hex gradient;
 * the `moog*` family + `electraControl` + `sticky` render no `.stripe` at all.
 */
const NOT_TOKEN_PINNED_SCENES: readonly string[] = [
  'audioOut', 'electraControl', 'mixer',
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
  /** `<spec>/<platform>/<scene>` — unique across the whole screenshot tree. */
  key: string;
  spec: string;
  platform: string;
  scene: string;
  type: string;
  card: string;
  token: string;
  /** `#rrggbb` actually painted, or undefined if no stripe band was found. */
  got?: string;
  y?: number;
  saturation?: number;
}

interface Measured {
  pinned: Pinned[];
  skipped: string[];
  quarantined: string[];
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
  const quarantined: string[] = [];
  let pointers = 0;
  for (const spec of baselineDirs()) {
    const sceneType = CARD_CAPTURE_DIRS[spec];
    if (!sceneType) continue; // declared non-card, or unclassified (asserted below)
    const specDir = resolve(SCREENSHOT_ROOT, spec);
    for (const platform of readdirSync(specDir).sort()) {
      const dir = resolve(specDir, platform);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith('.png')) continue;
        const scene = file.replace(/\.png$/, '');
        const key = `${spec}/${platform}/${scene}`;
        // A pair in EXEMPT_BASELINE_PAIRS is `test.skip()`-ed UNCONDITIONALLY, so
        // its PNG is not compared by anything and CANNOT be repaired by
        // `--update-snapshots` (the test never runs). Holding it to the current
        // palette would make this gate un-satisfiable, so it is reported instead
        // of asserted — see the `quarantined` list printed by the coverage test.
        // Deleting such a file is the preferred treatment (a baseline nothing
        // compares is not coverage, and a MISSING snapshot is what makes a later
        // drain-then-dispatch actually capture); the survivors are the ones that
        // must keep an image for a reason, e.g. `darwin/rasterize`, which is a
        // canvas-timing FLAKE quarantine and is rasterize's only baseline.
        // (The Set is GLOBAL and keyed `<platform>/<sceneId>`: every card-capture
        // spec consults it with its own scene id, which is the PNG stem.)
        if (EXEMPT_BASELINE_PAIRS.has(`${platform}/${scene}`)) {
          quarantined.push(key);
          continue;
        }
        const type = sceneType(scene);
        const card = explicit[type] ?? conventionalCardBasename(type);
        const cardPath = resolve(CARD_DIR, `${card}.svelte`);
        if (!existsSync(cardPath)) {
          skipped.push(`${key}: no card component (${card}.svelte)`);
          continue;
        }
        const source = stripeSourceToken(readFileSync(cardPath, 'utf8'));
        if (source.kind !== 'token') {
          skipped.push(`${key}: ${source.reason}`);
          continue;
        }
        const bytes = readBytes(resolve(dir, file));
        if (bytes.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8') === LFS_POINTER_PREFIX) {
          pointers++;
          continue;
        }
        const band = findStripeBand(new Uint8Array(bytes));
        pinned.push({
          key, spec, platform, scene, type, card, token: source.token,
          got: band?.hex, y: band?.y, saturation: band?.saturation,
        });
      }
    }
  }
  return { pinned, skipped, quarantined, pointers };
}

/** Which of the measured baselines disagree with a given palette? */
function offPalette(pinned: Pinned[], tokens: Record<string, string>): string[] {
  return pinned
    .filter((p) => p.got !== tokens[p.token])
    .map(
      (p) =>
        `${p.key}.png (${p.card}, ${p.token}): expected ${tokens[p.token]}, ` +
        `baseline paints ${p.got ?? '<no stripe band found>'}` +
        (p.y === undefined ? '' : ` at row y=${p.y} (saturation ${p.saturation})`),
    );
}

/** Just the keys, for set comparison against PENDING_PALETTE_REGEN. */
function offPaletteKeys(pinned: Pinned[], tokens: Record<string, string>): string[] {
  return pinned.filter((p) => p.got !== tokens[p.token]).map((p) => p.key).sort();
}

describe('VRT baselines paint the CURRENT --cable-* stripe', () => {
  const { pinned, skipped, quarantined, pointers } = measure();
  const unreadable = pointers > 0;
  const tokens = CABLE_VARS as unknown as Record<string, string>;

  it('every baseline directory is classified as card-capture or not', () => {
    // Pure source/dir bookkeeping — safe to run even on an lfs:false checkout.
    const unclassified = baselineDirs().filter(
      (d) => !CARD_CAPTURE_DIRS[d] && !NON_CARD_CAPTURE_DIRS[d],
    );
    expect(
      unclassified,
      `new VRT spec directories under e2e/vrt/__screenshots__ that this gate has never been ` +
      `told about. A gate whose scope is undeclared reads as full coverage: add each to ` +
      `CARD_CAPTURE_DIRS (single-card capture — give the stem → module type mapping) or to ` +
      `NON_CARD_CAPTURE_DIRS (with the reason it has no card stripe), in vrt-cable-stripe.ts.`,
    ).toEqual([]);
    // ...and the reverse: a table entry for a directory that no longer exists is
    // dead weight that quietly shrinks the gate's real scope.
    const dirs = new Set(baselineDirs());
    const dead = [...Object.keys(CARD_CAPTURE_DIRS), ...Object.keys(NON_CARD_CAPTURE_DIRS)]
      .filter((d) => !dirs.has(d))
      .sort();
    expect(dead, 'classification entries for baseline dirs that no longer exist').toEqual([]);
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
      const types = new Set<string>();
      for (const platform of readdirSync(dir)) {
        const pd = resolve(dir, platform);
        if (!statSync(pd).isDirectory()) continue;
        for (const f of readdirSync(pd)) {
          if (f.endsWith('.png')) types.add(toType(f.replace(/\.png$/, '')));
        }
      }
      for (const t of types) {
        const named =
          src.includes(`svelte-flow__node-${t}`) ||
          new RegExp(`moduleType:\\s*'${t}'`).test(src) ||
          new RegExp(`type:\\s*'${t}'`).test(src);
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
      `${Object.keys(CARD_CAPTURE_DIRS).length} card-capture dirs.\n` +
      `  EXEMPT_BASELINE_PAIRS (never compared by any test, so their pixels can be neither ` +
      `asserted nor repaired): ${quarantined.join(', ') || '(none)'}\n` +
      `  not token-pinned (${skipped.length}):\n    ${skipped.join('\n    ')}`,
    );
    expect(
      pinned.length,
      `only ${pinned.length} baselines resolved to a --cable-* stripe token (floor ` +
      `${MIN_TOKEN_PINNED_BASELINES}). A drop means the source-side resolver stopped recognising ` +
      `cards — the gate would be vacuous. Not-pinned reasons:\n  ${skipped.join('\n  ')}`,
    ).toBeGreaterThanOrEqual(MIN_TOKEN_PINNED_BASELINES);
  });

  it('the set of NOT-token-pinned cards is exactly the declared one', () => {
    if (unreadable && !REQUIRED) return;
    // The count floor above has ~20 baselines of slack, so a single card
    // converting `.stripe` from `var(--cable-audio)` to a hardcoded `#38d3c8`
    // would drop out of `pinned` and stay under the floor — the escape hatch
    // from this gate is to STOP being token-pinned, and a floor rewards it with
    // silence. Pin the identity of the excused cards, not just their number.
    const dropped = [...new Set(skipped.map((s) => s.split(': ')[0].split('/').pop()!))].sort();
    expect(
      dropped,
      `the set of scenes whose card does NOT pin .stripe to a --cable-* token changed. A card ` +
      `LEAVING this list is fine (it joined the gate). A card JOINING it means the gate silently ` +
      `stopped checking that card — hardcoding a hex where a token used to be is exactly the ` +
      `divergence this gate exists to catch, so it must be a deliberate, reviewed edit here.`,
    ).toEqual(NOT_TOKEN_PINNED_SCENES);
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
  // decoder, locator and comparison. Exactly that one baseline must go red.
  it('NEGATIVE CONTROL: repainting a baseline stripe row reddens exactly that baseline', () => {
    if (unreadable && !REQUIRED) return;
    const PERTURBED = '#ff0000'; // saturation 255 — outranks any card chrome row
    expect(
      offPaletteKeys(pinned, tokens).filter((k) => !PENDING_PALETTE_REGEN.includes(k)),
      'precondition: the non-pending baselines must be clean before perturbation',
    ).toEqual([]);

    const pendingSet = new Set(PENDING_PALETTE_REGEN);
    let controlled = 0;
    for (const token of Object.keys(tokens)) {
      const target = pinned.find(
        (p) => p.token === token && !pendingSet.has(p.key) && p.y !== undefined,
      );
      if (!target) continue;
      controlled++;
      const targetPath = resolve(SCREENSHOT_ROOT, target.spec, target.platform, `${target.scene}.png`);
      const perturbedBytes = Buffer.from(
        repaintStripeRow(new Uint8Array(readFileSync(targetPath)), target.y!, PERTURBED),
      );

      const remeasured = measure((p) => (p === targetPath ? perturbedBytes : readFileSync(p)));
      const hit = remeasured.pinned.find((p) => p.key === target.key);
      expect(
        hit?.got,
        `repainted row y=${target.y} of ${target.key}.png to ${PERTURBED}, but the gate still ` +
        `reads ${hit?.got} — it is NOT reading that file's pixels (units: #rrggbb of the modal ` +
        `colour of the most saturated uniform row in the top 12 image rows).`,
      ).toBe(PERTURBED);

      const bad = offPaletteKeys(remeasured.pinned, tokens).filter((k) => !pendingSet.has(k));
      expect(
        bad,
        `perturbing the PIXELS of ${target.key}.png (${token}) should redden exactly that ` +
        `baseline and nothing else.`,
      ).toEqual([target.key]);
    }
    expect(
      controlled,
      'every --cable-* token that any baseline pins must be pixel-controlled; 0 means the loop ' +
      'never ran and this test is decoration.',
    ).toBe(Object.keys(tokens).filter((t) => pinned.some((p) => p.token === t)).length);
    expect(controlled, 'expected all 9 cable tokens to be in use by some baseline').toBeGreaterThan(0);
  });
});
