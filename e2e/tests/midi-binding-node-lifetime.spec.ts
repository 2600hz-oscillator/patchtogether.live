// e2e/tests/midi-binding-node-lifetime.spec.ts
//
// #1727 — "a MIDI CC bound to an UN-MIGRATED module is silently INERT on the
// DEFAULT shell." THE REPRODUCTION, and then the regression guard.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
// A binding lives in a PERSISTED map keyed by (nodeId, paramId). Its SETTER did
// not: every control registered one `onMount` and dropped it `onDestroy`, and
// dispatch fired only where the two intersected. On the default shell an
// un-migrated module renders as <ModuleShellPlaceholder>, which mounts no
// param control at all — so the binding survived, showed as assigned, exported,
// round-tripped through localStorage, and did nothing. The param LATCHED at
// whatever the hardware last successfully wrote.
//
// The fix makes delivery a property of the GRAPH, not of a view: dispatch
// resolves (nodeId, paramId) against the live patch + the module def when no
// control has registered a setter. See $lib/midi/graph-param-dispatch.
//
// ── THE INSTRUMENT, AND WHY IT CANNOT READ "INERT" WHEN IT SIMPLY NEVER LOOKED
// The whole claim is a NEGATIVE ("the CC did not land"), which is the shape that
// a probe which never looked reports identically. So every phase here reports,
// in the assertion message: whether the inject hook actually fired, the persisted
// binding it found in localStorage, how many of the module's own controls are
// mounted RIGHT NOW, the rAF frames sampled, the wall-clock elapsed, and every
// distinct param value seen. And the phases are ordered so the negative is
// bracketed by deliveries the SAME probe did see:
//
//   A. card MOUNTED   → CC moves the param   (positive control: probe + inject work)
//   B. card GONE      → CC moves the param   (THE CLAIM — red before the fix)
//   C. card RE-MOUNTED→ CC moves the param   (permanent negative control the other
//                                             way: the injector is still alive, so a
//                                             frozen reading in B cannot be "the
//                                             simulated device died")
//
// Phase B additionally asserts the module's controls are mounted ZERO times, so
// it cannot pass by the card having quietly stayed alive.
//
// ── FRAMES, NEVER MILLISECONDS ───────────────────────────────────────────────
// Every wait is an in-page rAF frame count that EXITS ON THE EVENT (the param
// changed); the frame cap only bounds a failure. The accumulator lives in the
// page — one evaluate per phase, never one round-trip per sample.
//
// ── SUBJECTS ─────────────────────────────────────────────────────────────────
// DERIVED, not declared: the subject module must be ABSENT from STRICT_FACES
// (parsed from the shared source), because a promoted module renders a real
// <ModuleShell> with real controls and would test the wrong lane. If the subject
// is ever promoted, this spec fails loudly instead of silently going vacuous.
//
// ── WHAT A GREEN RUN HERE STRUCTURALLY CANNOT SEE ────────────────────────────
//   * ONE module. This is a runtime proof on a representative un-migrated
//     module; the claim that EVERY declared param of EVERY registered module is
//     graph-resolvable is the registry-wide, both-directions assertion in
//     `$lib/midi/graph-param-dispatch.test.ts`. Neither leg substitutes for the
//     other — this one proves the wiring, that one proves the coverage.
//   * NOTE bindings. Gate INPUT PORTS are covered by the same fallback and by
//     <PatchPanel> mounting on both lane renders; a NOTE bound to a card BUTTON
//     (a synthetic action id) is NOT covered anywhere and stays card-scoped —
//     see the header of `$lib/midi/graph-param-dispatch.ts`.
//   * The RANGE a mounted control uses. Phase A and phase B agreeing here says
//     the subject's Knob and the subject's def agree; a card that re-typed a
//     different range would diverge, and no runtime gate sees that. ⚠ For the
//     CURRENT subject the hole is REAL but currently harmless: the def declares
//     `scale` as `min: 0, max: 5, defaultValue: 2` and `Moog956Card.svelte`
//     RE-TYPES exactly those three numbers as literals rather than importing
//     them, so the two agree by inspection today and nothing gates it —
//     `moog956` is not in `RANGE_BOUND_CARDS`. That is the backdraft shape
//     sitting one edit away, and the caveat stands as written.

