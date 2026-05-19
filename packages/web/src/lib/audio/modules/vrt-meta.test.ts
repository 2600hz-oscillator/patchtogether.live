// packages/web/src/lib/audio/modules/vrt-meta.test.ts
//
// Coverage self-test for the Playwright VRT suite.
//
// Asserts every registered audio + video module has:
//   1. an entry in e2e/vrt/vrt.spec.ts's MODULES list
//   2. a baseline PNG under e2e/vrt/__screenshots__/vrt.spec.ts/{platform}/
//      for every platform we ship (linux + darwin)
//
// Catches the "added a new module, forgot the baseline" case in the
// vitest pass (~1s) rather than in the Playwright pass (~3min on CI),
// and well before the gallery deploys.
//
// EXEMPTED types are listed inline with a reason — currently just
// cameraInput, which can't be VRT'd without baking the synthetic-camera
// video frame into the baseline.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

// Modules that intentionally skip VRT. Each entry needs a reason +
// (where applicable) the alternative test that covers the same surface.
const EXEMPT_FROM_VRT: Record<string, string> = {
  // CAMERA renders a live MediaStream into a canvas. Even with the
  // fake-camera flag the synthetic frame is non-deterministic enough
  // (frame-time clock) that the baseline would flap. Functional coverage
  // is e2e/tests/camera-input.spec.ts.
  cameraInput: 'live MediaStream defeats deterministic capture',
  // GROUP is a Phase-1 collapse-N-modules container with no engine
  // binding. A bare GROUP! has no exposed ports → its visual surface
  // is just the card chrome + label, which carries no module-specific
  // pixels worth fingerprinting. Functional coverage is
  // e2e/tests/grouping-phase1.spec.ts.
  group: 'no-op render until exposed-ports are set by Create-Group; e2e covers the full flow',
  // CLOUDS first-slice PR (#166): VRT baseline pending; ART + unit + E2E
  // provide coverage. Promote into MODULES + capture baselines on both
  // platforms in a follow-up PR.
  clouds: 'VRT baseline pending; ART + unit + E2E provide coverage.',
  // MACSEQ — VRT baseline pending. Functional coverage is e2e/tests/macseq.spec.ts
  // which proves the headline MACSEQ→MACROOSCILLATOR MODELCV wiring works.
  // A follow-up PR will capture the darwin + linux pixel baselines.
  macseq: 'VRT baseline pending; e2e/tests/macseq.spec.ts covers MODELCV wiring',
  // RINGS first-slice PR: VRT baseline pending; ART + unit + E2E
  // provide coverage. Linux baseline is darwin-only for v1; a
  // follow-up PR will capture both platforms and promote into MODULES.
  rings: 'VRT baseline pending; ART + unit + E2E provide coverage. Linux baseline is darwin-only for v1.',
  // PEAKS first-slice PR: VRT baseline pending; ART + unit + E2E provide
  // coverage. Promote into MODULES + capture baselines on both platforms
  // in a follow-up PR.
  peaks: 'VRT baseline pending; ART + unit + E2E provide coverage.',
  // WARPS first-slice PR: VRT baseline pending; ART + unit + E2E provide
  // coverage. Promote into MODULES + capture baselines on both platforms
  // in a follow-up PR.
  warps: 'VRT baseline pending; ART + unit + E2E provide coverage.',
  // VEILS quad-VCA: VRT baseline pending; ART + unit + E2E provide coverage.
  veils: 'VRT baseline pending; ART + unit + E2E provide coverage',
  // ATTENUMIX simple mixer: VRT baseline pending; ART + unit + E2E cover it.
  // 4 attenuator faders + master + standard PatchPanel — no unique visual
  // surface beyond what VEILS already exercises; baseline can be promoted
  // in a follow-up. Same rationale as VEILS.
  attenumix: 'VRT baseline pending; ART + unit + E2E provide coverage',
  // CLOUDSEED first-slice PR: VRT baseline pending; complex card (4 panels
  // + bottom mix + preset bar). ART + unit + E2E provide coverage. Promote
  // into MODULES + capture darwin/linux baselines in a follow-up PR.
  cloudseed: 'VRT baseline pending; complex card; ART + unit + E2E provide coverage.',
  // LIVECODE is a text-DSL editor card with no ports. Its visual
  // surface is a <textarea> + Run button — the blinking caret + native
  // textarea chrome (selection rect, scrollbar fade) makes baselines
  // flap. Functional coverage is e2e/tests/livecode.spec.ts.
  livecode: 'textarea caret + native chrome defeats deterministic capture; e2e covers the run-flow',
  // HELM is a dense polyphonic synth card (~720px wide, multi-row knob
  // grid + 16-step pattern + gear-icon-toggled settings panel). Baseline
  // would need to capture both the main panel and the settings panel
  // separately, and the settings panel state depends on MIDI device list
  // (which is non-deterministic on a fresh CI runner). ART + unit + E2E
  // provide functional coverage; promote to MODULES in a follow-up PR
  // once we have a way to stub the MIDI device list deterministically.
  helm: 'VRT baseline pending; complex dense card + MIDI-dependent settings panel; ART + unit + E2E provide coverage.',
  // MIDI-CV-BUDDY card body depends on connected MIDI device (which
  // doesn't exist under VRT) — the "Connect MIDI…" empty state would
  // be the only deterministic baseline, and even that paints differently
  // once the user has previously granted permission (the card auto-
  // populates the device list on next reload). Functional coverage is
  // e2e/tests/midi-cv-buddy.spec.ts (asserts the Connect-MIDI button +
  // module mount). Real-device E2E is a known follow-up.
  midiCvBuddy: 'card content depends on connected MIDI device; unit + E2E provide coverage',
  // PONG research prototype: animated game state (ball moving) defeats a
  // deterministic single-frame baseline. Unit + ART + E2E provide coverage
  // until either (a) a deterministic-time test harness is added so VRT can
  // freeze the ball at a known position, or (b) the prototype is promoted
  // out of research/.
  pong: 'animated game state defeats deterministic capture; unit + ART + E2E provide coverage',
  // MODTRIS research prototype: same rationale as PONG — falling pieces +
  // gravity-driven state defeats deterministic single-frame capture. Unit +
  // ART + E2E provide coverage.
  modtris: 'animated game state defeats deterministic capture; unit + ART + E2E provide coverage',
  // ANALOGLOGICMATHS first-slice PR: VRT baseline pending; ART + unit + E2E
  // provide coverage. Card is small (2 attenuverter knobs + patch panel) and
  // stable; a follow-up PR will capture darwin + linux baselines once the
  // user has dogfooded any UI tweaks (multi-user testing surfaced the
  // ILLOGIC naming issue that motivated this module — give the panel a
  // beat to settle before pinning pixels).
  analogLogicMaths: 'VRT baseline pending; ART + unit + E2E provide coverage. UI is stable but new — pinning baselines in a follow-up PR.',
  // BENTBOX — CRT-emulation OUTPUT. Frame feedback + per-line sync jitter
  // animated by uTime defeats a deterministic single-frame baseline. Unit
  // + E2E provide coverage. Same gap as PONG/MODTRIS; promote once a
  // deterministic-time test harness exists.
  bentbox: 'animated CRT simulation (feedback + per-line time drift) defeats deterministic capture; unit + E2E provide coverage',
};

