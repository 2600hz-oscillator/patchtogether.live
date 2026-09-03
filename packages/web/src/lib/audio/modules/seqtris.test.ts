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
  // Scoped to SEQTRIS's own closure on purpose: this is a regression test for
  // the bug that happened here, not a new repo-wide gate.
  //
  // ⚠ THE LIST NOW COVERS THE TWO FACE BODIES AND THE SHARED WELL, and the
  // REGEX HAD TO CHANGE FOR THEM TO MEAN ANYTHING. `^import` with the `m` flag
  // cannot match a `.svelte` file's imports: they live inside `<script>` and are
  // INDENTED, so the anchor never fires and every added Svelte file would have
  // matched nothing and passed VACUOUSLY — a green test that had stopped
  // reading its subject. `^\s*import` is the fix, and the non-vacuity leg below
  // is what proves the matcher can still see anything at all in each file.
  const LAZY_IMPORT_GUARDED = [
    './seqtris.ts',
    '../seqtris-launchpad.ts',
    // The UI half. These are NOT reachable from the def (the extension is
    // discovered by a glob in the UI layer, so the ART registry never loads
    // them), but they are the files a future edit would most naturally reach
    // for a `LaunchpadPort` VALUE import — and the constraint is worth stating
    // where that edit happens.
    '../../ui/modules/seqtris/SeqtrisWellBody.svelte',
    '../../ui/modules/seqtris/SeqtrisTileBody.svelte',
    '../../ui/modules/seqtris/SeqtrisWell.svelte',
  ] as const;

  const STATIC_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+'([^']+)';/gm;

  for (const rel of LAZY_IMPORT_GUARDED) {
    it(`${rel} imports the Launchpad device layer lazily, never as a static value`, () => {
      const src = readFileSync(resolve(__dirname, rel), 'utf8');
      const all = [...src.matchAll(STATIC_IMPORT)].map((m) => m[1]!);
      // ⚠ NON-VACUITY, PER FILE. A regex that matches nothing makes the
      // assertion below pass for the wrong reason, which is exactly what the
      // original `^import` did to every Svelte file. Each guarded file really
      // does have static value imports, so seeing none means the matcher is
      // broken rather than the file being clean.
      expect(
        all.length,
        `${rel}: the static-import matcher found NOTHING, so the assertion below would pass `
          + 'on a file that statically imported the device layer. Fix the matcher, not the file.',
      ).toBeGreaterThan(0);

      const statics = all.filter(
        (spec) => spec.includes('launchpad-device') || spec.includes('launchpad-map'),
      );
      expect(
        statics,
        `${rel} must not statically import a rune-bearing Launchpad module — `
          + 'the ART lane runs this def with no Svelte compiler. Use `import type`, '
          + 'or the dynamic import() in seqtris-launchpad.ts connect().',
      ).toEqual([]);
    });
  }

  it('POSITIVE CONTROL: the matcher DOES catch a static device import when one exists', () => {
    // The instrument, driven against a synthetic offender in each of the two
    // source shapes the list contains. Without this the legs above are an
    // assertion about a regex nobody has watched fail.
    const offenders = [
      "import { bindUnit } from '$lib/control/launchpad/launchpad-device.svelte';",
      "  import { emptyFrame } from '$lib/control/launchpad/launchpad-map';",
    ];
    for (const line of offenders) {
      const hits = [...line.matchAll(new RegExp(STATIC_IMPORT.source, 'gm'))]
        .map((m) => m[1]!)
        .filter((spec) => spec.includes('launchpad-device') || spec.includes('launchpad-map'));
      expect(hits, `the matcher must see: ${line}`).toHaveLength(1);
    }
    // …and it must still ERASE a type-only import, which is the sanctioned form
    // every one of the guarded files actually uses.
    const typeOnly = "  import type { LaunchpadPort } from '$lib/control/launchpad/launchpad-device.svelte';";
    expect([...typeOnly.matchAll(new RegExp(STATIC_IMPORT.source, 'gm'))]).toHaveLength(0);
  });

  // ── THE FACE, PROMOTED ────────────────────────────────────────────────────
  //
  // ⚠ THIS LEG IS AN INVERSION, NOT AN ADDITION. It read "declares NO face —
  // the bespoke-surface disposition is deliberate" and asserted
  // `seqtrisDef.face` was `undefined`. The disposition was retired by the
  // EXTENSION SEAM rather than by a change of mind about the module: the well,
  // the hardware column and CONNECT live in `fullViewBody` / `tileBody`, so the
  // two knobs can be ranked without leaving the board and the controller
  // behind. The shape legs live in `seqtris-face-model.test.ts`; this one holds
  // the def's own end of it.
  it('declares a face — promoted, with the bodies carrying the game', () => {
    const face = seqtrisDef.face;
    expect(face, 'the def must declare a face; STRICT_FACES is asserted EQUAL to that set')
      .toBeDefined();
    expect(face!.order).toEqual(['gravity', 'quantize']);
    expect(face!.glyph).toBe('none');
    expect(face!.extension).toBe('seqtris');
    expect(face!.pages?.map((p) => p.id)).toEqual(['fall']);
    // ⚠ NO `paramCells`: a KNOB is what the shell already resolves for both
    // params, which is what the card draws — and there is no 'knob' literal in
    // the union to declare even if one wanted to.
    expect(face!.paramCells).toBeUndefined();
    // The rank must still cover every declared param — the completeness bar
    // module-face-lint holds for the STRICT_FACES set, asserted here too so a
    // param added later fails in the module's own file first.
    expect([...face!.order].sort()).toEqual(seqtrisDef.params.map((p) => p.id).sort());
    expect(seqtrisDef.controlFamilies).toBeUndefined();
  });

  it('the face is UI metadata only — no param, port or option roster moved', () => {
    // ⚠ The contract-diff claim, asserted rather than promised. A face PR that
    // moved any of these would owe a contract-lock re-pin and (for a def in the
    // basis) an attest run; this module's diff is provably behaviour-neutral.
    expect(seqtrisDef.params.map((p) => p.id)).toEqual(['gravity', 'quantize']);
    expect(seqtrisDef.inputs.map((p) => p.id)).toEqual(['clock']);
    expect(seqtrisDef.outputs.map((p) => p.id)).toEqual(['piece', 'board', 'line', 'spawn']);
    // ⚠ AND THE `quantize` LABELS ARE NOT RE-TYPED ON THE FACE. The shell reads
    // the def's own `options` roster; a second copy in `face` is the same
    // one-source violation as re-typing a range, and the same gate family.
    //
    // ⚠ ONLY `'free'` IS SEARCHABLE THIS WAY, and saying why is the point:
    // `'clock'` is ALSO the input jack's id and the rear group's label, so the
    // string is legitimately present and a blanket scan flags the wrong thing.
    // (Measured — this assertion failed on its first run for exactly that
    // reason.) `'free'` appears nowhere else in the face, so it is the half
    // that can carry the claim; the structural leg beside it covers the rest.
    const faceJson = JSON.stringify(seqtrisDef.face);
    expect(
      faceJson.includes('"free"'),
      "the face must not re-type the 'free' option label — it is declared on the param",
    ).toBe(false);
    // The structural form of the same rule: a face may not carry an `options`
    // roster at all, whatever the labels in it happen to be.
    expect(faceJson.includes('"options"')).toBe(false);
    // POSITIVE CONTROL: the scan can see a re-typed roster when there is one,
    // so the two legs above are not passing on a search that finds nothing.
    const offending = JSON.stringify({
      ...seqtrisDef.face,
      options: [{ value: 0, label: 'free' }],
    });
    expect(offending.includes('"free"')).toBe(true);
    expect(offending.includes('"options"')).toBe(true);
  });

  // ⚠ THE REAR RAIL IS AUTHORED, AND THE SLOT ID IS NOT FREE. `clock` is a real
  // signal input with NO paramTarget, so the derived rail would render one
  // anonymous jack. An input group must claim the LEADING slot
  // ('voice'/'signal') or name a declared page, or it appends as a stray band
  // after every page and the rear totality gate cannot see it.
  it('the rear rail groups the clock jack into the LEADING signal slot', () => {
    const groups = seqtrisDef.face!.rear?.groups ?? [];
    expect(groups.map((g) => [g.id, g.label, [...g.ports]])).toEqual([
      ['signal', 'clock', ['clock']],
    ]);
    // Every grouped port must exist on the direction it claims (module-face-lint
    // refuses otherwise, and a typo here is invisible in the rendered rail).
    const inputIds = new Set(seqtrisDef.inputs.map((p) => p.id));
    for (const g of groups) {
      for (const port of g.ports) {
        expect(inputIds.has(port), `rear group '${g.id}' names a non-input port '${port}'`)
          .toBe(true);
      }
    }
  });
});
