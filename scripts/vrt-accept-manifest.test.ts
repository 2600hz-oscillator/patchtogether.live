// scripts/vrt-accept-manifest.test.ts
//
// Pins for the accept-candidates PRODUCER (scripts/vrt-accept-manifest.mjs) —
// the step a failing vrt-strict shard runs to record, at the source, what
// vrt-accept.yml may later promote. Three things are load-bearing enough to
// hold with tests, because each failure mode writes REAL BYTES TO A WRONG
// PLACE or promotes a wrong render:
//
//   1. PATH DERIVATION. The baseline repo path comes from Playwright's own
//      `-expected` attachment (whose `path` is SnapshotHelper.expectedPath,
//      the absolute committed-baseline path), cross-checked against the
//      snapshotPathTemplate shape. The test-results FOLDER name is truncated
//      by Playwright (`moog907a` → `…--3cb78-g907a-…`) and must never decide
//      a path — a disagreement between the two derivations is a REFUSAL,
//      exact string against exact string.
//   2. THE PREVIOUS-PNG REFUSAL SIGNAL. `-previous.png` exists iff the render
//      never produced two identical consecutive frames; such an actual is a
//      moving frame and the accept path refuses it. The producer must carry
//      that flag per scene, from file/attachment presence, not from prose.
//   3. DEDUP vs CONFLICT. Two claims on one baseline path with identical
//      sha256 are one candidate (the run rendered the scene twice, byte-
//      stable — commit 4600f6ed8's source run had this); two claims with
//      DIFFERENT bytes are the per-VM-coin-flip signature and poison the
//      whole shard's manifest.
//
// Fixture-driven: a synthetic Playwright JSON report + results tree in an OS
// temp dir, PNGs built from primitives (same helper as vrt-png-verify.test.ts)
// so sha256s are computed against exactly what the test wrote. The CLI is
// driven via child_process like new-module.test.ts; the pure functions are
// imported directly where that is sharper.
//
// ⚠ WHAT THIS GATE CANNOT SEE: whether Playwright still shapes its JSON
// report and attachment names the way these fixtures do (attachment `name` =
// `<snapshot>-expected.png` etc., attachment `path` = the absolute baseline
// path). That contract is pinned against playwright 1.59 sources in the
// header of the .mjs; a Playwright upgrade that changes it will surface as
// zero candidates from a red run — which the reconciliation leg below turns
// into a loud refusal (an unclaimed actual on disk), not a silent no-op.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  candidatesFromReport,
  candidatesFromResultsTree,
  dedupeInPlace,
  templateBaselinePath,
} from './vrt-accept-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'vrt-accept-manifest.mjs');

// ── a minimal valid PNG, from primitives (vrt-png-verify.test.ts's helper) ──
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
/** 2×2 RGBA PNG whose pixel fill is `tint`, so two tints = two sha256s. */
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

// ── fixture plumbing ────────────────────────────────────────────────────────

