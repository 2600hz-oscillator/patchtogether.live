// packages/web/src/lib/docs/module-docs-lint.test.ts
//
// The AUTHORED-tier linters for the living-docs system (the prose half of the
// drift gate; the contract half is contract-lock.test.ts). Pure-unit, zero
// flake — they read the live registry and check the co-located `docs`:
//
//  1. CONSISTENCY (all authored modules): every `docs.ports` key resolves to a
//     real port; every `docs.controls` key resolves to a real param OR a
//     declared control-family template (`<familyId>-{n}`). This is the
//     orphan-rot guard — rename/remove a port and its stale doc entry fails CI,
//     forcing the doc to be fixed (the doc-side complement to the contract
//     golden, which catches the contract change itself).
//
//  2. COMPLETENESS (STRICT_DOCS set only): every port, every param, and every
//     control family of a promoted module HAS an authored entry — the
//     deny(missing_docs) guarantee, so a NEW port on a strict module fails
//     until documented.
//
//  3. EDGE COHERENCE: a documented trigger/gate port's prose must use the
//     vocabulary of its declared `edge` (conservative positive-presence check)
//     — a targeted defense against wrong-but-compiles prose on the one field
//     with a controlled vocabulary (the NUMPAD+ edge-vocabulary class).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import type { ControlFamily, ModuleDocs } from '$lib/graph/types';
import { STRICT_DOCS } from './strict-docs';
import { resolveLegend, staticKey, type LegendEntry } from './control-doc-resolver';
import {
  UNDECLARED_EDGE_DEBT,
  UNDECLARED_EDGE_PIN,
  undeclaredEdgePairs,
} from './undeclared-edge-ledger';
import { checkRatchetPin } from '$lib/dev/ratchet-pin';

interface DocPort {
  id: string;
  type?: string;
  edge?: 'trigger' | 'gate';
}

interface DocDef {
  type: string;
  card?: string;
  inputs?: readonly DocPort[];
  outputs?: readonly DocPort[];
  params?: readonly { id: string; label?: string }[];
  controlFamilies?: readonly ControlFamily[];
  docs?: ModuleDocs;
}

/** Committed numbered-face legends (e2e/vrt/__annotated__/<type>.legend.json) →
 *  the number→stable-test-id map the doc page resolves to authored blobs. This
 *  is the enumeration of EVERY on-card control (the static buttons have no
 *  param/family representation in the def, so the legend is their only roster).
 *  Five `../` from this file (docs → lib → src → web → packages → repo root). */
function loadLegends(): Record<string, LegendEntry[]> {
  const dir = fileURLToPath(new URL('../../../../../e2e/vrt/__annotated__/', import.meta.url));
  const out: Record<string, LegendEntry[]> = {};
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.legend.json')) continue;
    const j = JSON.parse(readFileSync(`${dir}${f}`, 'utf8')) as { type?: string; controls?: LegendEntry[] };
    if (j.type) out[j.type] = j.controls ?? [];
  }
  return out;
}
const LEGENDS = loadLegends();

/** All UI-component source concatenated — the cross-check corpus for the
 *  controlFamilies grep guard (mirrors webgl-attest's flag-vs-reality grep).
 *  Recurses the whole ui/ tree because a card's dynamic controls may live in a
 *  shared sub-component (e.g. the sequencer's quicksave row is ui/QuicksaveControls). */
