// scripts/vrt-accept.test.ts
//
// Gate for the VRT ACCEPT path (.github/workflows/vrt-accept.yml +
// scripts/vrt-accept.mjs + the ci.yml candidates step + `task vrt:accept`).
// Pure-unit, zero-flake, runs in the `unit` lane via `task test:scripts`.
//
// ── What this path is, in one paragraph ─────────────────────────────────────
// A red vrt-strict shard's `<scene>-actual.png` is byte-for-byte what a
// `--update-snapshots=all` capture would have committed (one stabilization
// loop, one buffer, two writeFileSync destinations — playwright
// toMatchSnapshot.js). vrt-accept.yml promotes those bytes over the committed
// baselines with NO re-render; the manual validation run is commit 4600f6ed8
// (65 scenes from run 33217755378). Because no browser re-derives the pixels,
// every safety property lives in workflow structure + script logic — exactly
// the kind of thing that can be quietly edited away. This file pins them, in
// the style of vrt-update-revalidate.test.ts / vrt-revalidate-gate.test.ts.
//
// ── The four pins the task force-orders (each a real failure mode) ─────────
//  1. NO close/reopen step, ever. The accept push is made with
//     VRT_BASELINE_PUSH_TOKEN, so `pull_request` fires natively; the
//     close+reopen dance exists only to compensate for a GITHUB_TOKEN push
//     and is documented unreliable (#1694: a reopen producing NO run; #1815:
//     a parked action_required run counted as success). Copying it here
//     would re-import that failure class.
//  2. sha256 + decode verification runs BEFORE the commit. Artifact transport
//     corrupted 10/98 PNGs on run 33211181271; a corrupt baseline poisons
//     whichever gate decodes it (run 33198943725 reddened every CI run on
//     its branch). Order matters: a verification after the push is a report,
//     not a gate.
//  3. head_sha mismatch is a hard REFUSAL. An actual is only valid for the
//     commit it rendered; promoting it over a moved branch bakes a stale
//     render over new code.
//  4. The candidates step exists in the strict shard job — and ONLY there.
//     The manifest must be recorded by the job that rendered the pixels
//     (producer-side sha256 is the whole transport-integrity story); a copy
//     of the step anywhere else would record hashes of bytes that already
//     crossed a transport.
//
// ── ⚠ WHAT THIS GATE CANNOT SEE ────────────────────────────────────────────
//  · Whether GitHub honours the workflow semantics (concurrency, if:
//    failure(), artifact retention). Text is pinned, behaviour is GitHub's.
//  · Whether VRT_BASELINE_PUSH_TOKEN exists / is valid — the fallback shape
//    is asserted, but only a live push proves the PR revalidates. The
//    workflow prints a loud warning on the fallback path for exactly this.
//  · Pixel CORRECTNESS. No checker can tell "intended new design" from "the
//    canvas stopped drawing, stably" — that is what the gallery's
//    per-scene review and the next vrt-strict run (the second witness, on a
//    different VM) are for. This file only proves the plumbing cannot lie.
//
// The blindness that CANNOT hide: every assertion is anchored to text that
// must exist in the real artifact, and the non-vacuity leg pins the job/input
// sets — if the scan stops recognising a file, that leg goes red rather than
// the rest passing over an empty string.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VRT_ACCEPT_CEILING } from './vrt-accept.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPT_YML = readFileSync(join(ROOT, '.github/workflows/vrt-accept.yml'), 'utf8');
const CI_YML = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const TASKFILE = readFileSync(join(ROOT, 'Taskfile.yml'), 'utf8');
const ACCEPT_MJS = readFileSync(join(ROOT, 'scripts/vrt-accept.mjs'), 'utf8');
const MANIFEST_MJS = readFileSync(join(ROOT, 'scripts/vrt-accept-manifest.mjs'), 'utf8');
const SCRIPT = join(ROOT, 'scripts/vrt-accept.mjs');

/** Top-level job keys of a workflow file (two-space indent under `jobs:`). */
function jobNames(src: string): string[] {
  const jobsAt = src.indexOf('\njobs:');
  if (jobsAt === -1) throw new Error('no jobs: block');
  return [...src.slice(jobsAt).matchAll(/^ {2}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/gm)].map((m) => m[1]!);
}

