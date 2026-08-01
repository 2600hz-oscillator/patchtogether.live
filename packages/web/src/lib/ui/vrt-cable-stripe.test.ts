// packages/web/src/lib/ui/vrt-cable-stripe.test.ts
//
// THE CABLE-STRIPE PALETTE GATE.
//
// Asserts that every committed per-card VRT baseline whose card pins its top
// `.stripe` to a `--cable-*` design token actually PAINTS that token's current
// value. Pure: source text + PNG bytes, no browser, no Playwright.
//
// It exists because the VRT gate is STRUCTURALLY BLIND to this class of drift
// (full writeup on vrt-cable-stripe.ts). Short version: the stripe is ~0.38 %
// of a card's pixels and `maxDiffPixelRatio` is 1 %, so a whole palette
// generation can rot in the baselines while `toHaveScreenshot` passes — and
// since Playwright only rewrites a snapshot on FAILURE, `--update-snapshots`
// cannot repair it either. Measured on this repo: #1159 recoloured every
// cable token and re-pinned a handful of PNGs; 76 of the 143 token-pinned
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CABLE_VARS } from '$lib/ui/skins/palettes/_cables';
import {
  conventionalCardBasename,
  findStripeBand,
  stripeSourceToken,
} from '$lib/ui/vrt-cable-stripe';
// vitest's resolve.alias doesn't reach across the /e2e/ workspace, so this is a
// relative path — same as vrt-meta.test.ts.
import { EXEMPT_BASELINE_PAIRS } from '../../../../../e2e/vrt/vrt-exemptions';

// This file lives at packages/web/src/lib/ui/. Five `..` hops = repo root.
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const CARD_DIR = resolve(REPO_ROOT, 'packages/web/src/lib/ui/modules');
const BASELINE_DIR = resolve(REPO_ROOT, 'e2e/vrt/__screenshots__/vrt.spec.ts');
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
 * Measured 2026-08-01: 143 token-pinned baselines before this PR (89 darwin +
 * 54 linux); 111 immediately after the stale ones are deleted, and 128 once
 * the linux recapture lands (15 of the deleted 32 are exempt-skipped pairs
 * that stay deleted on purpose — a baseline no test compares is not coverage).
 */
const MIN_TOKEN_PINNED_BASELINES = 105;

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
  platform: string;
  type: string;
  card: string;
  token: string;
  /** `#rrggbb` actually painted, or undefined if no stripe band was found. */
  got?: string;
  y?: number;
  saturation?: number;
}

/** Reads every baseline ONCE. Token comparison happens separately, so the
 *  negative control can re-evaluate against a perturbed palette for free. */
function measure(): {
  pinned: Pinned[];
  skipped: string[];
  quarantined: string[];
  pointers: number;
} {
  const explicit = cardBasenameByType();
  const pinned: Pinned[] = [];
  const skipped: string[] = [];
  const quarantined: string[] = [];
  let pointers = 0;
  if (!existsSync(BASELINE_DIR)) return { pinned, skipped, quarantined, pointers };
  for (const platform of readdirSync(BASELINE_DIR)) {
    const dir = resolve(BASELINE_DIR, platform);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.png')) continue;
      const type = file.replace(/\.png$/, '');
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
      if (EXEMPT_BASELINE_PAIRS.has(`${platform}/${type}`)) {
        quarantined.push(`${platform}/${type}`);
        continue;
      }
      const card = explicit[type] ?? conventionalCardBasename(type);
      const cardPath = resolve(CARD_DIR, `${card}.svelte`);
      if (!existsSync(cardPath)) {
        skipped.push(`${platform}/${type}: no card component (${card}.svelte)`);
        continue;
      }
      const source = stripeSourceToken(readFileSync(cardPath, 'utf8'));
      if (source.kind !== 'token') {
        skipped.push(`${platform}/${type}: ${source.reason}`);
        continue;
      }
      const bytes = readFileSync(resolve(dir, file));
      if (bytes.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8') === LFS_POINTER_PREFIX) {
        pointers++;
        continue;
      }
      const band = findStripeBand(new Uint8Array(bytes));
      pinned.push({
        platform, type, card, token: source.token,
        got: band?.hex, y: band?.y, saturation: band?.saturation,
      });
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
        `${p.platform}/${p.type}.png (${p.card}, ${p.token}): expected ${tokens[p.token]}, ` +
        `baseline paints ${p.got ?? '<no stripe band found>'}` +
        (p.y === undefined ? '' : ` at row y=${p.y} (saturation ${p.saturation})`),
    );
}

describe('VRT baselines paint the CURRENT --cable-* stripe', () => {
  const { pinned, skipped, quarantined, pointers } = measure();
  const unreadable = pointers > 0;
  const tokens = CABLE_VARS as unknown as Record<string, string>;

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
    // Print what the gate is structurally unable to judge, every run. A gate
    // that silently drops rows is how the previous audit counted 15 dark
    // baselines as coverage.
    console.info(
      `[vrt-cable-stripe] checking ${pinned.length} token-pinned baselines; ` +
      `${quarantined.length} skipped as EXEMPT_BASELINE_PAIRS (never compared by any test, so ` +
      `their pixels cannot be asserted OR repaired): ${quarantined.join(', ') || '(none)'}`,
    );
    expect(
      pinned.length,
      `only ${pinned.length} baselines resolved to a --cable-* stripe token (floor ` +
      `${MIN_TOKEN_PINNED_BASELINES}). A drop means the source-side resolver stopped recognising ` +
      `cards — the gate would be vacuous. Not-pinned reasons:\n  ${skipped.join('\n  ')}`,
    ).toBeGreaterThanOrEqual(MIN_TOKEN_PINNED_BASELINES);
  });

  it('every token-pinned baseline paints its token', () => {
    if (unreadable && !REQUIRED) return;
    const bad = offPalette(pinned, tokens);
    expect(
      bad,
      `${bad.length} of ${pinned.length} token-pinned VRT baselines paint a STALE cable colour. ` +
      `The VRT gate cannot see this (the stripe is under maxDiffPixelRatio) and ` +
      `--update-snapshots cannot fix it (Playwright only rewrites on failure): \`git rm\` each ` +
      `baseline below, then regenerate — a MISSING snapshot is always written.`,
    ).toEqual([]);
  });

  // ── NEGATIVE CONTROL ──────────────────────────────────────────────────────
  // A checker that cannot fail is decoration. Perturb the very thing the gate
  // claims to measure — a token's value — and the verdict MUST move, for EVERY
  // token in use. If any of these stays green, the comparison is not actually
  // reading that token's stripe pixels.
  it('NEGATIVE CONTROL: perturbing each --cable-* token turns the sweep red', () => {
    if (unreadable && !REQUIRED) return;
    expect(
      offPalette(pinned, tokens),
      'precondition: the committed baselines must be clean before perturbation',
    ).toEqual([]);

    for (const token of Object.keys(tokens)) {
      const users = pinned.filter((p) => p.token === token);
      if (users.length === 0) continue;
      const bad = offPalette(pinned, { ...tokens, [token]: '#0f0f0f' });
      expect(
        bad.length,
        `perturbing ${token} → #0f0f0f moved the verdict by ${bad.length}, not by the ` +
        `${users.length} baseline(s) pinned to it — the gate is not reading their stripe pixels.`,
      ).toBe(users.length);
    }
  });
});
