// packages/web/src/lib/dev/registry-manifest.test.ts
//
// The registry-manifest GATE. Not the emitter — that is `registry-manifest.ts`,
// a plain module (#1526).
//
// Why the registry projection is exercised here at all:
//   * vitest in this workspace already imports the three module-registry
//     barrels (audio / video / meta) in countless unit tests; running
//     the registry projection here is essentially free.
//   * Test-load-time iteration over a registry is the unit-test pass's
//     superpower. Playwright can't `await` at file load — but it CAN
//     `readFileSync` a JSON dump. So the manifest is the seam:
//     `task test:emit-manifest` (alias `manifest:emit`) emits it, downstream
//     `task e2e` + `task vrt` consume it via `e2e/tests/_registry.ts`.
//   * The alternative — duplicating the registry list in 3-4 hardcoded
//     allowlists across spec files — is what got the codebase to
//     21/74 (28%) drift in `io-spec-consistency.MODULE_TYPES` + 27/74
//     (36%) drift in `modules.spec.ts:MODULES` before this slice
//     landed.
//
// ⚠ THIS FILE NO LONGER WRITES THE MANIFEST as a side effect of `task test`.
// It used to: `it('emits the manifest JSON to disk')` did mkdirSync +
// writeFileSync unconditionally, which made the unit lane mutate the tree and
// hid the generation step from the task graph. The write now lives in
// `emitRegistryManifest()` and fires ONLY under `MANIFEST_EMIT=1` — the
// explicit generate seam, exactly the `DOCS_UPDATE` / `FACE_INVENTORY_UPDATE`
// accept-loop shape used elsewhere in the repo.
//
// What this file gates instead, all of it non-vacuous in a plain `task test`:
//   1. the registry-wide invariants (unique types, lowercase labels, known
//      categories, param validity) — unchanged;
//   2. the BUILDER is deterministic and its bytes are stable;
//   3. the WRITER is write-if-changed and round-trips — driven against a temp
//      path, never the real artifact;
//   4. the SOURCE FINGERPRINT that `e2e/tests/_registry.ts` uses to refuse a
//      stale manifest actually moves when a def's bytes move (the permanent
//      negative control — a fingerprint that cannot move is a staleness gate
//      that cannot fail).
//
// Schema is sorted by module type for stable diffs across runs.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  buildRegistryManifest,
  emitRegistryManifest,
  serializeRegistryManifest,
  MANIFEST_SCHEMA_VERSION,
  REGISTRY_MANIFEST_PATH,
} from './registry-manifest';
import {
  MANIFEST_BASIS_DIRS,
  MANIFEST_BASIS_FILES,
  manifestBasisFiles,
  manifestSourceFingerprint,
  REPO_ROOT,
} from './registry-manifest-basis';

// Pull every barrel — the side-effect import is what triggers the
// per-domain registerModule() calls. Without these the lists would be
// empty and the assertion at the bottom would fail.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { getAllModuleSpecs } from './module-specs';

