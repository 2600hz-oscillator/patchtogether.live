// packages/web/src/lib/ui/rack-sizing.test.ts
//
// Invariants for the 1u/3u rack sizing system. Data-level here (every declared
// def is well-formed + the CSS token relationship is 3u = 3×1u); the rendered
// "all 1u cards share one height / all 3u share another" check rides VRT.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Side-effect barrels so the registries populate.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

interface SizedDef {
  type: string;
  size?: '1u' | '3u';
  hp?: number;
}

function allDefs(): SizedDef[] {
  return [
    ...listModuleDefs(),
    ...listVideoModuleDefs(),
    ...listMetaModuleDefs(),
  ] as unknown as SizedDef[];
}

describe('rack sizing — declaration invariants', () => {
  it('every declared size is exactly 1u or 3u', () => {
    for (const d of allDefs()) {
      if (d.size !== undefined) {
        expect(['1u', '3u'], `${d.type} size`).toContain(d.size);
      }
    }
  });

  it('every declared hp is a positive integer (width in 1u tiles)', () => {
    for (const d of allDefs()) {
      if (d.hp !== undefined) {
        expect(Number.isInteger(d.hp), `${d.type} hp must be an integer`).toBe(true);
        expect(d.hp, `${d.type} hp must be >= 1`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('a module that declares hp also declares a size tier', () => {
    for (const d of allDefs()) {
      if (d.hp !== undefined) {
        expect(d.size, `${d.type} declares hp but no size`).toBeDefined();
      }
    }
  });

  it('sample: stereovca = 1u/hp1 (the 1u reference); sequencer = 3u/hp3', () => {
    const by = Object.fromEntries(allDefs().map((d) => [d.type, d]));
    expect(by.stereovca?.size).toBe('1u');
    expect(by.stereovca?.hp).toBe(1);
    expect(by.sequencer?.size).toBe('3u');
    expect(by.sequencer?.hp).toBe(3);
  });
});

describe('rack sizing — CSS token relationship (3u = 3 × 1u)', () => {
  it('_module-card.css pins 1u height = --rack-unit and 3u = calc(3 * --rack-unit)', () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'modules', '_module-card.css'),
      'utf8',
    );
    expect(css).toMatch(/--rack-unit:\s*\d+px/);
    expect(css).toMatch(/\.rack-1u[^{]*\{[^}]*height:\s*var\(--rack-unit\)/s);
    expect(css).toMatch(/\.rack-3u[^{]*\{[^}]*height:\s*calc\(3 \* var\(--rack-unit\)\)/s);
  });
});
