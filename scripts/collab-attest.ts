// scripts/collab-attest.ts
//
// The LOCAL @collab attestation RUNNER + WRITER (invoked by `task collab:attest`
// via scripts/collab-attest.sh). The collab analogue of scripts/webgl-attest.ts.
//
// WHY THIS EXISTS (full rationale in .myrobots/plans/collab-attest-2026-06-15.md
// and ci-collab-attest/README.md): the @collab CI lane is ~6.5-8 min and FLAKY —
// the in-memory Hocuspocus relay buckles under CI's 10-parallel-shard contention,
// so it's INFORMATIONAL (un-gated since 2026-06-06) and the DOOM-MP specs
// `test.skip(true,'…relay flake…')` → green-but-vacuous. LOCALLY you CONTROL the
// relay: a fresh, dedicated relay + DB with ZERO shard contention behaves
// reliably. So we run @collab where the relay actually works, pin a content hash,
// and CI gates on a cheap ~2-min VERIFY of the committed attestation.
//
// THE MEANINGFUL-GATE GUARD (the whole point): a @collab spec that SKIPS
// LOCALLY produced a VACUOUS run — it proved nothing about multiplayer. On a
// fresh dedicated relay that MUST NOT happen, so the runner treats ANY skip as a
// HARD FAILURE unless a NAMED `BENIGN_SKIPS` rule claims it (deny by default —
// see the classifier header in collab-attest-lib.ts for the four DOOM
// runtime-load skips and the `test.fixme` quarantine the old allow-by-default
// shape was minting straight through). It also pre-flights the DOOM/SNES assets
// so asset skips don't fire, and REFUSES if the DB or relay are not actually up
// (the @collab lane is VACUOUS without a real DB).
//
// On a fully-green run (every @collab spec genuinely passed, ZERO unnamed
// skips, DB + relay confirmed), writes ci-collab-attest/<hash>.json with the
// metadata + measured pass/skip summary. On ANY failure/flake/vacuity: writes
// nothing, exits non-zero. Does NOT auto-commit (the commit is the
// contributor's explicit act). retries=0 to surface flakes honestly; REPEAT=N →
// repeat-each (the 3x pre-MR flake-check).

import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, hostname, release, arch } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

import {
  REPO_ROOT,
  COLLAB_GREP,
  computeCollabHash,
  resolveCollabSpecs,
  classifySkip,
} from './collab-attest-lib';
import { bootOwnAppServer, assertServerIsThisWorktree, type OwnAppServer } from './worktree-identity';

const REPEAT = Math.max(1, parseInt(process.env.REPEAT || '1', 10) || 1);
const DRY = process.argv.includes('--dry-run'); // verify the mechanism w/o the long run
// retries=0 by default: a transient relay/sync stall under a FRESH dedicated
// relay is exactly the signal we must NOT mask (no-flake-tolerance). REPEAT>1
// (the 3x pre-MR flake-check) forces 0. Override with COLLAB_ATTEST_RETRIES only
// if a genuinely-environmental cold-WASM hiccup is diagnosed (it should not be a
// relay issue locally).
const RETRIES = REPEAT > 1 ? 0 : Math.max(0, parseInt(process.env.COLLAB_ATTEST_RETRIES || '0', 10) || 0);

const RELAY_PORT = Number(process.env.PORT || 1235);
// The app server is no longer the config-managed `vite preview` on the SHARED
// port 4173 (#1597: reuseExistingServer there could adopt a SIBLING WORKTREE'S
// preview and attest this tree's hash against that tree's bundle). The runner
// now boots ITS OWN preview server on a per-run ephemeral port and
// identity-verifies it (GET /__worktree) — see bootOwnAppServer in main().

interface RunSummary {
  specFiles: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  relayVacuitySkips: { spec: string; title: string; reason: string }[];
  /** Skips matching NO named benign rule. Deny-by-default: these REFUSE, exactly
   *  like a relay-vacuity skip, because a body that did not run cannot back an
   *  attestation that says it did. */
  unclassifiedSkips: { spec: string; title: string; reason: string }[];
  /** Skips claimed by a NAMED `BENIGN_SKIPS` rule — reported with their `why`,
   *  never silently. (Was `assetSkips`: an allow-by-default bucket that swallowed
   *  every unpredicted reason, including a `test.fixme` quarantine and four DOOM
   *  runtime-load failures. See the classifier header in collab-attest-lib.ts.) */
  benignSkips: { spec: string; title: string; reason: string; why: string }[];
}

