// packages/web/src/lib/video/webgl-attest-coverage.test.ts
//
// FAIL-CLOSED coverage guard for the WebGL local-attestation "semaphore"
// (.myrobots/plans/webgl-attestation-semaphore.md §12 / §-1 fixes V3/V6/V10).
//
// This is the load-bearing test of the whole scheme. The attestation only
// gives its ONE robust property — "editing a hashed WebGL file forces a
// re-attest or CI fails" — IF the hash basis (WEBGL_PATHS) covers EVERY file
// that renders WebGL. A file that renders WebGL but is NOT in the basis is a
// silent hole: a shader regression there moves no hash, the old attestation
// still matches, CI skips the heavy lane, and a real WebGL regression reaches
// main green (exactly the bug the original hand-listed design left open, V3).
//
// So this guard FAILS the build (it runs in the REQUIRED `unit` job) when ANY
// of these is not covered by the basis:
//   (1) every domain:'video' module def (mechanically, from the registry),
//   (2) every audio module def flagged `rendersWebGL: true` (CUBE/HYPERCUBE/
//       WAVESCULPT),
//   (3) every CARD whose source creates a WebGL context (getContext('webgl…')),
//   (4) every heavy WebGL spec the exported glob resolves.
// It ALSO asserts:
//   (5) NO `*.test.ts` is in the basis (node-env unit tests must stay OUT — V6),
//   (6) the rendersWebGL flag ↔ card-getContext cross-check holds in BOTH
//       directions, so the marker can't drift away from reality.
//
// Unlike the modules-card-map / DESCRIPTIONS guards, this one is mechanical end
// to end (no hand-maintained allowlist of covered files) and FAIL-CLOSED: a
// missed file is a hard red, never a silent skip.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Side-effect barrel imports so the registries are populated.
import '$lib/audio/modules';
import '$lib/video/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { conventionalCardName } from '$lib/ui/modules-card-map';

import {
  resolveWebglBasis,
  resolveHeavyWebglSpecs,
  resolveAttestableHeavyWebglSpecs,
  isFullyCollabCapacityGated,
  findAllWebglSourceFiles,
  sourceCreatesWebglContext,
  AUDIO_WEBGL_MODULE_DEFS,
  REPO_ROOT,
} from '../../../../../scripts/webgl-attest-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root from this test file (…/packages/web/src/lib/video → up 5).
const FROM_TEST_ROOT = resolve(__dirname, '../../../../..');

// Map an audio module type id → its source file path (the registry doesn't
// expose the file path, but our convention is one file per module under
// audio/modules/<type>.ts). We only need this for the rendersWebGL audio set,
// whose files we already know (AUDIO_WEBGL_MODULE_DEFS); this just verifies the
// flag and the file agree.

// The EXACT count of heavy-WebGL spec FILES the glob resolves (after the Phase-2
// re-bin EXCLUDEs). This is an exact guard, not a loose floor: a silent drop
// (e.g. a consolidation that accidentally deletes a kept spec, or a glob/exclude
// edit that mis-classifies one) must turn this red. Update it deliberately when a
// heavy spec is intentionally added/removed/consolidated, in lock-step with a
// fresh `task webgl:attest` (the attest count-gate uses the SAME resolver).
// Phase 2-remainder (#754 follow-up) consolidated texture-source→video-projection
// and video-output-resize→video-hide-controls, deleting 2 files: 44 → 42.
// GPU-attest rebuild Phase 0 (#864): +acidwarp-render-smoke.spec.ts (the DRS
// foundation proof, matched by the new `**/*-render-smoke.spec.ts` glob): 42 → 43.
// GPU-attest rebuild Phase 1: +7 frame.time-module DRS specs (inwards, lines,
// mandelbulb, nibbles, vfpga-runner, spirographs, textmarquee): 43 → 50.
// GPU-attest rebuild Phase 1b: +4 unblocked-deferred DRS specs (backdraft
// [freeze=1 after settle], outlines [seed + synchronous gate-spawns], peakstate
// [__peakstateVrtSeed + warmup], mandleblot [non-black view params]): 50 → 54.
// GPU-attest rebuild render-worker wave: −mandleblot.spec (its waitForTimeout
// pixel gate consolidated into the deterministic mandleblot-render-smoke.spec,
// which the *-render-smoke glob still enrolls here): 54 → 53.
// GPU-attest rebuild WAVESCULPT wave: −3 satellite specs (camera-cv/state-unity/spatial-audio → PCU in wavesculpt.test.ts): 53 → 50.
// GPU-attest rebuild Phase-2 remainder: −video-phase1.spec.ts (its LFO→param
// claim split into cv-bridge-map.test.ts PCU + the new
// destructor-render-smoke.spec.ts DRS) +destructor-render-smoke.spec.ts (matched
// by the *-render-smoke glob). Net heavy count UNCHANGED at 50 — but the basis
// FILE SET changed (one out, one in), so the attest hash moves → re-attest.
// (synesthesia-composite.spec.ts was also deleted this wave, but it was a Pass-B
// LEAKER, not a heavy-glob member, so it does not affect THIS count.)
// glsmoke-floor-expansion 2026-06-23: −3 specs RE-BINNED out of the heavy lane
// into WEBGL_HEAVY_EXCLUDE (toybox-node-controls, toybox-presets,
// videobox-performance-bundle) — they read no pixels and now pause the render
// loop, so they run cheap in the parallel matrix instead of the real-GPU attest.
// 50 → 47. (peakstate-render-smoke + wavecel-video-outs stay heavy-glob members +
// ALSO joined the SwiftShader floor.)
// glsmoke-floor-expansion wave 3 (2026-06-23): −3 more RE-BINNED to
// WEBGL_HEAVY_EXCLUDE (toybox-disk-loading, toybox-video-projection,
// video-audio-cvgate-coverage [now hardened] → shards). toybox-layer-input stays
// heavy-glob + ALSO joined the floor (main-thread bounded-step pixel read).
// toybox-new-content reclassified real-gpu-only (heavy raymarch shader pixels —
// stays); toybox-shadertoy/-node-batch/-node-menu/-layer-selector DEFERRED
// (worker-pixel / render-timing / flake — stay heavy). 47 → 44.
const EXPECTED_HEAVY_SPEC_COUNT = 44;

