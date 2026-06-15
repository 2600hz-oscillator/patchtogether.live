// scripts/collab-attest-lib.ts
//
// Shared resolver + content-hash for the @collab local-attestation "semaphore".
// The COLLAB analogue of scripts/webgl-attest-lib.ts — see
// .myrobots/plans/collab-attest-2026-06-15.md (the design, the basis, the
// honor-system framing) and ci-collab-attest/README.md.
//
// Imported by BOTH:
//   - scripts/collab-attest-hash.ts        (the CLI that prints the hash)
//   - scripts/collab-attest.ts             (the local runner + writer)
//   - packages/web/src/lib/multiplayer/collab-attest-basis.test.ts (a guard
//     unit test that the basis resolves to a non-trivial set + the relay-skip
//     classifier is sane)
// so the basis, the resolver, and the skip-classifier all agree and can't drift.
//
// DESIGN RULES (load-bearing — mirror webgl-attest-lib's):
//   * Deterministic + content-keyed (NOT git HEAD): survives squash-merge /
//     rebase / amend. Same content → same hash, always.
//   * Coarse + fail-CLOSED directory hashing where cheap (like
//     scripts/dsp-src-hash.sh + webgl-attest-lib): a missed file causes
//     OVER-invalidation (one extra re-attest, the SAFE direction), never a
//     missed re-attest.
//   * EXCLUDE **/*.test.ts under the hashed source dirs — those are node-env
//     vitest unit tests in the `unit` job; including them would force a re-attest
//     (a ~6.5-8 min @collab run) on every node-only unit-test edit. The @collab
//     e2e SPECS (which DO determine multiplayer behavior under test) are included
//     separately, resolved by their @collab/@capacity tag — fix mirrors webgl V6.
//   * The @collab spec set is resolved by SCANNING e2e/tests for the
//     @collab/@capacity tag (the exact selector the `collab` lane greps), not a
//     hand-listed glob — so a newly-tagged spec auto-enters the basis.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

/** The Playwright grep the `collab` lane uses to select multi-context specs.
 *  The attest runner runs EXACTLY this selector; the basis resolver uses the
 *  same tag set so "a spec the lane runs" == "a spec in the hash". */
export const COLLAB_GREP = '@collab|@capacity';
const COLLAB_TAG_RE = /@collab|@capacity/;

// -------------------------------------------------------------------------
// Whole-directory source roots that determine collab behavior (fail-CLOSED).
// Hashed wholesale EXCEPT node-env unit tests (**/*.test.ts). Over-coverage is
// the SAFE direction (an extra re-attest), so we take whole dirs rather than a
// hand-picked file allowlist that could silently miss a new sync file.
// -------------------------------------------------------------------------

/** Whole directories in the basis (every non-test file feeds the hash). */
export const COLLAB_DIR_ROOTS = [
  // The relay itself — Hocuspocus server, auth, capacity/slots, snapshot
  // persistence, reaper, heartbeat. THE multiplayer backend.
  'packages/server/src',
  // Client sync/presence/roster/awareness/layouts/clock-sync — the
  // multi-user app layer that talks to the relay.
  'packages/web/src/lib/multiplayer',
];

/** Individual source files in the basis (the syncedStore glue + the synced
 *  mutation surface + the DOOM multiplayer layer). DOOM's doom-* files are the
 *  most heavily @collab-tested sync surface (netcode/roster/presence/lockstep);
 *  they live in lib/doom alongside many NON-sync DOOM files (runtime, keys,
 *  sprites), so we list the sync ones explicitly rather than hash the whole dir
 *  (which would force a re-attest on a keyboard-routing or sprite edit). */
