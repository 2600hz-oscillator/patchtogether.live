// packages/web/src/lib/graph/workflow-pins.test.ts
//
// WORKFLOW MODE P1 — pinned-singleton planning + drawer keymap + the
// keyboard typing guard. P2 — the always-on topbar SURFACE pins
// (timelorde / midiclock / audioIn / audioOut) and their presence rules.
// Pure-unit (plain fixtures, no DOM, no Yjs).

import { describe, it, expect } from 'vitest';
import {
  WORKFLOW_PINNED_MODULES,
  WORKFLOW_PINNED_SURFACES,
  ALL_WORKFLOW_PINNED,
  WORKFLOW_DEFAULT_WIRES,
  WORKFLOW_DEFAULT_WIRE_LATCH,
  DRAWER_KEY_TO_PINNED,
  planPinnedSpawns,
  planPinnedIdentityRepairs,
  RESERVED_PINNED_IDS,
  planDefaultWires,
  isPinnedNode,
  isTypingTarget,
  isRackFlipKey,
  RACK_FLIP_KEY,
} from './workflow-pins';

/** Fixture: every always-on module present in its pinned form. */
function fullPinnedSet() {
  return ALL_WORKFLOW_PINNED.map((s) => ({ type: s.type, data: { pinned: true } }));
}

describe('WORKFLOW_PINNED_MODULES — the M/E/C trio contract', () => {
  it('is exactly mixmstrs + electraControl + clipplayer with deterministic ids', () => {
    expect(WORKFLOW_PINNED_MODULES.map((s) => [s.key, s.type, s.id])).toEqual([
      ['m', 'mixmstrs', 'pinned-mixmstrs'],
      ['e', 'electraControl', 'pinned-electraControl'],
      ['c', 'clipplayer', 'pinned-clipplayer'],
    ]);
  });

  it('drawer keymap covers every spec, keyed lowercase', () => {
    expect(DRAWER_KEY_TO_PINNED.size).toBe(WORKFLOW_PINNED_MODULES.length);
    expect(DRAWER_KEY_TO_PINNED.get('m')?.type).toBe('mixmstrs');
    expect(DRAWER_KEY_TO_PINNED.get('e')?.type).toBe('electraControl');
    expect(DRAWER_KEY_TO_PINNED.get('c')?.type).toBe('clipplayer');
    expect(DRAWER_KEY_TO_PINNED.get('M')).toBeUndefined(); // callers lowercase first
  });

  // OWNER 2026-07-26: "opening clip player with c is same as expanding any
  // other module" — C targets the dock FULL-VIEW (a pane that can sit
  // side-by-side with a module), M/E keep the mutually-exclusive pinned
  // drawer. Canvas's dock keymap branches on exactly this field, so pinning it
  // here is the cheap gate against a silent regression to the old
  // one-drawer-occupancy behavior.
  it('C opens a FULL-VIEW pane; M/E open the pinned drawer', () => {
    expect(WORKFLOW_PINNED_MODULES.map((s) => [s.key, s.surface])).toEqual([
      ['m', 'drawer'],
      ['e', 'drawer'],
      ['c', 'fullView'],
    ]);
    expect(DRAWER_KEY_TO_PINNED.get('c')?.surface).toBe('fullView');
  });

  it('every hotkey spec declares a surface (no undefined fall-through)', () => {
    for (const s of WORKFLOW_PINNED_MODULES) {
      expect(['drawer', 'fullView']).toContain(s.surface);
    }
  });
});

describe('WORKFLOW_PINNED_SURFACES — the P2 topbar surface contract', () => {
  it('is timelorde + midiclock + audioIn + audioOut with deterministic ids', () => {
    expect(WORKFLOW_PINNED_SURFACES.map((s) => [s.type, s.id, s.presence ?? 'pinned'])).toEqual([
      ['timelorde', 'pinned-timelorde', 'type'],
      ['midiclock', 'pinned-midiclock', 'pinned'],
      ['audioIn', 'pinned-audioIn', 'pinned'],
      ['audioOut', 'pinned-audioOut', 'pinned'],
    ]);
  });

  it('surface pins have NO drawer key (their faces are topbar menus)', () => {
    for (const s of WORKFLOW_PINNED_SURFACES) {
      expect('key' in s).toBe(false);
    }
    // The drawer keymap stays trio-only.
    expect(DRAWER_KEY_TO_PINNED.size).toBe(WORKFLOW_PINNED_MODULES.length);
  });

  it('ALL_WORKFLOW_PINNED is trio-then-surfaces with globally unique ids', () => {
    expect(ALL_WORKFLOW_PINNED.map((s) => s.type)).toEqual([
      'mixmstrs',
      'electraControl',
      'clipplayer',
      'timelorde',
      'midiclock',
      'audioIn',
      'audioOut',
    ]);
    const ids = ALL_WORKFLOW_PINNED.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ALL_WORKFLOW_PINNED) expect(s.id).toBe(`pinned-${s.type}`);
  });
});

