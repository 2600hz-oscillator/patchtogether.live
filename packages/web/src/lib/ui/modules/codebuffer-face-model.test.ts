// packages/web/src/lib/ui/modules/codebuffer-face-model.test.ts
//
// The CODE-BUFFER pair's faces — LIVECODE and the CLOCKED RUNNER it spawns —
// pinned where no pixel gate can see them, plus the permanent negative controls
// for the claims these two promotions rest on that are true by MECHANISM rather
// than by inspection.
//
// ⚠ ONE FILE FOR TWO MODULES, DELIBERATELY. The whole argument for promoting
// them together is that they are one instrument in two pieces, and three of the
// claims below are COMPARATIVE — they are about the difference between a module
// whose work lives in its factory and one whose work lived in its card. Splitting
// them would leave each half asserting a fact about the other module's file.
//
// THE CLAIMS:
//
//   1. `glyph: 'none'` is FORCED on both. A declaration cannot tell you whether
//      you chose it or the resolver did, so the resolver is asked.
//   2. THE EVALUATION SURVIVES A CARDLESS RACK. On `clockedRunner` it always
//      did — the tick subscription is in the FACTORY — and on `livecode` it did
//      NOT, which is the defect the promotion would have caused and instead
//      fixed. Both directions are asserted at source, because the difference is
//      invisible to every def-reading gate: neither def has anything to read.
//   3. THE RESTING STATUS TEXT IS GONE, NOT HIDDEN. Relocation and deletion look
//      identical from a green run, so each removed string is asserted ABSENT
//      from the faceplate body by name.
//   4. THE DIVISION ROSTER IS TOTAL against the tick maths, so a picker cannot
//      offer a division `divisionToBeatsPerTick` has no branch for.
//   5. THE BUFFER GEOMETRY IS ONE CONSTANT read by both bodies.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clockedRunnerDef, CLOCKED_RUNNER_DEFAULT_DIVISION } from '$lib/audio/modules/clocked-runner';
import { livecodeDef } from '$lib/audio/modules/livecode';
import { CLOCKED_DIVISIONS, divisionToBeatsPerTick } from '$lib/livecode/api-surface';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import { dockFullViewHeadPlan, hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { glyphBinding } from '$lib/ui/workflow/shell-glyph-live';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';
import { dockFacePlan } from '$lib/ui/workflow/curated-face';
import { NON_SHELL_LANE_TYPES } from '$lib/ui/workflow/legacy-fallback';
import { CARD_PRODUCER_LANE_TYPES, DOM_SOURCE_LANE_TYPES } from '$lib/ui/workflow/dom-source-modules';
import {
  CODE_BUFFER_FACE_H,
  CODE_BUFFER_FACE_MIN_W,
  CODE_BUFFER_LOG_MAX_H,
} from './code-buffer-face';
import { clockedRunnerDivisionOptions, clockedRunnerFiringDetail } from './clocked-runner-cell-actions';
import { livecodeRunDetail, type LivecodeRunRecord } from './livecode-cell-actions';

const SRC = resolve(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');

const CLOCKED_DEF_SRC = 'lib/audio/modules/clocked-runner.ts';
const LIVECODE_DEF_SRC = 'lib/audio/modules/livecode.ts';
const CLOCKED_BODY = 'lib/ui/modules/clockedRunner/ClockedRunnerEditorBody.svelte';
const LIVECODE_BODY = 'lib/ui/modules/livecode/LivecodeEditorBody.svelte';
const LIVECODE_ACTIONS = 'lib/ui/modules/livecode-cell-actions.ts';
const LIVECODE_CARD = 'lib/ui/modules/LivecodeCard.svelte';
const CLOCKED_CARD = 'lib/ui/modules/ClockedRunnerCard.svelte';

describe('the code-buffer pair — the ladder', () => {
  it('BOTH are PROMOTED, so the dock swap and the lane swap fire on each', () => {
    for (const t of ['clockedRunner', 'livecode']) {
      expect(STRICT_FACES.has(t), `${t} in STRICT_FACES`).toBe(true);
      expect(migrated(t), `${t}: an authored face that is not promoted is INERT`).toBe(true);
    }
  });

  it('each ranks exactly ONE cell, and it is the module\'s one non-document affordance', () => {
    expect(clockedRunnerDef.face?.order).toEqual(['clocked-runner-division-{n}']);
    expect(livecodeDef.face?.order).toEqual(['livecode-run-{n}']);
  });

  it('each declares ONE family, and it is the one `face.order` ranks', () => {
    // module-face-lint requires every declared family to be ranked AND rendered
    // exactly once, so a family is a promise to RANK rather than a vocabulary
    // list — which is why neither buffer is declared as one.
    for (const def of [clockedRunnerDef, livecodeDef]) {
      const ids = (def.controlFamilies ?? []).map((f) => f.id);
      expect(ids, `${def.type}: exactly one family`).toHaveLength(1);
      expect(
        def.face?.order?.includes(`${ids[0]}-{n}`),
        `${def.type}: the declared family is ranked`,
      ).toBe(true);
    }
  });

  it('each family\'s testidPrefix is a literal its LEGACY CARD already emits', () => {
    // module-docs-lint's card-drift leg greps real UI source for every declared
    // prefix. Neither promotion added a dead testid to satisfy it — both cards
    // carried these before the faces existed, and both survive under
    // `?shell=legacy`. Asserted here so a rename on either surface is red in the
    // unit lane too, where the message can say why.
    expect(read(CLOCKED_CARD)).toContain('data-testid="clocked-runner-division"');
    expect(read(LIVECODE_CARD)).toContain('data-testid="livecode-run"');
    expect(clockedRunnerDef.controlFamilies?.[0]?.testidPrefix).toBe('clocked-runner-division');
    expect(livecodeDef.controlFamilies?.[0]?.testidPrefix).toBe('livecode-run');
  });

  it('declares NO pages, NO rear and NO hero — one cell is one band', () => {
    for (const def of [clockedRunnerDef, livecodeDef]) {
      expect(def.face?.pages, `${def.type}: a header over one cell says nothing`).toBeUndefined();
      // `inputs` and `outputs` are both empty, so a rear group would resolve to
      // no port and module-face-lint refuses that outright.
      expect(def.face?.rear, `${def.type}: no jack for a group to name`).toBeUndefined();
      // A hero MOVES its key, so promoting the only cell empties the only band.
      expect(def.face?.hero, `${def.type}: a hero here would empty its band`).toBeUndefined();
    }
  });

  it('the one band really is ONE band, and it is not empty', () => {
    // `dockFacePlan` returns `[]` — truthy, and a BAND-LESS plate — for a face
    // that ranks nothing. Both of these rank one cell, so both get exactly one
    // `__unpaged` section, which is what the FACES roster's `pages: 1` claims.
    for (const def of [clockedRunnerDef, livecodeDef]) {
      const plan = dockFacePlan(def as never);
      expect(plan, `${def.type}: dockFacePlan is not null`).not.toBeNull();
      expect(plan!.length, `${def.type}: exactly one band`).toBe(1);
      expect(plan![0]!.controls.length, `${def.type}: the band carries the cell`).toBe(1);
    }
  });

  it('each owns a fullViewBody extension, which CLAIMS the dock head', () => {
    expect(clockedRunnerDef.face?.extension).toBe('clockedRunner');
    expect(livecodeDef.face?.extension).toBe('livecode');
    const plan = dockFullViewHeadPlan({
      view: 'dock-full',
      hasGlyph: false,
      heroCell: false,
      hasExtensionBody: true,
    });
    expect(plan.extBody, 'the code buffer paints at the dock').toBe(true);
    // ⚠ And it is DOCK-ONLY: a 192 px lane tile cannot carry a buffer, so the
    // lane keeps the ranked cell and nothing else.
    expect(
      dockFullViewHeadPlan({ view: 'lane', hasGlyph: false, heroCell: false, hasExtensionBody: true })
        .extBody,
      'the lane tile never paints a module surface',
    ).toBe(false);
  });

  it('each ranked key RESOLVES to a live cell of the kind the def argues for', () => {
    // A face key that resolves to no cell renders an explicitly INERT control.
    // Checked through the real resolver rather than by reading the registry, so
    // a param/non-param mix-up in `shellCellFor` is visible here.
    const div = shellCellFor('clockedRunner', {
      key: 'clocked-runner-division-{n}',
      kind: 'family',
    } as never);
    expect(div, 'the DIVISION cell resolves').not.toBeNull();
    expect(div!.kind, 'a selector — the card\'s own <select>, and 168 px flat').toBe('selector');

    const run = shellCellFor('livecode', { key: 'livecode-run-{n}', kind: 'family' } as never);
    expect(run, 'the RUN cell resolves').not.toBeNull();
    expect(run!.kind).toBe('action');
    // The probe is what stops a dead RUN passing green. It is a `data` probe
    // rather than an audition because no engine seam is touched.
    expect((run as { probe?: { effect?: { kind?: string; key?: string } } }).probe?.effect).toEqual({
      kind: 'data',
      key: 'lastRun',
      expect: 'changed',
    });
  });
});

describe('CLAIM 1 — `glyph: none` is FORCED, on both', () => {
  it('every other literal would resolve to a DEAD static binding', () => {
    for (const def of [clockedRunnerDef, livecodeDef]) {
      expect(def.face?.glyph, `${def.type}`).toBe('none');
      expect(def.outputs, `${def.type}: no port for a live-audio binding to find`).toEqual([]);
      expect(def.params, `${def.type}: no a/d/s/r for an envelope binding`).toEqual([]);
      // The resolver's own answer for each of the shapes the def comment rules
      // out. 'static' is the binding module-face-lint reddens by name.
      for (const glyph of ['scope', 'meter', 'waveform', 'envelope'] as const) {
        expect(
          glyphBinding({ ...def, face: { ...def.face!, glyph } } as never).kind,
          `${def.type}: '${glyph}' resolves dead`,
        ).toBe('static');
      }
      // ⚠ AND NOT A VIDEO SURFACE EITHER. `glyph: 'none'` plus a live thumbnail
      // and `glyph: 'none'` plus a blank tile are indistinguishable from the
      // declaration, so the other seam is asked directly.
      expect(hasVideoSurface(def as never), `${def.type}: audio domain, no thumb`).toBe(false);
    }
  });
});

describe('CLAIM 2 — the evaluation survives a rack with no card mounted', () => {
  // ⚠ THIS IS THE PAIR'S CENTRAL FINDING AND IT IS INVISIBLE TO EVERY
  // DEF-READING GATE, because neither def declares anything to read. It is also
  // the ES-9 question (#2205) asked of two modules that answer it oppositely.

  it('NEITHER module is in a lane set that would keep its card alive', () => {
    for (const t of ['clockedRunner', 'livecode']) {
      expect(NON_SHELL_LANE_TYPES.has(t), `${t}: the lane swaps to a face`).toBe(false);
      // Not in DOM_SOURCE ∪ CARD_PRODUCER — and since legacy-removal S1.5 the
      // off-screen `<HeadlessSourceHost>` is retired outright, so after
      // promotion NO card is kept mounted for ANY module. The two halves are
      // asserted separately because the union export retired with the host.
      expect(
        DOM_SOURCE_LANE_TYPES.has(t) || CARD_PRODUCER_LANE_TYPES.has(t),
        `${t}: nothing keeps this card mounted, so anything living only on it is deleted`,
      ).toBe(false);
    }
  });

  it('clockedRunner ticks from its FACTORY, so it never needed a surface', () => {
    const src = read(CLOCKED_DEF_SRC);
    // The subscription is taken inside `factory` and released in `dispose`, so
    // the loop is materialised from the GRAPH by the reconciler and is a
    // property of the NODE rather than of any window onto it.
    expect(src).toContain('const clock = getSchedulerClock();');
    expect(src).toContain('unsubscribeTick = clock.subscribe(tick);');
    expect(src).toContain('unsubscribeTick?.();');
    // And the card only ever READ it: the poll goes through `engine.read`, which
    // writes nothing.
    expect(read(CLOCKED_CARD)).toContain("e.read(node, 'lastError')");
  });

  it('livecode\'s factory does NOTHING, so its run had to leave the component', () => {
    const src = read(LIVECODE_DEF_SRC);
    // The negative control for the claim above: this def's handle installs no
    // timer and no subscription, which is exactly why leaving `runScript` on the
    // card would have shipped a module that cannot do anything.
    expect(src).not.toContain('subscribe(');
    expect(src).not.toContain('setInterval');
    expect(src).toContain('// no-op — LIVECODE has no params');

    // The evaluation now lives in a plain `.ts` module, reachable from the
    // ranked cell (and therefore from the LANE TILE), the faceplate body and the
    // legacy card.
    const actions = read(LIVECODE_ACTIONS);
    expect(actions).toContain('export function runLivecodeNode');
    expect(actions).toContain("from '$lib/livecode/runtime'");
  });

  it('ALL THREE surfaces call the SAME run, so none can drift', () => {
    // Two evaluators would be two answers to "what does Run do". The registry
    // entry, the body's test hook and the card all name the shared action.
    expect(read('lib/ui/workflow/shell-cells.ts')).toContain('runLivecodeNode(nodeId)');
    expect(read(LIVECODE_BODY)).toContain('runLivecodeNode(nodeId)');
    expect(read(LIVECODE_CARD)).toContain('runLivecodeNode(id)');
    // ⚠ AND THE RUN IS NOT DEFINED IN ANY COMPONENT. A `.svelte` copy is exactly
    // the regression this whole claim is about, so it is denied by name.
    for (const f of [LIVECODE_BODY, LIVECODE_CARD]) {
      expect(read(f), `${f}: the run is called, never re-implemented`).not.toContain(
        'function runLivecodeNode',
      );
    }
  });

  it('the RUN cell reads the LIVE buffer, not the 250 ms-old committed one', () => {
    // Both editors debounce their commit, so `node.data.text` is stale while
    // someone is typing — and "Run ran the version before your last keystroke"
    // is the #1583 class. The mounted editor publishes a flush; with none
    // mounted (a press on the lane tile) the committed text IS the live text.
    const actions = read(LIVECODE_ACTIONS);
    expect(actions).toContain('export function registerLivecodeEditor');
    expect(actions).toContain('const flush = editors.get(nodeId);');
    for (const f of [LIVECODE_BODY, LIVECODE_CARD]) {
      expect(read(f), `${f}: publishes its flush`).toContain('registerLivecodeEditor(');
      expect(read(f), `${f}: and releases it on unmount`).toContain('releaseEditor');
    }
  });

  it('a FAILED run is RECORDED, never dropped', () => {
    // The audition ledger's principle applied to an evaluation: "never pressed"
    // and "pressed and threw" must stay distinguishable, which is also what
    // makes the `data` probe honest.
    const failed: LivecodeRunRecord = {
      seq: 1, ok: false, error: '2:5: Unexpected token', mutations: 0, log: [],
    };
    expect(livecodeRunDetail(failed)).toBe('2:5: Unexpected token');
    expect(livecodeRunDetail(null), 'never run reads differently from ran-and-failed').toBe(
      'the script has not been run yet',
    );
    expect(livecodeRunDetail({ seq: 1, ok: true, error: null, mutations: 1, log: [] })).toBe(
      '1 rack change applied',
    );
  });
});

describe('CLAIM 3 — the resting status text is GONE, not relocated', () => {
  // ⚠ THE INVERSE ASSERTION. Moving a string and deleting it look identical from
  // a green run, so each removed string is named and asserted ABSENT from the
  // faceplate body. The lamps' sentences reach `aria-label` and `title` through
  // `StatusLed.detail` and never a text node.

  it('the runner\'s `fired {n}x (every {division})` line does not paint on the FACE', () => {
    const body = read(CLOCKED_BODY);
    expect(body, 'the deleted count line').not.toContain('fired {');
    expect(body, 'and not as a template either').not.toContain('`fired ${');
    expect(body, 'the measurements go through the lamp primitive').toContain('StatusLed');
    expect(body).toContain('caption="FIRING"');
    expect(body).toContain('caption="ERROR"');
  });

  it('livecode\'s status line and its log placeholder do not paint on the FACE', () => {
    const body = read(LIVECODE_BODY);
    expect(body, 'the resting instruction').not.toContain('Type a script and press Run');
    expect(body, 'the empty-state placeholder — reclaimed space, not hidden text').not.toContain(
      'output log appears here after Run',
    );
    expect(body, 'the mutation count').not.toContain('mutations applied');
    expect(body).toContain('caption="RUN"');
  });

  it('the CARDS keep theirs — the rulings are about FACEPLATES', () => {
    // The legacy cards are explicitly untouched by the 2026-08-19 rulings, and
    // they still render under `?shell=legacy`. Asserted so a later sweep does not
    // "finish the job" on a surface the ruling never covered.
    expect(read(LIVECODE_CARD)).toContain('Type a script and press Run');
    expect(read(CLOCKED_CARD)).toContain('data-testid="clocked-runner-status"');
  });

  it('NEGATIVE CONTROL — the absence checks can SEE a painted string', () => {
    // Three of the four assertions above are `not.toContain`, which passes on an
    // unreadable file, a renamed file, or a typo in the needle. This leg calls
    // the same reader on the same files with a needle that IS there.
    expect(read(CLOCKED_BODY)).toContain('clocked-runner-body-');
    expect(read(LIVECODE_BODY)).toContain('livecode-body-');
  });
});

describe('CLAIM 4 — the division roster is TOTAL against the tick maths', () => {
  it('every offered division has a `divisionToBeatsPerTick` branch', () => {
    // DERIVED MEMBERSHIP, not a length: a roster that skipped a value would
    // leave a state the factory can tick at and the picker cannot name.
    const offered = clockedRunnerDivisionOptions().map((o) => o.value);
    expect(offered).toEqual([...CLOCKED_DIVISIONS]);
    for (const d of offered) {
      const beats = divisionToBeatsPerTick(d as never);
      expect(beats, `${d} has a period`).toBeGreaterThan(0);
      expect(Number.isFinite(beats), `${d} is finite`).toBe(true);
    }
  });

  it('the default the picker falls back to is one the roster offers', () => {
    expect(CLOCKED_DIVISIONS as readonly string[]).toContain(CLOCKED_RUNNER_DEFAULT_DIVISION);
  });

  it('the FIRING lamp distinguishes "not yet" from "running"', () => {
    const idle = clockedRunnerFiringDetail({ lastError: null, fires: 0, errors: 0, bpm: 0 }, '1/16');
    const live = clockedRunnerFiringDetail({ lastError: null, fires: 12, errors: 0, bpm: 140 }, '1/16');
    expect(idle).not.toBe(live);
    expect(live).toContain('12');
    expect(live).toContain('140');
  });
});

describe('CLAIM 5 — the buffer geometry is ONE constant, read by both bodies', () => {
  it('both bodies bind the shared numbers rather than re-typing them', () => {
    for (const f of [CLOCKED_BODY, LIVECODE_BODY]) {
      const src = read(f);
      expect(src, `${f}: imports the shared geometry`).toContain(
        "from '$lib/ui/modules/code-buffer-face'",
      );
      expect(src, `${f}: binds the width through a custom property`).toContain(
        '--buf-min-w:${CODE_BUFFER_FACE_MIN_W}px',
      );
      expect(src, `${f}: and the height`).toContain('--buf-h:${CODE_BUFFER_FACE_H}px');
      expect(src, `${f}: the CSS reads the property, never a literal`).toContain(
        'min-width: var(--buf-min-w)',
      );
    }
    expect(read(LIVECODE_BODY)).toContain('--log-max-h:${CODE_BUFFER_LOG_MAX_H}px');
  });

  it('the buffer is genuinely wider than either face\'s widest cell', () => {
    // The reason these faces carry a `FACE_WIDTH_EXEMPTIONS` entry: the plate is
    // driven by the buffer, and the gate's ink measure cannot see an EMPTY text
    // buffer (its BOXY set is cells, canvases, svg and images; everything else is
    // measured by Range over its text nodes). A `selector` is 168 CSS px and an
    // `action` is 58, so without the floor the buffer would render narrower than
    // the module's own name row.
    const WIDEST_CELL_PX = 168; // `selector`, per the dock cell-width table
    expect(CODE_BUFFER_FACE_MIN_W).toBeGreaterThan(WIDEST_CELL_PX);
    // ...and it stays inside the 1220 px dock capture box with room to spare, so
    // the face is compact by the standard the width ruling actually sets.
    expect(CODE_BUFFER_FACE_MIN_W).toBeLessThan(600);
    // The buffer must not push the ranked band past the dock's ~425 px fold.
    expect(CODE_BUFFER_FACE_H + CODE_BUFFER_LOG_MAX_H).toBeLessThan(425);
  });
});