// ── 1. workflow shape: vrt-accept.yml ───────────────────────────────────────

describe('vrt-accept.yml shape', () => {
  it('the scan is not vacuous — one job, exactly the three dispatch inputs', () => {
    // ⚠ A BARE GREEN BELOW WOULD BE INDISTINGUISHABLE FROM A BROKEN SCANNER.
    expect(jobNames(ACCEPT_YML)).toEqual(['accept']);
    const onBlock = ACCEPT_YML.slice(ACCEPT_YML.indexOf('\non:'), ACCEPT_YML.indexOf('\npermissions:'));
    const inputs = [...onBlock.matchAll(/^ {6}([a-z_]+):\s*$/gm)].map((m) => m[1]);
    expect(inputs).toEqual(['ref', 'source_run_id', 'scenes']);
    // Serialize concurrent accepts on one ref; never cancel a running one.
    expect(ACCEPT_YML).toContain('group: vrt-accept-${{ inputs.ref }}');
    expect(ACCEPT_YML).toContain('cancel-in-progress: false');
    // The push-capable checkout, PAT-first — vrt-update.yml's exact pattern.
    expect(ACCEPT_YML).toContain('token: ${{ secrets.VRT_BASELINE_PUSH_TOKEN || github.token }}');
    expect(ACCEPT_YML).toContain('lfs: true');
    expect(ACCEPT_YML).toContain('persist-credentials: true');
  });

  it('NEVER contains a close/reopen step — the PAT push makes revalidation native', () => {
    // Deny the EXECUTABLE forms, not the word: the header comments legitimately
    // DESCRIBE the close+reopen dance while forbidding it.
    const denied = [
      /gh\s+pr\s+close/,
      /gh\s+pr\s+reopen/,
      /rest\.pulls\.update/,
      /state\s*[:=]\s*["']?closed/,
    ];
    for (const rx of denied) expect(ACCEPT_YML).not.toMatch(rx);
    // …and no revalidate job to hang one off (jobNames pinned above, but say
    // it explicitly so a second job named anything close gets read here first).
    expect(jobNames(ACCEPT_YML)).not.toContain('revalidate');
  });

  it('NEGATIVE CONTROL: the close/reopen deny-list can actually see a violation', () => {
    // Validate the instrument: each pattern fires on the real-world spelling
    // it exists for (all taken from vrt-update.yml's revalidate machinery).
    expect('flox activate -- gh pr close "$PR" --comment x').toMatch(/gh\s+pr\s+close/);
    expect('gh pr reopen "$PR"').toMatch(/gh\s+pr\s+reopen/);
    expect("await github.rest.pulls.update({ state: 'closed' })").toMatch(/rest\.pulls\.update/);
    expect("state: 'closed'").toMatch(/state\s*[:=]\s*["']?closed/);
  });

  it('refuses a STALE run: the head_sha gate exists, exits hard, and runs FIRST', () => {
    expect(ACCEPT_YML).toContain('Refuse a stale source run (head_sha must equal the ref tip)');
    expect(ACCEPT_YML).toMatch(/STALE RUN[\s\S]*?exit 1/);
    const order = [
      // Step-body anchors (the run: commands), not header prose — the header
      // legitimately NAMES the script while explaining the design.
      ACCEPT_YML.indexOf('- name: Refuse a stale source run'),
      ACCEPT_YML.indexOf("- name: Download the run's candidates manifests"),
      ACCEPT_YML.indexOf('node scripts/vrt-accept.mjs'),
      ACCEPT_YML.indexOf('git commit -F'),
      ACCEPT_YML.indexOf('git push origin'),
    ];
    for (const idx of order) expect(idx).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i]!,
        'gate → download → verify → commit → push must stay in THIS order: a verification ' +
          'after the push is a report, not a gate',
      ).toBeGreaterThan(order[i - 1]!);
    }
  });

  it('stages exactly the verified list — never the whole baseline tree', () => {
    expect(ACCEPT_YML).toContain('accept-dl/accepted.txt');
    expect(ACCEPT_YML).not.toMatch(/git add (-A|--all|\.|(-- )?e2e\/vrt\/__screenshots__)\s/);
  });
});

