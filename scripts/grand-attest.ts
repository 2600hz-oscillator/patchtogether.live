// scripts/grand-attest.ts
//
// The LOCAL heavy GRAND-INTEGRATION attestation RUNNER + WRITER (invoked by
// `task grand:attest` via scripts/grand-attest.sh). The grand analogue of
// scripts/webgl-attest.ts + scripts/collab-attest.ts.
//
// WHY THIS EXISTS (full rationale in the plan + ci-grand-attest/README.md): the
// full workflow-mode scenario drives TWO CI-hostile workloads at once — a real
// GPU (SYNESTHESIA is WebGL; SwiftShader can't fairly render it) AND a real H.264
// encoder (RECORDERBOX; CI has no OS/hardware encoder and the software one lies).
// So the heavy scenario NEVER runs on CI. LOCALLY, on a trusted GPU machine, it
// runs for real: real synesthesia band reaction, real recorderbox capture, the
// real clip-player scheduler + real automation record/playback, per-instrument
// RMS via the master mixer's post-fader taps. On a fully-green run the runner
// (a) REGENERATES + reads the offline combined-master ART `.sha` (so the pinned
// deterministic audio and the live run stay in agreement), and (b) writes
// ci-grand-attest/<hash>.json. CI then verifies that pin cheaply.
//
// On ANY failure/flake/skip: writes nothing, exits non-zero. Does NOT auto-commit
// (the commit is the contributor's explicit act). retries=0 to surface flakes
// honestly; REPEAT=N → repeat-each (the 3× pre-MR flake-check).

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, hostname, release, arch } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT, GRAND_GREP, computeGrandHash } from './grand-attest-lib';
import { bootOwnAppServer, assertServerIsThisWorktree, type OwnAppServer } from './worktree-identity';
import { preflightSolo, type CoTenantProfile } from './attest-preflight';

const REPEAT = Math.max(1, parseInt(process.env.REPEAT || '1', 10) || 1);
const DRY = process.argv.includes('--dry-run'); // verify the mechanism w/o the long real run
// retries=0 by default: a flake on a trusted quiet machine is exactly the signal
// we must NOT mask (no-flake-tolerance). REPEAT>1 forces 0. Override with
// GRAND_ATTEST_RETRIES only for a diagnosed environmental transient.
const RETRIES = REPEAT > 1 ? 0 : Math.max(0, parseInt(process.env.GRAND_ATTEST_RETRIES || '0', 10) || 0);

/** The offline combined-master baseline `.sha` the attestation records + the CI
 *  verify cross-checks (a belt to the content-hash suspenders). */
const BASELINE_SHA_REL = 'art/baselines/grand-integration/combined-master.sha';