function allCardSource(): string {
  const root = fileURLToPath(new URL('../ui/', import.meta.url));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}${e.name}`;
      if (e.isDirectory()) walk(`${p}/`);
      else if (e.name.endsWith('.svelte')) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out.join('\n');
}

function allDefs(): DocDef[] {
  return [
    ...(listModuleDefs() as unknown as DocDef[]),
    ...(listVideoModuleDefs() as unknown as DocDef[]),
    ...(listMetaModuleDefs() as unknown as DocDef[]),
  ].sort((a, b) => a.type.localeCompare(b.type));
}

const FAMILY_KEY = /^(.+)-\{n\}$/;

const TRIGGER_VOCAB = [
  'rising edge', 'once', 'trigger', 'clock', 'reset', 'strike', 'sync',
  'pulse', 'advance', 'restart', 'step', 'tick', 'fires',
];
const GATE_VOCAB = [
  'while', 'held', 'hold', 'sustain', 'level', 'high', 'open', 'as long as',
  'gate stays', 'note-on', 'note on', 'down',
];
const hasAny = (s: string, vocab: string[]) => {
  const low = s.toLowerCase();
  return vocab.some((w) => low.includes(w));
};

describe('module-docs lint — consistency (all authored modules)', () => {
  it('every docs.ports / docs.controls key resolves to a real port / param / family', () => {
    const orphans: string[] = [];
    for (const def of allDefs()) {
      if (!def.docs) continue;
      const inIds = new Set((def.inputs ?? []).map((p) => p.id));
      const outIds = new Set((def.outputs ?? []).map((p) => p.id));
      const paramIds = new Set((def.params ?? []).map((p) => p.id));
      const familyIds = new Set((def.controlFamilies ?? []).map((f) => f.id));

      for (const key of Object.keys(def.docs.inputs ?? {})) {
        if (!inIds.has(key)) orphans.push(`${def.type}: docs.inputs['${key}'] → no such input port`);
      }
      for (const key of Object.keys(def.docs.outputs ?? {})) {
        if (!outIds.has(key)) orphans.push(`${def.type}: docs.outputs['${key}'] → no such output port`);
      }
      // Static-button doc keys (snh toggle, page-nav, SAVE/LOAD/QUEUE, …) have
      // no param/family in the def — they're valid iff a numbered control on the
      // card maps to them (its stable test id, nodeId stripped).
      const legendStaticKeys = new Set((LEGENDS[def.type] ?? []).map((e) => staticKey(e.testid)));
      for (const key of Object.keys(def.docs.controls ?? {})) {
        const fam = key.match(FAMILY_KEY);
        if (fam) {
          if (!familyIds.has(fam[1])) {
            orphans.push(`${def.type}: docs.controls['${key}'] → no controlFamily '${fam[1]}'`);
          }
        } else if (!paramIds.has(key) && !legendStaticKeys.has(key)) {
          orphans.push(
            `${def.type}: docs.controls['${key}'] → no such param / family / numbered control`,
          );
        }
      }
    }
    expect(orphans.join('\n'), 'orphaned doc keys — rename/remove drifted the docs; fix the keys').toBe('');
  });
});

describe('module-docs lint — completeness (STRICT_DOCS set)', () => {
  it('every promoted module documents EVERY port, param, and control family', () => {
    const missing: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_DOCS.has(def.type)) continue;
      const docs = def.docs;
      if (!docs) {
        missing.push(`${def.type}: in STRICT_DOCS but has no docs`);
        continue;
      }
      const inDocs = docs.inputs ?? {};
      const outDocs = docs.outputs ?? {};
      const ctrlDocs = docs.controls ?? {};
      if (!docs.explanation || !docs.explanation.trim()) missing.push(`${def.type}: docs.explanation empty`);
      for (const p of def.inputs ?? []) {
        if (!inDocs[p.id]?.trim()) missing.push(`${def.type}: undocumented input '${p.id}'`);
      }
      for (const p of def.outputs ?? []) {
        if (!outDocs[p.id]?.trim()) missing.push(`${def.type}: undocumented output '${p.id}'`);
      }
      for (const p of def.params ?? []) {
        if (!ctrlDocs[p.id]?.trim()) missing.push(`${def.type}: undocumented param '${p.id}'`);
      }
      for (const f of def.controlFamilies ?? []) {
        if (!ctrlDocs[`${f.id}-{n}`]?.trim()) {
          missing.push(`${def.type}: undocumented control family '${f.id}' (need docs.controls['${f.id}-{n}'])`);
        }
      }
    }
    expect(missing.join('\n'), 'STRICT_DOCS module(s) missing required docs — author them or unpromote').toBe('');
  });
});

describe('module-docs lint — numbered card KEY resolves (STRICT_DOCS set)', () => {
  it('EVERY numbered control on a promoted module maps to an authored blob', () => {
    // The faithful "every control documented" bar: the numbered face is the real
    // on-card roster (incl. static buttons absent from the def). A new button →
    // a new number with no authored entry → this fails until it's documented.
    // (Skips a STRICT module with no generated face yet — regenerate it first.)
    const missing: string[] = [];
    for (const def of allDefs()) {
      if (!STRICT_DOCS.has(def.type)) continue;
      const legend = LEGENDS[def.type];
      if (!legend?.length) continue;
      for (const r of resolveLegend(legend, { params: def.params, docs: def.docs })) {
        if (!r.resolved) {
          missing.push(`${def.type}: numbered control #${r.n} ('${r.key}') has no authored docs.controls entry`);
        }
      }
    }
    expect(
      missing.join('\n'),
      'numbered control(s) with no authored blob — add a docs.controls entry for each',
    ).toBe('');
  });
});

