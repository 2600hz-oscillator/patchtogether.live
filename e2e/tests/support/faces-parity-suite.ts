// e2e/tests/faces-parity.spec.ts
//
// FACES RENDER-PARITY — the authoritative DOM gate for the workflow-mode
// UI-curation system: A REDESIGN MUST NEVER LOSE A CONTROL, and EVERY
// RENDERED CELL MUST BE A REAL, OPERABLE CONTROL.
//
// Born from the tidyVco tune/fine loss (the face ranked `detune`/`oct2` below
// the lane fit-plan's whole-cell cap, so the redesigned face surfaced ZERO
// tuning controls in-lane and the schema-level face-lint gate never noticed —
// schema coverage ≠ rendered coverage), then WIDENED by the P1 batch-2
// adversarial render verify, which found the complementary hole: the shell
// rendered every family/static cell as a DASHED LABEL and every param as a
// rotary, so
//   * dx7's PRESET selector (its hero, `face.order[0]`) and its .syx import
//     were DEAD TEXT — the DX7's voice could not be changed at all, and
//   * tomtom's MOMENTARY strike pad rendered as a LATCHING knob that masked
//     the TRIG jack and persisted a stuck value into the Y.Doc,
// while this spec only ever counted family cells and drove ONE spec-chosen
// param. Presence is not function, and a per-module operability probe cannot
// see a per-cell failure.
//
// REGISTRY-DRIVEN: enumerates STRICT_FACES (imported straight from the web
// source — the same set the lint gate and the migration bridge read), so
// every FUTURE promoted face auto-enrolls in this sweep with zero test
// edits. For each migrated module, the dock full-view (`?shell=1` →
// EXPAND) must satisfy:
//
//   1. EXACTLY one interactive control per def PARAM id — matched by the
//      card-kit's `control-<paramId>` testid binding, asserted as full
//      id-multiset equality against the LIVE def (window.__moduleSpecs):
//      a dropped control fails, a duplicated control fails, and an extra
//      control with no def backing fails.
//   2. one family cell per DECLARED control family, ZERO dead 'static'
//      cells, and ZERO cells marked `data-cell-inert` — the shell's loud
//      marker for a family/static key with no registered cell spec.
//   3. PER-CELL OPERABILITY: every rendered cell — param, family AND static
//      — is driven by its OWN natural interaction and asserted to have an
//      observable effect:
//        knob      → pointer-drag commits a new param value into the graph
//        momentary → press writes the pad HIGH, release returns it to REST
//                    (no latch, nothing stuck persisted)
//        toggle    → click flips the switch's aria-checked state
//        selector  → choosing another option changes the displayed value
//        action    → the press REACHES ITS DECLARED SEAM and is reported
//                    DELIVERED (2026-08-02 — this branch used to click and
//                    assert nothing at all; see driveCell's `action` case)
//        file      → a real <input type=file> that ACCEPTS a file and runs
//                    its import action (asserted via the cell's status line)
//      An inert cell has no natural interaction, so it fails by construction.
//
// The browser-free pre-gates are module-face-lint's dockFacePlan parity +
// momentary/compact-cap tests and shell-cells' coverage test; the deliberate
// in-lane top-N curation is covered by workflow-shell-faces. Runs on
// /rack?shell=legacy (no DB/relay) — the normal e2e lane.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { idsCoveredBy, paramsCoveredByCell } from './cell-coverage';
import { spawnPatch } from '../_helpers';
import { showAllBands, type BandFocusDecl } from '../_band-focus';
import { FACE_QUIESCE } from '../_face-quiesce';
import { STRICT_FACES } from '../../../packages/web/src/lib/ui/workflow/strict-faces';
// The COLOUR probe's "pick a different one" + its formatter, imported from the
// same pure model the component renders through — so the expected value and
// the painted value cannot drift, and the no-fixed-point property the probe
// depends on is the one the unit lane negative-controls on every run.
import {
  nextProbeColor,
  packedToHex,
} from '../../../packages/web/src/lib/ui/controls/color-field-model';

// CI (and a local E2E_SWIFTSHADER=1 flake-check) rasterizes on the SwiftShader
// SOFTWARE renderer with 4 workers on a 4-vCPU runner. Mirrors the SLOW_RENDER
// idiom in workflow-shell-video / workflow-lane-add-safety / videovarispeed-
// switch / workflow-master-transport.
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

// ── THE BUDGET IS PER-FACE AND SCALES WITH THAT FACE'S CELL COUNT ──
//
// This sweep's cost is DOMINATED by the per-cell operability loop: every cell
// costs a `centreOf` (scroll + rect, ONE call), four mouse dispatches
// (`move`/`down`/`move{steps:8}`/`up` — `steps` is batched browser-side, so it
// is one call, MEASURED, not four) and a graph read plus poll — ~9 protocol
// round-trips EACH, against a live SvelteFlow rack whose video zone is being
// software-rasterized the whole time. So a face's wall-clock is essentially
// `fixed boot/spawn/dock + k × cells`, and the flat 30s default was a budget
// for the SMALLEST face applied to the LARGEST one.
//
// Measured (this worktree, warm dev server, 1 worker):
//   real GPU     ≈ 1.2s + 0.12s/cell   (cloudseed's 46 cells → 6.7s)
//   SwiftShader  ≈ 2.0s + 0.19s/cell   (cloudseed → 10.8s)
// CI run 30190844866 (shard 3/10) failed EXACTLY the four biggest faces —
// cloudseed (46 cells), kickdrum (25), tidyVco (25), snaredrum (22) — on both
// attempts, always mid-`dragKnob` and always still PROGRESSING, never on a
// failed assertion; sixstrum (19) was the largest to squeak through. That
// cutoff pins CI at roughly `10s + 0.8s/cell`, i.e. ~4× the local software-
// renderer per-cell cost.
//
// The FIXED term is sized off the COLD boot, not the warm one: on a freshly
// started dev server (vite cache cleared) under SwiftShader the 4-cell `adsr`
// row — the alphabetically first, so the one that pays SvelteKit's on-demand
// /rack?shell=legacy&seed=none compile — measured 13.2s all-in vs 3.2s warm.
//
// So the ceiling is DERIVED from the cells the face actually rendered rather
// than bumped by a flat constant: batch 3 adds five more faces (and any face
// can grow params) without re-breaking this, and a face that shrinks gives its
// budget back. Costs NOTHING on the green path — a raised ceiling is only ever
// spent by a test that was going to fail anyway.
//
// Repo rule (ci-swiftshader-video-e2e-timeouts / CLAUDE.md): scale by the work,
// never flat; grow failure bounds only — no assertion or window below moves.
//
// The CI per-cell rate is sized for INTER-RUN VM VARIANCE, not the typical run
// (#1860 class, measured 2026-08-19 off blob reports): backdraft (28 cells)
// ran 41.9 s on main's green run and 47.9 s on the next branch run, then blew
// the old 1_800/cell ceiling (95.4 s) TWICE on the run after that — identical
// code, a ≥2× swing, the same slow-runner lottery that hit the videoout specs
// the same night. 3_000/cell puts backdraft at 129 s ≈ 2.7× its typical run.
const FACE_FIXED_MS = SLOW_RENDER ? 45_000 : 30_000;
const FACE_PER_CELL_MS = SLOW_RENDER ? 3_000 : 600;

interface SpecParam {
  id: string;
  curve: string;
  defaultValue: number;
  min: number;
  max: number;
}
interface SpecShape {
  type: string;
  params: SpecParam[];
  controlFamilies?: string[];
  /** #1726 — param ids the def declares as having NO user control. They must
   *  render ZERO cells; every other param exactly one. */
  noUserControl?: string[];
  strictFace?: boolean;
  /** `face.bandFocus` — the param whose value decides which bands render. See
   *  `_band-focus.ts` for why this sweep needs it. */
  bandFocus?: BandFocusDecl;
}

/**
 * ⚠ `showAllBands` MOVED TO `./_band-focus.ts` and is IMPORTED above.
 *
 * It lived here first, because this was the first sweep band focus broke. It is
 * not the only one: PF-20's annotation sweep (`faceplate-platform.spec.ts`) went
 * RED the same way — `declared 5, received 1` band hints — because every
 * registry-driven face sweep measures the whole face against what the def
 * declares, and a focused face renders less of it. Two copies of the drive would
 * have been two things to keep in step with the declaration's shape, so there is
 * one export site and both sweeps import it.
 *
 * WHY THIS SWEEP NEEDS IT, kept here at the subject: this test asserts the
 * dock's control set EQUALS the def's param set. A face that hides bands renders
 * FEWER controls at most values, so the assertion would FAIL on a
 * correctly-working module. It does not go vacuous; it goes red for the wrong
 * reason. The companion half — that the hiding is REAL — is §4 below.
 */

/** The shell's per-cell interaction contract (`data-cell-control`).
 *
 *  ⚠ EVERY value needs a `driveCell` branch. The final `throw` is deliberate —
 *  an unrecognised control kills the WHOLE spec rather than skipping one row —
 *  so a new primitive lands its branch HERE, in the platform PR, before any
 *  face adopts it. */
type CellControl =
  | 'knob'
  | 'momentary'
  | 'toggle'
  | 'segmented'
  | 'selector'
  | 'grid'
  | 'color'
  | 'hue'
  | 'fader'
  | 'xy'
  | 'action'
  | 'file'
  | 'panel'
  | 'inert';

/** A panel's DECLARED operability probe (PF-14 — shell-cells.ts ShellPanelProbe).
 *  Published from the SHELL layer, not `__moduleSpecs`. */
interface PanelProbe {
  testid: string;
  action: 'click' | 'drag';
  effect:
    | { kind: 'data'; key: string; expect: 'changed' }
    | { kind: 'data-rev'; key: string }
    /** A DIFFERENT element inside the panel whose rendered text must change —
     *  for a panel whose affordance is deliberately NOT in `node.data` (a
     *  private view setting must not ride the Y.Doc). See the shell-cells doc. */
    | { kind: 'text'; testid: string; expect: 'changed' };
}

interface RenderedCell {
  control: CellControl;
  kind: string;
  key: string;
  /** The cell's `data-control-params`, verbatim — a 2-D pad declares both axis
   *  ids here. Interpreted by `paramsCoveredByCell`, never in the page. */
  covered: string | null;
  /** The `face.pages` band this cell lives in. Load-bearing for a TABBED face
   *  (PF-16): the inactive bands are CSS-hidden, so the drive loop has to open
   *  the owning tab before it can touch the cell. */
  page: string | null;
}

/**
 * The module def's source, for anchoring a FACE_QUIESCE global against the code
 * that actually reads it. Audio and video defs live in sibling directories and
 * the type IS the basename, so this needs no per-module knowledge. Returns null
 * when neither exists, which the anchoring test fails on.
 */
// ⚠ THIS PATH IS RELATIVE TO *THIS FILE*, AND THIS FILE MOVED (#2141). It was
// `../../packages/…` while the sweep lived at `e2e/tests/`; the split moved it to
// `e2e/tests/support/`, one level deeper.
//
// ⚠ AND NOTHING STATIC COULD SEE THAT. The import-path fixes in the same commit
// were caught by `tsc` because they are `import` statements; this is a RUNTIME
// `new URL(...)` + `existsSync`, so a wrong path is not a compile error — it is
// a silent `null`, and `moduleSourceFor` returning null reads exactly like "that
// module does not exist". It surfaced on CI as
// `foxy: no module source found to anchor the quiesce against`, which points at
// foxy rather than at this line.
//
// So the directory itself is now anchored below: a base that does not resolve
// fails ONCE, naming the real cause, instead of once per module naming the wrong
// one.
const MODULES_ROOT = fileURLToPath(new URL('../../../packages/web/src/lib/', import.meta.url));

