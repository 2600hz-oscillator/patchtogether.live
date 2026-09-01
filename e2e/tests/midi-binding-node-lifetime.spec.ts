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
// ⚠ THE SUBJECT IS NOW A **PROMOTED** MODULE, AND THAT INVERSION IS THE FIX FOR
// #2068. What this spec needs is the un-migrated RENDER PATH — a lane tile that
// mounts no param control — not any particular module. It used to get there by
// naming a module that happened still to be on that path, which is a standing
// bet against the face programme: `wavecel` → `depolarizer` → `moog956`, two
// re-points in one day, and `moog956` was the last candidate in the registry.
// The owner has ruled that EVERYTHING migrates, so in the limit no such module
// exists and no fourth re-point is available.
//
// So the placeholder path is REQUESTED instead, through the forced-placeholder
// test seam ($lib/dev/forced-placeholder.svelte.ts, installed only under DEV /
// VITE_E2E_HOOKS): `__forceUnmigrated([type])` makes Canvas's ONE promotion
// read (`laneMigrated`) answer "un-migrated" for that type on every surface it
// injects the answer into — the lane tile, the dock full view, the rail tray.
//
// ⚠ AND THE SUBJECT IS DELIBERATELY ONE THAT **IS** PROMOTED, which is what
// keeps the seam non-vacuous. `depolarizer` — this spec's own second subject,
// promoted out from under it on 2026-08-20 — is in STRICT_FACES today, asserted
// in `beforeAll`. If the seam ever stops working, the default shell renders its
// real <ModuleShell> face and the placeholder assertion below reds immediately;
// there is no arrangement in which this spec passes while the seam does nothing.
// A subject that was merely un-promoted would pass either way.
//
// ⚠ A REGISTERED "never promoted" FIXTURE MODULE WOULD NOT HAVE WORKED. #2068
// says so and the reason is structural: a def auto-enrols in every
// registry-driven sweep (VRT, the per-module I/O sweeps, the docs catalog, the
// face-migration inventory's own remaining-count), i.e. it is exactly the
// durable un-migrated fixture subject the owner ruling forbids. A render seam
// has no def, no ports, no card and no inventory row.
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
//     different range would diverge, and no runtime gate sees that. ⚠ THE
//     CAVEAT IS GENERAL AND NO LONGER APPLIES TO THIS SUBJECT. It was written
//     for `moog956`, whose card re-typed `scale`'s `min: 0, max: 5,
//     defaultValue: 2` as literals rather than importing them, so the two
//     agreed by inspection and nothing gated it (`moog956` is not in
//     `RANGE_BOUND_CARDS`) — the backdraft shape sitting one edit away.
//     `DepolarizerCard` reads `def('depth').min/max/defaultValue` off
//     `depolarizerDef`, so for THIS subject card and def cannot diverge. The
//     hole is still real for any future re-point onto a literal-typing card.

// `_fixtures` (not bare @playwright/test) for `errorWatch`: this spec expands,
// collapses and LRU-evicts real cards, which is exactly the flow a lifetime bug
// announces itself in as a console error.
import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { REGISTRY } from './_registry';

/**
 * The PROMOTED set, read off the MANIFEST's own `strictFace` projection.
 *
 * ⚠ IT USED TO REGEX THE `strict-faces.ts` SOURCE, AND THAT PARSER WAS BROKEN —
 * measured 2026-09-01, not suspected. The member list is `export const
 * STRICT_FACES … [ … ]` with a per-module rationale comment above almost every
 * entry, and the extractor was `/'([^']+)'/g` over the block: `[^']+` crosses
 * newlines, so every APOSTROPHE in that prose ("the card's", "it's") opened a
 * match that ran to the next one and swallowed the real entries in between. It
 * reported 563 "types", most of them paragraphs, and — the part that matters —
 * `depolarizer` and `moog956` came back FALSE while `vca` came back true. Which
 * entries survive depends on where the apostrophes happen to fall.
 *
 * ⚠ SO THE OLD `beforeAll` GUARD COULD SILENTLY FAIL TO FIRE. Its whole job was
 * "red if this spec's subject has been promoted", and a false negative for the
 * subject is exactly the case it cannot afford: the spec would have gone on
 * asserting a placeholder against a faced module. The two re-points it did catch
 * were luck of the apostrophes, not the anchor doing its job. (The `export const`
 * anchor in the note this replaces was real and is not the part that broke.)
 *
 * `strictFace` on the registry manifest is STRICT_FACES membership emitted by
 * the generator for exactly this question — the same field
 * `workflow-shell.spec.ts` selects placeholder subjects on — so it cannot drift
 * from the set it describes, and no parser sits between them.
 */
const PROMOTED = new Set(REGISTRY.filter((m) => m.strictFace === true).map((m) => m.type));

