// packages/web/src/lib/docs/module-manifest.test.ts
//
// Unit tests for the docs module-manifest generator. These run against the
// REAL packages/web/src/lib/audio/modules/ source tree because that's the
// shape we ship; a synthetic fixture would just duplicate the parser's own
// test surface. The assertions are deliberately structural, not pinned to
// exact module counts, so adding a new module doesn't break this file.

import { describe, expect, it, test } from 'vitest';
import { buildModuleManifest } from './module-manifest';
import '$lib/audio/modules'; // side-effect: registers all module defs
import '$lib/video/modules'; // video defs too — the drift gate covers all domains
import '$lib/meta/modules'; // meta defs too
import { getAllModuleSpecs } from '$lib/dev/module-specs';
import {
  explainInputPort,
  explainOutputPort,
  explainParam,
  type ExplainPort,
  type ExplainParam,
} from './io-explain';

// The cable types io-explain gives a real human label to (cableTypeLabel in
// io-explain.ts). A port whose type is NOT here falls through to the raw type
// name — the drift signal: a newly-registered cable type that nobody taught
// io-explain about. Keep in lock-step with io-explain.ts:cableTypeLabel.
const KNOWN_CABLE_TYPES = new Set([
  'audio',
  'cv',
  'pitch',
  'gate',
  'modsignal',
  'polyPitchGate',
  'keys',
  'image',
  'mono-video',
  'video',
]);

// Registry-driven exclusion: getAllModuleSpecs() reads the LIVE registries,
// which only contain SPAWNABLE cards (internal `*-engine`/`*-types`/`*-draw`
// support files never call registerModule, so they're already absent). This
// explicit list is the escape hatch for any registered-but-special module
// type that legitimately shouldn't be held to the I/O-explanation contract
// (e.g. a non-card meta organizational node). Empty today — add a type id
// with a one-line reason if one ever needs it.
const DRIFT_EXEMPT = new Set<string>([]);

const m = buildModuleManifest();

