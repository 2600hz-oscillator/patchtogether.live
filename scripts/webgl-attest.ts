// scripts/webgl-attest.ts
//
// The real-GPU WebGL attestation RUNNER + WRITER (invoked by `task webgl:attest`
// via scripts/webgl-attest.sh). Multi-pass (fix V5), measured spec counts (never
// hand-typed), refuses SwiftShader, refuses to write on any shortfall.
//
// Passes (E2E_WEBGL_HEAVY=only structurally cannot reach the camera/leaker specs
// — it gives chromium-camera/chromium-audio-in testMatch:[] and sets chromium's
// testMatch to exactly the heavy globs — so we run THREE explicit passes):
//   A — heavy:   E2E_WEBGL_HEAVY=only   (the ~49 heavy-glob spec files)
//   B — leakers: E2E_WEBGL_HEAVY unset, --grep-files the WEBGL_LEAKER_SPECS
//   C — camera:  --project chromium-camera (camera-input → WebGL VideoOut)
// All on the REAL GPU (E2E_SWIFTSHADER must be UNSET — a SwiftShader attestation
// would be a lie). retries=0 to surface flakes honestly; REPEAT=N → repeat-each.
//
// On a fully-green run where the MEASURED spec-file count equals the derived
// expected set for every pass, writes ci-webgl-attest/<hash>.json with the
// metadata + per-suite measured summary. On ANY failure/flake/shortfall: writes
// nothing, exits non-zero. Does NOT auto-commit (the commit is the contributor's
// explicit act). See .myrobots/plans/webgl-attestation-semaphore.md §5.

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, hostname, release, arch, cpus, loadavg } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  computeWebglHash,
  resolveAttestableHeavyWebglSpecs,
  WEBGL_LEAKER_SPECS,
  WEBGL_CAMERA_SPECS,
} from './webgl-attest-lib';

const REPEAT = Math.max(1, parseInt(process.env.REPEAT || '1', 10) || 1);
const DRY = process.argv.includes('--dry-run'); // verify the mechanism w/o the long real-GPU run
// Per-test retry budget for the real-GPU passes. The heavy lane runs ~210 WebGL
// specs SERIALLY on a SINGLE Metal/ANGLE context; under that sustained load the
// driver occasionally drops a single frame on a timing-sensitive viewport/decode
// assertion (verified: the offenders pass 5/5 in ISOLATION but a different ~1-2
// of 210 stall on each saturated full run — the documented GPU-serial transient,
// ci-swiftshader-video-e2e-timeouts). This is an ENVIRONMENT stall, not a code
// flake, and is why Phase 1 shipped --retries=2 as an interim. Phase 2 (#753)
// leaned the lane (49→44 specs) and it now passes CLEAN at retries=0 (verified:
// 0 flaky across all passes), so the DEFAULT is now 0 — a transient stall now
// correctly REFUSES the attestation, forcing investigation (no-flake-tolerance).
// Override with WEBGL_ATTEST_RETRIES=N only if the lane ever regrows. A test that
// FAILS ALL RETRIES still refuses; REPEAT>1 (the 3× pre-MR flake-check) forces 0.
const RETRIES = REPEAT > 1 ? 0 : Math.max(0, parseInt(process.env.WEBGL_ATTEST_RETRIES || '0', 10) || 0);

// Worker count for the real-GPU passes. ROOT CAUSE of the rotating "transient"
// heavy-spec flakes (different toybox/video spec each saturated run): runPass
// did NOT pin --workers, so Playwright defaulted to ≈half-cores and ran the heavy
// WebGL specs IN PARALLEL — multiple browser/ANGLE contexts hammering the ONE
// GPU. GPU-bound work doesn't speed up under that parallelism; it just STARVES
// (slow renders → setup/click/viewport races → a different ~1-2 specs stall each
// run). The earlier comment assumed the lane was "serial" — it wasn't. PIN it to
// 1 so heavy specs get the GPU SOLO (deterministic, ≈same wall-clock since the
// GPU serialises the work anyway). Override with WEBGL_ATTEST_WORKERS=N for the
// worker-count sweep (#136); the 3× flake-check (REPEAT>1) also forces 1.
const WORKERS = REPEAT > 1 ? 1 : Math.max(1, parseInt(process.env.WEBGL_ATTEST_WORKERS || '1', 10) || 1);