let root: string; // synthetic repo root
let results: string; // synthetic e2e/vrt/test-results

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vrt-accept-manifest-'));
  results = join(root, 'e2e/vrt/test-results');
  mkdirSync(results, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** One failing screenshot assertion: results folder + report entry. */
function addFailure(opts: {
  specFile: string;
  name: string;
  folder: string;
  actual: Buffer;
  previous?: Buffer;
  expectedAttachmentPath?: string; // override to break the template check
}) {
  const dir = join(results, opts.folder);
  mkdirSync(dir, { recursive: true });
  const actualPath = join(dir, `${opts.name}-actual.png`);
  writeFileSync(actualPath, opts.actual);
  writeFileSync(join(dir, `${opts.name}-expected.png`), makePng(0x11));
  const attachments = [
    {
      name: `${opts.name}-expected.png`,
      contentType: 'image/png',
      path: opts.expectedAttachmentPath ?? join(root, templateBaselinePath(opts.specFile, opts.name)),
    },
    { name: `${opts.name}-actual.png`, contentType: 'image/png', path: actualPath },
    { name: `${opts.name}-diff.png`, contentType: 'image/png', path: join(dir, `${opts.name}-diff.png`) },
  ];
  if (opts.previous) {
    const p = join(dir, `${opts.name}-previous.png`);
    writeFileSync(p, opts.previous);
    attachments.push({ name: `${opts.name}-previous.png`, contentType: 'image/png', path: p });
  }
  return {
    title: `${opts.name} matches baseline`,
    file: opts.specFile,
    tests: [{ results: [{ status: 'failed', errors: [], attachments }] }],
  };
}

function report(...specs: object[]) {
  return { suites: [{ title: 'vrt', file: 'vrt.spec.ts', specs }] };
}

function runCli(reportObj: object, extra: string[] = []) {
  const reportPath = join(root, 'report.json');
  const outPath = join(root, 'manifest.json');
  writeFileSync(reportPath, JSON.stringify(reportObj));
  const stdout = execFileSync(
    'node',
    [SCRIPT, '--report', reportPath, '--results', results, '--out', outPath, '--shard', '3', '--repo-root', root, ...extra],
    {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_RUN_ID: '424242', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'vrt-strict-shard', VRT_HEAD_SHA: 'feedface', VRT_CPU_MODEL: 'AMD EPYC 7763' },
    },
  );
  return { stdout, manifest: JSON.parse(readFileSync(outPath, 'utf8')) };
}

function expectCliRefusal(reportObj: object): string {
  const reportPath = join(root, 'report.json');
  writeFileSync(reportPath, JSON.stringify(reportObj));
  try {
    execFileSync('node', [SCRIPT, '--report', reportPath, '--results', results, '--out', join(root, 'm.json'), '--repo-root', root], {
      encoding: 'utf8',
    });
  } catch (e: unknown) {
    const err = e as { status: number; stderr: string };
    expect(err.status).toBe(1);
    return err.stderr;
  }
  throw new Error('manifest builder was expected to refuse and did not');
}

// ── the pins ────────────────────────────────────────────────────────────────