/** The subject: a PROMOTED audio module, driven onto the un-migrated render
 *  path by the forced-placeholder seam (see the SUBJECTS section of the header).
 *  Its promotion is ASSERTED in `beforeAll`, not assumed — that assertion is
 *  what makes the seam load-bearing rather than decorative.
 *
 *  ⚠ RE-POINTED TWICE IN ONE DAY (2026-08-20) BEFORE THE SEAM EXISTED:
 *  `wavecel` → `depolarizer` → `moog956`. Both times the old `beforeAll`
 *  precondition fired exactly as designed — *"Re-point this spec at a module
 *  that is still un-migrated"* — and the guard working is the only reason this
 *  spec did not silently go vacuous against a `<ModuleShell>`. #2068 filed the
 *  CHURN as the defect, because a third re-point does not fix it. This is that
 *  fix, and the pick returns to `depolarizer`: the module the churn ran over.
 *
 *  ⚠ WHAT THE PICK NOW NEEDS, and it is a shorter list than the old one. Not
 *  "still un-migrated" — the seam supplies that. Only: an audio module that
 *  resolves a legacy card (`laneRenderKind` returns 'legacy', not
 *  'placeholder', for a type with no card), is not a `NON_SHELL_LANE_TYPES`
 *  snowflake (same reason), needs no hardware or network, and renders the bound
 *  param as a `<Knob>` (which sets `aria-label={label}`) so the learn gesture
 *  and the mounted-control count have something to find. `DepolarizerCard` is
 *  90 lines, one knob, one CV in / one CV out.
 *
 *  ⚠ AND IT CLOSES THE RANGE HOLE THE PREVIOUS SUBJECT LEFT OPEN. `moog956`'s
 *  card RE-TYPED its `scale` bounds as literals (`min={0} max={5}`) rather than
 *  importing them, so card and def agreed only by inspection and nothing gated
 *  it — the caveat in "WHAT A GREEN RUN CANNOT SEE" below existed for that.
 *  `DepolarizerCard` reads `def('depth').min/max` off `depolarizerDef` itself,
 *  so the two CANNOT diverge and the caveat no longer applies to this subject.
 *
 *  ⚠ THE "[0,1] param" REQUIREMENT AN EARLIER VERSION STATED IS NOT REAL.
 *  `ccToParam` maps CC 0..127 across the param's OWN declared `[min,max]`, read
 *  off the registry manifest at test time — so any range works and the
 *  expectation is derived, never hard-coded. (`depth` happens to be 0..1.) */
const SUBJECT = {
  nodeId: 'mb-rb',
  type: 'depolarizer',
  paramId: 'depth',
  /** The Knob's aria-label on the legacy card — how the mounted-control count
   *  is taken. `<Knob>` sets `aria-label={label}`, and DepolarizerCard passes
   *  `label="DEPTH"`. */
  ariaLabel: 'DEPTH',
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
  // ── ASK FOR THE UN-MIGRATED RENDER PATH (#2068) ────────────────────────────
  // Seeded BEFORE navigation, so the very first paint of the rack already has
  // the subject on the placeholder path and nothing has to re-render into it.
  // `installForcedPlaceholderHook` drains this pending list when Canvas mounts.
  await page.addInitScript((type: string) => {
    (globalThis as unknown as { __forceUnmigratedPending: string[] }).__forceUnmigratedPending = [
      type,
    ];
  }, SUBJECT.type);

  // Plain `/rack` — the DEFAULT faceplate shell. Under `?shell=legacy` the real
  // card renders in the lane and this defect is invisible, which is exactly how
  // the existing midi-learn.spec.ts (on the `rack` fixture) stayed green
  // through it.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });

  // THE SEAM TOOK, asserted rather than assumed — and it is asserted HERE, at
  // the hook, so a build without VITE_E2E_HOOKS fails naming the missing hook
  // instead of timing out later on a placeholder that was never going to exist.
  // Re-applying is idempotent; it also covers a boot ordering in which the
  // pending list was drained before this navigation's Canvas mounted.
  const forced = await page.evaluate((type: string) => {
    const w = globalThis as unknown as { __forceUnmigrated?: (t: string[]) => string[] };
    if (typeof w.__forceUnmigrated !== 'function') return null;
    return w.__forceUnmigrated([type]);
  }, SUBJECT.type);
  expect(
    forced,
    '__forceUnmigrated hook not present — a DEV/VITE_E2E_HOOKS build is expected (the same gate ' +
      'as __patch / __ydoc / __midiTestInject)',
  ).not.toBeNull();
  expect(forced, `the forced-placeholder seam must hold ${SUBJECT.type}`).toEqual([SUBJECT.type]);

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
    // ⚠ THE PRECONDITION IS INVERTED, AND THE INVERSION IS THE CONTROL (#2068).
    // It used to read "the subject must be UN-MIGRATED". It now reads "the
    // subject must be PROMOTED", because the placeholder path is REQUESTED by
    // the forced-placeholder seam rather than borrowed from a module that has
    // not been faced yet. Asserting promotion is what stops the seam being
    // decorative: against an un-promoted subject this spec would pass whether
    // or not `__forceUnmigrated` did anything, and the day the last un-promoted
    // module went it would have failed for a reason with no relation to #1727.
    // With a promoted subject the placeholder assertion in each test can only
    // hold if the seam is working.
    expect(
      PROMOTED.has(SUBJECT.type),
      `${SUBJECT.type} is NOT in STRICT_FACES, so the default shell would render it as a ` +
        'placeholder anyway and the forced-placeholder seam this spec is built on would be ' +
        'unproven — a green run would say nothing about it. Point SUBJECT at a PROMOTED audio ' +
        'module that resolves a legacy card and renders its bound param as a <Knob>.',
    ).toBe(true);
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
    //
    // ⚠ IT IS ALSO THE SEAM'S OWN CONTROL. `SUBJECT.type` IS promoted (asserted
    // in `beforeAll`), so on the default shell it renders `module-shell`, not
    // this. Reaching a placeholder at all is proof that `__forceUnmigrated`
    // moved Canvas's promotion read; if the seam regresses, this is the line
    // that reds, and it reds before anything about MIDI is exercised.
    await expect(
      page.locator(`.svelte-flow__node[data-id="${SUBJECT.nodeId}"] [data-testid="module-shell-placeholder"]`),
      `${SUBJECT.type} must render the UN-MIGRATED placeholder tile — it is PROMOTED, so this ` +
        'can only be true if the forced-placeholder seam (__forceUnmigrated → Canvas.laneMigrated) ' +
        'is working. A `module-shell` here means the seam stopped moving the lane.',
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