function moduleSourceFor(type: string): string | null {
  if (!existsSync(MODULES_ROOT)) {
    throw new Error(
      `faces-parity-suite: MODULES_ROOT does not resolve (${MODULES_ROOT}). This file's path ` +
        'relative to packages/ has changed — every quiesce anchor below would report "no module ' +
        'source found" and name a MODULE instead of this path.',
    );
  }
  for (const domain of ['audio', 'video']) {
    const p = `${MODULES_ROOT}${domain}/modules/${type}.ts`;
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

/**
 * Boot the workflow shell, optionally QUIESCING the module under test first.
 *
 * ⚠ THE INSTALL HAPPENS BEFORE `goto`, and that ordering is the whole
 * mechanism: `addInitScript` runs at document_start, so the flag is set before
 * any module factory constructs and can be read at construction time. Setting
 * it after navigation would be a race against the first frame.
 *
 * `type` is optional because the other tests in this file boot the shell
 * without a module under test; those get no quiesce, which is the deny-by-
 * default behaviour. See `_face-quiesce.ts` for what a quiesce may and may not
 * stop — in short, a module's own animation, never the cell surface this sweep
 * asserts on.
 */
async function gotoShell(page: Page, type?: string): Promise<void> {
  const quiesce = type ? FACE_QUIESCE[type] : undefined;
  if (quiesce) {
    await page.addInitScript(
      ({ global, value }) => {
        (globalThis as unknown as Record<string, number>)[global] = value;
      },
      { global: quiesce.global, value: quiesce.value },
    );
  }
  await page.goto('/rack');
  // 15 s (not the 5 s default): this is the BOOT wait, and the FIRST test of a
  // run pays SvelteKit's on-demand /rack?shell=legacy&seed=none route compilation before the workflow
  // chrome mounts — which overran 5 s on a cold dev server and failed only the
  // alphabetically-first module. The sibling workflow specs (camera-input,
  // dock-pane-close-chrome, workflow-dock-occupancy) already carry this exact
  // bound; it still fails hard if the topbar genuinely never mounts. Doubled
  // under SLOW_RENDER: on CI that cold compile lands on a 4-vCPU runner already
  // running three other workers' software-rasterized racks.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({
    timeout: SLOW_RENDER ? 30_000 : 15_000,
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  // ⚠ THIS PROVES `addInitScript` RAN AND SURVIVED NAVIGATION — AND NOTHING
  // MORE, which is worth stating precisely because the first version of this
  // comment claimed more. Setting a name and then reading the SAME name back is
  // a tautology: it returns the value whatever the name is, so it cannot tell a
  // correct global from a typo. Measured — renaming the roster's global to
  // nonsense left this GREEN while the row ran unquiesced.
  //
  // It is kept because it CAN still fail on the one thing it does cover (a
  // Playwright change that stops applying init scripts, or a navigation that
  // drops them), and it fails LOUDLY rather than as a slow row. The check that
  // the global is one the module actually READS is anchored against the module
  // SOURCE in the roster test above, which is where a typo dies.
  if (quiesce) {
    const landed = await page.evaluate(
      (g) => (globalThis as unknown as Record<string, unknown>)[g],
      quiesce.global,
    );
    expect(
      landed,
      `${type}: the declared quiesce ${quiesce.global} did not reach the page — `
        + 'the row is running UNQUIESCED and its budget no longer means what it says',
    ).toBe(quiesce.value);
  }
}

async function readSpec(page: Page, type: string): Promise<SpecShape> {
  const spec = await page.evaluate((t) => {
    const w = globalThis as unknown as { __moduleSpecs?: SpecShape[] };
    return w.__moduleSpecs?.find((s) => s.type === t) ?? null;
  }, type);
  expect(spec, `${type}: registered in the live registry (__moduleSpecs)`).toBeTruthy();
  return spec!;
}

/** Open the module's dock full-view and return the dock-tier shell locator. */
async function openDock(page: Page, nodeId: string) {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  const dockShell = faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]');
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/** Read the live graph value of one param (null when unset). */
function readParam(page: Page, nodeId: string, pid: string): Promise<number | null> {
  return page.evaluate(
    ({ nodeId, pid }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch.nodes[nodeId]?.params?.[pid] ?? null;
    },
    { nodeId, pid },
  );
}

/**
 * Read a value out of the live `node.data` by PATH — the `readParam` twin for
 * the half of a module's state that is NOT params.
 *
 * A bespoke panel (PF-14) edits `node.data` on purpose: the DX7's 78 operator
 * values are patch DESIGN, not performance, so they ride the Y.Doc as plain
 * data instead of buying 78 ParamDefs' worth of MIDI-learn/automation/CV. That
 * is exactly why a panel needs a declared probe — nothing about `node.data` is
 * visible to the param-shaped assertions above.
 *
 * `path` supports dotted keys and numeric indices: `voiceRev`, `opOn[1]`,
 * `voice.operators[0].outputLevel`. Returns null for a missing node/segment, so
 * "unset" and "absent" read the same way `readParam` makes them.
 */
function readData(page: Page, nodeId: string, path: string): Promise<unknown> {
  return page.evaluate(
    ({ nodeId, path }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: unknown } | undefined> };
      };
      let cur: unknown = w.__patch.nodes[nodeId]?.data;
      for (const seg of path.split(/[.[\]]+/).filter(Boolean)) {
        if (cur === null || cur === undefined) return null;
        cur = (cur as Record<string, unknown>)[seg];
      }
      return cur ?? null;
    },
    { nodeId, path },
  );
}

/** The panel probes the SHELL published (`window.__shellPanelProbes`). */
function readPanelProbe(page: Page, type: string, key: string): Promise<PanelProbe | null> {
  return page.evaluate(
    ({ type, key }) => {
      const w = globalThis as unknown as {
        __shellPanelProbes?: Record<string, Record<string, PanelProbe>>;
      };
      return w.__shellPanelProbes?.[type]?.[key] ?? null;
    },
    { type, key },
  );
}

/** The action-cell press MODES the SHELL published (`window.__shellActionModes`).
 *  Read from the DECLARATION, never from the DOM — see the note on
 *  `shellActionModes()` in shell-cells.ts for the measured reason. */
function readActionMode(page: Page, type: string, key: string): Promise<'trigger' | 'gate' | null> {
  return page.evaluate(
    ({ type, key }) => {
      const w = globalThis as unknown as {
        __shellActionModes?: Record<string, Record<string, 'trigger' | 'gate'>>;
      };
      return w.__shellActionModes?.[type]?.[key] ?? null;
    },
    { type, key },
  );
}

/** An ACTION cell's declared operability probe (`window.__shellActionProbes`). */
function readActionProbe(page: Page, type: string, key: string): Promise<ActionProbe | null> {
  return page.evaluate(
    ({ type, key }) => {
      const w = globalThis as unknown as {
        __shellActionProbes?: Record<string, Record<string, ActionProbe>>;
      };
      return w.__shellActionProbes?.[type]?.[key] ?? null;
    },
    { type, key },
  );
}

/**
 * Read the AUDITION LEDGER out of the page.
 *
 * ⚠ IT IS ACCUMULATED IN THE PAGE, NOT POLLED FROM HERE. The repo rule
 * (CLAUDE.md, "never sample a page-side quantity with a Playwright-side poll
 * loop") applies exactly: an audition is a single synchronous call on the main
 * thread, and a protocol-round-trip poll on that same thread would be racing
 * the thing it measures on a loaded runner. The seams push into a module-scope
 * array, so a record SURVIVES a stall and one `evaluate` after the press reads
 * everything that happened.
 */
function readAuditionLog(page: Page): Promise<AuditionRecord[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __auditionLog?: () => AuditionRecord[] };
    return w.__auditionLog ? w.__auditionLog() : [];
  });
}

interface AuditionRecord {
  seq: number;
  nodeId: string;
  /** `manual-press` is the MOMENTARY PAD seam — see the `momentary` branch and
   *  audition-ledger.ts for why it is a fourth member, not an alias of
   *  `manual-gate`. An ACTION cell must never declare it (shell-cells.test.ts). */
  seam: 'manual-strike' | 'manual-gate' | 'engine-message' | 'manual-press';
  high?: boolean;
  paramId?: string;
  delivered: boolean;
}

interface ActionProbe {
  effect:
    | { kind: 'audition'; seam: AuditionRecord['seam'] }
    | { kind: 'data'; key: string; expect: 'changed' }
    | { kind: 'data-rev'; key: string };
}

/** The pure predicate, mirroring `auditionDelivered` in audition-ledger.ts —
 *  which is negative-controlled in BOTH directions in the unit lane on every
 *  run (`audition-ledger.test.ts`), so this side stays a thin read. */
const delivered = (
  log: AuditionRecord[],
  nodeId: string,
  seam: AuditionRecord['seam'],
  sinceSeq: number,
  high?: boolean,
  paramId?: string,
): boolean =>
  log.some(
    (r) =>
      r.seq > sinceSeq &&
      r.nodeId === nodeId &&
      r.seam === seam &&
      r.delivered &&
      (high === undefined || r.high === high) &&
      (paramId === undefined || r.paramId === paramId),
  );

const lastSeq = (log: AuditionRecord[]): number => (log.length ? log[log.length - 1]!.seq : 0);

/** A one-line dump of what the ledger DID see, so a red run is diagnosable
 *  rather than a coin flip ("frozen" and "never looked" must not print the
 *  same thing). */
const dumpLog = (log: AuditionRecord[], since: number): string =>
  log
    .filter((r) => r.seq > since)
    .map(
      (r) =>
        `${r.seam}${r.paramId ? `[${r.paramId}]` : ''}` +
        `${r.high === undefined ? '' : r.high ? '/high' : '/low'}→${r.delivered}`,
    )
    .join(', ') || '(no audition records at all)';

/** Every cell the dock faceplate rendered, in DOM order.
 *
 *  ⚠ `evaluateAll` matches HIDDEN elements, and that is what makes the PF-16
 *  tab rail free here: a tabbed face keeps all eight bands MOUNTED and hides
 *  seven with CSS, so this sweep still sees the whole control surface. If the
 *  shell ever `{#if}`-unmounted an inactive page instead, a tabbed face would
 *  read as a face that LOST forty controls — which is exactly the alarm this
 *  gate should raise, so nothing here filters by visibility on purpose. */
async function renderedCells(dockShell: Locator): Promise<RenderedCell[]> {
  return dockShell.locator('[data-cell-kind]').evaluateAll((els) =>
    els.map((el) => ({
      control: (el.getAttribute('data-cell-control') ?? 'inert') as CellControl,
      kind: el.getAttribute('data-cell-kind') ?? '',
      key: el.getAttribute('data-cell-key') ?? '',
      // RAW attribute — interpreted by `paramsCoveredByCell` in Node (see the
      // domIds note above and support/cell-coverage.ts).
      covered: el.querySelector('[data-control-params]')?.getAttribute('data-control-params') ?? null,
      page: el.closest('[data-face-page]')?.getAttribute('data-face-page') ?? null,
    })),
  );
}

