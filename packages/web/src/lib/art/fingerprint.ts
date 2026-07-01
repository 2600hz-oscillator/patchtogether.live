// packages/web/src/lib/art/fingerprint.ts
//
// Pure, dependency-free GEOMETRY for the ART "Spectral Column Print" gallery
// (plan §1.4 / Phase 3). It turns a committed uint8 fingerprint — computed
// read-only from the `.f32` ART baselines by `art/build_gallery.py` and pinned
// in `fingerprints.generated.json` — into SVG-ready bar geometry. There is NO
// FFT / audio math here: the heavy compute already ran in Python and was
// quantized to bytes. This module is the render half, and stays a pure function
// so the future `/docs/art` route (Phase 4) draws the exact committed bytes with
// zero client-side compute → fully VRT-deterministic.
//
// Unit-tested in fingerprint.test.ts (known uint8 → asserted column heights /
// peak-cap Y / meter segment counts).

/** The uint8 shape + scalar features + human labels for one ART baseline. */
export interface Fingerprint {
	/** `columnCount` log-spaced, per-baseline peak-normalized magnitude columns (0..255). */
	spectrum: number[];
	features: { crest: number; zcr: number; centroid: number };
	labels: { peakDb: number | null; rmsDb: number | null; durS: number; samples: number };
}

/** The committed manifest shape (mirrors fingerprints.generated.json). */
export interface FingerprintManifest {
	version: number;
	columnCount: number;
	freqRange: [number, number];
	sampleRate: number;
	features: Record<'crest' | 'zcr' | 'centroid', { unit: string; range: [number, number] }>;
	fingerprints: Record<string, Fingerprint>;
}

/** A single positioned bar in the SVG's coordinate space (y grows DOWN). */
export interface Column {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Lay out a fingerprint's uint8 spectrum as evenly-spaced vertical bars filling
 * a `width × height` box. Bars grow UP from the bottom (SVG y-down: a taller bar
 * has a smaller `y`). `gap` is the fraction (0..1) of each column slot left as a
 * gutter between bars (default 0.2). A uint8 of 255 fills the full height.
 */
export function fingerprintToColumns(
	spectrum: number[],
	width: number,
	height: number,
	gap = 0.2,
): Column[] {
	const n = spectrum.length;
	if (n === 0) return [];
	const g = Math.min(0.95, Math.max(0, gap));
	const slotW = width / n;
	const barW = slotW * (1 - g);
	const pad = (slotW - barW) / 2;
	return spectrum.map((v, i) => {
		const u = Math.min(255, Math.max(0, v)) / 255;
		const h = u * height;
		return { x: i * slotW + pad, y: height - h, w: barW, h };
	});
}

/** Index of the tallest column (the peak). Ties resolve to the first. */
export function peakIndex(spectrum: number[]): number {
	let idx = 0;
	let max = -Infinity;
	for (let i = 0; i < spectrum.length; i++) {
		if (spectrum[i] > max) {
			max = spectrum[i];
			idx = i;
		}
	}
	return idx;
}

/**
 * The y-coordinate of the TOP of the tallest column — where the "white peak cap"
 * marker is drawn. For a per-baseline peak-normalized spectrum (max === 255) this
 * is 0 (the cap sits at the very top); the function stays correct for arbitrary
 * input so the unit test can exercise non-normalized cases.
 */
export function peakCapY(spectrum: number[], height: number): number {
	if (spectrum.length === 0) return height;
	const max = Math.min(255, Math.max(0, Math.max(...spectrum))) / 255;
	return height - max * height;
}

/**
 * Quantize a uint8 feature value into `n` lit segments for an 8-segment meter
 * (graft #1). 0 → 0 lit; 255 → all `n` lit; linear + rounded in between.
 */
export function featureMeterSegments(u8: number, n = 8): number {
	const u = Math.min(255, Math.max(0, u8)) / 255;
	return Math.min(n, Math.max(0, Math.round(u * n)));
}
