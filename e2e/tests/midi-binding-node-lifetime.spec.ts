// e2e/tests/midi-binding-node-lifetime.spec.ts
//
// #1727 — "a MIDI CC bound to a module with no control on screen is silently
// INERT." THE REPRODUCTION, and then the regression guard.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
// A binding lives in a PERSISTED map keyed by (nodeId, paramId). Its SETTER did
// not: every control registered one `onMount` and dropped it `onDestroy`, and
// dispatch fired only where the two intersected. A module with no mounted param
// control therefore kept a binding that survived, showed as assigned, exported,
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
//   A. face MOUNTED   → CC moves the param   (positive control: probe + inject work)
//   B. face GONE      → CC moves the param   (THE CLAIM — red before the fix)
//   C. face RE-MOUNTED→ CC moves the param   (permanent negative control the other
//                                             way: the injector is still alive, so a
//                                             frozen reading in B cannot be "the
//                                             simulated device died")
//
// Phase B additionally asserts the module's controls are mounted ZERO times, so
// it cannot pass by the face having quietly stayed alive.
//
// ⚠ AND "ZERO" IS THE ASSERTION SHAPE THIS REPO GETS WRONG, so phase B never
// takes it alone. Zero controls is TRIVIALLY true of a page that has not
// loaded, of a mis-typed selector, and of a node that was never spawned — the
// three ways this file could go quietly vacuous. So the zero is always read
// beside a WITNESS: a second node of the SAME TYPE, on the canvas, whose
// identical `[role="slider"][aria-label]` count must be NON-ZERO in the same
// evaluate, at the same instant, through the same selector. The pair is the
// assertion — "the subject has none AND the witness has some" can only hold if
// the probe is looking and the app is up. Ordering carries the rest: the
// subject MOUNTS ITS CONTROLS FIRST (asserted), and only then is it taken off
// the canvas, so its absence is a state this test drove the page into rather
// than a state it found.
//
// ── FRAMES, NEVER MILLISECONDS ───────────────────────────────────────────────
// Every wait is an in-page rAF frame count that EXITS ON THE EVENT (the param
// changed); the frame cap only bounds a failure. The accumulator lives in the
// page — one evaluate per phase, never one round-trip per sample.
//
// ── HOW A NODE REACHES "NO CONTROL MOUNTED ANYWHERE" ─────────────────────────
// ⚠ THE ROUTE HAS CHANGED THREE TIMES AND THE SUBJECT IS NOT THE POINT — the
// STATE is. What this spec needs is a node that exists, is wired, holds a
// binding, and has no param control in the document. How it got there is an
// implementation detail of the shell, and every time the shell changed, this
// file paid:
//
//   1. name a module with no face          → `wavecel` → `depolarizer` →
//      `moog956`, two re-points in ONE DAY as each got promoted. #2068 filed
//      the CHURN as the defect: the owner ruled everything migrates, so in the
//      limit no such module exists.
//   2. REQUEST the control-less render     → the forced-placeholder seam
//      (`__forceUnmigrated`), which made a promoted type render the uniform
//      placeholder tile. That tile is deleted; nothing emits it, and the seam
//      it was reached through is deleted with it.
//   3. take the node OFF THE CANVAS        → what this file does now, and the
//      first route that is not a bet on the render layer at all.
//
// A node carrying `data.pinned` is CANVAS-HIDDEN: `Canvas`'s flowNodes
// derivation skips it (`isCanvasHiddenNode`, $lib/graph/hidden-card), so it
// mounts NO lane tile and therefore no lane control — while staying a fully
// real node in the patch, with its ports, its params, its engine instance and
// its cables. That is the state #1727 is about, reached through the graph
// rather than through a render branch.
//
// ⚠ AND IT IS A SHIPPING PRODUCT STATE, NOT A FIXTURE. The built-in clip
// player is exactly this shape — `pinned-clipplayer` is canvas-hidden and its
// only surface is the dock pane the `c` key opens (WORKFLOW_PINNED_MODULES,
// $lib/graph/workflow-pins) — so "canvas-hidden node, opened as a dock full
// view" is a path the app takes on its own, with real users' bindings on it.
// The audio-I/O and MIDI-DIN singletons are the same shape with no drawer at
// all. This is the LEAST synthetic of the three routes, which is why a fourth
// re-point is not expected: it does not depend on any module lacking a face,
// on any dev-only seam, or on any branch of the lane switch.
//
// ⚠ A REGISTERED "never faced" FIXTURE MODULE IS STILL NOT THE ANSWER, and the
// reason outlived the seam: a def auto-enrols in every registry-driven sweep
// (VRT, the per-module I/O sweeps, the docs catalog), i.e. it is exactly the
// durable un-faced fixture subject the owner ruling forbids. `data.pinned` is a
// per-NODE flag on an ordinary module: no def, no ports of its own, no row
// anywhere.
//
// ── WHAT A GREEN RUN HERE STRUCTURALLY CANNOT SEE ────────────────────────────
//   * ONE module. This is a runtime proof on one representative module; the
//     claim that EVERY declared param of EVERY registered module is
//     graph-resolvable is the registry-wide, both-directions assertion in
//     `$lib/midi/graph-param-dispatch.test.ts`. Neither leg substitutes for the
//     other — this one proves the wiring, that one proves the coverage.
//   * NOTE bindings. Gate INPUT PORTS are covered by the same fallback and by
//     <PatchPanel> mounting on the lane tile; a NOTE bound to a face BUTTON
//     (a synthetic action id) is NOT covered anywhere — see the header of
//     `$lib/midi/graph-param-dispatch.ts`.
//   * The RANGE a mounted control uses. Phase A and phase B agreeing here says
//     the subject's Knob and the subject's def agree. That is now true BY
//     CONSTRUCTION rather than by inspection: the faceplate ranks controls
//     straight off the def (`paramSpec(def, id)`), so there is no second
//     hand-typed copy of the bounds left to diverge from. The caveat this slot
//     used to carry was written for a per-module card that re-typed its
//     `min`/`max` as literals; no such file exists any more.

