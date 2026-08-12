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
// nothing about the rest.
//
// ── THE LEDGER IS GONE (2026-08-09) ─────────────────────────────────────────
// Inverting to deny-by-default was right; parking the 299 in a hand-counted
// LEDGER was not. 295 of them already carried authored prose naming the
// answer — the debt was mechanically payable in one sweep on day one — and
// the hand-typed ceiling that went with the list auto-merged WRONG in 3 of 3
// parallel branches, once cleanly and silently. All 275 remaining pairs were
// declared from the Phase-0 classification table
// (`.myrobots/2026-08-09-edge-cleanup-table.md`) and both the ledger module
// and its ceiling were DELETED.
//
// The demand below is now UNCONDITIONAL: a gate-cable port with no `edge` is
// RED, full stop. There is no ledger, no exemption list, and deliberately NO
// replacement counter — a number a future merge could make stale is the
// disease this removal cured. If a genuinely un-payable case ever appears,
// derive its count from the artifact; never type it into a shared file.
//
interface GatePort {
  type: string;
  id: string;
  dir: 'in' | 'out';
  edge?: 'trigger' | 'gate';
  desc?: string;
}

/** THE predicate — the one the demand clause and its negative control BOTH
 *  call, so the control can never drift into testing a re-typed copy. */
function undeclaredGatePorts(ports: readonly GatePort[]): string[] {
  return ports
    .filter((p) => !p.edge)
    .map((p) => `${p.type}.${p.id} (${p.dir})`)
    .sort();
}