describe('WebGL attestation — fail-closed coverage guard (§12)', () => {
  const basis = resolveWebglBasis();
  const basisSet = new Set(basis);

  it('sanity: REPO_ROOT resolves to the repo (Taskfile.yml present)', () => {
    expect(existsSync(join(REPO_ROOT, 'Taskfile.yml'))).toBe(true);
    // and matches the path derived from this test file
    expect(REPO_ROOT).toBe(FROM_TEST_ROOT);
  });

  it('(1) every domain:video module def is covered by the basis', () => {
    // The whole packages/web/src/lib/video tree (minus *.test.ts) is in-basis,
    // so every video module def — which lives under lib/video/modules — is
    // covered by construction. Assert that construction holds: the modules dir
    // is represented in the basis and carries entries for the registered types.
    const videoTypes = listVideoModuleDefs().map((d) => d.type);
    expect(videoTypes.length).toBeGreaterThan(0);
    const videoModuleFilesInBasis = basis.filter((p) =>
      p.startsWith('packages/web/src/lib/video/modules/'),
    );
    // At least one source file per registered video module (defs + helpers).
    expect(
      videoModuleFilesInBasis.length,
      'no video module sources in basis — lib/video/** sweep is broken',
    ).toBeGreaterThanOrEqual(videoTypes.length);
    // And the engine + shared GL libs are covered.
    expect(basisSet.has('packages/web/src/lib/video/engine.ts')).toBe(true);
    expect(basisSet.has('packages/web/src/lib/video/module-registry.ts')).toBe(true);
  });

  it('(2) every rendersWebGL-flagged audio module def is covered by the basis', () => {
    const flagged = listModuleDefs().filter((d) => (d as { rendersWebGL?: boolean }).rendersWebGL);
    // We expect exactly CUBE / HYPERCUBE / WAVESCULPT today.
    expect(flagged.map((d) => d.type).sort()).toEqual(['cube', 'hypercube', 'wavesculpt']);
    // Each flagged def's source file MUST be in the basis.
    for (const f of AUDIO_WEBGL_MODULE_DEFS) {
      expect(basisSet.has(f), `rendersWebGL audio def not in basis: ${f}`).toBe(true);
    }
    // The flagged-def set and the AUDIO_WEBGL_MODULE_DEFS file set must agree in
    // size, so a newly-flagged def can't be added without also listing its file.
    expect(flagged.length).toBe(AUDIO_WEBGL_MODULE_DEFS.length);
  });

  it('(3) FAIL-CLOSED: every source file that creates a WebGL context is in the basis', () => {
    const webglSources = findAllWebglSourceFiles();
    expect(webglSources.length, 'no WebGL source files found — scan is broken').toBeGreaterThan(0);
    const uncovered = webglSources.filter((f) => !basisSet.has(f));
    expect(
      uncovered,
      `WebGL-rendering source files NOT in the hash basis (silent regression hole):\n  ${uncovered.join('\n  ')}\n` +
        `Add them to WEBGL_PATHS in scripts/webgl-attest-lib.ts (or, for an audio ` +
        `module, set rendersWebGL:true on its def + list it in AUDIO_WEBGL_MODULE_DEFS).`,
    ).toEqual([]);
  });

  it('(4) every heavy WebGL spec the exported glob resolves is in the basis', () => {
    const specs = resolveHeavyWebglSpecs();
    expect(
      specs.length,
      `heavy glob resolved ${specs.length} specs, expected exactly ${EXPECTED_HEAVY_SPEC_COUNT} ` +
        `— if you intentionally added/removed/consolidated a heavy spec, update ` +
        `EXPECTED_HEAVY_SPEC_COUNT + re-attest; if not, a spec was silently dropped/mis-classified.`,
    ).toBe(EXPECTED_HEAVY_SPEC_COUNT);
    const uncovered = specs.filter((f) => !basisSet.has(f));
    expect(uncovered, `heavy specs not in basis: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('(4b) the ATTESTABLE heavy set excludes fully @collab/@capacity-gated specs', () => {
    // Pass A runs `--grep-invert "@collab|@capacity"`, so a heavy spec whose
    // every test is @collab/@capacity-gated runs ZERO tests and Playwright never
    // registers it — the runner's measured-spec-file count would be short of the
    // raw glob count (the 48/49 false-shortfall). The attestable set subtracts
    // those, so it equals what Pass A actually runs.
    const all = resolveHeavyWebglSpecs();
    const attestable = resolveAttestableHeavyWebglSpecs();
    const excluded = all.filter((p) => !attestable.includes(p));
    // Every excluded spec must really be fully gated (no false exclusion that
    // would let a real failure hide behind an under-count).
    for (const p of excluded) {
      expect(
        isFullyCollabCapacityGated(join(REPO_ROOT, p)),
        `${p} was excluded from the attestable set but is NOT fully @collab/@capacity-gated`,
      ).toBe(true);
    }
    // And no attestable spec should itself be fully gated (it would never run).
    for (const p of attestable) {
      expect(
        isFullyCollabCapacityGated(join(REPO_ROOT, p)),
        `${p} is fully @collab/@capacity-gated but counted as attestable`,
      ).toBe(false);
    }
    // The attestable set is non-empty and ≤ the glob set. No heavy spec is fully
    // @collab/@capacity-gated today, so it currently equals the glob count.
    expect(attestable.length).toBe(EXPECTED_HEAVY_SPEC_COUNT);
    expect(attestable.length).toBeLessThanOrEqual(all.length);
  });

  it('(5) NO node-env *.test.ts file leaked into the basis (fix V6)', () => {
    const tests = basis.filter((p) => p.endsWith('.test.ts'));
    expect(
      tests,
      `node-env unit tests must NOT be in the WebGL basis (they would force a ` +
        `10-min real-GPU re-attest on every node-only edit):\n  ${tests.join('\n  ')}`,
    ).toEqual([]);
  });

  it('(6) rendersWebGL ↔ card-getContext cross-check holds in both directions', () => {
    // Forward: every rendersWebGL-flagged audio module's CARD source must
    // actually create a WebGL context (the flag is real, not stale).
    const flagged = listModuleDefs().filter((d) => (d as { rendersWebGL?: boolean }).rendersWebGL);
    for (const def of flagged) {
      // Convention: PascalCase(type) + 'Card.svelte' (override via def.card).
      const cardName = (def as { card?: string }).card ?? conventionalCardName(def.type);
      const cardPath = `packages/web/src/lib/ui/modules/${cardName}.svelte`;
      const abs = join(REPO_ROOT, cardPath);
      expect(existsSync(abs), `card for rendersWebGL module ${def.type} not found at ${cardPath}`).toBe(true);
      expect(
        sourceCreatesWebglContext(abs, true),
        `module ${def.type} is flagged rendersWebGL but ${cardPath} does NOT create a WebGL context — stale flag`,
      ).toBe(true);
    }

    // Reverse: every AUDIO-domain card that DOES create a WebGL context must
    // have its module def flagged rendersWebGL (so the marker can't be missed
    // on a new audio-domain WebGL module). Video-domain cards are covered by
    // the lib/video sweep, not the flag, so they're excluded here.
    const audioTypes = new Set(listModuleDefs().map((d) => d.type));
    const flaggedTypes = new Set(flagged.map((d) => d.type));
    const webglCards = findAllWebglSourceFiles().filter((f) =>
      f.startsWith('packages/web/src/lib/ui/modules/') && f.endsWith('Card.svelte'),
    );
    for (const cardPath of webglCards) {
      const base = cardPath.split('/').pop()!.replace(/Card\.svelte$/, '');
      const typeGuess = base.charAt(0).toLowerCase() + base.slice(1);
      // Only enforce the flag for AUDIO-domain cards (video cards aren't in the
      // audio registry). If the card's lowercased basename matches a registered
      // AUDIO module type, that module MUST be flagged.
      if (audioTypes.has(typeGuess)) {
        expect(
          flaggedTypes.has(typeGuess),
          `audio-domain card ${cardPath} creates a WebGL context but module ` +
            `'${typeGuess}' is NOT flagged rendersWebGL — add rendersWebGL:true to its def`,
        ).toBe(true);
      }
    }
  });
});