// `_fixtures` (not bare @playwright/test) for `errorWatch`: this spec expands,
// collapses and LRU-evicts real cards, which is exactly the flow a lifetime bug
// announces itself in as a console error.
import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { REGISTRY } from './_registry';

/** The subject: an ordinary audio module, taken OFF THE CANVAS mid-test so no
 *  control of its remains mounted (see "HOW A NODE REACHES…" in the header).
 *
 *  ⚠ RE-POINTED TWICE IN ONE DAY (2026-08-20): `wavecel` → `depolarizer` →
 *  `moog956`, each time because the named module got a face. #2068 filed the
 *  CHURN as the defect, because a further re-point does not fix it. The pick
 *  returns to `depolarizer` — the module the churn ran over — and the reason it
 *  can now stay put is that NOTHING about it has to remain un-faced.
 *
 *  ⚠ WHAT THE PICK NEEDS, and it is a short list: an audio module that needs no
 *  hardware or network, is not a `NON_SHELL_LANE_TYPES` snowflake (those keep
 *  their own roaming surface and are not lane tiles at all), and whose faceplate
 *  ranks the bound param as a `<Knob>` (which sets `aria-label={label}`) so the
 *  learn gesture and the mounted-control count have something to find.
 *  `depolarizer` is one knob, one CV in, one CV out.
 *
 *  ⚠ "THE FACE RANKS `depth`" IS NOT ASSUMED — phase A asserts a non-zero
 *  mounted-control count before anything is taken away, so a face that stopped
 *  ranking this param fails loudly there instead of making phase B vacuously
 *  true. That assertion replaces the STRICT_FACES precondition this file used to
 *  carry, which asked a question (is it promoted?) that now has the same answer
 *  for every module and so could no longer fail.
 *
 *  ⚠ THE "[0,1] param" REQUIREMENT AN EARLIER VERSION STATED IS NOT REAL.
 *  `ccToParam` maps CC 0..127 across the param's OWN declared `[min,max]`, read
 *  off the registry manifest at test time — so any range works and the
 *  expectation is derived, never hard-coded. (`depth` happens to be 0..1.) */
