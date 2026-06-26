// packages/web/src/lib/docs/doc-index-from-def.test.ts
//
// Contract for buildDocIndexFromDef — the LIVE-registry adapter that the
// on-canvas "Annotate" mode uses to resolve a hovered control/port to its
// authored doc straight from the live AudioModuleDef. It must produce the SAME
// flat DocIndex the doc PAGE builds from the prerender-safe manifest, so the two
// surfaces never drift — crucially the CV→param DUAL link (adsr `attack` CV jack
// → the `attack` faceplate control's authored prose) — and it must return null
// for an undocumented module (annotate is gated on authored docs).

import { describe, it, expect } from 'vitest';
import { buildDocIndexFromDef } from './doc-index-from-def';
import { buildDocIndex } from './doc-index';
import { buildModuleManifest } from './module-manifest';
import { adsrDef } from '$lib/audio/modules/adsr';
import { analogVcoDef } from '$lib/audio/modules/analog-vco';

describe('buildDocIndexFromDef — documented module (adsr)', () => {
  const index = buildDocIndexFromDef(adsrDef);

  it('builds a non-null index for a module with authored docs', () => {
    expect(index).not.toBeNull();
  });

  it('exposes the attack control with name, range and authored prose', () => {
    const attack = index!.controls.attack;
    expect(attack).toBeDefined();
    expect(attack.kind).toBe('param');
    expect(attack.name).toBe('A'); // ParamDef label
    expect(attack.range).toContain('0.001');
    expect(attack.desc).toBeTruthy();
  });

  it('carries the CV→param DUAL link on the attack CV input', () => {
    const attackIn = index!.inputs.attack;
    expect(attackIn).toBeDefined();
    expect(attackIn.cable).toBe('cv');
    expect(attackIn.paramTarget).toBeDefined();
    expect(attackIn.paramTarget!.id).toBe('attack');
    expect(attackIn.paramTarget!.name).toBe('A');
    // Same authored prose as the faceplate control (one source of truth).
    expect(attackIn.paramTarget!.desc).toBe(index!.controls.attack.desc);
  });

  it('carries the gate input + env outputs with authored prose', () => {
    expect(index!.inputs.gate.cable).toBe('gate');
    expect(index!.inputs.gate.desc).toMatch(/gate/i);
    expect(index!.outputs.env).toBeDefined();
    expect(index!.outputs.env_inv).toBeDefined();
  });

  it('matches the doc-PAGE index built from the manifest (no drift)', () => {
    const fromManifest = buildDocIndex(
      buildModuleManifest().modules.find((m) => m.type === 'adsr')!,
    );
    // The two builders must agree on the authored payload the user sees.
    expect(index!.explanation).toBe(fromManifest.explanation);
    expect(index!.controls.attack.desc).toBe(fromManifest.controls.attack.desc);
    expect(index!.inputs.gate.desc).toBe(fromManifest.inputs.gate.desc);
    expect(index!.outputs.env.desc).toBe(fromManifest.outputs.env.desc);
    expect(index!.inputs.attack.paramTarget!.desc).toBe(
      fromManifest.inputs.attack.paramTarget!.desc,
    );
  });
});

describe('buildDocIndexFromDef — undocumented module', () => {
  it('returns null when the def has no authored docs (analogVco)', () => {
    // analogVco is intentionally NOT in MODULE_DOCS — annotate is unavailable.
    expect(analogVcoDef.docs).toBeUndefined();
    expect(buildDocIndexFromDef(analogVcoDef)).toBeNull();
  });

  it('returns null for an undefined def', () => {
    expect(buildDocIndexFromDef(undefined)).toBeNull();
  });
});