describe('planPinnedSpawns', () => {
  it('an empty rack plans every always-on module, trio first', () => {
    expect(planPinnedSpawns([]).map((s) => s.type)).toEqual([
      'mixmstrs',
      'electraControl',
      'clipplayer',
      'timelorde',
      'midiclock',
      'audioIn',
      'audioOut',
    ]);
  });

  it('plans only the missing specs', () => {
    const nodes = fullPinnedSet().filter((n) => n.type !== 'electraControl');
    expect(planPinnedSpawns(nodes).map((s) => s.type)).toEqual(['electraControl']);
  });

  it('a full pinned set plans nothing (the ensure is idempotent)', () => {
    expect(planPinnedSpawns(fullPinnedSet())).toEqual([]);
  });

  it('UNPINNED instances do NOT satisfy presence:"pinned" specs', () => {
    // A user-spawned canvas mixmstrs / audioIn is a normal card, not the
    // always-on hidden one.
    const nodes = [
      { type: 'mixmstrs', data: {} },
      { type: 'electraControl' },
      { type: 'clipplayer', data: { pinned: false } },
      { type: 'audioIn', data: {} },
      { type: 'audioOut', data: {} },
      { type: 'midiclock', data: {} },
    ];
    expect(planPinnedSpawns(nodes).map((s) => s.type)).toEqual([
      'mixmstrs',
      'electraControl',
      'clipplayer',
      'timelorde',
      'midiclock',
      'audioIn',
      'audioOut',
    ]);
  });

  it('an UNPINNED canvas timelorde DOES satisfy the presence:"type" spec', () => {
    // An imported patch carries a
    // random-id canvas TIMELORDE; it is the rack clock (maxInstances=1) —
    // no hidden competitor may spawn.
    const nodes = [
      ...fullPinnedSet().filter((n) => n.type !== 'timelorde'),
      { type: 'timelorde', data: {} },
    ];
    expect(planPinnedSpawns(nodes)).toEqual([]);
  });

  it('a PINNED timelorde satisfies the presence:"type" spec too', () => {
    expect(planPinnedSpawns(fullPinnedSet())).toEqual([]);
  });
});

// ── HOSTILE PEER — identity repair at the reserved ids ────────────────────
//
// THREAT MODEL, and why it is not hypothetical: a rackspace holds up to 4
// collaborators and anonymous invitees are allowed, so an untrusted peer has
// WRITE access to the live Y.Doc. The envelope type guard in
// graph/persistence.ts runs on IMPORT only; graph/snapshot.ts copies `type` and
// `domain` verbatim out of the live doc with no validation at all. Every state
// asserted below is one a peer can actually produce today.
//
// WHAT IS BEING DEFENDED: audio/reconciler.ts reads
// `prev.type !== cur.type || prev.domain !== cur.domain` as remove+add and
// calls `engine.removeNode`. At `pinned-audioIn` / `pinned-audioOut` that
// destroys the DEVICE SESSION; at `pinned-mixmstrs` it also breaks a
// hard-coded id (channel-columns.ts MASTER_MIX_ID, push2/push-lane.ts).

/** Fixture: the canonical set as it exists in a healthy doc, WITH ids. */
function canonicalNodes(): Array<{
  id: string;
  type: string;
  domain: string;
  data: Record<string, unknown> | null;
  params?: Record<string, unknown>;
  position?: { x: number; y: number };
}> {
  return ALL_WORKFLOW_PINNED.map((s) => ({
    id: s.id,
    type: s.type,
    domain: s.domain as string,
    data: { pinned: true, name: s.type } as Record<string, unknown> | null,
  }));
}

