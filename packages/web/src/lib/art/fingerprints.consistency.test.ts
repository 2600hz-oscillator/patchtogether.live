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
//
// The BYTE-EXACT regen==committed drift ratchet lives in fingerprints.check.test.ts
// (that one needs python+numpy and skips where they are absent).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FingerprintManifest } from './fingerprint';

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
		expect(manifest.version).toBe(1);
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