/**
 * PF-16 — open the tab that owns `cell`, when the face is tabbed at all.
 *
 * REGISTRY-DRIVEN, like everything else here: the rail's existence is read off
 * the DOM (`[role="tab"]` chips the faceplate painted), never off a per-module
 * list, so a face that crosses the tab threshold later auto-enrols with no
 * edit. A face below the threshold has no rail and this is a no-op.
 *
 * Verifying the tab actually TOOK matters: a rail that renders but does not
 * switch would leave the cell hidden and the failure would surface as a
 * confusing `toBeVisible` timeout on the control rather than on the tab.
 *
 * ── ⚠ WHY THIS TAKES A CURSOR INSTEAD OF ASKING THE PAGE ────────────────────
 *
 * It is called ONCE PER CELL — ~380 times across this file — and it used to
 * spend two protocol round-trips (`locator.count`, then `locator.getAttribute`)
 * on EVERY ONE of them just to discover that the tab it wants is already the
 * open tab. Cells arrive grouped by band, so the answer was already known: the
 * only calls that can change anything are the ~8 real transitions per railed
 * face, plus one rail-exists probe per face.
 *
 * MEASURED with `DEBUG=pw:api` over the whole spec — `locator.count` 382 → 33
 * and `locator.getAttribute` 129 → 16.
 *
 * ⚠ AND THE COUNT IS THE POINT, not the seconds. A protocol call is one
 * round-trip between the test process and the browser: the same test makes the
 * SAME NUMBER of them on Metal, under SwiftShader, and on a contended 4-worker
 * runner. Wall-clock does none of that — which is exactly why #1454 measured
 * this file green on Metal and blew shard 3's 900 s ceiling on CI. A count is
 * the only number that transfers.
 *
 * The CURSOR IS NOT A CACHE OF PAGE STATE. It records what THIS LOOP last
 * clicked, and nothing else in the loop touches the rail — `driveCell` operates
 * cells, never tabs. If that ever stops being true the cursor must go, because
 * a stale cursor would skip a needed click and the failure would resurface as
 * the same confusing `toBeVisible` timeout this helper's own comment warns
 * about. The click path still asserts `aria-selected` flipped, so a rail that
 * renders and does not switch is caught on the transition it fails.
 */
interface TabCursor {
  /** null = not yet probed; false = this face has no rail (untabbed). */
  railed: boolean | null;
  /** The band id this loop last activated, or null before the first switch. */
  active: string | null;
}

function newTabCursor(): TabCursor {
  return { railed: null, active: null };
}

async function openTabFor(page: Page, cell: RenderedCell, cursor: TabCursor): Promise<void> {
  if (!cell.page) return;
  if (cursor.railed === false) return; // untabbed face — one scrolling column
  const tab = page.getByTestId('dock-full-view').getByTestId(`faceplate-tab-${cell.page}`);
  if (cursor.railed === null) {
    // ONE rail-exists probe per face, not per cell. `count()` on a per-band
    // testid is the same question for every band of a given face: a faceplate
    // either painted a rail or it did not.
    cursor.railed = (await tab.count()) > 0;
    if (!cursor.railed) return;
  }
  if (cursor.active === cell.page) return; // already open — this loop opened it
  if (cursor.active === null && (await tab.getAttribute('aria-selected')) === 'true') {
    // First cell of a railed face: the faceplate chose its own default tab, so
    // the page is the authority exactly once. After this the cursor is.
    cursor.active = cell.page;
    return;
  }
  await tab.click();
  await expect(tab, `tab '${cell.page}' activates`).toHaveAttribute('aria-selected', 'true');
  cursor.active = cell.page;
}

/**
 * Drag a knob cell vertically — the KnobConic gesture, sized so EVERY param
 * shape actually moves. The dial maps 200 px to the full arc and a `discrete`
 * curve SNAPS to the nearest step, so the old fixed 48 px nudge could never
 * move a coarse switch-like param (`hard` 0..1, `oct2` -1..1, `strumDir`
 * 0..2 all round straight back). Travel is therefore derived from the param's
 * own step count, and the direction runs AWAY from whichever end the value
 * currently sits at (a param resting at its max, e.g. dx7 `voiceCount`, cannot
 * go up) while staying inside the viewport.
 *
 * That direction rule is load-bearing, not a nicety: a FIXED upward drag is a
 * guaranteed FALSE FAILURE on any param already at its ceiling — nothing moves,
 * nothing commits, and a perfectly operable control reads as LOST. Batch 3's
 * MIXER is the sharpest case (it ships all four channel levels AND the master
 * at max — a summing mixer is a unity pass-through out of the box), and the
 * same bite recurs on every attenuator-shaped module.
 */
/**
 * Scroll a control into view and return its CENTRE, in ONE protocol call.
 *
 * ⚠ THIS REPLACED `scrollIntoViewIfNeeded()` + `boundingBox()`, which is two
 * round-trips asking one question, ~360 times across this file. MEASURED with
 * `DEBUG=pw:api`: `locator.scrollIntoViewIfNeeded` 375 → 0 and
 * `locator.boundingBox` 349 → 0, against one `locator.evaluate` each.
 *
 * Equivalence, since this is a pointer coordinate and being subtly wrong would
 * show up as a drag that misses: `getBoundingClientRect()` is viewport-relative
 * and so is `boundingBox()`, and both are read AFTER the scroll, so the numbers
 * are the same numbers. `scrollIntoView({ block: 'center' })` is instant by
 * default (no smooth behaviour to race), and layout is synchronous, so reading
 * the rect on the next line sees the scrolled position.
 *
 * ⚠ WHAT IT GIVES UP, stated because it is the only real risk: Playwright's
 * `scrollIntoViewIfNeeded` also waits for the element to be STABLE (not
 * animating). This does not. Two things make that safe here rather than
 * hopeful — the caller has already awaited `expect(host).toBeVisible()`, and a
 * mis-aimed drag cannot pass silently: the `expect.poll(readParam).not.toBe(
 * before)` that follows every drag turns a missed grab into a RED test, never
 * a green one. Flake-checked 3× under `E2E_SWIFTSHADER=1`, which is the
 * renderer where a slow layout would actually bite.
 */
