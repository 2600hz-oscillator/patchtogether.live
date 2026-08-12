// packages/web/src/lib/ui/modules/manual-strike-wiring.test.ts
//
// THE CALLER↔SEAM GATE. `manual-strike-actions.test.ts` proves the seam works;
// this proves the RACK ACTUALLY USES IT, and uses the right half of it.
//
// ⚠ WHY IT IS A SEPARATE GATE — what every existing check is structurally
// unable to see:
//   * `shell-cells.test.ts` asserts an action cell declares the HANDLER FIELD
//     its mode needs (`mode:'gate'` ⇒ `onGate`). It never CALLS the handler, so
//     a `mode:'gate'` cell whose `onGate` called `fireManualStrike` passes it
//     cleanly — and that pad would fire one 5 ms pulse, report `aria-pressed`,
//     and never close. The declaration and the implementation are two sides of
//     a contract and it reads one.
//   * `faces-parity` clicks the rendered button and asserts it was enabled and
//     that `aria-pressed` moved. Both are true of a button wired to the wrong
//     seam, or to no seam at all.
//   * `{kickdrum,karplus,snaredrum}-factory-strike.test.ts` prove the FACTORY
//     answers the read keys. Nothing there says a caller ever asks.
//   * `contract-lock` / `module-docs-lint` / `module-face-lint` read the DEF.
// So the whole gate set could stay green with every audition in the rack
// disconnected. This file drives the REAL `SHELL_CELLS` registry against a
// recording engine and reads back WHICH READ KEY each cell actually reached.
//
// It exists because the seam it guards was, for one week, TWO modules: the
// kickdrum/karplus one-shot file and a parallel `snaredrum-strike-actions`
// whose one-shot half was a byte-for-byte copy (same read-key STRING). Merging
// them is only half the fix — the other half is a gate that makes the next
// struck voice's wiring visible, so the copy cannot quietly come back.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { setActiveEngine } from '$lib/audio/engine-ref';
import type { PatchEngine } from '$lib/audio/engine';
import {
  MANUAL_GATE_KEY,
  MANUAL_STRIKE_KEY,
  __resetManualGateLatch,
} from './manual-strike-actions';
import {
  shellCellFor,
  shellCellKeys,
  typesWithShellCells,
  type ShellActionCell,
} from '$lib/ui/workflow/shell-cells';

const NID = 'manual-strike-wiring-node';
const AUDITION_KEYS = [MANUAL_STRIKE_KEY, MANUAL_GATE_KEY];

/**
 * THE PINNED AUDITION INVENTORY — `moduleType:faceKey → the read keys the cell
 * actually reaches`, in call order.
 *
 * An ACCEPT-LOOP, exactly like `contract-lock.txt` or the push-card goldens: a
 * new struck voice adds a line here in the same commit that wires it, and a
 * caller that stops going through the shared seam DROPS a line. Both are red.
 * That is the point — an audition that silently detaches is invisible to every
 * other gate we own.
 */
const EXPECTED_AUDITIONS: Record<string, string[]> = {
  'karplus:karplus-strike-{n}': [MANUAL_STRIKE_KEY],
  'kickdrum:kickdrum-strike-{n}': [MANUAL_STRIKE_KEY],
  'snaredrum:snaredrum-hit-{n}': [MANUAL_STRIKE_KEY],
  // press + release ⇒ the gate setter is resolved twice, once per edge.
  'snaredrum:snaredrum-roll-{n}': [MANUAL_GATE_KEY, MANUAL_GATE_KEY],
  // face batch 3 — RECOVERED. The legacy card's ⟋ STRUM button always drove
  // this seam; the shell registry did not, so `?shell=1` offered twenty
  // controls over an instrument that could not be sounded.
  'sixstrum:sixstrum-strum-{n}': [MANUAL_STRIKE_KEY],
  // face batch 3 — the fourteen-engine macro voice. FIVE of its engines
  // (FM 6OP, STRING, KICK, SNARE, HIHAT) initialise their excitation or
  // envelopes to zero and are SILENT with nothing patched into TRIG, so this
  // is the only way to hear more than a third of the module on a bare rack.
  'macrooscillator:macro-strike-{n}': [MANUAL_STRIKE_KEY],
  // face batch 3 — meowbox. A HELD pad, so two resolutions like snaredrum's
  // ROLL. ⚠ THE SHAPE IS THE DEF'S, NOT A PREFERENCE: `gate` is declared
  // edge:'gate' and the DSP's amp envelope sustains at 0.4, so a one-shot would
  // fire the 5 ms trigger pulse and release the envelope 5 ms into a 400 ms
  // tail. The factory answers `manualGate` and deliberately NOT `manualTrigger`,
  // so a caller reaching for the wrong shape gets a recorded non-delivery
  // instead of a blip.
  'meowbox:meowbox-meow-{n}': [MANUAL_GATE_KEY, MANUAL_GATE_KEY],
  // face batch 4 — rings, and the strongest case in this list. The others are
  // voices that are silent with nothing patched into their strike input; rings
  // is silent FULL STOP — measured peak exactly 0.000e+0 on both taps, in both
  // models, with nothing patched and nothing struck, because it has no internal
  // exciter and no free-run at all. Before this seam there was no strum control
  // anywhere in the product (not on the card, not on any shell tier), so the
  // module could be spawned, fully explored, and never heard.
  // ⚠ ONE-SHOT, and the def is why: `strum` declares edge:'trigger' and the
  // processor fires on the RISING EDGE only, ignoring how long the level stays
  // high — so a held gate would strike once and then hold a level the DSP does
  // not read. The factory answers `manualTrigger` and deliberately not
  // `manualGate`.
  'rings:rings-strum-{n}': [MANUAL_STRIKE_KEY],
};

