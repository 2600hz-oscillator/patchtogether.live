// e2e/tests/mixmstrs-face-console.spec.ts
//
// MIXMSTRS' FACE AS A CONSOLE (#1825) — the two owner asks, both of which are
// LOOK changes that no unit test can settle.
//
//   1. ONE COLUMN GRID. Channel N's fader, EQ knobs, comp macro, enable switch,
//      threshold, ratio and both sends sit at ONE x. Before this change each
//      band sized its own `max-content` columns from its own widest cell, so the
//      face carried three pitches (channels 51.72 / dynamics 62.00 / sends 50.00
//      CSS px) and by channel 8 the same channel's cells were 90.00 px apart.
//
//      ⚠ THE SUBJECT IS THE BANDS ON THE RULER, and `returns` is deliberately
//      not one of them: #1805 gave it `clusterFlow: 'row'` so return 1 and
//      return 2 sit side by side, and a console grid aligns clusters STACKED one
//      above the other. Membership is asserted in both directions below, so the
//      narrowing is a stated property rather than a filter that could quietly
//      swallow a band that fell off the ruler by accident.
//   2. CHANNEL N TAKES LANE N'S COLOUR. Owner, 2026-08-17: *"for mixmstrs only,
//      ch1-8 instead of neon blue, all controls should match the assigned color
//      of its lane."*
//
// ⚠ WHY EACH LEG NEEDS A BROWSER. `consoleGridCols` / `faceConsoleGridCols` are
// pure and already unit-tested; what they CANNOT see is whether three levels of
// CSS `subgrid` actually resolve to one ruler. `face.channelAccent` is a list of
// param ids that says nothing about whether a colour reaches a control. Both
// verdicts here are read off the LIVE DOM: `getBoundingClientRect` for the
// grid, the RESOLVED `--_ka` custom property for the colour.
//
// ⚠ UNITS: CSS px throughout. The dock full view is an absolutely-positioned
// sibling of `.svelte-flow__viewport`, NOT inside xyflow's zoom transform, so
// these numbers need no zoom division (the `_shell-faces` fold geometry makes
// the same argument about the same element).
//
// ⚠ THE INSTRUMENT IS VALIDATED IN BOTH DIRECTIONS, permanently:
//   * the grid leg asserts the cells have GENUINELY DIFFERENT intrinsic widths
//     while their column centres coincide — otherwise "aligned" would be free
//     and this would pass on a face where every control is the same size;
//   * a second grid test asserts a face with ONE console band does NOT get the
//     ruler, so the probe attribute is not emitted unconditionally;
//   * the colour leg asserts the BUS-scoped controls (master, the returns, the
//     send PRE/POST switches) are STILL the domain accent — otherwise a bug
//     that repainted the whole faceplate one colour would read as a pass;
//   * the last leg CHANGES a lane colour and watches the open faceplate follow,
//     which is the only evidence the colours are live rather than a palette
//     baked at mount.
//
// ⚠ WHAT IS NOT COVERED HERE, and why. The declared NO-LANE FALLBACK ("a rack
// with no clip player keeps the domain accent") is asserted in
// `lane-colors.test.ts`, not here: the workflow rack ALWAYS carries a
// `pinned-clipplayer` (the column reconciler creates it), so the condition is
// unreachable through any gesture on `/rack` — measured 2026-08-17, the rack
// reports exactly one clip player with no module spawning one.
//
// AUDIO-AVAILABILITY: none needed — layout and CSS only, no analyser, no WebGL.

import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

const MM = 'mm';

/**
 * Column centres agree to this many CSS px.
 *
 * NOT a fudge for layout slop: the tracks are shared by construction, and the
 * only residue is HALF-PIXEL ROUNDING of a cell whose own width is fractional
 * (the `threshold` knob renders 47.67 px inside a 52 px track, so its centre
 * reports 110.99 where an integer-width sibling reports 111.00). Anything above
 * this is a different ruler, not a rounding.
 */
const COL_EPS_PX = 0.5;

interface Cell {
  key: string;
  control: string;
  cx: number;
  w: number;
}
interface Cluster {
  band: string;
  cluster: string;
  /** Is this cluster's BAND subgridded onto the face-wide ruler? */
  onRuler: boolean;
  cells: Cell[];
}

