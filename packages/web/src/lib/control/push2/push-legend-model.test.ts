// packages/web/src/lib/control/push2/push-legend-model.test.ts
//
// LEGEND MODE — the pure model, and THE FRESHNESS GATE.
//
// The gate is the reason the feature exists: on-device documentation is worse
// than none if it can go stale, so this file fails in BOTH directions —
//
//   · DENY-MISSING: a position that DISPATCHES something in a given
//     (view, mode, shift) must carry legend text.
//   · DENY-ORPHAN:  a position that carries legend text must dispatch
//     something in that same context.
//
// and it does so by deriving the two sides from DIFFERENT objects: "does it
// dispatch" is asked of the ROUTER'S OWN CLASSIFIER FUNCTIONS (`gridShiftRight`,
// `clipRight`, `controlRight`, `keysScaleRight`, `keysArpShiftRight`,
// `topRowAction`, `armTopLane`, `slotForScene`), while "what does it say" comes
// from the binding TABLES those classifiers read. A one-sided check would prove
// nothing about the other side (CLAUDE.md, "a gate that reads only one side of a
// two-sided contract").
//
// ⚠ NEGATIVE CONTROLS ARE PERMANENT, NOT AUTHORING-TIME. Four of them run on
// every invocation: two synthetic (a bound-but-unnamed cell, a named-but-unbound
// cell) and two that PERTURB THE REAL SHIPPING TABLE and assert the real gate
// goes red. A gate nobody has watched fail is not known to work.
//
// SCOPE, stated so its silence is not read as coverage: this covers the SCENE
// column and the FUNCTION row, base + SHIFT layer. It does not cover the 8×8
// pads, the encoders, the D-Pad, the channel-select row, or the third-layer
// modifiers (GRID-hold, latched PROB pages, copy/paste arms) — `legendScope()`
// names them and this file asserts that list, so adding a layer without
// declaring it is visible in the diff.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GRID_SHIFT_BINDINGS,
  CLIP_RIGHT_BINDINGS,
  KEYS_ARP_BINDINGS,
  TOP_ROW_BINDINGS,
  SHIFT_JUMP,
  topRowAction,
  armTopLane,
  gridShiftRight,
  clipRight,
  controlRight,
  keysScaleRight,
  keysArpShiftRight,
  sceneForWindowIndex,
  slotForScene,
  isEditExitSceneRow,
  MAX_SCENES,
} from '$lib/control/launchpad/launchpad-map';
import { LP_HEIGHT } from '$lib/control/launchpad/launchpad-sysex';
import type { LaunchpadLegendContext } from '$lib/control/launchpad/launchpad-control.svelte';
import {
  pushLegendView,
  sceneLegendRow,
  functionLegendRow,
  legendCells,
  legendContexts,
  legendScope,
  functionCellCc,
  LEGEND_CELLS,
  type PushLegendCell,
} from './push-legend-model';

// ---------------------------------------------------------------------------
// Context helper
// ---------------------------------------------------------------------------

function ctx(over: Partial<LaunchpadLegendContext> = {}): LaunchpadLegendContext {
  return {
    deployment: 'single',
    view: 'grid',
    mode: 'session',
    shift: false,
    gridHeld: false,
    sceneScrollOffset: 0,
    bound: true,
    ...over,
  };
}

const labels = (cells: readonly PushLegendCell[]): string[] => cells.map((c) => c.label);

// ---------------------------------------------------------------------------
// THE INDEPENDENT SIDE — "would a press here dispatch anything?", asked of the
// router's own classifiers, in the router's own branch order (handleSingleKey:
// length-edit takes over, then KEYS, then the active view).
// ---------------------------------------------------------------------------

function sceneDispatches(c: LaunchpadLegendContext, i: number): boolean {
  if (c.mode === 'lengthEdit') return isEditExitSceneRow(LP_HEIGHT - 1 - i);
  if (c.mode === 'keys') {
    return c.shift ? keysArpShiftRight(i) !== null : keysScaleRight(i) !== null;
  }
  switch (c.view) {
    case 'grid':
      return c.shift
        ? gridShiftRight(i) !== null
        : slotForScene(sceneForWindowIndex(c.sceneScrollOffset, i)) !== null;
    case 'clip':
      return clipRight(i) !== null;
    case 'control':
      return controlRight(i) !== null;
    case 'arranger':
      return false; // handleSingleKey: `case 'arranger': break` — routes nothing
  }
}