// `_fixtures` (not bare @playwright/test) for `errorWatch`: this spec expands,
// collapses and LRU-evicts real cards, which is exactly the flow a lifetime bug
// announces itself in as a console error.
import { test, expect, type Page } from './_fixtures';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnPatch } from './_helpers';
import { REGISTRY } from './_registry';

const STRICT_FACES_SRC = readFileSync(
  fileURLToPath(
    new URL('../../packages/web/src/lib/ui/workflow/strict-faces.ts', import.meta.url),
  ),
  'utf8',
);

/** The PROMOTED set, parsed off its export (anchored on `export const`, never a
 *  bare name match — the same footgun `card-producer-lifetime.spec.ts` records,
 *  where an unanchored regex ran on to the file header's prose mention). */
function strictFaces(): Set<string> {
  const block = /export const STRICT_FACES[^[]*\[([\s\S]*?)\n\]/.exec(STRICT_FACES_SRC);
  if (!block) throw new Error('could not parse STRICT_FACES — has the shape changed?');
  const types = [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (types.length === 0) throw new Error('STRICT_FACES parsed EMPTY — refusing to pass vacuously');
  return new Set(types);
}

const PROMOTED = strictFaces();

/** The subject: an UN-MIGRATED audio module with a plain [0,1] param and a
 *  legacy card that renders it as a Knob. Its un-migrated-ness is ASSERTED
 *  below, not assumed.
 *
 *  ⚠ RE-POINTED TWICE IN ONE DAY (2026-08-20): `wavecel` → `depolarizer` →
 *  `moog956`. Both times the `beforeAll` precondition fired exactly as designed
 *  — *"Re-point this spec at a module that is still un-migrated"* — and the
 *  guard working is the only reason this spec did not silently go vacuous
 *  against a `<ModuleShell>`. It is filed as #2068, because the CHURN is the
 *  defect and a third re-point does not fix it.
 *
 *  ⚠ THE PREVIOUS PICK'S REASONING WAS WRONG, AND SPECIFICALLY SO — read this
 *  before choosing a fourth. `depolarizer` was called "structurally
 *  un-promotable" on the faceplate skill's STOP 1 refusal ("≤2 params, no
 *  control families, no node.data-backed affordances … the same grounds on
 *  which `noise` is refused"). Both halves were false: `noise` was ALREADY in
 *  STRICT_FACES when it was cited, and the owner had directed the opposite —
 *  *"they still need to be done, <4 params or not"* (2026-08-20) — so the
 *  batch-18 blitz promoted `depolarizer` hours later. That skill text is
 *  corrected in #2067; do not resurrect the argument from a stale copy.
 *
 *  ⚠ SO THE PICK IS NOW MADE ON DISPOSITION, NOT ON THINNESS. `moog956` is
 *  `bespoke-surface` in the face-migration inventory: its primary interaction
 *  is a ribbon DRAG, not a param, so it needs a hand-written surface behind the
 *  extension seam rather than a ranked cell list. No lane or directive is
 *  face-queueing that disposition, so the subject does not expire with this
 *  blitz or the next batch — which is exactly how both prior picks died, by
 *  borrowing from the `generic-face` population being actively drained.
 *
 *  It is still only a delay, not a fix: EVERY module is eventually migrated off
 *  the legacy card, so in the limit no valid subject exists. #2068 carries the
 *  durable shape (a forced-placeholder harness hook rather than a registry
 *  fixture, which would auto-enrol in every registry-driven sweep).
 *
 *  ⚠ THE "[0,1] param" REQUIREMENT THIS COMMENT USED TO STATE IS NOT REAL, and
 *  believing it needlessly narrowed the candidate set to one heavyweight looper
 *  card. `ccToParam` maps CC 0..127 across the param's OWN declared
 *  `[min,max]`, read off the registry manifest at `beforeAll` — so any range
 *  works and the expectation is derived, never hard-coded. `moog956`'s `scale`
 *  is `0..5 linear`, and `Moog956Card.svelte` renders it as `<Knob
 *  label="Scale">` (the Knob sets `aria-label={label}`). */
const SUBJECT = {
  nodeId: 'mb-rb',
  type: 'moog956',
  paramId: 'scale',
  /** The Knob's aria-label on the legacy card — how the mounted-control count
   *  is taken. `<Knob>` sets `aria-label={label}`, and Moog956Card passes
   *  `label="Scale"`. */
  ariaLabel: 'Scale',
  channel: 0,
  cc: 21,
} as const;

/** Two more un-migrated modules used only as LRU pressure (opening a third
 *  full-view evicts the least-recently-opened pane — MAX_FULLVIEW_PANES). */
const CROWD = ['mb-x', 'mb-y'] as const;

/** Frame CAP on "did the param move". It BOUNDS THE FAILURE — the watcher exits
 *  the frame the value changes, so a healthy delivery costs 1-2 frames. The
 *  durable commit is the CC pump's LEADING EDGE (cc-commit.ts: a cold stream
 *  commits at end-of-microtask), so anything beyond a couple of frames is
 *  already pathological; the rest of the cap exists so a FAILURE prints a full
 *  series instead of timing out. */
const MOVE_CAP_FRAMES = 90;

interface Watch {
  injected: boolean;
  before: number | null;
  after: number | null;
  moved: boolean;
  frames: number;
  elapsedMs: number;
  /** Every distinct value the param took while watching, in first-seen order. */
  distinct: number[];
  /** The persisted binding record for this key, straight out of localStorage. */
  storedBinding: string;
  /** How many of the module's own controls are mounted in the document RIGHT
   *  NOW — 0 is the placeholder lane, ≥1 means a real card is somewhere. */
  mountedControls: number;
}

/**
 * ONE evaluate: read the param, inject a CC, then rAF-sample the param IN THE
 * PAGE until it changes (capped in FRAMES). Returns everything an assertion
 * message needs to distinguish "did not land" from "never looked".
 */
async function injectAndWatch(
  page: Page,
  args: { nodeId: string; paramId: string; ariaLabel: string; channel: number; cc: number; value: number },
): Promise<Watch> {
  return page.evaluate(
    async ({ nodeId, paramId, ariaLabel, channel, cc, value, cap }) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { params?: Record<string, number> }> };
        __midiTestInject?: (c: number, cc: number, v: number) => boolean;
      };
      const read = (): number | null => {
        const v = w.__patch?.nodes?.[nodeId]?.params?.[paramId];
        return typeof v === 'number' ? v : null;
      };
      // NODE-SCOPED, not document-wide: the LRU leg has three nodes of the same
      // type on the canvas, and a document-wide count reads the OTHER modules'
      // knobs as if the subject's card were alive. Scoped to every place this
      // node's real card can be mounted — its dock pane, its lane node, and the
      // headless source host.
      const controls = () => {
        const scopes = document.querySelectorAll(
          `[data-fullview-node="${nodeId}"], .svelte-flow__node[data-id="${nodeId}"], [data-node-id="${nodeId}"]`,
        );
        let n = 0;
        for (const s of Array.from(scopes)) {
          n += s.querySelectorAll(`[role="slider"][aria-label="${ariaLabel}"]`).length;
        }
        return n;
      };
      const storedBinding = (() => {
        try {
          const raw = window.localStorage.getItem('pt.midi-bindings.v1');
          if (!raw) return '(no pt.midi-bindings.v1 in localStorage)';
          const all = JSON.parse(raw) as Array<{ key?: string }>;
          const mine = all.filter((b) => b?.key === `${nodeId}:${paramId}`);
          return mine.length ? JSON.stringify(mine) : `(none for ${nodeId}:${paramId} in ${JSON.stringify(all)})`;
        } catch (e) {
          return `(unreadable: ${String(e)})`;
        }
      })();

      const before = read();
      const seen: number[] = [];
      const push = (v: number | null) => {
        if (v !== null && !seen.includes(v)) seen.push(v);
      };
      push(before);

      if (typeof w.__midiTestInject !== 'function') {
        throw new Error('__midiTestInject hook not present — a DEV/VITE_E2E_HOOKS build is expected');
      }
      const t0 = performance.now();
      const injected = w.__midiTestInject(channel, cc, value) === true;

      let n = 0;
      await new Promise<void>((resolve) => {
        const tick = () => {
          n++;
          const v = read();
          push(v);
          if ((v !== before && v !== null) || n >= cap) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const after = read();
      return {
        injected,
        before,
        after,
        moved: after !== before,
        frames: n,
        elapsedMs: Math.round(performance.now() - t0),
        distinct: seen,
        storedBinding,
        mountedControls: controls(),
      };
    },
    { ...args, cap: MOVE_CAP_FRAMES },
  );
}

function fmt(phase: string, w: Watch, expected: number): string {
  return (
    `[${phase}] injected=${w.injected} · binding=${w.storedBinding} · ` +
    `mounted "${SUBJECT.ariaLabel}" controls=${w.mountedControls} · ` +
    `param ${SUBJECT.nodeId}.${SUBJECT.paramId}: before=${w.before} after=${w.after} ` +
    `(expected ≈${expected.toFixed(4)}) · distinct values seen=[${w.distinct.join(', ')}] · ` +
    `watched ${w.frames} rAF frames (cap ${MOVE_CAP_FRAMES} frames) in ${w.elapsedMs} ms wall`
  );
}

/** CC 0..127 → a param's declared [min,max] (ccValueToParamValue's contract). */
function ccToParam(ccValue: number, min: number, max: number): number {
  return min + (Math.max(0, Math.min(127, ccValue)) / 127) * (max - min);
}

async function openFullView(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    (globalThis as unknown as { __openDockFullView: (i: string) => void }).__openDockFullView(id);
  }, nodeId);
}