/** Two rAFs in the page — a content swap lands and paints. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** The workflow rack, with `nodes` spawned and `openId`'s dock full view open. */
async function bootDock(
  page: Page,
  nodes: { id: string; type: string; position: { x: number; y: number } }[],
  openId: string,
): Promise<void> {
  // NOT the shared `rack` fixture — this file owns its own boot so the dock
  // open below is deterministic.
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await spawnPatch(page, nodes);
  const shell = page.locator(`.svelte-flow__node[data-id="${openId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  await expect(
    faceplate.locator('[data-testid="module-shell"][data-shell-tier="dock"]'),
  ).toBeVisible();
  // The bands must be laid out before anything is measured — this structural
  // assert doubles as the readiness gate.
  await expect(faceplate.locator('[data-testid="face-page"]').first()).toBeVisible();
  await settle(page);
}

/** Every cluster on the faceplate, with its cells' geometry. */
async function readClusters(page: Page): Promise<Cluster[]> {
  return page.evaluate(() => {
    const out: {
      band: string;
      cluster: string;
      onRuler: boolean;
      cells: { key: string; control: string; cx: number; w: number }[];
    }[] = [];
    const root = document.querySelector('[data-testid="dock-full-view"]');
    if (!root) return out;
    for (const band of Array.from(root.querySelectorAll('[data-testid="face-page"]'))) {
      for (const c of Array.from(band.querySelectorAll('[data-testid="face-cluster"]'))) {
        const row = c.querySelector('.page-controls');
        if (!row) continue;
        out.push({
          band: band.getAttribute('data-face-page') ?? '?',
          cluster: c.getAttribute('data-face-cluster') ?? '?',
          onRuler: band.hasAttribute('data-face-ruler'),
          cells: Array.from(row.children).map((el) => {
            const r = el.getBoundingClientRect();
            return {
              key: (el as HTMLElement).dataset.cellKey ?? '?',
              control: (el as HTMLElement).dataset.cellControl ?? '?',
              cx: +(r.x + r.width / 2).toFixed(2),
              w: +r.width.toFixed(2),
            };
          }),
        });
      }
    }
    return out;
  });
}

/**
 * The RESOLVED accent of one cell — the `--_ka` the neon primitives paint from,
 * read off the element that declares it (`.knob` / `.fader-wrap` /
 * `.toggle-ctl`), never off the cell's own inline property.
 *
 * ⚠ THAT DISTINCTION IS THE WHOLE POINT. Reading `--ka` on the `.kcol` would
 * only prove the shell WROTE something; `--_ka` is what the control RESOLVED
 * through `var(--ka, var(--domain, var(--accent)))`, so a primitive that
 * bypasses the chain (the #1812 class — `XyPad` handles, card-local chips)
 * reads as its own fallback here and the test fails, as it should.
 */
async function accentOf(page: Page, key: string): Promise<string> {
  return page.evaluate((k) => {
    const cell = document
      .querySelector('[data-testid="dock-full-view"]')
      ?.querySelector(`[data-cell-key="${k}"]`);
    if (!cell) return `MISSING:${k}`;
    const inner = cell.querySelector('.knob, .fader-wrap, .toggle-ctl') as HTMLElement | null;
    if (!inner) return `NO-PRIMITIVE:${k}`;
    return getComputedStyle(inner).getPropertyValue('--_ka').trim();
  }, key);
}

async function accentsOf(page: Page, keys: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = await accentOf(page, k);
  return out;
}

/** The faceplate's own domain accent — what every non-channel cell falls back to. */
async function domainAccent(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(
      document.querySelector('[data-testid="dock-full-view"] [data-testid="module-shell"]')!,
    )
      .getPropertyValue('--domain')
      .trim(),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · ONE COLUMN GRID
// ─────────────────────────────────────────────────────────────────────────────

test('every 8-wide row shares ONE column ruler — column N is channel N everywhere', async ({
  page,
  errorWatch,
}) => {
  void errorWatch;
  await bootDock(page, [{ id: MM, type: 'mixmstrs', position: { x: 460, y: 240 } }], MM);

  // The page declares a face-wide ruler at all. Without this, every clause below
  // could pass by coincidence on a face whose bands happened to agree.
  //
  // ⚠ SCOPED TO THE DOCK FULL VIEW — the same root `readClusters` already uses,
  // so this spec measures ONE face everywhere. It was `page.getByTestId(...)`
  // until 2026-08-24, when promoting `audioOut` put a second `face-pages` on
  // every page: its PINNED instance lives in the topbar 🎧 panel, and that panel
  // is always MOUNTED (open/close only toggles CSS, because AudioinCard owns the
  // live input stream). The bare locator became a strict-mode violation.
  const dock = page.getByTestId('dock-full-view');
  const declared = await dock.getByTestId('face-pages').getAttribute('data-face-console-cols');
  expect(declared, 'mixmstrs must render on a FACE-WIDE console ruler').not.toBeNull();
  const ruler = Number(declared);

  const all = await readClusters(page);
  expect(all.length, 'the faceplate must render clustered bands').toBeGreaterThan(0);

  // ── WHICH BANDS ARE ON THE RULER — ASSERTED, NOT ASSUMED ─────────────────
  //
  // ⚠ THE SUBJECT IS THE BANDS THAT SUBGRID ONTO THE PAGE, and after #1805 that
  // is no longer "all of them". `returns` declares `clusterFlow: 'row'` (owner:
  // *"return 1 and return 2 can sit next to each other"*), and `consoleGridCols`
  // refuses a side-by-side band outright: a console grid's whole product is that
  // column j of every cluster shares one centre, which requires the clusters to
  // sit one ABOVE the other. Placed side by side there is nothing to align, so
  // return 2's first fader legitimately sits where the channel ruler's column 5
  // is and must not be measured against it.
  //
  // So the filter below is a REAL narrowing of the subject, not a tolerance —
  // and it is spelled out as membership in BOTH directions so it cannot quietly
  // grow. A band silently leaving the ruler is exactly how this assertion would
  // go vacuous.
  const onRuler = [...new Set(all.filter((c) => c.onRuler).map((c) => c.band))].sort();
  const offRuler = [...new Set(all.filter((c) => !c.onRuler).map((c) => c.band))].sort();
  expect(onRuler, 'exactly these bands share the face-wide ruler').toEqual([
    'channels',
    'dynamics',
    'sends',
  ]);
  // ⚠ TWO BANDS ARE OFF THE RULER NOW, FOR DIFFERENT REASONS, and both are
  // deliberate. `returns` is side-by-side (`clusterFlow: 'row'`). `record` is
  // all SEGMENTED cells, which are far wider than knobs because their width is
  // set by their option labels: putting it on the shared ruler was measured and
  // took the face from ONE column pitch to FOUR (168.2 / 161.2 / 161.1 / 111.6
  // CSS px), which is the #1825 defect itself. A record row cannot share the
  // fader pitch without destroying it for the three bands that depend on it.
  expect(offRuler, 'and exactly these bands are laid out off the ruler instead').toEqual([
    'record',
    'returns',
  ]);
  // …and the off-ruler band really is the side-by-side one, read off the DOM
  // rather than inferred from its absence: a band that fell off the ruler for
  // some OTHER reason would satisfy the two clauses above and be a bug.
  // ⚠ SCOPED, LIKE ITS TWO SIBLINGS IN THIS FILE. This one is not red today and
  // the reason is luck rather than design: since 2026-08-24 the pinned audioOut
  // faceplate sits on every page in the always-mounted 🎧 panel, and it renders
  // NO `face-page` children only because its def declares a hero and no `pages`.
  // One band on that face and this `toHaveCount(1)` reads 2. A count assertion
  // whose safety depends on ANOTHER module's face content is not an assertion
  // about mixmstrs.
  const returnsBand = page
    .getByTestId('dock-full-view')
    .locator('[data-testid="face-page"][data-face-page="returns"]');
  await expect(returnsBand, 'the returns band must still render').toHaveCount(1);
  await expect(
    returnsBand,
    'returns is off the ruler because it is a CLUSTER ROW, not because it lost its clusters',
  ).toHaveClass(/cluster-row/);
  await expect(
    returnsBand,
    'a side-by-side band must not also claim a column ruler — two layout systems, one element',
  ).not.toHaveAttribute('data-console-cols', /.*/);

  const clusters = all.filter((c) => c.onRuler);
  expect(clusters.length, 'the ruler must carry clusters to measure').toBeGreaterThan(0);

  // A cluster wider than the ruler would be spanning tracks that do not exist.
  for (const c of clusters) {
    expect(
      c.cells.length,
      `${c.band}/${c.cluster} has ${c.cells.length} cells, ruler is ${ruler} columns`,
    ).toBeLessThanOrEqual(ruler);
  }

  // ── THE VERDICT: one x per column, across every band ──────────────────────
  const byColumn = new Map<number, { where: string; cx: number }[]>();
  for (const c of clusters) {
    c.cells.forEach((cell, i) => {
      const list = byColumn.get(i) ?? [];
      list.push({ where: `${c.band}/${c.cluster}:${cell.key}`, cx: cell.cx });
      byColumn.set(i, list);
    });
  }
  const offenders: string[] = [];
  for (const [i, seen] of byColumn) {
    const ref = seen[0]!;
    for (const s of seen) {
      if (Math.abs(s.cx - ref.cx) > COL_EPS_PX) {
        offenders.push(
          `column ${i + 1}: ${s.where} centre ${s.cx} CSS px vs ${ref.where} ${ref.cx} CSS px ` +
            `(Δ ${(s.cx - ref.cx).toFixed(2)} CSS px, tolerance ${COL_EPS_PX} CSS px)`,
        );
      }
    }
  }
  expect(
    offenders.join('\n'),
    'a column must have ONE centre across every band on the face-wide ruler',
  ).toBe('');

  // ── AND THE PITCH IS ONE NUMBER, not one per band ─────────────────────────
  const pitches = new Set<number>();
  for (const c of clusters) {
    for (let i = 1; i < c.cells.length; i++) {
      pitches.add(+(c.cells[i]!.cx - c.cells[i - 1]!.cx).toFixed(1));
    }
  }
  expect(
    [...pitches],
    'the console must have ONE column pitch in CSS px ' +
      '(it had three before #1825: 51.7 / 62.0 / 50.0)',
  ).toHaveLength(1);

  // ── POSITIVE CONTROL: the alignment is NOT free ───────────────────────────
  // If every cell were the same width the clauses above would hold on any
  // layout, including the broken one. Assert the face really does mix control
  // widths — a fader, a knob and a switch are three different sizes — so
  // "aligned" means the COLUMN owns the width and the control centres in it.
  const widths = new Set(clusters.flatMap((c) => c.cells.map((x) => x.w)));
  const controls = new Set(clusters.flatMap((c) => c.cells.map((x) => x.control)));
  expect(
    widths.size,
    `the alignment must be non-trivial — cells must have DIFFERENT intrinsic widths ` +
      `(saw ${[...widths].join(', ')} CSS px across controls ${[...controls].join(', ')})`,
  ).toBeGreaterThan(1);
  for (const kind of ['fader', 'knob', 'toggle']) {
    expect(controls, `a ${kind} must be on the ruler for the width mix to be real`).toContain(kind);
  }
});

test('NEGATIVE CONTROL: a face with ONE console band gets no face-wide ruler', async ({
  page,
  errorWatch,
}) => {
  void errorWatch;
  // The probe above reads `data-face-console-cols`. If the shell emitted it
  // unconditionally that read would prove nothing. tidyVco has exactly one
  // console band (`envelopes`), so it keeps the band-level ruler it has today
  // and MUST NOT carry the attribute — which is also the containment claim for
  // this change: no other face's layout moved.
  await bootDock(page, [{ id: 'tv', type: 'tidyVco', position: { x: 460, y: 240 } }], 'tv');
  // ⚠ THE SCOPE IS LOAD-BEARING ON THIS LEG SPECIFICALLY, more than on the
  // positive one above. Since 2026-08-24 a second `face-pages` exists on every
  // page — the PINNED audioOut faceplate in the always-mounted 🎧 topbar panel —
  // and it carries no `data-face-console-cols`. A bare locator is a strict-mode
  // violation today, but "fixing" it with `.first()` would have made this
  // NEGATIVE CONTROL pass against the PANEL instead of against tidyVco: green,
  // and no longer testing the thing it exists to test. Scoped to the dock full
  // view this spec opened, so the subject is unambiguous.
  await expect(
    page.getByTestId('dock-full-view').getByTestId('face-pages'),
  ).not.toHaveAttribute('data-face-console-cols', /.*/);
  // …and it really does have clustered bands, so the absence is a DECISION and
  // not "there was nothing to align".
  const clusters = await readClusters(page);
  expect(clusters.length, 'tidyVco must still render clusters').toBeGreaterThan(0);
  expect(
    clusters.filter((c) => c.onRuler),
    'and no band of a single-console-band face may claim the page ruler',
  ).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · CHANNEL N TAKES LANE N'S COLOUR
// ─────────────────────────────────────────────────────────────────────────────

test('ch1-8 render in their LANE colour, and the BUS controls do not', async ({
  page,
  errorWatch,
}) => {
  void errorWatch;
  await bootDock(page, [{ id: MM, type: 'mixmstrs', position: { x: 460, y: 240 } }], MM);

  // Read FIRST: the cross-check at the end opens a context menu, which dismisses
  // the faceplate.
  const domain = await domainAccent(page);
  expect(domain, 'the shell must define a domain accent to fall back to').not.toBe('');

  // The channels the FACE actually rendered — derived from the DOM, never a
  // typed count, so a ninth channel is covered the day it exists.
  const channels = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="dock-full-view"]')!;
    const ns = new Set<number>();
    for (const el of Array.from(root.querySelectorAll('[data-cell-key]'))) {
      const m = /^ch(\d+)_volume$/.exec((el as HTMLElement).dataset.cellKey ?? '');
      if (m) ns.add(Number(m[1]));
    }
    return [...ns].sort((a, b) => a - b);
  });
  expect(channels.length, 'the face must render channel strips').toBeGreaterThan(1);

  // ── ONE COLOUR PER COLUMN, ACROSS THREE DIFFERENT PRIMITIVES ──────────────
  // A fader, a knob and a switch resolve the accent by three different routes
  // (the inherited `--ka`; an explicit `accent` prop that SHADOWS it; and a
  // shared `.switch` that was OUTSIDE the chain entirely until #1825). Each of
  // those three was a real way for one row of the console to opt out silently,
  // so a column is only one colour if all three agree.
  const perChannel: string[] = [];
  for (const n of channels) {
    const trio = await accentsOf(page, [`ch${n}_volume`, `ch${n}_low`, `ch${n}_compEnable`]);
    const distinct = new Set(Object.values(trio));
    expect(
      [...distinct],
      `channel ${n}: fader / knob / switch must resolve ONE colour — got ${JSON.stringify(trio)}`,
    ).toHaveLength(1);
    perChannel.push([...distinct][0]!);
  }

  // ── ONE COLOUR PER CHANNEL — the point of colouring by channel ────────────
  expect(
    new Set(perChannel).size,
    `every channel must have its OWN colour — got ${perChannel.join(', ')}`,
  ).toBe(channels.length);

  // ── NEGATIVE CONTROL: the BUS controls keep the domain accent ─────────────
  // Permanent, and it is what separates "channel N is lane N" from "the whole
  // faceplate turned one colour". `ret1_volume` sits in COLUMN 1 of the returns
  // band and must NOT be channel 1's colour — it is the wet coming back from
  // send 1, not a channel. That is also why the mapping is a predicate over
  // param IDS rather than a column position.
  const bus = await accentsOf(page, ['master_volume', 'ret1_volume', 'send1Pre']);
  for (const [key, colour] of Object.entries(bus)) {
    expect(colour, `${key} is BUS-scoped and must keep the domain accent`).toBe(domain);
  }
  expect(perChannel, 'and no channel may resolve to the domain accent').not.toContain(domain);

  // ── AND THEY ARE THE RACK'S LANE COLOURS, cross-read off ANOTHER surface ──
  // The strongest available check that these are the LANE values and not a
  // palette this face invented: the node menu's "assign to channel" buttons
  // paint `--lane-color` from the same seam (`canonicalLaneColors`). Two
  // independent surfaces, one source of truth — if the face restated the
  // mapping, or resolved a different clip player, they would disagree here.
  //
  // ⚠ LAST, because opening the menu dismisses the faceplate.
  await page
    .locator(`.svelte-flow__node[data-id="${MM}"]`)
    .click({ button: 'right', position: { x: 8, y: 8 } });
  const trigger = page.getByTestId('ctx-assign-channel');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByTestId('ctx-assign-channel-0')).toBeVisible();
  const menuColors = await page.evaluate(
    (n) =>
      Array.from({ length: n }, (_, ch) => {
        const b = document.querySelector(`[data-testid="ctx-assign-channel-${ch}"]`);
        return b ? getComputedStyle(b).getPropertyValue('--lane-color').trim() : `MISSING:${ch}`;
      }),
    channels.length,
  );
  expect(menuColors, "the face's columns must be the rack's lane colours").toEqual(perChannel);
});

test('a lane colour the user picks re-tints that channel LIVE, and only that channel', async ({
  page,
  errorWatch,
}) => {
  void errorWatch;
  // ⚠ WHY THIS LEG EXISTS. Everything above would also pass if the face had
  // baked the default hue palette at mount. The owner's ask is that the console
  // "match the assigned color of its lane" — a colour the user can CHANGE — so
  // the property under test is that an OPEN faceplate follows the graph.
  await bootDock(page, [{ id: MM, type: 'mixmstrs', position: { x: 460, y: 240 } }], MM);

  const target = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string } | undefined> };
    };
    return Object.entries(w.__patch.nodes).find(([, n]) => n?.type === 'clipplayer')?.[0] ?? null;
  });
  expect(target, 'the workflow rack must carry a clip player to hold lane colours').not.toBeNull();

  const before = await accentsOf(page, ['ch1_low', 'ch1_volume', 'ch1_compEnable', 'ch2_low']);
  const PICKED = '#7b2ff7';
  expect(Object.values(before), 'the picked colour must differ from the resting one').not.toContain(
    PICKED,
  );
  expect(
    before.ch2_low,
    'the two channels must START on different colours or the isolation leg is vacuous',
  ).not.toBe(before.ch1_low);

  // How many lanes the array must carry — read off the rack, never typed.
  const lanes = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="dock-full-view"]')!;
    const ns = new Set<string>();
    for (const el of Array.from(root.querySelectorAll('[data-cell-key]'))) {
      const m = /^ch(\d+)_volume$/.exec((el as HTMLElement).dataset.cellKey ?? '');
      if (m) ns.add(m[1]!);
    }
    return ns.size;
  });

  // ⚠ THE CARD'S OWN WRITE SHAPE, THROUGH THE REAL Y.DOC — not a simulated
  // input event, and not a shortcut around the store. `ClipplayerCard`'s
  // `setLaneColor` rebuilds the whole per-lane array and assigns it in one
  // transaction (SyncedStore rejects index assignment into a Y.Array); this is
  // that write, and it is the same seam the channel-column specs' `seedAndRun`
  // uses. The swatch INPUT itself lives in the clip player's own dock pane,
  // which cannot be open at the same time as the faceplate under test — driving
  // it would mean measuring a faceplate that is no longer on screen.
  await page.evaluate(
    ({ id, colour, n }) => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
      };
      w.__ydoc.transact(() => {
        const cp = w.__patch.nodes[id]!;
        if (!cp.data) cp.data = {};
        const base = new Array<string | null>(n).fill(null);
        base[0] = colour;
        (cp.data as { laneColor?: unknown }).laneColor = base;
      });
    },
    { id: target!, colour: PICKED, n: lanes },
  );

  await expect
    .poll(() => accentOf(page, 'ch1_low'), {
      timeout: 10_000,
      message: 'the OPEN faceplate must re-tint channel 1 when its lane colour changes',
    })
    .toBe(PICKED);

  // …every primitive in the column, not just the knob…
  const after = await accentsOf(page, ['ch1_low', 'ch1_volume', 'ch1_compEnable', 'ch2_low']);
  expect(after.ch1_volume, 'the fader follows too').toBe(PICKED);
  expect(after.ch1_compEnable, 'and the switch follows too').toBe(PICKED);
  // …and NOTHING ELSE moved. A write that repainted every column would satisfy
  // the poll above and be a worse bug than the one this fixes.
  expect(after.ch2_low, 'channel 2 must be untouched').toBe(before.ch2_low);
});