interface Drive {
  where: string;
  mode: 'trigger' | 'gate';
  /** The audition read keys this cell asked the engine for, in order. */
  keys: string[];
  /** `nodeId:hi` / `nodeId:lo` for every gate edge that reached the engine. */
  gates: string[];
  /** `nodeId` for every one-shot that reached the engine. */
  fired: string[];
}

/** Every registered `action` cell, as `[moduleType, faceKey, cell]`. */
function actionCells(): [string, string, ShellActionCell][] {
  const out: [string, string, ShellActionCell][] = [];
  for (const type of typesWithShellCells()) {
    for (const key of shellCellKeys(type)) {
      const cell = shellCellFor(type, { key, kind: 'family', label: key });
      if (cell?.kind === 'action') out.push([type, key, cell]);
    }
  }
  return out;
}

/**
 * DRIVE every action cell for real and record what it reached. A trigger cell
 * gets one `onFire`; a gate cell gets a press AND a release, because the release
 * is the edge whose loss is the forever-rolling drum.
 */
function driveAll(): Drive[] {
  const out: Drive[] = [];
  for (const [type, key, cell] of actionCells()) {
    __resetManualGateLatch();
    const keys: string[] = [];
    const gates: string[] = [];
    const fired: string[] = [];
    const engine = {
      read(node: ModuleNode, k: string): unknown {
        if (!AUDITION_KEYS.includes(k)) return undefined;
        keys.push(k);
        if (k === MANUAL_STRIKE_KEY) return () => fired.push(node.id);
        return (high: boolean) => gates.push(`${node.id}:${high ? 'hi' : 'lo'}`);
      },
      // cloudseed's `Clear tail` is an ENGINE gesture, not an audition — it
      // takes the `env` handle and writes. Present so driving it is a no-op
      // here rather than a throw that would read as "reached no audition".
      write() {},
    };
    setActiveEngine(engine as unknown as PatchEngine);
    const env = { engine, node: patch.nodes[NID] as unknown as ModuleNode | undefined };
    const mode = cell.mode ?? 'trigger';
    if (mode === 'gate') {
      cell.onGate?.(NID, true, env);
      cell.onGate?.(NID, false, env);
    } else {
      cell.onFire?.(NID, env);
    }
    setActiveEngine(null);
    out.push({ where: `${type}:${key}`, mode, keys, gates, fired });
  }
  __resetManualGateLatch();
  return out;
}

beforeEach(() => {
  __resetManualGateLatch();
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'snaredrum',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: {},
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
});

afterEach(() => {
  setActiveEngine(null);
  __resetManualGateLatch();
  ydoc.transact(() => {
    if (patch.nodes[NID]) delete patch.nodes[NID];
  }, LOCAL_ORIGIN);
});