async function boot(page: Page): Promise<void> {
  // Plain `/rack` — the DEFAULT faceplate shell. Under `?shell=legacy` the real
  // card renders in the lane and this defect is invisible, which is exactly how
  // the existing midi-learn.spec.ts (on the `rack` fixture) stayed green
  // through it.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));
}

/**
 * Install the simulated MIDI device BEFORE anything arms a learn.
 *
 * ⚠ LOAD-BEARING, and it is a real race, not belt-and-braces. `beginLearn` is
 * `await connect()` THEN `learnSpec = spec`. With no device installed,
 * `connect()` in headless Chromium goes to the REAL
 * `navigator.requestMIDIAccess()`, which does not resolve promptly — so the
 * learn is not yet armed when the first injected CC arrives, the capture is
 * dropped, and no binding forms. Pre-installing makes `connect()` hit its
 * `if (access) return true` fast path. (`__midiTestInject` would install the
 * device itself, but only on the message that has already been missed.)
 */
async function installSimMidi(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __midiTestInstall?: () => boolean }).__midiTestInstall === 'function',
  );
  await page.evaluate(() => {
    (globalThis as unknown as { __midiTestInstall: () => boolean }).__midiTestInstall();
  });
}

/** The subject's knob wrapper in the open dock full-view — it carries the
 *  `midi-learning` / `midi-bound` state classes, which is how "the learn is
 *  actually armed" becomes an assertion instead of an assumption. */