interface PwSuite {
  specs?: {
    file?: string;
    title?: string;
    tests?: {
      status?: string;
      results?: { status?: string }[];
      annotations?: { type?: string; description?: string }[];
    }[];
  }[];
  suites?: PwSuite[];
}

/** TCP probe: resolve true iff something accepts a connection on host:port. */
function tcpUp(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

async function waitForTcp(host: string, port: number, totalMs: number, label: string): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await tcpUp(host, port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label}: nothing listening on ${host}:${port} after ${totalMs}ms`);
}

/** Kill any process already bound to the relay port so we boot a FRESH relay
 *  (a stale relay from a prior run could be carrying stale slot/doc state). */
function freeRelayPort() {
  try {
    const pids = execSync(`lsof -ti tcp:${RELAY_PORT} || true`, { encoding: 'utf8' }).trim();
    if (pids) {
      console.log(`Freeing relay port ${RELAY_PORT} (killing pid(s): ${pids.replace(/\n/g, ' ')})`);
      for (const pid of pids.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* lsof not present or nothing bound — fine */
  }
}

/** Assert a REAL Postgres is configured + reachable. The @collab lane is
 *  VACUOUS without a DB (the relay's auth/membership/persistence gates run real
 *  SQL); an in-memory fallback would let a hand-wavy run "pass". */
function assertDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is unset. The @collab lane is VACUOUS without a real Postgres ' +
        '(the relay auth/membership/persistence gates run real SQL). Start a local ' +
        "Postgres and export DATABASE_URL, e.g.:\n" +
        '  export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/patchtogether_test\n' +
        '  flox activate -- psql "$DATABASE_URL" -f db/schema/001_init.sql',
    );
  }
  // Probe it for real (and apply the schema — idempotent CREATE TABLE IF NOT
  // EXISTS in 001_init.sql).
  try {
    execFileSync('psql', [url, '-c', 'SELECT 1'], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(
      `DATABASE_URL is set but Postgres is not reachable (psql SELECT 1 failed): ${(e as Error).message}\n` +
        'Bring up the DB before attesting — a non-reachable DB makes the @collab run vacuous.',
    );
  }
  // Apply the schema WITHOUT ON_ERROR_STOP — the schema uses bare CREATE TABLE
  // (CI applies it once to a fresh per-job DB), so re-applying to an existing
  // local DB raises "relation already exists". That is benign for our purpose
  // (the tables we need exist); a genuinely missing/broken schema still surfaces
  // when the relay's SQL gates fail during the run. Mirrors ci.yml's plain
  // `psql -f` (no ON_ERROR_STOP).
  for (const schema of ['db/schema/001_init.sql', 'db/schema/003_saved_groups.sql']) {
    const p = join(REPO_ROOT, schema);
    if (existsSync(p)) {
      try {
        execFileSync('psql', [url, '-f', p], { stdio: 'pipe' });
      } catch {
        // Tolerate "already exists" on a re-run; the relay's runtime SQL is the
        // real check that the schema is usable.
      }
    }
  }
  // Assert the core table the relay needs actually exists now (a real
  // schema-missing case must still fail the attest, not be silently swallowed
  // by the tolerant apply above).
  let racksPresent = '';
  try {
    racksPresent = execFileSync(
      'psql',
      [url, '-tAc', "SELECT to_regclass('public.racks') IS NOT NULL"],
      { encoding: 'utf8' },
    ).trim();
  } catch (e) {
    throw new Error(`Schema verification query failed: ${(e as Error).message}`);
  }
  if (racksPresent !== 't') {
    throw new Error(
      'DB schema not applied (table "racks" is absent after psql -f). ' +
        'Apply it manually: psql "$DATABASE_URL" -f db/schema/001_init.sql',
    );
  }
  console.log(`Database OK (schema applied): ${url.replace(/:[^:@/]*@/, ':***@')}`);
  return url;
}

/** Pre-flight the DOOM/SNES assets the @collab DOOM specs need, so the benign
 *  asset-skips (DOOM WASM / DOOM1.WAD missing) do NOT fire and leave us with a
 *  vacuous DOOM-MP lane. Builds the WASM + fetches the shareware WAD if absent,
 *  the same way ci.yml's collab job does. Warns (does not hard-fail) if a tool
 *  is missing — the runner still asserts no relay-vacuity, and DOOM-asset skips
 *  are reported in the summary. */
function preflightAssets() {
  if (DRY) return;
  // (a) The web PREVIEW bundle. We run @collab against `vite preview` (built
  //     bundle) like the CI collab job — kills the HMR-reload flake class
  //     (#232/#225). `vite preview` needs a prior `vite build`, and the DOOM/WAD
  //     static assets must be present at BUILD time so they're baked into the
  //     served bundle — so build the WASM/WAD FIRST (below), then the bundle.
  const doomWasm = join(REPO_ROOT, 'packages/web/static/doom/doom.wasm');
  const doomWad = join(REPO_ROOT, 'packages/web/static/doom/DOOM1.WAD');
  if (!existsSync(doomWasm)) {
    console.log('DOOM WASM absent — building (build-doom-wasm.sh)…');
    try {
      execFileSync('bash', ['packages/web/native/build-doom-wasm.sh'], { cwd: REPO_ROOT, stdio: 'inherit' });
    } catch (e) {
      console.warn(`⚠ DOOM WASM build failed (${(e as Error).message}) — DOOM-MP specs may asset-skip.`);
    }
  }
  if (!existsSync(doomWad)) {
    console.log('DOOM1.WAD absent — fetching shareware WAD…');
    try {
      execFileSync(
        'bash',
        [
          '-c',
          'curl -L --fail --silent --show-error -o packages/web/static/doom/DOOM1.WAD ' +
            'https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad',
        ],
        { cwd: REPO_ROOT, stdio: 'inherit' },
      );
    } catch (e) {
      console.warn(`⚠ DOOM1.WAD fetch failed (${(e as Error).message}) — DOOM-MP specs may asset-skip.`);
    }
  }
  // (b) Build the preview bundle (after the DOOM/WAD assets exist so they're
  //     baked in). The runner's OWN preview server (bootOwnAppServer, #1597)
  //     serves this bundle on a per-run ephemeral port. We
  //     are already inside `flox activate` (invoked via task collab:attest), so
  //     the toolchain is on PATH — build directly. CRITICAL: VITE_E2E_HOOKS=1
  //     bakes in the test hooks the @collab specs need (window.__attachProvider,
  //     etc.) — without it, every spec hangs on waitForFunction(__attachProvider)
  //     and the run is uselessly red (matches ci.yml's build-web step env).
  console.log('Building web preview bundle (vite build, VITE_E2E_HOOKS=1) for the @collab preview run…');
  execFileSync('npm', ['run', 'build', '-w', 'packages/web'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_E2E_HOOKS: '1' },
  });
}

/** Boot the dedicated Hocuspocus relay as a child (fresh, this-worktree
 *  sources via `npm run dev -w packages/server`) and wait for the port. Returns
 *  the child so main can tear it down. Playwright's own webServer config would
 *  also boot one, but we boot + assert it OURSELVES first so the runner can
 *  REFUSE before paying for the full Playwright run if the relay can't come up. */
function bootRelay(databaseUrl: string): ChildProcess {
  freeRelayPort();
  console.log(`Booting dedicated relay on ws://localhost:${RELAY_PORT} …`);
  const child = spawn('npm', ['run', 'dev', '-w', 'packages/server'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(RELAY_PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`Relay process exited early with code ${code}`);
  });
  return child;
}

