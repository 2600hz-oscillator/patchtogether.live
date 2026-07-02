// packages/web/src/lib/art/fingerprints.check.test.ts
//
// The ART fingerprint DRIFT GATE — the byte-exact ratchet, mirroring the
// living-docs contract-lock gate (regenerate from source, string-compare to the
// committed golden, fail on any diff). Here the "source" is the 48 committed
// `.f32` baselines and the generator is `art/build_gallery.py --fingerprints-out`,
// so a re-render or baseline change that would move the fingerprints flips this
// red until a human re-pins with `flox activate -- task art:fingerprints:accept`
// and reviews the diff.
//
// Unlike contract-lock (pure-TS), regenerating needs python3 + numpy AND the
// materialized (not git-LFS-pointer) `.f32` bytes. Those live in the flox env
// locally + the ART CI lane, but NOT the plain `unit` CI lane — so this test
// PROBES for them and SKIPS cleanly where absent (per the plan: "numpy/scipy are
// in the flox env → runs locally, not CI-only"). The pure-fs honesty guard in
// fingerprints.consistency.test.ts still runs everywhere.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'fingerprints.generated.json');

/** Walk up from this file until we find the repo root (has art/build_gallery.py). */
function findRepoRoot(start: string): string | null {
	let dir = start;
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, 'art', 'build_gallery.py'))) return dir;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}

const REPO_ROOT = findRepoRoot(HERE);

/** Is at least one `.f32` materialized (real bytes, not a ~130-byte LFS pointer)? */
function baselinesMaterialized(baselinesDir: string): boolean {
	if (!existsSync(baselinesDir)) return false;
	for (const scenario of readdirSync(baselinesDir, { withFileTypes: true })) {
		if (!scenario.isDirectory()) continue;
		const sdir = join(baselinesDir, scenario.name);
		for (const f of readdirSync(sdir)) {
			if (!f.endsWith('.f32')) continue;
			// Real baselines are ≥ ~1 KB of float32 PCM; LFS pointers are ~130 bytes
			// of ASCII beginning `version https://git-lfs...`.
			const p = join(sdir, f);
			if (statSync(p).size > 1024 && !readFileSync(p).subarray(0, 8).equals(Buffer.from('version '))) {
				return true;
			}
		}
	}
	return false;
}

/** Probe python3 + numpy + materialized baselines; returns why we can't run. */
function probe(): { canRun: boolean; reason: string } {
	if (!REPO_ROOT) return { canRun: false, reason: 'repo root (art/build_gallery.py) not found' };
	const baselinesDir = join(REPO_ROOT, 'art', 'baselines');
	try {
		execFileSync('python3', ['-c', 'import numpy'], { stdio: 'ignore' });
	} catch {
		return { canRun: false, reason: 'python3 + numpy unavailable (expected off the flox/ART env)' };
	}
	if (!baselinesMaterialized(baselinesDir)) {
		return { canRun: false, reason: 'ART .f32 baselines are git-LFS pointers, not materialized' };
	}
	return { canRun: true, reason: '' };
}

const p = probe();
if (!p.canRun) {
	// eslint-disable-next-line no-console
	console.info(`[fingerprints.check] SKIP drift gate: ${p.reason}`);
}

describe('ART fingerprint manifest — byte-exact drift gate', () => {
	it.skipIf(!p.canRun)(
		'committed fingerprints.generated.json == a fresh python regen',
		() => {
			const tmp = join(mkdtempSync(join(tmpdir(), 'art-fp-')), 'fingerprints.generated.json');
			execFileSync(
				'python3',
				[
					join(REPO_ROOT!, 'art', 'build_gallery.py'),
					'--baseline-dir',
					join(REPO_ROOT!, 'art', 'baselines'),
					'--fingerprints-out',
					tmp,
				],
				{ stdio: 'ignore' },
			);

			const fresh = readFileSync(tmp, 'utf8');
			const committed = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, 'utf8') : '';

			if (committed !== fresh) {
				// Terse, actionable diff — first differing manifest line.
				const c = committed.split('\n');
				const f = fresh.split('\n');
				let at = 0;
				while (at < c.length && at < f.length && c[at] === f[at]) at++;
				const hint =
					`first diff at line ${at + 1}:\n` +
					`  - committed: ${JSON.stringify(c[at] ?? '<eof>')}\n` +
					`  + regen:     ${JSON.stringify(f[at] ?? '<eof>')}`;
				expect(
					committed,
					`ART fingerprint drift detected — the committed manifest no longer matches a ` +
						`fresh compute from art/baselines/**/*.f32. Re-pin with ` +
						`\`flox activate -- task art:fingerprints:accept\` and review the git diff ` +
						`(a diff = the baselines or the compute changed: accept it, or recognize a bug).\n${hint}`,
				).toBe(fresh);
			}
			expect(committed).toBe(fresh);
		},
	);
});
