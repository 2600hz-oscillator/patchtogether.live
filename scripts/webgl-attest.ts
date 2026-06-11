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
import { tmpdir, hostname, release, arch } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  computeWebglHash,
  resolveHeavyWebglSpecs,
  WEBGL_LEAKER_SPECS,
  WEBGL_CAMERA_SPECS,
} from './webgl-attest-lib';

const REPEAT = Math.max(1, parseInt(process.env.REPEAT || '1', 10) || 1);
const DRY = process.argv.includes('--dry-run'); // verify the mechanism w/o the long real-GPU run

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
    '--retries=0',
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
    throw new Error(`Pass ${opts.name}: ${result.failed} failed test(s) — attestation refused.`);
  }
  if (result.flaky > 0) {
    throw new Error(`Pass ${opts.name}: ${result.flaky} flaky test(s) (retries=0) — root-cause the flake; attestation refused.`);
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
    const probeScript = `
      const { chromium } = require('@playwright/test');
      (async () => {
        const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
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
    const out = execSync(`node -e ${JSON.stringify(probeScript)}`, {
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
// main
// ---------------------------------------------------------------------------
function main() {
  // (1) Refuse SwiftShader — the whole point is the real GPU.
  if (process.env.E2E_SWIFTSHADER === '1') {
    console.error('E2E_SWIFTSHADER=1 is set — a SwiftShader attestation would be a lie. Unset it and run on the real GPU.');
    process.exit(2);
  }
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
  const heavySpecs = resolveHeavyWebglSpecs(); // repo-relative
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