// ── 2. verification is REUSED, not re-implemented ───────────────────────────

describe('the accept scripts share ONE PNG verifier and ONE hash story', () => {
  it('both scripts import assertDecodablePng from vrt-png-verify.mjs and neither re-parses PNGs', () => {
    for (const [name, src] of [
      ['vrt-accept.mjs', ACCEPT_MJS],
      ['vrt-accept-manifest.mjs', MANIFEST_MJS],
    ] as const) {
      expect(src, `${name} must reuse the collector's verifier`).toContain(
        "import { assertDecodablePng } from './vrt-png-verify.mjs'",
      );
      // A second decoder is a second opinion about what "valid" means — the
      // drift between two copies is how a corrupt file slips one of them.
      expect(src, `${name} re-implements PNG parsing`).not.toContain('PNG_SIGNATURE');
      expect(src, `${name} re-implements the inflate check`).not.toContain('inflateSync');
    }
  });

  it('the accept script verifies the producer sha256 and calls the mismatch what it is', () => {
    expect(ACCEPT_MJS).toContain('actual_sha256');
    expect(ACCEPT_MJS).toContain('TRANSPORT MISMATCH');
    // The artifact-name ↔ path-construction agreement across files: ci.yml
    // uploads `vrt-strict-test-results-<shard>`; the accept script LOCATES
    // actuals under exactly that directory name. If either side renames, this
    // is the line that says so before a runner does.
    expect(ACCEPT_MJS).toContain('vrt-strict-test-results-');
    expect(CI_YML).toContain('name: vrt-strict-test-results-${{ matrix.shard }}');
    expect(ACCEPT_YML).toContain("--pattern 'vrt-strict-test-results-*'");
    expect(ACCEPT_YML).toContain("--pattern 'vrt-accept-candidates-*'");
  });
});

// ── 3. the candidates step lives in the strict shard job — and only there ───

describe('ci.yml candidates step', () => {
  const shardStart = CI_YML.indexOf('\n  vrt-strict-shard:');
  const shardEnd = CI_YML.indexOf('\n  vrt-strict:\n', shardStart);
  const shardBlock = CI_YML.slice(shardStart, shardEnd);

  it('the strict shard job emits + uploads the manifest, on failure only', () => {
    expect(shardStart).toBeGreaterThan(-1);
    expect(shardEnd).toBeGreaterThan(shardStart);
    expect(shardBlock).toContain('scripts/vrt-accept-manifest.mjs');
    expect(shardBlock).toContain('name: vrt-accept-candidates-${{ matrix.shard }}');
    // Candidates only exist on a red shard; a green-run manifest would be an
    // empty artifact per shard per run for nothing.
    expect(shardBlock).toContain(
      '- name: Emit accept-candidates manifest (failing scenes → promotable actuals)\n        if: failure()',
    );
    // The json reporter feed the derivation depends on (attachment metadata,
    // not folder names) is wired on the Playwright step of the SAME job.
    expect(shardBlock).toContain('VRT_JSON_REPORT');
  });

  it('…and NOWHERE else: producer-side hashing only means anything in the producing job', () => {
    const inBlock = shardBlock.split('vrt-accept-manifest.mjs').length - 1;
    const inFile = CI_YML.split('vrt-accept-manifest.mjs').length - 1;
    expect(inBlock).toBeGreaterThan(0);
    expect(inFile).toBe(inBlock);
  });

  it('the accept gallery job reviews a red strict run without gating it', () => {
    expect(jobNames(CI_YML)).toContain('vrt-accept-gallery');
    const gStart = CI_YML.indexOf('\n  vrt-accept-gallery:');
    const gallery = CI_YML.slice(gStart, CI_YML.length);
    // Runs exactly when the shard matrix failed on a PR — the default
    // success() gate can never be true on the path the job exists for.
    expect(gallery).toContain(
      "if: always() && github.event_name == 'pull_request' && needs.vrt-strict-shard.result == 'failure'",
    );
    // Distinct CF Pages alias + distinct comment marker: must not collide
    // with the changeset gallery's vrt-pr-<N> / its marker.
    expect(gallery).toContain('--branch=vrt-accept-pr-${{ github.event.pull_request.number }}');
    expect(gallery).toContain('<!-- vrt-accept-gallery -->');
    const changeset = readFileSync(join(ROOT, '.github/workflows/vrt-changeset-gallery.yml'), 'utf8');
    expect(changeset).toContain('<!-- vrt-changeset-gallery -->');
    expect(changeset).not.toContain('vrt-accept-pr-');
  });
});