async function centreOf(control: Locator): Promise<{ cx: number; cy: number }> {
  return await control.evaluate((el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
}

/**
 * `centreOf`'s twin for a control driven by a gesture that needs the WHOLE box
 * rather than its centre — today exactly the 2-D pad, whose drive is a diagonal
 * from the centre toward a corner. Same scroll, same one-round-trip shape, same
 * equivalence argument.
 *
 * ⚠ IT EXISTS BECAUSE THE `xy` ARM WAS THE ONE ARM THAT NEVER SCROLLED, and
 * that was invisible until a face declared a pad. `centreOf` returns a centre,
 * so the pad arm — which needs width/height to aim at a corner — was written
 * with a bare `boundingBox()` and the scroll silently dropped out. Nothing
 * caught it because `face.xyPads` had NO ADOPTER: the kind shipped ahead of its
 * first consumer, so this branch had never executed against a real faceplate.
 *
 * MEASURED on `backdraft`, the first adopter: the TILT pad's box came back at
 * y=774..870 in a 720-tall viewport — entirely below the fold —
 * `document.elementFromPoint` at both the grab and the release point returned
 * NONE, and the drag wrote nothing. The failure surfaced as "'camTiltX' did not
 * move", which reads like a pad wired to one axis: a true statement about the
 * symptom that points at the wrong subject.
 */
async function rectOf(control: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return await control.evaluate((el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

async function dragKnob(page: Page, knob: Locator, p: SpecParam, current: number): Promise<void> {
  const { cx, cy } = await centreOf(knob);

  // Travel (px): a discrete param must cross its rounding midpoint (1 step =
  // 200/steps px, so 0.6 of a step + slack always lands on a new integer); a
  // continuous one moves with any real gesture.
  const steps = p.curve === 'discrete' ? Math.max(1, Math.round(p.max - p.min)) : 0;
  const travel = steps ? Math.min(190, (200 * 0.6) / steps + 30) : 60;

  // Which way: 'up' raises the value. Start from the end the value is NOT at.
  const frac = (current - p.min) / (p.max - p.min || 1);
  let up = frac <= 0.5;
  const vh = page.viewportSize()?.height ?? 720;
  if (up && cy - travel < 8) up = false;
  else if (!up && cy + travel > vh - 8) up = true;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, up ? cy - travel : cy + travel, { steps: 8 });
  await page.mouse.up();
}

/**
 * Drive ONE rendered cell and assert an observable effect. Returns a short
 * description of what it proved, so a failure names the exact cell.
 */
async function driveCell(
  page: Page,
  dockShell: Locator,
  nodeId: string,
  spec: SpecShape,
  cell: RenderedCell,
): Promise<void> {
  const where = `${spec.type} cell '${cell.key}' (${cell.kind}/${cell.control})`;

  // An INERT cell is the failure this gate exists for — a curated control
  // rendered as dead text, with no interaction to perform at all.
  expect(cell.control, `${where}: rendered INERT (a dead label, not a control)`).not.toBe('inert');

  const host = dockShell.locator(`[data-cell-key="${cell.key}"]`);
  await expect(host, `${where}: renders`).toBeVisible();

  if (cell.control === 'knob') {
    const pid = cell.key;
    const p = spec.params.find((q) => q.id === pid);
    expect(p, `${where}: backed by a real ParamDef`).toBeTruthy();
    const before = await readParam(page, nodeId, pid);
    await dragKnob(page, host.locator(`[data-testid="control-${pid}"]`), p!, before ?? p!.defaultValue);
    await expect
      .poll(() => readParam(page, nodeId, pid), {
        message: `${where}: dragging the knob commits a param change into the graph`,
      })
      .not.toBe(before);
    return;
  }

  // A FADER is a THROW over the same 1-D scale a knob covers, so it is driven
  // the same way and asserted the same way: `dragKnob` is a pointer drag over
  // the control's own box, which is exactly what a fader wants too. The kind
  // exists because the AFFORDANCE differs (a card that draws a throw and a face
  // that draws a dial are not the same control), not because the value
  // semantics do — so a separate drive helper would be two implementations of
  // one gesture. `NeonFader` derives `control-<paramId>` itself, so the
  // locator is identical.
  // ⚠ THIS ARM USED TO MATCH `'neon-fader'` TOO. #1794 collapsed the two
  // declared kinds into one — there is a single throw in the app now — so the
  // second alternative would name a kind `DeclaredParamCell` no longer has.
  if (cell.control === 'fader') {
    const pid = cell.key;
    const p = spec.params.find((q) => q.id === pid);
    expect(p, `${where}: backed by a real ParamDef`).toBeTruthy();
    const fader = host.locator(`[data-testid="control-${pid}"]`);
    await expect(fader, `${where}: the fader is a real, visible control`).toBeVisible();
    const before = await readParam(page, nodeId, pid);
    await dragKnob(page, fader, p!, before ?? p!.defaultValue);
    await expect
      .poll(() => readParam(page, nodeId, pid), {
        message: `${where}: dragging the fader commits a param change into the graph`,
      })
      .not.toBe(before);
    return;
  }

  // A 2-D PAD is ONE cell over TWO params, and the drive reflects that: a
  // SINGLE DIAGONAL drag must move BOTH. That is a strictly stronger assertion
  // than the knob arm makes, and it is the one that matters — two dials can
  // reach every value this pad can, and cannot reach them together. A pad wired
  // to only one axis (the likeliest way to break it) passes every 1-D check and
  // fails here.
  if (cell.control === 'xy') {
    const pad = host.locator('[data-control-params]');
    await expect(pad, `${where}: the pad is a real, visible control`).toBeVisible();
    const axes = ((await pad.getAttribute('data-control-params')) ?? '').split(',').filter(Boolean);
    expect(
      axes.length,
      `${where}: an xy cell must declare BOTH axis param ids in data-control-params`,
    ).toBe(2);
    for (const pid of axes) {
      expect(
        spec.params.some((q) => q.id === pid),
        `${where}: axis '${pid}' is backed by a real ParamDef`,
      ).toBe(true);
    }
    const before = await Promise.all(axes.map((pid) => readParam(page, nodeId, pid)));
    // Drag from the pad's centre toward its lower-left corner: both axes move,
    // and away from centre so a default-at-an-edge param still has travel.
    // SCROLL FIRST — see `rectOf`. A pad below the fold reports a perfectly
    // good box that no pointer can reach.
    const box = await rectOf(pad);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.85, { steps: 8 });
    await page.mouse.up();
    for (const [i, pid] of axes.entries()) {
      await expect
        .poll(() => readParam(page, nodeId, pid), {
          message:
            `${where}: ONE diagonal drag must commit BOTH axes — '${pid}' did not move. A pad ` +
            `wired to a single axis passes every 1-D assertion in this spec.`,
        })
        .not.toBe(before[i]);
    }
    return;
  }

  if (cell.control === 'momentary') {
    // A press-pad must go HIGH while held and RETURN TO REST on release — never
    // latch — and it must leave NOTHING behind in the Y.Doc.
    //
    // ⚠ THE ORACLE MOVED, AND NOT COSMETICALLY. A press-pad writes the ENGINE
    // ONLY (manual-strike-actions.ts `setMomentaryParam`) precisely so a lost
    // release cannot persist a stuck value — which means `readParam` is now
    // STRUCTURALLY BLIND to it, exactly like the audition seams above. This
    // branch used to read:
    //
    //     .poll(() => readParam(page, nodeId, pid) ?? rest).toBe(rest)
    //
    // With the param permanently absent that is `rest === rest` —
    // UNCONDITIONALLY TRUE. The headline "a momentary pad must not latch"
    // assertion would have shipped vacuous, passing on a pad that latched, on a
    // pad that never fired, and on a pad whose handler was deleted. Fixing only
    // the HIGH poll (which fails loudly, so it gets noticed) while leaving the
    // release clause is the trap: it looks like the whole repair.
    //
    // So both edges are asserted against the AUDITION LEDGER, the same
    // observable the `action` branch uses and for the same reason — and both
    // can fail. The graph is then asserted to be UNTOUCHED, which is the third
    // independent leg and the one that would catch a re-introduced Y.Doc write.
    const pid = cell.key;
    const pad = host.locator(`[data-testid="control-${pid}"]`);
    // One call, not two — see centreOf.
    const { cx: padCx, cy: padCy } = await centreOf(pad);
    // Snapshot BOTH oracles before the gesture: the ledger cursor so an earlier
    // module's press cannot satisfy this one, and the graph value so "untouched"
    // is a comparison rather than an assumption about what spawn seeded.
    const beforeSeq = lastSeq(await readAuditionLog(page));
    const beforeParam = await readParam(page, nodeId, pid);
    await page.mouse.move(padCx, padCy);
    await page.mouse.down();
    await expect
      .poll(
        async () =>
          delivered(await readAuditionLog(page), nodeId, 'manual-press', beforeSeq, true, pid),
        {
          message:
            `${where}: the PRESS reached the momentary seam and DELIVERED. A false here means ` +
            `the pad ran its handler and the engine took nothing — the pad is dead while it ` +
            `still lights up.`,
        },
      )
      .toBe(true);
    await expect(pad, `${where}: reports its held state`).toHaveAttribute('aria-pressed', 'true');
    // ⚠ READ WHILE STILL HELD. This is the anti-latch check's graph half, and it
    // only means anything before the release: if the press wrote the Y.Doc, THIS
    // is where it is visible.
    expect(
      await readParam(page, nodeId, pid),
      `${where}: the press must write the ENGINE ONLY — a durable param value here is the ` +
        `stuck-pad defect (a lost release then persists it, syncs it, and survives reload)`,
    ).toBe(beforeParam);

    await page.mouse.up();
    // ⚠ ASSERTED ON THE RELEASE EDGE ITSELF, not on an end state. A pad that
    // never pressed and a pad that pressed-and-released both end with
    // `aria-pressed="false"` and both leave the graph untouched — only the LOW
    // record distinguishes "the release reached the seam" from "the release went
    // nowhere and the engine is still holding the pad down".
    await expect(pad, `${where}: not left pressed`).toHaveAttribute('aria-pressed', 'false');
    const pLog = await readAuditionLog(page);
    expect(
      delivered(pLog, nodeId, 'manual-press', beforeSeq, false, pid),
      `${where}: the RELEASE reached the seam and returned the pad to REST — a momentary pad ` +
        `must not latch. Ledger since press: ${dumpLog(pLog, beforeSeq)}`,
    ).toBe(true);
    expect(
      await readParam(page, nodeId, pid),
      `${where}: the gesture left NOTHING in the Y.Doc`,
    ).toBe(beforeParam);
    return;
  }

  if (cell.control === 'toggle') {
    const sw = host.locator('[role="switch"]');
    const before = await sw.getAttribute('aria-checked');
    await sw.click();
    await expect(sw, `${where}: clicking flips the switch`).not.toHaveAttribute(
      'aria-checked',
      before ?? '',
    );
    return;
  }

  if (cell.control === 'segmented') {
    // A NAMED-STATE row (PF-1 `ParamDef.options`). Operating it means picking
    // a DIFFERENT state and seeing that state land in the graph — the same bar
    // the knob branch meets, not merely "a button was clickable".
    const pid = cell.key;
    const group = host.locator(`[data-testid="control-${pid}"]`);
    await expect(group, `${where}: a real radiogroup`).toHaveAttribute('role', 'radiogroup');
    const segs = group.locator('[role="radio"]');
    const n = await segs.count();
    expect(n, `${where}: the row offers more than one state`).toBeGreaterThan(1);

    // Pick a segment that is NOT the active one. `aria-checked` is authored
    // off the nearest-segment snap, so this works for an off-detent value too.
    let target = -1;
    for (let i = 0; i < n; i++) {
      if ((await segs.nth(i).getAttribute('aria-checked')) !== 'true') { target = i; break; }
    }
    expect(target, `${where}: some state other than the current one is offered`).toBeGreaterThanOrEqual(0);

    const before = await readParam(page, nodeId, pid);
    await segs.nth(target).scrollIntoViewIfNeeded();
    await segs.nth(target).click();
    await expect
      .poll(() => readParam(page, nodeId, pid), {
        message: `${where}: choosing a state commits it into the graph`,
      })
      .not.toBe(before);
    await expect(segs.nth(target), `${where}: the chosen state lights up`).toHaveAttribute(
      'aria-checked',
      'true',
    );
    return;
  }

  if (cell.control === 'grid') {
    // A CHART of states (PF-15 `face.paramCells`). Two halves, and the split is
    // the thing worth asserting: the CHIP lives in the cell (it is the param's
    // one `control-<paramId>` element, which is why the multiset assert above
    // still balances), while the grid itself is PORTALED to <body> — so it is
    // located off `page`, never off `dockShell`. Operating it means committing
    // a DIFFERENT state into the graph, the same bar the knob branch meets.
    const pid = cell.key;
    const chip = host.locator(`[data-testid="control-${pid}"]`);
    await expect(chip, `${where}: the chip opens a picker`).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
    const before = await readParam(page, nodeId, pid);
    await chip.scrollIntoViewIfNeeded();
    await chip.click();

    const grid = page.locator(`[role="radiogroup"][data-grid-param="${pid}"]`);
    await expect(grid, `${where}: the portaled grid opens`).toBeVisible();
    const gcells = grid.locator('[role="radio"]');
    const n = await gcells.count();
    expect(n, `${where}: the chart offers more than one state`).toBeGreaterThan(1);

    let target = -1;
    for (let i = 0; i < n; i++) {
      if ((await gcells.nth(i).getAttribute('aria-checked')) !== 'true') { target = i; break; }
    }
    expect(target, `${where}: some state other than the current one is offered`).toBeGreaterThanOrEqual(0);
    await gcells.nth(target).scrollIntoViewIfNeeded();
    await gcells.nth(target).click();

    await expect
      .poll(() => readParam(page, nodeId, pid), {
        message: `${where}: picking a cell commits it into the graph`,
      })
      .not.toBe(before);
    await expect(grid, `${where}: committing closes the picker`).toHaveCount(0);
    return;
  }

  if (cell.control === 'color') {
    // A PACKED-RGB SWATCH (`face.paramCells['x'] = 'color'`). The cell kind
    // exists because the alternative — a KnobConic over 16.7 million states —
    // would have PASSED the knob branch above: dragging it does commit a param
    // change. So the probe here has to prove more than "a control moved".
    //
    // ⚠ THE FAILURE MODE A COLOUR CONTROL HAS AND A KNOB DOES NOT IS
    // DECORATION. A coloured rectangle that writes nothing looks correct in a
    // screenshot, in a VRT baseline, and to any assertion that checks a
    // control mounted. Three legs, and each one fails a different lie:
    //
    //   1. the `control-<paramId>` element is a REAL, VISIBLE, ENABLED
    //      `<input type="color">` with a painted box — so a decorative <span>
    //      beside a `display:none` input (the legacy card's shape) is caught
    //      before anything is driven;
    //   2. the graph takes EXACTLY `nextProbeColor(before)` — not merely "a
    //      different value", so a control that clamps, drops a channel or
    //      writes a constant fails on the value rather than passing on the
    //      change;
    //   3. the WITNESS — a separate element whose text is derived from the
    //      LIVE param, never from the input's own state — reaches the same
    //      hex. This is the leg that distinguishes "changed the colour" from
    //      "rendered a swatch": the native input keeps showing whatever was
    //      picked (the browser owns that), so if the write path is severed the
    //      picker looks right and only the witness stays behind.
    //
    // `nextProbeColor` cannot return the value already showing — no fixed
    // point, asserted over the whole space in the unit lane on every run
    // (color-field-model.test.ts). Without that this probe would be vacuous in
    // exactly the way it cannot detect from inside.
    const pid = cell.key;
    const input = host.locator(`[data-testid="control-${pid}"]`);
    await expect(input, `${where}: a real colour input`).toBeVisible();
    await expect(input, `${where}: is an <input type="color">`).toHaveAttribute('type', 'color');
    await expect(input, `${where}: operable`).toBeEnabled();
    const box = await input.boundingBox();
    expect(
      Math.min(box?.width ?? 0, box?.height ?? 0),
      `${where}: the swatch has a real hit target (a hidden input behind a decorative ` +
        `swatch is operable by a script and unreachable by a player)`,
    ).toBeGreaterThan(4);

    // ⚠ THE WITNESS IS `aria-valuetext` ON THE INPUT, NOT A PAINTED SPAN. It was
    // `[data-testid="colorhex-<pid>"]` until 2026-08-20, when that span was found
    // printing a VALUE at rest on a faceplate (#2038's class, second instance —
    // `colourofmagic` is `'color'`'s first adopter, so the hex reached a plate
    // for the first time). The element moved to the accessible tree; the
    // DISCIPLINE is unchanged, because it still reads the `value` PROP rather
    // than the input's own state, so a severed write path still diverges.
    await expect(
      input,
      `${where}: publishes a hex WITNESS derived from the live param. Without it a swatch ` +
        `that never commits is indistinguishable from one that does.`,
    ).toHaveAttribute('aria-valuetext', /^#[0-9a-f]{6}$/i);

    const before = (await readParam(page, nodeId, pid)) ?? 0;
    const want = nextProbeColor(before);
    const wantHex = packedToHex(want);
    expect(want, `${where}: the probe must ask for a DIFFERENT colour`).not.toBe(before);

    // A native colour picker opens an OS dialog on click, so the value is set
    // directly and `input` dispatched — the same event the browser fires while
    // a player drags inside the picker.
    await input.scrollIntoViewIfNeeded();
    await input.evaluate((el, hex) => {
      (el as HTMLInputElement).value = hex;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, wantHex);

    await expect
      .poll(() => readParam(page, nodeId, pid), {
        message:
          `${where}: picking ${wantHex} must commit that EXACT packed value into the graph ` +
          `(was ${before}); a near-miss here is a dropped channel or a clamp, not a rounding`,
      })
      .toBe(want);
    await expect(
      input,
      `${where}: the hex witness must follow the LIVE param to ${wantHex}. The native picker ` +
        `shows the chosen colour whether or not anything was written — only this attribute ` +
        `reads the graph back, so a swatch that is decoration fails HERE and nowhere else.`,
    ).toHaveAttribute('aria-valuetext', wantHex);
    return;
  }

  if (cell.control === 'hue') {
    // A HUE RING (`face.paramCells['x'] = 'hue'`). Like the colour swatch above
    // it, this kind exists because the alternative — a KnobConic over a 0..1
    // angle — would have PASSED the knob branch: dragging it commits a param
    // change. So the probe has to prove more than "a control moved".
    //
    // ⚠ IT IS DRIVEN BY A REAL POINTER GESTURE AT A KNOWN ANGLE, not by setting
    // a value. The whole reason this primitive exists is that the mapping from
    // POSITION to hue wraps, and a probe that wrote the param directly would
    // exercise none of that — it would pass just as happily on a ring whose
    // pointer maths was inverted, off by a quarter turn, or dead. Pressing at a
    // known point on the ring and asserting the ANGLE THAT IMPLIES is the only
    // form that can fail on those.
    const pid = cell.key;
    const ring = host.locator(`[data-testid="control-${pid}"]`);
    await ring.scrollIntoViewIfNeeded();
    const box = await ring.boundingBox();
    expect(box, `${where}: the ring must have a layout box to press`).toBeTruthy();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    const before = (await readParam(page, nodeId, pid)) ?? 0;

    // Press at the THREE O'CLOCK position — a quarter turn clockwise from the
    // top, i.e. hue 0.25 on a 0..1 ring. Chosen because it is far from both the
    // default and the 0/1 seam, so neither a stuck control nor a wrap bug can
    // land on it by accident.
    const radius = Math.min(box!.width, box!.height) / 2;
    await page.mouse.move(cx + radius * 0.8, cy);
    await page.mouse.down();
    await page.mouse.up();

    const want = 0.25;
    await expect
      .poll(() => readParam(page, nodeId, pid), {
        message:
          `${where}: pressing at three o'clock on the ring must commit hue ${want} ` +
          `(was ${before}). A miss of ~0.25 is a quarter-turn offset in the angle maths; ` +
          `a miss of ~0.5 is an inverted sweep; no change at all is a decorative ring.`,
      })
      // The press lands within a pixel or two of the exact angle, so allow a
      // small tolerance — but far tighter than any of the failure modes above.
      .toBeCloseTo(want, 1);

    // …and the ACCESSIBLE value follows, which is where this primitive's value
    // lives: the resting faceplate paints no number, so `aria-valuetext` is the
    // only readable surface and a spec that did not check it would let the
    // control go silent for a screen reader without failing.
    await expect(ring, `${where}: aria-valuetext tracks the committed angle`).toHaveAttribute(
      'aria-valuetext',
      /^\d+°$/,
    );
    return;
  }

  if (cell.control === 'panel') {
    // A BESPOKE PANEL (PF-14) has no interaction this sweep could guess, so the
    // module DECLARES one — and the declaration is what keeps the sweep
    // REGISTRY-DRIVEN off STRICT_FACES instead of growing a per-module branch
    // here. A panel with no probe fails: an undrivable cell is indistinguishable
    // from a dead one, which is the whole class this gate exists to catch.
    const probe = await readPanelProbe(page, spec.type, cell.key);
    expect(
      probe,
      `${where}: declares an operability probe. Add one to its shell-cell spec ` +
        `(packages/web/src/lib/ui/workflow/shell-cells.ts) — the sweep will not ` +
        `special-case a module.`,
    ).toBeTruthy();
    const target = host.locator(`[data-testid="${probe!.testid}"]`);
    await expect(target, `${where}: the probe's target renders`).toBeVisible();

    const effect = probe!.effect;
    // A `text` probe watches a DIFFERENT element than the one it drives — the
    // point is that the interaction moved something the driven control cannot
    // fake by relabelling itself.
    const witness =
      effect.kind === 'text' ? host.locator(`[data-testid="${effect.testid}"]`) : null;
    if (witness) {
      await expect(
        witness,
        `${where}: the probe's WITNESS element (${effect.kind === 'text' ? effect.testid : ''}) renders`,
      ).toBeVisible();
    }
    const key = effect.kind === 'text' ? '' : effect.key;
    const snap = async () => JSON.stringify(await readData(page, nodeId, key));
    const beforeRaw = key ? await readData(page, nodeId, key) : null;
    const before = key ? JSON.stringify(beforeRaw) : '';
    const beforeText = witness ? ((await witness.innerText()) ?? '').trim() : '';

    if (probe!.action === 'drag') {
      const { cx, cy } = await centreOf(target);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx, cy - 24, { steps: 8 });
      await page.mouse.up();
    } else {
      await target.click();
    }

    if (effect.kind === 'data-rev') {
      // A monotonic revision counter must ADVANCE.
      await expect
        .poll(async () => Number(await readData(page, nodeId, key)) || 0, {
          message: `${where}: the probe advances '${key}'`,
        })
        .toBeGreaterThan(Number(beforeRaw) || 0);
    } else if (effect.kind === 'text') {
      await expect(
        witness!,
        `${where}: driving '${probe!.testid}' must CHANGE the text of '${effect.testid}' ` +
          `(was "${beforeText}") — a control that only relabels itself is a dead control`,
      ).not.toHaveText(beforeText);
    } else {
      await expect
        .poll(snap, { message: `${where}: the probe CHANGES node.data['${key}']` })
        .not.toBe(before);
    }
    return;
  }

  if (cell.control === 'selector') {
    // Open the roster and choose a DIFFERENT option; the chip's displayed
    // value must follow (proving the selection was actually committed).
    const chip = host.locator('[role="button"][aria-haspopup="listbox"]');
    const shown = (await chip.locator('.val').innerText()).trim();
    await chip.click();
    const options = page.locator('[role="listbox"] [role="option"]');
    const n = await options.count();
    expect(n, `${where}: the roster offers options`).toBeGreaterThan(1);
    let picked = -1;
    for (let i = 0; i < n; i++) {
      if ((await options.nth(i).innerText()).trim() !== shown) { picked = i; break; }
    }
    expect(picked, `${where}: the roster offers an option other than the current one`).toBeGreaterThanOrEqual(0);
    const want = (await options.nth(picked).innerText()).trim();
    await options.nth(picked).click();
    await expect(chip.locator('.val'), `${where}: choosing another option changes the selection`).toHaveText(want);
    return;
  }

  if (cell.control === 'action') {
    const btn = host.locator('button');
    await expect(btn, `${where}: a real enabled button`).toBeEnabled();

    // TWO SHAPES, and which one this is comes from the DECLARATION
    // (`window.__shellActionModes`), never from the DOM. ⚠ THE DOM ANSWER WAS
    // SELF-BLINDING AND IT WAS MEASURED: this branch used to ask the button
    // whether it carried `aria-pressed`, which `Button.svelte` emits only when
    // `momentary` — so deleting `momentary` from ModuleShell's action branch
    // turned the held pad into a one-shot AND deleted the check, and the whole
    // sweep reported 21 passed. Reading the module's own declaration keeps the
    // two sides of the contract independent. Registry-driven: the next
    // gate-mode cell auto-enrols with no edit here.
    // ── THE PROBE. ⚠ THIS BRANCH USED TO END `await btn.click(); return;` ──
    // It asserted the button existed and was ENABLED, then clicked it and
    // asserted NOTHING — the only cell kind in this sweep with no probe at all,
    // on the kind whose entire purpose is to DO something. A dead audition
    // passed the whole face green; karplus's dock PLUCK animated its press
    // flash on a string that was never plucked, and the sweep called it
    // operable. Every other branch here proves an observable effect, and a
    // PANEL has been required to DECLARE one since PF-14; an `action` is now
    // held to the same bar.
    //
    // An audition writes NOTHING to the graph on purpose
    // (manual-strike-actions.ts), so `readParam`/`readData` are structurally
    // blind to it. The observable is whether the seam RESOLVED a callable off
    // the live engine handle and called it — the boolean all three seams
    // already computed and every call site threw away.
    const probe = await readActionProbe(page, spec.type, cell.key);
    expect(
      probe,
      `${where}: declares no operability probe. Add one to its shell-cell spec ` +
        `(packages/web/src/lib/ui/workflow/shell-cells.ts) — the sweep will not ` +
        `special-case a module, and a press with no declared observable is ` +
        `indistinguishable from a dead one.`,
    ).toBeTruthy();

    const mode = await readActionMode(page, spec.type, cell.key);
    const before = lastSeq(await readAuditionLog(page));
    // ⚠ THE `data` SNAPSHOT IS TAKEN **HERE**, BEFORE THE PRESS — and it used to
    // be taken after it, which made that whole branch unable to pass.
    //
    // MEASURED on the branch that first adopted it (frametable's SAVE TABLE, the
    // first `data`-probe action cell in the tree; the shape had shipped in
    // PF-14 as "a future action cell" and never had one). `driveCell` clicked,
    // and only THEN read `beforeRaw`. Any handler that had already written by
    // the time that round-trip completed made before === after, so the poll
    // compared a value against itself and timed out on a press that had worked
    // perfectly:
    //
    //   Expected: not "{\"seq\":1,\"ok\":false,\"error\":\"ring not ready\"}"
    //   Timeout 5000ms exceeded while waiting on the predicate
    //
    // The `audition` branch two lines up never had the bug because `before` was
    // always captured pre-click; this is the same discipline, applied to the
    // sibling oracle. ⚠ Note the FAILURE DIRECTION: a never-adopted branch fails
    // CLOSED here (a working cell reads as broken) rather than open, which is
    // the lucky half — the same latency would silently PASS a `data-rev` probe
    // whose counter had been bumped before the snapshot.
    const dataKey = probe!.effect.kind === 'audition' ? null : probe!.effect.key;
    const beforeRaw = dataKey === null ? null : await readData(page, nodeId, dataKey);

    if (mode === 'gate') {
      // A declared HELD action MUST render as a momentary pad. This is the
      // clause the DOM sniff could not have.
      await expect(
        btn,
        `${where}: declared mode:'gate' but the shell did not render a MOMENTARY pad ` +
          `(no aria-pressed) — a held action driven as a one-shot opens and never closes`,
      ).toHaveAttribute('aria-pressed', 'false');
      const { cx: btnCx, cy: btnCy } = await centreOf(btn);
      await page.mouse.move(btnCx, btnCy);
      await page.mouse.down();
      await expect(btn, `${where}: press drives the HELD action pad high`).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      // ⚠ ASSERTED ON THE OPEN EDGE, BEFORE THE RELEASE. A held audition that
      // never opened and a held audition that opened-and-closed both end with
      // `aria-pressed="false"`, so an end-state-only check cannot tell them
      // apart. Both edges are proven, separately.
      await expect
        .poll(async () => delivered(await readAuditionLog(page), nodeId, 'manual-gate', before, true), {
          message: `${where}: the PRESS reached the held audition seam and delivered`,
        })
        .toBe(true);

      await page.mouse.up();
      await expect(
        btn,
        `${where}: release RETURNS the held pad to rest — a gate action must not latch`,
      ).toHaveAttribute('aria-pressed', 'false');
      const gLog = await readAuditionLog(page);
      expect(
        delivered(gLog, nodeId, 'manual-gate', before, false),
        `${where}: the RELEASE reached the seam and CLOSED the gate — a roll that opens and ` +
          `never closes is the worst failure this seam has. Ledger since press: ${dumpLog(gLog, before)}`,
      ).toBe(true);
      return;
    }

    await btn.click();

    if (probe!.effect.kind === 'audition') {
      const seam = probe!.effect.seam;
      await expect
        .poll(async () => delivered(await readAuditionLog(page), nodeId, seam, before), {
          message:
            `${where}: the press reached the '${seam}' seam and DELIVERED. A false here means ` +
            `the button ran its handler and the engine handle answered nothing — the audition ` +
            `is dead while the control looks perfectly alive.`,
        })
        .toBe(true);
      return;
    }

    // An action cell that edits node.data instead of firing a seam. `beforeRaw`
    // was captured BEFORE the click — see the note at the snapshot.
    const key = probe!.effect.key;
    if (probe!.effect.kind === 'data-rev') {
      await expect
        .poll(async () => Number(await readData(page, nodeId, key)) || 0, {
          message: `${where}: the press advances '${key}'`,
        })
        .toBeGreaterThan(Number(beforeRaw) || 0);
    } else {
      const snap = JSON.stringify(beforeRaw);
      await expect
        .poll(async () => JSON.stringify(await readData(page, nodeId, key)), {
          message: `${where}: the press CHANGES node.data['${key}']`,
        })
        .not.toBe(snap);
    }
    return;
  }

  if (cell.control === 'file') {
    // A real <input type="file"> wired to a real import action: feed it a
    // file and assert the cell REPORTS a result (status or error). Either
    // way the action RAN — which is what "not inert" means here. (The
    // content-level import behaviour is covered by dx7-syx-load.spec.ts.)
    const input = host.locator('input[type="file"]');
    await expect(input, `${where}: a real file input`).toBeAttached();
    await expect(input, `${where}: declares an accept filter`).not.toHaveAttribute('accept', '');
    await input.setInputFiles({
      name: 'probe.syx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(64, 0),
    });
    await expect(
      host.locator('[data-testid$="-status"]'),
      `${where}: the import action ran and reported back`,
    ).toBeVisible();
    return;
  }

  throw new Error(`${where}: unknown cell control kind — teach this gate how to drive it`);
}


// ── THE PARTITION (#2141) ───────────────────────────────────────────────────
//
// ⚠ WHY THIS FILE EXISTS AT ALL. This sweep is REGISTRY-DRIVEN — it enrolls
// every module in `STRICT_FACES` — so its cost grows with every face that
// merges, and it had grown into the single most expensive file in the e2e
// suite. MEASURED on ci.yml run 32625571916: 2303.2 CPU-s against a 2088 s fair
// share at 10 shards, i.e. ONE spec file exceeding a whole shard's share, which
// makes a balanced partition arithmetically impossible and reddened
// `e2e-shard-plan`'s balance assertion at 1.1546 against its 1.15 threshold.
//
// ⚠ AND THE SECOND MOTIVATION IS THE INSTRUMENT, not just the size. The cost
// artifact is a SINGLE-RUN sample of a load-dependent quantity, and this file's
// samples swung 2310.9 -> 1561.4 -> 2303.2 CPU-s across three consecutive runs —
// about 32% run to run. So whether the balance assertion passed depended on
// WHICH RUN was last accepted, which is not a property a gate should have. A
// file small enough that its swing cannot dominate a shard removes that
// dependence rather than tuning around it.
//
// THE SPLIT KEEPS THREE PROPERTIES, and each one rules out an alternative:
//
//   AUTO-ENROLLMENT   every partition derives its own set from `STRICT_FACES`
//                     here, so a newly promoted face lands in exactly one
//                     partition with nothing to edit. A hand-written list per
//                     file would let a face escape the sweep silently, which is
//                     the one failure this sweep must never have.
//   STABLE IDENTITY   a module's partition is a function of ITS OWN NAME, so it
//                     never migrates between files as the roster grows and its
//                     cost stays attributable to one file forever. ⚠ This is
//                     what rules out the obvious alternative of splitting BY
//                     DOMAIN or by an index into the sorted roster: both
//                     reshuffle every membership whenever a face is added, so
//                     every file's measured cost becomes a measurement of a
//                     different population than the one it will run next time.
//   ROW NAMES         the test title is unchanged, so every report line and
//                     every per-test timing row keeps the name it has today.
//
// The partition count is DERIVED, not chosen: at the WORST measured cost above,
// N = 4 puts each file at ~576 CPU-s = 0.27x a fair share, leaving room for the
// roster to nearly quadruple before any single file approaches the limit again.
// The roster is at 131 of 198 registered modules, so it can still grow by half
// just by finishing the migration.

/** FNV-1a, 32-bit. A stable, dependency-free string hash — the same input gives
 *  the same partition on every machine and every run, forever. */
function hashType(type: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < type.length; i++) {
    h ^= type.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** How many spec files this sweep is split across. */
export const FACES_PARITY_PARTITIONS = 4;

/** Which partition a module belongs to — a function of its OWN name only. */
export function facesParityPartitionOf(type: string, partitions: number = FACES_PARITY_PARTITIONS): number {
  return hashType(type) % partitions;
}

/** The modules one partition owns, sorted — derived from STRICT_FACES, never listed. */
export function facesParityTypesFor(partition: number, partitions: number = FACES_PARITY_PARTITIONS): string[] {
  return [...STRICT_FACES].sort().filter((t) => facesParityPartitionOf(t, partitions) === partition);
}

/** Register ONE partition's per-module parity rows. */
export function registerFacesParityTests(partition: number, partitions: number = FACES_PARITY_PARTITIONS): void {
  test.describe(`faces render-parity (partition ${partition + 1}/${partitions}): every STRICT_FACES dock full-view carries the def's FULL control surface`, () => {
  for (const type of facesParityTypesFor(partition, partitions)) {
    test(`${type}: dock control set === def param set (+families, no extras) and EVERY cell operates`, async ({ page }) => {
      // Stage 1 of the derived budget (see FACE_FIXED_MS): covers boot + spawn
      // + dock open + the parity reads, i.e. everything before the cell count
      // is even knowable.
      test.setTimeout(FACE_FIXED_MS);
      // The type is passed so a face that DECLARES a quiesce gets it installed
      // before boot. The sweep names no module: it hands over the type it is
      // already iterating and the roster decides (deny-by-default).
      await gotoShell(page, type);
      await spawnPatch(page, [{ id: 'm', type, position: { x: 460, y: 240 } }]);

      const spec = await readSpec(page, type);
      // The imported STRICT_FACES set and the live registry agree this module
      // is migrated (guards a stale import path / set drift).
      expect(spec.strictFace, `${type}: __moduleSpecs agrees it is STRICT_FACES-migrated`).toBe(true);

      // A band-focused face renders only ONE band at its default value, so the
      // multiset equality below is only the intended behaviour in its declared
      // show-all state. No-op on every other face.
      await showAllBands(page, 'm', spec);

      const dockShell = await openDock(page, 'm');

      // ── 1. PARAM PARITY: exact id-multiset equality, DOM vs live def. ──
      // ⚠ A CONTROL MAY COVER MORE THAN ONE PARAM. The `control-<paramId>`
      // convention assumes one element per param, which is true of every 1-D
      // primitive and FALSE of a 2-D pad: `XyPad` is one element driving two.
      // Reading only the testid would report both axes as MISSING — a faced pad
      // would look like two lost controls.
      //
      // So an element may DECLARE the full set it covers in
      // `data-control-params`, and this reads that when present. Exact multiset
      // equality is unchanged; what changes is that the identity now generalises
      // to any N-to-1 control instead of being wired to the 1:1 case.
      const domIds = (
        await dockShell.locator('[data-testid^="control-"]').evaluateAll((els) =>
          // RAW attributes only — the rule that interprets them is
          // `idsCoveredBy`, in Node, so `xy-pad-cell.spec.ts` can drive the SAME
          // function against a real pad. See support/cell-coverage.ts.
          els.map((el) => ({
            testid: el.getAttribute('data-testid'),
            covered: el.getAttribute('data-control-params'),
          })),
        )
      ).flatMap(idsCoveredBy);
      // #1726 — a param the def DECLARES has no user control is not a lost
      // control; it is a control that must not exist. So the identity is taken
      // over the params that DO owe a cell, and the declared ones are asserted
      // ABSENT immediately below rather than dropped from the subject — an
      // exclusion with no matching assertion is how a suppression mechanism
      // turns into a hiding place.
      const noControl = new Set(spec.noUserControl ?? []);
      const defIds = spec.params.map((p) => p.id).filter((id) => !noControl.has(id));
      expect(
        [...domIds].sort(),
        `${type}: dock full-view renders EXACTLY one interactive control per def param ` +
          `(missing = a lost control, duplicate/unknown = an unbacked extra)`,
      ).toEqual([...defIds].sort());

      // The inverted half: ZERO cells for a declared param. This is what makes
      // the declaration a claim about the RENDERER rather than a gate exemption
      // — it can fail, and it fails loudly, in the direction a mis-declaration
      // would actually break.
      expect(
        [...domIds].filter((id) => noControl.has(id)),
        `${type}: param(s) declared noUserControl still rendered an interactive cell ` +
          `— the declaration says a player never sets them`,
      ).toEqual([]);

      // ── 2. FAMILY CELLS, no dead statics, and NO INERT CELLS. ──
      await expect(
        dockShell.locator('[data-cell-kind="family"]'),
        `${type}: one rendered cell per declared control family`,
      ).toHaveCount(spec.controlFamilies?.length ?? 0);
      await expect(
        dockShell.locator('[data-cell-kind="static"]'),
        `${type}: no dead static cells — every rendered control is def-backed`,
      ).toHaveCount(0);
      const inert = await dockShell.locator('[data-cell-inert]').evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-cell-key') ?? '?'),
      );
      expect(
        inert,
        `${type}: INERT cell(s) — a curated control rendered as a dead label. Register a ` +
          `shell-cell spec (packages/web/src/lib/ui/workflow/shell-cells.ts).`,
      ).toEqual([]);

      // ── 3. PER-CELL OPERABILITY: drive every cell, not one sampled knob. ──
      const cells = await renderedCells(dockShell);
      // ⚠ THE INVARIANT IS PARAMS COVERED, NOT CELLS RENDERED. It used to read
      // `cells.length === params + families`, which silently assumes every cell
      // renders exactly ONE param — true of every 1-D primitive and false the
      // moment a control binds two (a 2-D pad). Under the old identity a face
      // with one pad was one cell SHORT and went red for a control that was
      // working perfectly. Counting coverage instead is the general form: the
      // next N-to-1 control needs no edit here.
      const paramCells = cells.filter((c) => c.kind === 'param');
      const covered = cells.reduce((n, c) => n + paramsCoveredByCell(c.kind, c.covered), 0);
      expect(
        covered,
        `${type}: the dock's param cells cover EVERY def param exactly once ` +
          `(${paramCells.length} param cells covering ${covered} of ${defIds.length} params)`,
      ).toBe(defIds.length);
      expect(
        cells.length,
        `${type}: no cell beyond the param cells and the declared control families`,
      ).toBe(paramCells.length + (spec.controlFamilies?.length ?? 0));
      const keys = cells.map((c) => c.key);
      expect(new Set(keys).size, `${type}: every rendered cell carries a UNIQUE data-cell-key`).toBe(keys.length);

      // Stage 2: now that the face's REAL size is known, extend the ceiling by
      // its own cell count (Playwright counts a re-`setTimeout` from the test's
      // start, so this SUPERSEDES stage 1 rather than stacking on it). The
      // per-cell loop below is the whole cost — a 46-cell reverb gets ~7× the
      // driving budget of a 2-cell VCA because it does ~7× the driving.
      test.setTimeout(FACE_FIXED_MS + FACE_PER_CELL_MS * cells.length);

      // ONE cursor per face — see openTabFor. It turns a per-cell pair of
      // protocol round-trips into a per-TRANSITION one, which is the shape the
      // work actually has.
      const tabs = newTabCursor();
      for (const cell of cells) {
        // ⚠ RE-ASSERTED PER CELL, and the reason is a real interaction rather
        // than caution: on a band-focused face the FOCUS PARAM IS ITSELF A CELL.
        // Driving it (the sweep sets every control) re-focuses the plate
        // mid-walk, and every band the new value hides takes its cells with it —
        // so the next `driveCell` looks for a control that is no longer mounted
        // and reports it as a LOST control. Restoring show-all before each drive
        // makes the walk independent of the order it happens to visit cells in.
        // No-op on every face without the feature.
        await showAllBands(page, 'm', spec);
        await openTabFor(page, cell, tabs);
        await driveCell(page, dockShell, 'm', spec, cell);
      }

      // ── 4. BAND FOCUS: the feature must actually HIDE something. ──
      //
      // ⚠ THE COMPANION TO `showAllBands`, AND NEITHER LEG MEANS ANYTHING
      // ALONE. Everything above ran in the declared show-all state, so it proves
      // every control is reachable — and it would pass identically against a
      // face that declared `bandFocus` and then ignored it. This drives a
      // FOCUSED value and asserts the other bands are genuinely gone from the
      // DOM, which is the half that can only pass if the declaration is wired.
      //
      // Registry-driven and skip-free: a face without the feature simply has no
      // `bandFocus` to read, so this costs it nothing and reports no skip — a
      // skipped row would read as coverage it does not have.
      if (spec.bandFocus) {
        const focus = spec.bandFocus;
        const entries = Object.entries(focus.bands);
        expect(
          entries.length,
          `${type}: declares bandFocus with NO bands — a face that hides nothing`,
        ).toBeGreaterThan(0);

        const [focusedBand, values] = entries[0]!;
        const otherBands = entries.slice(1).map(([b]) => b);
        expect(
          values.length,
          `${type}: band '${focusedBand}' is revealed by no value, so it is unreachable`,
        ).toBeGreaterThan(0);

        await page.evaluate(
          ({ id, param, v }) => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
              __ydoc: { transact: (fn: () => void) => void };
            };
            w.__ydoc.transact(() => {
              const n = w.__patch.nodes[id];
              if (n) n.params[param] = v;
            });
          },
          { id: 'm', param: focus.param, v: values[0]! },
        );

        // The focused band stays…
        await expect(
          dockShell.locator(`[data-face-page="${focusedBand}"]`),
          `${type}: focusing '${focusedBand}' must keep its own band on the plate`,
        ).toBeVisible();

        // …and every other declared band goes. ⚠ Asserted ABSENT rather than
        // hidden: the point of the feature is reclaimed space, and a band left
        // in the DOM with `visibility: hidden` would still hold its row.
        for (const other of otherBands) {
          await expect(
            dockShell.locator(`[data-face-page="${other}"]`),
            `${type}: '${other}' must be GONE while '${focusedBand}' is focused — the whole ` +
              `point is that the picture and the controls steering it share the plate`,
          ).toHaveCount(0);
        }

        // NON-VACUITY: prove the two states actually DIFFER, so a face whose
        // bands were absent for some unrelated reason cannot pass this.
        expect(
          otherBands.length,
          `${type}: only one band declared, so "the others are hidden" asserts nothing`,
        ).toBeGreaterThan(0);
      }
    });
  }
  });
}

/** The tests that must run EXACTLY ONCE, not once per partition. */
export function registerFacesParityOneOffs(): void {
  // ── THE PARTITION COVERAGE GATE ───────────────────────────────────────────
  //
  // ⚠ THE ONE THING THE SPLIT COULD BREAK THAT NOTHING ELSE WOULD NOTICE. Before
  // it, "is every faced module swept?" was true by construction — one file, one
  // loop over `STRICT_FACES`. Afterwards it is a property of the partition
  // function, and the failure mode is SILENT: a face that lands in no partition
  // is not reported as skipped, it simply has no test, and every lane stays
  // green. That is strictly worse than a red, so it is asserted here rather than
  // reasoned about.
  //
  // Asserted in BOTH directions, because each alone is blind:
  //   * the union of the partitions must EQUAL the roster — a face in no
  //     partition escapes the sweep entirely;
  //   * the partitions must be DISJOINT — a face in two partitions is a module
  //     paying twice, which reads as a cost regression nobody can attribute.
  //
  // Both are derived from `STRICT_FACES` itself, so this cannot rot into a
  // hand-maintained list of who-is-where.
  test.describe('faces parity partitions cover the roster exactly', () => {
    test('every STRICT_FACES module lands in exactly ONE partition', () => {
      const roster = [...STRICT_FACES].sort();
      const buckets = Array.from({ length: FACES_PARITY_PARTITIONS }, (_, k) =>
        facesParityTypesFor(k, FACES_PARITY_PARTITIONS));
      const flat = buckets.flat();

      // Non-vacuity FIRST: an empty roster would satisfy both directions below.
      expect(roster.length, 'STRICT_FACES is empty — this gate would pass vacuously').toBeGreaterThan(0);

      expect(
        [...flat].sort(),
        'the partitions do not reconstruct STRICT_FACES — a faced module is either in NO partition ' +
          '(it has silently stopped being swept, with no skip reported anywhere) or in TWO',
      ).toEqual(roster);

      expect(
        flat.length,
        'a module appears in more than one partition — it pays twice and its cost is unattributable',
      ).toBe(new Set(flat).size);

      // ⚠ AND THE PARTITION MUST ACTUALLY PARTITION. A function returning the
      // whole roster for every k would satisfy neither check above, but one
      // returning everything for k=0 and nothing for the rest would satisfy the
      // union — while putting the entire sweep back in one file and quietly
      // undoing the split. Every partition therefore has to be non-empty.
      buckets.forEach((b, k) => {
        expect(
          b.length,
          `partition ${k + 1}/${FACES_PARITY_PARTITIONS} is EMPTY — the split has collapsed back ` +
            'toward one file and the balance argument no longer holds',
        ).toBeGreaterThan(0);
      });
    });

    test('a module\'s partition depends only on its OWN name (stable under roster growth)', () => {
      // ⚠ THE PROPERTY THAT MAKES COSTS ATTRIBUTABLE, and the one a by-index or
      // by-domain split would fail. If membership depended on the roster, every
      // promotion would reshuffle every file and each file's measured cost would
      // describe a population it will never run again. Proven by asking the
      // partition function about names that are NOT in the roster at all: it
      // must still answer, and answer the same way, because it never consults
      // the roster.
      const probe = 'zzz-not-a-real-module';
      const a = facesParityPartitionOf(probe);
      const b = facesParityPartitionOf(probe);
      expect(a, 'the partition function is not deterministic').toBe(b);
      expect(a, 'a partition index must be in range').toBeGreaterThanOrEqual(0);
      expect(a, 'a partition index must be in range').toBeLessThan(FACES_PARITY_PARTITIONS);

      // NEGATIVE CONTROL: different names must not all collapse to one bucket —
      // a hash that returned a constant would pass every assertion above while
      // putting the whole roster in one file.
      const spread = new Set(
        ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
          .map((n) => facesParityPartitionOf(n)),
      );
      expect(
        spread.size,
        'the partition function maps distinct names to a single bucket — it is not partitioning',
      ).toBeGreaterThan(1);
    });
  });

  test.describe('faces render-parity: every STRICT_FACES dock full-view carries the def’s FULL control surface', () => {
  // ⚠ ANCHORED TO THE ARTIFACT, BOTH DIRECTIONS. A quiesce makes a row cheaper,
  // which is exactly the kind of knob that rots into a blanket opt-out if
  // nothing watches it. Two properties keep it honest, and neither names a
  // module: every entry must name a module this sweep actually drives (a face
  // that was renamed or un-promoted cannot leave a silent entry behind), and
  // the `why` must be substantive rather than a placeholder. The REQUIRED `why`
  // on the type is the third leg — `tsc` refuses an entry without one before
  // this test ever runs.
  test('every FACE_QUIESCE entry names a live STRICT_FACES module AND a global that module READS', () => {
    const stale = Object.keys(FACE_QUIESCE).filter((t) => !STRICT_FACES.has(t));
    expect(
      stale,
      'FACE_QUIESCE names a module this sweep does not drive — delete the entry or restore the face',
    ).toEqual([]);
    for (const [type, q] of Object.entries(FACE_QUIESCE)) {
      expect(q.global, `${type}: quiesce global looks like a page hook`).toMatch(/^__\w+$/);
      expect(
        q.why.length,
        `${type}: a quiesce must say what it stops AND what it leaves alone`,
      ).toBeGreaterThan(200);
      // ⚠ ANCHOR THE GLOBAL TO THE MODULE THAT READS IT, and this clause exists
      // because its absence was MEASURED as a vacuous gate. The runtime check in
      // `gotoShell` reads the flag back off the page — which is a TAUTOLOGY:
      // `addInitScript` sets the name, so reading the same name returns it
      // whatever the name is. Renaming this entry's global to a deliberate
      // nonsense string left that check GREEN while the row silently ran
      // unquiesced (and took 1.0 min instead of 45 s, so only the clock knew).
      // A quiesce whose global no module reads is a no-op wearing a
      // declaration, so the name is checked against the SOURCE.
      const src = moduleSourceFor(type);
      expect(src, `${type}: no module source found to anchor the quiesce against`).toBeTruthy();
      expect(
        src,
        `${type}: nothing in the module reads ${q.global} — the quiesce is a no-op`,
      ).toContain(q.global);
    }
  });
  });

test.describe('tidyVco tune-cluster regression (the owner control-loss report)', () => {
  test('the tune cluster (detune + oct2) renders in the LANE full face AND the dock oscillator band', async ({ page }) => {
    // Same boot + spawn + dock-open fixed cost as a face row (it drives no
    // cells, so it needs no per-cell term).
    test.setTimeout(FACE_FIXED_MS);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }]);

    const shell = page.locator('.svelte-flow__node[data-id="tv"] [data-testid="module-shell"]');
    await expect(shell).toBeVisible();
    // The spawn reveal parks the zoom at 0.6 — the LOD 'full' band: the
    // richest IN-LANE face. The redesign must keep the tuning controls
    // visible here (the loss: detune ranked below the 6-cell plate cap and
    // oct2 outside the top-8 left the lane with ZERO tuning controls).
    await expect(shell).toHaveAttribute('data-shell-tier', 'full');
    await expect(shell.locator('[data-testid="control-detune"]'), 'lane full face: FINE (detune ¢)').toBeVisible();
    await expect(shell.locator('[data-testid="control-oct2"]'), 'lane full face: TUNE (oct2)').toBeVisible();

    // And the dock full-view keeps them in the OSCILLATOR section band (the
    // gallery-mock tune cluster placement).
    const dockShell = await openDock(page, 'tv');
    const oscBand = dockShell.locator('[data-face-page="oscillator"]');
    await expect(oscBand.locator('[data-testid="control-detune"]'), 'dock oscillator band: detune').toBeVisible();
    await expect(oscBand.locator('[data-testid="control-oct2"]'), 'dock oscillator band: oct2').toBeVisible();
  });
});