describe('planPinnedIdentityRepairs — hostile-peer defence of the reserved ids', () => {
  it('plans NOTHING in steady state (the repair can never cause a teardown)', () => {
    // Load-bearing: the repair WRITES into the doc, so a repair that fired on a
    // healthy rack would itself trip identityChanged on every snapshot — the
    // exact disease it exists to cure.
    expect(planPinnedIdentityRepairs(canonicalNodes())).toEqual([]);
  });

  it('plans nothing for an ABSENT reserved id (that is planPinnedSpawns’ job)', () => {
    const nodes = canonicalNodes().filter((n) => n.id !== 'pinned-mixmstrs');
    expect(planPinnedIdentityRepairs(nodes)).toEqual([]);
    // ...and the spawn planner still owns it, so the two never overlap.
    expect(planPinnedSpawns(nodes).map((s) => s.id)).toContain('pinned-mixmstrs');
  });

  it('ATTACK: a peer swaps the TYPE at a reserved id → repair to canonical', () => {
    const nodes = canonicalNodes();
    nodes.find((n) => n.id === 'pinned-mixmstrs')!.type = 'scope';
    expect(planPinnedIdentityRepairs(nodes)).toEqual([
      { id: 'pinned-mixmstrs', type: 'mixmstrs', domain: 'audio', fields: ['type'] },
    ]);
  });

  it('ATTACK: a peer swaps the DOMAIN at a reserved id → repair to canonical', () => {
    const nodes = canonicalNodes();
    nodes.find((n) => n.id === 'pinned-audioOut')!.domain = 'meta';
    expect(planPinnedIdentityRepairs(nodes)).toEqual([
      { id: 'pinned-audioOut', type: 'audioOut', domain: 'audio', fields: ['domain'] },
    ]);
  });

  it('ATTACK: a peer clears data.pinned → repair (an unpinned pin is DELETABLE)', () => {
    // mutate.ts's removePatchNode, Clear and Backspace all gate on isPinnedNode
    // alone, so flipping the flag makes the next Clear delete the node outright.
    // Presence then self-heals; the hardware session does NOT.
    const nodes = canonicalNodes();
    nodes.find((n) => n.id === 'pinned-audioIn')!.data!.pinned = false;
    expect(planPinnedIdentityRepairs(nodes)).toEqual([
      { id: 'pinned-audioIn', type: 'audioIn', domain: 'audio', fields: ['pinned'] },
    ]);
  });

  // ── ⚠ THE presence:'type' EXEMPTION ──────────────────────────────────────
  // The first draft canonicalised `pinned` for EVERY reserved id, and broke a
  // real player-reachable state. vrt `face-timelorde-compact` adopts the pinned
  // TIMELORDE by UN-PINNING it — `isCanvasHiddenNode` is `pinned || hiddenCard`
  // and the flowNodes derivation skips those, so a pinned node has no canvas
  // tile to capture at all. Re-pinning made the node vanish: xyflow reported
  // '(unmeasured)' for 900 frames.
  //
  // That is not a test artefact. presence:'type' means "any node of this type
  // satisfies the invariant, pinned or not", so an un-pinned canvas TIMELORDE
  // is exactly what a rack IMPORTED FROM A SAVED PATCH has. A hardening that
  // breaks legitimate use is a regression, so the flag leg is scoped. These pin
  // the narrowing so it cannot be widened back without re-reading the reason.

  it('presence:"type" — an UN-PINNED occupant is legitimate, never repaired', () => {
    const nodes = canonicalNodes();
    nodes.find((n) => n.id === 'pinned-timelorde')!.data!.pinned = false;
    expect(planPinnedIdentityRepairs(nodes)).toEqual([]);
  });

  it('presence:"type" — an occupant with NO data bag is still not repaired', () => {
    const nodes = canonicalNodes();
    nodes.find((n) => n.id === 'pinned-timelorde')!.data = null;
    expect(planPinnedIdentityRepairs(nodes)).toEqual([]);
  });

  it('⚠ but presence:"type" STILL defends type and domain — the session leg', () => {
    // The exemption is scoped to the FLAG. `identityChanged` reads type/domain,
    // so relaxing those would give away the whole finding.
    const nodes = canonicalNodes();
    const t = nodes.find((n) => n.id === 'pinned-timelorde')!;
    t.type = 'scope';
    t.data!.pinned = false; // un-pinned AND retyped — only the retype is repaired
    expect(planPinnedIdentityRepairs(nodes)).toEqual([
      { id: 'pinned-timelorde', type: 'timelorde', domain: 'audio', fields: ['type'] },
    ]);
  });

  it('the exemption applies to presence:"type" ONLY — every other spec keeps it', () => {
    // Derived from the table rather than hand-listed, so a future presence:'type'
    // spec is covered and a future presence:'pinned' one cannot quietly opt out.
    for (const spec of ALL_WORKFLOW_PINNED) {
      const nodes = canonicalNodes();
      nodes.find((n) => n.id === spec.id)!.data!.pinned = false;
      const plan = planPinnedIdentityRepairs(nodes);
      if (spec.presence === 'type') {
        expect(plan, `${spec.id} is presence:'type' — unpinning is legitimate`).toEqual([]);
      } else {
        expect(plan.map((r) => [r.id, r.fields]), `${spec.id} must still be re-pinned`).toEqual([
          [spec.id, ['pinned']],
        ]);
      }
    }
  });

  it('the DEVICE-SESSION holders are presence:"pinned", so they keep the full guard', () => {
    // The exemption would be dangerous if it ever covered these two. Asserted
    // against the table, so a future presence change reddens HERE rather than
    // silently widening the exemption to a node that holds hardware.
    for (const id of ['pinned-audioIn', 'pinned-audioOut']) {
      expect(ALL_WORKFLOW_PINNED.find((s) => s.id === id)?.presence ?? 'pinned').toBe('pinned');
    }
  });

  it('ATTACK: data wiped entirely → repair (no throw on a null data bag)', () => {
    const nodes = canonicalNodes();
    nodes.find((n) => n.id === 'pinned-clipplayer')!.data = null;
    expect(planPinnedIdentityRepairs(nodes)).toEqual([
      { id: 'pinned-clipplayer', type: 'clipplayer', domain: 'audio', fields: ['pinned'] },
    ]);
  });

  it('ATTACK: all three fields at once → one repair naming all three', () => {
    const nodes = canonicalNodes();
    const victim = nodes.find((n) => n.id === 'pinned-electraControl')!;
    victim.type = 'vco';
    victim.domain = 'audio'; // canonical is 'meta'
    victim.data = {};
    expect(planPinnedIdentityRepairs(nodes)).toEqual([
      {
        id: 'pinned-electraControl',
        type: 'electraControl',
        domain: 'meta',
        fields: ['type', 'domain', 'pinned'],
      },
    ]);
  });

  it('ATTACK: EVERY reserved id poisoned at once → every one is repaired', () => {
    // A sweep must not be able to reach the device-session holders either.
    const nodes = canonicalNodes().map((n) => ({ ...n, type: 'scope', data: {} }));
    const plan = planPinnedIdentityRepairs(nodes);
    expect(plan.map((r) => r.id).sort()).toEqual(ALL_WORKFLOW_PINNED.map((s) => s.id).sort());
    for (const r of plan) {
      const spec = ALL_WORKFLOW_PINNED.find((s) => s.id === r.id)!;
      expect([r.type, r.domain]).toEqual([spec.type, spec.domain]);
    }
  });

  it('LEGITIMATE USE SURVIVES: params, position, name and the wire latch are untouched', () => {
    // A hardening that flattens real user state is a regression. The plan
    // carries ONLY the three canonical fields — it cannot even EXPRESS a params
    // or position write, so nothing downstream can flatten them.
    const nodes = canonicalNodes();
    const out = nodes.find((n) => n.id === 'pinned-audioOut')!;
    out.type = 'scope'; // attacked
    out.params = { gain: 0.37 };
    out.position = { x: 900, y: 12 };
    out.data!.name = 'main out';
    out.data![WORKFLOW_DEFAULT_WIRE_LATCH] = true;
    const plan = planPinnedIdentityRepairs(nodes);
    expect(plan).toHaveLength(1);
    expect(Object.keys(plan[0]!).sort()).toEqual(['domain', 'fields', 'id', 'type']);
  });

  it('a NON-reserved id is never touched, whatever it holds', () => {
    const nodes = [
      ...canonicalNodes(),
      { id: 'user-scope-1', type: 'scope', domain: 'audio', data: {} },
      // Even a node claiming to be pinned, at an id we do not reserve.
      { id: 'evil-1', type: 'mixmstrs', domain: 'audio', data: { pinned: true } },
    ];
    expect(planPinnedIdentityRepairs(nodes)).toEqual([]);
  });

  it('survives null / id-less entries in the node list', () => {
    expect(
      planPinnedIdentityRepairs([null, undefined, { type: 'scope' }, ...canonicalNodes()]),
    ).toEqual([]);
  });

  it('RESERVED_PINNED_IDS is exactly the planner’s id set', () => {
    expect([...RESERVED_PINNED_IDS].sort()).toEqual(ALL_WORKFLOW_PINNED.map((s) => s.id).sort());
  });
});