// ── EDGE COHERENCE — and the `if (!p.edge) continue` that hollowed it out ───
//
// ⚠ A MISSING DECLARATION IS NOT "NOT APPLICABLE", IT IS "UNCHECKED".
// The vocabulary check below used to open `if (!p.edge) continue`, so the only
// ports it could ever fail were the ones whose author had already declared an
// edge — and the ports nobody declared, whose prose is therefore entirely
// unreviewed, were exactly the ones it skipped. Same shape as a `<=` ceiling
// that can only trip by growing.
//
// MEASURED at the time of the fix: 362 gate-cable ports, 63 declared and
// checked, 299 skipped — the gate covered 17 % of its subject and printed
// nothing about the rest. `undeclared-edge-ledger.ts` now names every one, and
// the demand is deny-by-default.
//
/** Every gate-cable port, with the doc prose (if any) that describes it. */
function gatePorts(): {
  type: string;
  id: string;
  dir: 'in' | 'out';
  edge?: 'trigger' | 'gate';
  desc?: string;
}[] {
  const out: { type: string; id: string; dir: 'in' | 'out'; edge?: 'trigger' | 'gate'; desc?: string }[] = [];
  for (const def of allDefs()) {
    for (const [dir, ports] of [['in', def.inputs], ['out', def.outputs]] as const) {
      for (const p of ports ?? []) {
        if (p.type !== 'gate') continue;
        out.push({
          type: def.type,
          id: p.id,
          dir,
          edge: p.edge,
          desc: dir === 'in' ? def.docs?.inputs?.[p.id] : def.docs?.outputs?.[p.id],
        });
      }
    }
  }
  return out;
}

describe('module-docs lint — edge/gate vocabulary coherence', () => {
  it('a documented trigger/gate port uses its declared edge vocabulary', () => {
    const mismatches: string[] = [];
    for (const def of allDefs()) {
      if (!def.docs) continue;
      const probes: { p: DocPort; desc?: string }[] = [
        ...(def.inputs ?? []).map((p) => ({ p, desc: def.docs!.inputs?.[p.id] })),
        ...(def.outputs ?? []).map((p) => ({ p, desc: def.docs!.outputs?.[p.id] })),
      ];
      for (const { p, desc } of probes) {
        if (!p.edge) continue; // ← DELIBERATE HERE: undeclared ports are the
        // subject of the DEDICATED clause below, not silently dropped. The
        // split matters: this clause is about prose-vs-declaration agreement
        // and is meaningless without a declaration to disagree with.
        if (!desc) continue;
        const ownVocab = p.edge === 'trigger' ? TRIGGER_VOCAB : GATE_VOCAB;
        if (!hasAny(desc, ownVocab)) {
          mismatches.push(
            `${def.type}.${p.id}: declared edge='${p.edge}' but its doc uses no ${p.edge} vocabulary — "${desc}"`,
          );
        }
      }
    }
    expect(mismatches.join('\n'), 'edge/gate doc vocabulary mismatch — fix the prose or the declared edge').toBe('');
  });

  it('EVERY gate-cable port declares `edge`, or is named in the ledger (deny-by-default)', () => {
    const ports = gatePorts();
    const known = new Set(undeclaredEdgePairs());
    const undeclared: string[] = [];
    for (const p of ports) {
      if (p.edge) continue;
      const pair = `${p.type}.${p.id}`;
      if (known.has(pair)) continue;
      undeclared.push(`${pair} (${p.dir})`);
    }
    expect(
      undeclared.sort().join('\n'),
      `gate-cable port(s) with NO \`edge\` declaration and no ledger entry.\n` +
        `A trigger fires ONCE per rising edge; a gate acts WHILE high. The consumer's\n` +
        `interpretation is DECLARED on the port ($lib/audio/gate-trigger), and an\n` +
        `undeclared port is UNCHECKED, not exempt — the vocabulary clause above cannot\n` +
        `see it. Declare \`edge: 'trigger' | 'gate'\` (then \`task docs:accept\`), or add it\n` +
        `to packages/web/src/lib/docs/undeclared-edge-ledger.ts.`,
    ).toBe('');
  });

  it('the edge ledger is anchored to the DEFS — no stale entries', () => {
    // Ground truth is the def, not the list. An entry for a port that has since
    // declared `edge` (or been deleted) is an exemption nobody is watching, and
    // it would silently re-exempt a future undeclared port of the same name.
    const live = new Map(gatePorts().map((p) => [`${p.type}.${p.id}`, p]));
    const stale: string[] = [];
    for (const [type, ids] of Object.entries(UNDECLARED_EDGE_DEBT)) {
      for (const id of ids) {
        const p = live.get(`${type}.${id}`);
        if (!p) stale.push(`${type}.${id} — no such gate-cable port`);
        else if (p.edge) stale.push(`${type}.${id} — now declares edge='${p.edge}'`);
      }
    }
    expect(
      stale.sort().join('\n'),
      'stale edge-ledger entr(ies) — delete them AND lower UNDECLARED_EDGE_CEILING by the same count',
    ).toBe('');
  });

  it('the edge ratchet moves in BOTH directions, and reports COVERAGE not a bare number', () => {
    const ports = gatePorts();
    const declared = ports.filter((p) => p.edge).length;
    const pairs = undeclaredEdgePairs().length;
    const pct = ((declared / ports.length) * 100).toFixed(1);
    const breakdown =
      `gate-cable ports: ${ports.length} | declared+checked: ${declared} (${pct}%) | ` +
      `undeclared (ledgered): ${pairs} across ${Object.keys(UNDECLARED_EDGE_DEBT).length} modules`;

    expect(pairs, `undeclared-edge debt GREW. ${breakdown}`).toBeLessThanOrEqual(
      UNDECLARED_EDGE_CEILING,
    );
    // A ceiling can only trip by GROWING, so assert the other direction too: a
    // drain that declares an edge and forgets to lower the number passes in
    // total silence and leaves slack for the next undeclared port.
    expect(
      UNDECLARED_EDGE_CEILING - pairs,
      `undeclared-edge debt is ${pairs} but UNDECLARED_EDGE_CEILING still says ` +
        `${UNDECLARED_EDGE_CEILING} — lower it by the difference in the SAME commit. ${breakdown}`,
    ).toBe(0);
  });

  it('NEGATIVE CONTROL: the deny-by-default clause really fires on a missing declaration', () => {
    // ⚠ A textual/structural gate that matches nothing looks exactly like a
    // clean tree. Perturb the thing the clause claims to measure and confirm
    // the answer MOVES — in both directions — on every run, not once at
    // authoring time.
    const known = new Set(undeclaredEdgePairs());
    const check = (p: { type: string; id: string; edge?: 'trigger' | 'gate' }) =>
      !!p.edge || known.has(`${p.type}.${p.id}`);

    // (a) a NEW gate port that declares nothing and is not ledgered → caught.
    expect(check({ type: 'brandNew', id: 'strike' }), 'undeclared + unledgered must FAIL').toBe(false);
    // (b) the same port, once it declares an edge → passes.
    expect(check({ type: 'brandNew', id: 'strike', edge: 'trigger' }), 'declared must PASS').toBe(true);
    // (c) a real ledgered port passes today…
    expect(check({ type: 'qbrt', id: 'ping' }), 'ledgered must PASS').toBe(true);
    // (d) …and the ledger is not vacuously matching everything.
    expect(check({ type: 'qbrt', id: 'not_a_port' }), 'the ledger must not match by module alone').toBe(
      false,
    );
  });
});