interface PassResult {
  name: string;
  expectedSpecFiles: number;
  measuredSpecFiles: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

/** Run one Playwright pass with the JSON reporter to a temp file and return
 *  measured counts. Throws on a non-zero exit OR any failure/flaky. */
function runPass(opts: {
  name: string;
  env: Record<string, string>;
  args: string[];
  expectedSpecFiles: number;
}): PassResult {
  const tmp = mkdtempSync(join(tmpdir(), 'webgl-attest-'));
  const jsonOut = join(tmp, 'report.json');
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...opts.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut,
  };
  // An empty-string value means "unset for the child" (delete the key) so the
  // config's `=== 'only' | 'exclude'` checks see a genuinely-undefined mode.
  for (const [k, v] of Object.entries(opts.env)) {
    if (v === '') delete env[k];
  }
  const fullArgs = [
    '--workspace',
    'e2e',
    'playwright',
    'test',
    '--reporter=json',
    `--retries=${RETRIES}`,
    `--workers=${WORKERS}`, // pin: heavy WebGL specs get the GPU solo (no parallel contention)
    ...(REPEAT > 1 ? [`--repeat-each=${REPEAT}`] : []),
    ...opts.args,
  ];

  console.log(`\n=== Pass ${opts.name} ===`);
  console.log(`  env: ${Object.entries(opts.env).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
  console.log(`  npx ${fullArgs.join(' ')}`);

  if (DRY) {
    console.log('  [--dry-run] skipping the actual Playwright run; mechanism only.');
    return {
      name: opts.name,
      expectedSpecFiles: opts.expectedSpecFiles,
      measuredSpecFiles: opts.expectedSpecFiles,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
    };
  }

  let runExit = 0;
  try {
    execFileSync('npx', fullArgs, { cwd: REPO_ROOT, env, stdio: 'inherit' });
  } catch {
    runExit = 1; // non-zero = at least one failure; we still parse JSON for detail
  }

  if (!existsSync(jsonOut)) {
    throw new Error(`Pass ${opts.name}: no JSON report at ${jsonOut} (Playwright did not run?)`);
  }
  const report = JSON.parse(readFileSync(jsonOut, 'utf8'));
  const counts = summarize(report);
  rmSync(tmp, { recursive: true, force: true });

  const result: PassResult = {
    name: opts.name,
    expectedSpecFiles: opts.expectedSpecFiles,
    measuredSpecFiles: counts.specFiles.size,
    passed: counts.passed,
    failed: counts.failed,
    flaky: counts.flaky,
    skipped: counts.skipped,
  };

  console.log(
    `  → spec files: ${result.measuredSpecFiles}/${result.expectedSpecFiles} | ` +
      `passed=${result.passed} failed=${result.failed} flaky=${result.flaky} skipped=${result.skipped}`,
  );

  if (runExit !== 0 || result.failed > 0) {
    throw new Error(`Pass ${opts.name}: ${result.failed} failed test(s) (failed all ${RETRIES} retries) — attestation refused.`);
  }
  if (result.flaky > 0) {
    if (RETRIES === 0) {
      // REPEAT mode (the 3× pre-MR flake-check): retries=0, so a flaky result is
      // a genuine flake to root-cause — refuse.
      throw new Error(`Pass ${opts.name}: ${result.flaky} flaky test(s) (retries=0) — root-cause the flake; attestation refused.`);
    }
    // Normal attest with retries: a "flaky" test PASSED on retry — a recovered
    // GPU-serial transient stall (see RETRIES rationale), not a code flake. Log
    // it transparently (so a creeping flake rate is visible in the JSON summary)
    // but do NOT refuse — the original e2e-video lane tolerated the same.
    console.log(`  ⚠ ${result.flaky} test(s) recovered on retry (transient GPU-serial stall under sustained load) — see suites.${opts.name}.flaky in the attestation.`);
  }
  // COUNT GATE: measured spec-file count must EQUAL the derived expected set.
  if (result.measuredSpecFiles !== result.expectedSpecFiles) {
    throw new Error(
      `Pass ${opts.name}: measured ${result.measuredSpecFiles} spec files but expected ${result.expectedSpecFiles} ` +
        `— a shortfall means specs silently didn't run (the V5 failure mode). Attestation refused.`,
    );
  }
  return result;
}

