// packages/web/src/lib/ui/workflow/chromaconsole-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the CHROMA CONSOLE's faceplate.
//
// The registry-driven sweeps (`module-face-lint`, `shell-cells`,
// `face-rack-status-source`, `faces-parity`) enrol this module automatically and
// ask GENERIC questions: does every key resolve, does every cell operate, does
// the declared body role hold. This file asks the ones that are only true of
// THIS module — the ones that, if they silently stopped being true, would leave
// every one of those sweeps green.
//
// ⚠ AND THE UNREACHABLE HALF IS LARGER HERE THAN ON ANY OTHER BINDER. No CI
// runner has a Chroma Console, a granted MIDI origin, or any output port at all,
// so every behavioural gate stops at "no port is selected". What is left to hold
// structurally — the rank, the two SEPARATE seams, the auto-detect tie-break,
// the body's refusal to paint a value — is what this file pins.
//
// ⚠ EACH ASSERTION EXISTS BECAUSE A PLAUSIBLE EDIT WOULD DEFEAT IT QUIETLY, and
// the comment on each says which edit.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '$lib/audio/modules';
import { chromaconsoleDef } from '$lib/audio/modules/chromaconsole';
import { DEVICE_SLOT_IDS } from '$lib/devices/device-module';
import { STRICT_FACES } from './strict-faces';
import { shellCellFor, shellActionProbes } from './shell-cells';
import { glyphBinding } from './shell-glyph-live';
import { curatedFace, dockFacePlan, dockPlanControls, laneOrder } from './curated-face';

const FACE = () => chromaconsoleDef.face!;

const CONNECT = 'chromaconsole-connect-{n}';
const PUSHALL = 'chromaconsole-pushall-{n}';

const SRC = (rel: string): string => readFileSync(resolve(__dirname, rel), 'utf8');

describe('chromaconsole face — the promotion itself', () => {
  it('is PROMOTED, not merely authored', () => {
    // An authored `face` that is not in STRICT_FACES is INERT: it ships as a
    // no-op while looking complete, because `migrated()` is what decides which
    // component the player actually operates.
    expect(chromaconsoleDef.face, 'a face is declared').toBeTruthy();
    expect(STRICT_FACES.has('chromaconsole'), 'and it is promoted').toBe(true);
  });

  it('`glyph: none` is RUN through glyphBinding, not argued from the module', () => {
    // ⚠ TWO WAYS TO GET THIS WRONG, and only one is caught by the registry lint.
    //   1. Any literal except 'algorithm' falls through to `{ kind: 'static' }`
    //      (`outputs: []` ⇒ `primaryAudioOutPortId` is null), which
    //      module-face-lint's dead-glyph clause reddens. Loud.
    //   2. ⚠ `glyph: 'algorithm'` would RESOLVE — the `layoutSource: <ext>`
    //      branch fires for any def carrying a `face.extension`, which this one
    //      does — so it PASSES the dead-glyph clause and paints an empty
    //      topology plate, because this extension exports no `glyph` slot.
    //      Silent. That is the edit this assertion exists for.
    expect(FACE().glyph).toBe('none');
    expect(glyphBinding(chromaconsoleDef).kind).toBe('none');
    expect(chromaconsoleDef.outputs.length, 'nothing for a live glyph to bind to').toBe(0);
    const asAlgorithm = {
      ...chromaconsoleDef,
      face: { ...FACE(), glyph: 'algorithm' as const },
    };
    expect(glyphBinding(asAlgorithm).kind, 'would pass the dead-glyph clause').toBe('algorithm');
  });
});

