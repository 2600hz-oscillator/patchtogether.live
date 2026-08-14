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
// All passes run against an app server THIS RUNNER BOOTS ITSELF on a per-run
// ephemeral port, identity-verified via GET /__worktree (#1597) — never the
// config's reuse-happy webServer on the shared default port, which could adopt
// a SIBLING WORKTREE'S dev server and attest this tree's hash against that
// tree's app. See scripts/worktree-identity.ts.
//
// On a fully-green run where the MEASURED spec-file count equals the derived
// expected set for every pass, writes ci-webgl-attest/<hash>.json with the
// metadata + per-suite measured summary. On ANY failure/flake/shortfall: writes
// nothing, exits non-zero. Does NOT auto-commit (the commit is the contributor's
// explicit act). See .myrobots/plans/webgl-attestation-semaphore.md §5.

import { execFileSync, execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, hostname, release, arch, cpus, loadavg } from 'node:os';
import { join } from 'node:path';

import {
  REPO_ROOT,
  computeWebglHash,
  resolveAttestableHeavyWebglSpecs,
  WEBGL_LEAKER_SPECS,
  WEBGL_CAMERA_SPECS,
  WEBGL_SERIAL_SPECS,
} from './webgl-attest-lib';
import {
  parsePs,
  foreignCoTenants,
  formatCoTenants,
  parseListeners,
  leakedServers,
  type PsRow,
} from './webgl-cotenancy';
import { bootOwnAppServer, assertServerIsThisWorktree, type OwnAppServer } from './worktree-identity';

const REPEAT = Math.max(1, parseInt(process.env.REPEAT || '1', 10) || 1);
const DRY = process.argv.includes('--dry-run'); // verify the mechanism w/o the long real-GPU run
// Per-test retry budget for the real-GPU passes. retries=1 is a THIN BACKSTOP
// for the irreducible GPU-transient tail: a real GPU ALWAYS shares cycles with
// the macOS WindowServer, so even a well-written test can drop a single frame on
// a saturated run. retries=1 lets ONE such transient recover; a test that FAILS
// BOTH attempts still REFUSES (a real regression is never masked).
//
// This is a backstop, NOT a license for flaky tests. EVERY actual recovery is
// surfaced LOUDLY (the test name + its first-attempt error) AND recorded in the
// attestation json (suites.*.flakyDetails) so each can be reviewed + confirmed a
// true transient. And MAX_FLAKY caps how many recoveries ONE run may absorb: an
// occasional single recovery is fine, but several in one run is NOT a rare
// transient — it's systemic, so the attest REFUSES (forcing a real fix). The
// deterministic GPU-attest rebuild drives the underlying rate toward zero so this
// backstop almost never fires; a rising flakyDetails rate is the signal to fix
// tests, not to raise retries. REPEAT>1 (the 3× pre-MR flake-check) forces 0 — a
// NEW/changed test must be clean with NO safety net. Override: WEBGL_ATTEST_RETRIES.
const RETRIES = REPEAT > 1 ? 0 : Math.max(0, parseInt(process.env.WEBGL_ATTEST_RETRIES || '1', 10) || 0);
// Max recovered-flaky tests a single run may absorb before refusing (per pass).
// 0 = ideal; 1 = the rare allowed transient; more in ONE run = systemic → refuse.
const MAX_FLAKY = REPEAT > 1 ? 0 : Math.max(0, parseInt(process.env.WEBGL_ATTEST_MAX_FLAKY || '1', 10) || 0);