test.describe('param vocabulary: a NAMED discrete param reads as its name at BOTH tiers', () => {
  // PF-1's two halves are different primitives answering the SAME question, so
  // the only assertion worth making spans both: the dock lays the states out
  // as a row, the lane keeps the dial (a 46 px knob column cannot hold a row)
  // and paints a readout NAMING the state instead — and they must NAME THE SAME
  // STATE. A per-tier test would pass while the two disagreed, which is the
  // failure a player actually notices when they zoom out.
  //
  // filter.mode is the case: three parallel two-pole sections, `curve:
  // 'discrete'`, and the one control that decides whether CUTOFF sounds dark,
  // thin or narrow. Pre-PF-1 it rendered as a rotary printing "0.00".
  //
  // ⚠ THIS PAIR SURVIVED THE 2026-08-17 READOUT REMOVAL UNCHANGED, and it is
  // worth saying why rather than leaving the reader to check. The owner removed
  // the resting NUMBER from every face, not the resting NAME (`paintsReadout`:
  // a bare `options`/`landmarks` roster and no declared `format`). filter's two
  // params here are exactly the two ends of that predicate — `mode` declares a
  // bare roster and still paints, `cutoff` declares nothing at all and still
  // does not — so both assertions mean today what they meant when they were
  // written. ⚠ What CHANGED is the predicate behind the second one: "no
  // declared vocabulary ⇒ no readout" is now strictly weaker than the rule,
  // because a param declaring a `format` would ALSO paint nothing. If cutoff is
  // ever given a formatter, this leg stops discriminating and the contrast has
  // to move to `aria-valuetext`, where the vocabulary still resolves.
  test('filter.mode: Segmented in the dock, dial + painted NAME in the lane, same state', async ({ page }) => {
    test.setTimeout(FACE_FIXED_MS);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'f', type: 'filter', position: { x: 460, y: 240 } }]);

    // ── LANE (the spawn reveal parks zoom at 0.6 = LOD 'full', the richest
    //    in-lane face; filter's 5 ranked controls all fit the 6-cell plate). ──
    const shell = page.locator('.svelte-flow__node[data-id="f"] [data-testid="module-shell"]');
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-shell-tier', 'full');
    const laneCell = shell.locator('[data-cell-key="mode"]');
    await expect(laneCell, 'lane: mode keeps the DIAL — a lane column has no room for a row')
      .toHaveAttribute('data-cell-control', 'knob');
    const laneReadout = laneCell.locator('[data-testid="readout-mode"]');
    await expect(laneReadout, 'lane: the dial PAINTS a readout naming the state').toBeVisible();
    await expect(laneReadout).toHaveText('LP');
    // …and speaks it too, off the same resolver. One value, two audiences — the
    // split that let every `format`-only face keep its assertions when the
    // painted line went away.
    await expect(laneCell.locator('[data-testid="control-mode"]')).toHaveAttribute(
      'aria-valuetext',
      'LP',
    );
    // DETENT TICKS: a declared roster also marks the arc, so the dial SHOWS it
    // has three resting positions rather than reading as a continuous sweep.
    // This is the same renderer PF-10's landmarks use, so exercising it here
    // keeps that path out of the "unreached until Batch B" bucket.
    await expect(
      laneCell.locator('[data-testid="control-mode"] .tick'),
      'lane: one detent tick per declared state',
    ).toHaveCount(3);

    // A knob with NO declared vocabulary must stay exactly as it was — no
    // readout, no ticks. This is PF-3's gate asserted in the DOM, and it is
    // the reason ~17 dock faceplates did not move.
    const cutoffCell = shell.locator('[data-cell-key="cutoff"]');
    await expect(cutoffCell, 'a plain param is still a dial').toHaveAttribute('data-cell-control', 'knob');
    await expect(
      cutoffCell.locator('[data-testid="readout-cutoff"]'),
      'a param with no declared vocabulary paints NO readout',
    ).toHaveCount(0);
    // …and falls back to the raw ladder when asked what it is worth. This is
    // what stops the line above from being satisfied by a face that lost its
    // vocabulary resolution entirely: both cells would then paint nothing, and
    // only this assertion would tell them apart from `mode`'s `LP`.
    await expect(cutoffCell.locator('[data-testid="control-cutoff"]')).toHaveAttribute(
      'aria-valuetext',
      /^\d/,
    );
    await expect(
      cutoffCell.locator('.tick'),
      'a param with no declared vocabulary renders NO detent ticks',
    ).toHaveCount(0);

    // ── DOCK: the same param, laid out as its three named states. ──
    const dockShell = await openDock(page, 'f');
    const dockCell = dockShell.locator('[data-cell-key="mode"]');
    await expect(dockCell, 'dock: mode becomes a named-state ROW').toHaveAttribute(
      'data-cell-control',
      'segmented',
    );
    const segs = dockCell.locator('[data-testid="control-mode"] [role="radio"]');
    await expect(segs, 'dock: one button per declared option').toHaveCount(3);
    await expect(segs, 'dock: the states are NAMED, not numbered').toHaveText(['LP', 'HP', 'BP']);
    await expect(segs.nth(0), 'dock: the default state is lit').toHaveAttribute('aria-checked', 'true');

    // ── AGREEMENT: pick BP in the dock; the lane dial must say BP too. ──
    await segs.nth(2).click();
    await expect
      .poll(() => readParam(page, 'f', 'mode'), { message: 'picking BP commits mode=2' })
      .toBe(2);
    await expect(segs.nth(2), 'dock: BP is now the lit state').toHaveAttribute('aria-checked', 'true');
    await expect(laneReadout, 'lane: the painted name follows the dock selection').toHaveText('BP');
  });
});