const SUBJECT = {
  nodeId: 'mb-rb',
  type: 'depolarizer',
  paramId: 'depth',
  /** The Knob's aria-label — how the mounted-control count is taken. `<Knob>`
   *  sets `aria-label={label}`, and the ranked `depth` cell labels it DEPTH. */
  ariaLabel: 'DEPTH',
  channel: 0,
  cc: 21,
} as const;

/** THE WITNESS — a second node of the SAME TYPE that stays on the canvas.
 *
 *  ⚠ IT IS THE ONLY THING STANDING BETWEEN "the subject's controls are gone"
 *  AND A VACUOUS PASS. Every way this file could break quietly — the page not
 *  loaded, the aria-label renamed, the selector mistyped, `spawnPatch` silently
 *  adding nothing — produces ZERO controls for the subject and would read as
 *  the claim holding. The witness is counted through the SAME selector in the
 *  SAME evaluate, and must be NON-ZERO whenever the subject is zero. One
 *  reading cannot distinguish an absence from a blind probe; the pair can. */
const WITNESS = { nodeId: 'mb-witness', type: SUBJECT.type } as const;

/** Two more nodes used only as LRU pressure (opening a third full-view evicts
 *  the least-recently-opened pane — MAX_FULLVIEW_PANES). They are canvas nodes
 *  of the subject's type, so in that leg they are ALSO the witness. */
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
  /** How many of THIS NODE's own controls are mounted in the document RIGHT
   *  NOW — 0 means no surface of it is on screen anywhere. */
  mountedControls: number;
  /** The same count, through the SAME selector, for the WITNESS node — the
   *  control that turns `mountedControls === 0` into a measurement instead of
   *  a shrug. See the WITNESS declaration. */
  witnessControls: number;
}

/**
 * ONE evaluate: read the param, inject a CC, then rAF-sample the param IN THE
 * PAGE until it changes (capped in FRAMES). Returns everything an assertion
 * message needs to distinguish "did not land" from "never looked".
 */
async function injectAndWatch(
  page: Page,
  args: {
    nodeId: string;
    paramId: string;
    ariaLabel: string;
    channel: number;
    cc: number;
    value: number;
    /** Node ids whose controls must be PRESENT while the subject's are absent
     *  (the vacuity witness). Counted through the identical selector. */
    witnessNodeIds: readonly string[];
  },
): Promise<Watch> {
  return page.evaluate(
    async ({ nodeId, paramId, ariaLabel, channel, cc, value, cap, witnessNodeIds }) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { params?: Record<string, number> }> };
        __midiTestInject?: (c: number, cc: number, v: number) => boolean;
      };
      const read = (): number | null => {
        const v = w.__patch?.nodes?.[nodeId]?.params?.[paramId];
        return typeof v === 'number' ? v : null;
      };
      // NODE-SCOPED, not document-wide: this file always has more than one node
      // of the subject's type on screen (the witness, and three in the LRU leg),
      // and a document-wide count would read the OTHER modules' knobs as if the
      // subject's own surface were alive. Scoped to every place a node's
      // controls can mount — its dock pane, its lane tile, and the headless
      // source host.
      //
      // ⚠ ONE FUNCTION, USED FOR BOTH READINGS. The witness count MUST go
      // through the identical selector or it proves nothing: a witness measured
      // a different way could stay non-zero while a typo made the subject's
      // reading permanently zero, which is the exact failure it is here to rule
      // out.
      const controlsFor = (id: string) => {
        const scopes = document.querySelectorAll(
          `[data-fullview-node="${id}"], .svelte-flow__node[data-id="${id}"], [data-node-id="${id}"]`,
        );
        let n = 0;
        for (const s of Array.from(scopes)) {
          n += s.querySelectorAll(`[role="slider"][aria-label="${ariaLabel}"]`).length;
        }
        return n;
      };
      const controls = () => controlsFor(nodeId);
      const witnesses = () =>
        witnessNodeIds.reduce((sum: number, id: string) => sum + controlsFor(id), 0);
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
        witnessControls: witnesses(),
      };
    },
    { ...args, cap: MOVE_CAP_FRAMES },
  );
}