describe('buildModuleManifest', () => {
  it('emits a non-empty manifest with the expected top-level shape', () => {
    expect(m.moduleCount).toBeGreaterThanOrEqual(19);
    expect(m.modules).toHaveLength(m.moduleCount);
    expect(m.categories.length).toBeGreaterThan(0);
    expect(m.warnings).toEqual([]);
    expect(typeof m.generatedAt).toBe('string');
  });

  it('every module has a type, label, category, description, and a sourceUrl', () => {
    for (const mod of m.modules) {
      expect(mod.type).toBeTruthy();
      expect(mod.label).toBeTruthy();
      expect(mod.category).toBeTruthy();
      expect(mod.description).toBeTruthy();
      expect(mod.sourceUrl).toMatch(/^https:\/\/github\.com\/.+\.ts$/);
    }
  });

  // GUARD: every discovered module must carry a real, hand-written
  // description in DESCRIPTIONS — never the describeModule() fallback
  // placeholder. The docs site (/docs/modules + /docs/modules/[id]) renders
  // straight from this manifest, so a module missing a DESCRIPTIONS entry
  // ships a "Add a one-line description ..." placeholder to the live docs.
  // This test fails the build the moment a new module lands without one,
  // so description-less modules can't regress in.
  it('NO module falls through to the description placeholder (every module documented)', () => {
    // The exact sentinel emitted by describeModule() when DESCRIPTIONS has
    // no entry for a module type.
    const FALLBACK_MARKER =
      'Add a one-line description in packages/web/src/lib/docs/module-manifest.ts:DESCRIPTIONS';
    const undocumented = m.modules
      .filter((mod) => mod.description.includes(FALLBACK_MARKER))
      .map((mod) => `${mod.type} (${mod.file})`);
    expect(
      undocumented,
      `Modules missing a real DESCRIPTIONS entry: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  it('sequencer has the expected inputs / outputs / params (spot check vs registry)', () => {
    const seq = m.modules.find((x) => x.type === 'sequencer');
    expect(seq).toBeDefined();
    if (!seq) return;
    expect(seq.inputs.map((p) => p.id)).toEqual(expect.arrayContaining(['clock']));
    expect(seq.outputs.map((p) => p.id)).toEqual(expect.arrayContaining(['pitch', 'gate']));
    // Each port note is populated from PORT_NOTES or the type-based fallback
    for (const p of [...seq.inputs, ...seq.outputs]) {
      expect(p.note).toBeTruthy();
    }
  });

  it('auto I/O section: adsr CV inputs explain modulation + cvScale (docs-overhaul §3c)', () => {
    const adsr = m.modules.find((x) => x.type === 'adsr');
    expect(adsr).toBeDefined();
    if (!adsr) return;
    // The `io` field is the SINGLE source of truth the doc page renders.
    const gate = adsr.io.inputs.find((p) => p.id === 'gate');
    expect(gate?.explain, 'gate explanation').toMatch(/gate \/ trigger/);
    const attack = adsr.io.inputs.find((p) => p.id === 'attack');
    expect(attack?.explain, 'attack explanation').toMatch(/modulates attack/);
    // adsr's attack CV declares cvScale: { mode: 'log' } → multiplicative text.
    expect(attack?.explain).toMatch(/multiplicative|octaves/);
    const env = adsr.io.outputs.find((p) => p.id === 'env');
    expect(env?.explain, 'env output explanation').toMatch(/control voltage/);
  });

  it('auto I/O section: a stereo-pair module notes L/R normaling', () => {
    // kickdrum declares stereoPairs [['audio_l','audio_r']] (verified in the
    // registry manifest). The doc parser should pick it up + io-explain
    // should note the L-only auto-duplicate on the L side.
    const kick = m.modules.find((x) => x.type === 'kickdrum');
    expect(kick, 'kickdrum present').toBeDefined();
    if (!kick) return;
    expect(kick.stereoPairs, 'kickdrum stereoPairs parsed').toEqual([['audio_l', 'audio_r']]);
    // audio_l / audio_r are OUTPUTS (the stereo voice bus). The output
    // explainer notes the pair membership.
    const left = kick.io.outputs.find((p) => p.id === 'audio_l');
    expect(left?.explain, 'audio_l explanation').toMatch(/stereo pair with audio_r/);

    // clouds declares two pairs incl. a stereo INPUT pair (in_l/in_r); the
    // input explainer notes the L-only auto-duplicate-to-R normaling.
    const clouds = m.modules.find((x) => x.type === 'clouds');
    expect(clouds, 'clouds present').toBeDefined();
    if (!clouds) return;
    expect(clouds.stereoPairs).toEqual([
      ['in_l', 'in_r'],
      ['out_l', 'out_r'],
    ]);
    const inL = clouds.io.inputs.find((p) => p.id === 'in_l');
    expect(inL?.explain, 'in_l explanation').toMatch(/auto-duplicates to R/);
  });

  it('analogVco exposes saw / square / triangle / sine outputs', () => {
    const vco = m.modules.find((x) => x.type === 'analogVco');
    expect(vco).toBeDefined();
    if (!vco) return;
    const ids = vco.outputs.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['saw', 'square', 'triangle', 'sine']));
    expect(vco.inputs.map((p) => p.id)).toEqual(expect.arrayContaining(['pitch', 'fm']));
  });

  it('singleton modules (timelorde) carry maxInstances === 1', () => {
    const tl = m.modules.find((x) => x.type === 'timelorde');
    expect(tl?.maxInstances).toBe(1);
  });

  it('mixmstrs is NOT capped to a single instance (multiple master buses allowed)', () => {
    const mix = m.modules.find((x) => x.type === 'mixmstrs');
    expect(mix?.maxInstances ?? Infinity).not.toBe(1);
  });

  it('mixmstrs synthesizes ports/params via the build-helper fallback', () => {
    const mix = m.modules.find((x) => x.type === 'mixmstrs');
    expect(mix).toBeDefined();
    if (!mix) return;
    // 6 channels L+R + 2 stereo returns = 16 audio inputs; assert >= 12
    // (6 channel pairs) to leave room if the helper grows.
    const audioIn = mix.inputs.filter((p) => p.type === 'audio');
    expect(audioIn.length).toBeGreaterThanOrEqual(12);
    // 61 params (per the description string) — assert >= 55 to leave room
    // if the helper grows.
    expect(mix.params.length).toBeGreaterThanOrEqual(55);
  });

  it('audioOut is a terminal output with two mono inputs and zero outputs', () => {
    const out = m.modules.find((x) => x.type === 'audioOut');
    expect(out).toBeDefined();
    if (!out) return;
    expect(out.outputs).toEqual([]);
    expect(out.inputs.map((p) => p.id)).toEqual(expect.arrayContaining(['L', 'R']));
  });

  it('modules are stably sorted by category order then label', () => {
    const order = ['sources', 'modulation', 'filters', 'effects', 'utilities', 'output'];
    const indexes = m.modules.map((mod) => {
      const i = order.indexOf(mod.category);
      return i < 0 ? 999 : i;
    });
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]).toBeGreaterThanOrEqual(indexes[i - 1]);
    }
  });
});

// ----------------------------------------------------------------------------
// I/O-spec consistency: published manifest <-> registered module def.
//
// Catches drift introduced by:
//  - Adding a new port to the def but forgetting to update the manifest's
//    build-helper synthesizer (relevant for modules with computed inputs).
//  - Renaming a port id without updating PORT_NOTES (the parser still emits
//    the renamed id, so this checks the registry is the single source of
//    truth).
//
// The reverse direction (UI handles match the def) is enforced by the
// e2e/tests/io-spec-consistency.spec.ts harness.
// ----------------------------------------------------------------------------
describe('manifest stays in sync with module defs', () => {
  // The manifest emitter walks `../audio/modules/*.ts` only — video +
  // meta module defs are out of scope. Filter the spec list so we
  // don't false-fail when a sibling test (or production code) has
  // already triggered the side-effect import of `$lib/video/modules`
  // and populated the cross-domain registry. The manifest's
  // audio-only scope is the design — video gets its own docs surface.
  const audioSpecs = getAllModuleSpecs().filter((s) => s.domain === 'audio');
  for (const spec of audioSpecs) {
    test(`${spec.type}: manifest input/output ids match def`, () => {
      const mod = m.modules.find((x) => x.type === spec.type);
      expect(mod, `manifest entry for ${spec.type}`).toBeDefined();
      if (!mod) return;
      expect(
        mod.inputs.map((p) => p.id).sort(),
        `${spec.type} input ids`,
      ).toEqual(spec.inputs.map((p) => p.id).sort());
      expect(
        mod.outputs.map((p) => p.id).sort(),
        `${spec.type} output ids`,
      ).toEqual(spec.outputs.map((p) => p.id).sort());
    });
  }
});

// ----------------------------------------------------------------------------
// I/O-EXPLANATION DRIFT GATE (docs-overhaul §5).
//
// The auto-generated Inputs & Outputs section renders io-explain's output for
// every declared port + param. This gate FAILS CI the moment a module's port
// or param can't be explained — so the docs can never silently drift into a
// "raw type name" or empty cell:
//   * every port's cable type must be one io-explain gives a human label to
//     (a NEW registered cable type that nobody taught io-explain fails here),
//   * every port + param must yield a NON-EMPTY explanation string.
//
// Runs against the LIVE registry (getAllModuleSpecs, schemaVersion-2 enriched)
// across ALL domains — so internal `*-engine`/`*-types` support files (which
// never registerModule) are inherently excluded, and the explicit DRIFT_EXEMPT
// set is the registry-driven escape hatch for any special registered type.
// ----------------------------------------------------------------------------
describe('I/O-explanation drift gate (every port + param explains)', () => {
  const specs = getAllModuleSpecs().filter((s) => !DRIFT_EXEMPT.has(s.type));

  it('covers a non-trivial number of spawnable modules across domains', () => {
    expect(specs.length).toBeGreaterThan(60);
  });

  for (const spec of specs) {
    test(`${spec.type}: every port has a known cable type`, () => {
      const unknown = [...spec.inputs, ...spec.outputs]
        .filter((p) => !KNOWN_CABLE_TYPES.has(p.type))
        .map((p) => `${p.id} (${p.type})`);
      expect(
        unknown,
        `${spec.type}: ports with a cable type io-explain can't label ` +
          `(teach io-explain.ts:cableTypeLabel + KNOWN_CABLE_TYPES): ${unknown.join(', ')}`,
      ).toEqual([]);
    });

    test(`${spec.type}: every port + param yields a non-empty explanation`, () => {
      const empties: string[] = [];
      for (const p of spec.inputs) {
        if (!explainInputPort(p as ExplainPort).trim()) empties.push(`input ${p.id}`);
      }
      for (const p of spec.outputs) {
        if (!explainOutputPort(p as ExplainPort).trim()) empties.push(`output ${p.id}`);
      }
      for (const p of spec.params) {
        if (!explainParam(p as ExplainParam).trim()) empties.push(`param ${p.id}`);
      }
      expect(
        empties,
        `${spec.type}: ports/params with no explanation: ${empties.join(', ')}`,
      ).toEqual([]);
    });

    test(`${spec.type}: every cv input with a paramTarget produces a modulation explanation`, () => {
      const missing = spec.inputs
        .filter((p) => p.type === 'cv' && p.paramTarget)
        .filter((p) => !/modulates/.test(explainInputPort(p as ExplainPort)))
        .map((p) => p.id);
      expect(
        missing,
        `${spec.type}: cv inputs with a paramTarget but no "modulates" explanation: ${missing.join(', ')}`,
      ).toEqual([]);
    });
  }
});