/** Run the @collab specs once with the JSON reporter to a temp file → summary.
 *  Throws on a non-zero exit OR any failure/flaky OR any RELAY-VACUITY skip.
 *  `appUrl` is the runner's OWN identity-verified preview server (#1597) —
 *  E2E_SKIP_WEBSERVER=1 keeps the config's reuse-happy webServer out entirely
 *  (the relay is ours too, booted by bootRelay on RELAY_PORT). */
function runCollab(appUrl: string | null): RunSummary {
  const tmp = mkdtempSync(join(tmpdir(), 'collab-attest-'));
  const jsonOut = join(tmp, 'report.json');
  const env: Record<string, string | undefined> = {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut,
    // Run against `vite preview` (built bundle) like the CI collab job — kills
    // the HMR-reload flake class (#232/#225) and lowers CPU pressure. The
    // bundle is served by OUR OWN preview server (appUrl), never a reused one.
    E2E_USE_PREVIEW: '1',
    ...(appUrl ? { E2E_BASE_URL: appUrl, E2E_SKIP_WEBSERVER: '1' } : {}),
    // Opt the COLLAB_JOB-gated specs IN (they guard `process.env.CI &&
    // !process.env.COLLAB_JOB`). We are NOT CI, so they'd run anyway, but setting
    // it makes the local run identical to the dedicated CI collab lane.
    COLLAB_JOB: '1',
  };
  const args = [
    '--workspace',
    'e2e',
    'playwright',
    'test',
    '--grep',
    COLLAB_GREP,
    '--workers=2', // mirrors `task collab` / the CI collab lane
    '--reporter=json',
    `--retries=${RETRIES}`,
    ...(REPEAT > 1 ? [`--repeat-each=${REPEAT}`] : []),
  ];

  console.log(`\n=== Running @collab specs ===`);
  console.log(`  npx ${args.join(' ')}`);

  if (DRY) {
    console.log('  [--dry-run] skipping the actual Playwright run; mechanism only.');
    return {
      specFiles: resolveCollabSpecs().length,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      relayVacuitySkips: [],
      unclassifiedSkips: [],
      benignSkips: [],
    };
  }

  let runExit = 0;
  try {
    execFileSync('npx', args, { cwd: REPO_ROOT, env, stdio: 'inherit' });
  } catch {
    runExit = 1; // non-zero = at least one failure; we still parse JSON for detail
  }

  if (!existsSync(jsonOut)) {
    throw new Error(`No JSON report at ${jsonOut} (Playwright did not run?)`);
  }
  const report = JSON.parse(readFileSync(jsonOut, 'utf8'));
  const summary = summarize(report);
  rmSync(tmp, { recursive: true, force: true });

  console.log(
    `\n  → spec files: ${summary.specFiles} | passed=${summary.passed} failed=${summary.failed} ` +
      `flaky=${summary.flaky} skipped=${summary.skipped} ` +
      `(relay-vacuity=${summary.relayVacuitySkips.length}, unclassified=${summary.unclassifiedSkips.length}, ` +
      `named-benign=${summary.benignSkips.length})`,
  );

  // (a) Hard fail on any failure.
  if (runExit !== 0 || summary.failed > 0) {
    throw new Error(`${summary.failed} @collab test(s) failed (all ${RETRIES} retries) — attestation refused.`);
  }
  // (b) Flaky handling — mirrors scripts/webgl-attest.ts's RETRIES rationale.
  //     With retries=0 (the strict DEFAULT), a flaky result is a genuine flake to
  //     root-cause → REFUSE. With retries>0 (the COLLAB_ATTEST_RETRIES escape
  //     hatch, set deliberately on a loaded host), a "flaky" test PASSED on retry
  //     — on a FRESH dedicated relay that is a HOST-saturation transient (the
  //     browserContext.close()/2-context teardown timeout class under load), NOT
  //     a relay/sync flake (a relay-sync flake surfaces as a VACUITY SKIP, caught
  //     in (c), never as a recovered pass). Log it transparently (the count lands
  //     in the attestation JSON so a creeping rate is visible) but do NOT refuse.
  if (summary.flaky > 0) {
    if (RETRIES === 0) {
      throw new Error(
        `${summary.flaky} @collab test(s) were flaky on a FRESH dedicated relay (retries=0) — root-cause it; attestation refused.`,
      );
    }
    console.log(
      `  ⚠ ${summary.flaky} test(s) recovered on retry (host-saturation transient under load, retries=${RETRIES}) — ` +
        `recorded in run.flaky. NOT a relay-vacuity skip (those refuse). Prefer an idle machine for retries=0.`,
    );
  }
  // (c) THE meaningful-gate guard: any RELAY-VACUITY skip means the local run
  //     proved nothing about multiplayer → refuse.
  if (summary.relayVacuitySkips.length > 0) {
    const lines = summary.relayVacuitySkips
      .map((s) => `    - ${s.spec} › ${s.title}: "${s.reason}"`)
      .join('\n');
    throw new Error(
      `${summary.relayVacuitySkips.length} @collab test(s) SKIPPED for a relay/sync-vacuity reason on a FRESH\n` +
        `dedicated relay — the run is VACUOUS (it proved nothing about multiplayer):\n${lines}\n` +
        `On a calm local relay these MUST converge. Diagnose the sync stall; attestation refused.`,
    );
  }
  // (c2) DENY BY DEFAULT: a skip that no NAMED rule claims refuses too. This is
  //      the leg that was missing — see the classifier header in
  //      collab-attest-lib.ts for what it was letting through (four DOOM
  //      runtime-load skips and a `test.fixme` quarantine, all filed as "benign
  //      asset skips" and minted). If the skip is legitimately harmless, it gets
  //      an entry with its own `why`; it does not get to be a number.
  if (summary.unclassifiedSkips.length > 0) {
    const lines = summary.unclassifiedSkips
      .map((s) => `    - ${s.spec} › ${s.title}: "${s.reason || '(no reason given — a test.skip()/test.fixme with no description)'}"`)
      .join('\n');
    throw new Error(
      `${summary.unclassifiedSkips.length} @collab test(s) SKIPPED for a reason no BENIGN_SKIPS rule claims:\n${lines}\n` +
        `A skipped body proves nothing, so the run cannot back an attestation that says it ran.\n` +
        `Either fix what made it skip, or — if the skip genuinely does not weaken the\n` +
        `attestation — add a NAMED { spec, reason, why } entry to BENIGN_SKIPS in\n` +
        `scripts/collab-attest-lib.ts. Attestation refused.`,
    );
  }
  // (d) Report the NAMED benign skips loudly, each with the `why` that justifies
  //     it. These are the only skips a green attestation may carry, and an
  //     operator should have to read the argument every time.
  if (summary.benignSkips.length > 0) {
    console.log(`  ⚠ ${summary.benignSkips.length} NAMED benign skip(s) — the attestation does NOT cover these:`);
    for (const s of summary.benignSkips) {
      console.log(`     - ${s.spec} › ${s.title}: "${s.reason || '(no reason given)'}"`);
      console.log(`       why: ${s.why}`);
    }
  }
  // (e) Sanity: SOMETHING must have genuinely passed (a 0-passed run is vacuous).
  if (summary.passed === 0) {
    throw new Error('Zero @collab tests passed — the run is vacuous; attestation refused.');
  }
  return summary;
}

