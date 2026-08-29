// scripts/vrt-changeset-gallery.test.ts
//
// Covers the `--from-results` mode of the VRT diff gallery (the "fail → see what
// changed" path used by the ci.yml `vrt` job on failure). A code change that
// SHIFTS a render fails the VRT lane with the diff in Playwright's test-results
// (`*-expected.png` / `*-actual.png`) but commits no baseline PNGs, so the
// git-diff mode finds nothing — `--from-results` surfaces it. Also locks in the
// slider/onion-skin compare markup (Piece B) and the added-vs-modified split.
//
// The baseline tree is a SINGLE set (vrt.config.ts snapshotPathTemplate has no
// `{platform}` segment), so a changed baseline is identified by (spec, card) and
// the emitted paths are asserted in full below — an exact string, not a shape
// match, so a re-introduced platform segment cannot pass.
//
// Drives the real .mjs via child_process (like new-module.test.ts) against a
// synthetic Playwright results dir built with sharp. Output goes to an OS temp
// dir (absolute --out), so nothing touches the repo tree.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'vrt-changeset-gallery.mjs');

// A solid-colour PNG fixture.
async function png(path: string, rgb: [number, number, number]) {
  await sharp({
    create: { width: 48, height: 36, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } },
  })
    .png()
    .toFile(path);
}

let resultsDir: string;
let outDir: string;

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), 'vrt-results-'));
  outDir = mkdtempSync(join(tmpdir(), 'vrt-gallery-'));
});

