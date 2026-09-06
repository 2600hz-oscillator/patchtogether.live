// scripts/new-module.test.ts
//
// Tests for the new-module scaffolder.
//
// ⚠ THESE TESTS USED TO MUTATE THE REAL WORKING COPY. scaffold() wrote into
// the tracked registry files and undo() put them back — except undo() was not
// byte-exact, so every `task test:scripts` run appended +5 blank lines to
// packages/web/src/lib/ui/modules-card-map.test.ts and left them there. That
// file is one of the hand-maintained lists concurrent PRs already collide on
// (see CLAUDE.md's post-merge conflict sweep), so the residue manufactured
// conflicts between unrelated PRs and corrupted the "did my additions
// survive?" git-grep check the sweep depends on. 200 stray blank lines had
// accumulated in it by the time this was found.
//
// The scaffolder's insert/undo asymmetry is fixed at the source
// (insertMarkerLine in new-module.ts). This file removes the whole CLASS on
// top of that: the scaffolder is pointed at a throwaway FIXTURE TREE via
// NEW_MODULE_REPO_ROOT, so it cannot open a tracked file even if a future
// edit reintroduces an asymmetry. The final describe() block is the guard
// that keeps it that way.
//
// We avoid the typecheck step inside the tests (it takes ~30s); a separate
// "scaffolder roundtrip is typecheck-clean" assertion can be added as a
// `task` target if it ever matters.
//
// All tests use a guard-rail beforeEach to make sure no orphan markers /
// stub files survive from a previous failed run.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────────────────────────────────────────────────────
// The REAL checkout. Only ever READ here — never handed to the scaffolder.

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const real = (rel: string): string => join(REAL_REPO_ROOT, rel);

/** Every tracked file the scaffolder is capable of writing to. Copied into
 *  the fixture tree below, and byte-compared in the guard at the bottom. */
const REGISTRY_FILES = [
  'packages/web/src/lib/audio/modules/index.ts',
  'packages/web/src/lib/video/modules/index.ts',
  'packages/web/src/lib/meta/modules/index.ts',
  'packages/web/src/lib/graph/types.ts',
  'packages/web/src/lib/ui/Canvas.svelte',
  'packages/web/src/lib/ui/module-categories.ts',
  'packages/web/src/lib/docs/module-manifest.ts',
] as const;

/**
 * Read by loadCloneShape('resofilter') — a real def, so the clone assertions
 * keep testing the real port shape rather than a hand-written stand-in.
 *
 * ⚠ THE SECOND FILE IS NOT INCIDENTAL. `resofilter` declares
 * `params: RESOFILTER_PARAMS`, importing them from a shared def-free module
 * (the `ringback-crush-model` rule: the ranges live in ONE place the def, the
 * card and the face model all read). So `--from resofilter` has to FOLLOW that
 * identifier across a file boundary, and this fixture has to contain the file
 * it lands in — otherwise the sandbox is testing a resolution that cannot
 * succeed, which is a green scaffolder over a broken clone. Adding the
 * identifier-following branch to `findArrayField` and this line to the fixture
 * are two halves of one change.
 */
const CLONE_SOURCE_FILES = [
  'packages/web/src/lib/audio/modules/resofilter.ts',
  'packages/web/src/lib/audio/resofilter-params.ts',
] as const;

/** Directories the scaffolder writes new files into (and loadCloneShape scans). */
const FIXTURE_DIRS = [
  'packages/web/src/lib/audio/modules',
  'packages/web/src/lib/video/modules',
  'packages/web/src/lib/meta/modules',
  'packages/web/src/lib/ui/modules',
] as const;

// Snapshot the REAL files BEFORE anything runs. This is the guard's baseline.
const REAL_BEFORE = new Map<string, string>(
  REGISTRY_FILES.map((rel) => [rel, readFileSync(real(rel), 'utf8')]),
);

// ───────────────────────────────────────────────────────────────────────────
// The FIXTURE TREE. Built before new-module.ts is imported, because that
// module resolves its path constants eagerly at load time.

