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
import { getAllModuleSpecs } from '$lib/dev/module-specs';

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