describe('module-docs lint — controlFamilies match the card (no drift)', () => {
  it('every declared controlFamily.testidPrefix actually appears in the card source', () => {
    const cards = allCardSource();
    const missing: string[] = [];
    for (const def of allDefs()) {
      for (const f of def.controlFamilies ?? []) {
        // The card emits `${testidPrefix}-${nodeId}-${i}` — so the literal
        // prefix string must appear somewhere in card markup. PRESENCE-ONLY:
        // proves the family exists, not that its member COUNT is right (the
        // DOM-scan oracle, a later phase, verifies size).
        if (!cards.includes(f.testidPrefix)) {
          missing.push(`${def.type}: controlFamily '${f.id}' testidPrefix '${f.testidPrefix}' not found in any card`);
        }
      }
    }
    expect(missing.join('\n'), 'declared control family has no matching card testid — the flag drifted off the card').toBe('');
  });
});

describe('module-docs lint — STRICT_DOCS RATCHET (only grows)', () => {
  // STRICT_DOCS is an OPT-IN allowlist: a module is promoted here once its
  // co-located docs are authored + verified (see strict-docs.ts). This cap
  // FREEZES the set at today's size so it can only GROW — REMOVING a module
  // (un-promoting / shrinking documentation coverage) fails this test on purpose.
  //   RATCHET RULE: strict lists only grow. RAISE the number when you promote a
  //   module. Only LOWER it for a real, justified un-promotion — NEVER to make a
  //   red docs gate go green.
  it('STRICT_DOCS never shrinks below its frozen floor', () => {
    // 178→169 (2026-07-07): the 15-module deletion PR removed the 14 STRICT
    // members among them (chowkick / riotgirls / atlantisCatalyst / grids /
    // peaks / stages / symbiote / veils / warps / aquaTank / elements / tides2 /
    // qbert / snes9x) — a real un-promotion via module deletion, not a gate
    // dodge. (The old floor had lagged the list's actual size.)
    // 169→170 (2026-07-19): +1 frametable (video wavetable oscillator — born
    // strict, docs authored + verified against the source).
    // 170→171 (2026-07-19): +1 videocube (video isomorph of audio CUBE — born
    // strict, docs authored + verified against the source).
    // 171→172 (2026-07-21): +1 cvBuddy (ES-9 note-lane sink — born strict, docs
    // authored + verified against the source).
    expect(
      STRICT_DOCS.size,
      'STRICT_DOCS shrank below its frozen floor — see the RATCHET rule above',
    ).toBeGreaterThanOrEqual(172);
  });
});
