// packages/web/src/lib/art/fingerprints.consistency.test.ts
//
// HONESTY GUARD for the committed ART fingerprint manifest (the data behind the
// future ART Gallery). Pure fs + JSON — no python, no numpy, no FFT — so it runs
// on the plain `unit` CI lane and even on git-LFS POINTER `.f32` files (it keys
// off the file LISTING, never the audio bytes). It asserts three things:
//
//   (a) COMPLETENESS BIJECTION — every art/baselines/**/*.f32 ⟺ exactly one
//       manifest entry (mirrors vrt-meta's covered-or-exempt bijection). A new
//       baseline with no fingerprint, or a stale fingerprint for a deleted
//       baseline, fails here.
//   (b) VALIDITY — header constants + every entry: 48 uint8 columns, features +
//       labels present and in-range, per-baseline PEAK-NORMALIZED (max === 255).
//   (c) NON-STUB — no all-zero / all-constant spectrum, and the corpus is
//       "mostly distinct" (mirrors baseline-uniqueness's intent: a stub that
//       emits one shape for every baseline collapses distinctness → fails).
//   (d) PROVENANCE — every entry pins the sha256 of the `.f32` bytes it was
//       computed from, and that sha256 still matches the baseline on disk. This
//       is the one check that catches "a baseline was re-pinned but the manifest
//       was not" (the #1174 drift), and it does so WITHOUT python, numpy or LFS:
//       a git-LFS oid IS the sha256 of the content, so the pointer stub on an
//       `lfs: false` lane carries the same identity the real bytes hash to.
//
// The BYTE-EXACT regen==committed drift ratchet lives in fingerprints.check.test.ts.
// That one additionally catches COMPUTE drift (the generator's math changing),
// needs python+numpy plus materialized bytes, and therefore runs in the `art` CI
// job — where it is made non-skippable by ART_FINGERPRINTS_REQUIRED=1.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FingerprintManifest } from './fingerprint';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const BASELINES_DIR = fileURLToPath(new URL('../../../../../art/baselines/', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('./fingerprints.generated.json', import.meta.url));

// A uint8 fingerprint is lossy, so two genuinely-distinct-but-spectrally-similar
// baselines CAN collapse to one shape (today: analog-vco pw-sweep-narrow vs
// pw-sweep-wide — same long-term-average spectrum + same crest/zcr/centroid).
// One or two such legit collisions must NOT trip the guard; a STUB (one shape
// for every baseline, or a whole scenario) drops distinctness far below this.
const MIN_DISTINCT_FRACTION = 0.8;

/** Recursively collect `<scenario>/<name>` keys for every `.f32` baseline. */
function collectKeys(dir: string, prefix = ''): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
		if (ent.isDirectory()) out.push(...collectKeys(join(dir, ent.name), rel));
		else if (ent.isFile() && ent.name.endsWith('.f32')) out.push(rel.slice(0, -'.f32'.length));
	}
	return out;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FingerprintManifest;