const SANDBOX = mkdtempSync(join(tmpdir(), 'new-module-sandbox-'));

for (const rel of [...REGISTRY_FILES, ...CLONE_SOURCE_FILES]) {
  const dest = join(SANDBOX, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(real(rel), dest);
}
for (const rel of FIXTURE_DIRS) mkdirSync(join(SANDBOX, rel), { recursive: true });

process.env.NEW_MODULE_REPO_ROOT = SANDBOX;

// Dynamic import so the assignment above lands first.
const { __test_internals } = await import('./new-module.ts');

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

const {
  toCamel,
  toPascal,
  parseArgs,
  scaffold,
  undo,
  loadCloneShape,
  insertMarkerLine,
  REPO_ROOT,
  GRAPH_TYPES_PATH,
  REGISTRY_PATHS,
  CANVAS_PATH,
  MODULE_CATEGORIES_PATH,
  MANIFEST_PATH,
  audioModulePath,
  videoModulePath,
  metaModulePath,
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

  // ⚠ `--no-card` IS GONE WITH THE THING IT SKIPPED. The scaffolder no longer
  // writes a `<Type>Card.svelte`, so a flag to suppress one has nothing to
  // suppress — and asserting it now THROWS is the stronger statement.
  it('parses --from / --label / --category', () => {
    const a = parseArgs([
      TEST_TYPE_A, 'audio',
      '--from', 'resofilter',
      '--label', 'COMPRESSOR',
      '--category', 'Effects',
    ]);
    expect(a.scaffold?.fromType).toBe('resofilter');
    expect(a.scaffold?.label).toBe('COMPRESSOR');
    expect(a.scaffold?.category).toBe('Effects');
    expect(() => parseArgs([TEST_TYPE_A, 'audio', '--no-card'])).toThrow(/unknown flag/);
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
  it('creates the module-owned files + carries palette; does NOT edit the shared registry files', () => {
    const res = scaffold({
      type: TEST_TYPE_A,
      domain: 'audio',
      label: 'MYTESTMOD',
      category: 'Effects',
      fromType: null,
      noTypecheck: true,
    });

    // 1) module def + 2) card + 3) test (3 files created)
    expect(res.filesCreated).toContain(audioModulePath(TEST_TYPE_A));
    expect(res.filesCreated).toContain(moduleTestPath('audio', TEST_TYPE_A));

    // Edits limited to the 3 still-hand-maintained lists: manifest prose,
    // VRT exemptions, the card-map test enumeration.
    expect(res.filesEdited).toContain(MANIFEST_PATH);

    // The four conflict-prone shared files are NOT edited anymore.
    expect(res.filesEdited).not.toContain(REGISTRY_PATHS.audio);
    expect(res.filesEdited).not.toContain(GRAPH_TYPES_PATH);
    expect(res.filesEdited).not.toContain(MODULE_CATEGORIES_PATH);
    expect(res.filesEdited).not.toContain(CANVAS_PATH);

    // Sanity: every file actually exists on disk now.
    for (const f of res.filesCreated) {
      expect(existsSync(f), `created file should exist: ${f}`).toBe(true);
    }

    // The def file itself carries the palette (self-classification) + the
    // type, and is the AUTO-registered source of truth.
    const def = readFileSync(audioModulePath(TEST_TYPE_A), 'utf8');
    expect(def).toContain(`type: '${toCamel(TEST_TYPE_A)}'`);
    expect(def).toContain(`palette: { top: 'Audio modules'`);

    // The shared barrels / types / Canvas / categories are UNTOUCHED — no
    // marker, no mention of the new module.
    expect(readFileSync(REGISTRY_PATHS.audio, 'utf8')).not.toContain(`[new-module:${TEST_TYPE_A}]`);
    expect(readFileSync(GRAPH_TYPES_PATH, 'utf8')).not.toMatch(
      new RegExp(`\\|\\s*'${toCamel(TEST_TYPE_A)}'`),
    );
    expect(readFileSync(CANVAS_PATH, 'utf8')).not.toContain(`${toPascal(TEST_TYPE_A)}Card from`);
    expect(readFileSync(MODULE_CATEGORIES_PATH, 'utf8')).not.toContain(`${toCamel(TEST_TYPE_A)}:`);

    // ⚠ NO CARD FILE AND NO CARD-MAP LINE. Both used to be asserted here; the
    // scaffolder writes neither, because there is no card renderer and no map.
    expect(res.filesCreated.some((f) => f.endsWith('Card.svelte')), 'no card is scaffolded').toBe(false);

    // Sanity: manifest has a DESCRIPTIONS entry (real, not the fallback
    // placeholder).
    const manifest = readFileSync(MANIFEST_PATH, 'utf8');
    expect(manifest).toContain(`${toCamel(TEST_TYPE_A)}:`);
    expect(manifest).toContain(`Scaffolded by scripts/new-module.ts`);

    // ⚠ THE VRT-EXEMPTION SANITY CHECK IS GONE WITH THE STEP IT CHECKED. The
    // scaffolder used to inject a "pending baseline" `EXEMPT_FROM_VRT` entry so
    // the per-module legacy-CARD sweep would not fail on an unphotographed
    // card. That sweep and its exemption tables are deleted; a new module's
    // visual coverage is a FACE scene it earns by promotion, not an excuse it
    // is issued on the way in.
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
      fromType: null, noTypecheck: true,
    });
    expect(() => scaffold({
      type: TEST_TYPE_A, domain: 'audio',
      label: 'MYTESTMOD', category: 'Effects',
      fromType: null, noTypecheck: true,
    })).toThrow(/already exists/);
  });
});

