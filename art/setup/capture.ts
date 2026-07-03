// art/setup/capture.ts
//
// Reusable AUDIO-PROFILE capture harness (ART backfill Phase 0 — spec:
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md §4.3).
//
// A profile scenario = (driver) → (pure-TS module core) → capture every
// SIGNATURE output → pin each as art/baselines/<group>/<name>.f32 + .sha.
//
// This lifts the proven per-scenario patterns into ONE shared helper set:
//   - `captureOutputs` — the render loop: a per-sample `tick` fed by a driver
//     (see ./drivers) fills one Float32Array per declared output at 48 kHz
//     mono (the pure-TS-core rendering path — owner decision §6b.3).
//   - `dspSourceSha`  — the multi-file source pin (the `combinedSourceSha`
//     pattern from treeohvox/voice-character.test.ts, generalized): hash the
//     worklet entry + every `-dsp.ts` lib the render depends on, so a
//     coefficient change in ANY of them invalidates the baseline.
//   - `assertBaseline` / `pinAll` — the write-or-SHA-gate-and-compare round
//     trip (lifted verbatim from analog-vco/fm-sync-model.test.ts's
//     assertBaseline): on UPDATE_BASELINES/first-run write .f32 + .sha; else
//     assert the committed .sha matches the CURRENT source sha (stale-pin
//     guard) then RMS tier-B compare against the committed .f32.
//
// Discipline reminders (memory `art-sha-pin-regenerate-last` + CLAUDE.md):
// re-pin `.sha` files as the LAST edit step of a change and confirm only
// `.sha` (not `.f32`) changed on a pure re-pin.

import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readBaseline,
  writeBaseline,
  readBaselineSha,
  writeBaselineSha,
  compareBuffers,
  SHOULD_UPDATE_BASELINES,
  SAMPLE_RATE,
  DSP_SRC_DIR,
  type ComparisonTier,
} from './render';

export { SAMPLE_RATE };

// ---------------------------------------------------------------------------
// Source-SHA pin
// ---------------------------------------------------------------------------

/**
 * Combined source SHA over one or more files under `packages/dsp/src/`
 * (paths relative to that dir, e.g. `'chowkick.ts', 'lib/chowkick-dsp.ts'`).
 * 16-hex sha256 slice, matching moduleSourceSha / the dist .sha convention.
 *
 * Pin EVERY file whose per-sample math the profile renders through — the
 * worklet entry AND its pure `-dsp.ts` lib(s) — so a change in either forces
 * an intentional re-capture (`task art:update`).
 */
export async function dspSourceSha(...relPaths: string[]): Promise<string> {
  if (relPaths.length === 0) throw new Error('dspSourceSha: no source files given');
  const h = createHash('sha256');
  for (const rel of relPaths) {
    h.update(await readFile(join(DSP_SRC_DIR, rel), 'utf8'));
  }
  return h.digest('hex').slice(0, 16);
}

/** Repo root (the directory that contains packages/, art/, e2e/, …). */
const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/**
 * Combined source SHA over files given RELATIVE TO THE REPO ROOT — the
 * dspSourceSha discipline for render paths that live (partly) OUTSIDE
 * packages/dsp/src. Pure-Web-Audio modules (no worklet) render through a
 * factory in packages/web (e.g. the moog907a/914 fixed-filter-bank fan of
 * BiquadFilterNodes), so their profiles pin the factory wiring + the shared
 * data lib, e.g.:
 *   repoSourceSha(
 *     'packages/dsp/src/lib/moog-filterbank-dsp.ts',
 *     'packages/web/src/lib/audio/modules/moog-filterbank-factory.ts',
 *   )
 */