describe('chromaconsole face — TWO GESTURES ABOVE EIGHT KNOBS', () => {
  // The ranking argument, pinned because it is the one an unrelated tidy would
  // undo. The pedal is `readBack: 'none'`, so PUSH ALL is the only
  // reconciliation that exists in either direction, and neither it nor CONNECT
  // has a second surface — while the eight slot VALUES have four (MIDI learn,
  // clip automation, the Electra, the Push 2 card).
  it('CONNECT is rank 0 and PUSH ALL is rank 1', () => {
    // ⚠ THE PLAUSIBLE EDIT IS A TIDY, NOT A DELETION: someone groups the eight
    // slots first "because they are the controls". `faceTierCap` caps a
    // glyph-less COMPACT tile at 3, so a demoted gesture leaves the lane tile
    // and every other gate stays green — the dock plan is still perfect and the
    // lane still paints three cells.
    expect(FACE().order[0]).toBe(CONNECT);
    expect(FACE().order[1]).toBe(PUSHALL);
  });

  it('both gestures survive at MINI, COMPACT and FULL', () => {
    expect(curatedFace(chromaconsoleDef, 'mini')?.controls.map((c) => c.key)).toEqual([CONNECT]);
    for (const tier of ['compact', 'full'] as const) {
      const keys = curatedFace(chromaconsoleDef, tier)?.controls.map((c) => c.key) ?? [];
      expect(keys, `${tier} keeps the grant gesture`).toContain(CONNECT);
      expect(keys, `${tier} keeps the reconciliation`).toContain(PUSHALL);
    }
  });

  it('the lane tile reaches real slot knobs too — the gestures do not eat it', () => {
    // The other direction of the same trade: if a later edit ranked more
    // non-param cells above the slots, the tile would be all buttons and no
    // instrument. The compact cap is 3, so at least one slot must survive there.
    const compact = curatedFace(chromaconsoleDef, 'compact')?.controls.map((c) => c.key) ?? [];
    expect(compact.some((k) => k.startsWith('slot'))).toBe(true);
  });

  it('laneOrder drops nothing — no hero cell, no pad', () => {
    // `laneOrder` removes exactly a declared `hero.cell` and each xyPad's `x`.
    // This face declares neither, so the lane roster IS `face.order`.
    expect([...laneOrder(FACE())]).toEqual([CONNECT, PUSHALL, ...DEVICE_SLOT_IDS]);
  });

  it('both cells are ACTIONs, not PANELs — panels are the dock-only kind', () => {
    for (const key of [CONNECT, PUSHALL]) {
      const cell = shellCellFor('chromaconsole', { kind: 'family', key, label: key } as never);
      expect(cell?.kind, `${key} renders at lane tiers`).toBe('action');
    }
  });
});

