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

import { normalizeForHash, type BasisReader } from './attest-code-basis';

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
 *  The package.json pins are hashed NARROWLY — only the collab-relevant deps in
 *  COLLAB_DEP_ALLOW (see `collabDepDigest`), NOT the whole file. This kills the
 *  "re-attest treadmill" (task #160): #939 (MILKDROP) added a *video* dep
 *  (butterchurn) to packages/web/package.json and, because the file was hashed
 *  WHOLESALE, drifted the collab content-hash → collab-attest went red on a
 *  change that cannot possibly affect sync. The `.flox/env/manifest.toml` pin
 *  IS still hashed wholesale (no dep allowlist applies; the Node toolchain it
 *  pins rarely churns). Mirrors webgl-attest-lib's TOOLCHAIN_PIN_FILES. */
export const TOOLCHAIN_PIN_FILES = [
  'packages/server/package.json', // narrowed: pins yjs / pg / @hocuspocus/*
  'packages/web/package.json', // narrowed: pins yjs + the client sync deps
  'e2e/package.json', // narrowed: pins @playwright/test (multi-context harness)
  '.flox/env/manifest.toml', // pins the Node toolchain (hashed wholesale)
];

/** A package.json dependency can move sync / relay / multi-context-harness
 *  behavior ONLY if it's one of these — the Yjs core + protocols, the
 *  syncedStore glue, the relay's Postgres + websocket, and the Playwright
 *  harness. A bump to ANY other dep (a video/audio/UI lib like butterchurn)
 *  must NOT drift the collab hash. An omission here is non-fatal: the nightly
 *  full @collab lane (collab-nightly.yml) is the backstop for a real regression
 *  from a dep that isn't listed. Keep generous. */
export const COLLAB_DEP_ALLOW: RegExp[] = [
  /^@hocuspocus\//,
  /^yjs$/, /^y-/, /^lib0$/, // Yjs core + protocols (y-protocols, y-websocket, …)
  /^@syncedstore\//, /^syncedstore$/, // client store glue
  /^pg$/, // relay snapshot persistence
  /^ws$/, // relay websocket transport
  /^@playwright\/test$/, // the multi-context @collab harness
];

/** Is this basis entry a package.json toolchain pin (→ narrow-hashed by deps)? */
function isPackageJsonPin(rel: string): boolean {
  return TOOLCHAIN_PIN_FILES.includes(rel) && rel.endsWith('package.json');
}

/** Deterministic digest of ONLY the collab-relevant deps (COLLAB_DEP_ALLOW) in
 *  a package.json's dependencies + devDependencies — sorted `name@range` lines.
 *  Used in place of the whole file in the content hash so a collab-irrelevant
 *  dep change can't drift it. Exported for the basis guard test. */
export function collabDepDigest(pkgRel: string, read: BasisReader = readBasisFile): string {
  const raw = JSON.parse(read(pkgRel)) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...(raw.dependencies ?? {}), ...(raw.devDependencies ?? {}) };
  return Object.keys(all)
    .filter((name) => COLLAB_DEP_ALLOW.some((re) => re.test(name)))
    .sort()
    .map((name) => `${name}@${all[name]}`)
    .join('\n');
}

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
 *  feed `<repo-relative-path>\0<CODE>` into one sha256.
 *
 *  CODE, not bytes. Every source/spec file goes through the SHARED normalizer
 *  (`scripts/attest-code-basis.ts`): a TypeScript AST re-emit that drops
 *  comments, the living-docs `docs`/`controlFamilies`/`face` def properties and
 *  type-only imports. **This closes the asymmetry that WAS the bug**: the docs
 *  escape hatch used to live in webgl-attest-lib and nowhere else, while
 *  COLLAB_DIR_ROOTS hashes ALL of packages/server/src + lib/multiplayer
 *  wholesale — so two pure COMMENT lines flipped the collab hash and demanded a
 *  full relay re-attest (#1422). A comment cannot change how the relay
 *  converges, so the hash is now blind to it by construction.
 *
 *  package.json toolchain pins keep their NARROWER treatment — only the
 *  collab-relevant deps (collabDepDigest) — so a collab-irrelevant dep bump
 *  (e.g. a video lib like butterchurn, #939) can't drift the hash. `.sql`
 *  schema and `.flox/env/manifest.toml` are hashed by raw bytes (outside the
 *  normalizer's scope — over-invalidation is the safe direction). */
export function computeCollabHash(read: BasisReader = readBasisFile): string {
  const h = createHash('sha256');
  for (const rel of resolveCollabBasis()) {
    h.update(rel);
    h.update('\0');
    if (isPackageJsonPin(rel)) {
      h.update(collabDepDigest(rel, read));
    } else {
      h.update(normalizeForHash(rel, read(rel)));
    }
  }
  return h.digest('hex');
}

/** The default basis reader: repo-relative path → file text. */
export function readBasisFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

// -------------------------------------------------------------------------
// Skip classifier — THE meaningful-gate guard. DENY BY DEFAULT.
// -------------------------------------------------------------------------
//
// ⚠ THIS CLASSIFIER USED TO ALLOW BY DEFAULT, AND THAT MADE THE GATE BLIND.
//
// The shape was `isRelayVacuitySkip(reason) ? vacuity : benign`, i.e. a skip
// was filed as a benign "asset skip" — reported, never refused — unless its
// reason contained one of ELEVEN hard-coded substrings. So the set of skips
// that could poison an attestation was a hand-maintained ALLOW-LIST of failure
// phrasings, and every skip reason nobody thought of was waved through.
//
// What that was actually letting past, MEASURED 2026-08-13 on this tree:
//
//   • FOUR @collab DOOM specs (doom-launch:208, doom-identity-crossview:215,
//     doom-late-join:207, doom-multiplayer:173) carry
//     `test.skip(true, 'DOOM runtime failed to load on A within 25s')`.
//     That reason matches no marker → "benign asset skip". A run in which all
//     four DOOM multiplayer specs never loaded a runtime and skipped their
//     entire bodies reported `passed=48 … asset skips=4` and MINTED AN
//     ATTESTATION. The DOOM 2-user gate is the single most expensive thing the
//     @collab lane exists to prove, and it could be absent from a green run.
//
//   • `in-card-title.spec.ts`'s `test.fixme` (a QUARANTINE, #565) reports as a
//     skip with an EMPTY reason. Empty matches no marker → "benign asset skip".
//     Every attestation ever minted carries `asset skips=1` for it — the
//     summary line has been telling operators a quarantined @collab sync test
//     is a missing ROM.
//
// A gate whose green run looks identical whether DOOM ran or not is not a gate.
// So the polarity is inverted here: a skip is benign ONLY if a NAMED entry
// claims it, carrying the exact (spec, reason, why) triple. Everything else —
// an unrecognised reason, an empty reason, a runtime-load failure, a phrasing
// nobody predicted — POISONS the attestation. `RELAY_VACUITY_MARKERS` survives,
// but its job is now to NAME the diagnosis in the refusal message, not to be
// the only thing that can refuse.
//
// WHAT THIS STILL CANNOT SEE (stated inside the gate, per the blind-gates
// rule): a test that PASSES while asserting nothing. Skip classification says
// nothing about assertion strength — only that a body which did not run cannot
// be reported as if it had.

/** Substrings that NAME a skip as RELAY/SYNC VACUITY. Case-insensitive. These
 *  no longer decide refusal on their own (everything unnamed refuses too) —
 *  they sharpen the refusal message from "unclassified" to "the relay did not
 *  converge", which are different things to go and fix. */
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

/** True iff a skip reason NAMES relay/sync vacuity. Note this is no longer the
 *  refusal predicate — see `classifySkip`. A reason returning false here is NOT
 *  thereby benign; it is merely not diagnosed as a relay stall. */
export function isRelayVacuitySkip(reason: string): boolean {
  const r = (reason || '').toLowerCase();
  return RELAY_VACUITY_MARKERS.some((m) => r.includes(m));
}

/** A NAMED benign skip. One entry per instance — never a bare filename, so a
 *  NEW skip appearing in an already-listed spec still refuses. */
export interface BenignSkipRule {
  /** Spec basename under `e2e/tests/`. Anchored: the basis guard fails if this
   *  file does not exist, or is not in the @collab lane's own spec set, so a
   *  stale entry naming something that no longer runs is RED rather than inert. */
  spec: string;
  /** The reason this rule claims. `''` matches an EMPTY reason ONLY (a
   *  `test.fixme`), never "any reason"; otherwise a case-insensitive substring. */
  reason: string;
  /** Why a run carrying this skip still proves what the attestation claims.
   *  REQUIRED BY THE TYPE — `tsc` refuses an entry that does not answer it,
   *  before any test runs. */
  why: string;
}

/** The complete set of skips a green attestation may carry. Deny by default:
 *  anything not matched here refuses, including reasons nobody has written yet. */
export const BENIGN_SKIPS: readonly BenignSkipRule[] = [
  {
    spec: 'in-card-title.spec.ts',
    reason: '',
    why:
      'A `test.fixme` QUARANTINE (#565), not an environmental skip: the peer ' +
      'rename-sync case times out at its 120s budget on CI. It is named here so ' +
      'the summary stops calling a quarantined @collab test a missing asset, and ' +
      'so it is the ONE skip an operator has to argue with rather than a number. ' +
      'It does not weaken the attestation because no other spec covers it — it is ' +
      'simply not covered, and saying so out loud is the point.',
  },
];

/** How a skip is dispositioned. Both non-benign verdicts REFUSE. */
export type SkipVerdict = 'benign' | 'vacuity' | 'unclassified';

/** Classify one skip. `specFile` is matched on basename so a report path
 *  (`tests/foo.spec.ts`) and a repo path (`e2e/tests/foo.spec.ts`) agree. */
export function classifySkip(
  specFile: string,
  reason: string,
): { verdict: SkipVerdict; rule?: BenignSkipRule } {
  const base = (specFile || '').split('/').pop() ?? '';
  const r = (reason || '').trim();
  for (const rule of BENIGN_SKIPS) {
    if (rule.spec !== base) continue;
    const matched =
      rule.reason === '' ? r === '' : r.toLowerCase().includes(rule.reason.toLowerCase());
    if (matched) return { verdict: 'benign', rule };
  }
  if (isRelayVacuitySkip(r)) return { verdict: 'vacuity' };
  return { verdict: 'unclassified' };
}
