// scripts/new-module.test.ts
//
// Tests for the new-module scaffolder. These are HEAVY by unit-test
// standards: each test calls scaffold() against the real codebase + then
// undo()s to leave the tree clean. We avoid the typecheck step inside
// the tests (it takes ~30s and the test harness is what's flaky-prone if
// typecheck slows down); a separate "scaffolder roundtrip is typecheck-
// clean" assertion can be added as a `task` target if it ever matters.
//
// All tests use a guard-rail beforeEach to make sure no orphan markers /
// stub files survive from a previous failed run.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { __test_internals } from './new-module.ts';

const {
  toCamel,
  toPascal,
  parseArgs,
  scaffold,
  undo,
  loadCloneShape,
  GRAPH_TYPES_PATH,
  REGISTRY_PATHS,
  CANVAS_PATH,
  MODULE_CATEGORIES_PATH,
  MANIFEST_PATH,
  VRT_EXEMPTIONS_PATH,
  audioModulePath,
  cardPath,
  moduleTestPath,
} = __test_internals;

// Names we use only in tests — picked to never collide with a real module.
const TEST_TYPE_A = 'mytestmod';
const TEST_TYPE_B = 'cloneprobe';

function cleanAll(): void {
  // Aggressive scrub so a half-run prior test doesn't pollute the next.
  for (const t of [TEST_TYPE_A, TEST_TYPE_B]) {
    undo(t);
  }
}

beforeEach(cleanAll);
afterEach(cleanAll);

describe('name conversion helpers', () => {
  it('toCamel', () => {
    expect(toCamel('compressor')).toBe('compressor');
    expect(toCamel('analog-vco')).toBe('analogVco');
    expect(toCamel('analog-logic-maths')).toBe('analogLogicMaths');
  });

  it('toPascal', () => {
    expect(toPascal('compressor')).toBe('Compressor');
    expect(toPascal('analog-vco')).toBe('AnalogVco');
  });
});

describe('parseArgs', () => {
  it('parses the happy-path positionals + defaults', () => {
    const a = parseArgs([TEST_TYPE_A, 'audio']);
    expect(a.mode).toBe('scaffold');
    expect(a.scaffold?.type).toBe(TEST_TYPE_A);
    expect(a.scaffold?.domain).toBe('audio');
    expect(a.scaffold?.label).toBe(TEST_TYPE_A.toUpperCase());
    expect(a.scaffold?.category).toBe('utility');
  });

  it('parses --from / --label / --category / --no-card', () => {
    const a = parseArgs([
      TEST_TYPE_A, 'audio',
      '--from', 'resofilter',
      '--label', 'COMPRESSOR',
      '--category', 'Effects',
      '--no-card',
    ]);
    expect(a.scaffold?.fromType).toBe('resofilter');
    expect(a.scaffold?.label).toBe('COMPRESSOR');
    expect(a.scaffold?.category).toBe('Effects');
    expect(a.scaffold?.noCard).toBe(true);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs([TEST_TYPE_A, 'audio', '--bogus'])).toThrow(/unknown flag/);
  });

  it('rejects bad domain', () => {
    expect(() => parseArgs([TEST_TYPE_A, 'magic'])).toThrow(/must be one of/);
  });

  it('parses --undo', () => {
    const a = parseArgs(['--undo', TEST_TYPE_A]);
    expect(a.mode).toBe('undo');
    expect(a.undo?.type).toBe(TEST_TYPE_A);
  });
});