function functionDispatches(c: LaunchpadLegendContext, i: number): boolean {
  const cc = functionCellCc(i);
  if (cc === null) return false;
  // Under SHIFT the press is CONSUMED as the per-lane arm (handleTopRow), so the
  // shift layer dispatches exactly where `armTopLane` resolves a lane.
  return c.shift ? armTopLane(cc) !== null : topRowAction(cc) !== null;
}

// ---------------------------------------------------------------------------
// THE AUDITOR — a pure checker, so the negative controls can drive it with
// fabricated inputs and watch it go red.
// ---------------------------------------------------------------------------

type Violation =
  | { kind: 'missing-legend'; where: string }
  | { kind: 'orphan-legend'; where: string; label: string }
  | { kind: 'bound-mismatch'; where: string; label: string; bound: boolean };

function auditRow(
  where: string,
  cells: readonly PushLegendCell[],
  dispatches: (i: number) => boolean,
): Violation[] {
  const out: Violation[] = [];
  for (const cell of cells) {
    const routed = dispatches(cell.index);
    const at = `${where}[${cell.index}]`;
    if (routed && cell.label === '') out.push({ kind: 'missing-legend', where: at });
    if (!routed && cell.label !== '') {
      out.push({ kind: 'orphan-legend', where: at, label: cell.label });
    }
    // `bound` is what the RENDERER draws a dash for; it must agree with the
    // label, or the screen would print a dash over real text (or vice versa).
    if (cell.bound !== (cell.label !== '')) {
      out.push({ kind: 'bound-mismatch', where: at, label: cell.label, bound: cell.bound });
    }
  }
  return out;
}

/**
 * TABLE-LEVEL audit — the direction the cell sweep structurally CANNOT see.
 *
 * The model asks the classifier before it reads a row, so a row whose classifier
 * stopped resolving paints blank and the cell sweep stays green (verified: that
 * exact perturbation left the sweep green). Good behaviour on screen; useless as
 * a gate. So the tables are ALSO audited against their classifiers directly:
 *   · a row the classifier no longer resolves = a legend with nothing behind it;
 *   · a classifier that resolves PAST the table = a routable button with no row
 *     to name it (the one-past-the-end probe).
 */
function auditTable(
  name: string,
  rows: readonly { legend: string }[],
  resolves: (i: number) => boolean,
): Violation[] {
  const out: Violation[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!resolves(i)) {
      out.push({ kind: 'orphan-legend', where: `${name}[${i}]`, label: rows[i].legend });
    }
  }
  if (resolves(rows.length)) out.push({ kind: 'missing-legend', where: `${name}[${rows.length}]` });
  return out;
}

function auditAllTables(): Violation[] {
  return [
    ...auditTable('GRID_SHIFT_BINDINGS', GRID_SHIFT_BINDINGS, (i) => gridShiftRight(i) !== null),
    ...auditTable('CLIP_RIGHT_BINDINGS', CLIP_RIGHT_BINDINGS, (i) => clipRight(i) !== null),
    ...auditTable('KEYS_ARP_BINDINGS', KEYS_ARP_BINDINGS, (i) => keysArpShiftRight(i) !== null),
    ...auditTable(
      'TOP_ROW_BINDINGS',
      TOP_ROW_BINDINGS,
      (i) => i < TOP_ROW_BINDINGS.length && topRowAction(TOP_ROW_BINDINGS[i].cc) !== null,
    ),
  ];
}