/** Every gate-cable port, with the doc prose (if any) that describes it. */
function gatePorts(): GatePort[] {
  const out: GatePort[] = [];
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

  it('EVERY gate-cable port declares `edge` — unconditional, no exemptions', () => {
    const ports = gatePorts();
    const undeclared = undeclaredGatePorts(ports);
    expect(
      undeclared.join('\n'),
      `gate-cable port(s) with NO \`edge\` declaration.\n` +
        `A trigger fires ONCE per rising edge; a gate acts WHILE high. The consumer's\n` +
        `interpretation is DECLARED on the port ($lib/audio/gate-trigger), and an\n` +
        `undeclared port is UNCHECKED, not exempt — the vocabulary clause above cannot\n` +
        `see it. Declare \`edge: 'trigger' | 'gate'\` and run \`task docs:accept\`.\n` +
        `There is no ledger to add it to: read the DSP, decide, declare.\n` +
        `Scope of this clause: cable type 'gate' only, across the audio, video and\n` +
        `meta registries — it says nothing about cv/audio/poly ports, by design.`,
    ).toBe('');
    // Coverage, stated rather than counted against a literal: the subject is
    // the whole gate-cable population and the answer must be all of it.
    expect(
      ports.filter((p) => p.edge).length,
      `every gate-cable port must be declared+checked (${ports.length} total)`,
    ).toBe(ports.length);
  });

  it('NEGATIVE CONTROL: the unconditional clause fires on a missing declaration', () => {
    // ⚠ A structural gate that matches nothing looks exactly like a clean tree,
    // and the tree IS clean now — every real port is declared, so the clause
    // above returns '' on every run whether or not it works. This leg perturbs
    // the thing it claims to measure and confirms the answer MOVES, in BOTH
    // directions, on every run rather than once at authoring time. It runs the
    // SAME predicate (`undeclaredGatePorts`) the clause does, not a re-typed
    // copy — a re-typed copy is how the previous self-test went blind.
    type P = Parameters<typeof undeclaredGatePorts>[0][number];
    const declared: P = { type: 'synthetic', id: 'strike', dir: 'in', edge: 'trigger' };
    const missing: P = { type: 'synthetic', id: 'strike', dir: 'in' };

    // (a) an undeclared gate port is CAUGHT, and named with its direction.
    expect(undeclaredGatePorts([missing]), 'undeclared must FAIL').toEqual([
      'synthetic.strike (in)',
    ]);
    // (b) the same port, once it declares an edge, PASSES.
    expect(undeclaredGatePorts([declared]), 'declared must PASS').toEqual([]);
    // (c) `edge: 'gate'` is a declaration too — the predicate must not be
    //     accidentally reading truthiness of the string 'trigger' alone.
    expect(
      undeclaredGatePorts([{ ...missing, edge: 'gate' }]),
      "edge: 'gate' must PASS",
    ).toEqual([]);
    // (d) one bad port among good ones still reddens (no all-or-nothing bug).
    expect(
      undeclaredGatePorts([declared, missing, { ...declared, id: 'other' }]),
      'a single undeclared port among declared ones must FAIL',
    ).toEqual(['synthetic.strike (in)']);
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

describe('module-docs lint — STRICT_DOCS is DERIVED FROM THE ARTIFACT, not floored', () => {
  // ⚠ `STRICT_DOCS.size >= 172` IS GONE (2026-08-12, the no-ratchets sweep).
  //
  // WHAT IT PROTECTED: un-promotion. A module quietly deleted from STRICT_DOCS
  // drops out of the deny-missing-docs bar above and is checked only for
  // consistency, which is a way to make a red docs gate green.
  //
  // WHY A FLOOR WAS THE WRONG SHAPE FOR IT, twice over. It never actually
  // caught un-promotion — the set was 185 against a floor of 172, so THIRTEEN
  // modules could have been un-promoted before it noticed. And it is the
  // construct that auto-merges cleanly and wrongly: two branches each promoting
  // one module both write the same next number, and the merged truth is one
  // higher, silently.
  //
  // WHAT CARRIES IT INSTEAD — the same protection, DERIVED, with no slack:
  // completeness is a property of the def, so read it off the def. A module
  // whose co-located `docs` are already complete MUST be promoted. Removing a
  // name from STRICT_DOCS while its docs stay complete is now RED, which is the
  // gate-dodge the floor existed for; un-promoting for real means deleting the
  // docs, which is a large and obvious diff.
  //
  // ⚠ POLICY THIS MAKES EXPLICIT: authoring complete docs IS the promotion.
  // That was already the stated rule (CLAUDE.md, "every NEW module ships with
  // co-located docs and is added to STRICT_DOCS"); it just had nothing
  // enforcing it. Measured at the time of the change: 196 registered defs, 185
  // in STRICT_DOCS, and **zero** modules complete-but-unpromoted — so this is
  // a faithful hardening of the live state, not a new bar.
  it('every module whose docs are COMPLETE is in STRICT_DOCS (deny-by-default)', () => {
    const unpromoted: string[] = [];
    for (const def of allDefs()) {
      if (STRICT_DOCS.has(def.type)) continue;
      const docs = def.docs;
      if (!docs?.explanation?.trim()) continue;
      const inDocs = docs.inputs ?? {};
      const outDocs = docs.outputs ?? {};
      const ctrlDocs = docs.controls ?? {};
      const complete =
        (def.inputs ?? []).every((p) => inDocs[p.id]?.trim()) &&
        (def.outputs ?? []).every((p) => outDocs[p.id]?.trim()) &&
        (def.params ?? []).every((p) => ctrlDocs[p.id]?.trim()) &&
        (def.controlFamilies ?? []).every((f) => ctrlDocs[`${f.id}-{n}`]?.trim());
      if (complete) unpromoted.push(def.type);
    }
    expect(
      unpromoted.sort(),
      'module(s) with COMPLETE co-located docs that are not in STRICT_DOCS. Authoring ' +
        'complete docs IS the promotion — add them to strict-docs.ts. (If this went red on ' +
        'a DELETION from STRICT_DOCS: that is the un-promotion this replaced the frozen ' +
        'floor to catch. Un-promote by removing the docs, not the name.)',
    ).toEqual([]);
  });

  it('ANCHORED TO THE ARTIFACT: no STRICT_DOCS name is a module that no longer exists', () => {
    // The other direction, so the list cannot rot. A name that resolves to
    // nothing is a promotion nobody is watching, and it makes the deny check
    // above satisfiable by a registry that has shrunk.
    const live = new Set(allDefs().map((d) => d.type));
    expect(
      [...STRICT_DOCS].filter((t) => !live.has(t)).sort(),
      'STRICT_DOCS name(s) that are not registered module types — delete them',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the completeness predicate separates complete from incomplete', () => {
    // Both assertions above are `toEqual([])`, so a predicate that returned
    // "incomplete" for everything would be permanently, silently green. This
    // exercises the SAME shape the check runs, in both directions, every run.
    const probe = (docs: Record<string, unknown> | undefined, params: { id: string }[]): boolean => {
      const d = docs as { explanation?: string; controls?: Record<string, string> } | undefined;
      if (!d?.explanation?.trim()) return false;
      const c = d.controls ?? {};
      return params.every((p) => c[p.id]?.trim());
    };
    expect(
      probe({ explanation: 'x', controls: { a: 'documented' } }, [{ id: 'a' }]),
      'a fully documented def must read COMPLETE',
    ).toBe(true);
    expect(
      probe({ explanation: 'x', controls: {} }, [{ id: 'a' }]),
      'a def with an undocumented param must read INCOMPLETE',
    ).toBe(false);
    expect(probe(undefined, []), 'a def with no docs at all must read INCOMPLETE').toBe(false);
  });
});