export const COLLAB_STANDALONE_SOURCE = [
  // syncedStore glue + provider wiring + persisted-snapshot bridge.
  'packages/web/src/lib/graph/store.ts',
  'packages/web/src/lib/graph/persistence.ts',
  'packages/web/src/lib/graph/snapshot.ts',
  // The synced mutation/duplicate surface (writes that must converge cross-tab).
  'packages/web/src/lib/graph/mutate.ts',
  'packages/web/src/lib/graph/duplicate.ts',
  // DOOM multiplayer sync layer (the lockstep/roster/presence/netcode oracle
  // the @collab DOOM specs exercise end-to-end). NON-sync DOOM files
  // (runtime/keys/sprites/cheats) are intentionally NOT here.
  'packages/web/src/lib/doom/doom-netcode.ts',
  'packages/web/src/lib/doom/doom-lockstep.ts',
  'packages/web/src/lib/doom/doom-roster.ts',
  'packages/web/src/lib/doom/doom-presence.ts',
  'packages/web/src/lib/doom/doom-session.ts',
  'packages/web/src/lib/doom/doom-host-authority.ts',
  'packages/web/src/lib/doom/doom-awareness-signature.ts',
  'packages/web/src/lib/doom/doom-gating.ts',
  'packages/web/src/lib/doom/doom-player-identity.ts',
];

/** Shared e2e helpers + config the @collab specs depend on (small, rarely
 *  churn; over-cover is safe). The DB schema is in-basis because the relay's
 *  auth/membership/persistence gates run real SQL against it (the @collab lane
 *  is VACUOUS without a DB — db/schema changes change collab behavior). */
export const COLLAB_STANDALONE_HELPER = [
  'e2e/tests/_collab-helpers.ts',
  'e2e/tests/_helpers.ts',
  'e2e/tests/_drivers.ts',
  'e2e/tests/_registry.ts',
  'e2e/playwright.config.ts',
  'db/schema/001_init.sql',
  'db/schema/003_saved_groups.sql',
];

/** Toolchain pins that can change relay/sync/runtime behavior (a Hocuspocus /
 *  yjs / Playwright bump can move sync semantics or the multi-context harness).
 *  Hashed wholesale; they rarely churn, so over-coverage is the safe direction.
 *  Mirrors webgl-attest-lib's TOOLCHAIN_PIN_FILES. */
export const TOOLCHAIN_PIN_FILES = [
  'packages/server/package.json', // pins @hocuspocus/server, yjs, pg
  'packages/web/package.json', // pins the client provider + syncedStore
  'e2e/package.json', // pins @playwright/test (the multi-context harness)
  '.flox/env/manifest.toml', // pins the Node toolchain
];

// -------------------------------------------------------------------------
// File-walk helpers (mirror webgl-attest-lib).
// -------------------------------------------------------------------------

/** Recursively list every file under `dir` (relative to REPO_ROOT), POSIX
 *  paths, optionally excluding a predicate. Returns repo-relative paths. */
function walk(dirRel: string, exclude?: (relPath: string) => boolean): string[] {
  const abs = join(REPO_ROOT, dirRel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = posix(join(dirRel, entry.name));
    if (entry.isDirectory()) {
      out.push(...walk(childRel, exclude));
    } else if (entry.isFile()) {
      if (exclude && exclude(childRel)) continue;
      out.push(childRel);
    }
  }
  return out;
}

/** Normalize OS path separators to POSIX so hashes are identical on macOS/Linux. */
function posix(p: string): string {
  return p.split(sep).join('/');
}

// -------------------------------------------------------------------------
// @collab spec resolution (by tag — the same selector the lane greps).
// -------------------------------------------------------------------------

/** Resolve the @collab/@capacity-tagged e2e spec FILE set by scanning
 *  e2e/tests for the tag (the same `--grep "@collab|@capacity"` the `collab`
 *  lane uses). Returns repo-relative, sorted paths. A newly-tagged spec
 *  auto-enters the basis → a re-attest is forced when it's added/edited. */
export function resolveCollabSpecs(): string[] {
  const all = walk('e2e/tests').filter((p) => p.endsWith('.spec.ts'));
  const matched = all.filter((p) => COLLAB_TAG_RE.test(readFileSync(join(REPO_ROOT, p), 'utf8')));
  return matched.sort();
}

// -------------------------------------------------------------------------
// The COLLAB_PATHS basis (mechanical + fail-closed).
// -------------------------------------------------------------------------