function auditAll(contexts: readonly LaunchpadLegendContext[]): Violation[] {
  const out: Violation[] = [];
  for (const c of contexts) {
    const tag = `${c.view}/${c.mode}${c.shift ? '+shift' : ''}`;
    out.push(...auditRow(`scene:${tag}`, sceneLegendRow(c).cells, (i) => sceneDispatches(c, i)));
    out.push(
      ...auditRow(`function:${tag}`, functionLegendRow(c).cells, (i) => functionDispatches(c, i)),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------

describe('LEGEND freshness gate — deny-missing AND deny-orphan', () => {
  it('every dispatching position is named, and every named position dispatches', () => {
    const violations = auditAll(legendContexts());
    expect(
      violations,
      `LEGEND is out of date with the DISPATCH. Each entry is (view/mode[+shift])[cellIndex]:\n` +
        `  missing-legend = a press there does something, but the screen says nothing\n` +
        `  orphan-legend  = the screen names something no press can reach\n` +
        `  bound-mismatch = the drawn dash disagrees with the label\n` +
        `Fix by editing the ROUTING TABLE row (launchpad-map.ts), which carries both.\n` +
        JSON.stringify(violations, null, 2),
    ).toEqual([]);
  });

  it('every ROUTING TABLE row still resolves, and nothing routes past a table', () => {
    const violations = auditAllTables();
    expect(
      violations,
      'A legend row no longer dispatches (orphan-legend), or a classifier resolves a ' +
        'position past the end of its table so the button cannot be named ' +
        '(missing-legend). launchpad-map.ts:\n' + JSON.stringify(violations, null, 2),
    ).toEqual([]);
  });

  it('sweeps every view × mode × shift layer (24 contexts), not just the default', () => {
    const cs = legendContexts();
    expect(cs.length).toBe(4 * 3 * 2);
    // Guard against a sweep that silently narrows: all four views must appear.
    expect(new Set(cs.map((c) => c.view)).size).toBe(4);
    expect(new Set(cs.map((c) => c.mode)).size).toBe(3);
    expect(cs.filter((c) => c.shift).length).toBe(cs.length / 2);
  });

  it('a legend row is exactly 8 cells — a 9th table row would be unreachable', () => {
    // The screen has 8 slices and the hardware has 8 buttons per row, so a table
    // that grew past 8 could dispatch from a position no legend can ever show.
    expect(GRID_SHIFT_BINDINGS.length).toBe(LEGEND_CELLS);
    expect(CLIP_RIGHT_BINDINGS.length).toBe(LEGEND_CELLS);
    expect(KEYS_ARP_BINDINGS.length).toBe(LEGEND_CELLS);
    expect(TOP_ROW_BINDINGS.length).toBe(LEGEND_CELLS);
    for (const c of legendContexts()) {
      expect(sceneLegendRow(c).cells.length).toBe(LEGEND_CELLS);
      expect(functionLegendRow(c).cells.length).toBe(LEGEND_CELLS);
    }
  });

  it('no legend is blank-by-accident: every table row carries non-empty text', () => {
    for (const [name, table] of [
      ['GRID_SHIFT_BINDINGS', GRID_SHIFT_BINDINGS],
      ['CLIP_RIGHT_BINDINGS', CLIP_RIGHT_BINDINGS],
      ['KEYS_ARP_BINDINGS', KEYS_ARP_BINDINGS],
    ] as const) {
      for (const b of table) {
        expect(b.legend.trim(), `${name}: ${b.action} has an empty legend`).not.toBe('');
        // `shiftLegend: null` means "shift changes nothing here" and is legal;
        // an EMPTY STRING would mean "shift kills this button", which no row
        // means, so it is a typo trap worth closing.
        expect(b.shiftLegend, `${name}: ${b.action} — use null, not ''`).not.toBe('');
      }
    }
    for (const b of TOP_ROW_BINDINGS) {
      expect(b.legend.trim(), `TOP_ROW_BINDINGS: ${b.action} has an empty legend`).not.toBe('');
    }
  });

  it('a table that IS the shift layer declares no shift-of-shift', () => {
    // GRID_SHIFT and KEYS_ARP are only ever consulted WITH shift held, so the
    // model reads their `.legend` and never their `.shiftLegend`. A value set
    // there would be silently ignored — a field that can be written and is
    // never read is the same species of lie this whole feature exists to kill.
    for (const b of [...GRID_SHIFT_BINDINGS, ...KEYS_ARP_BINDINGS]) {
      expect(b.shiftLegend, `${b.action}: this table IS the shift layer`).toBeNull();
    }
    // NEGATIVE CONTROL for the assertion's reach: the CLIP table — the one that
    // IS consulted on both layers — genuinely uses the field.
    expect(CLIP_RIGHT_BINDINGS.some((b) => b.shiftLegend !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — permanent, so the instrument is re-proven every run.
// ---------------------------------------------------------------------------

describe('LEGEND gate NEGATIVE CONTROLS (the gate must be able to fail)', () => {
  it('SYNTHETIC: a bound-but-unnamed cell is reported as missing-legend', () => {
    const cells: PushLegendCell[] = [{ index: 0, tag: '1', label: '', bound: false }];
    const v = auditRow('fake', cells, () => true);
    expect(v).toEqual([{ kind: 'missing-legend', where: 'fake[0]' }]);
  });

  it('SYNTHETIC: a named-but-unbound cell is reported as orphan-legend', () => {
    const cells: PushLegendCell[] = [{ index: 0, tag: '1', label: 'GHOST', bound: true }];
    const v = auditRow('fake', cells, () => false);
    expect(v).toEqual([{ kind: 'orphan-legend', where: 'fake[0]', label: 'GHOST' }]);
  });

  it('REAL TABLE: blanking a shipping legend turns the REAL gate red', () => {
    // Perturb the very object the gate claims to measure and confirm the number
    // moves — the CLAUDE.md negative-control rule applied to a freshness gate.
    const row = CLIP_RIGHT_BINDINGS[0] as { legend: string };
    const saved = row.legend;
    try {
      row.legend = '';
      const v = auditAll(legendContexts());
      expect(v.length).toBeGreaterThan(0);
      expect(v.every((x) => x.kind === 'missing-legend')).toBe(true);
      expect(v.map((x) => x.where)).toContain('scene:clip/session[0]');
    } finally {
      row.legend = saved;
    }
    expect(auditAll(legendContexts())).toEqual([]); // restored
  });

  it('REAL TABLE: naming a position nothing routes to turns the REAL gate red', () => {
    // The ARRANGER view routes no scene press at all, so any text there is an
    // orphan by construction — the cleanest available "legend without dispatch".
    const arranger = ctx({ view: 'arranger' });
    const cells = sceneLegendRow(arranger).cells.map((c) =>
      c.index === 3 ? { ...c, label: 'GHOST', bound: true } : c,
    );
    const v = auditRow('scene:arranger', cells, (i) => sceneDispatches(arranger, i));
    expect(v).toEqual([{ kind: 'orphan-legend', where: 'scene:arranger[3]', label: 'GHOST' }]);
  });

  it('TABLE audit: a row whose classifier stopped resolving is an orphan', () => {
    // This is the case the CELL sweep cannot see (the model asks the classifier
    // first and paints blank), which is exactly why the table audit exists.
    const rows = [{ legend: 'A' }, { legend: 'B' }, { legend: 'C' }];
    expect(auditTable('fake', rows, (i) => i < 2)).toEqual([
      { kind: 'orphan-legend', where: 'fake[2]', label: 'C' },
    ]);
  });

  it('TABLE audit: a classifier resolving past the table is a missing legend', () => {
    const rows = [{ legend: 'A' }, { legend: 'B' }];
    expect(auditTable('fake', rows, (i) => i < 3)).toEqual([
      { kind: 'missing-legend', where: 'fake[2]' },
    ]);
  });

  it('the auditor is not vacuously green — it reads every cell of every context', () => {
    // If the sweep ever stopped iterating, the gate above would pass in silence.
    // Force EVERY position to be "routed" and confirm the count of complaints
    // equals the number of genuinely-blank cells across the whole sweep.
    let blanks = 0;
    for (const c of legendContexts()) {
      blanks += legendCells(pushLegendView(c)).filter((x) => x.label === '').length;
    }
    expect(blanks).toBeGreaterThan(0); // the blank cells are real (arranger, SHIFT)
    let complaints = 0;
    for (const c of legendContexts()) {
      complaints += auditRow('x', sceneLegendRow(c).cells, () => true).length;
      complaints += auditRow('y', functionLegendRow(c).cells, () => true).length;
    }
    expect(complaints).toBe(blanks);
  });
});

// ---------------------------------------------------------------------------
// SOURCE-LEVEL GATE: the SHIFT layer the legend PROMISES must be the SHIFT layer
// the handler actually branches on. No runtime gate can see this (the shift
// magnitude lives inside a switch), so it is checked at the source level — the
// same discipline as the `controlFamilies`→card-testid grep in module-docs-lint.
// ---------------------------------------------------------------------------

const CONTROL_SRC_PATH = fileURLToPath(
  new URL('../launchpad/launchpad-control.svelte.ts', import.meta.url),
);

/** The actions whose CLIP-view handling reads `shift`, read out of the source. */
export function clipActionsBranchingOnShift(src: string): Set<string> {
  const out = new Set<string>();
  const body = section(src, 'function handleClipRight(');
  for (const b of CLIP_RIGHT_BINDINGS) {
    const start = body.indexOf(`case '${b.action}':`);
    if (start < 0) continue;
    const next = nextCaseIndex(body, start);
    if (/\bshift\b/.test(body.slice(start, next))) out.add(b.action);
  }
  // A row can also be intercepted BEFORE dispatch by the outer handler (FOLLOW
  // is: no-shift = momentary VEL, shift = the FOLLOW toggle). An interception
  // keyed on the action literal is, by definition, modifier-sensitive handling.
  const outer = section(src, 'function handleSingleClip(');
  for (const b of CLIP_RIGHT_BINDINGS) {
    if (outer.includes(`clipRight(sceneIndex) === '${b.action}'`)) out.add(b.action);
  }
  return out;
}

/** Source text from `marker` to the end of that function (brace matching). */
function section(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`launchpad-control source no longer contains ${marker}`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

function nextCaseIndex(body: string, from: number): number {
  const n = body.indexOf("case '", from + 6);
  return n < 0 ? body.length : n;
}

describe('LEGEND ↔ DISPATCH shift layer (source-level)', () => {
  const src = readFileSync(CONTROL_SRC_PATH, 'utf8');

  it('exactly the CLIP rows that declare a shift legend are the ones that read shift', () => {
    const declared = new Set(
      CLIP_RIGHT_BINDINGS.filter((b) => b.shiftLegend !== null).map((b) => b.action),
    );
    const actual = clipActionsBranchingOnShift(src);
    expect(
      [...actual].sort(),
      'A CLIP right-column row promises a SHIFT function the handler no longer implements, ' +
        'or implements one it does not advertise. Fix the row in launchpad-map.ts ' +
        'or the branch in handleClipRight/handleSingleClip.',
    ).toEqual([...declared].sort());
    expect(declared.size).toBe(5); // follow + the nav pair + the step pair
  });

  it('NEGATIVE CONTROL: removing the shift branch from a case is detected', () => {
    const broken = src.replace(
      "      editRowOffset += shift ? SHIFT_JUMP : 1;",
      '      editRowOffset += 1;',
    );
    expect(broken).not.toBe(src); // the anchor still exists — else this is vacuous
    expect(clipActionsBranchingOnShift(broken).has('rowUp')).toBe(false);
    expect(clipActionsBranchingOnShift(src).has('rowUp')).toBe(true);
  });

  it('NEGATIVE CONTROL: removing the FOLLOW interception is detected', () => {
    const broken = src.replace("clipRight(sceneIndex) === 'follow'", 'false');
    expect(broken).not.toBe(src);
    expect(clipActionsBranchingOnShift(broken).has('follow')).toBe(false);
  });

  it('the printed SHIFT magnitude IS the constant the handler adds', () => {
    // 'PITCH +8' says 8 because SHIFT_JUMP is 8 — the template literal in the
    // table is what makes that true rather than a coincidence.
    expect(CLIP_RIGHT_BINDINGS[4].shiftLegend).toBe(`PITCH +${SHIFT_JUMP}`);
    expect(CLIP_RIGHT_BINDINGS[5].shiftLegend).toBe(`PITCH −${SHIFT_JUMP}`);
    expect(SHIFT_JUMP).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// THE MODEL — what each view actually says.
// ---------------------------------------------------------------------------

describe('scene row (the 8 buttons right of the grid; cell 0 = TOP button)', () => {
  it('GRID base = scene launch, numbered from the SCROLLED window', () => {
    expect(labels(sceneLegendRow(ctx({ view: 'grid' })).cells)).toEqual([
      'SCENE 1', 'SCENE 2', 'SCENE 3', 'SCENE 4', 'SCENE 5', 'SCENE 6', 'SCENE 7', 'SCENE 8',
    ]);
    // The number is computed by the dispatch's own window math, so scrolling
    // changes the legend — a hand-written 'SCENE 1..8' list could not do this.
    expect(labels(sceneLegendRow(ctx({ view: 'grid', sceneScrollOffset: 4 })).cells)[0]).toBe(
      'SCENE 5',
    );
  });

  it('GRID base: a scene past the stored ceiling reads as UNBOUND, not as a lie', () => {
    const cells = sceneLegendRow(ctx({ view: 'grid', sceneScrollOffset: MAX_SCENES - 3 })).cells;
    expect(cells[0].label).toBe(`SCENE ${MAX_SCENES - 2}`);
    expect(cells[3].bound).toBe(false);
    expect(cells[3].label).toBe('');
  });

  it('GRID + SHIFT = the grid-shift function palette', () => {
    expect(labels(sceneLegendRow(ctx({ view: 'grid', shift: true })).cells)).toEqual([
      'COPY', 'PASTE', 'CLIP DIV', 'SWING +', 'SWING −', 'LENGTH', 'SCENES ▲', 'SCENES ▼',
    ]);
  });

  it('CLIP: SHIFT swaps only the rows whose handler reads shift', () => {
    const base = labels(sceneLegendRow(ctx({ view: 'clip' })).cells);
    const shifted = labels(sceneLegendRow(ctx({ view: 'clip', shift: true })).cells);
    expect(base).toEqual([
      'DOUBLE', 'LENGTH', 'VEL HOLD', 'KEYS', 'PITCH +1', 'PITCH −1', 'STEP ◀', 'STEP ▶',
    ]);
    expect(shifted).toEqual([
      'DOUBLE', 'LENGTH', 'FOLLOW', 'KEYS', 'PITCH +8', 'PITCH −8', 'STEP ◀8', 'STEP ▶8',
    ]);
    // DOUBLE/LENGTH/KEYS are shift-INSENSITIVE, so they must read the SAME on
    // both layers — `shiftLegend: null` means exactly that, and showing a blank
    // there would claim shift kills the button.
    expect([base[0], base[1], base[3]]).toEqual([shifted[0], shifted[1], shifted[3]]);
  });

  it('CONTROL = per-lane STOP, numbered by the lane the classifier returns', () => {
    expect(labels(sceneLegendRow(ctx({ view: 'control' })).cells)).toEqual([
      'STOP L8', 'STOP L7', 'STOP L6', 'STOP L5', 'STOP L4', 'STOP L3', 'STOP L2', 'STOP L1',
    ]);
    // controlRight is the router's classifier; the legend is its return value.
    expect(controlRight(0)).toBe(7);
  });

  it('ARRANGER routes nothing → eight cells that are EMPTY, not missing', () => {
    const cells = sceneLegendRow(ctx({ view: 'arranger' })).cells;
    expect(labels(cells)).toEqual(['', '', '', '', '', '', '', '']);
    expect(cells.every((c) => c.bound === false)).toBe(true);
    // …and the gate is fine with that: an unbound cell is an ANSWER.
    expect(auditRow('a', cells, (i) => sceneDispatches(ctx({ view: 'arranger' }), i))).toEqual([]);
  });

  it('KEYS base = the scale column; KEYS + SHIFT = the arp column', () => {
    expect(labels(sceneLegendRow(ctx({ mode: 'keys' })).cells)).toEqual([
      'MAJOR', 'MINOR', 'PENTATONIC', 'DORIAN', 'PHRYGIAN', 'MIXOLYDIAN', 'CHROMATIC', 'ARP ON/OFF',
    ]);
    expect(labels(sceneLegendRow(ctx({ mode: 'keys', shift: true })).cells)).toEqual([
      'ARP DIV +', 'ARP DIV −', 'ARP UP', 'ARP DOWN', 'ARP UP-DN', 'RANGE +', 'RANGE −', 'ARP LATCH',
    ]);
  });

  it('KEYS/LENGTH take over the scene column regardless of the active view', () => {
    // handleSingleKey checks length-edit, then keys, THEN the view — the legend
    // branches in the same order, or it would document an unreachable view.
    for (const view of ['grid', 'clip', 'control', 'arranger'] as const) {
      expect(labels(sceneLegendRow(ctx({ view, mode: 'keys' })).cells)[0]).toBe('MAJOR');
      expect(labels(sceneLegendRow(ctx({ view, mode: 'lengthEdit' })).cells)).toEqual([
        'EXIT', '', '', '', '', '', '', '',
      ]);
    }
  });
});

describe('function row (the 8 buttons under the display)', () => {
  it('base layer is the permanent nav row, identical in every view', () => {
    const expected = ['PLAY/STOP', 'GRID', 'CLIP', 'ARRANGER', 'CONTROL', 'UNDO', 'REDO', 'SHIFT'];
    for (const view of ['grid', 'clip', 'control', 'arranger'] as const) {
      expect(labels(functionLegendRow(ctx({ view })).cells)).toEqual(expected);
    }
  });

  it('SHIFT layer is the per-lane automation arm, from armTopLane', () => {
    const cells = functionLegendRow(ctx({ shift: true })).cells;
    expect(labels(cells)).toEqual([
      'ARM L1', 'ARM L2', 'ARM L3', 'ARM L4', 'ARM L5', 'ARM L6', 'ARM L7', '',
    ]);
    // Column 8 IS the shift button: it has no shift layer of its own. That is a
    // legitimately EMPTY cell, and the distinction from "undocumented" is the
    // whole reason `bound` exists.
    expect(cells[7].bound).toBe(false);
    expect(armTopLane(functionCellCc(7)!)).toBeNull();
  });

  it('cell i documents the i-th button left→right (CC 91..98)', () => {
    expect([0, 1, 7].map((i) => functionCellCc(i))).toEqual([91, 92, 98]);
    expect(topRowAction(functionCellCc(0)!)).toBe('transport');
    expect(topRowAction(functionCellCc(7)!)).toBe('shift');
  });
});

describe('the whole view', () => {
  it('names the context and the shift layer', () => {
    expect(pushLegendView(ctx({ view: 'clip' })).context).toBe('CLIP');
    expect(pushLegendView(ctx({ mode: 'keys' })).context).toBe('KEYS');
    expect(pushLegendView(ctx({ mode: 'lengthEdit' })).context).toBe('LENGTH');
    expect(pushLegendView(ctx({ shift: true })).shift).toBe(true);
  });

  it('says so when nothing is bound (the buttons route nowhere)', () => {
    expect(pushLegendView(ctx({ bound: false })).note).toMatch(/no clip player bound/);
    expect(pushLegendView(ctx({ bound: true })).note).toBeNull();
  });

  it('is PURE — same context in, identical cells out', () => {
    const a = legendCells(pushLegendView(ctx({ view: 'clip', shift: true })));
    const b = legendCells(pushLegendView(ctx({ view: 'clip', shift: true })));
    expect(a).toEqual(b);
    expect(a.length).toBe(LEGEND_CELLS * 2);
  });

  it('declares its own SCOPE, so silence is not read as coverage', () => {
    const s = legendScope();
    expect(s.covered).toContain('scene column (base + SHIFT)');
    expect(s.covered).toContain('function row (base + SHIFT)');
    for (const missing of [
      '8×8 pad matrix',
      'display encoders',
      'D-Pad',
      'channel-select row above the display',
      'GRID-held repeat-count layer',
    ]) {
      expect(s.uncovered).toContain(missing);
    }
  });
});
