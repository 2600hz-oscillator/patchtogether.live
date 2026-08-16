// packages/web/src/lib/midi/graph-param-dispatch.test.ts
//
// #1727 — THE COVERAGE + STRUCTURE GATE for the graph-resolved MIDI delivery
// path. The e2e (`e2e/tests/midi-binding-node-lifetime.spec.ts`) proves the
// WIRING on one module in a real browser; this proves the CLAIM the wiring is
// only worth having if it holds: that the delivery resolves for EVERY declared
// param of EVERY registered module, and that nothing can switch it off.
//
// ── WHAT THIS GATE IS STRUCTURALLY UNABLE TO SEE, stated inside the gate ─────
//   * Whether the value ARRIVES. Resolution is a pure lookup; the runtime leg
//     below drives one real dispatch through the real store, and the e2e drives
//     the whole browser path. A green resolve says the target exists, not that
//     a message reached it.
//   * A CARD that re-typed a range next to its knob. Every check here reads the
//     DEF, which is the one side this path uses. The other side of that
//     two-sided contract is unreadable from any runtime gate (the ±0.2-vs-±1
//     class); this path does not create that divergence and does not hide it.
//   * A `paramId` that is NOT a declared ParamDef (TOYBOX's layer-qualified
//     ids, card-local pseudo-params) and a NOTE bound to a card BUTTON. Those
//     are DECLINED by design — asserted below, in both directions, so
//     "declines" can never quietly become "silently drops everything".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as dispatch from './graph-param-dispatch';
import {
  resolveCcTargetForType,
  resolveGateTarget,
  resolveCcTarget,
  splitBindingKey,
  deliverCcToGraph,
  flushGraphCcCommits,
} from './graph-param-dispatch';
import {
  ccValueToParamValue,
  bindingKey,
  importBindings,
  registerSetter,
  unregisterSetter,
  __test_setAccess,
  __test_clearBindings,
} from './midi-learn.svelte';
import { shellParamWrite } from '$lib/ui/workflow/shell-param-writes';
import { patch } from '$lib/graph/store';
import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import '$lib/audio/modules'; // side-effect: register the audio defs
import '$lib/video/modules'; // side-effect: register the video defs
import '$lib/meta/modules'; // side-effect: register the meta defs
import type { MidiAccessLike, MidiInputLike, MidiEventLike } from '$lib/audio/modules/midi-cv-buddy';
import type { ModuleNode, ParamDef, PortDef } from '$lib/graph/types';

/** A fake MIDIAccess with one input, so a CC can be pushed through the REAL
 *  `handleMidi` → `handleCc` dispatch path (the same seam hardware uses).
 *  Mirrors `midi-learn.test.ts`'s helper. */
function makeFakeAccess(): { access: MidiAccessLike; sendCc: (ch: number, cc: number, v: number) => void } {
  let handler: ((ev: MidiEventLike) => void) | null = null;
  const input: MidiInputLike = {
    id: 'gpd-fake-input-0',
    name: 'Fake Controller',
    manufacturer: 'test',
    state: 'connected',
    get onmidimessage() { return handler; },
    set onmidimessage(h) { handler = h; },
  };
  const inputs = new Map<string, MidiInputLike>([[input.id, input]]);
  return {
    access: { inputs, onstatechange: null },
    sendCc: (ch, cc, v) => {
      handler?.({ data: new Uint8Array([0xb0 | (ch & 0x0f), cc & 0x7f, v & 0x7f]), timeStamp: 0 });
    },
  };
}

interface DefLike {
  type: string;
  params?: readonly ParamDef[];
  inputs?: readonly PortDef[];
}

/** Every registered def, from all three domain registries. */
function allDefs(): DefLike[] {
  return [
    ...(listModuleDefs() as unknown as DefLike[]),
    ...(listVideoModuleDefs() as unknown as DefLike[]),
    ...(listMetaModuleDefs() as unknown as DefLike[]),
  ];
}

