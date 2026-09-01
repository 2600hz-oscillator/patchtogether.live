// Def-shape and contract gates for seqtris. The RULES live in
// seqtris-engine.test.ts, the Launchpad seam in seqtris-launchpad.test.ts, and
// the live chain in e2e/tests/seqtris.spec.ts.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { seqtrisDef } from './seqtris';
import { SEQTRIS_DEFAULT_DIVISOR, divisorLadder } from './seqtris-engine';
import { isNoteSource } from '$lib/graph/patch-convenience';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('seqtris def shape', () => {
  it('is an audio-domain game module with a factory', () => {
    expect(seqtrisDef.type).toBe('seqtris');
    expect(seqtrisDef.domain).toBe('audio');
    expect(seqtrisDef.category).toBe('games');
    expect(seqtrisDef.palette).toEqual({ top: 'Games', sub: 'Arcade' });
    expect(typeof seqtrisDef.factory).toBe('function');
  });

  it('label is lowercase (card CSS uppercases for display)', () => {
    expect(seqtrisDef.label).toBe(seqtrisDef.label.toLowerCase());
  });

  it('declares size on the def, not in rack-sizes', () => {
    expect(seqtrisDef.size).toBe('3u');
    expect(seqtrisDef.hp).toBe(2);
  });

  it('has exactly one clock input, declared as a TRIGGER', () => {
    expect(seqtrisDef.inputs.map((p) => [p.id, p.type, p.edge])).toEqual([
      ['clock', 'gate', 'trigger'],
    ]);
  });

  it('the clock input carries no paramTarget — the pulse count is read on the main thread', () => {
    // Gravity is a COUNT of rising edges polled through the shared
    // createEdgeCounter seam, not a value summed into an AudioParam. A
    // paramTarget here would make the count unreadable from JS.
    for (const port of seqtrisDef.inputs) {
      expect(port.paramTarget).toBeUndefined();
      expect(port.cvScale).toBeUndefined();
    }
  });

  it('has the four outputs the spec names, with the two note ports poly', () => {
    expect(seqtrisDef.outputs.map((p) => [p.id, p.type, p.edge])).toEqual([
      ['piece', 'polyPitchGate', undefined],
      ['board', 'polyPitchGate', undefined],
      ['line', 'gate', 'trigger'],
      ['spawn', 'gate', 'trigger'],
    ]);
  });

  it('IS a note source — the poly outputs put it in that family by SHAPE', () => {
    // Deliberate: PIECE is a playable note stream, so a lane/clip that asks
    // "can this drive a voice" must say yes. (A note source is never a clip
    // TARGET, which is also correct here — nothing plays INTO seqtris.)
    expect(isNoteSource(seqtrisDef)).toBe(true);
  });

  it('params are the two knobs, with in-range defaults', () => {
    expect(seqtrisDef.params.map((p) => p.id)).toEqual(['gravity', 'quantize']);
    for (const p of seqtrisDef.params) {
      expect(p.defaultValue).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue).toBeLessThanOrEqual(p.max);
      expect(p.curve).toBe('discrete');
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it('the GRAV default is the engine default, so the docs\' ladder is the real one', () => {
    const grav = seqtrisDef.params.find((p) => p.id === 'gravity')!;
    expect(grav.defaultValue).toBe(SEQTRIS_DEFAULT_DIVISOR);
    // The explanation quotes this ladder verbatim; if the default moves, the
    // prose is wrong and this is where it shows.
    expect([...divisorLadder(grav.defaultValue)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(seqtrisDef.docs!.controls!.gravity).toContain('8, 7, 6, 5, 4, 3, 2, 1');
  });

  it('QUANT names both of its states — a two-position switch with no unnamed setting', () => {
    const quant = seqtrisDef.params.find((p) => p.id === 'quantize')!;
    expect(quant.min).toBe(0);
    expect(quant.max).toBe(1);
    expect(quant.options?.map((o) => [o.value, o.label])).toEqual([
      [0, 'free'],
      [1, 'clock'],
    ]);
  });

  it('docs cover the explanation, every port and every control', () => {
    const docs = seqtrisDef.docs!;
    expect(docs.explanation!.length).toBeGreaterThan(400);
    for (const port of seqtrisDef.inputs) {
      expect(docs.inputs?.[port.id], `docs.inputs.${port.id}`).toBeTruthy();
    }
    for (const port of seqtrisDef.outputs) {
      expect(docs.outputs?.[port.id], `docs.outputs.${port.id}`).toBeTruthy();
    }
    for (const p of seqtrisDef.params) {
      expect(docs.controls?.[p.id], `docs.controls.${p.id}`).toBeTruthy();
    }
  });

  it('the BOARD stub SAYS it is a stub — a silent jack with no note about it is a bug report', () => {
    expect(seqtrisDef.docs!.outputs!.board.toLowerCase()).toContain('silent');
  });

  // ── THE ART-LANE IMPORT HAZARD, guarded where it bit ─────────────────────
  //
  // `launchpad-device.svelte.ts` declares `$state` at module scope. The ART
  // harness loads the AUDIO REGISTRY under plain vitest with NO Svelte plugin,
  // so a VALUE import of that file from anything this def reaches throws
  // `ReferenceError: $state is not defined` — and it does so while loading three
  // unrelated CV scenarios, which is where it actually surfaced on this PR. The
  // device layer arrives through `import()` inside CONNECT instead.
  //
  // Scoped to SEQTRIS's own two files on purpose: this is a regression test for
  // the bug that happened here, not a new repo-wide gate.
  for (const rel of ['./seqtris.ts', '../seqtris-launchpad.ts']) {
    it(`${rel} imports the Launchpad device layer lazily, never as a static value`, () => {
      const src = readFileSync(resolve(__dirname, rel), 'utf8');
      const statics = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)';/gm)]
        .map((m) => m[1]!)
        .filter((spec) => spec.includes('launchpad-device') || spec.includes('launchpad-map'));
      expect(
        statics,
        `${rel} must not statically import a rune-bearing Launchpad module — `
          + 'the ART lane runs this def with no Svelte compiler. Use `import type`, '
          + 'or the dynamic import() in seqtris-launchpad.ts connect().',
      ).toEqual([]);
    });
  }

  it('declares NO face — the bespoke-surface disposition is deliberate', () => {
    // The well and the eight hardware-ordered controls are the module; two
    // knobs are all a generic face could rank. See FACE_MIGRATION_INVENTORY.
    expect(seqtrisDef.face).toBeUndefined();
    expect(seqtrisDef.controlFamilies).toBeUndefined();
  });
});