describe('vrt-accept-manifest: path derivation', () => {
  it('derives the baseline path from the expected ATTACHMENT, exact against the template — folder names stay decoration', () => {
    const png = makePng(0x22);
    // The folder name is deliberately the TRUNCATED garbage Playwright really
    // produces (run 33217755378's shard 12: `…--3cb78-g907a-…` for moog907a).
    // If any part of the derivation reads it, this exact-string assert breaks.
    const { manifest } = runCli(
      report(
        addFailure({ specFile: 'vrt.spec.ts', name: 'moog907a', folder: 'vrt-VRT-every-module-card--3cb78-g907a-card-matches-baseline-chromium-vrt', actual: png }),
      ),
    );
    expect(manifest.schema).toBe('vrt-accept-candidates/v1');
    expect(manifest.run_id).toBe('424242');
    expect(manifest.shard).toBe(3);
    expect(manifest.head_sha).toBe('feedface');
    expect(manifest.cpu_model).toBe('AMD EPYC 7763');
    expect(manifest.candidates).toHaveLength(1);
    const c = manifest.candidates[0];
    expect(c.baseline_path).toBe('e2e/vrt/__screenshots__/vrt.spec.ts/moog907a.png');
    expect(c.actual_path).toBe('vrt-VRT-every-module-card--3cb78-g907a-card-matches-baseline-chromium-vrt/moog907a-actual.png');
    expect(c.actual_sha256).toBe(sha(png));
    expect(c.previous_png_present).toBe(false);
    expect(c.settled).toBe(true);
  });

  it('REFUSES when the attachment path and the template derivation disagree — a promote step must not guess', () => {
    const stderr = expectCliRefusal(
      report(
        addFailure({
          specFile: 'vrt.spec.ts',
          name: 'moog907a',
          folder: 'vrt-whatever-chromium-vrt',
          actual: makePng(0x22),
          // Wrong spec dir: the shape of the bug the truncation heuristic
          // would produce. Real bytes to this path would be a wrong-place write.
          expectedAttachmentPath: join(root, 'e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/moog907a.png'),
        }),
      ),
    );
    expect(stderr).toContain('moog907a');
    expect(stderr).toContain('disagrees with');
  });

  it('REFUSES an actual attachment that has no expected attachment (no path to derive)', () => {
    const png = makePng(0x22);
    const dir = join(results, 'vrt-x-chromium-vrt');
    mkdirSync(dir, { recursive: true });
    const actualPath = join(dir, 'mystery-actual.png');
    writeFileSync(actualPath, png);
    const stderr = expectCliRefusal(
      report({
        title: 'mystery',
        file: 'vrt.spec.ts',
        tests: [{ results: [{ status: 'failed', errors: [], attachments: [{ name: 'mystery-actual.png', contentType: 'image/png', path: actualPath }] }] }],
      }),
    );
    expect(stderr).toContain('mystery');
    expect(stderr).toContain('NO expected attachment');
  });

  it('REFUSES an actual ON DISK that no report failure claims — report and tree must describe the same run', () => {
    const dir = join(results, 'vrt-orphan-chromium-vrt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'orphan-actual.png'), makePng(0x22));
    const stderr = expectCliRefusal(report());
    expect(stderr).toContain('not claimed by any report failure');
    expect(stderr).toContain('orphan-actual.png');
  });

  it('a failing test with NO snapshot attachments is recorded as unpromotable, not silently dropped', () => {
    // The "unrecognised content at end of stream" class: the screenshot
    // pipeline died before writing an actual (15 of 80 scenes on run
    // 33217755378). Nothing to promote, but the manifest must SAY the scene
    // is red for a non-pixel reason.
    const { manifest } = runCli(
      report({ title: 'died-before-write', file: 'vrt.spec.ts', tests: [{ results: [{ status: 'failed', errors: [{ message: 'unrecognised content at end of stream' }], attachments: [] }] }] }),
    );
    expect(manifest.candidates).toHaveLength(0);
    expect(manifest.unpromotable).toEqual([
      { spec_file: 'vrt.spec.ts', test_title: 'died-before-write', reason: 'no-snapshot-attachments' },
    ]);
  });
});

describe('vrt-accept-manifest: the previous-png (never-settled) signal', () => {
  it('flags a scene whose loop wrote -previous.png — the accept path refuses these', () => {
    const { manifest } = runCli(
      report(
        addFailure({ specFile: 'vrt.spec.ts', name: 'wobbly', folder: 'vrt-wobbly-chromium-vrt', actual: makePng(0x22), previous: makePng(0x33) }),
      ),
    );
    const c = manifest.candidates[0];
    expect(c.previous_png_present).toBe(true);
    expect(c.settled).toBe(false);
  });

  it('also trips on the error STRING when the attachment is missing (belt + braces)', () => {
    // Reuse addFailure's on-disk fixture (which writes NO -previous.png), but
    // re-wrap its attachments in a result that carries the never-settled
    // error text — the flag must go false off the STRING alone.
    const spec = addFailure({ specFile: 'vrt.spec.ts', name: 'wobbly', folder: 'vrt-wobbly-chromium-vrt', actual: makePng(0x22) });
    const attachments = spec.tests[0]!.results[0]!.attachments;
    const failures = candidatesFromReport({
      report: report({
        title: 'wobbly',
        file: 'vrt.spec.ts',
        tests: [
          {
            results: [
              {
                status: 'failed',
                errors: [{ message: 'Failed to take two consecutive stable screenshots.' }],
                attachments,
              },
            ],
          },
        ],
      }),
      resultsDir: results,
      repoRoot: root,
    });
    expect(failures.candidates[0]!.previous_png_present).toBe(false);
    expect(failures.candidates[0]!.settled).toBe(false);
  });
});

describe('vrt-accept-manifest: dedup vs conflict', () => {
  it('two byte-identical claims on one baseline collapse to ONE candidate', () => {
    const png = makePng(0x22);
    const { manifest } = runCli(
      report(
        addFailure({ specFile: 'vrt.spec.ts', name: 'twice', folder: 'vrt-twice-a-chromium-vrt', actual: png }),
        addFailure({ specFile: 'vrt.spec.ts', name: 'twice', folder: 'vrt-twice-b-chromium-vrt', actual: png }),
      ),
    );
    expect(manifest.candidates).toHaveLength(1);
    expect(manifest.candidates[0].actual_sha256).toBe(sha(png));
  });

  it('two DIFFERENT renders of one baseline are a CONFLICT — the whole manifest is refused', () => {
    const stderr = expectCliRefusal(
      report(
        addFailure({ specFile: 'vrt.spec.ts', name: 'twice', folder: 'vrt-twice-a-chromium-vrt', actual: makePng(0x22) }),
        addFailure({ specFile: 'vrt.spec.ts', name: 'twice', folder: 'vrt-twice-b-chromium-vrt', actual: makePng(0x44) }),
      ),
    );
    expect(stderr).toContain('CONFLICT');
    expect(stderr).toContain('e2e/vrt/__screenshots__/vrt.spec.ts/twice.png');
  });

  it('NEGATIVE CONTROL: dedupeInPlace itself distinguishes agree from disagree', () => {
    // Validate the instrument: both branches, directly.
    const agree = [
      { baseline_path: 'p', actual_sha256: 'aaa' },
      { baseline_path: 'p', actual_sha256: 'aaa' },
    ];
    const problems: string[] = [];
    dedupeInPlace(agree, problems);
    expect(agree).toHaveLength(1);
    expect(problems).toEqual([]);
    const disagree = [
      { baseline_path: 'p', actual_sha256: 'aaa' },
      { baseline_path: 'p', actual_sha256: 'bbb' },
    ];
    dedupeInPlace(disagree, problems);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('CONFLICT');
  });
});

describe('vrt-accept-manifest: --from-results-tree fallback (pre-JSON-report artifact sets)', () => {
  function seedBaseline(specFile: string, name: string) {
    const dir = join(root, 'e2e/vrt/__screenshots__', specFile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), makePng(0x11));
  }

  it('places an actual by its NAME in the committed tree, corroborated by the folder slug', () => {
    seedBaseline('vrt.spec.ts', 'moog907a');
    const png = makePng(0x22);
    const dir = join(results, 'vrt-VRT-every-module-card--3cb78-g907a-card-matches-baseline-chromium-vrt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'moog907a-actual.png'), png);
    const { candidates } = candidatesFromResultsTree({ resultsDir: results, repoRoot: root });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.baseline_path).toBe('e2e/vrt/__screenshots__/vrt.spec.ts/moog907a.png');
    expect(candidates[0]!.actual_sha256).toBe(sha(png));
  });

  it('REFUSES an ambiguous name (committed under two specs) and an unknown name (a NEW scene)', () => {
    seedBaseline('vrt.spec.ts', 'dupe');
    seedBaseline('workflow-shell-faces.spec.ts', 'dupe');
    const dir = join(results, 'vrt-dupe-chromium-vrt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dupe-actual.png'), makePng(0x22));
    writeFileSync(join(dir, 'brand-new-actual.png'), makePng(0x22));
    expect(() => candidatesFromResultsTree({ resultsDir: results, repoRoot: root })).toThrow(
      /ambiguous[\s\S]*no committed baseline|no committed baseline[\s\S]*ambiguous/,
    );
  });

  it('REFUSES when the folder slug does not corroborate the tree-derived spec', () => {
    seedBaseline('workflow-shell-faces.spec.ts', 'face-thing-dock');
    const dir = join(results, 'vrt-something-chromium-vrt'); // wrong spec's slug
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'face-thing-dock-actual.png'), makePng(0x22));
    expect(() => candidatesFromResultsTree({ resultsDir: results, repoRoot: root })).toThrow(/not corroborated/);
  });
});