describe('scaffold — happy path (audio)', () => {
  it('writes all 8 expected outputs + leaves the registry edited', () => {
    const res = scaffold({
      type: TEST_TYPE_A,
      domain: 'audio',
      label: 'MYTESTMOD',
      category: 'Effects',
      fromType: null,
      noCard: false,
      noTypecheck: true,
    });

    // 1) module def + 2) card + 3) test (3 files created)
    expect(res.filesCreated).toContain(audioModulePath(TEST_TYPE_A));
    expect(res.filesCreated).toContain(cardPath(toPascal(TEST_TYPE_A)));
    expect(res.filesCreated).toContain(moduleTestPath('audio', TEST_TYPE_A));

    // 4-8) edits to manifest / vrt / registry / types / categories / canvas
    expect(res.filesEdited).toContain(MANIFEST_PATH);
    expect(res.filesEdited).toContain(VRT_EXEMPTIONS_PATH);
    expect(res.filesEdited).toContain(REGISTRY_PATHS.audio);
    expect(res.filesEdited).toContain(GRAPH_TYPES_PATH);
    expect(res.filesEdited).toContain(MODULE_CATEGORIES_PATH);
    expect(res.filesEdited).toContain(CANVAS_PATH);

    // Sanity: every file actually exists on disk now.
    for (const f of res.filesCreated) {
      expect(existsSync(f), `created file should exist: ${f}`).toBe(true);
    }

    // Sanity: the registry barrel mentions the new def's camelCase
    // variable name.
    const reg = readFileSync(REGISTRY_PATHS.audio, 'utf8');
    expect(reg).toContain(`${toCamel(TEST_TYPE_A)}Def`);
    expect(reg).toContain(`[new-module:${TEST_TYPE_A}]`);

    // Sanity: the StandardModuleType union has the new camelCase entry.
    const graphTypes = readFileSync(GRAPH_TYPES_PATH, 'utf8');
    expect(graphTypes).toMatch(new RegExp(`\\|\\s*'${toCamel(TEST_TYPE_A)}'`));

    // Sanity: Canvas.svelte has the import + router entry.
    const canvas = readFileSync(CANVAS_PATH, 'utf8');
    expect(canvas).toContain(`${toPascal(TEST_TYPE_A)}Card from`);
    expect(canvas).toContain(`${toCamel(TEST_TYPE_A)}: ${toPascal(TEST_TYPE_A)}Card,`);

    // Sanity: module-categories has the entry.
    const cats = readFileSync(MODULE_CATEGORIES_PATH, 'utf8');
    expect(cats).toContain(`${toCamel(TEST_TYPE_A)}: { top: 'Audio modules'`);

    // Sanity: manifest has a DESCRIPTIONS entry (real, not the fallback
    // placeholder).
    const manifest = readFileSync(MANIFEST_PATH, 'utf8');
    expect(manifest).toContain(`${toCamel(TEST_TYPE_A)}:`);
    expect(manifest).toContain(`Scaffolded by scripts/new-module.ts`);

    // Sanity: VRT exemption with a reason longer than the 10-char gate.
    const vrt = readFileSync(VRT_EXEMPTIONS_PATH, 'utf8');
    expect(vrt).toMatch(new RegExp(`${toCamel(TEST_TYPE_A)}:\\s*'pending baseline`));
  });
});

describe('scaffold — happy path (--from resofilter)', () => {
  it('clones the source module\'s inputs/outputs/params verbatim', () => {
    scaffold({
      type: TEST_TYPE_B,
      domain: 'audio',
      label: 'CLONEPROBE',
      category: 'Effects',
      fromType: 'resofilter',
      noCard: true,         // skip card to keep the assertion simple
      noTypecheck: true,
    });

    const stubSrc = readFileSync(audioModulePath(TEST_TYPE_B), 'utf8');
    // The cloned shape should include the canonical RESOFILTER port ids.
    expect(stubSrc).toContain(`'audio'`);      // input id
    expect(stubSrc).toContain(`'cutoff_cv'`);  // input id
    expect(stubSrc).toContain(`'reso_cv'`);    // input id
    expect(stubSrc).toContain(`'out_l'`);      // output id
    expect(stubSrc).toContain(`'out_r'`);      // output id
    // And the canonical params.
    expect(stubSrc).toContain(`'cutoff'`);
    expect(stubSrc).toContain(`'resonance'`);
    expect(stubSrc).toContain(`'mix'`);
    // And the stereoPairs clone.
    expect(stubSrc).toContain(`stereoPairs:`);
  });

  it('loadCloneShape extracts a real ClonedShape for resofilter', () => {
    const shape = loadCloneShape('resofilter');
    expect(shape.domain).toBe('audio');
    expect(shape.inputsBody).toContain(`'audio'`);
    expect(shape.outputsBody).toContain(`'out_l'`);
    expect(shape.paramsBody).toContain(`'cutoff'`);
    expect(shape.stereoPairs).toContain(`'out_l'`);
  });

  it('throws a helpful error when the source module does not exist', () => {
    expect(() => loadCloneShape('definitely-not-a-real-module-zzz')).toThrow(/could not find/);
  });
});