afterEach(() => {
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

function runFromResults(): { count: string; html: string; summary: any } {
  const jsonPath = join(outDir, 'summary.json');
  const out = execFileSync(
    'node',
    [SCRIPT, '--from-results', resultsDir, '--out', outDir, '--pr', '4242', '--json', jsonPath],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return {
    count: out.trim(),
    html: readFileSync(join(outDir, 'index.html'), 'utf8'),
    summary: JSON.parse(readFileSync(jsonPath, 'utf8')),
  };
}

describe('vrt-changeset-gallery --from-results', () => {
  it('renders a modified card (OLD/NEW/DIFF + slider) and an added card from a run', async () => {
    // MODIFIED: expected (dark) vs actual (light) — a big luminance delta so
    // pixelmatch registers a non-zero diff.
    const modDir = join(resultsDir, 'vrt-composite-mixer-cv-sum-chromium-vrt');
    mkdirSync(modDir, { recursive: true });
    await png(join(modDir, 'mixer-cv-sum-expected.png'), [30, 30, 30]);
    await png(join(modDir, 'mixer-cv-sum-actual.png'), [210, 210, 210]);
    await png(join(modDir, 'mixer-cv-sum-diff.png'), [255, 0, 0]); // pw's own diff — ignored
    // ADDED: only an actual (a brand-new/missing baseline).
    const addDir = join(resultsDir, 'vrt-spec-ts-newcard-chromium-vrt');
    mkdirSync(addDir, { recursive: true });
    await png(join(addDir, 'newcard-actual.png'), [10, 90, 10]);

    const { count, html, summary } = runFromResults();

    // Both mismatches found, classified correctly. These literals are NOT
    // population counts: they are the exact contents of the fixture set this
    // test just authored two statements above (one -expected/-actual pair, one
    // lone -actual), so they cannot drift as the repo grows.
    expect(count).toBe('2');
    expect(summary.count).toBe(2);
    expect(summary.modified).toBe(1);
    expect(summary.added).toBe(1);

    const mod = summary.cards.find((c: any) => c.path.includes('mixer-cv-sum'));
    const add = summary.cards.find((c: any) => c.path.includes('newcard'));
    expect(mod.status).toBe('M');
    expect(add.status).toBe('A');
    // The modified card has a real pixel diff (luminance change is detected).
    expect(mod.diffPixels).toBeGreaterThan(0);

    // A baseline is identified by (spec, card) — the reconstructed path has NO
    // platform segment. Asserted as a whole string so a reintroduced
    // `/linux/` or `/darwin/` fails rather than slipping past a substring match.
    expect(mod.path).toBe(
      'e2e/vrt/__screenshots__/vrt-composite-mixer-cv-sum/mixer-cv-sum.png',
    );
    expect(add.path).toBe(
      'e2e/vrt/__screenshots__/vrt-spec-ts-newcard/newcard.png',
    );
    // …and the card's sub-label is the bare spec (it used to read "spec · platform").
    expect(html).toContain('<div class="path">vrt-composite-mixer-cv-sum</div>');

    // Piece B: the modified card gets the slider/onion-skin compare widget…
    expect(html).toContain('class="compare"');
    expect(html).toContain('cmp-swipe');
    expect(html).toContain('cmp-onion');
    // …exactly once (the added card has no OLD image, so no slider).
    expect((html.match(/class="compare"/g) ?? []).length).toBe(1);
    // The added card is labelled as a new baseline.
    expect(html).toContain('new baseline (no prior)');
  });

  it('emits count 0 + a clean page when the results dir has no mismatches', async () => {
    const { count, html, summary } = runFromResults();
    expect(count).toBe('0');
    expect(summary.count).toBe(0);
    expect(html).toContain('No VRT baseline changes');
  });
});

// ── the ACCEPT gallery (--candidates): the reviewing surface for a red
// vrt-strict run. Differs from bare --from-results in the one way that
// matters for a PROMOTE path: baseline paths come from the shards' manifests
// (Playwright's own attachment metadata, recorded at the source), never from
// the truncated results folder names — because these paths are what
// `task vrt:accept` will write real bytes to. Cards carry that copy-paste
// command; scenes the accept workflow would refuse (never settled) show the
// refusal INSTEAD of a command, so review surface and enforcement cannot
// disagree; and there is deliberately NO accept-all button — the full-set
// command is plain text at the very bottom (§4.5 of the promote-on-accept
// report: batch accept is how an all-black baseline shipped and passed for
// months).
describe('vrt-changeset-gallery --candidates (accept gallery)', () => {
  const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  async function pngBuf(rgb: [number, number, number]): Promise<Buffer> {
    return sharp({
      create: { width: 48, height: 36, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } },
    })
      .png()
      .toBuffer();
  }

  async function seedCandidate(opts: {
    shard: number;
    specFile: string;
    name: string;
    folder: string;
    oldRgb: [number, number, number];
    newRgb: [number, number, number];
    settled?: boolean;
  }) {
    const dir = join(resultsDir, `vrt-strict-test-results-${opts.shard}`, opts.folder);
    mkdirSync(dir, { recursive: true });
    const actual = await pngBuf(opts.newRgb);
    writeFileSync(join(dir, `${opts.name}-actual.png`), actual);
    writeFileSync(join(dir, `${opts.name}-expected.png`), await pngBuf(opts.oldRgb));
    return {
      key: `${opts.specFile} :: ${opts.name}`,
      name: opts.name,
      spec_file: opts.specFile,
      baseline_path: `e2e/vrt/__screenshots__/${opts.specFile}/${opts.name}.png`,
      actual_path: `${opts.folder}/${opts.name}-actual.png`,
      actual_sha256: sha256(actual),
      previous_png_present: !(opts.settled ?? true),
      settled: opts.settled ?? true,
    };
  }

  function writeManifest(shard: number, candidates: object[]) {
    const dir = join(resultsDir, 'candidates', `vrt-accept-candidates-${shard}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `vrt-accept-candidates-${shard}.json`),
      JSON.stringify({ schema: 'vrt-accept-candidates/v1', run_id: '99001122', shard, candidates }),
    );
  }

  it('cards carry the AUTHORITATIVE path + per-scene accept command; refusable scenes get the refusal; full-set command is bottom plain text', async () => {
    // Three scenes: a big diff, a small diff (order pin: largest first even
    // though 'aaa-small' sorts first by name), and a never-settled one. The
    // folder names are truncated garbage ON PURPOSE — nothing may parse them.
    const big = await seedCandidate({
      shard: 3, specFile: 'vrt.spec.ts', name: 'moog907a',
      folder: 'vrt-VRT-every-module-card--3cb78-g907a-card-matches-baseline-chromium-vrt',
      oldRgb: [20, 20, 20], newRgb: [240, 240, 240],
    });
    const small = await seedCandidate({
      shard: 3, specFile: 'vrt.spec.ts', name: 'aaa-small',
      folder: 'vrt-VRT-every-module-card--91ab2-small-card-matches-baseline-chromium-vrt',
      oldRgb: [20, 20, 20], newRgb: [20, 20, 24],
    });
    const wobbly = await seedCandidate({
      shard: 7, specFile: 'workflow-shell-faces.spec.ts', name: 'face-wobbly-dock',
      folder: 'workflow-shell-faces-VRT-P-bb8dc--dock-matches-baseline-chromium-vrt',
      oldRgb: [20, 20, 20], newRgb: [200, 40, 40], settled: false,
    });
    writeManifest(3, [big, small]);
    writeManifest(7, [wobbly]);

    const jsonPath = join(outDir, 'summary.json');
    const out = execFileSync(
      'node',
      [
        SCRIPT,
        '--from-results', resultsDir,
        '--candidates', join(resultsDir, 'candidates'),
        '--run-id', '99001122',
        '--out', outDir,
        '--json', jsonPath,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const summary = JSON.parse(readFileSync(jsonPath, 'utf8'));

    expect(out.trim()).toBe('3');
    // The manifest's baseline path survives verbatim — an exact string, so a
    // regression to the folder-name heuristic (which would emit
    // 'vrt-VRT-every-module-card…/moog907a.png') cannot pass.
    expect(summary.cards.map((c: any) => c.path)).toContain(
      'e2e/vrt/__screenshots__/vrt.spec.ts/moog907a.png',
    );
    // Per-card, copy-paste-ready accept commands for the SETTLED scenes…
    expect(html).toContain('task vrt:accept -- 99001122 moog907a');
    expect(html).toContain('task vrt:accept -- 99001122 aaa-small');
    expect(html).toContain('class="copycmd"');
    // …and the refusal, not a command, for the never-settled one.
    expect(html).toContain('NEVER SETTLED');
    expect(html).not.toContain('task vrt:accept -- 99001122 face-wobbly-dock');
    // Largest diff first: the big card renders before the small one despite
    // the small one's name sorting first.
    expect(html.indexOf('>moog907a<')).toBeLessThan(html.indexOf('>aaa-small<'));
    // The full-set command exists ONCE, at the bottom, as plain text — no
    // button in the footer (the copy buttons above belong to per-scene cards).
    const footerAt = html.indexOf('class="acceptall"');
    expect(footerAt).toBeGreaterThan(html.lastIndexOf('class="copycmd"'));
    const footer = html.slice(footerAt);
    expect(footer).toContain('task vrt:accept -- 99001122');
    expect(footer).not.toContain('<button');
  });
});