export async function repoSourceSha(...relPaths: string[]): Promise<string> {
  if (relPaths.length === 0) throw new Error('repoSourceSha: no source files given');
  const h = createHash('sha256');
  for (const rel of relPaths) {
    h.update(await readFile(join(REPO_ROOT, rel), 'utf8'));
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Strip `// docs-hash-ignore:start … // docs-hash-ignore:end` regions — the
 * SAME marker convention (and regex) the WebGL attest uses to keep co-located
 * `docs:` prose out of its basis hash (`scripts/webgl-attest-lib.ts`
 * `stripDocsForHash`; guarded there by webgl-attest-coverage.test.ts).
 */
const DOCS_IGNORE_RE =
  /^[ \t]*\/\/ docs-hash-ignore:start[\s\S]*?^[ \t]*\/\/ docs-hash-ignore:end[ \t]*\r?\n/gm;
export function stripDocsForPin(src: string): string {
  return src.replace(DOCS_IGNORE_RE, '');
}

/**
 * `repoSourceSha` with docs-hash-ignore regions stripped first — the pin for
 * modules whose ENTIRE render path is the factory in a DOCS-BEARING def file
 * (the pure-Web-Audio pattern-3 set: no worklet, no separate factory/lib
 * file to pin instead). The moog907a/960 precedent holds that docs edits
 * must NEVER invalidate audio pins, so those defs wrap their co-located
 * `docs: {…}` block in the markers and the profile pins everything else
 * (ports, params, the factory's node graph). A def with no markers hashes
 * unchanged (the strip is a no-op).
 */
export async function docsStrippedRepoSourceSha(...relPaths: string[]): Promise<string> {
  if (relPaths.length === 0) throw new Error('docsStrippedRepoSourceSha: no source files given');
  const h = createHash('sha256');
  for (const rel of relPaths) {
    h.update(stripDocsForPin(await readFile(join(REPO_ROOT, rel), 'utf8')));
  }
  return h.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Render loop — drive + capture every signature output
// ---------------------------------------------------------------------------

export interface CaptureOptions {
  /** Render length in seconds. Spec §4.1: ~0.5 s steady sources/FX, ≥1.0 s
   *  for envelope/sequence/decay-tail modules. */
  durationS: number;
  /** The SIGNATURE outputs to capture (owner decision §6b.2 — distinct taps
   *  only, not every near-identical lane). */
  outputs: readonly string[];
  sampleRate?: number;
}

/**
 * Render `durationS` seconds at 48 kHz mono by calling `tick(i)` once per
 * sample. `tick` closes over the module core's state + the driver buffers
 * (see ./drivers) and returns one sample per declared output id.
 *
 * Returns `Record<outputId, Float32Array>` ready for `pinAll`.
 */
export function captureOutputs(
  opts: CaptureOptions,
  tick: (i: number) => Record<string, number>,
): Record<string, Float32Array> {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const n = Math.round(sr * opts.durationS);
  const bufs: Record<string, Float32Array> = {};
  for (const id of opts.outputs) bufs[id] = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const frame = tick(i);
    for (const id of opts.outputs) {
      const v = frame[id];
      if (v === undefined) throw new Error(`captureOutputs: tick() missing output '${id}' at sample ${i}`);
      bufs[id]![i] = v;
    }
  }
  return bufs;
}

// ---------------------------------------------------------------------------
// Baseline pinning (write-or-compare round trip)
// ---------------------------------------------------------------------------

export interface PinOptions {
  tier?: ComparisonTier;
  threshold?: number;
}

/**
 * The canonical baseline round-trip for one captured buffer (lifted from
 * analog-vco's assertBaseline): write on UPDATE_BASELINES/first-run, else
 * SHA-gate the pin then tier-B RMS compare against the committed .f32.
 */
export async function assertBaseline(
  scenarioId: string,
  buf: Float32Array,
  srcSha: string,
  opts: PinOptions = {},
): Promise<void> {
  const existing = await readBaseline(scenarioId);
  const existingSha = await readBaselineSha(scenarioId);
  if (SHOULD_UPDATE_BASELINES || !existing) {
    await writeBaseline(scenarioId, buf);
    await writeBaselineSha(scenarioId, srcSha);
    expect(true).toBe(true);
    return;
  }
  expect(
    existingSha,
    `Baseline SHA (${existingSha}) != source SHA (${srcSha}) for ${scenarioId}. ` +
      'Run `flox activate -- task art:update` if the DSP change was intentional, then review the .f32 diff.',
  ).toBe(srcSha);
  const cmp = compareBuffers(buf, existing, opts.tier ?? 'B', opts.threshold ?? 1e-4);
  expect(cmp.pass, `${scenarioId}: ${cmp.detail}`).toBe(true);
}

/**
 * Pin every captured output of a module profile:
 * `art/baselines/<group>/<name>.f32` + `.sha` per entry, where `group` is the
 * module's baseline group dir (kebab-case of the module type id — the
 * existing convention: analogVco → analog-vco, sampleHold → sample-hold).
 */
export async function pinAll(
  group: string,
  srcSha: string,
  buffers: Record<string, Float32Array>,
  opts: PinOptions = {},
): Promise<void> {
  const names = Object.keys(buffers);
  if (names.length === 0) throw new Error(`pinAll(${group}): no buffers to pin`);
  for (const name of names) {
    await assertBaseline(`${group}/${name}`, buffers[name]!, srcSha, opts);
  }
}

/** Baseline group dir for a module type id (kebab-case of the camelCase id —
 *  matches every existing group: analogVco→analog-vco, sampleHold→sample-hold,
 *  cube→cube). Shared with the audio-profile coverage gate. */
export function moduleIdToBaselineGroup(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