/** Walk the Playwright JSON report → counts + the SET of spec files that
 *  actually ran (so the count-gate compares spec FILES, the stable unit). */
function summarize(report: {
  suites?: PwSuite[];
}): { passed: number; failed: number; flaky: number; skipped: number; specFiles: Set<string> } {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  const specFiles = new Set<string>();

  const visit = (suite: PwSuite) => {
    for (const spec of suite.specs ?? []) {
      if (spec.file) specFiles.add(spec.file);
      for (const test of spec.tests ?? []) {
        const status = test.status; // 'expected' | 'unexpected' | 'flaky' | 'skipped'
        if (status === 'expected') passed++;
        else if (status === 'unexpected') failed++;
        else if (status === 'flaky') flaky++;
        else if (status === 'skipped') skipped++;
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const s of report.suites ?? []) visit(s);
  return { passed, failed, flaky, skipped, specFiles };
}

interface PwSuite {
  specs?: { file?: string; tests?: { status?: string }[] }[];
  suites?: PwSuite[];
}

/** Probe the real ANGLE renderer string via a one-shot headless WebGL context
 *  (no Playwright run) and abort if it reports SwiftShader. */
function probeRenderer(): string {
  if (DRY) return 'dry-run (renderer probe skipped)';
  // Cheap probe: launch Chromium through Playwright's node API, read
  // UNMASKED_RENDERER_WEBGL. Falls back to a descriptive string if unavailable.
  try {
    // Launch with the SAME real-GPU ANGLE flags the attestation passes use
    // (E2E_REAL_GPU → playwright.config.ts). HEADLESS Chromium on macOS falls
    // back to SwiftShader EVEN ON A REAL GPU unless given --use-gl=angle
    // --use-angle=metal — so a bare-flag probe would wrongly report SwiftShader
    // and abort the attestation on a perfectly capable Mac. The probe must
    // mirror the actual render path it is certifying.
    const angleBackend =
      process.env.E2E_ANGLE_BACKEND || (process.platform === 'darwin' ? 'metal' : 'default');
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
    // execFileSync (argv form) — NOT execSync via the shell: passing the probe
    // script as a `-e` argv element avoids shell mangling of its quotes/parens
    // (the shell path produced "Invalid or unexpected token").
    const out = execFileSync('node', ['-e', probeScript], {
      cwd: join(REPO_ROOT, 'e2e'),
      encoding: 'utf8',
    }).trim();
    return out || 'unknown';
  } catch (e) {
    return `probe-failed (${(e as Error).message})`;
  }
}

function playwrightVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'e2e/node_modules/@playwright/test/package.json'), 'utf8'),
    );
    return pkg.version || '?';
  } catch {
    // Fall back to the spec range from e2e/package.json.
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
// Pre-flight: refuse a NON-SOLO machine.
// ---------------------------------------------------------------------------
// ROOT CAUSE of the "transients in different files each run" class (NOT a code
// flake, NOT a per-test bug): the heavy passes drive ONE Metal/ANGLE context
// with --workers=1, but a CO-TENANT GPU client (a browser, an Electron/native
// GL app) running at attest time steals GPU cycles from that context. Renders
// slow → a DIFFERENT 1-2 timing-sensitive WebGL specs stall on each saturated
// run → retries=0 turns each into a false refusal. Pin-workers (#860) fixed the
// INTERNAL parallelism; this fixes the EXTERNAL contention the runner couldn't
// see. We detect heavy GPU co-tenants + high load up front and REFUSE rather
// than burn a ~6-min run and mislabel a co-tenant stall as a regression.
// Override (e.g. on a dedicated runner you trust) with WEBGL_ATTEST_ALLOW_BUSY=1.
function preflightSolo(): void {
  if (process.env.WEBGL_ATTEST_ALLOW_BUSY === '1') {
    console.log('Pre-flight: WEBGL_ATTEST_ALLOW_BUSY=1 — skipping the quiet-machine guard.');
    return;
  }
  const ncpu = cpus().length || 1;
  const load1 = loadavg()[0] ?? 0;
  // GPU co-tenants (browsers / native GL apps) consuming real CPU at pre-flight
  // time — before WE spawn any chromium, so anything here is someone else's.
  const COTENANT_RE = /Google Chrome|Microsoft Edge|Safari|Chromium|firefox|Brave|Electron|Patchtogether\.app|Spotify/i;
  let cotenants: string[] = [];
  try {
    cotenants = execSync('ps -A -o %cpu=,comm=', { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { const i = l.indexOf(' '); return { cpu: parseFloat(l.slice(0, i)) || 0, name: l.slice(i + 1) }; })
      .filter((p) => p.cpu >= 8 && COTENANT_RE.test(p.name))
      .sort((a, b) => b.cpu - a.cpu)
      .map((p) => `${p.cpu.toFixed(0)}% ${p.name.split('/').pop()}`);
  } catch { /* ps unavailable → fall back to load only */ }
  const loadBusy = load1 > ncpu * 0.5;
  if (cotenants.length === 0 && !loadBusy) {
    console.log(`Pre-flight: machine looks quiet (load(1m)=${load1.toFixed(2)} on ${ncpu} cores). Proceeding.`);
    return;
  }
  console.error('────────────────────────────────────────────────────────────');
  console.error('webgl:attest PRE-FLIGHT — machine is NOT quiet; REFUSING to run.');
  if (cotenants.length) console.error(`  GPU co-tenants: ${cotenants.join('  ·  ')}`);
  console.error(`  load(1m)=${load1.toFixed(2)} on ${ncpu} cores${loadBusy ? '  (HIGH)' : ''}`);
  console.error('  The real-GPU attest needs the GPU SOLO. A co-tenant browser or');
  console.error('  native GL app steals GPU cycles from the attest\'s single ANGLE/');
  console.error('  Metal context, so a DIFFERENT 1-2 timing-sensitive WebGL specs');
  console.error('  stall each run — the "transients in different files" false refusal.');
  console.error('  → Quit heavy browsers / native GL apps, then re-run.');
  console.error('  → Override (dedicated/trusted runner only): WEBGL_ATTEST_ALLOW_BUSY=1');
  console.error('────────────────────────────────────────────────────────────');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  // (1) Refuse SwiftShader — the whole point is the real GPU.
  if (process.env.E2E_SWIFTSHADER === '1') {
    console.error('E2E_SWIFTSHADER=1 is set — a SwiftShader attestation would be a lie. Unset it and run on the real GPU.');
    process.exit(2);
  }
  // (1b) Refuse a contended machine (the external-co-tenant transient class).
  if (!DRY) preflightSolo();
  // Force the real hardware GPU for the probe AND all three Playwright passes.
  // HEADLESS Chromium on macOS defaults to SwiftShader even on a real GPU;
  // E2E_REAL_GPU=1 → playwright.config.ts adds --use-gl=angle --use-angle=metal
  // so the attested run is genuinely on the GPU (see GPU_ARGS in the config).
  process.env.E2E_REAL_GPU = '1';
  const renderer = probeRenderer();
  console.log(`Real renderer: ${renderer}`);
  if (/swiftshader|software/i.test(renderer)) {
    console.error(`The active WebGL renderer reports SwiftShader/software ('${renderer}'). This machine cannot produce a real-GPU attestation. Abort.`);
    process.exit(2);
  }

  // (2) Compute the content hash up front.
  const hash = computeWebglHash();
  console.log(`WebGL content hash: ${hash}`);

  // (3) Derive expected spec-file counts (MEASURED gating happens per pass).
  //     Pass A runs `--grep-invert "@collab|@capacity"`, so a heavy spec whose
  //     every test is @collab/@capacity-gated (e.g. picturebox-sync) runs ZERO
  //     tests and Playwright never registers it → measured would be 1 short of
  //     the raw glob count. Use the ATTESTABLE set (glob minus fully-gated) so
  //     the count-gate matches what Pass A actually runs.
  const heavySpecs = resolveAttestableHeavyWebglSpecs(); // repo-relative
  const expectedHeavy = heavySpecs.length;
  const expectedLeakers = WEBGL_LEAKER_SPECS.length;
  const expectedCamera = WEBGL_CAMERA_SPECS.length;

  const startedAt = Date.now();
  const results: PassResult[] = [];

  // Pass A — heavy set (E2E_WEBGL_HEAVY=only). @collab/@capacity excluded.
  results.push(
    runPass({
      name: 'A-heavy',
      env: { E2E_WEBGL_HEAVY: 'only' },
      args: ['--grep-invert', '@collab|@capacity'],
      expectedSpecFiles: expectedHeavy,
    }),
  );

  // Pass B — leakers/uncovered (E2E_WEBGL_HEAVY UNSET; explicit spec files).
  results.push(
    runPass({
      name: 'B-leakers',
      env: { E2E_WEBGL_HEAVY: '' }, // unset for the child (empty = treated as unset by config)
      args: WEBGL_LEAKER_SPECS,
      expectedSpecFiles: expectedLeakers,
    }),
  );

  // Pass C — camera (chromium-camera project; E2E_WEBGL_HEAVY unset).
  results.push(
    runPass({
      name: 'C-camera',
      env: { E2E_WEBGL_HEAVY: '' },
      // NB: `--project=X` (with `=`) — the space form `--project X spec.ts`
      // makes Playwright parse the following positional spec as a 2nd project.
      args: ['--project=chromium-camera', ...WEBGL_CAMERA_SPECS],
      expectedSpecFiles: expectedCamera,
    }),
  );

  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  if (DRY) {
    console.log('\n[--dry-run] All passes selected + count-gated OK (no real run). NOT writing an attestation.');
    return;
  }

  // (4) Write the attestation — every pass green + counts matched.
  const attestation = {
    schemaVersion: 1,
    webglContentHash: hash,
    attestedAt: new Date().toISOString(),
    attestedBy: gitEmail(),
    gitHeadAtAttest: gitHead(), // INFORMATIONAL only — NOT the match key
    playwrightVersion: playwrightVersion(),
    os: `${process.platform} ${release()} (${arch()})`,
    host: hostname(),
    gpu: renderer,
    repeatEach: REPEAT,
    suites: {
      'A-heavy': pick(results[0]),
      'B-leakers': pick(results[1]),
      'C-camera': pick(results[2]),
    },
    durationSec,
  };

  const outFile = join(REPO_ROOT, 'ci-webgl-attest', `${hash}.json`);
  writeFileSync(outFile, JSON.stringify(attestation, null, 2) + '\n');
  console.log(`\nAttested ${hash}.`);
  console.log(`Wrote ci-webgl-attest/${hash}.json`);
  console.log(`Now:  git add ci-webgl-attest/${hash}.json  and commit it with your PR.`);
}

function pick(r: PassResult) {
  return {
    specFiles: r.measuredSpecFiles,
    passed: r.passed,
    failed: r.failed,
    flaky: r.flaky,
    skipped: r.skipped,
  };
}

main();