// ── 4. task vrt:accept ──────────────────────────────────────────────────────

describe('Taskfile vrt:accept', () => {
  const tStart = TASKFILE.indexOf('\n  vrt:accept:');
  const tEnd = TASKFILE.indexOf('\n  vrt:watch:', tStart);
  const block = TASKFILE.slice(tStart, tEnd);

  it('exists, dispatches the accept workflow on the branch, and derives its ceiling from the script', () => {
    expect(tStart).toBeGreaterThan(-1);
    expect(block).toContain('gh workflow run vrt-accept.yml --ref "$BRANCH"');
    expect(block).toContain('-f source_run_id=');
    expect(block).toContain('-f scenes=');
    // ONE ceiling, owned by scripts/vrt-accept.mjs. A re-typed copy here is
    // the two-numbers-tracking-each-other defect this repo keeps paying for.
    expect(block).toContain('VRT_ACCEPT_CEILING');
    expect(block).not.toMatch(/\b40\b/);
    expect(block).toContain('ACCEPT_ALL');
    // Never accept onto main — the most-regretted affordance in this product
    // category (auto-accept on the mainline).
    expect(block).toMatch(/refusing to accept baselines onto/);
  });
});

// ── 5. the accept script's decision logic, driven for real ─────────────────

// PNG fixture from primitives (vrt-png-verify.test.ts's helper) so every
// sha256 is computed against exactly what the test wrote.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(tint = 0x7f): Buffer {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(2 * (1 + 2 * 4), tint);
  raw[0] = 0;
  raw[9] = 0;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let root: string;