test.describe('dx7 hero controls are REACHABLE in the shell (the inert-cell P0)', () => {
  // The headline finding: dx7's PRESET selector — the one control that swaps
  // the whole sound — and its .syx cartridge import rendered as dashed text
  // under `?shell=1`, so the DX7's voice could not be changed. This pins the
  // fix at the level the user experiences it: pick a voice, the graph loads it.
  test('the dock PRESET cell actually loads a different voice into node.data', async ({ page }) => {
    // Same boot + spawn + dock-open fixed cost as a face row; the one selector
    // it drives is well inside the fixed term.
    test.setTimeout(FACE_FIXED_MS);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'dx', type: 'dx7', position: { x: 460, y: 240 } }]);
    const dockShell = await openDock(page, 'dx');

    const preset = dockShell.locator('[data-cell-key="dx7-preset-select-{n}"]');
    await expect(preset, 'the preset cell renders').toBeVisible();
    await expect(preset, 'and is NOT the old dead label').toHaveAttribute('data-cell-control', 'selector');

    // Read through the shared `readData` helper (the `readParam` twin the panel
    // branch uses) rather than a hand-rolled evaluate: node.data is where every
    // non-param control's state lives, and one reader keeps the path semantics
    // identical across the file.
    const before = await readData(page, 'dx', 'preset');

    await preset.locator('[role="button"][aria-haspopup="listbox"]').click();
    const options = page.locator('[role="listbox"] [role="option"]');
    await expect(options.first()).toBeVisible();
    // Pick the LAST built-in so the choice is unambiguous vs the default.
    const want = (await options.last().innerText()).trim();
    await options.last().click();

    await expect
      .poll(() => readData(page, 'dx', 'preset'), {
        message: 'choosing a voice writes node.data.preset (the factory polls it)',
      })
      .toBe(want);
    expect(want, 'and it is a DIFFERENT voice than before').not.toBe(before);
  });
});