/** Walk the Playwright JSON report → counts + classified skips. A test that
 *  `test.skip(true, reason)`s gets status 'skipped' and an annotation
 *  `{ type: 'skip', description: reason }`. We classify each skip's reason via
 *  the shared isRelayVacuitySkip() so the runner and the basis guard agree. */
function summarize(report: { suites?: PwSuite[] }): RunSummary {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  const specFiles = new Set<string>();
  const relayVacuitySkips: RunSummary['relayVacuitySkips'] = [];
  const unclassifiedSkips: RunSummary['unclassifiedSkips'] = [];
  const benignSkips: RunSummary['benignSkips'] = [];

  const visit = (suite: PwSuite) => {
    for (const spec of suite.specs ?? []) {
      if (spec.file) specFiles.add(spec.file);
      for (const test of spec.tests ?? []) {
        const status = test.status; // 'expected' | 'unexpected' | 'flaky' | 'skipped'
        if (status === 'expected') passed++;
        else if (status === 'unexpected') failed++;
        else if (status === 'flaky') flaky++;
        else if (status === 'skipped') {
          skipped++;
          const reason =
            (test.annotations ?? []).find((a) => a.type === 'skip')?.description ?? '';
          const entry = { spec: spec.file ?? '?', title: spec.title ?? '?', reason };
          const { verdict, rule } = classifySkip(entry.spec, reason);
          if (verdict === 'benign') benignSkips.push({ ...entry, why: rule!.why });
          else if (verdict === 'vacuity') relayVacuitySkips.push(entry);
          else unclassifiedSkips.push(entry);
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const s of report.suites ?? []) visit(s);
  return {
    specFiles: specFiles.size,
    passed,
    failed,
    flaky,
    skipped,
    relayVacuitySkips,
    unclassifiedSkips,
    benignSkips,
  };
}

function playwrightVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'e2e/node_modules/@playwright/test/package.json'), 'utf8'),
    );
    return pkg.version || '?';
  } catch {
    try {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'e2e/package.json'), 'utf8'));
      return (pkg.devDependencies?.['@playwright/test'] || '?').replace(/^[\^~]/, '');
    } catch {
      return '?';
    }
  }
}

function hocuspocusVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/server/package.json'), 'utf8'));
    return (pkg.dependencies?.['@hocuspocus/server'] || '?').replace(/^[\^~]/, '');
  } catch {
    return '?';
  }
}

function gitHead(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
// PSEUDONYMOUS BY DESIGN. These attestations are COMMITTED to a public repo,
// so they must not publish a personal email or a machine hostname. The verifier
// only ECHOES these two fields in a log line — the sanity gate is `gpu`
// (SwiftShader is rejected) — so a stable pseudonym costs nothing and the
// scripts' own comment already says every field is hand-writable, not security.
function attestActor(): string {
  // Stable, non-identifying. Was `git config user.email`.
  return 'patchtogether-maintainer';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  // (1) Compute the content hash up front.
  const hash = computeCollabHash();
  console.log(`@collab content hash: ${hash}`);

  // (2) Assert a REAL DB (the lane is vacuous without one) + apply the schema.
  const databaseUrl = DRY ? (process.env.DATABASE_URL ?? '(dry-run: db not checked)') : assertDatabase();

  // (3) Pre-flight DOOM/SNES assets so benign asset-skips don't fire.
  preflightAssets();

  // (4) Boot a FRESH dedicated relay + ASSERT it's actually up before we pay for
  //     the full Playwright run. (E2E_SKIP_WEBSERVER=1 keeps Playwright's own
  //     webServer config out of the picture entirely — both servers are ours.)
  let relay: ChildProcess | undefined;
  let relayUp = false;
  let appServer: OwnAppServer | undefined;
  try {
    if (!DRY) {
      relay = bootRelay(databaseUrl as string);
      await waitForTcp('127.0.0.1', RELAY_PORT, 60_000, 'relay');
      relayUp = true;
      console.log(`Relay confirmed up on ws://localhost:${RELAY_PORT}.`);

      // (4b) Boot OUR OWN preview server for the bundle preflightAssets just
      // built, on a per-run ephemeral port, and identity-verify it (#1597).
      // Never the config's shared-port webServer, whose reuseExistingServer
      // could adopt a sibling worktree's preview and attest the wrong app.
      appServer = await bootOwnAppServer({ repoRoot: REPO_ROOT, mode: 'preview', context: 'collab:attest' });
    }

    const startedAt = Date.now();
    const summary = runCollab(appServer?.url ?? null);
    const durationSec = Math.round((Date.now() - startedAt) / 1000);

    if (DRY) {
      console.log('\n[--dry-run] Mechanism wired OK (DB/relay/asset checks + run + classify). NOT writing an attestation.');
      return;
    }

    // (5a) RE-VERIFY the app server's identity immediately before writing — a
    // green run only backs an attestation if the bundle that served it is
    // still, provably, THIS worktree's (#1597).
    if (appServer) {
      await assertServerIsThisWorktree(appServer.url, REPO_ROOT, 'collab:attest(pre-write)');
    }

    // (5) Write the attestation — green, zero relay-vacuity, DB + relay confirmed.
    const attestation = {
      schemaVersion: 1,
      collabContentHash: hash,
      attestedAt: new Date().toISOString(),
      attestedBy: attestActor(),
      gitHeadAtAttest: gitHead(), // INFORMATIONAL only — NOT the match key
      playwrightVersion: playwrightVersion(),
      hocuspocusVersion: hocuspocusVersion(),
      os: `${process.platform} ${release()} (${arch()})`,
      machineClass: 'local-trusted-gpu-workstation', // was hostname()
      databaseConfirmed: true,
      relayConfirmed: relayUp,
      relayPort: RELAY_PORT,
      // The runner's OWN identity-verified preview server (#1597) — per-run
      // ephemeral port; root/commit re-verified at write time.
      appServer: appServer
        ? { url: appServer.url, mode: appServer.mode, root: appServer.identity.root, commit: appServer.identity.commit }
        : undefined,
      repeatEach: REPEAT,
      retries: RETRIES,
      run: {
        specFiles: summary.specFiles,
        passed: summary.passed,
        failed: summary.failed,
        flaky: summary.flaky,
        skipped: summary.skipped,
        relayVacuitySkips: summary.relayVacuitySkips.length,
        unclassifiedSkips: summary.unclassifiedSkips.length,
        // Each entry names the spec + the rule that claims it, so an
        // attestation records WHAT a green run did not cover — not just how many.
        namedBenignSkips: summary.benignSkips.map((s) => ({ spec: s.spec, title: s.title })),
      },
      durationSec,
    };

    const outFile = join(REPO_ROOT, 'ci-collab-attest', `${hash}.json`);
    writeFileSync(outFile, JSON.stringify(attestation, null, 2) + '\n');
    console.log(`\nAttested ${hash}.`);
    console.log(`  ${summary.passed} @collab tests passed on a fresh dedicated relay+DB, 0 relay-vacuity skips.`);
    console.log(`Wrote ci-collab-attest/${hash}.json`);
    console.log(`Now:  git add ci-collab-attest/${hash}.json  and commit it with your PR.`);
  } finally {
    if (appServer) {
      console.log('Tearing down the attest-owned app preview server…');
      appServer.stop();
    }
    if (relay && !relay.killed) {
      console.log('Tearing down the dedicated relay…');
      relay.kill('SIGTERM');
    }
  }
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