/** Returns the FULL, sorted, repo-relative list of files in the collab content
 *  hash basis. Every file here, by content, feeds the hash. Mechanical: the
 *  source roots are whole-dir swept; the specs are derived by tag. */
export function resolveCollabBasis(): string[] {
  const files = new Set<string>();

  // (1) Whole source-dir roots — fail-closed, EXCLUDING node-env unit tests.
  for (const root of COLLAB_DIR_ROOTS) {
    for (const f of walk(root, (p) => p.endsWith('.test.ts'))) files.add(f);
  }

  // (2) Standalone sync sources (syncedStore glue + DOOM MP layer).
  for (const f of COLLAB_STANDALONE_SOURCE) {
    if (existsSync(join(REPO_ROOT, f))) files.add(f);
  }

  // (3) The @collab/@capacity specs (resolved by tag) — editing any attested
  //     spec forces a re-attest.
  for (const f of resolveCollabSpecs()) files.add(f);

  // (4) Shared helpers + config + DB schema.
  for (const f of COLLAB_STANDALONE_HELPER) {
    if (existsSync(join(REPO_ROOT, f))) files.add(f);
  }

  // (5) Toolchain pins.
  for (const f of TOOLCHAIN_PIN_FILES) {
    if (existsSync(join(REPO_ROOT, f))) files.add(f);
  }

  return [...files].sort();
}

// -------------------------------------------------------------------------
// The hash (identical algorithm to webgl-attest-lib / dsp-src-hash.sh).
// -------------------------------------------------------------------------

/** Deterministic content-hash over the basis: for each file in sorted order,
 *  feed `<repo-relative-path>\0<file-bytes>` into one sha256. */
export function computeCollabHash(): string {
  const h = createHash('sha256');
  for (const rel of resolveCollabBasis()) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(REPO_ROOT, rel)));
  }
  return h.digest('hex');
}

// -------------------------------------------------------------------------
// Vacuous-skip classifier — THE meaningful-gate guard.
// -------------------------------------------------------------------------
//
// A @collab spec `test.skip(true, '…')`s for two distinct reasons:
//   (a) RELAY/SYNC VACUITY: cross-context Yjs sync / roster / presence /
//       lockstep did not converge ("relay flake", "sync did not reach",
//       "roster sync did not seat", "never saw/took", "mpLive sync"). LOCALLY,
//       on a fresh dedicated relay with zero shard contention, this MUST NOT
//       happen — if it does, the local run is itself vacuous and CANNOT back a
//       trustworthy attestation. The runner treats this as a HARD FAILURE.
//   (b) ASSET/RESOURCE: a build artifact (DOOM WASM / DOOM1.WAD / SNES ROM) is
//       absent, or a context ran out of headroom ("missing", "not built",
//       "resource-constrained", "failed to load … within"). These are
//       legitimate environmental skips, NOT relay vacuity — but the runner
//       PRE-FLIGHTS the assets so they should not fire either, and reports any
//       that do.
//
// The classifier is the single source of truth for which skip reasons are
// VACUITY (poison the attestation) vs benign. Tested by the basis guard.

/** Substrings that mark a skip as RELAY/SYNC VACUITY (poisons the attestation).
 *  Case-insensitive. Drawn from every `test.skip(true,'…')` reason across the
 *  @collab specs (see the plan doc's enumeration). */
export const RELAY_VACUITY_MARKERS = [
  'relay flake',
  'sync did not',
  'sync flake',
  'roster sync',
  'mplive sync',
  'node sync',
  'never saw',
  'never took',
  'did not reach',
  'did not seat',
  'did not deliver',
];

/** True iff a skip reason indicates relay/sync vacuity (so a LOCAL skip with
 *  this reason must FAIL the attestation — the run proved nothing). */
export function isRelayVacuitySkip(reason: string): boolean {
  const r = (reason || '').toLowerCase();
  return RELAY_VACUITY_MARKERS.some((m) => r.includes(m));
}