describe('audition wiring — the shell cells really reach the shared seam', () => {
  it('the AUDITION INVENTORY is exactly what is pinned (a detached caller drops out)', () => {
    const actual: Record<string, string[]> = {};
    for (const d of driveAll()) if (d.keys.length) actual[d.where] = d.keys;
    expect(
      actual,
      'an audition cell stopped reaching the shared seam, or a new one appeared.\n' +
        'If you WIRED a new struck voice: add its line to EXPECTED_AUDITIONS.\n' +
        'If a line VANISHED: that module’s audition is now dead in the dock and\n' +
        'nothing else in the suite can see it — do not "fix" this by deleting the line.',
    ).toEqual(EXPECTED_AUDITIONS);
  });

  it('MODE and READ KEY agree — a gate pad cannot be wired to the one-shot', () => {
    // The hole `shell-cells.test.ts` is structurally blind to: it reads the
    // declaration, this reads the behaviour. Swapping `setManualGate` for
    // `fireManualStrike` in the roll cell passes there and fails here.
    const wrong: string[] = [];
    for (const d of driveAll()) {
      const uniq = [...new Set(d.keys)];
      if (!uniq.length) continue;
      if (uniq.length > 1) {
        wrong.push(`${d.where}: one cell reached BOTH audition keys (${uniq.join(', ')})`);
        continue;
      }
      const key = uniq[0]!;
      if (key === MANUAL_GATE_KEY && d.mode !== 'gate') {
        wrong.push(`${d.where}: reaches ${MANUAL_GATE_KEY} but declares mode '${d.mode}' — a one-shot Button never sends the release, so the gate would never close`);
      }
      if (key === MANUAL_STRIKE_KEY && d.mode !== 'trigger') {
        wrong.push(`${d.where}: reaches ${MANUAL_STRIKE_KEY} but declares mode '${d.mode}' — a momentary pad would report "held" over a one-shot`);
      }
    }
    expect(wrong.join('\n'), 'action cell(s) whose press MODE contradicts the seam they call').toBe('');
  });

  it('every GATE audition sends exactly ONE high and ONE low for a press/release', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const d of driveAll()) {
      if (d.mode !== 'gate' || !d.keys.length) continue;
      checked++;
      if (JSON.stringify(d.gates) !== JSON.stringify([`${NID}:hi`, `${NID}:lo`])) {
        bad.push(`${d.where}: edges were [${d.gates.join(', ')}], expected [hi, lo]`);
      }
    }
    expect(bad.join('\n'), 'a held audition that never closes ROLLS FOREVER').toBe('');
    expect(checked, 'no gate audition was exercised — this clause would be vacuous').toBeGreaterThan(0);
  });

  it('every TRIGGER audition fires EXACTLY ONCE at the node it was handed', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const d of driveAll()) {
      if (d.mode !== 'trigger' || !d.keys.length) continue;
      checked++;
      if (JSON.stringify(d.fired) !== JSON.stringify([NID])) {
        bad.push(`${d.where}: fired [${d.fired.join(', ')}], expected exactly [${NID}]`);
      }
    }
    expect(bad.join('\n'), 'a one-shot audition that fires twice, or at the wrong node').toBe('');
    expect(checked, 'no trigger audition was exercised — this clause would be vacuous').toBeGreaterThan(0);
  });
});

// ── ONE OBVIOUS PLACE ────────────────────────────────────────────────────────
//
// The behavioural gate above can only see callers that go THROUGH the registry.
// A card that hand-rolls `e.read(node, 'manualTrigger')` is invisible to it —
// which is exactly what SamsloopCard and SixstrumCard do today, and exactly the
// shape the next struck voice will copy if nothing counts them.

/**
 * Files under `ui/modules/` allowed to name an audition read key. ONLY SHRINKS.
 *
 * `manual-strike-actions.ts` is the seam itself. The other two are LEGACY cards
 * that resolve the handle inline instead of calling it; each is one boy-scout
 * conversion away (`fireManualStrike(id)`), and until then they are declared
 * here rather than silently tolerated. A new card must NOT be added — wire it to
 * the seam. This list is what makes "one obvious place" enforced rather than
 * advisory.
 */
const INLINE_AUDITION_FILES = new Set([
  'manual-strike-actions.ts',
  'SamsloopCard.svelte',
  'SixstrumCard.svelte',
]);

function uiModuleSources(): [string, string][] {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  return readdirSync(dir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.svelte')) && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')]);
}

describe('audition wiring — the read keys live in ONE place', () => {
  it('no card re-implements the resolver (the allowlist only shrinks)', () => {
    const offenders = uiModuleSources()
      .filter(([, src]) => AUDITION_KEYS.some((k) => src.includes(`'${k}'`)))
      .map(([file]) => file)
      .filter((f) => !INLINE_AUDITION_FILES.has(f))
      .sort();
    expect(
      offenders,
      `card(s) naming an audition read key directly. Call the seam instead:\n` +
        `  fireManualStrike(id)      — a one-shot (edge:'trigger' port)\n` +
        `  setManualGate(id, high)   — a held audition (edge:'gate' port)\n` +
        `An inline resolver is a second implementation: it skips the latch, the\n` +
        `leak guard and every gate in this file.`,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the allowlist is not stale, and the grep really matches', () => {
    // Two ways this gate could be decoration: an allowlist naming files that no
    // longer contain a key (so it would never fire), or a grep that matches
    // nothing at all (so `offenders` is empty for the wrong reason).
    const byName = new Map(uiModuleSources());
    for (const f of INLINE_AUDITION_FILES) {
      const src = byName.get(f);
      expect(src, `${f} is allowlisted but not present — drop the entry`).toBeDefined();
      expect(
        AUDITION_KEYS.some((k) => src!.includes(`'${k}'`)),
        `${f} no longer names an audition read key — REMOVE it from INLINE_AUDITION_FILES (this list only shrinks)`,
      ).toBe(true);
    }
    // …and the seam itself must be found by the very grep the sweep uses.
    expect(byName.get('manual-strike-actions.ts')).toContain(`'${MANUAL_STRIKE_KEY}'`);
    expect(byName.get('manual-strike-actions.ts')).toContain(`'${MANUAL_GATE_KEY}'`);
  });
});