describe('ART fingerprint manifest — consistency honesty guard', () => {
	it('has the expected header (48 cols, 20 Hz–24 kHz, 48 kHz)', () => {
		expect(manifest.version).toBe(2);
		expect(manifest.columnCount).toBe(48);
		expect(manifest.freqRange).toEqual([20, 24000]);
		expect(manifest.sampleRate).toBe(48000);
		expect(manifest.features.crest.range).toEqual([0, 26]);
		expect(manifest.features.zcr.range).toEqual([0, 0.5]);
		expect(manifest.features.centroid.range).toEqual([20, 24000]);
	});

	it('(a) completeness: every .f32 baseline ⟺ exactly one fingerprint entry', () => {
		const baselineKeys = collectKeys(BASELINES_DIR).sort();
		expect(baselineKeys.length, 'no .f32 baselines found under art/baselines/').toBeGreaterThan(0);
		const manifestKeys = Object.keys(manifest.fingerprints).sort();

		const missing = baselineKeys.filter((k) => !(k in manifest.fingerprints));
		const orphaned = manifestKeys.filter((k) => !baselineKeys.includes(k));
		expect(
			[...missing, ...orphaned],
			`fingerprint manifest is out of sync with art/baselines/ — regenerate with ` +
				`\`flox activate -- task art:fingerprints:accept\`.\n` +
				(missing.length ? `  baselines with NO fingerprint: ${missing.join(', ')}\n` : '') +
				(orphaned.length ? `  fingerprints with NO baseline: ${orphaned.join(', ')}\n` : ''),
		).toEqual([]);
		expect(manifestKeys).toEqual(baselineKeys);
	});

	// ---------------------------------------------------------------------
	// (d) PROVENANCE — the drift-proofing that #1174 needed and did not have.
	//
	// #1174 re-pinned art/baselines/delay/audio.f32 (an owner-approved
	// equal-power dry/wet fix, +3.01 dB) WITHOUT re-running
	// `task art:fingerprints:accept`. Nothing went red: the byte-exact regen
	// gate needs python+numpy AND materialized LFS bytes, so it self-skipped on
	// every CI lane, and checks (a)-(c) above only key off the file LISTING —
	// which #1174 did not change. The drift shipped to main and broke only
	// fresh LOCAL checkouts.
	//
	// This check closes that hole with NO new CI dependency: the manifest now
	// records the sha256 of the bytes it was computed from, and a git-LFS oid
	// IS the sha256 of the content — so on an `lfs: false` checkout we read the
	// identity out of the ~130-byte pointer stub, and on a real checkout we
	// hash the bytes. Same value either way. Re-pin a baseline without re-pinning
	// the manifest and this goes RED everywhere, including the plain `unit` lane.
	it('(d) provenance: every entry pins the sha256 of the .f32 it was computed from', () => {
		const LFS_MAGIC = 'version https://git-lfs.github.com/spec/v1';
		const stubbed: string[] = [];

		for (const key of collectKeys(BASELINES_DIR)) {
			const bytes = readFileSync(join(BASELINES_DIR, `${key}.f32`));
			const pinned = manifest.fingerprints[key]?.sourceSha256;

			expect(pinned, `${key}: manifest entry has no sourceSha256`).toMatch(/^[0-9a-f]{64}$/);

			// An LFS POINTER carries the content's sha256 as its oid; real bytes we
			// hash directly. Both paths yield the sha256 of the true .f32 content.
			let actual: string;
			if (bytes.subarray(0, LFS_MAGIC.length).toString('utf8') === LFS_MAGIC) {
				const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(bytes.toString('utf8'))?.[1];
				expect(oid, `${key}: LFS pointer with no parseable "oid sha256:" line`).toBeTruthy();
				actual = oid!;
				stubbed.push(key);
			} else {
				actual = createHash('sha256').update(bytes).digest('hex');
			}

			expect(
				actual,
				`${key}: the committed fingerprint was computed from DIFFERENT .f32 bytes than the ` +
					`baseline now on disk — a baseline was re-pinned without re-pinning the manifest ` +
					`(exactly what #1174 did to delay/audio). Re-pin with ` +
					`\`flox activate -- task art:fingerprints:accept\` and REVIEW the diff: a labels-only ` +
					`move is a level change, a spectrum move is a timbral change.\n` +
					`  manifest sourceSha256: ${pinned}\n` +
					`  baseline on disk:      ${actual}`,
			).toBe(pinned);
		}

		// Honesty about which path ran: on a materialized checkout NOTHING should
		// come from a pointer, and on an `lfs: false` lane everything does. A
		// partially-smudged tree is fine — but never let this test pass while
		// silently checking nothing, so require the corpus to be non-empty.
		expect(collectKeys(BASELINES_DIR).length).toBeGreaterThan(0);
		if (stubbed.length) {
			// eslint-disable-next-line no-console
			console.info(
				`[fingerprints.consistency] (d) verified ${stubbed.length} baseline(s) via git-LFS ` +
					`pointer oids (lfs:false checkout) — provenance still fully enforced.`,
			);
		}
	});

	it('(b) validity: 48 uint8 peak-normalized columns + in-range features/labels', () => {
		for (const [key, fp] of Object.entries(manifest.fingerprints)) {
			expect(fp.spectrum.length, `${key}: spectrum length`).toBe(manifest.columnCount);
			for (const v of fp.spectrum) {
				expect(Number.isInteger(v) && v >= 0 && v <= 255, `${key}: spectrum value ${v}`).toBe(true);
			}
			// per-baseline peak-normalized ⇒ the tallest column is exactly 255.
			expect(Math.max(...fp.spectrum), `${key}: not peak-normalized (max!=255)`).toBe(255);

			for (const f of ['crest', 'zcr', 'centroid'] as const) {
				const fv = fp.features[f];
				expect(Number.isInteger(fv) && fv >= 0 && fv <= 255, `${key}: feature ${f}=${fv}`).toBe(
					true,
				);
			}
			expect(Number.isInteger(fp.labels.samples) && fp.labels.samples > 0, `${key}: samples`).toBe(
				true,
			);
			expect(typeof fp.labels.durS === 'number' && fp.labels.durS > 0, `${key}: durS`).toBe(true);
			// peakDb/rmsDb are finite floats for a real render (null only if silent).
			expect(fp.labels.peakDb === null || typeof fp.labels.peakDb === 'number').toBe(true);
			expect(fp.labels.rmsDb === null || typeof fp.labels.rmsDb === 'number').toBe(true);
		}
	});

	it('(c) non-stub: no all-zero/all-constant spectrum; corpus is mostly distinct', () => {
		const entries = Object.entries(manifest.fingerprints);
		const degenerate = entries
			.filter(([, fp]) => new Set(fp.spectrum).size <= 1)
			.map(([k]) => k);
		expect(
			degenerate,
			`all-zero/all-constant spectrum ⇒ a stub or a degenerate render: ${degenerate.join(', ')}`,
		).toEqual([]);

		const distinct = new Set(entries.map(([, fp]) => fp.spectrum.join(','))).size;
		const minDistinct = Math.ceil(entries.length * MIN_DISTINCT_FRACTION);
		expect(
			distinct,
			`only ${distinct}/${entries.length} distinct fingerprint shapes (< ${minDistinct}); ` +
				`a stub is emitting the same shape for many baselines.`,
		).toBeGreaterThanOrEqual(minDistinct);
	});
});

