// packages/web/src/lib/video/webgl-attest-coverage.test.ts
//
// FAIL-CLOSED coverage guard for the WebGL local-attestation "semaphore"
// (.claude/skills/renderer-tests/SKILL.md; fixes V3/V6/V10).
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
//   (2) every audio module def flagged `rendersWebGL: true` (CUBE/WAVESCULPT),
//   (3) every SOURCE FILE that creates a WebGL context (getContext('webgl…')),
//       module surfaces included — the scan is by CONTENT, never by filename.
// It ALSO asserts:
//   (4) the heavy WebGL spec glob still resolves the expected COUNT (so a spec is
//       never silently dropped/mis-classified) — but e2e specs are NOT hashed,
//   (5) NO `*.test.ts` AND NO `e2e/tests/**` file is in the basis — node-env unit
//       tests stay OUT (V6) and e2e test code stays OUT (2026-06-26: "changing
//       tests should not change our attest hashes"; the spec is the DRIVER, not
//       the rendered content),
//   (6) the rendersWebGL flag ↔ module-surface-getContext cross-check holds in
//       BOTH directions, so the marker can't drift away from reality. The
//       forward direction walks the module's real MOUNT SITES (the node viz
//       host, the module's own shell extension); the reverse attributes a
//       WebGL-creating surface to its owning module by DIRECTORY.
//
// Unlike the DESCRIPTIONS guards, this one is mechanical end
// to end (no hand-maintained allowlist of covered files) and FAIL-CLOSED: a
// missed file is a hard red, never a silent skip.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Side-effect barrel imports so the registries are populated.
import '$lib/audio/modules';
import '$lib/video/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
// ⚠ THE NODE RENDER-TREE ROOT (legacy-removal S1). A module whose renderer is
// mounted by the NODE rather than by one of its own surfaces is not reachable
// from the module's own files at all — see `renderTreeRootsFor` below.
import { NODE_VIZ_SURFACE_TYPES } from '$lib/ui/media/node-viz-surfaces';