let cand: string;
let res: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vrt-accept-'));
  cand = join(root, 'dl/candidates');
  res = join(root, 'dl/results');
  mkdirSync(cand, { recursive: true });
  mkdirSync(res, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Cand = {
  specFile?: string;
  name: string;
  buf: Buffer;
  settled?: boolean;
  previous?: boolean;
  shaOverride?: string;
};

/** Write one shard's manifest + its actual files, gh-run-download layout. */
function shard(n: number, cands: Cand[], headSha = 'feedface') {
  const artifactDir = join(cand, `vrt-accept-candidates-${n}`);
  mkdirSync(artifactDir, { recursive: true });
  const resultsRoot = join(res, `vrt-strict-test-results-${n}`);
  const candidates = cands.map((c) => {
    const specFile = c.specFile ?? 'vrt.spec.ts';
    const folder = `vrt-shard${n}-${c.name}-chromium-vrt`;
    mkdirSync(join(resultsRoot, folder), { recursive: true });
    writeFileSync(join(resultsRoot, folder, `${c.name}-actual.png`), c.buf);
    // The accept script writes INTO the checked-out baseline tree; the
    // fixture repo root must hold the spec dir like a real checkout does.
    mkdirSync(join(root, 'e2e/vrt/__screenshots__', specFile), { recursive: true });
    return {
      key: `${specFile} :: ${c.name}`,
      name: c.name,
      spec_file: specFile,
      baseline_path: `e2e/vrt/__screenshots__/${specFile}/${c.name}.png`,
      actual_path: `${folder}/${c.name}-actual.png`,
      actual_sha256: c.shaOverride ?? sha(c.buf),
      previous_png_present: c.previous ?? false,
      settled: c.settled ?? true,
    };
  });
  writeFileSync(
    join(artifactDir, `vrt-accept-candidates-${n}.json`),
    JSON.stringify({
      schema: 'vrt-accept-candidates/v1',
      run_id: '424242',
      run_attempt: '1',
      job: 'vrt-strict-shard',
      shard: n,
      head_sha: headSha,
      cpu_model: 'AMD EPYC 7763',
      source: 'playwright-json-report',
      candidates,
      unpromotable: [],
    }),
  );
}

function runAccept(scenes: string, extra: string[] = []) {
  const messageOut = join(root, 'msg.txt');
  const acceptedOut = join(root, 'accepted.txt');
  const stdout = execFileSync(
    'node',
    [
      SCRIPT,
      '--candidates', cand,
      '--results', res,
      '--run-id', '424242',
      '--scenes', scenes,
      '--head', 'feedface',
      '--actor', 'octocat',
      '--repo-root', root,
      '--message-out', messageOut,
      '--accepted-out', acceptedOut,
      ...extra,
    ],
    { encoding: 'utf8' },
  );
  return {
    stdout,
    message: readFileSync(messageOut, 'utf8'),
    accepted: readFileSync(acceptedOut, 'utf8').split('\n').filter(Boolean),
  };
}

function expectRefusal(scenes: string, extra: string[] = []): string {
  try {
    runAccept(scenes, extra);
  } catch (e: unknown) {
    const err = e as { status: number; stderr: string };
    expect(err.status).toBe(1);
    return err.stderr;
  }
  throw new Error('vrt-accept was expected to refuse and did not');
}

describe('vrt-accept.mjs decisions', () => {
  it('happy path: verifies, copies, writes provenance naming run + sha256s', () => {
    const a = makePng(0x22);
    const b = makePng(0x44);
    shard(1, [{ name: 'moog914', buf: a }]);
    shard(2, [{ name: 'face-lfo-dock', specFile: 'workflow-shell-faces.spec.ts', buf: b }]);
    const { stdout, message, accepted } = runAccept('');
    expect(stdout).toBe('2');
    expect(accepted.sort()).toEqual([
      'e2e/vrt/__screenshots__/vrt.spec.ts/moog914.png',
      'e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-lfo-dock.png',
    ].sort());
    // The bytes really landed, verbatim.
    expect(sha(readFileSync(join(root, 'e2e/vrt/__screenshots__/vrt.spec.ts/moog914.png')))).toBe(sha(a));
    // Provenance: run id, per-scene sha256 prefixes, the no-re-render claim.
    expect(message).toContain('ACCEPT 2 baseline(s) from run 424242 [no re-render]');
    expect(message).toContain(`sha256 ${sha(a).slice(0, 12)}`);
    expect(message).toContain('AMD EPYC 7763');
    expect(message).toContain('@octocat');
  });

  it('an implicit ALL-candidates accept EXCLUDES never-settled scenes and says so in the provenance', () => {
    shard(1, [
      { name: 'steady', buf: makePng(0x22) },
      { name: 'wobbly', buf: makePng(0x44), settled: false, previous: true },
    ]);
    const { stdout, message, accepted } = runAccept('');
    expect(stdout).toBe('1');
    expect(accepted).toEqual(['e2e/vrt/__screenshots__/vrt.spec.ts/steady.png']);
    expect(existsSync(join(root, 'e2e/vrt/__screenshots__/vrt.spec.ts/wobbly.png'))).toBe(false);
    expect(message).toContain('left RED — never settled');
    expect(message).toContain('wobbly');
  });

  it('an EXPLICITLY requested never-settled scene is a refusal naming it', () => {
    shard(1, [{ name: 'wobbly', buf: makePng(0x44), settled: false, previous: true }]);
    const stderr = expectRefusal('wobbly');
    expect(stderr).toContain('wobbly');
    expect(stderr).toContain('NEVER SETTLED');
  });

  it('refuses a TRANSPORT MISMATCH (downloaded bytes != producer sha256) and stages nothing', () => {
    const buf = makePng(0x22);
    shard(1, [{ name: 'moog914', buf }]);
    // Corrupt the downloaded copy AFTER the manifest recorded its hash — the
    // exact shape of the 10-of-98 corruption on run 33211181271.
    const onDisk = join(res, 'vrt-strict-test-results-1/vrt-shard1-moog914-chromium-vrt/moog914-actual.png');
    const tampered = Buffer.from(buf);
    tampered[40] = tampered[40]! ^ 0xff;
    writeFileSync(onDisk, tampered);
    const stderr = expectRefusal('');
    expect(stderr).toContain('TRANSPORT MISMATCH');
    expect(stderr).toContain('moog914');
    expect(existsSync(join(root, 'e2e/vrt/__screenshots__/vrt.spec.ts/moog914.png'))).toBe(false);
  });

  it('refuses bytes that MATCH their recorded sha256 but do not decode (corrupt at the source)', () => {
    const corrupt = makePng(0x22).subarray(0, 40); // truncated — sha over the corrupt bytes
    shard(1, [{ name: 'moog914', buf: Buffer.from(corrupt) }]);
    const stderr = expectRefusal('');
    expect(stderr).toContain('does not decode');
  });

  it('refuses a requested scene the run does not carry, naming it', () => {
    shard(1, [{ name: 'moog914', buf: makePng(0x22) }]);
    const stderr = expectRefusal('moog915');
    expect(stderr).toContain('moog915');
    expect(stderr).toContain('not among this run');
  });

  it('a short name under two specs is ambiguous; the qualified form resolves it', () => {
    shard(1, [
      { name: 'dupe', buf: makePng(0x22) },
      { name: 'dupe', specFile: 'workflow-shell-faces.spec.ts', buf: makePng(0x44) },
    ]);
    const stderr = expectRefusal('dupe');
    expect(stderr).toContain('ambiguous');
    expect(stderr).toContain('vrt.spec.ts/dupe');
    const { accepted } = runAccept('workflow-shell-faces.spec.ts/dupe');
    expect(accepted).toEqual(['e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/dupe.png']);
  });

  it('cross-shard: byte-agreement dedupes, byte-DISAGREEMENT refuses the whole accept', () => {
    const buf = makePng(0x22);
    shard(1, [{ name: 'shared', buf }]);
    shard(2, [{ name: 'shared', buf }]);
    expect(runAccept('').stdout).toBe('1');
    rmSync(cand, { recursive: true });
    rmSync(res, { recursive: true });
    mkdirSync(cand, { recursive: true });
    shard(1, [{ name: 'shared', buf: makePng(0x22) }]);
    shard(2, [{ name: 'shared', buf: makePng(0x44) }]);
    const stderr = expectRefusal('');
    expect(stderr).toContain('CONFLICT');
  });

  it('refuses when the manifests were rendered at a DIFFERENT head_sha (stale run, second witness)', () => {
    shard(1, [{ name: 'moog914', buf: makePng(0x22) }], '0ldc0mm1t');
    const stderr = expectRefusal('');
    expect(stderr).toContain('STALE');
    expect(stderr).toContain('0ldc0mm1t');
  });

  it(`enforces the ${VRT_ACCEPT_CEILING}-scene ceiling: over it is a capture, ALL waives it deliberately`, () => {
    const buf = makePng(0x22);
    shard(1, Array.from({ length: VRT_ACCEPT_CEILING + 1 }, (_, i) => ({ name: `scene${String(i).padStart(2, '0')}`, buf })));
    const stderr = expectRefusal('');
    expect(stderr).toContain('CAPTURE, not an accept');
    expect(stderr).toContain('task vrt:commit');
    expect(runAccept('ALL').stdout).toBe(String(VRT_ACCEPT_CEILING + 1));
  });

  it('a scene already byte-identical to its baseline is reported, not re-committed', () => {
    const buf = makePng(0x22);
    shard(1, [{ name: 'moog914', buf }]);
    mkdirSync(join(root, 'e2e/vrt/__screenshots__/vrt.spec.ts'), { recursive: true });
    writeFileSync(join(root, 'e2e/vrt/__screenshots__/vrt.spec.ts/moog914.png'), buf);
    const { stdout, message, accepted } = runAccept('');
    expect(stdout).toBe('0');
    expect(accepted).toEqual([]);
    expect(message).toContain('already byte-identical');
  });
});