describe('chromaconsole face — the two probes, and the two SEPARATE seams', () => {
  it('both cells declare an audition probe on the engine-message seam', () => {
    // ⚠ A `data`/`data-rev` probe would be wrong in BOTH directions. The natural
    // observables — `status().connected` flipping, the transmitter's `delivered`
    // count rising — need a granted origin AND a real output port, so they would
    // be permanently RED on perfectly live controls. A revision counter would be
    // the opposite failure: green on a button that bumps a number and reaches
    // nothing.
    const probes = shellActionProbes().chromaconsole ?? {};
    for (const key of [CONNECT, PUSHALL]) {
      const probe = probes[key];
      expect(probe, `${key} declares a probe`).toBeTruthy();
      expect(probe!.effect.kind).toBe('audition');
      expect((probe!.effect as { seam: string }).seam).toBe('engine-message');
    }
  });

  it('⚠ THE TWO CELLS CALL TWO DIFFERENT SEAM FUNCTIONS', () => {
    // THE ASSERTION THE SHARED-SEAM SHAPE OWES. Both cells declare the SAME
    // audition seam on the SAME node (es9's connect/disconnect pair is the
    // precedent, and faces-parity re-baselines `lastSeq` before each press, so
    // the sweep still discriminates). What the sweep CANNOT see is a copy-paste
    // that points both `onFire`s at the same function: PUSH ALL would record a
    // delivered audition, the probe would pass, and pressing it would grant MIDI
    // access instead of re-sending eight CCs. Green everywhere, dead in the
    // player's hands.
    const src = SRC('./shell-cells.ts');
    // ⚠ `{2}` RATHER THAN TWO LITERAL SPACES — `no-regex-spaces`, which is a
    // lint ERROR rather than a style note for exactly the reason it bites here:
    // this match is TERMINATED by the registry block's two-space indent, and two
    // invisible characters are the thing a later edit miscounts. Same match.
    const block = /chromaconsole: \{([\s\S]*?)\n {2}\},/.exec(src)?.[1] ?? '';
    expect(block, 'the registry block was found').not.toBe('');
    expect(block).toMatch(/chromaconsoleConnect\(nodeId\)/);
    expect(block).toMatch(/chromaconsolePushAll\(nodeId\)/);
    expect(
      (block.match(/chromaconsoleConnect\(/g) ?? []).length,
      'the grant gesture is wired exactly once',
    ).toBe(1);
    expect(
      (block.match(/chromaconsolePushAll\(/g) ?? []).length,
      'the reconciliation is wired exactly once',
    ).toBe(1);
  });

  it('both seams record `delivered: false` when the handle is absent', () => {
    // A press that reached nothing must be recorded LOUDLY rather than dropped —
    // the ledger's whole point, and the difference between "never pressed" and
    // "pressed and reached nothing". The plausible edit is an early `return`
    // above the `recordAudition` call, which makes a dead press invisible.
    const src = SRC('../modules/chromaconsole-cell-actions.ts');
    expect(
      (src.match(/recordAudition\(\{ nodeId, seam: 'engine-message', delivered: false \}\)/g) ?? [])
        .length,
      'one honest no-handle record per gesture',
    ).toBe(2);
  });
});

describe('chromaconsole face — AUTO-DETECT has ONE implementation', () => {
  // The behaviour fix that rides this PR. `matchPortByHint` had a full unit
  // suite and ZERO production callers, while the card re-implemented the match
  // inline with a DIFFERENT tie-break: the helper is earliest-HINT, the card was
  // earliest-PORT. The descriptor orders its hints most-specific-first on
  // purpose, so with both a DIN interface enumerating as "Chroma" and the real
  // pedal present, the card bound the interface.
  it('the seam calls the shared helper', () => {
    const src = SRC('../modules/chromaconsole-cell-actions.ts');
    expect(src).toMatch(/matchPortByHint\(CHROMA_CONSOLE, ports\)/);
  });

  it('⚠ AND NO SURFACE MATCHES AGAIN — the seam is the only matcher', () => {
    // The regression this file exists to prevent: a future edit "inlines the
    // little helper back into the surface for clarity" and two callers start
    // choosing different ports, with nothing red anywhere. The legacy card was
    // the second caller and was read here by name; the shell cells are the
    // caller now, and the deny is made of the surviving surfaces instead.
    // The seam is BOTH the matcher and the only caller of itself: the connect
    // action inside `chromaconsole-cell-actions.ts` auto-selects through the
    // same function, so a second implementation would have to appear as a
    // second `portHints.some(` somewhere in the module's own sources.
    const seam = SRC('../modules/chromaconsole-cell-actions.ts');
    expect(seam, 'the connect action auto-selects through the shared helper')
      .toMatch(/chromaconsoleAutoSelectPort\(api\)/);
    const matches = [...seam.matchAll(/portHints\.some\(/g)].length;
    expect(matches, 'the hint match has exactly ONE implementation').toBeLessThanOrEqual(1);
    const cells = SRC('./shell-cells.ts');
    expect(
      /portHints\.some\(/.test(cells),
      'the shell cells must not re-implement the hint match',
    ).toBe(false);
  });

  it('⚠ AND THE SLOT NAME HAS ONE IMPLEMENTATION TOO', () => {
    // The card's `knobLabel` and the body's chip caption must be the same
    // arithmetic: a hand-copy is how a qualified label ("amount · character")
    // starts being shortened one way on one surface and another way on the
    // other.
    const card = SRC('../modules/ChromaconsoleCard.svelte');
    expect(card).toMatch(/const knobLabel = chromaconsoleSlotName;/);
  });
});

describe('chromaconsole face — two honest bands, no tab rail', () => {
  it('renders every param and both families exactly once, nothing unbacked', () => {
    const controls = dockPlanControls(dockFacePlan(chromaconsoleDef) ?? []);
    expect(controls.map((c) => c.key).sort()).toEqual([CONNECT, PUSHALL, ...DEVICE_SLOT_IDS].sort());
  });

  it('is TWO bands and is NOT tab-railed — nothing is padded to reach a rail', () => {
    // The rail engages at DOCK_TAB_MIN_BANDS = 7 and `face.tabbed` is
    // owner-instruction-only. ⚠ The control-heavy tabbed ruling does NOT reach
    // this module: that ruling is about many controls of DIFFERENT types, and
    // this is eight controls of ONE type plus two gestures. Splitting the slots
    // into pages to reach seven bands is padding a rail, which the same ruling
    // names as the anti-pattern.
    expect(FACE().pages?.length).toBe(2);
    expect(FACE().tabbed).toBeUndefined();
    expect(dockFacePlan(chromaconsoleDef)?.length).toBe(2);
  });

  it('declares NO hero, NO rackStatus, NO xyPads', () => {
    // There is no picture to promote, and the MIDI binding is a property of THIS
    // node rather than of the rack: two chromaconsoles can drive two pedals on
    // two ports, so `rackStatus` would suppress a band on the second for no
    // reason.
    expect(FACE().hero).toBeUndefined();
    expect(FACE().rackStatus).toBeUndefined();
    expect(FACE().xyPads).toBeUndefined();
  });

  it('ranks all eight slots — none is `noUserControl`, none is dropped', () => {
    for (const id of DEVICE_SLOT_IDS) {
      expect(FACE().order, `${id} is ranked`).toContain(id);
    }
    expect(chromaconsoleDef.params.length).toBe(DEVICE_SLOT_IDS.length);
  });
});

describe('chromaconsole face — the DEVICE BODY, and what only IT can carry', () => {
  const body = () => SRC('../modules/chromaconsole/ChromaconsoleDeviceBody.svelte');

  it('declares the extension by id', () => {
    expect(FACE().extension).toBe('chromaconsole');
  });

  it('carries the output picker and the channel — the two non-cell affordances', () => {
    const src = body();
    expect(src).toMatch(/chromaconsole-port-\{nodeId\}/);
    expect(src).toMatch(/chromaconsole-channel-\{nodeId\}/);
  });

  it('carries NO connect and NO push-all button — both are ranked cells', () => {
    // A second affordance for one gesture is clutter under "compact is the
    // default", a second thing to keep in sync, and — worse — it makes the cell
    // look optional to the next reader, who might then unrank it and take the
    // gesture off the lane tile.
    //
    // ⚠ THE PREDICATE IS THE HANDLER, NOT THE PHRASE. The empty-state hint NAMES
    // the cell ("Press Connect MIDI to…") exactly as midiclock's does, and it
    // has to: the whole point of the empty state is saying which gesture to
    // reach for. Matching on the words would forbid the instruction.
    const src = body();
    expect(/chromaconsoleConnect\(/.test(src), 'no connect handler in the body').toBe(false);
    expect(/chromaconsolePushAll\(/.test(src), 'no push-all handler in the body').toBe(false);
  });

  it('⚠ PAINTS NO VALUE — the readout is DELETED, not relocated', () => {
    // The 2026-08-17 ruling, and on this module the readout is doubly wrong: it
    // is the white decimal the ruling names AND, on a receive-only device, the
    // element most likely to be read as "what the pedal holds". The plausible
    // edit is a well-meaning port of the card's `readoutFor`, which no runtime
    // gate would see — `face-resting-text-source` reads FACE FIELDS and is blind
    // to a body's markup by its own admission.
    expect(/formatControlValue/.test(body()), 'no value formatter reaches this surface').toBe(false);
  });

  it('⚠ THE ENUM Segmented PASSES AN EXPLICIT testid', () => {
    // faces-parity asserts EXACT MULTISET equality between the dock's
    // `[data-testid^="control-"]` elements and the def's param ids. A `Segmented`
    // given `paramId` emits `control-<paramId>` by default, so the board's second
    // surface for an enum-assigned slot would read as a DUPLICATE of the band
    // cell — a face-wide failure, and LATENT, because the sweep never assigns an
    // enum control and the default eight assignments are all continuous.
    //
    // ⚠ AND `paramId` MUST STAY: it is the MIDI-learn binding key, so dropping
    // it to suppress the testid would silently delete MIDI Learn from the
    // control (Knob.svelte's prop carries the same warning).
    const src = body();
    expect(src).toMatch(/testid="chromaconsole-seg-\{nodeId\}-\{chip\.slotId\}"/);
    expect(src).toMatch(/paramId=\{chip\.slotId\}/);
  });

  it('⚠ NO ACTIVITY DOT, NO COUNTER, NO ELAPSED TIME', () => {
    // The legacy card's header records that its resting render must be
    // byte-stable for a committed VRT baseline, and that the same deletions stop
    // it implying it knows what a receive-only pedal holds. The face inherits
    // both, and BINDERS §2.1's non-text activity dot is refused here for the
    // first of those reasons. The two ledger counters are the concrete temptation.
    const src = body();
    expect(/status\.delivered/.test(src), 'the delivered count stays off the surface').toBe(false);
    expect(/status\.undelivered/.test(src), 'the undelivered count too').toBe(false);
    expect(/setInterval|requestAnimationFrame/.test(src), 'nothing is on a timer').toBe(false);
  });
});

describe('chromaconsole — the slot reassignment is UNDOABLE', () => {
  it('⚠ writeAssign goes through mutateNode, not a bare ydoc.transact', () => {
    // THE DEFECT THIS PR FIXES, pinned so it cannot come back. `store.ts` tracks
    // `trackedOrigins = [LOCAL_ORIGIN]`, so an untagged transaction is atomic and
    // syncs to rack-mates but never reaches the UndoManager. A slot reassignment
    // is the module's most destructive and least reconstructible edit — which of
    // twenty-nine controls was slot 5 before? — and it was outside Cmd-Z.
    //
    // Nothing else in the tree can see this: the mutate guard scans `.params`
    // writes and this is `.data`, and no behavioural gate presses Cmd-Z after a
    // reassignment.
    const src = SRC('../../audio/modules/chromaconsole.ts');
    expect(src).toMatch(/mutateNode\(nodeId, \(live\) => \{/);
    expect(/ydoc\.transact\(/.test(src), 'no untagged transaction remains').toBe(false);
  });
});