describe('scaffold — idempotency', () => {
  it('a second run with the same args errors cleanly', () => {
    scaffold({
      type: TEST_TYPE_A, domain: 'audio',
      label: 'MYTESTMOD', category: 'Effects',
      fromType: null, noCard: false, noTypecheck: true,
    });
    expect(() => scaffold({
      type: TEST_TYPE_A, domain: 'audio',
      label: 'MYTESTMOD', category: 'Effects',
      fromType: null, noCard: false, noTypecheck: true,
    })).toThrow(/already exists/);
  });
});

describe('undo', () => {
  it('removes everything scaffold added (files + marker lines)', () => {
    scaffold({
      type: TEST_TYPE_A, domain: 'audio',
      label: 'MYTESTMOD', category: 'Effects',
      fromType: null, noCard: false, noTypecheck: true,
    });

    // Sanity: scaffold worked.
    expect(existsSync(audioModulePath(TEST_TYPE_A))).toBe(true);

    const result = undo(TEST_TYPE_A);

    // Files deleted.
    expect(existsSync(audioModulePath(TEST_TYPE_A))).toBe(false);
    expect(existsSync(cardPath(toPascal(TEST_TYPE_A)))).toBe(false);
    expect(existsSync(moduleTestPath('audio', TEST_TYPE_A))).toBe(false);
    expect(result.filesDeleted.length).toBeGreaterThanOrEqual(3);

    // Markers stripped from registries + edit files.
    const marker = `[new-module:${TEST_TYPE_A}]`;
    for (const f of [
      REGISTRY_PATHS.audio,
      GRAPH_TYPES_PATH,
      CANVAS_PATH,
      MODULE_CATEGORIES_PATH,
      MANIFEST_PATH,
      VRT_EXEMPTIONS_PATH,
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src.includes(marker), `${f} still contains marker after undo`).toBe(false);
    }

    // And the StandardModuleType union no longer mentions the camelCase
    // type — the most regression-sensitive of the edits.
    const gt = readFileSync(GRAPH_TYPES_PATH, 'utf8');
    expect(gt).not.toMatch(new RegExp(`\\|\\s*'${toCamel(TEST_TYPE_A)}'`));
  });

  it('is a no-op for a never-scaffolded type', () => {
    const result = undo('definitely-never-existed-xyz');
    expect(result.filesDeleted).toEqual([]);
    expect(result.filesEdited).toEqual([]);
  });
});

describe('scaffold — video / meta domain stubs', () => {
  it('emits a video-domain stub that wires into the video registry', () => {
    scaffold({
      type: TEST_TYPE_A, domain: 'video',
      label: 'MYTESTMOD', category: 'Sources',
      fromType: null, noCard: false, noTypecheck: true,
    });
    const reg = readFileSync(REGISTRY_PATHS.video, 'utf8');
    expect(reg).toContain(`${toCamel(TEST_TYPE_A)}Def`);
    const cats = readFileSync(MODULE_CATEGORIES_PATH, 'utf8');
    expect(cats).toContain(`${toCamel(TEST_TYPE_A)}: { top: 'Video modules'`);
  });

  it('emits a meta-domain stub that wires into the meta registry', () => {
    scaffold({
      type: TEST_TYPE_A, domain: 'meta',
      label: 'MYTESTMOD', category: 'tools',
      fromType: null, noCard: false, noTypecheck: true,
    });
    const reg = readFileSync(REGISTRY_PATHS.meta, 'utf8');
    expect(reg).toContain(`${toCamel(TEST_TYPE_A)}Def`);
    const cats = readFileSync(MODULE_CATEGORIES_PATH, 'utf8');
    expect(cats).toContain(`${toCamel(TEST_TYPE_A)}: { top: 'Hybrid'`);
  });
});