describe('#1727 · graph-resolved MIDI delivery — coverage', () => {
  it('resolves EVERY declared param of EVERY registered module, at the DEF\'s exact range', () => {
    const offenders: string[] = [];
    const typesSeen = new Set<string>();

    for (const def of allDefs()) {
      typesSeen.add(def.type);
      for (const p of def.params ?? []) {
        const t = resolveCcTargetForType(def.type, p.id);
        if (!t) {
          offenders.push(`${def.type}.${p.id}: resolveCcTargetForType returned null`);
          continue;
        }
        // The range must be the DEF's, not a 0..1 default or a re-typed copy.
        // A silently-wrong range is the failure mode a "did it resolve" check
        // would sail past, so the VALUES are asserted, not just the presence.
        if (t.min !== p.min || t.max !== p.max) {
          offenders.push(
            `${def.type}.${p.id}: resolved [${t.min}, ${t.max}] but the def declares [${p.min}, ${p.max}]`,
          );
        }
      }
    }

    // NOT a count: the SET of types the scan walked must be exactly the set the
    // registries publish. A registry that failed to populate (the way a missing
    // barrel import makes a scan vacuous) fails here rather than passing with
    // an empty offender list.
    expect(
      [...typesSeen].sort(),
      'the scan must walk every registered module type — a partially-loaded registry ' +
        'makes an empty offender list meaningless',
    ).toEqual([...new Set(allDefs().map((d) => d.type))].sort());

    expect(
      offenders,
      '#1727: a declared param that this path cannot resolve is a MIDI binding that goes ' +
        'silent the moment no control is mounted for it.\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('PERMANENT NEGATIVE CONTROL (both directions): the SAME predicate declines what it should', () => {
    // Direction 1 — an unknown param on a REAL module. Derived, not hand-typed:
    // take the first registered def that declares any param.
    const def = allDefs().find((d) => (d.params?.length ?? 0) > 0)!;
    expect(def, 'no registered def declares a param — the registries did not load').toBeTruthy();
    const realParam = def.params![0]!;

    // The predicate CAN say yes (this is the positive half — a negative control
    // that only ever returns null proves nothing).
    expect(resolveCcTargetForType(def.type, realParam.id)).toEqual({
      min: realParam.min,
      max: realParam.max,
      moduleType: def.type,
    });

    // …and it CAN say no, for each of the two independent reasons.
    const bogusParam = '__not_a_declared_param__';
    expect(def.params!.some((p) => p.id === bogusParam), 'fixture param id must not exist').toBe(false);
    expect(
      resolveCcTargetForType(def.type, bogusParam),
      'an undeclared param must DECLINE — inventing a graph key for a card-local ' +
        'pseudo-param would write a value nothing reads',
    ).toBeNull();

    const bogusType = '__not_a_registered_module__';
    expect(allDefs().some((d) => d.type === bogusType), 'fixture type must not exist').toBe(false);
    expect(resolveCcTargetForType(bogusType, realParam.id)).toBeNull();
  });

  it('STRUCTURE: nothing here can be un-registered, disposed or released', () => {
    // The registry precedents in this family (#1531, #1574, #1729) guard the
    // node-lifetime rule by having NO teardown method, so `tsc` refuses the
    // wrong call. This path has no lease at all — it resolves at dispatch time —
    // and this is the artifact-anchored statement of that: a future
    // `unregisterGraphSetter` would re-create exactly the seam #1727 is.
    //
    // `flush` is deliberately allowed: it can only make a staged write land
    // SOONER, never make a future message silent.
    const forbidden = Object.keys(dispatch).filter((k) =>
      /^(register|unregister|dispose|destroy|teardown|release|revoke|detach|unbind)/i.test(k),
    );
    expect(
      forbidden,
      'graph-param-dispatch must expose no handle a view can revoke — delivery is a property ' +
        'of the graph, not a lease a card holds. Exports found: ' + Object.keys(dispatch).join(', '),
    ).toEqual([]);
  });
});

describe('#1727 · graph-resolved MIDI delivery — runtime, against the REAL store', () => {
  const NODE = 'gpd-test-node';
  const OTHER = 'gpd-test-other';

  /** A registered audio def with a param that (a) has a range other than [0,1],
   *  so a scaling bug cannot pass by coincidence, and (b) has NO PF-13 macro
   *  write override — an override deliberately does not write its own flat key,
   *  so it would make the durable assertion below read as a miss. Derived, so
   *  registration order cannot silently change the fixture into one of those. */
  const subject = (() => {
    for (const d of listModuleDefs() as unknown as DefLike[]) {
      const p = (d.params ?? []).find(
        (q) => (q.min !== 0 || q.max !== 1) && shellParamWrite(d.type, q.id) === null,
      );
      if (p) return { type: d.type, param: p };
    }
    throw new Error('no registered audio def declares a plain non-[0,1] param — cannot build the fixture');
  })();

  function node(id: string, type: string): ModuleNode {
    return { id, type, domain: 'audio', position: { x: 0, y: 0 }, params: {}, data: {} } as unknown as ModuleNode;
  }

  beforeEach(() => {
    patch.nodes[NODE] = node(NODE, subject.type);
  });
  /** The syncedStore proxy throws on deleting an absent key, so drop only what
   *  is actually there. */
  function drop(id: string): void {
    if (patch.nodes[id]) delete patch.nodes[id];
  }

  afterEach(() => {
    flushGraphCcCommits();
    drop(NODE);
    drop(OTHER);
  });

  it('writes the DEF-scaled value onto the live node with NO control mounted anywhere', async () => {
    const cc = 100;
    const delivered = deliverCcToGraph(NODE, subject.param.id, cc);
    flushGraphCcCommits();
    await Promise.resolve();

    const expected = ccValueToParamValue(cc, subject.param.min, subject.param.max);
    const got = (patch.nodes[NODE] as ModuleNode).params?.[subject.param.id];
    expect(
      { delivered, got },
      `${subject.type}.${subject.param.id} (range [${subject.param.min}, ${subject.param.max}]) ` +
        `must take the def-scaled value of CC ${cc}`,
    ).toEqual({ delivered: true, got: expected });
  });

  it('uses the SAME scaling as the mounted-control path (one contract, two delivery paths)', async () => {
    // The mounted path scales with midi-learn's `ccValueToParamValue`; this path
    // scales against the def. If those ever diverge, the same physical knob
    // means two different values depending on whether a card happens to be open
    // — which is the class of bug #1727 belongs to, in a new costume.
    for (const cc of [0, 1, 63, 64, 127]) {
      deliverCcToGraph(NODE, subject.param.id, cc);
      flushGraphCcCommits();
      await Promise.resolve();
      expect(
        (patch.nodes[NODE] as ModuleNode).params?.[subject.param.id],
        `CC ${cc} must scale identically on both delivery paths`,
      ).toBe(ccValueToParamValue(cc, subject.param.min, subject.param.max));
    }
  });

  it('DECLINES (and writes nothing) for an absent node or an undeclared param', async () => {
    expect(deliverCcToGraph('no-such-node', subject.param.id, 64)).toBe(false);
    expect(deliverCcToGraph(NODE, '__not_a_declared_param__', 64)).toBe(false);
    flushGraphCcCommits();
    await Promise.resolve();
    expect(
      (patch.nodes[NODE] as ModuleNode).params?.['__not_a_declared_param__'],
      'a declined delivery must write NOTHING — not a 0, not a default',
    ).toBeUndefined();
  });

  it('resolves a binding key back to (node, param) off the LIVE GRAPH, not off a delimiter guess', () => {
    expect(splitBindingKey(`${NODE}:${subject.param.id}`)).toEqual({
      moduleId: NODE,
      paramId: subject.param.id,
    });
    // A node id that itself contains the delimiter — "split on the first colon"
    // gets this wrong, matching against the live graph does not.
    const COLON_ID = 'rack:1:node';
    patch.nodes[COLON_ID] = node(COLON_ID, subject.type);
    try {
      expect(splitBindingKey(`${COLON_ID}:${subject.param.id}`)).toEqual({
        moduleId: COLON_ID,
        paramId: subject.param.id,
      });
    } finally {
      drop(COLON_ID);
    }
    // NEGATIVE CONTROL, same predicate: a key whose node has left the graph has
    // nothing to deliver to.
    expect(splitBindingKey('gone-node:whatever')).toBeNull();
  });

  // ── THE DEFECT ITSELF, driven through the REAL dispatch path ──────────────
  //
  // Everything above tests the resolver. This tests what #1727 actually was: a
  // CC arriving on a real MIDI input, a binding present, and NO control mounted
  // for it. Before the fix `handleCc` looked the key up in `setters`, found
  // nothing, and returned.
  describe('an inbound CC with a binding and NO registered setter', () => {
    const CH = 0;
    const CC = 21;
    const OTHER_CC = 99;
    let sendCc: (ch: number, cc: number, v: number) => void;

    beforeEach(() => {
      __test_clearBindings();
      const fake = makeFakeAccess();
      sendCc = fake.sendCc;
      __test_setAccess(fake.access);
      importBindings([
        { kind: 'cc', key: bindingKey(NODE, subject.param.id), channel: CH, cc: CC, learnedAt: Date.now() },
      ]);
    });
    afterEach(() => {
      __test_clearBindings();
      __test_setAccess(null);
    });

    it('lands on the graph (#1727 — this returned silently before the fix)', async () => {
      sendCc(CH, CC, 127);
      flushGraphCcCommits();
      await Promise.resolve();
      expect(
        (patch.nodes[NODE] as ModuleNode).params?.[subject.param.id],
        `#1727: ${subject.type}.${subject.param.id} — a persisted binding must deliver with no ` +
          'control mounted anywhere. The binding is present and the message reached handleMidi; ' +
          'if this is undefined the delivery path is gone again.',
      ).toBe(ccValueToParamValue(127, subject.param.min, subject.param.max));
    });

    it('PERMANENT NEGATIVE CONTROL: a CC on a DIFFERENT number writes nothing', async () => {
      sendCc(CH, OTHER_CC, 127);
      flushGraphCcCommits();
      await Promise.resolve();
      expect(
        (patch.nodes[NODE] as ModuleNode).params?.[subject.param.id],
        'the fallback must still be ADDRESSED — a path that writes on every message would pass ' +
          'the test above while being a worse bug',
      ).toBeUndefined();
    });

    it('a MOUNTED control still wins, and the graph path does NOT also fire', async () => {
      const seen: number[] = [];
      registerSetter(NODE, subject.param.id, {
        min: subject.param.min,
        max: subject.param.max,
        onchange: (v) => seen.push(v),
      });
      try {
        sendCc(CH, CC, 64);
        flushGraphCcCommits();
        await Promise.resolve();
        expect(seen, 'the registered setter must receive the message').toEqual([
          ccValueToParamValue(64, subject.param.min, subject.param.max),
        ]);
        expect(
          (patch.nodes[NODE] as ModuleNode).params?.[subject.param.id],
          'the graph path must NOT also write — a card owns its own commit (bespoke writers, ' +
            'macro overrides), and a double write would fight it',
        ).toBeUndefined();
      } finally {
        unregisterSetter(NODE, subject.param.id);
      }
    });
  });

  it('resolveCcTarget / resolveGateTarget agree with the live node\'s type', () => {
    expect(resolveCcTarget(NODE, subject.param.id)).toEqual({
      min: subject.param.min,
      max: subject.param.max,
      moduleType: subject.type,
    });
    expect(resolveCcTarget('no-such-node', subject.param.id)).toBeNull();

    // GATE half: a declared `gate` INPUT resolves; an OUTPUT and a non-gate
    // input do not. Derived from the registries — the first def that has one.
    const gated = (listModuleDefs() as unknown as DefLike[]).find((d) =>
      (d.inputs ?? []).some((p) => p.type === 'gate'),
    );
    expect(gated, 'no registered audio def declares a gate input — fixture cannot be built').toBeTruthy();
    const gatePort = gated!.inputs!.find((p) => p.type === 'gate')!;
    const nonGate = gated!.inputs!.find((p) => p.type !== 'gate');
    patch.nodes[OTHER] = node(OTHER, gated!.type);
    expect(resolveGateTarget(OTHER, gatePort.id)).toEqual({ moduleType: gated!.type });
    if (nonGate) expect(resolveGateTarget(OTHER, nonGate.id)).toBeNull();
    expect(resolveGateTarget(OTHER, '__not_a_port__')).toBeNull();
  });
});