// -------------------------------------------------------------------------
// The two STRUCTURAL fixes that keep the drift from recurring. Both are plain
// text assertions over committed config — no python, no LFS, no CI cost — and
// both exist because #1174 proved a human will re-pin one artifact and forget
// the other, and that CI will not notice if the gate can't run.
// -------------------------------------------------------------------------
describe('ART fingerprint drift — recurrence prevention is wired up', () => {
	const taskfile = readFileSync(join(REPO_ROOT, 'Taskfile.yml'), 'utf8');
	const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

	it('`task art:update` re-pins the fingerprint manifest in the same breath', () => {
		// Baselines and the manifest are ONE truth in two artifacts. Regenerating
		// baselines must regenerate the manifest, or they drift (#1174).
		const block = /^ {2}art:update:\n(?: {4}.*\n| *\n)*/m.exec(taskfile)?.[0];
		expect(block, 'no `art:update:` task found in Taskfile.yml').toBeTruthy();
		expect(
			block,
			'`task art:update` must chain `art:fingerprints:accept` — otherwise re-pinning ' +
				'ART baselines leaves fingerprints.generated.json stale, which is exactly the ' +
				'#1174 drift this manifest\'s provenance check now catches after the fact.',
		).toMatch(/art:fingerprints:accept/);
	});

	it('the ci.yml `art` job runs the drift gate, non-vacuously', () => {
		// The `art` job is the only lane with materialized LFS baselines. If the
		// gate is not invoked there it runs NOWHERE on CI — decoration, not a gate.
		const artJob = /^ {2}art:\n(?: {4}.*\n| {6,}.*\n| *\n)*/m.exec(ci)?.[0];
		expect(artJob, 'no `art:` job found in .github/workflows/ci.yml').toBeTruthy();
		expect(
			artJob,
			'the ci.yml `art` job must run `task art:fingerprints:check` — it is the only ' +
				'CI lane that materializes the LFS .f32 baselines, so it is the only place ' +
				'the byte-exact drift gate can execute at all.',
		).toMatch(/art:fingerprints:check/);
		expect(
			artJob,
			'the drift gate must run with ART_FINGERPRINTS_REQUIRED=1 so it FAILS rather ' +
				'than silently skip-passing if the baselines or numpy go missing from the job.',
		).toMatch(/ART_FINGERPRINTS_REQUIRED/);
	});
});