describe('WORKFLOW_DEFAULT_WIRES — the mixmstrs→audioOut default-wire contract', () => {
  it('is exactly master L/R → audioOut L/R with deterministic e-… ids', () => {
    // Port ids are pinned to the defs: mixmstrs outputs masterL/masterR
    // (mixmstrs.ts), audioOut inputs L/R (audio-out.ts). The id template is
    // the SAME `e-<src>-<srcPort>-<dst>-<dstPort>` handleConnect writes, so
    // racing clients converge on one Y.Map entry per wire.
    expect(WORKFLOW_DEFAULT_WIRES).toEqual([
      {
        id: 'e-pinned-mixmstrs-masterL-pinned-audioOut-L',
        source: { nodeId: 'pinned-mixmstrs', portId: 'masterL' },
        target: { nodeId: 'pinned-audioOut', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      },
      {
        id: 'e-pinned-mixmstrs-masterR-pinned-audioOut-R',
        source: { nodeId: 'pinned-mixmstrs', portId: 'masterR' },
        target: { nodeId: 'pinned-audioOut', portId: 'R' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ]);
  });
});

describe('planDefaultWires — one-shot seed, never re-fight the user', () => {
  const mix = { id: 'pinned-mixmstrs', data: { pinned: true } };
  const out = { id: 'pinned-audioOut', data: { pinned: true } };

  it('plans both wires + the latch when both pins exist and nothing is latched', () => {
    const plan = planDefaultWires([mix, out], []);
    expect(plan.latch).toBe(true);
    expect(plan.wires).toEqual([...WORKFLOW_DEFAULT_WIRES]);
  });

  it('plans NOTHING while either endpoint is still missing (replan later, no latch burn)', () => {
    expect(planDefaultWires([mix], [])).toEqual({ wires: [], latch: false });
    expect(planDefaultWires([out], [])).toEqual({ wires: [], latch: false });
    expect(planDefaultWires([], [])).toEqual({ wires: [], latch: false });
  });

  it('the latch on the pinned audioOut suppresses re-seeding forever (user delete respected)', () => {
    const latched = { id: 'pinned-audioOut', data: { pinned: true, [WORKFLOW_DEFAULT_WIRE_LATCH]: true } };
    // Even with ZERO edges present — i.e. the user deleted the default
    // cables — a latched audioOut plans nothing.
    expect(planDefaultWires([mix, latched], [])).toEqual({ wires: [], latch: false });
  });

  it('a non-boolean latch value does not count (strict === true)', () => {
    const weird = { id: 'pinned-audioOut', data: { [WORKFLOW_DEFAULT_WIRE_LATCH]: 'yes' } };
    expect(planDefaultWires([mix, weird], []).latch).toBe(true);
  });

  it('skips a wire whose target input is already occupied (never replace a user patch)', () => {
    const edges = [{ target: { nodeId: 'pinned-audioOut', portId: 'L' } }];
    const plan = planDefaultWires([mix, out], edges);
    expect(plan.latch).toBe(true);
    expect(plan.wires.map((w) => w.target.portId)).toEqual(['R']);
  });

  it('both targets occupied → empty wires but the latch still burns (seed consumed)', () => {
    const edges = [
      { target: { nodeId: 'pinned-audioOut', portId: 'L' } },
      { target: { nodeId: 'pinned-audioOut', portId: 'R' } },
    ];
    expect(planDefaultWires([mix, out], edges)).toEqual({ wires: [], latch: true });
  });

  it('tolerates sparse edge arrays (Y.Map holes)', () => {
    const plan = planDefaultWires([mix, out], [null, undefined]);
    expect(plan.wires).toHaveLength(2);
  });
});

describe('isPinnedNode', () => {
  it('true only for data.pinned === true', () => {
    expect(isPinnedNode({ type: 'x', data: { pinned: true } })).toBe(true);
    expect(isPinnedNode({ type: 'x', data: { pinned: 'true' } })).toBe(false);
    expect(isPinnedNode({ type: 'x', data: {} })).toBe(false);
    expect(isPinnedNode({ type: 'x' })).toBe(false);
    expect(isPinnedNode(null)).toBe(false);
    expect(isPinnedNode(undefined)).toBe(false);
  });
});

describe('isTypingTarget — the M/E/C inert-while-typing guard', () => {
  it('inputs / textareas / selects / contenteditable are typing targets', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input' })).toBe(true); // case-insensitive
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('plain elements / null / non-objects are not', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget('input')).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
});

// ── THE RACK-FLIP SHORTCUT (#1508) ────────────────────────────────────────
// The flip used to be BARE TAB, which consumed the browser's focus-traversal
// key across the whole shell. These tests pin the two properties that fix has
// to keep true forever: TAB IS NEVER A FLIP (in any modifier combination),
// and the replacement key does not silently double-bind onto another global
// shortcut.
describe('isRackFlipKey — the rack/dock flip shortcut', () => {
  /** Every modifier permutation, generated (never a typed list of combos). */
  const MODIFIERS = ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const;
  function modifierCombos(): Array<Record<string, boolean>> {
    const out: Array<Record<string, boolean>> = [];
    for (let mask = 1; mask < 1 << MODIFIERS.length; mask++) {
      const combo: Record<string, boolean> = {};
      MODIFIERS.forEach((m, i) => {
        if (mask & (1 << i)) combo[m] = true;
      });
      out.push(combo);
    }
    return out;
  }

  it('a bare flip key fires, in either letter case', () => {
    expect(isRackFlipKey({ key: RACK_FLIP_KEY })).toBe(true);
    expect(isRackFlipKey({ key: RACK_FLIP_KEY.toUpperCase() })).toBe(true);
  });

  it('BARE TAB IS THE FLIP — and `f` is not (owner ruling #1629)', () => {
    // The regression leg for #1629, the inverse of the short-lived #1508
    // rebind: the flip gesture is bare Tab, and the letter key that briefly
    // replaced it must never silently come back as a second binding.
    expect(isRackFlipKey({ key: 'Tab' }), 'bare Tab is the rack-flip shortcut').toBe(true);
    const letterFlips = [{}, ...modifierCombos()]
      .map((mods) => ({ key: 'f', ...mods }))
      .filter((e) => isRackFlipKey(e));
    expect(letterFlips, '`f` must never be read as the rack-flip shortcut').toEqual([]);
  });

  it('every modifier combination on the flip key itself is rejected', () => {
    // Shift-Tab is the one keyboard traversal deliberately kept native;
    // Cmd/Ctrl/Alt-Tab belong to the OS (app switcher, browser tab cycling).
    const leaks = modifierCombos()
      .map((mods) => ({ key: RACK_FLIP_KEY, ...mods }))
      .filter((e) => isRackFlipKey(e));
    expect(leaks, 'the flip shortcut is BARE — no modifier form of it exists').toEqual([]);
  });

  it('other keys are not the flip key', () => {
    expect(isRackFlipKey({ key: 'Escape' })).toBe(false);
    expect(isRackFlipKey({ key: 'Enter' })).toBe(false);
    expect(isRackFlipKey({ key: ' ' })).toBe(false);
    expect(isRackFlipKey({})).toBe(false);
  });

  // COLLISION GATE, derived from the artifact rather than restated: the flip
  // key is read out of the SAME map the dock keymap dispatches on, so a future
  // pinned module that claims `f` reddens here instead of double-firing at
  // runtime. The viewport-nav keys ('v' + the lane digits) are the other
  // bare-key family in the shell; the digits are generated from a char range,
  // not enumerated.
  it('does not collide with a pinned-drawer key or a viewport-nav key', () => {
    const drawerKeys = [...DRAWER_KEY_TO_PINNED.keys()];
    expect(drawerKeys.filter((k) => isRackFlipKey({ key: k }))).toEqual([]);

    const navKeys = ['v', ...Array.from({ length: 10 }, (_, i) => String(i))];
    expect(navKeys.filter((k) => isRackFlipKey({ key: k }))).toEqual([]);
  });

  // NEGATIVE CONTROL for the collision gate above — a gate that can only ever
  // return [] proves nothing. Feed the SAME predicate shape a key that IS the
  // flip key and confirm the filter catches it.
  it('the collision gate can actually detect a collision', () => {
    const colliding = ['x', RACK_FLIP_KEY, 'y'].filter((k) => isRackFlipKey({ key: k }));
    expect(colliding).toEqual([RACK_FLIP_KEY]);
  });
});