describe('undo', () => {
  it('removes everything scaffold added (files + marker lines)', () => {
    scaffold({
      type: TEST_TYPE_A, domain: 'audio',
      label: 'MYTESTMOD', category: 'Effects',
      fromType: null, noTypecheck: true,
    });

    // Sanity: scaffold worked.
    expect(existsSync(audioModulePath(TEST_TYPE_A))).toBe(true);

    const result = undo(TEST_TYPE_A);

    // Files deleted.
    expect(existsSync(audioModulePath(TEST_TYPE_A))).toBe(false);
    // (there is no card path to check any more — the scaffolder writes none)
    expect(existsSync(moduleTestPath('audio', TEST_TYPE_A))).toBe(false);
    // TWO, not three: the def and its shape test. The third was the card stub,
    // which the scaffolder no longer writes — so undo has one fewer file to
    // remove and this floor moves with it rather than being left to pass on a
    // count nobody re-derived.
    expect(result.filesDeleted.length).toBeGreaterThanOrEqual(2);

    // Markers stripped from the still-edited lists (+ the legacy shared
    // files, defensively — they shouldn't carry any markers now).
    const marker = `[new-module:${TEST_TYPE_A}]`;
    for (const f of [
      REGISTRY_PATHS.audio,
      GRAPH_TYPES_PATH,
      CANVAS_PATH,
      MODULE_CATEGORIES_PATH,
      MANIFEST_PATH,
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src.includes(marker), `${f} still contains marker after undo`).toBe(false);
    }
  });

  it('is a no-op for a never-scaffolded type', () => {
    const result = undo('definitely-never-existed-xyz');
    expect(result.filesDeleted).toEqual([]);
    expect(result.filesEdited).toEqual([]);
  });

  // ── The regression this file exists for. ────────────────────────────────
  //
  // scaffold() → undo() must return every edited file to its EXACT prior
  // bytes. The historical defect was addCardMapTestEntry() inserting TWO
  // newlines while removeMarkerLines() dropped ONE line, so each cycle left
  // a blank line behind. The `.includes(marker) === false` assertion above is
  // structurally blind to that: the marker really is gone, and the file is
  // still wrong.
  it('is BYTE-EXACT — a scaffold/undo cycle leaves every edited file unchanged', () => {
    const before = new Map<string, string>(
      [MANIFEST_PATH].map(
        (f) => [f, readFileSync(f, 'utf8')],
      ),
    );

    // Two full cycles: residue of this class ACCUMULATES, so a second pass
    // makes an off-by-one-line bug twice as visible and proves the first
    // cycle didn't merely get lucky.
    for (const pass of [1, 2]) {
      scaffold({
        type: TEST_TYPE_A, domain: 'audio',
        label: 'MYTESTMOD', category: 'Effects',
        fromType: null, noTypecheck: true,
      });
      undo(TEST_TYPE_A);

      for (const [f, prior] of before) {
        const now = readFileSync(f, 'utf8');
        expect(
          now === prior,
          `pass ${pass}: ${f} is NOT byte-identical after scaffold+undo — ` +
          `${prior.split('\n').length} → ${now.split('\n').length} lines. ` +
          `An insert that adds more than the ONE line undo removes leaks residue ` +
          `into a tracked registry file on every run.`,
        ).toBe(true);
      }
    }
  });
});