describe('registry manifest gate', () => {
  const specs = getAllModuleSpecs();

  it('every barrel registered at least one module', () => {
    // 74 was the count at the time this slice landed (55 audio + 17
    // video + 2 meta). The bar is "non-trivially populated", not an
    // exact count — new modules push the count up without breaking
    // this assertion. If the count DROPS, it means a registration
    // side-effect got skipped (the barrel import didn't fire) and the
    // emitted manifest would be wrong.
    expect(specs.length).toBeGreaterThan(60);
  });

  it('every module has the required fields', () => {
    for (const m of specs) {
      expect(m.type, 'type').toBeTruthy();
      expect(m.label, `${m.type} label`).toBeTruthy();
      expect(m.domain, `${m.type} domain`).toMatch(/^(audio|video|meta)$/);
      expect(m.category, `${m.type} category`).toBeTruthy();
      expect(Array.isArray(m.inputs), `${m.type} inputs is array`).toBe(true);
      expect(Array.isArray(m.outputs), `${m.type} outputs is array`).toBe(true);
      // schemaVersion-2: params is always an array (possibly empty).
      expect(Array.isArray(m.params), `${m.type} params is array`).toBe(true);
    }
  });

  // schemaVersion-2 enrichment carries the full PortDef/ParamDef surface.
  // Spot-check ADSR: its CV inputs declare paramTarget + cvScale, and its
  // params declare label/min/max/curve — the fields the docs I/O section
  // + io-explain read. This is the manifest-side proof the projection
  // (module-specs.ts) preserves the def fields end-to-end.
  it('schemaVersion-2 carries paramTarget/cvScale on ports and full ParamDef', () => {
    const adsr = specs.find((s) => s.type === 'adsr');
    expect(adsr, 'adsr present').toBeDefined();
    if (!adsr) return;
    const attackIn = adsr.inputs.find((p) => p.id === 'attack');
    expect(attackIn?.paramTarget, 'adsr.attack paramTarget').toBe('attack');
    expect(attackIn?.cvScale?.mode, 'adsr.attack cvScale.mode').toBe('log');
    const attackParam = adsr.params.find((p) => p.id === 'attack');
    expect(attackParam?.label, 'adsr.attack param label').toBeTruthy();
    expect(typeof attackParam?.min, 'adsr.attack min is number').toBe('number');
    expect(typeof attackParam?.max, 'adsr.attack max is number').toBe('number');
    expect(attackParam?.curve, 'adsr.attack curve').toBeTruthy();
  });

  it('module types are unique', () => {
    const types = specs.map((m) => m.type);
    const unique = new Set(types);
    expect(types.length, 'no duplicate type ids').toBe(unique.size);
  });

  // The card UI uppercases the label for DISPLAY via CSS, so the stored
  // `label:` string itself must be lowercase for consistency (the #658
  // convention). Iterating the full registry here both ENUMERATES every
  // offender and PREVENTS recurrence — any new module that lands with an
  // uppercase label (or a stray uppercase letter in a multi-word label
  // like 'audio in') fails CI here. Multi-word labels keep their spaces;
  // only letter-casing is constrained.
  it('every module label is lowercase', () => {
    const offenders = specs
      .filter((m) => m.label !== m.label.toLowerCase())
      .map((m) => `${m.type}: ${JSON.stringify(m.label)}`);
    expect(
      offenders,
      `module labels must be lowercase (card CSS uppercases for display); ` +
        `offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  // The def `category` string is cosmetic ordering data (docs CAT_ORDER, the
  // legacy palette fallback, mike/personality's 'sequencers' probe) and is
  // deliberately EXCLUDED from the contract-lock golden — so this registry-wide
  // allowlist is the single guard that a def's category isn't a typo. The set
  // is FROZEN to what the registry uses today; a genuinely new category is a
  // one-line, reviewed addition here. ('utility' vs 'utilities' and 'filter'
  // vs 'filters' are pre-existing legacy near-duplicates — normalizing them
  // changes docs ordering + mike lookups, so they stay listed until a
  // dedicated cleanup.)
  it('every module category is in the known set (no typo categories)', () => {
    const KNOWN_CATEGORIES = new Set([
      'sources', 'modulation', 'filters', 'filter', 'effects', 'video-effects',
      'utilities', 'utility', 'tools', 'output', 'processors', 'games', 'hybrid',
    ]);
    const offenders = specs
      .filter((m) => !KNOWN_CATEGORIES.has(m.category))
      .map((m) => `${m.type}: ${JSON.stringify(m.category)}`);
    expect(
      offenders,
      `unknown module category (typo, or add it to KNOWN_CATEGORIES deliberately):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  // Registry-wide ParamDef validity — the invariants per-module def-shape
  // tests used to re-assert N times (LoC-reduction row 1). The golden pins the
  // VALUES (min/max/default per param); these pin the RULES that must hold for
  // any value the golden accepts.
  it('every param declares a non-empty label and a default within [min, max]', () => {
    const offenders: string[] = [];
    for (const m of specs) {
      for (const p of m.params) {
        if (typeof p.label !== 'string' || p.label.length === 0) {
          offenders.push(`${m.type}.${p.id}: empty label`);
        }
        if (!(p.defaultValue >= p.min && p.defaultValue <= p.max)) {
          offenders.push(
            `${m.type}.${p.id}: default ${p.defaultValue} outside [${p.min}, ${p.max}]`,
          );
        }
        if (!(p.min <= p.max)) {
          offenders.push(`${m.type}.${p.id}: min ${p.min} > max ${p.max}`);
        }
      }
    }
    expect(offenders, `param validity:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // The BUILDER — pure over the registry.
  // ---------------------------------------------------------------------

  it('the builder is deterministic: two independent reads serialize byte-identically', () => {
    // Fixed fingerprint on both sides so this measures the REGISTRY read, not
    // the fs read. (The fingerprint's own determinism is gated below.)
    const a = serializeRegistryManifest(buildRegistryManifest('FIXED'));
    const b = serializeRegistryManifest(buildRegistryManifest('FIXED'));
    expect(a).toBe(b);
    // Negative control for THIS assertion: a different fingerprint must move
    // the bytes, or the comparison above is over a constant.
    expect(serializeRegistryManifest(buildRegistryManifest('OTHER'))).not.toBe(a);
  });

  it('the built manifest carries the schema version and every registered module', () => {
    const m = buildRegistryManifest('FIXED');
    expect(m.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(m.modules.length).toBe(specs.length);
    expect(m.modules.map((x) => x.type)).toEqual(specs.map((x) => x.type));
  });

  // ---------------------------------------------------------------------
  // The WRITER — driven against a TEMP path. The real artifact is written
  // ONLY by the `MANIFEST_EMIT=1` seam at the bottom of this file, so a plain
  // `task test` leaves the working tree alone.
  // ---------------------------------------------------------------------

  it('the writer round-trips and is write-if-changed (no needless mtime churn)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'registry-manifest-'));
    try {
      const path = resolve(dir, 'nested/registry-manifest.json');
      const manifest = buildRegistryManifest('FIXED');

      const first = emitRegistryManifest(path, manifest);
      expect(first.changed, 'first emit creates the file').toBe(true);
      expect(first.modules).toBe(specs.length);

      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
        schemaVersion: number;
        sourceFingerprint: string;
        modules: { type: string }[];
      };
      expect(onDisk.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
      expect(onDisk.sourceFingerprint).toBe('FIXED');
      expect(onDisk.modules.map((m) => m.type)).toEqual(specs.map((s) => s.type));

      const mtimeBefore = statSync(path).mtimeMs;
      const second = emitRegistryManifest(path, manifest);
      expect(second.changed, 're-emitting identical content is a no-op').toBe(false);
      expect(statSync(path).mtimeMs, 'unchanged emit must not touch mtime').toBe(mtimeBefore);

      // Negative control: different content DOES rewrite. Without this leg the
      // `changed === false` assertion above would also pass on a writer that
      // never writes anything.
      const third = emitRegistryManifest(path, buildRegistryManifest('MOVED'));
      expect(third.changed, 'changed content must rewrite').toBe(true);
      expect(
        (JSON.parse(readFileSync(path, 'utf8')) as { sourceFingerprint: string })
          .sourceFingerprint,
      ).toBe('MOVED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // The SOURCE FINGERPRINT — what `e2e/tests/_registry.ts` uses to refuse a
  // stale manifest. A staleness gate whose fingerprint cannot move is a gate
  // that cannot fail, so the perturbation legs here are PERMANENT.
  // ---------------------------------------------------------------------

  it('the basis covers every registered module def file and the projection', () => {
    const files = manifestBasisFiles();
    // Anchor to the ARTIFACT, not to a count: every hand-named basis entry must
    // still exist on disk, or the fingerprint is silently hashing less than it
    // claims. (`manifestBasisFiles` reads them; a missing one throws below.)
    for (const rel of MANIFEST_BASIS_FILES) {
      expect(files, `${rel} must be in the basis`).toContain(rel);
    }
    // Every basis dir contributed at least its barrel — a dir that silently
    // resolved to nothing would hash to a stable value forever.
    for (const dir of MANIFEST_BASIS_DIRS) {
      expect(files, `${dir}/index.ts must be in the basis`).toContain(`${dir}/index.ts`);
    }
    // DERIVED membership: every def file the barrels glob is in the basis.
    // Asserted as a set difference, never as a population count.
    const globbed = files.filter((f) => MANIFEST_BASIS_DIRS.some((d) => f.startsWith(`${d}/`)));
    expect(globbed.every((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))).toBe(true);
    expect(globbed.length, 'basis dirs must contribute def files').toBeGreaterThan(
      specs.length,
    );
  });

  it('the fingerprint is stable across calls over the real tree', () => {
    expect(manifestSourceFingerprint()).toBe(manifestSourceFingerprint());
  });

  it('PERMANENT CONTROL: perturbing ONE basis file moves the fingerprint', () => {
    const files = manifestBasisFiles();
    // Read the tree ONCE; perturb from memory. Re-reading per perturbation is
    // ~80k syscalls and cost 2.2 s of the unit lane for no extra coverage.
    const bytes = new Map(files.map((rel) => [rel, readFileSync(resolve(REPO_ROOT, rel))]));
    const readCached = (rel: string): Buffer => bytes.get(rel) as Buffer;

    const baseline = manifestSourceFingerprint(readCached, files);
    expect(
      baseline,
      'the cached reader must reproduce the real fingerprint, or this control ' +
        'is measuring a different function than the one _registry.ts calls',
    ).toBe(manifestSourceFingerprint());

    // Perturb each basis file in turn — ONE byte appended — and require the
    // fingerprint to move for every one of them. A file that can be edited
    // without moving the hash is a hole in the staleness gate, and this names
    // the exact file rather than reporting "some file".
    const NL = Buffer.from('\n');
    const blind: string[] = [];
    for (const target of files) {
      const moved = manifestSourceFingerprint(
        (rel) => (rel === target ? Buffer.concat([readCached(rel), NL]) : readCached(rel)),
        files,
      );
      if (moved === baseline) blind.push(target);
    }
    expect(
      blind,
      'these basis files can change without moving the manifest fingerprint — ' +
        `the staleness gate in e2e/tests/_registry.ts is blind to them:\n  ${blind.join('\n  ')}`,
    ).toEqual([]);
  });

  it('PERMANENT CONTROL: a file DROPPED from the basis moves the fingerprint', () => {
    const files = manifestBasisFiles();
    const baseline = manifestSourceFingerprint();
    // Renaming/removing a def must not read as "unchanged" — the hash covers
    // the PATH list, not just the concatenated bytes.
    const withoutOne = files.filter((f) => f !== files[files.length - 1]);
    expect(manifestSourceFingerprint(undefined, withoutOne)).not.toBe(baseline);
  });

  // ---------------------------------------------------------------------
  // The GENERATE seam. This is the ONLY thing in the unit lane that writes to
  // e2e/.generated/, and it is off unless `task test:emit-manifest` turns it on.
  // ---------------------------------------------------------------------

  it.runIf(process.env.MANIFEST_EMIT)(
    '[MANIFEST_EMIT] emits e2e/.generated/registry-manifest.json',
    () => {
      const res = emitRegistryManifest();
      expect(res.path).toBe(REGISTRY_MANIFEST_PATH);
      expect(res.modules).toBe(specs.length);
      const written = JSON.parse(readFileSync(res.path, 'utf8')) as {
        schemaVersion: number;
        sourceFingerprint: string;
      };
      expect(written.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
      // The consumer recomputes exactly this. If it does not match here, every
      // Playwright spec would refuse to load — fail in the fast lane instead.
      expect(written.sourceFingerprint).toBe(manifestSourceFingerprint());
    },
  );

  it('the unit lane does NOT write the real manifest unless MANIFEST_EMIT is set', () => {
    // The point of #1526, asserted rather than described. When the emit seam is
    // OFF, nothing above this line may have touched the artifact.
    if (process.env.MANIFEST_EMIT) return;
    let before: string | null = null;
    try {
      before = readFileSync(REGISTRY_MANIFEST_PATH, 'utf8');
    } catch {
      before = null;
    }
    // Re-running every writer-exercising path must still leave it alone: they
    // all take an explicit path argument, so none of them can reach the real one.
    const dir = mkdtempSync(resolve(tmpdir(), 'registry-manifest-guard-'));
    try {
      emitRegistryManifest(resolve(dir, 'x.json'), buildRegistryManifest('FIXED'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    let after: string | null = null;
    try {
      after = readFileSync(REGISTRY_MANIFEST_PATH, 'utf8');
    } catch {
      after = null;
    }
    expect(after, `${REGISTRY_MANIFEST_PATH} must be untouched by a plain unit run`).toBe(
      before,
    );
  });
});