interface RunSummary {
  specFiles: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

interface PwSuite {
  specs?: {
    file?: string;
    tests?: { status?: string }[];
  }[];
  suites?: PwSuite[];
}

// ---------------------------------------------------------------------------
// Pre-flight: refuse a NON-SOLO machine (the external-co-tenant GPU-contention
// transient class — lifted from webgl-attest's preflightSolo). Override on a
// dedicated/trusted runner with GRAND_ATTEST_ALLOW_BUSY=1.
// ---------------------------------------------------------------------------

/** Probe the real ANGLE renderer via a one-shot headless WebGL context and abort
 *  if it reports SwiftShader (lifted from webgl-attest). */
function probeRenderer(): string {
  if (DRY) return 'dry-run (renderer probe skipped)';
  try {
    const angleBackend = process.env.E2E_ANGLE_BACKEND || (process.platform === 'darwin' ? 'metal' : 'default');
    const probeScript = `
      const { chromium } = require('@playwright/test');
      (async () => {
        const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=${angleBackend}'] });
        const p = await b.newPage();
        const r = await p.evaluate(() => {
          const c = document.createElement('canvas');
          const gl = c.getContext('webgl2') || c.getContext('webgl');
          if (!gl) return 'no-webgl';
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        });
        await b.close();
        process.stdout.write(String(r));
      })().catch(e => { process.stdout.write('probe-error: ' + e.message); });
    `;
    const out = execFileSync('node', ['-e', probeScript], { cwd: join(REPO_ROOT, 'e2e'), encoding: 'utf8' }).trim();
    return out || 'unknown';
  } catch (e) {
    return `probe-failed (${(e as Error).message})`;
  }
}

/** Run the @grand-attest spec once with the JSON reporter to a temp file →
 *  summary. Throws on non-zero exit OR any failure/flaky/skip. */
function runGrand(): RunSummary {
  const tmp = mkdtempSync(join(tmpdir(), 'grand-attest-'));
  const jsonOut = join(tmp, 'report.json');
  const env: Record<string, string | undefined> = {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut,
    // Opt the heavy scenario IN. The spec `test.skip`s itself unless GRAND_ATTEST
    // is set, so it is inert in the normal e2e CI matrix (no playwright.config
    // edit needed — that file is in the collab+webgl bases) and runs ONLY here.
    GRAND_ATTEST: '1',
    // Real hardware GPU for synesthesia (config adds --use-gl=angle
    // --use-angle=metal on macOS; headless Chromium else falls back to
    // SwiftShader even on a real GPU).
    E2E_REAL_GPU: '1',
  };
  const args = [
    '--workspace',
    'e2e',
    'playwright',
    'test',
    '--grep',
    GRAND_GREP,
    // The scenario is one serial spec; workers=1 keeps the GPU quiet for it.
    '--workers=1',
    '--reporter=json',
    `--retries=${RETRIES}`,
    ...(REPEAT > 1 ? [`--repeat-each=${REPEAT}`] : []),
  ];

  console.log(`\n=== Running @grand-attest scenario ===`);
  console.log(`  npx ${args.join(' ')}`);

  if (DRY) {
    console.log('  [--dry-run] skipping the actual Playwright run; mechanism only.');
    return { specFiles: 1, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  }

  let runExit = 0;
  try {
    execFileSync('npx', args, { cwd: REPO_ROOT, env, stdio: 'inherit' });
  } catch {
    runExit = 1;
  }

  if (!existsSync(jsonOut)) {
    throw new Error(`No JSON report at ${jsonOut} (Playwright did not run?)`);
  }
  const report = JSON.parse(readFileSync(jsonOut, 'utf8'));
  const summary = summarize(report);
  rmSync(tmp, { recursive: true, force: true });

  console.log(
    `\n  → spec files: ${summary.specFiles} | passed=${summary.passed} failed=${summary.failed} ` +
      `flaky=${summary.flaky} skipped=${summary.skipped}`,
  );

  if (runExit !== 0 || summary.failed > 0) {
    throw new Error(`${summary.failed} @grand-attest test(s) failed (all ${RETRIES} retries) — attestation refused.`);
  }
  if (summary.flaky > 0) {
    throw new Error(
      `${summary.flaky} @grand-attest test(s) were flaky (retries=${RETRIES}) — root-cause the flake on a trusted quiet machine; attestation refused.`,
    );
  }
  if (summary.skipped > 0) {
    throw new Error(
      `${summary.skipped} @grand-attest test(s) SKIPPED on a trusted machine — the run is partly vacuous. A capability gate (e.g. H.264) should be TRUE here; diagnose it; attestation refused.`,
    );
  }
  if (summary.passed === 0) {
    throw new Error('Zero @grand-attest tests passed — the run is vacuous; attestation refused.');
  }
  return summary;
}

/** Walk the Playwright JSON report → counts. */
function summarize(report: { suites?: PwSuite[] }): RunSummary {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  const specFiles = new Set<string>();
  const visit = (suite: PwSuite) => {
    for (const spec of suite.specs ?? []) {
      if (spec.file) specFiles.add(spec.file);
      for (const test of spec.tests ?? []) {
        const status = test.status;
        if (status === 'expected') passed++;
        else if (status === 'unexpected') failed++;
        else if (status === 'flaky') flaky++;
        else if (status === 'skipped') skipped++;
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const s of report.suites ?? []) visit(s);
  return { specFiles: specFiles.size, passed, failed, flaky, skipped };
}

/** Regenerate the offline combined-master ART baseline (so the pinned
 *  deterministic audio reflects the attested source) and return its `.sha`. On a
 *  pure re-pin only the `.sha`/`.f32` under the grand-integration group move. */
function regenerateOfflineArt(): string {
  if (!DRY) {
    console.log('\nRegenerating the offline combined-master ART baseline (UPDATE_BASELINES=1)…');
    execFileSync('npm', ['exec', '-w', 'art', '--', 'vitest', 'run', '--config', 'vitest.config.ts', 'grand-integration'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, UPDATE_BASELINES: '1' },
    });
  }
  const shaPath = join(REPO_ROOT, BASELINE_SHA_REL);
  return existsSync(shaPath) ? readFileSync(shaPath, 'utf8').trim() : '';
}

function playwrightVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'e2e/node_modules/@playwright/test/package.json'), 'utf8'));
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
// The attest's OWN app server (#1597) — module-scoped so the exit/signal
// handlers can always tear it down (refusal paths process.exit() directly,
// which skips try/finally). stop() is synchronous.
let ownServer: OwnAppServer | undefined;
process.on('exit', () => ownServer?.stop());
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    ownServer?.stop();
    process.exit(130);
  });
}