test.describe('sixstrum PRESET is a RECALL, not a relabelled tuning switch', () => {
  // The sibling gap to dx7's: the batch-2 face carried the raw `tuning` param
  // (which only swaps the open-string set) but NOT the guitar/bass/harp PRESET
  // RECALL that the classic card's MODE knob fires — so the three calibrated
  // knob states were unreachable under `?shell=1`. The param survived the
  // redesign; the affordance did not.
  //
  // The generic per-cell sweep above already proves the cell is a real,
  // operable Selector. What it CANNOT tell apart is a recall from a renamed
  // tuning knob — both move `tuning`. So this pins the thing that makes it a
  // preset: picking BASS moves `tuning` AND the OTHER stamped params with it.
  // Then it twists one of them back, because a preset is a starting point, not
  // a lock (the classic card keeps every knob editable after a recall).
  test('picking BASS stamps the whole calibrated knob state, and the knobs stay editable', async ({ page }) => {
    test.setTimeout(FACE_FIXED_MS);
    await gotoShell(page);
    await spawnPatch(page, [{ id: 'ss', type: 'sixstrum', position: { x: 460, y: 240 } }]);
    const dockShell = await openDock(page, 'ss');

    const preset = dockShell.locator('[data-cell-key="sixstrum-preset-{n}"]');
    await expect(preset, 'the preset cell renders').toBeVisible();
    await expect(preset, 'and is a real Selector, not a dead label').toHaveAttribute(
      'data-cell-control',
      'selector',
    );

    // GUITAR is the default knob state (tuning 0 / register 0).
    const chip = preset.locator('[role="button"][aria-haspopup="listbox"]');
    await expect(chip.locator('.val'), 'starts on the default mode').toHaveText('guitar');

    await chip.click();
    const bass = page.locator('[role="listbox"] [role="option"]', { hasText: 'bass' });
    await expect(bass, 'the roster offers BASS').toBeVisible();
    await bass.click();
    await expect(chip.locator('.val'), 'the chip follows the recall').toHaveText('bass');

    // 1. the tuning it names…
    await expect
      .poll(() => readParam(page, 'ss', 'tuning'), {
        message: 'BASS recalls the bass string set (tuning → 1)',
      })
      .toBe(1);
    // 2. …AND the rest of the calibrated state. `register` is the sharpest
    //    witness (0 → −12: the bass sits an octave down), and `ring` proves it
    //    is the whole preset rather than a two-value special case.
    await expect
      .poll(() => readParam(page, 'ss', 'register'), {
        message: 'a RECALL, not a tuning switch: register moves with it (→ −12 st)',
      })
      .toBe(-12);
    await expect
      .poll(() => readParam(page, 'ss', 'ring'), {
        message: 'and the string ring too (→ 6 s, the bass long/dark decay)',
      })
      .toBe(6);

    // RECALL-THEN-EDIT: nothing is locked by the stamp. Twist RING and confirm
    // the edit commits over the recalled value.
    const spec = await readSpec(page, 'sixstrum');
    const ringDef = spec.params.find((p) => p.id === 'ring')!;
    const ringCell = dockShell.locator('[data-cell-key="ring"] [data-testid="control-ring"]');
    await dragKnob(page, ringCell, ringDef, 6);
    await expect
      .poll(() => readParam(page, 'ss', 'ring'), {
        message: 'a preset is a STARTING POINT: a knob still commits after the recall',
      })
      .not.toBe(6);
  });
});
}