// Worker count for the real-GPU passes. PARALLELISM IS REQUIRED FOR SPEED.
// The previous code pinned this to 1 ("GPU serialises the work anyway") which
// was WRONG: most of each heavy spec's wall-time is NON-GPU overhead — page
// boot + `networkidle` + `spawnPatch` + card mount + teardown — and that does
// NOT overlap under --workers=1. Serialising all ~49 heavy specs took 60-90 min
// vs ~5 min parallel (the proven config from before #941). The #161 3.6h
// blow-up was EXTERNAL contention (a 9-agent swarm oversubscribing the GPU while
// the attest ran), NOT the attest's own parallelism — and that case is now
// guarded two ways: (a) the pre-flight load check below refuses to attest on a
// busy machine, and (b) GLOBAL_TIMEOUT_MS bounds any stall to minutes (not
// hours). So default to ≈half-cores (Playwright's own default formula); the 3×
// flake-check (REPEAT>1) still forces 1. Override with WEBGL_ATTEST_WORKERS=N.
const DEFAULT_WORKERS = Math.max(2, Math.ceil((cpus().length || 4) / 2));
const WORKERS = REPEAT > 1 ? 1 : Math.max(1, parseInt(process.env.WEBGL_ATTEST_WORKERS || String(DEFAULT_WORKERS), 10) || DEFAULT_WORKERS);

// Global-timeout backstop (ms): bounds the WORST case so a wedged/contended run
// aborts cleanly in minutes instead of running for hours (the #161 failure mode
// had NO backstop). Applied per Playwright pass. Generous vs the ~5-min normal
// run so a legitimately slow real-GPU pass never trips it. Override with
// WEBGL_ATTEST_GLOBAL_TIMEOUT_MS=N.
const GLOBAL_TIMEOUT_MS = Math.max(
  60_000,
  parseInt(process.env.WEBGL_ATTEST_GLOBAL_TIMEOUT_MS || '900000', 10) || 900_000,
);

interface FlakyDetail {
  /** Test that FAILED its first attempt then RECOVERED on retry. */
  test: string;
  file: string;
  /** First-attempt error (truncated) — the WHY, so a human can confirm it was a
   *  true transient and not a masked real failure. */
  firstError: string;
}

interface PassResult {
  name: string;
  expectedSpecFiles: number;
  measuredSpecFiles: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  /** Per-test detail for every recovered-on-retry test (empty on a clean run). */
  flakyDetails: FlakyDetail[];
}

/** Run one Playwright pass with the JSON reporter to a temp file and return
 *  measured counts. Throws on a non-zero exit OR any failure/flaky. */