describe('scaffold — video / meta domain stubs', () => {
  it('emits a video-domain def that carries a Video-modules palette + auto-registers', () => {
    scaffold({
      type: TEST_TYPE_A, domain: 'video',
      label: 'MYTESTMOD', category: 'Sources',
      fromType: null, noTypecheck: true,
    });
    // The def is the source of truth — palette lives on it; the glob barrel
    // registers it; the shared video index is NOT edited.
    const def = readFileSync(videoModulePath(TEST_TYPE_A), 'utf8');
    expect(def).toContain(`palette: { top: 'Video modules'`);
    expect(def).toContain(`type: '${toCamel(TEST_TYPE_A)}'`);
    expect(readFileSync(REGISTRY_PATHS.video, 'utf8')).not.toContain(`${toCamel(TEST_TYPE_A)}Def`);
  });

  it('emits a meta-domain def that carries a Hybrid palette + auto-registers', () => {
    scaffold({
      type: TEST_TYPE_A, domain: 'meta',
      label: 'MYTESTMOD', category: 'tools',
      fromType: null, noTypecheck: true,
    });
    const def = readFileSync(metaModulePath(TEST_TYPE_A), 'utf8');
    expect(def).toContain(`palette: { top: 'Hybrid'`);
    expect(def).toContain(`type: '${toCamel(TEST_TYPE_A)}'`);
    expect(readFileSync(REGISTRY_PATHS.meta, 'utf8')).not.toContain(`${toCamel(TEST_TYPE_A)}Def`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// insertMarkerLine — the invariant that makes undo byte-exact, asserted at
// the seam so the rule is stated once and cannot be quietly reintroduced.

describe('insertMarkerLine (byte-exact-undo invariant)', () => {
  const SRC = "const A = [\n  'a',\n];\n";
  const endIdx = SRC.indexOf(']');

  it('inserts EXACTLY one line', () => {
    const next = insertMarkerLine(SRC, endIdx, "  'b', // [new-module:b]\n", 'fixture.ts');
    expect(next).toBe("const A = [\n  'a',\n  'b', // [new-module:b]\n];\n");
    expect(next.split('\n').length).toBe(SRC.split('\n').length + 1);
  });

  it('REJECTS a leading newline — the exact shape that leaked 200 blank lines', () => {
    expect(() => insertMarkerLine(SRC, endIdx, "\n  'b', // [new-module:b]\n", 'fixture.ts'))
      .toThrow(/EXACTLY one/);
  });

  it('REJECTS an unterminated line', () => {
    expect(() => insertMarkerLine(SRC, endIdx, "  'b', // [new-module:b]", 'fixture.ts'))
      .toThrow(/EXACTLY one/);
  });

  it('REJECTS splicing into the middle of an existing line', () => {
    const inline = "const A = ['a'];\n";
    expect(() => insertMarkerLine(inline, inline.indexOf(']'), "  'b', // [new-module:b]\n", 'fixture.ts'))
      .toThrow(/newline before the closing bracket/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE GUARD. Declared last so it runs after every test above (vitest executes
// in declaration order). It asserts the thing this whole file is about: the
// suite does not touch the real working copy.

describe('GUARD — the scaffolder suite never touches the real working copy', () => {
  // Permanent instrument negative-control. Without this, a broken sandbox
  // (typo'd env var, an eagerly-cached import, a path constant that stopped
  // going through rp()) would silently send every test above back at the real
  // tree — and the byte-comparison below would STILL pass, because
  // scaffold+undo is byte-exact again. "Sandboxed" and "not sandboxed but
  // tidy" are indistinguishable from that comparison alone, so the redirect
  // is proved separately, on every run.
  it('the scaffolder resolved its paths INSIDE the fixture tree, not the repo', () => {
    expect(SANDBOX).not.toBe(REAL_REPO_ROOT);
    expect(REPO_ROOT, 'new-module.ts did not honour NEW_MODULE_REPO_ROOT').toBe(SANDBOX);

    for (const p of [
      MANIFEST_PATH, GRAPH_TYPES_PATH,
      CANVAS_PATH, MODULE_CATEGORIES_PATH,
      REGISTRY_PATHS.audio, REGISTRY_PATHS.video, REGISTRY_PATHS.meta,
      audioModulePath(TEST_TYPE_A),
      moduleTestPath('audio', TEST_TYPE_A),
    ]) {
      expect(p.startsWith(SANDBOX + sep), `${p} must resolve inside the fixture tree`).toBe(true);
      expect(
        p.startsWith(REAL_REPO_ROOT + sep),
        `${p} resolves inside the REAL repo — the scaffolder would edit tracked files`,
      ).toBe(false);
    }
  });

  it('every tracked registry file is byte-identical to its pre-test content', () => {
    for (const [rel, before] of REAL_BEFORE) {
      const after = readFileSync(real(rel), 'utf8');
      expect(after === before, mutationReport(rel, before, after)).toBe(true);
    }
  });

  it('left no scaffolded stub files behind in the real tree', () => {
    const candidates: string[] = [];
    for (const type of [TEST_TYPE_A, TEST_TYPE_B]) {
      for (const domain of ['audio', 'video', 'meta']) {
        candidates.push(`packages/web/src/lib/${domain}/modules/${type}.ts`);
        candidates.push(`packages/web/src/lib/${domain}/modules/${type}.test.ts`);
      }
      candidates.push(`packages/web/src/lib/ui/modules/${toPascal(type)}Card.svelte`);
    }
    const found = candidates.filter((rel) => existsSync(real(rel)));
    expect(found, `scaffolded stubs leaked into the real tree: ${found.join(', ')}`).toEqual([]);
  });
});

/** A readable line-level report — vitest's default diff on a 300-line source
 *  file is unusable, and "which line moved" is the whole diagnosis here. */
function mutationReport(rel: string, before: string, after: string): string {
  if (before === after) return `${rel} unchanged`;
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head && tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  const show = (lines: string[], mark: string): string[] =>
    lines.slice(0, 8).map((l) => `    ${mark} ${JSON.stringify(l)}`)
      .concat(lines.length > 8 ? [`    ${mark} …and ${lines.length - 8} more`] : []);

  return [
    ``,
    `${rel} was MUTATED by the scaffolder test suite.`,
    `  ${a.length} → ${b.length} lines; first divergence at line ${head + 1}.`,
    ...show(a.slice(head, a.length - tail), '-'),
    ...show(b.slice(head, b.length - tail), '+'),
    ``,
    `  This suite must run entirely inside the NEW_MODULE_REPO_ROOT fixture tree.`,
    `  A mutation here means either the sandbox redirect broke, or scaffold()/undo()`,
    `  stopped being byte-exact (see insertMarkerLine in scripts/new-module.ts).`,
    ``,
  ].join('\n');
}