async function main() {
  // (1) Refuse SwiftShader — the whole point is the real GPU (synesthesia).
  if (process.env.E2E_SWIFTSHADER === '1') {
    console.error('E2E_SWIFTSHADER=1 is set — a SwiftShader attestation would be a lie. Unset it and run on the real GPU.');
    process.exit(2);
  }
  // (1b) Refuse a contended machine — sampled ACROSS a window, never at one
  // instant (#1331). This used to be a SECOND copy of the guard carrying an
  // OLDER co-tenant regex (brand-only: no Discord / Slack / generic
  // "Helper (Renderer)"), i.e. blind to the exact 42.9% Electron renderer
  // webgl-cotenancy.ts was fixed for. One module now, one match list.
  let preflight: CoTenantProfile | null = null;
  if (!DRY) {
    preflight = preflightSolo({
      label: 'grand:attest',
      allowBusyEnv: 'GRAND_ATTEST_ALLOW_BUSY',
      busyCpuEnv: 'GRAND_ATTEST_BUSY_CPU',
      leaked: [],
    });
  }

  // (2) Compute the content hash up front.
  const hash = computeGrandHash();
  console.log(`grand-integration content hash: ${hash}`);

  // (3) Probe + assert a real GPU renderer.
  const renderer = probeRenderer();
  console.log(`Real renderer: ${renderer}`);
  if (!DRY && /swiftshader|software/i.test(renderer)) {
    console.error(`The active WebGL renderer reports SwiftShader/software ('${renderer}'). This machine cannot produce a real-GPU grand attestation. Abort.`);
    process.exit(2);
  }

  // (3b) BOOT OUR OWN APP SERVER (#1597) — never the config's reuse-happy
  // webServer on the shared default port, which could adopt a SIBLING
  // WORKTREE'S dev server and attest this tree's hash against that tree's app.
  // Fresh dev server, per-run ephemeral port, identity-verified via
  // GET /__worktree; E2E_BASE_URL + E2E_SKIP_WEBSERVER=1 point the scenario at
  // exactly it. The relay webServer is skipped too — the grand scenario is
  // solo workflow-mode (no provider attach).
  if (!DRY) {
    ownServer = await bootOwnAppServer({ repoRoot: REPO_ROOT, mode: 'dev', context: 'grand:attest' });
    process.env.E2E_BASE_URL = ownServer.url;
    process.env.E2E_SKIP_WEBSERVER = '1';
  }

  // (4) Run the heavy scenario.
  const startedAt = Date.now();
  const summary = runGrand();

  // (5) Regenerate + read the offline ART `.sha` (ties pinned audio to the run).
  const combinedMasterSha = regenerateOfflineArt();
  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  if (DRY) {
    console.log('\n[--dry-run] Mechanism wired OK (preflight + renderer probe + run + ART regen). NOT writing an attestation.');
    return;
  }

  // (6a) RE-VERIFY the server identity immediately before writing — a green
  // run only backs an attestation if the app that ran it is still, provably,
  // THIS worktree's (#1597).
  if (ownServer) {
    await assertServerIsThisWorktree(ownServer.url, REPO_ROOT, 'grand:attest(pre-write)');
  }

  // (6) Write the attestation.
  const attestation = {
    schemaVersion: 1,
    grandContentHash: hash,
    attestedAt: new Date().toISOString(),
    attestedBy: attestActor(),
    gitHeadAtAttest: gitHead(), // INFORMATIONAL only — NOT the match key
    playwrightVersion: playwrightVersion(),
    os: `${process.platform} ${release()} (${arch()})`,
    machineClass: 'local-trusted-gpu-workstation', // was hostname()
    // HOW QUIET THE MACHINE WAS (#1331) — see webgl-attest for the rationale.
    preflight: preflight
      ? {
          samples: preflight.samples,
          windowMs: preflight.windowMs,
          maxForeignCpu: preflight.maxForeignCpu,
          thresholdCpu: preflight.thresholdCpu,
          load1: preflight.load1,
          cores: preflight.cores,
        }
      : undefined,
    gpu: renderer,
    // The attest booted + identity-verified its OWN app server (#1597).
    appServer: ownServer
      ? { url: ownServer.url, mode: ownServer.mode, root: ownServer.identity.root, commit: ownServer.identity.commit }
      : undefined,
    /** The offline combined-master baseline `.sha` this run validated (the CI
     *  verify cross-checks it against the committed baseline). */
    combinedMasterSha,
    repeatEach: REPEAT,
    retries: RETRIES,
    run: {
      specFiles: summary.specFiles,
      passed: summary.passed,
      failed: summary.failed,
      flaky: summary.flaky,
      skipped: summary.skipped,
    },
    durationSec,
  };

  const attestDir = join(REPO_ROOT, 'ci-grand-attest');
  const outFile = join(attestDir, `${hash}.json`);
  writeFileSync(outFile, JSON.stringify(attestation, null, 2) + '\n');
  console.log(`\nAttested ${hash}.`);
  console.log(`  ${summary.passed} @grand-attest test(s) passed on ${renderer}; offline ART sha=${combinedMasterSha}.`);
  console.log(`Wrote ci-grand-attest/${hash}.json`);

  // PRUNE superseded attestations (prune-to-1, webgl-style). CI only ever
  // verifies the ONE hash the current basis computes to.
  const superseded = readdirSync(attestDir).filter((f) => f.endsWith('.json') && f !== `${hash}.json`);
  for (const f of superseded) rmSync(join(attestDir, f));
  if (superseded.length > 0) {
    console.log(`Pruned ${superseded.length} superseded attestation(s) — ci-grand-attest/ now holds only the live hash.`);
  }
  console.log(`Now:  git add -A ci-grand-attest/ art/baselines/grand-integration/  and commit them with your PR.`);

  // TEARDOWN ON THE SUCCESS PATH (#1630) — same wedge class as webgl-attest:
  // the exit-hook stop() can never fire while the un-torn-down server child
  // keeps the event loop alive. Await the child's actual exit.
  await ownServer?.stopAndWait();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