async function runPass(opts: {
  name: string;
  env: Record<string, string>;
  args: string[];
  expectedSpecFiles: number;
  /** Per-pass worker override. Defaults to WORKERS (the parallel passes). The
   *  serial bucket sets workers=1 to run on a quiet GPU (no FBO-readback race). */
  workers?: number;
}): Promise<PassResult> {
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
    `--workers=${opts.workers ?? WORKERS}`, // ≈half-cores parallel (speed); contention guarded by pre-flight + global-timeout. Serial bucket overrides to 1.
    `--global-timeout=${GLOBAL_TIMEOUT_MS}`, // backstop: abort a wedged/contended pass in minutes, not hours
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
      flakyDetails: [],
    };
  }

  // ── RUN THE PASS WITH A CO-TENANCY WATCHDOG ALONGSIDE IT ──────────────────
  //
  // This used to be a blocking execFileSync, which is precisely why co-tenancy
  // could only ever be sampled BEFORE the run. Load arriving mid-pass was
  // invisible and surfaced as `30 failed` in wavesculpt.spec.ts on a branch that
  // does not touch wavesculpt — a contention stall wearing a regression's
  // clothes. Spawning async lets a sampler run on the same event loop.
  //
  // Requires SUSTAINED contention (consecutive busy samples), not a single
  // spike: `ps` catches instantaneous CPU, and one transient blip from a
  // background app is not worth killing a ~6-minute GPU run over.
  const SAMPLE_MS = Math.max(1000, parseInt(process.env.WEBGL_ATTEST_SAMPLE_MS || '15000', 10) || 15000);
  const NEEDED = Math.max(1, parseInt(process.env.WEBGL_ATTEST_BUSY_SAMPLES || '2', 10) || 2);
  const CPU_MIN = Math.max(1, parseFloat(process.env.WEBGL_ATTEST_BUSY_CPU || '25') || 25);
  const passStart = Date.now();

  let runExit = 0;
  let contention: ContentionAbort | null = null;
  let consecutive = 0;

  await new Promise<void>((resolve) => {
    const child = spawn('npx', fullArgs, { cwd: REPO_ROOT, env, stdio: 'inherit' });

    const timer = setInterval(() => {
      if (process.env.WEBGL_ATTEST_ALLOW_BUSY === '1') return;
      const found = sampleForeignCoTenants(CPU_MIN);
      if (found.length === 0) {
        consecutive = 0; // must be SUSTAINED; a lone spike resets the streak
        return;
      }
      consecutive += 1;
      const names = formatCoTenants(found);
      console.error(
        `  ⚠ co-tenant seen during ${opts.name} (${consecutive}/${NEEDED}): ${names.join('  ·  ')}`,
      );
      if (consecutive < NEEDED) return;
      contention = new ContentionAbort(opts.name, names, Math.round((Date.now() - passStart) / 1000));
      clearInterval(timer);
      // Kill the run rather than let it produce failures that read as a
      // regression. SIGTERM first; the close handler resolves either way.
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, SAMPLE_MS);
    timer.unref();

    child.on('error', () => {
      runExit = 1;
      clearInterval(timer);
      resolve();
    });
    child.on('close', (code) => {
      runExit = code === 0 ? 0 : 1;
      clearInterval(timer);
      resolve();
    });
  });

  // ⚠ ABORT LOUDLY, AND BEFORE PARSING THE REPORT. A contended pass leaves a
  // JSON report full of failures; reporting those would be reporting the very
  // false regression this watchdog exists to prevent.
  if (contention) throw contention;

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
    flakyDetails: counts.flakyDetails,
  };

  console.log(
    `  → spec files: ${result.measuredSpecFiles}/${result.expectedSpecFiles} | ` +
      `passed=${result.passed} failed=${result.failed} flaky=${result.flaky} skipped=${result.skipped}`,
  );

  if (runExit !== 0 || result.failed > 0) {
    throw new Error(`Pass ${opts.name}: ${result.failed} failed test(s) (failed all ${RETRIES} retries) — attestation refused.`);
  }
  if (result.flaky > 0) {
    // A "flaky" test FAILED its first attempt then RECOVERED on retry. Surface
    // EVERY one LOUDLY with its first-attempt error so it can be reviewed and
    // confirmed a true transient — never silently absorbed.
    console.error(`\n  ⚠ RETRY FIRED — ${result.flaky} test(s) recovered on retry in Pass ${opts.name}. REVIEW each; confirm it was transient contention, NOT a masked bug:`);
    for (const d of result.flakyDetails) {
      console.error(`     • ${d.file} › ${d.test}`);
      console.error(`       first-attempt error: ${d.firstError}`);
    }
    console.error(`  (recorded in suites.${opts.name}.flakyDetails of the attestation json)`);
    if (RETRIES === 0) {
      // REPEAT mode (the 3× pre-MR flake-check): no safety net — any flake refuses.
      throw new Error(`Pass ${opts.name}: ${result.flaky} flaky test(s) with retries=0 — root-cause the flake; attestation refused.`);
    }
    if (result.flaky > MAX_FLAKY) {
      // Several recoveries in ONE run is not a rare transient — it's systemic.
      throw new Error(`Pass ${opts.name}: ${result.flaky} recovered-flaky test(s) exceeds MAX_FLAKY=${MAX_FLAKY} — too many for a rare transient; fix the tests (do NOT raise the ceiling). Attestation refused.`);
    }
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
}): { passed: number; failed: number; flaky: number; skipped: number; specFiles: Set<string>; flakyDetails: FlakyDetail[] } {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  const specFiles = new Set<string>();
  const flakyDetails: FlakyDetail[] = [];

  const visit = (suite: PwSuite) => {
    for (const spec of suite.specs ?? []) {
      if (spec.file) specFiles.add(spec.file);
      for (const test of spec.tests ?? []) {
        const status = test.status; // 'expected' | 'unexpected' | 'flaky' | 'skipped'
        if (status === 'expected') passed++;
        else if (status === 'unexpected') failed++;
        else if (status === 'flaky') {
          flaky++;
          // Capture the WHY: the first attempt that did NOT pass (the one the
          // retry recovered from), truncated. So every recovery is reviewable.
          const firstBad = (test.results ?? []).find((r) => r.status && r.status !== 'passed');
          const raw = firstBad?.errors?.[0]?.message ?? firstBad?.error?.message ?? '(no error captured)';
          flakyDetails.push({
            test: spec.title ?? '(unknown test)',
            file: spec.file ?? '(unknown file)',
            firstError: String(raw).replace(/\[[0-9;]*m/g, '').split('\n').slice(0, 4).join(' | ').slice(0, 400),
          });
        } else if (status === 'skipped') skipped++;
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const s of report.suites ?? []) visit(s);
  return { passed, failed, flaky, skipped, specFiles, flakyDetails };
}

interface PwTestResult { status?: string; error?: { message?: string }; errors?: { message?: string }[] }
interface PwSuite {
  specs?: { file?: string; title?: string; tests?: { status?: string; results?: PwTestResult[] }[] }[];
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
/** One `ps` sample, reduced to co-tenants that are NOT this process's subtree.
 *  Returns [] if ps is unavailable — the caller then has no evidence either way
 *  and must not invent any. */
function sampleForeignCoTenants(minCpu: number): PsRow[] {
  let rows: PsRow[];
  try {
    rows = parsePs(execSync('ps -A -o %cpu=,pid=,ppid=,comm=', { encoding: 'utf8' }));
  } catch {
    return [];
  }
  return foreignCoTenants(rows, process.pid, minCpu);
}

/** Dev servers left listening by a DIFFERENT checkout of this repo. */
function findLeakedServers() {
  try {
    const listeners = parseListeners(
      execSync('lsof -nP -iTCP -sTCP:LISTEN -Fpn 2>/dev/null || true', { encoding: 'utf8' }),
    );
    return leakedServers(listeners, REPO_ROOT, (pid) => {
      try {
        const out = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null || true`, { encoding: 'utf8' });
        const line = out.split('\n').find((l) => l.startsWith('n'));
        return line ? line.slice(1) : null;
      } catch {
        return null;
      }
    });
  } catch {
    return [];
  }
}

/** Raised when co-tenancy arrives DURING a pass. Distinct from a test failure
 *  on purpose: the two need opposite responses and must never print alike. */
class ContentionAbort extends Error {
  constructor(
    readonly pass: string,
    readonly cotenants: string[],
    readonly atSec: number,
  ) {
    super(`contention during pass ${pass}`);
    this.name = 'ContentionAbort';
  }
}

function preflightSolo(): void {
  if (process.env.WEBGL_ATTEST_ALLOW_BUSY === '1') {
    console.log('Pre-flight: WEBGL_ATTEST_ALLOW_BUSY=1 — skipping the quiet-machine guard.');
    return;
  }
  const ncpu = cpus().length || 1;
  const load1 = loadavg()[0] ?? 0;
  // GPU co-tenants (browsers / native GL apps) consuming real CPU at pre-flight
  // time — before WE spawn any chromium, so anything here is someone else's.
  // Threshold = a CLEAR heavy contender, not incidental idle: a backgrounded
  // browser tab idles at ~5-10% CPU and barely touches the GPU (the attest that
  // false-refused on "9% Microsoft Edge" at load 2.07 — verified harmless),
  // whereas the runs that actually starved specs had co-tenants at 28-38% AND
  // load >5. So gate per-process at 25% and let the aggregate load check
  // (load > cores·0.5) catch broad contention. Override via WEBGL_ATTEST_BUSY_CPU.
  const COTENANT_CPU_MIN = Math.max(1, parseFloat(process.env.WEBGL_ATTEST_BUSY_CPU || '25') || 25);
  // The renderer-not-brand matching and the ancestry filter both live in
  // ./webgl-cotenancy so the MID-RUN watchdog below shares this exact predicate
  // rather than a re-typed copy of it.
  const cotenants = formatCoTenants(sampleForeignCoTenants(COTENANT_CPU_MIN));
  const leaked = findLeakedServers();
  const loadBusy = load1 > ncpu * 0.5;
  if (cotenants.length === 0 && leaked.length === 0 && !loadBusy) {
    console.log(`Pre-flight: machine looks quiet (load(1m)=${load1.toFixed(2)} on ${ncpu} cores). Proceeding.`);
    return;
  }
  console.error('────────────────────────────────────────────────────────────');
  console.error('webgl:attest PRE-FLIGHT — machine is NOT quiet; REFUSING to run.');
  if (cotenants.length) console.error(`  GPU co-tenants: ${cotenants.join('  ·  ')}`);
  if (leaked.length) {
    // `task worktree:guard` classifies an idle worktree as abandoned and removes
    // the CHECKOUT, but it never stops a dev server that worktree started. A
    // leaked vite keeps compiling and serving, which is CPU and (through the
    // browser that may still be pointed at it) GPU.
    console.error('  LEAKED dev servers from other checkouts:');
    for (const s of leaked) console.error(`    pid ${s.pid} on :${s.port} — ${s.cwd}`);
    console.error('    → stop each from its own worktree: flox activate -- task e2e:stop');
  }
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
// The attest's OWN app server (#1597) — module-scoped so the exit/signal
// handlers can always tear it down (several refusal paths process.exit()
// directly, which skips a try/finally in main). stop() is synchronous.
let ownServer: OwnAppServer | undefined;
process.on('exit', () => ownServer?.stop());
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    ownServer?.stop();
    process.exit(130);
  });
}

async function main() {
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

  // (1c) BOOT OUR OWN APP SERVER — the attest must NEVER reuse a server it did
  // not boot (#1597). The config's webServer has `reuseExistingServer: !CI` on
  // the shared default port, so a bare Playwright run here would happily adopt
  // a SIBLING WORKTREE'S dev server and attest THIS tree's hash against THAT
  // tree's app. Instead: a fresh dev server on a per-run ephemeral port,
  // identity-verified via GET /__worktree (refuses, naming both paths, if the
  // port somehow serves another checkout), and E2E_BASE_URL +
  // E2E_SKIP_WEBSERVER=1 exported so every pass targets exactly it. The relay
  // webServer is skipped too — every @collab/@capacity test is grep-inverted
  // out of the attest passes, so nothing here attaches a provider.
  if (!DRY) {
    ownServer = await bootOwnAppServer({ repoRoot: REPO_ROOT, mode: 'dev', context: 'webgl:attest' });
    process.env.E2E_BASE_URL = ownServer.url;
    process.env.E2E_SKIP_WEBSERVER = '1';
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
  // Split the SERIAL bucket out of the parallel heavy pass: a @webgl-serial spec
  // runs in Pass A-serial (workers=1) instead of A-heavy, so A-heavy's spec-file
  // count drops by the number of serial specs present in the heavy set.
  const serialInHeavy = heavySpecs.filter((p) => WEBGL_SERIAL_SPECS.some((b) => p.endsWith('/' + b) || p === b));
  const expectedHeavy = heavySpecs.length - serialInHeavy.length;
  const expectedSerial = serialInHeavy.length;
  const expectedLeakers = WEBGL_LEAKER_SPECS.length;
  const expectedCamera = WEBGL_CAMERA_SPECS.length;
  if (expectedSerial !== WEBGL_SERIAL_SPECS.length) {
    // A serial spec is no longer in the heavy attestable set (renamed / removed /
    // newly @collab-gated). Fail LOUDLY rather than silently mis-count a pass.
    console.error(
      `Serial-bucket drift: ${expectedSerial}/${WEBGL_SERIAL_SPECS.length} WEBGL_SERIAL_SPECS are in the heavy set ` +
        `— reconcile WEBGL_SERIAL_SPECS in webgl-attest-lib.ts.`,
    );
    process.exit(2);
  }

  const startedAt = Date.now();
  const results: PassResult[] = [];

  // Pass A — heavy set (E2E_WEBGL_HEAVY=only). @collab/@capacity excluded, AND
  // @webgl-serial excluded (those run serially in Pass A-serial below).
  results.push(
    await runPass({
      name: 'A-heavy',
      env: { E2E_WEBGL_HEAVY: 'only' },
      args: ['--grep-invert', '@collab|@capacity|@webgl-serial'],
      expectedSpecFiles: expectedHeavy,
    }),
  );

  // Pass A-serial — the SERIAL bucket: heavy specs that are green-in-isolation
  // but flake under A-heavy's parallel GPU load (FBO-readback race). workers=1 =
  // a quiet GPU, so they pass honestly instead of being papered over by retries.
  // Wall-time is ADDITIVE — WEBGL_SERIAL_SPECS is kept strict + logged below.
  const serialStartedAt = Date.now();
  results.push(
    await runPass({
      name: 'A-serial',
      env: { E2E_WEBGL_HEAVY: 'only' },
      args: ['--grep', '@webgl-serial'],
      workers: 1,
      expectedSpecFiles: expectedSerial,
    }),
  );
  const serialDurationSec = Math.round((Date.now() - serialStartedAt) / 1000);
  console.log(
    `\n  ⏱  Serial bucket: ${expectedSerial} spec file(s) in ${serialDurationSec}s (ADDITIVE, workers=1). ` +
      `Keep WEBGL_SERIAL_SPECS strict — each addition lengthens every attest.`,
  );

  // Pass B — leakers/uncovered (E2E_WEBGL_HEAVY UNSET; explicit spec files).
  // ANCHOR each leaker basename at a path-segment boundary (leading '/'):
  // Playwright treats every positional arg as a REGEX matched against the spec's
  // file PATH, so a SHORTER leaker basename SUBSTRING-matches a LONGER spec's
  // filename — the bare `cube.spec.ts` also matched `videocube.spec.ts` (the
  // heavy VIDEOCUBE spec added by #1136), so Pass B ran 5 files for 4 leakers and
  // the count-gate refused. `/cube.spec.ts` pins the match to a path boundary
  // (`…/videocube.spec.ts` has no `/cube` segment), while still matching
  // `…/tests/cube.spec.ts`. Fixes the whole basename-suffix collision class.
  results.push(
    await runPass({
      name: 'B-leakers',
      env: { E2E_WEBGL_HEAVY: '' }, // unset for the child (empty = treated as unset by config)
      args: WEBGL_LEAKER_SPECS.map((s) => `/${s}`),
      expectedSpecFiles: expectedLeakers,
    }),
  );

  // Pass C — camera (chromium-camera project; E2E_WEBGL_HEAVY unset).
  results.push(
    await runPass({
      name: 'C-camera',
      env: { E2E_WEBGL_HEAVY: '' },
      // NB: `--project=X` (with `=`) — the space form `--project X spec.ts`
      // makes Playwright parse the following positional spec as a 2nd project.
      // `--grep-invert @camera-integration` excludes the getUserMedia integration
      // describe in camera-input.spec.ts: that flow depends on the live
      // getUserMedia → 'streaming' chain, which stalls under Pass C's cumulative
      // GPU load (the camera attest flake). Only the DETERMINISTIC render-smoke
      // describe attests here; the integration describe runs in the sharded lane.
      args: ['--project=chromium-camera', '--grep-invert', '@camera-integration', ...WEBGL_CAMERA_SPECS],
      expectedSpecFiles: expectedCamera,
    }),
  );

  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  if (DRY) {
    console.log('\n[--dry-run] All passes selected + count-gated OK (no real run). NOT writing an attestation.');
    return;
  }

  // (4a) RE-VERIFY the server identity immediately before writing — a green
  // run only backs an attestation if the app that ran it is still, provably,
  // THIS worktree's (closes the server-replaced-mid-run window; #1597).
  if (ownServer) {
    await assertServerIsThisWorktree(ownServer.url, REPO_ROOT, 'webgl:attest(pre-write)');
  }

  // (4) Write the attestation — every pass green + counts matched.
  const attestation = {
    schemaVersion: 1,
    webglContentHash: hash,
    attestedAt: new Date().toISOString(),
    attestedBy: attestActor(),
    gitHeadAtAttest: gitHead(), // INFORMATIONAL only — NOT the match key
    playwrightVersion: playwrightVersion(),
    os: `${process.platform} ${release()} (${arch()})`,
    machineClass: 'local-trusted-gpu-workstation', // was hostname()
    gpu: renderer,
    // The attest booted + identity-verified its OWN app server (#1597) — the
    // per-run ephemeral port and the /__worktree identity it re-verified at
    // write time. `serverCommit` is informational (dev serves live files).
    appServer: ownServer
      ? { url: ownServer.url, mode: ownServer.mode, root: ownServer.identity.root, commit: ownServer.identity.commit }
      : undefined,
    repeatEach: REPEAT,
    suites: {
      'A-heavy': pick(results[0]),
      'A-serial': pick(results[1]),
      'B-leakers': pick(results[2]),
      'C-camera': pick(results[3]),
    },
    durationSec,
  };

  const attestDir = join(REPO_ROOT, 'ci-webgl-attest');
  const outFile = join(attestDir, `${hash}.json`);
  writeFileSync(outFile, JSON.stringify(attestation, null, 2) + '\n');
  console.log(`\nAttested ${hash}.`);
  console.log(`Wrote ci-webgl-attest/${hash}.json`);

  // PRUNE superseded attestations. CI only ever verifies the ONE hash the
  // current basis computes to, so older <hash>.json files are dead weight (git
  // retains the full history regardless). Keeping the working tree to exactly
  // the live hash kills the unbounded accumulation + the manual
  // git-rm-the-old-one step. (Across two concurrently-merging webgl PRs the dir
  // can transiently hold 2 hashes; the next attest re-prunes to 1.)
  const superseded = readdirSync(attestDir)
    .filter((f) => f.endsWith('.json') && f !== `${hash}.json`);
  for (const f of superseded) rmSync(join(attestDir, f));
  if (superseded.length > 0) {
    console.log(`Pruned ${superseded.length} superseded attestation(s) — ci-webgl-attest/ now holds only the live hash.`);
  }
  console.log(`Now:  git add -A ci-webgl-attest/  and commit it with your PR.`);

  // TEARDOWN ON THE SUCCESS PATH (#1630). The refusal paths process.exit(),
  // which fires the sync stop() exit hook — but a NORMAL return relies on the
  // event loop draining, and the un-torn-down server child KEEPS IT ALIVE:
  // the task then wedges after minting (measured: 8+ min post-write) and an
  // impatient operator's kill leaves vite/workerd ORPHANS. Await the child's
  // actual exit so the port is free before the task returns.
  await ownServer?.stopAndWait();
}

function pick(r: PassResult) {
  return {
    specFiles: r.measuredSpecFiles,
    passed: r.passed,
    failed: r.failed,
    flaky: r.flaky,
    skipped: r.skipped,
    // Per-test detail for every recovered-on-retry test — the permanent record
    // so a reviewer (and a flake-rate trend) can confirm each was transient.
    flakyDetails: r.flakyDetails,
  };
}

// ⚠ CONTENTION IS NOT A REGRESSION, AND MUST NOT PRINT LIKE ONE.
//
// The whole point of the mid-run watchdog is that `Pass A-heavy: 30 failed` and
// "another process took the GPU" are different events that used to produce
// identical output — and the wrong one got diagnosed, on a branch that did not
// even touch the failing spec. So a contention abort exits with its OWN code
// (3) and says, in as many words, that nothing here is evidence about the code.
main().catch((err: unknown) => {
  if (err instanceof ContentionAbort) {
    console.error('────────────────────────────────────────────────────────────');
    console.error(`webgl:attest ABORTED — the machine stopped being quiet DURING pass ${err.pass}.`);
    console.error(`  detected ${err.atSec}s into the pass`);
    console.error(`  GPU co-tenants: ${err.cotenants.join('  ·  ')}`);
    console.error('');
    console.error('  ⚠ THIS IS NOT A TEST RESULT. The run was killed on purpose, before it');
    console.error('  could produce failures that read as a regression — which is exactly what');
    console.error('  happened when this was only checked at START: 30 failures in one spec,');
    console.error('  on a branch that does not touch that spec, all of it contention.');
    console.error('');
    console.error('  → quit the co-tenant, then re-run. NOTHING was attested.');
    console.error('  → override (dedicated/trusted runner only): WEBGL_ATTEST_ALLOW_BUSY=1');
    console.error('────────────────────────────────────────────────────────────');
    process.exit(3);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