// Modules listed in vrt.spec.ts but missing a baseline on one or more
// platforms. Used to allow a first-slice module to ship VRT coverage on
// the author's platform while a follow-up PR captures the missing
// platform's baseline. Each entry MUST list the specific {platform}/{type}
// keys that are intentionally absent — anything else stays a hard failure.
//
// Empty: all currently-registered modules ship baselines on both
// darwin + linux. New first-slice modules whose author only had a
// darwin (or linux) box can add an entry here referencing the
// missing pair, with a follow-up PR to drop it.
const EXEMPT_BASELINE_PAIRS = new Set<string>([]);

function repoRoot(): string {
  // This file lives at packages/web/src/lib/audio/modules/. Six `..`
  // hops up = repo root. Resolved from import.meta.dirname so the
  // result is invariant to vitest's working directory.
  return resolve(import.meta.dirname, '../../../../../..');
}

function readVrtSpecModuleList(): Set<string> {
  const specPath = resolve(repoRoot(), 'e2e/vrt/vrt.spec.ts');
  const src = readFileSync(specPath, 'utf8');
  // Match `{ type: 'foo', domain: 'audio' | 'video', ... }` entries. The
  // regex is intentionally loose — we just need the `type:` value.
  const re = /\btype:\s*['"]([a-zA-Z0-9]+)['"]/g;
  const out = new Set<string>();
  for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

// Platforms we ship baselines for. Matches the {platform} substitution
// in vrt.config.ts's snapshotPathTemplate (Playwright fills it from
// process.platform). Keep in sync with the committed subdirs under
// e2e/vrt/__screenshots__/vrt.spec.ts/. Adding a new platform here
// without committing baselines will (correctly) fail this test.
const VRT_PLATFORMS = ['linux', 'darwin'] as const;

function baselinePath(type: string, platform: string): string {
  return resolve(
    repoRoot(),
    `e2e/vrt/__screenshots__/vrt.spec.ts/${platform}/${type}.png`,
  );
}

describe('VRT coverage self-test', () => {
  // Import the registration barrels so the registries are populated.
  // The web app's UI does this on first page load; in the vitest pass
  // we have to import them explicitly.
  //
  // Note: these imports must come before any test body executes. We
  // use a dynamic import inside `beforeAll` to keep the type-checker
  // happy in environments where the registration side-effects haven't
  // been triggered yet by a sibling test in the same vitest invocation.
  //
  // The audio + video module barrels self-register on first import
  // (see audio/modules/index.ts + video/modules/index.ts), so a single
  // import of each is enough.
  it('imports module barrels so registries are populated', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const total =
      listModuleDefs().length + listVideoModuleDefs().length + listMetaModuleDefs().length;
    expect(total, 'at least one module is registered').toBeGreaterThan(0);
  });

  it('every registered module is listed in vrt.spec.ts (or exempted)', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');
    const registered = [
      ...listModuleDefs().map((d) => d.type as string),
      ...listVideoModuleDefs().map((d) => d.type as string),
      ...listMetaModuleDefs().map((d) => d.type as string),
    ];
    const inSpec = readVrtSpecModuleList();
    const missing: string[] = [];
    for (const t of registered) {
      if (EXEMPT_FROM_VRT[t]) continue;
      if (!inSpec.has(t)) missing.push(t);
    }
    expect(
      missing,
      `add these to e2e/vrt/vrt.spec.ts MODULES (or add an EXEMPT_FROM_VRT entry with a reason): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every VRT-listed module has a baseline PNG on disk for every shipped platform', async () => {
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    const inSpec = readVrtSpecModuleList();
    // `${platform}/${type}` keys so the failure message names the exact
    // file the dev needs to regenerate. Cross-platform contributors will
    // typically only have one platform locally; CI runs Linux. A PR that
    // adds a baseline on one platform but forgets the other lands here
    // with a precise missing-file list.
    const missingBaseline: string[] = [];
    for (const t of inSpec) {
      for (const platform of VRT_PLATFORMS) {
        const key = `${platform}/${t}`;
        if (EXEMPT_BASELINE_PAIRS.has(key)) continue;
        if (!existsSync(baselinePath(t, platform))) missingBaseline.push(key);
      }
    }
    expect(
      missingBaseline,
      `run \`task vrt:update\` on each platform to (re)generate baselines for: ${missingBaseline.join(', ')}`,
    ).toEqual([]);
  });

  it('every exempted module has a non-empty reason', () => {
    for (const [t, reason] of Object.entries(EXEMPT_FROM_VRT)) {
      expect(reason.length, `${t} exemption needs a reason`).toBeGreaterThan(10);
    }
  });
});
