// scripts/vrt-changeset-gallery.test.ts
//
// Covers the `--from-results` mode of the VRT diff gallery (the "fail → see what
// changed" path used by the ci.yml `vrt` job on failure). A code change that
// SHIFTS a render fails the VRT lane with the diff in Playwright's test-results
// (`*-expected.png` / `*-actual.png`) but commits no baseline PNGs, so the
// git-diff mode finds nothing — `--from-results` surfaces it. Also locks in the
// slider/onion-skin compare markup (Piece B) and the added-vs-modified split.
//
// Drives the real .mjs via child_process (like new-module.test.ts) against a
// synthetic Playwright results dir built with sharp. Output goes to an OS temp
// dir (absolute --out), so nothing touches the repo tree.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
    [SCRIPT, '--from-results', resultsDir, '--platform', 'linux', '--out', outDir, '--pr', '4242', '--json', jsonPath],
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

    // Two mismatches found, classified correctly.
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