import {
  resolveWebglBasis,
  resolveHeavyWebglSpecs,
  resolveAttestableHeavyWebglSpecs,
  isFullyCollabCapacityGated,
  findAllWebglSourceFiles,
  sourceCreatesWebglContext,
  stripComments,
  AUDIO_WEBGL_MODULE_DEFS,
  REPO_ROOT,
} from '../../../../../scripts/webgl-attest-lib';
import { normalizeForHashWithReport } from '../../../../../scripts/attest-code-basis';

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
// GRAPHIC EQ (new Winamp-style VU-meter video output): +graphic-eq-render-smoke.spec.ts
// (matched by the *-render-smoke glob). 44 → 45.
// +1 tempest-render-smoke.spec.ts (TEMPEST P1 vector well, already in main) and
// +1 milkdrop-render-smoke.spec.ts (butterchurn visualizer) both join via the
// `**/*-render-smoke.spec.ts` DRS glob — deterministic non-black/structured
// pixel gates. 45 → 47.
// COLOUR OF MAGIC (#1016): +colourofmagic.spec.ts (8-FBO colorspace processor —
// the bespoke spec readPixels()es all 8 output textures) and +picturebox-gif.spec.ts
// (its ANIMATES test samples the output LUMA OVER TIME to prove animated frames
// advance — a GPU-timing pixel read that #1010 mis-binned into the sharded matrix,
// where it flaked under SwiftShader contention). Both INTENTIONALLY join the heavy
// lane; e2e/webgl-heavy-globs.ts is in the hash basis, so this moved the WebGL hash
// (re-attested). 47 → 49.
// SOURCERY (2026-07-04): +sourcery.spec.ts (2-input region shape-match recolor —
// the bespoke spec wires two real video sources and readPixels()es the output FBO
// for non-black/structured/param-response). Full-res dependent-texelFetch fill →
// isolated in the serialized heavy lane; e2e/webgl-heavy-globs.ts is in the hash
// basis, so this moved the WebGL hash (re-attested). 49 → 50.
// PULL EVAL (2026-07-10): +video-pull-eval.spec.ts (sink-driven pull evaluation
// gate — engine-probe cadence asserts on a LIVE unpaused render loop plus one
// video-out canvas non-black read). It matches the existing `**/video-*.spec.ts`
// glob and genuinely belongs in the serialized lane (relies on real continuous
// rendering; reads a canvas). No edit to e2e/webgl-heavy-globs.ts, so the SET
// grew without moving the hash basis. 50 → 51.
// TOYBOX CONTROL-SURFACE (2026-07-11, #1056): +toybox-control-surface.spec.ts
// (the two toybox-booting surface tests split out of control-surface.spec.ts —
// the LEARNED-layer 60s-timeout shard-contention class). Matches the existing
// `**/toybox-*.spec.ts` glob; no globs-file edit, hash basis unmoved. 51 → 52.
// KEYER FRAMEWORK (2026-07-11, §11 change 6): +keyer-functional.spec.ts (the
// keyer-family functional validation — DRS frozen-clock gl.readPixels off
// module FBOs, previously mis-binned onto the sharded SwiftShader matrix).
// Batched into the keyer-framework PR's single re-attest. 52 → 53.
// CELLSHADE rebuild (§12 R7): +cellshade-functional.spec.ts (theory-derived
// exact-texel probes off the module's own FBO — DRS-frozen fixtures) and
// +cellshade.spec.ts (ACIDWARP→cellshade live-render canvas stats). Both
// readPixels()-class specs from the sharded-matrix contention class.
// Batched into the rebuild's single re-attest. 53 → 55.
// POSTERBOX (2026-07-11): +posterbox-functional.spec.ts (retro palette-crush —
// the theory-derived spec readPixels()es the module's output FBO for the legacy
// 3-3-2 continuity anchors, hue-order preservation, the Bayer dither checker
// block, and the mix sweep). Real-GPU pixel reads → serialized heavy lane;
// e2e/webgl-heavy-globs.ts is in the hash basis, and the new video module def
// moves the hash anyway (re-attest at merge). 55 → 56.
// PULL-EVAL REBASE (2026-07-11): #1045 (video-pull-eval, +1) reconciled onto
// main's keyer/cellshade/posterbox wave (+4). #1056 anticipated the 2-way
// reconcile to 52; main's +4 since then lands the final count at 56.
// VIDEOVARISPEED CROP (feat/videovarispeed-crop): videovarispeed-crop.spec.ts
// matches the EXISTING `**/videovarispeed-*.spec.ts` heavy glob, so the SET
// grows by one (the glob itself is unchanged, so this is a bookkeeping bump —
// the hash actually moves because the new `crop` output port lands in
// videovarispeed.ts, an in-basis file → owner re-attest at merge). 56 → 57.
// VIDEOCUBE CHROMASTACK (#1136): videocube.spec.ts is a heavy 3-input WebGL e2e
// that the broad `video-*` glob does NOT match (no dash), so it was mis-binned
// onto the sharded SwiftShader matrix; adding `**/videocube.spec.ts` to
// WEBGL_HEAVY_GLOBS enrolls it (the glob file is a STANDALONE_BASIS_FILE → the
// hash moves → the same one-time re-attest). 57 → 58.
// REMOVED 2026-08-12 (boy-scout, P0 "NEVER hand-type a population count"):
// `EXPECTED_HEAVY_SPEC_COUNT` was a typed literal whose value was HOW MANY
// heavy specs exist. Adding one unrelated e2e spec that happens to match the
// glob made this red and demanded a re-count — the exact tax the directive
// names, and a value that auto-merges WRONG when two branches each add a spec.
//
// What it actually protected, and where that protection now lives:
//   * "a spec was silently dropped / the glob broke" → (4) now asserts the
//     resolved set is NON-EMPTY, that every resolved path EXISTS on disk, and
//     that it contains no duplicates. A broken glob resolves nothing and still
//     goes red; a mis-typed pattern that resolves a non-file goes red too.
//   * "attestable == all (nothing is fully @collab/@capacity-gated)" → (4b)
//     now asserts `excluded` is EMPTY, which is the same statement as a
//     PROPERTY rather than as an arithmetic identity between two counts.
//
// ⚠ THE SIGNAL THAT IS GENUINELY GONE, recorded here so the next person to
// delete or restore this knows what they are trading (the #1458 precedent for
// MIN_TOKEN_PINNED_BASELINES). The count had a THIRD, unstated job: it was the
// only thing that went red when the ATTESTED SET changed. Editing
// `e2e/webgl-heavy-globs.ts` moves the hash mechanically because that file is a
// STANDALONE_BASIS_FILE — but ADDING A SPEC WHOSE NAME MATCHES AN EXISTING GLOB
// (e.g. a new `video-*.spec.ts`) enrols it in Pass A while moving NO hash, and
// nothing now reports that. That was judged acceptable when this was removed:
// enrolling an ADDITIONAL spec widens what the GPU semaphore covers rather than
// invalidating what it already certified, and no GL content changes. If you
// ever need the signal back, assert THE PROPERTY — e.g. pin the attested set by
// NAME in a generated artifact on an accept loop — never re-derive a size.
//
// No successor counter was written. Specs are excluded from the hash basis, so
// none of this affects the WebGL attest.

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
    // We expect exactly CUBE / WAVESCULPT today (HYPERCUBE was deleted 2026-08-10).
    expect(flagged.map((d) => d.type).sort()).toEqual(['cube', 'wavesculpt']);
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

  it('(4) the heavy WebGL spec glob resolves the expected count — but specs are NOT hashed', () => {
    const specs = resolveHeavyWebglSpecs();
    // NON-EMPTY: a broken/renamed glob resolves nothing, and a suite that
    // measures nothing must never pass vacuously.
    expect(specs.length, 'heavy WebGL spec glob resolved NOTHING — the glob is broken').toBeGreaterThan(0);
    // EVERY resolved path is a real file: a mis-typed pattern that resolves a
    // directory or a stale path is a silent mis-classification.
    const missing = specs.filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(missing, `heavy glob resolved paths that do not exist: ${missing.join(', ')}`).toEqual([]);
    // No duplicates — two overlapping globs would double-count a spec and make
    // the sharded matrix run it twice.
    const dupes = specs.filter((p, i) => specs.indexOf(p) !== i);
    expect(dupes, `heavy glob resolved duplicate specs: ${dupes.join(', ')}`).toEqual([]);
    // Specs are the attest DRIVER, not the rendered content, so they are
    // DELIBERATELY EXCLUDED from the hash basis — editing a test must never force
    // a GPU re-attest (2026-06-26). Assert the INVERSE of the old invariant: no
    // resolved heavy spec leaked into the basis.
    const leaked = specs.filter((f) => basisSet.has(f));
    expect(
      leaked,
      `heavy specs must NOT be in the hash basis (test edits must be hash-transparent): ${leaked.join(', ')}`,
    ).toEqual([]);
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
    // The attestable set is non-empty, and no heavy spec is fully
    // @collab/@capacity-gated today — stated as a PROPERTY of the excluded set
    // rather than as an identity between two counts.
    expect(attestable.length, 'the attestable heavy set is empty').toBeGreaterThan(0);
    expect(excluded, `heavy specs excluded as fully gated: ${excluded.join(', ')}`).toEqual([]);
    expect(attestable.length).toBeLessThanOrEqual(all.length);
  });

  it('(5) NO node-env *.test.ts AND no e2e/tests/** file leaked into the basis', () => {
    const tests = basis.filter((p) => p.endsWith('.test.ts'));
    expect(
      tests,
      `node-env unit tests must NOT be in the WebGL basis (they would force a ` +
        `10-min real-GPU re-attest on every node-only edit):\n  ${tests.join('\n  ')}`,
    ).toEqual([]);
    // E2E test files (specs, _helpers, _registry) are the attest DRIVER, not the
    // rendered content — excluded from the hash so editing a test is
    // hash-transparent (owner directive 2026-06-26). The attested SET is tracked
    // by e2e/webgl-heavy-globs.ts + playwright.config.ts (kept in-basis), not by
    // the spec bytes; the §12 spec-count gate above still catches silent drops.
    const e2eFiles = basis.filter((p) => p.startsWith('e2e/tests/'));
    expect(
      e2eFiles,
      `e2e/tests files must NOT be in the WebGL hash basis (a test edit must not ` +
        `force a GPU re-attest):\n  ${e2eFiles.join('\n  ')}`,
    ).toEqual([]);
  });

  /**
   * Does a card's RENDER TREE create a WebGL context — the card's own source,
   * or any `.svelte` it (transitively) imports?
   *
   * ⚠ WHY THE TREE AND NOT THE FILE. The check used to read the card file
   * alone, which silently made "the renderer must live in ONE 1200-line card"
   * a structural rule. cube's volume render is the module's whole instrument
   * and the faceplate hero has to paint the SAME picture, so it moved into
   * `cube/CubeVizSurface.svelte` and the card renders it — at which point a
   * file-scoped check calls a perfectly live flag stale. Following the imports
   * keeps the claim the check actually makes ("this module IS a GPU render
   * path") true while letting the renderer be a component.
   *
   * STILL FAIL-CLOSED: it only ever ADDS files to look at, so a module that
   * genuinely stopped rendering WebGL anywhere in its tree still reddens, and
   * the failure message prints every file it scanned so a false green is
   * inspectable rather than mysterious. The basis itself is untouched —
   * `resolveWebglBasis` walks the whole `ui/modules` tree by content, so the
   * extracted surface enrolled itself with no list to edit (which is check (3)).
   */
  function cardTreeCreatesWebglContext(cardAbs: string): { found: boolean; scanned: string[] } {
    const seen = new Set<string>();
    const scanned: string[] = [];
    const visit = (abs: string): boolean => {
      if (seen.has(abs) || !existsSync(abs)) return false;
      seen.add(abs);
      scanned.push(abs.slice(REPO_ROOT.length + 1));
      const src = readFileSync(abs, 'utf8');
      if (sourceCreatesWebglContext(src)) return true;
      // Relative `.svelte` imports only — a $lib-aliased shared primitive is a
      // control, never a renderer, and resolving the alias here would drag the
      // whole component library into every scan.
      for (const m of stripComments(src).matchAll(/from\s+['"](\.[^'"]*\.svelte)['"]/g)) {
        if (visit(resolve(dirname(abs), m[1]!))) return true;
      }
      return false;
    };
    return { found: visit(cardAbs), scanned };
  }

  /**
   * The SAME walk, EXHAUSTIVELY — every relative `.svelte` a root renders,
   * with no short-circuit on the first WebGL hit.
   *
   * ⚠ IT EXISTS BECAUSE THE SHORT-CIRCUIT MADE THE SCAN RECORD UNUSABLE AS AN
   * ANCHOR, which is a thing worth stating rather than quietly working around:
   * `cardTreeCreatesWebglContext` stops the moment it finds a context, so its
   * `scanned` list is "what it happened to read before the first hit", not "the
   * render tree". Asking that list whether it reached a particular module's
   * directory answers by import ORDER — the node host reaches wavesculpt first
   * and returns, so the identical question about cube reads as a stale roster
   * entry. This walk answers the question that was actually being asked.
   */
  function renderTreeFiles(rootAbs: string): string[] {
    const seen = new Set<string>();
    const files: string[] = [];
    const visit = (abs: string): void => {
      if (seen.has(abs) || !existsSync(abs)) return;
      seen.add(abs);
      files.push(abs.slice(REPO_ROOT.length + 1));
      const src = readFileSync(abs, 'utf8');
      for (const m of stripComments(src).matchAll(/from\s+['"](\.[^'"]*\.svelte)['"]/g)) {
        visit(resolve(dirname(abs), m[1]!));
      }
    };
    visit(rootAbs);
    return files;
  }

  /**
   * The ROOTS of a module's render tree — the files that MOUNT its renderer.
   *
   * ⚠ THE CARD WAS NEVER THE RIGHT SUBJECT, IT WAS MERELY THE ONLY ONE, AND
   * THIS LEG FOUND THAT ITSELF TWICE. `rendersWebGL` claims "this module IS a
   * GPU render path", and until legacy-removal S1 the only way to reach a
   * module's renderer was through its card. wavesculpt's renderer then moved to
   * the NODE (`$lib/ui/media/NodeVizSurfaceHost`, one mount per node) and the
   * card merely ADOPTED its canvas — so a card-rooted walk called a perfectly
   * live flag stale, one level up from the "why the tree and not the file" note
   * above. cube followed. Now the card is gone entirely and the roots are the
   * two real mount sites:
   *
   *   1. the NODE VIZ SURFACE HOST, for a module the roster actually names;
   *   2. the module's own SHELL EXTENSION entry
   *      (`modules/<face.extension>/shell-extension.ts`), the one file a module
   *      is allowed to statically import its own components from.
   *
   * STILL FAIL-CLOSED, in the direction that matters: the host is a root ONLY
   * for a rostered module, so a module that stopped rendering WebGL anywhere
   * still reddens, and a module that quietly left the roster loses the extra
   * root rather than keeping a free pass. Both root kinds import their
   * components RELATIVELY for this walk's sake — see the note in
   * `NodeVizSurfaceHost.svelte`, and `shell-extensions.ts`'s "the module OWNS
   * that file; it may statically import its own components there".
   */
  const NODE_VIZ_SURFACE_HOST = 'packages/web/src/lib/ui/media/NodeVizSurfaceHost.svelte';
  const MODULE_SURFACE_ROOT = 'packages/web/src/lib/ui/modules';
  function renderTreeRootsFor(type: string, def: unknown): string[] {
    const roots: string[] = [];
    if (NODE_VIZ_SURFACE_TYPES.has(type)) roots.push(NODE_VIZ_SURFACE_HOST);
    const ext = (def as { face?: { extension?: string } }).face?.extension;
    if (ext) roots.push(`${MODULE_SURFACE_ROOT}/${ext}/shell-extension.ts`);
    return roots;
  }

  it('(6) rendersWebGL ↔ render-tree getContext cross-check holds in both directions', () => {
    // Forward: every rendersWebGL-flagged audio module's RENDER TREE must
    // actually create a WebGL context (the flag is real, not stale).
    const flagged = listModuleDefs().filter((d) => (d as { rendersWebGL?: boolean }).rendersWebGL);
    for (const def of flagged) {
      const roots = renderTreeRootsFor(def.type, def);
      expect(
        roots,
        `module ${def.type} is flagged rendersWebGL but MOUNTS its renderer from nowhere — ` +
          'it is on no node-viz-surface roster and declares no face.extension, so there is no ' +
          'render tree to walk and the flag is unprovable',
      ).not.toEqual([]);
      const scannedAll: string[] = [];
      let found = false;
      for (const root of roots) {
        const abs = join(REPO_ROOT, root);
        expect(existsSync(abs), `render-tree root ${root} for ${def.type} not found`).toBe(true);
        const r = cardTreeCreatesWebglContext(abs);
        scannedAll.push(...r.scanned);
        if (r.found) {
          found = true;
          break;
        }
      }
      expect(
        found,
        `module ${def.type} is flagged rendersWebGL but NONE of its render-tree roots ` +
          `(${roots.join(', ')}) NOR any .svelte they render creates a WebGL context — stale ` +
          `flag. Scanned:\n  ${scannedAll.join('\n  ')}`,
      ).toBe(true);
    }

    // ⚠ THE HOST ROOT IS ANCHORED, so this leg cannot go quietly blind.
    // If the roster empties, the root stops being added and nothing above
    // would say so — the forward legs would simply pass on the other roots.
    expect(
      NODE_VIZ_SURFACE_TYPES.size,
      'no module has a node-mounted viz surface — if that is intended, delete the host ' +
        'render-tree root with the registry; if it is not, the root has silently stopped ' +
        'covering anything',
    ).toBeGreaterThan(0);
    for (const type of NODE_VIZ_SURFACE_TYPES) {
      const def = listModuleDefs().find((d) => d.type === type);
      if (!def) continue; // a video-domain surface is covered by the lib/video sweep
      expect(
        (def as { rendersWebGL?: boolean }).rendersWebGL,
        `${type}'s renderer is mounted by the node host, so its flag is only provable through ` +
          'the host root — an unflagged member would leave that root untested',
      ).toBe(true);

      // ⚠ POSITIVE CONTROL ON THE HOST ROOT: walking it must actually DESCEND
      // into this module's own surface directory. Without this the leg above
      // would pass just as happily if the host itself created a context, or if
      // the walk stopped at the first file — and the root would be proving
      // something about the host rather than about the module. Derived from the
      // walk's own scan record, so there is no path re-typed here to go stale.
      const viaHost = renderTreeFiles(join(REPO_ROOT, NODE_VIZ_SURFACE_HOST));
      const owned = viaHost.filter((f) => f.startsWith(`${MODULE_SURFACE_ROOT}/${type}/`));
      expect(
        owned,
        `the node-host render tree contains NO file under ${MODULE_SURFACE_ROOT}/${type}/, so the ` +
          `host root proves nothing about ${type}. Either the host stopped importing this ` +
          'surface RELATIVELY (the walk follows relative .svelte imports only) or the roster ' +
          `entry is stale. Walked:\n  ${viaHost.join('\n  ')}`,
      ).not.toEqual([]);
      // …and one of those files is really where the context comes from, so the
      // host is reaching the module's RENDERER rather than some sibling panel.
      expect(
        owned.some((f) => sourceCreatesWebglContext(readFileSync(join(REPO_ROOT, f), 'utf8'))),
        `the node host reaches ${type}'s directory but none of the files it renders there ` +
          `creates a WebGL context: ${owned.join(', ')}`,
      ).toBe(true);

      // ⚠ AND THE OTHER ROOTS MUST NOT REACH IT: a root that can be deleted
      // with every leg still green is a root nobody is testing. If the module's
      // own shell extension reaches a context too, the renderer has been mounted
      // a SECOND time — which for a node-owned surface is the #1587 defect, not
      // a redundancy — and the host root has stopped being load-bearing.
      for (const other of renderTreeRootsFor(type, def).filter((r) => r !== NODE_VIZ_SURFACE_HOST)) {
        const abs = join(REPO_ROOT, other);
        if (!existsSync(abs)) continue;
        const r = cardTreeCreatesWebglContext(abs);
        expect(
          r.found,
          `${type}'s render tree reaches a WebGL context from ${other} as well as from the node ` +
            'host, so the host root proves nothing. A node-owned surface must have exactly ONE ' +
            `mount site. Scanned:\n  ${r.scanned.join('\n  ')}`,
        ).toBe(false);
      }
    }

    // Reverse: every AUDIO-domain MODULE SURFACE that creates a WebGL context
    // must have its module def flagged rendersWebGL (so the marker can't be
    // missed on a new audio-domain WebGL module). Video-domain modules are
    // covered by the lib/video sweep, not the flag, so they're excluded here.
    //
    // ⚠ ATTRIBUTION IS BY DIRECTORY, which is the shell-extension glob's own
    // convention (`modules/<id>/…`) and the same string the def declares as
    // `face.extension`. A renderer sitting FLAT in `modules/` belongs to no
    // module — nothing can attribute it, so it is reported rather than skipped.
    const audioTypes = new Set(listModuleDefs().map((d) => d.type));
    const flaggedTypes = new Set(flagged.map((d) => d.type));
    const webglSurfaces = findAllWebglSourceFiles().filter((f) =>
      f.startsWith(`${MODULE_SURFACE_ROOT}/`),
    );
    // Non-vacuity: cube and wavesculpt live here, so an empty result means the
    // content scan or the prefix has broken rather than that the tree is clean.
    expect(
      webglSurfaces,
      'NO module surface creates a WebGL context — the content scan or the path prefix broke',
    ).not.toEqual([]);
    const unattributed: string[] = [];
    for (const surfacePath of webglSurfaces) {
      const rest = surfacePath.slice(MODULE_SURFACE_ROOT.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        unattributed.push(surfacePath);
        continue;
      }
      const owner = rest.slice(0, slash);
      // Only enforce the flag for AUDIO-domain modules (video modules aren't in
      // the audio registry). If the owning directory names a registered AUDIO
      // module type, that module MUST be flagged.
      if (audioTypes.has(owner)) {
        expect(
          flaggedTypes.has(owner),
          `audio-domain module surface ${surfacePath} creates a WebGL context but module ` +
            `'${owner}' is NOT flagged rendersWebGL — add rendersWebGL:true to its def`,
        ).toBe(true);
      }
    }
    expect(
      unattributed,
      'These files create a WebGL context but sit FLAT in the module-surface directory, so no ' +
        'module owns them and the flag cross-check cannot reach them:\n  ' +
        `${unattributed.join('\n  ')}\n` +
        `Move each into its module's own directory (${MODULE_SURFACE_ROOT}/<type>/), which is ` +
        'the same convention the shell-extension glob and `face.extension` already use.',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Living-docs is HASH-TRANSPARENT (owner directive 2026-06-24: "docs must not
// change attest hashes"; 2026-08-09: "docs should not need explicit ignore,
// they should be ignored by design").
//
// The mechanism is `scripts/attest-code-basis.ts` — a TypeScript AST re-emit
// that drops comments, the `docs`/`controlFamilies`/`face` def properties and
// type-only imports. There is no marker to remember and no lint to catch a
// forgotten one. The mechanism's own both-direction proof (string safety, the
// per-attest comment/docs/code legs, the raw-file scope ratchet) lives in
// `scripts/attest-code-basis.test.ts`, in the same required `unit` lane.
//
// What belongs HERE is the claim specific to THIS basis: the video modules that
// carry co-located docs really are docs-transparent, measured on the REAL files
// rather than a fixture — so a def whose docs the normalizer somehow failed to
// reach shows up here, named.
// ---------------------------------------------------------------------------
describe('webgl-attest: docs on REAL basis files are hash-transparent', () => {
  const basis = resolveWebglBasis();

  /** The basis files the normalizer actually strips a docs property from. */
  const docBearing = basis.filter((rel) => {
    if (!rel.endsWith('.ts')) return false;
    const { report } = normalizeForHashWithReport(rel, readFileSync(join(REPO_ROOT, rel), 'utf8'));
    return report.strippedProps.length > 0;
  });

  it('the doc-bearing set is non-trivial (a zero-length set passes vacuously)', () => {
    // ⚠ `>= 50` STOOD HERE (removed 2026-08-12, the no-ratchets sweep). It was
    // a hand-typed integer over the basis file list — a population that grows
    // with every new WebGL module — recording 68 at the 2026-08-09 conversion,
    // so it carried ~26 % slack and would have needed bumping eventually while
    // never catching anything the leg BELOW does not already catch by name.
    // Non-vacuity is what was actually being claimed, so it is claimed at zero;
    // the named `cube`/`wavesculpt` check on the next `it()` is what makes a
    // normalizer that silently stopped stripping impossible to miss.
    expect(docBearing.length, 'the normalizer stripped a docs prop from NOTHING').toBeGreaterThan(0);
  });

  it('the rendersWebGL AUDIO defs are among them (cube / wavesculpt)', () => {
    for (const def of AUDIO_WEBGL_MODULE_DEFS) {
      expect(docBearing, `${def} carries co-located docs that must be stripped`).toContain(def);
    }
  });

  it.each(['docs', 'controlFamilies', 'face'])(
    'no basis file leaks a def-level `%s` into the hashed content',
    (prop) => {
      const leaked: string[] = [];
      for (const rel of docBearing) {
        const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
        const { text, report } = normalizeForHashWithReport(rel, src);
        if (!report.strippedProps.includes(prop)) continue;
        // The def-level declaration is written at two-space indent; if it is
        // still there after normalisation the strip did not reach it.
        if (new RegExp(`^ {2,4}${prop}:`, 'm').test(text)) leaked.push(rel);
      }
      expect(leaked).toEqual([]);
    },
  );
});
