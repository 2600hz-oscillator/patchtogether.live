// packages/web/src/lib/art/fingerprint.test.ts
//
// Pure-unit coverage for the ART fingerprint GEOMETRY (fingerprint.ts) — the
// "unit for the ART-viz compute" the Phase-3 plan requires. Known uint8 input →
// asserted bar geometry / peak-cap Y / meter segment counts. No fs, no python,
// no FFT: fully deterministic, ~0 CI wall-time.

import { describe, it, expect } from 'vitest';
import {
	fingerprintToColumns,
	peakIndex,
	peakCapY,
	featureMeterSegments,
} from './fingerprint';

describe('fingerprintToColumns', () => {
	it('maps uint8 heights into evenly-spaced bars (255 = full height)', () => {
		// gap=0 → bars fill their whole slot, so the math is exact.
		const cols = fingerprintToColumns([0, 128, 255], 30, 100, 0);
		expect(cols).toHaveLength(3);
		const slotW = 30 / 3; // 10
		// x is the left edge of each 10px slot.
		expect(cols.map((c) => c.x)).toEqual([0, 10, 20]);
		expect(cols.map((c) => c.w)).toEqual([10, 10, 10]);
		// 0 → zero height, sitting on the baseline (y === height).
		expect(cols[0]).toMatchObject({ y: 100, h: 0 });
		// 128/255 → ~50.2% height; y = height - h (bars grow up).
		expect(cols[1].h).toBeCloseTo((128 / 255) * 100, 6);
		expect(cols[1].y).toBeCloseTo(100 - (128 / 255) * 100, 6);
		// 255 → full height, top at y=0.
		expect(cols[2]).toMatchObject({ y: 0, h: 100 });
	});

	it('applies a gutter fraction, keeping bars centered in their slot', () => {
		const cols = fingerprintToColumns([255, 255], 20, 50, 0.2);
		const slotW = 20 / 2; // 10
		const barW = slotW * 0.8; // 8
		expect(cols[0].w).toBeCloseTo(barW, 6);
		expect(cols[0].x).toBeCloseTo((slotW - barW) / 2, 6); // 1px pad
		expect(cols[1].x).toBeCloseTo(slotW + (slotW - barW) / 2, 6); // 11
	});

	it('clamps out-of-range bytes and handles the empty case', () => {
		expect(fingerprintToColumns([], 10, 10)).toEqual([]);
		const cols = fingerprintToColumns([300, -5], 10, 100, 0);
		expect(cols[0].h).toBeCloseTo(100, 6); // 300 clamps to 255 → full
		expect(cols[1].h).toBeCloseTo(0, 6); // -5 clamps to 0
	});
});

describe('peakIndex + peakCapY', () => {
	it('finds the tallest column (first on a tie)', () => {
		expect(peakIndex([0, 128, 255])).toBe(2);
		expect(peakIndex([255, 10, 255])).toBe(0);
		expect(peakIndex([5, 5, 5])).toBe(0);
	});

	it('a peak-normalized spectrum (max 255) caps at the very top (y=0)', () => {
		expect(peakCapY([0, 128, 255], 100)).toBeCloseTo(0, 6);
	});

	it('a non-normalized spectrum caps proportional to its own max', () => {
		expect(peakCapY([0, 128], 100)).toBeCloseTo(100 - (128 / 255) * 100, 6);
		expect(peakCapY([], 100)).toBe(100);
	});
});

describe('featureMeterSegments', () => {
	it('quantizes a uint8 into 0..n lit segments', () => {
		expect(featureMeterSegments(0, 8)).toBe(0);
		expect(featureMeterSegments(255, 8)).toBe(8);
		expect(featureMeterSegments(128, 8)).toBe(4); // round(4.01)
		expect(featureMeterSegments(255, 4)).toBe(4);
		expect(featureMeterSegments(0, 4)).toBe(0);
		expect(featureMeterSegments(64, 8)).toBe(2); // round(2.008)
	});

	it('clamps out-of-range input and never exceeds n', () => {
		expect(featureMeterSegments(1000, 8)).toBe(8);
		expect(featureMeterSegments(-10, 8)).toBe(0);
	});
});
