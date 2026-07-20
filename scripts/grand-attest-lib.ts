// scripts/grand-attest-lib.ts
//
// Shared resolver + content-hash for the GRAND-INTEGRATION local-attestation
// "semaphore" — the third sibling of scripts/webgl-attest-lib.ts and
// scripts/collab-attest-lib.ts. See
// .myrobots/plans/grand-integration-e2e-art-2026-07-19.md and
// ci-grand-attest/README.md.
//
// Imported by BOTH:
//   - scripts/grand-attest-hash.ts   (the CLI that prints the hash / basis)
//   - scripts/grand-attest.ts        (the local heavy runner + writer)
//   - packages/web/src/lib/audio/modules/grand-attest-basis.test.ts (a fail-CLOSED
//     guard unit test in the required `unit` job)
// so the basis, the resolver, and the guard all agree and can't drift.
//
// DESIGN RULES (mirror webgl/collab):
//   * Deterministic + content-keyed (NOT git HEAD): survives squash/rebase/amend.
//   * Hash the AUDIO-DEFINING SUBSTANCE only — the four instrument DSP cores (+
//     the sub-libs their per-sample math flows through, the same union the ART
//     profiles pin), the pure clip step math, the SHARED clip fixture, the
//     offline ART scenario + the pure clip driver, and the toolchain pins.
//   * EXCLUDE `e2e/tests/**` (the Playwright DRIVER spec) and `scripts/**` (the
//     runner) — per the platform rule "editing a test/runner must not change an
//     attest hash." Editing the spec/runner is hash-free; a change to what the
//     scenario actually EXERCISES (cores/fixture/driver/step-math) is what forces
//     a re-attest. (Guarded by grand-attest-basis.test.ts.)
//   * package.json pins are NARROWED to the grand-relevant dep (@playwright/test —
//     the browser/H.264 engine the heavy attest depends on) via `grandDepDigest`,
//     so an unrelated web/video dep bump can't drift the hash (the collab #939
//     treadmill lesson). The Node/Chromium toolchain (.flox manifest) is hashed
//     wholesale (it pins the offline render's float determinism AND the browser
//     engine; it rarely churns, so over-cover is the safe direction).

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

/** The Playwright grep tag that selects the heavy grand-integration scenario.
 *  The attest runner runs EXACTLY this selector; it is NOT hashed (the spec is
 *  in `e2e/tests/**`, excluded from the hash), but it is the single source of
 *  truth for "what the runner runs" shared with the runner + guard. */
export const GRAND_GREP = '@grand-attest';

// ---------------------------------------------------------------------------
// The basis — explicit, narrow, meaningful.
// ---------------------------------------------------------------------------

/** The four instrument DSP cores + every sub-lib their per-sample math flows
 *  through — the UNION of the kick/snare/tidy/sixstrum ART profiles' `.sha`
 *  pins, so a coefficient change in ANY of them forces BOTH an ART re-pin and a
 *  grand re-attest (the desired coupling). */
export const GRAND_DSP_CORES = [
  'packages/dsp/src/lib/kickdrum-dsp.ts',
  'packages/dsp/src/lib/snaredrum-dsp.ts',
  'packages/dsp/src/lib/snare-roll-dsp.ts',
  'packages/dsp/src/lib/tidy-vco-dsp.ts',
  'packages/dsp/src/lib/sixstrum-dsp.ts',
  'packages/dsp/src/lib/sixstrum-tuning.ts',
  'packages/dsp/src/lib/karplus-dsp.ts',
  'packages/dsp/src/lib/analog-delay-core.ts',
  'packages/dsp/src/lib/adsr-env.ts',
  'packages/dsp/src/lib/moog-vco-dsp.ts',
  'packages/dsp/src/lib/dsp-utils.ts',
  'packages/dsp/src/lib/oversample.ts',
  'packages/dsp/src/lib/rbj-biquad.ts',
];

/** The PURE clip step math the driver + browser scheduler both depend on (the
 *  offline↔browser fidelity anchor). */
export const GRAND_CLIP_MATH = [
  'packages/web/src/lib/audio/modules/clip-types.ts',
  'packages/web/src/lib/audio/modules/clip-clock.ts',
];

/** The SHARED clip/automation fixture (seeds BOTH the browser spec and the
 *  offline ART) + the offline ART scenario + the pure clip driver. Editing any
 *  of these changes what the scenario exercises → re-attest. */
export const GRAND_SCENARIO_SUBSTANCE = [
  'e2e/fixtures/grand-integration/clips.ts',
  'art/scenarios/grand-integration/combined-master.test.ts',
  'art/setup/clip-driver.ts',
];

/** Toolchain pins. `e2e/package.json` is NARROWED to @playwright/test (see
 *  grandDepDigest); `.flox/env/manifest.toml` is hashed wholesale. */
export const TOOLCHAIN_PIN_FILES = [
  'e2e/package.json', // narrowed → @playwright/test (browser + H.264 engine)
  '.flox/env/manifest.toml', // Node/Chromium toolchain (offline float determinism + engine)
];

/** A package.json dep can move the heavy attest's browser/encoder behavior ONLY
 *  if it's the Playwright harness. A bump to any other dep must NOT drift the
 *  hash (the collab #939 wholesale-churn lesson). */
export const GRAND_DEP_ALLOW: RegExp[] = [/^@playwright\/test$/];

/** Is this basis entry a package.json toolchain pin (→ narrow-hashed by deps)? */
function isPackageJsonPin(rel: string): boolean {
  return TOOLCHAIN_PIN_FILES.includes(rel) && rel.endsWith('package.json');
}

/** Deterministic digest of ONLY the grand-relevant deps (GRAND_DEP_ALLOW) in a
 *  package.json's dependencies + devDependencies — sorted `name@range` lines.
 *  Exported for the basis guard test. */
export function grandDepDigest(pkgRel: string): string {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, pkgRel), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...(raw.dependencies ?? {}), ...(raw.devDependencies ?? {}) };
  return Object.keys(all)
    .filter((name) => GRAND_DEP_ALLOW.some((re) => re.test(name)))
    .sort()
    .map((name) => `${name}@${all[name]}`)
    .join('\n');
}

/** Returns the FULL, sorted, repo-relative list of files in the grand content
 *  hash basis. Every file here, by content, feeds the hash. */
export function resolveGrandBasis(): string[] {
  const files = new Set<string>();
  for (const f of [
    ...GRAND_DSP_CORES,
    ...GRAND_CLIP_MATH,
    ...GRAND_SCENARIO_SUBSTANCE,
    ...TOOLCHAIN_PIN_FILES,
  ]) {
    if (existsSync(join(REPO_ROOT, f))) files.add(f);
  }
  return [...files].sort();
}

// ---------------------------------------------------------------------------
// The hash (identical algorithm to webgl/collab-attest-lib / dsp-src-hash.sh).
// ---------------------------------------------------------------------------

/** Deterministic content-hash over the basis: for each file in sorted order,
 *  feed `<repo-relative-path>\0<bytes>` into one sha256. package.json pins are
 *  hashed NARROWLY (grandDepDigest); every other file is hashed by raw bytes. */
export function computeGrandHash(): string {
  const h = createHash('sha256');
  for (const rel of resolveGrandBasis()) {
    h.update(rel);
    h.update('\0');
    if (isPackageJsonPin(rel)) {
      h.update(grandDepDigest(rel));
    } else {
      h.update(readFileSync(join(REPO_ROOT, rel)));
    }
  }
  return h.digest('hex');
}