function fmt(phase: string, w: Watch, expected: number): string {
  return (
    `[${phase}] injected=${w.injected} · binding=${w.storedBinding} · ` +
    `mounted "${SUBJECT.ariaLabel}" controls=${w.mountedControls} ` +
    `(witness nodes: ${w.witnessControls} — same selector, same instant) · ` +
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
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));
}

/**
 * Take a node OFF THE CANVAS — the product's own canvas-hidden state, set the
 * way the app sets it: `data.pinned` on the node, inside one Y transaction.
 *
 * `Canvas`'s flowNodes derivation skips a canvas-hidden node
 * (`isCanvasHiddenNode`), so its lane tile unmounts and with it every control
 * the lane was mounting. Nothing else about the node changes: it keeps its
 * params, its ports, its cables and its engine instance, which is exactly the
 * state #1727 is about.
 *
 * Returned as an ASSERTION, not a fire-and-forget: the caller waits on the lane
 * tile actually going away, so "no controls" is never read off a page that
 * simply had not re-rendered yet.
 */
async function hideFromCanvas(page: Page, nodeId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n) throw new Error(`hideFromCanvas: no node ${id} in the patch`);
      if (!n.data) n.data = {};
      n.data.pinned = true;
    });
  }, nodeId);
  await expect(
    page.locator(`.svelte-flow__node[data-id="${nodeId}"]`),
    `${nodeId} must leave the canvas once it is pinned — Canvas's flowNodes derivation skips a ` +
      'canvas-hidden node (isCanvasHiddenNode). A tile still here means the node is still ' +
      'mounting controls and every "zero controls" assertion after this point would be false.',
  ).toHaveCount(0, { timeout: 20_000 });
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
    // The subject must declare the param this spec binds — the one precondition
    // that is a FACT about the registry rather than about the render layer.
    //
    // ⚠ THE STRICT_FACES PRECONDITION THAT STOOD HERE IS DELETED, AND ITS JOB
    // MOVED RATHER THAN VANISHED. It asserted the subject was promoted, which
    // was what kept the forced-placeholder seam honest: against an un-promoted
    // subject the old spec passed whether or not the seam did anything. With
    // every module faced, that question has one answer for every type and a
    // gate that cannot fail is not a gate. What it was really protecting —
    // "this module actually mounts a control for this param" — is now asserted
    // where it can still be false, on the live DOM in phase A.
    const mod = REGISTRY.find((m) => m.type === SUBJECT.type);
    expect(mod, `${SUBJECT.type} is missing from the registry manifest`).toBeTruthy();
    expect(
      mod!.params.map((p) => p.id),
      `${SUBJECT.type} must declare ${SUBJECT.paramId}`,
    ).toContain(SUBJECT.paramId);
  });

  test('a learned CC keeps driving the param after the face that learned it is COLLAPSED', async ({ page, errorWatch }) => {
    test.setTimeout(120_000);
    const mod = REGISTRY.find((m) => m.type === SUBJECT.type)!;
    const pd = mod.params.find((p) => p.id === SUBJECT.paramId)!;

    await boot(page);
    await spawnPatch(
      page,
      [
        { id: SUBJECT.nodeId, type: SUBJECT.type, domain: 'audio', params: { [SUBJECT.paramId]: 0 } },
        {
          id: WITNESS.nodeId,
          type: WITNESS.type,
          domain: 'audio',
          position: { x: 520, y: 120 },
          params: { [SUBJECT.paramId]: 0 },
        },
      ],
      [],
      { mountTimeout: 30_000 },
    );

    // ── THE SUBJECT MOUNTS ITS CONTROLS FIRST, AND THAT ORDER IS THE POINT ────
    // Both nodes land on the canvas as ordinary lane tiles, and the subject's
    // DEPTH knob is asserted PRESENT here — before anything is taken away. So
    // the zero this test later asserts is a state it drove the page into, never
    // a page that had not finished loading. Without this line, every "the
    // controls are gone" assertion below would also pass against a rack that
    // never spawned the node at all.
    const subjectLaneControl = page.locator(
      `.svelte-flow__node[data-id="${SUBJECT.nodeId}"] [role="slider"][aria-label="${SUBJECT.ariaLabel}"]`,
    );
    await expect(
      subjectLaneControl,
      `${SUBJECT.type}'s faceplate must rank ${SUBJECT.paramId} as a labelled control for this ` +
        'spec to have anything to bind or to count. If this is the line that failed, the face ' +
        'stopped ranking the param — re-point SUBJECT at a module whose face still does.',
    ).not.toHaveCount(0, { timeout: 20_000 });

    // ── ACT ONE: take the subject OFF THE CANVAS. Its lane tile — and the only
    //      controls it had mounted — go with it; the node, its params and its
    //      engine instance stay. This is the state #1727 lives in.
    await hideFromCanvas(page, SUBJECT.nodeId);

    // …and the WITNESS is still here, counted through the SAME selector. This
    // pair is what makes "the subject has zero controls" a measurement.
    await expect(
      page.locator(
        `.svelte-flow__node[data-id="${WITNESS.nodeId}"] [role="slider"][aria-label="${SUBJECT.ariaLabel}"]`,
      ),
      'the witness must still be mounting its controls — if BOTH nodes read zero, this spec is ' +
        'measuring a blank page rather than a hidden node, and every assertion below is vacuous',
    ).not.toHaveCount(0, { timeout: 20_000 });

    // ── ARRANGE: the only way a user can learn a CC here is the dock full-view.
    await installSimMidi(page);
    await openFullView(page, SUBJECT.nodeId);
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 30_000 });
    await armLearn(page);

    // ── A. POSITIVE CONTROL (permanent): the face IS mounted. The learn capture
    //      itself applies the value, so this proves the probe, the inject hook
    //      and the scaling all work before anything is taken away.
    const witnessNodeIds = [WITNESS.nodeId];
    const expectedA = ccToParam(64, pd.min, pd.max);
    const a = await injectAndWatch(page, { ...SUBJECT, witnessNodeIds, value: 64 });
    expect(a.moved, `phase A must deliver while the face is mounted. ${fmt('A · face mounted', a, expectedA)}`).toBe(true);
    expect(a.after!, fmt('A · face mounted', a, expectedA)).toBeCloseTo(expectedA, 2);
    expect(a.mountedControls, fmt('A · face mounted', a, expectedA)).toBeGreaterThan(0);
    // The binding EXISTS — the precondition for phases B and C, asserted on the
    // control's own bound-state class rather than inferred from the value move.
    await expect(knobWrap(page), 'the learn must have produced a binding').toHaveClass(/midi-bound/);

    // ── ACT TWO: collapse the full-view. With the node already off the canvas,
    //      this pane was its LAST surface — so now the module has no control
    //      mounted anywhere in the document. The binding does not care.
    await page.getByTestId('faceplate-collapse').first().click();
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(0, { timeout: 20_000 });

    // ── B. THE CLAIM. Before the fix this reads `after === before` forever.
    const expectedB = ccToParam(127, pd.min, pd.max);
    const b = await injectAndWatch(page, { ...SUBJECT, witnessNodeIds, value: 127 });
    expect(
      b.mountedControls,
      `phase B must run with ZERO of the subject's controls mounted. ${fmt('B · face gone', b, expectedB)}`,
    ).toBe(0);
    // ⚠ THE ZERO ABOVE IS ONLY MEANINGFUL BESIDE THIS. Read in the same
    // evaluate, through the same selector, at the same instant: the witness
    // still has its controls. A blind probe, a renamed aria-label or a page
    // that never loaded would zero BOTH — and that is the reading this catches.
    expect(
      b.witnessControls,
      'the witness node must still be mounting controls while the subject has none, or the ' +
        `zero above is a blind probe rather than an absence. ${fmt('B · face gone', b, expectedB)}`,
    ).toBeGreaterThan(0);
    expect(
      b.after!,
      '#1727: a CC bound to a module with no control on screen must keep driving its param — ' +
        'the binding\'s delivery is a property of the GRAPH, not of a view.\n  ' +
        fmt('B · face gone', b, expectedB),
    ).toBeCloseTo(expectedB, 2);

    // ── C. PERMANENT NEGATIVE CONTROL, the other direction: re-mount the face
    //      and deliver again. If B ever fails while C passes, the injector was
    //      alive and B is a real delivery failure; if BOTH fail, the instrument
    //      is what broke. The two readings are what tell those apart.
    await openFullView(page, SUBJECT.nodeId);
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 30_000 });
    const expectedC = ccToParam(32, pd.min, pd.max);
    const c = await injectAndWatch(page, { ...SUBJECT, witnessNodeIds, value: 32 });
    expect(c.mountedControls, fmt('C · face re-mounted', c, expectedC)).toBeGreaterThan(0);
    expect(
      c.after!,
      'the simulated MIDI device must still be delivering after the collapse — this is what ' +
        'stops a frozen phase-B reading being blamed on a dead injector.\n  ' +
        fmt('C · face re-mounted', c, expectedC),
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

    // Same order as the sibling test, and for the same reason: the subject
    // mounts its controls on the canvas FIRST, and is only then taken off it,
    // so the later zero is a state this test produced.
    await expect(
      page.locator(
        `.svelte-flow__node[data-id="${SUBJECT.nodeId}"] [role="slider"][aria-label="${SUBJECT.ariaLabel}"]`,
      ),
      `${SUBJECT.type}'s faceplate must rank ${SUBJECT.paramId} as a labelled control`,
    ).not.toHaveCount(0, { timeout: 20_000 });
    await hideFromCanvas(page, SUBJECT.nodeId);

    await installSimMidi(page);
    await openFullView(page, SUBJECT.nodeId);
    await expect(page.locator('[data-testid="dock-full-view"]')).toHaveCount(1, { timeout: 30_000 });
    await armLearn(page);
    // THE CROWD ARE THE WITNESSES HERE — two canvas nodes of the subject's own
    // type, which is what this leg needed anyway for the eviction.
    const witnessNodeIds = [...CROWD];
    const expectedA = ccToParam(100, pd.min, pd.max);
    const a = await injectAndWatch(page, { ...SUBJECT, witnessNodeIds, value: 100 });
    expect(a.after!, fmt('A · face mounted', a, expectedA)).toBeCloseTo(expectedA, 2);

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
    const b = await injectAndWatch(page, { ...SUBJECT, witnessNodeIds, value: 20 });
    expect(
      b.mountedControls,
      `the SUBJECT's own controls must be gone (the two crowd modules keep theirs — this count ` +
        `is node-scoped precisely so they cannot mask it). ${fmt('B · evicted by LRU', b, expectedB)}`,
    ).toBe(0);
    expect(
      b.witnessControls,
      'and the crowd modules must still have theirs, read through the same selector in the same ' +
        `evaluate — otherwise the zero above is a blind probe. ${fmt('B · evicted by LRU', b, expectedB)}`,
    ).toBeGreaterThan(0);
    expect(
      b.after!,
      '#1727 (LRU): the bound module was never touched — a third expand evicted its pane — and ' +
        'its CC must still land.\n  ' + fmt('B · evicted by LRU', b, expectedB),
    ).toBeCloseTo(expectedB, 2);
  });
});
