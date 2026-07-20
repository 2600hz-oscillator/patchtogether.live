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
import { tmpdir, hostname, release, arch, cpus, loadavg } from 'node:os';
import { join } from 'node:path';

import { REPO_ROOT, GRAND_GREP, computeGrandHash } from './grand-attest-lib';

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
function preflightSolo(): void {
  if (process.env.GRAND_ATTEST_ALLOW_BUSY === '1') {
    console.log('Pre-flight: GRAND_ATTEST_ALLOW_BUSY=1 — skipping the quiet-machine guard.');
    return;
  }
  const ncpu = cpus().length || 1;
  const load1 = loadavg()[0] ?? 0;
  const COTENANT_CPU_MIN = Math.max(1, parseFloat(process.env.GRAND_ATTEST_BUSY_CPU || '25') || 25);
  const COTENANT_RE = /Google Chrome|Microsoft Edge|Safari|Chromium|firefox|Brave|Electron|Patchtogether\.app|Spotify/i;
  let cotenants: string[] = [];
  try {
    cotenants = execSync('ps -A -o %cpu=,comm=', { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(' ');
        return { cpu: parseFloat(l.slice(0, i)) || 0, name: l.slice(i + 1) };
      })
      .filter((p) => p.cpu >= COTENANT_CPU_MIN && COTENANT_RE.test(p.name))
      .sort((a, b) => b.cpu - a.cpu)
      .map((p) => `${p.cpu.toFixed(0)}% ${p.name.split('/').pop()}`);
  } catch {
    /* ps unavailable → fall back to load only */
  }
  const loadBusy = load1 > ncpu * 0.5;
  if (cotenants.length === 0 && !loadBusy) {
    console.log(`Pre-flight: machine looks quiet (load(1m)=${load1.toFixed(2)} on ${ncpu} cores). Proceeding.`);
    return;
  }
  console.error('────────────────────────────────────────────────────────────');
  console.error('grand:attest PRE-FLIGHT — machine is NOT quiet; REFUSING to run.');
  if (cotenants.length) console.error(`  GPU co-tenants: ${cotenants.join('  ·  ')}`);
  console.error(`  load(1m)=${load1.toFixed(2)} on ${ncpu} cores${loadBusy ? '  (HIGH)' : ''}`);
  console.error('  The heavy attest needs the GPU + CPU quiet — synesthesia (WebGL)');
  console.error('  + recorderbox (H.264) + the audio graph are timing-sensitive.');
  console.error('  → Quit heavy browsers / native GL apps, then re-run.');
  console.error('  → Override (dedicated/trusted runner only): GRAND_ATTEST_ALLOW_BUSY=1');
  console.error('────────────────────────────────────────────────────────────');
  process.exit(2);
}

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
function gitEmail(): string {
  try {
    return execSync('git config user.email', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  // (1) Refuse SwiftShader — the whole point is the real GPU (synesthesia).
  if (process.env.E2E_SWIFTSHADER === '1') {
    console.error('E2E_SWIFTSHADER=1 is set — a SwiftShader attestation would be a lie. Unset it and run on the real GPU.');
    process.exit(2);
  }
  // (1b) Refuse a contended machine.
  if (!DRY) preflightSolo();

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

  // (6) Write the attestation.
  const attestation = {
    schemaVersion: 1,
    grandContentHash: hash,
    attestedAt: new Date().toISOString(),
    attestedBy: gitEmail(),
    gitHeadAtAttest: gitHead(), // INFORMATIONAL only — NOT the match key
    playwrightVersion: playwrightVersion(),
    os: `${process.platform} ${release()} (${arch()})`,
    host: hostname(),
    gpu: renderer,
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
}

main();