function knobWrap(page: Page) {
  return page
    .locator('[data-testid="dock-full-view"]')
    .locator(`.knob-wrap:has([role="slider"][aria-label="${SUBJECT.ariaLabel}"])`)
    .first();
}

/** Right-click the subject's Knob in the open dock full-view and arm MIDI Learn. */
async function armLearn(page: Page): Promise<void> {
  const wrap = knobWrap(page);
  await expect(wrap).toBeVisible({ timeout: 20_000 });
  await wrap.locator(`[role="slider"][aria-label="${SUBJECT.ariaLabel}"]`).click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await expect(menu).toBeHidden();
  // The learn is ARMED — asserted on the control's own state, so an injected CC
  // can never race ahead of `beginLearn`'s awaited `connect()`.
  await expect(wrap, 'MIDI Learn must be armed before the first CC is injected').toHaveClass(
    /midi-learning/,
    { timeout: 20_000 },
  );
}

test.describe('#1727 — a MIDI CC binding outlives every view of its module', () => {
  test.beforeAll(() => {
    // DERIVED PRECONDITION, asserted rather than assumed: the subject must be
    // UN-MIGRATED, or the default shell renders a real <ModuleShell> with real
    // controls and this whole spec silently tests the wrong lane.
    expect(
      PROMOTED.has(SUBJECT.type),
      `${SUBJECT.type} has been PROMOTED into STRICT_FACES, so it no longer renders as a ` +
        'placeholder on the default shell. Re-point this spec at a module that is still ' +
        'un-migrated (the defect class is not module-specific).',
    ).toBe(false);
    // …and it must actually declare the param this spec binds.
    const mod = REGISTRY.find((m) => m.type === SUBJECT.type);
    expect(mod, `${SUBJECT.type} is missing from the registry manifest`).toBeTruthy();
    expect(
      mod!.params.map((p) => p.id),
      `${SUBJECT.type} must declare ${SUBJECT.paramId}`,
    ).toContain(SUBJECT.paramId);
  });

  test('a learned CC keeps driving the param after the card that learned it is COLLAPSED', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const mod = REGISTRY.find((m) => m.type === SUBJECT.type)!;
    const pd = mod.params.find((p) => p.id === SUBJECT.paramId)!;

    await boot(page);
    await spawnPatch(
      page,
      [{ id: SUBJECT.nodeId, type: SUBJECT.type, domain: 'audio', params: { [SUBJECT.paramId]: 0 } }],
      [],
      { mountTimeout: 30_000 },
    );

    // The default lane shows the uniform tile — the module's own card is NOT
    // here. This is the state the defect lives in.
    await expect(
      page.locator(`.svelte-flow__node[data-id="${SUBJECT.nodeId}"] [data-testid="module-shell-placeholder"]`),
    ).toHaveCount(1, { timeout: 20_000 });

    // ── ARRANGE: the only way a user can learn a CC here is the dock full-view.
    await installSimMidi(page);
    await openFullView(page, SUBJECT.nodeId);
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 30_000 });
    await armLearn(page);

    // ── A. POSITIVE CONTROL (permanent): the card IS mounted. The learn capture
    //      itself applies the value, so this proves the probe, the inject hook
    //      and the scaling all work before anything is taken away.
    const expectedA = ccToParam(64, pd.min, pd.max);
    const a = await injectAndWatch(page, { ...SUBJECT, value: 64 });
    expect(a.moved, `phase A must deliver while the card is mounted. ${fmt('A · card mounted', a, expectedA)}`).toBe(true);
    expect(a.after!, fmt('A · card mounted', a, expectedA)).toBeCloseTo(expectedA, 2);
    expect(a.mountedControls, fmt('A · card mounted', a, expectedA)).toBeGreaterThan(0);
    // The binding EXISTS — the precondition for phases B and C, asserted on the
    // control's own bound-state class rather than inferred from the value move.
    await expect(knobWrap(page), 'the learn must have produced a binding').toHaveClass(/midi-bound/);

    // ── ACT: collapse the full-view. The card unmounts; the binding does not.
    await page.getByTestId('faceplate-collapse').first().click();
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(
      page.locator(`[role="slider"][aria-label="${SUBJECT.ariaLabel}"]`),
      'the subject\'s control must be gone from the document — otherwise phase B is vacuous',
    ).toHaveCount(0, { timeout: 20_000 });

    // ── B. THE CLAIM. Before the fix this reads `after === before` forever.
    const expectedB = ccToParam(127, pd.min, pd.max);
    const b = await injectAndWatch(page, { ...SUBJECT, value: 127 });
    expect(
      b.mountedControls,
      `phase B must run with ZERO of the module's controls mounted. ${fmt('B · card gone', b, expectedB)}`,
    ).toBe(0);
    expect(
      b.after!,
      '#1727: a CC bound to an un-migrated module must keep driving its param when no card is ' +
        'mounted — the binding\'s delivery is a property of the GRAPH, not of a view.\n  ' +
        fmt('B · card gone', b, expectedB),
    ).toBeCloseTo(expectedB, 2);

    // ── C. PERMANENT NEGATIVE CONTROL, the other direction: re-mount the card
    //      and deliver again. If B ever fails while C passes, the injector was
    //      alive and B is a real delivery failure; if BOTH fail, the instrument
    //      is what broke. The two readings are what tell those apart.
    await openFullView(page, SUBJECT.nodeId);
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 30_000 });
    const expectedC = ccToParam(32, pd.min, pd.max);
    const c = await injectAndWatch(page, { ...SUBJECT, value: 32 });
    expect(c.mountedControls, fmt('C · card re-mounted', c, expectedC)).toBeGreaterThan(0);
    expect(
      c.after!,
      'the simulated MIDI device must still be delivering after the collapse — this is what ' +
        'stops a frozen phase-B reading being blamed on a dead injector.\n  ' +
        fmt('C · card re-mounted', c, expectedC),
    ).toBeCloseTo(expectedC, 2);
  });

  test('…and after LRU EVICTION, where nothing is done to the bound module at all', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const mod = REGISTRY.find((m) => m.type === SUBJECT.type)!;
    const pd = mod.params.find((p) => p.id === SUBJECT.paramId)!;

    await boot(page);
    await spawnPatch(
      page,
      [
        { id: SUBJECT.nodeId, type: SUBJECT.type, domain: 'audio', params: { [SUBJECT.paramId]: 0 } },
        ...CROWD.map((id, i) => ({
          id,
          type: SUBJECT.type,
          domain: 'audio' as const,
          position: { x: 300 + i * 200, y: 100 },
          params: { [SUBJECT.paramId]: 0 },
        })),
      ],
      [],
      { mountTimeout: 30_000 },
    );

    await installSimMidi(page);
    await openFullView(page, SUBJECT.nodeId);
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 30_000 });
    await armLearn(page);
    const expectedA = ccToParam(100, pd.min, pd.max);
    const a = await injectAndWatch(page, { ...SUBJECT, value: 100 });
    expect(a.after!, fmt('A · card mounted', a, expectedA)).toBeCloseTo(expectedA, 2);

    // THE SILENT TRIGGER: expand two OTHER modules. The dock holds at most
    // MAX_FULLVIEW_PANES, so the subject's pane is evicted from the FRONT —
    // with no user action against the subject whatsoever.
    for (const id of CROWD) {
      await openFullView(page, id);
    }
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(CROWD.length, { timeout: 30_000 });
    await expect(
      page.locator(`[data-testid="dock-full-view"][data-fullview-node="${SUBJECT.nodeId}"]`),
      'the subject\'s pane must have been evicted by the two later expands',
    ).toHaveCount(0, { timeout: 20_000 });

    const expectedB = ccToParam(20, pd.min, pd.max);
    const b = await injectAndWatch(page, { ...SUBJECT, value: 20 });
    expect(
      b.mountedControls,
      `the SUBJECT's own controls must be gone (the two crowd modules keep theirs — this count ` +
        `is node-scoped precisely so they cannot mask it). ${fmt('B · evicted by LRU', b, expectedB)}`,
    ).toBe(0);
    expect(
      b.after!,
      '#1727 (LRU): the bound module was never touched — a third expand evicted its pane — and ' +
        'its CC must still land.\n  ' + fmt('B · evicted by LRU', b, expectedB),
    ).toBeCloseTo(expectedB, 2);
  });
});
