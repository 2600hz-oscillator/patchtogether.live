// packages/web/src/lib/ui/modules/dx7-patch-actions.test.ts
//
// REAL-Y.Doc tests for the DX7 PRESET STAMP and the edit-buffer readers.
// These run against the SAME live syncedStore + Y.Doc + UndoManager the patch
// uses (graph/store.ts) — not a mock — because the two things the stamp has to
// get right are *both* properties of the real store:
//
//   1. UNDO GRANULARITY. The UndoManager records one entry per tracked
//      TRANSACTION, so "five writes in one mutateNode" and "five writes" are
//      indistinguishable from the values alone and differ ONLY in
//      `undoStack.length`. A mock store cannot see the difference at all.
//   2. YJS PROXIES. A voice read back out of `data.userPatches` is a Y.Map
//      proxy whose `op.r`/`op.l` are Y.Array proxies; that is the exact input
//      `deepUnwrapVoice` exists for, and a plain-object fixture would prove
//      nothing about it. The proxy tests below assert `structuredClone` THROWS
//      on the raw entry first — the negative control on the instrument — so
//      "the unwrap works" cannot be a vacuous pass.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { DX7_BUILTIN_BANK, findBuiltinPatch } from '$lib/audio/dx7-banks';
import { setOpField } from '$lib/audio/dx7-voice-edit';
import type { DX7Voice } from '$lib/audio/dx7-syx';
import type { ModuleNode } from '$lib/graph/types';
import {
  DX7_DIRTY_MARK,
  DX7_OP_COUNT,
  dx7EditVoice,
  dx7FindVoice,
  dx7IsDirty,
  dx7OpOn,
  dx7PresetChipLabel,
  dx7PresetName,
  dx7PresetVoice,
  dx7UserPatches,
  dx7VoiceRev,
  loadDx7SyxFile,
  selectDx7Preset,
} from './dx7-patch-actions';

const NID = 'dx7-stamp-test';
const AAAHGOOD_SYX = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'audio', '__fixtures__', 'AAAHGOOD.SYX',
);

/** A node in the LEGACY shape: a preset NAME and nothing else. This is what
 *  every rack saved before this PR looks like — no `voice`, no `opOn`, no
 *  `voiceRev`, and (usually) no `params.feedback`. */
function makeLegacyNode(preset = 'E.PIANO 1', params: Record<string, number> = {}): void {
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'dx7',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params,
      data: { preset },
    } as ModuleNode;
  }, LOCAL_ORIGIN);
  undoManager.clear();
  undoManager.stopCapturing();
}

const liveNode = (): ModuleNode => patch.nodes[NID] as ModuleNode;
const liveData = (): Record<string, unknown> => liveNode().data as Record<string, unknown>;

beforeEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
  undoManager.stopCapturing();
});

afterEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  undoManager.clear();
});

// ---------------------------------------------------------------------------
// 1. THE STAMP — five writes, ONE transaction
// ---------------------------------------------------------------------------

describe('selectDx7Preset — the STAMP', () => {
  it('writes 3 data keys + 2 params in ONE undo step', () => {
    makeLegacyNode('E.PIANO 1', { algorithm: 5, feedback: 4 });
    const target = findBuiltinPatch('TUB BELLS')!;

    selectDx7Preset(NID, 'TUB BELLS');

    // ---- all five landed ----
    const d = liveData();
    expect(d.preset, 'data.preset = the ORIGIN voice name').toBe('TUB BELLS');
    expect(d.voice, 'data.voice = the edit buffer').toBeTruthy();
    expect((d.voice as DX7Voice).name).toBe('TUB BELLS');
    expect(d.opOn, 'data.opOn = six mutes, all on').toEqual([true, true, true, true, true, true]);
    expect(d.voiceRev, 'data.voiceRev bumped from absent(0) to 1').toBe(1);
    expect(liveNode().params.algorithm, 'params.algorithm from the voice').toBe(target.algorithm);
    expect(liveNode().params.feedback, 'params.feedback from the voice').toBe(target.feedback);

    // ---- ...as ONE undo entry. THE assertion of this PR. ----
    // Five separate writes would give five entries, and a user pressing Cmd-Z
    // would walk the rack through states that never existed (a TUB BELLS label
    // over an E.PIANO 1 buffer, or a TUB BELLS voice at E.PIANO 1's feedback).
    expect(
      undoManager.undoStack.length,
      'the whole stamp is ONE undoable edit, not five',
    ).toBe(1);
  });

  it('ONE undo restores every one of the five values together', () => {
    makeLegacyNode('E.PIANO 1', { algorithm: 5, feedback: 4 });
    // Stamp E.PIANO 1 first so there IS a prior buffer to come back to
    // (the legacy node has no `data.voice` at all).
    selectDx7Preset(NID, 'E.PIANO 1');
    undoManager.clear();
    undoManager.stopCapturing();
    const before = {
      preset: liveData().preset,
      voiceName: (liveData().voice as DX7Voice).name,
      rev: liveData().voiceRev,
      algorithm: liveNode().params.algorithm,
      feedback: liveNode().params.feedback,
    };

    selectDx7Preset(NID, 'BASS 1');
    expect(liveData().preset).toBe('BASS 1');

    undoManager.undo();

    expect(liveData().preset, 'label restored').toBe(before.preset);
    expect((liveData().voice as DX7Voice).name, 'buffer restored').toBe(before.voiceName);
    expect(liveData().voiceRev, 'rev restored').toBe(before.rev);
    expect(liveNode().params.algorithm, 'algorithm restored').toBe(before.algorithm);
    expect(liveNode().params.feedback, 'feedback restored').toBe(before.feedback);
  });

  it('NEGATIVE CONTROL: five separate mutations really do make five undo steps', () => {
    // The instrument check. `undoStack.length === 1` above only means anything
    // if this store CAN produce a longer stack for the same five values — i.e.
    // if the metric moves when the thing it measures changes. It does.
    makeLegacyNode();
    const v = findBuiltinPatch('BASS 1')!;
    ydoc.transact(() => { (liveNode().data as Record<string, unknown>).preset = 'BASS 1'; }, LOCAL_ORIGIN);
    undoManager.stopCapturing();
    ydoc.transact(() => { (liveNode().data as Record<string, unknown>).voiceRev = 1; }, LOCAL_ORIGIN);
    undoManager.stopCapturing();
    ydoc.transact(() => { liveNode().params.algorithm = v.algorithm; }, LOCAL_ORIGIN);
    undoManager.stopCapturing();
    ydoc.transact(() => { liveNode().params.feedback = v.feedback; }, LOCAL_ORIGIN);
    undoManager.stopCapturing();
    expect(undoManager.undoStack.length, 'un-transacted writes ARE separately undoable').toBe(4);
  });

  it('bumps voiceRev monotonically, and re-selecting the SAME name is a REVERT (not a no-op)', () => {
    makeLegacyNode();
    selectDx7Preset(NID, 'BRASS 1');
    expect(liveData().voiceRev).toBe(1);
    selectDx7Preset(NID, 'BRASS 1'); // the REVERT gesture
    expect(liveData().voiceRev, 'a revert must still bump the rev, or the engine never re-applies it').toBe(2);
    selectDx7Preset(NID, 'CALLIOPE');
    expect(liveData().voiceRev).toBe(3);
  });

  it('re-selecting the loaded name DISCARDS operator edits (that is what REVERT means)', () => {
    makeLegacyNode();
    selectDx7Preset(NID, 'MARIMBA');
    const pristine = (liveData().voice as DX7Voice).operators[1]!.level;
    // Simulate PR 6's operator edit: a different level on op2.
    ydoc.transact(() => {
      (liveNode().data as Record<string, unknown>).voice = setOpField(
        liveData().voice, 1, 'level', pristine === 0 ? 42 : 0,
      );
    }, LOCAL_ORIGIN);
    expect(dx7IsDirty(liveNode()), 'the edit registered as dirty').toBe(true);

    selectDx7Preset(NID, 'MARIMBA');
    expect((liveData().voice as DX7Voice).operators[1]!.level).toBe(pristine);
    expect(dx7IsDirty(liveNode()), 'clean again after the revert').toBe(false);
  });

  it('an UNKNOWN voice name is refused — no label, no buffer, no rev, no params', () => {
    // A stamp is destructive (it replaces the buffer and resets the mutes), so
    // "the roster does not have that voice" must not quietly mean "load
    // E.PIANO 1 and call it NOPE".
    makeLegacyNode('E.PIANO 1', { algorithm: 5, feedback: 4 });
    selectDx7Preset(NID, 'NOT A REAL VOICE');
    expect(liveData().preset).toBe('E.PIANO 1');
    expect(liveData().voice).toBeUndefined();
    expect(liveData().voiceRev).toBeUndefined();
    expect(liveNode().params.algorithm).toBe(5);
    expect(undoManager.undoStack.length, 'a refused stamp adds no undo entry').toBe(0);
  });

  it('a missing node is a safe no-op', () => {
    expect(() => selectDx7Preset('no-such-node', 'BASS 1')).not.toThrow();
    expect(patch.nodes['no-such-node']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. THE YJS PROXY — deepUnwrapVoice is MANDATORY, not defensive
// ---------------------------------------------------------------------------

describe('selectDx7Preset — stamping a voice that lives in the Y.Doc', () => {
  /** Write a cartridge-shaped voice into `data.userPatches` so reading it back
   *  yields a Yjs proxy (exactly what a real .syx import produces). */
  function seedUserPatch(voice: DX7Voice): void {
    ydoc.transact(() => {
      (liveNode().data as Record<string, unknown>).userPatches = [voice];
    }, LOCAL_ORIGIN);
    undoManager.clear();
    undoManager.stopCapturing();
  }

  it('THE NEGATIVE CONTROLS: the raw roster entry is BOTH unclonable AND un-writable', () => {
    // Two independently-measured hazards, both asserted rather than assumed —
    // if either ever stops firing, the corresponding "the unwrap saved us"
    // assertion below has quietly become vacuous.
    makeLegacyNode();
    seedUserPatch({ ...findBuiltinPatch('WIRE LEAD')!, name: 'CART 01' });
    const raw = dx7UserPatches(liveNode())[0]!;

    // (a) postMessage's structuredClone rejects the Yjs proxy — the SHIPPED
    //     bug modules/dx7.ts documents (SYX voices never reached the worklet).
    expect(() => structuredClone(raw), 'a cartridge voice is a Yjs proxy').toThrow();

    // (b) and writing it back into the SAME doc under another key throws too:
    //     "Not supported: reassigning object that already occurs in the tree."
    //     THIS is the one that makes deepUnwrapVoice mandatory in the STAMP
    //     specifically — a stamp that skipped it would not merely lose the
    //     worklet update, it would throw and leave `data.preset` written with
    //     no buffer behind it.
    expect(() => {
      ydoc.transact(() => { (liveNode().data as Record<string, unknown>).voice = raw; }, LOCAL_ORIGIN);
    }, 'writing an integrated Y type under a second key').toThrow();
  });

  it('stamps a SYX-shaped voice, and the supported reader hands back plain, cloneable JS', () => {
    makeLegacyNode();
    const src = { ...findBuiltinPatch('WIRE LEAD')!, name: 'CART 01' };
    seedUserPatch(src);

    // Does not throw — see negative control (b): it would, without the unwrap.
    selectDx7Preset(NID, 'CART 01');

    // `data.voice` on disk is a Y type again (everything in the doc is), so the
    // property that matters is what the SUPPORTED READER returns — that is the
    // value the factory posts to the worklet.
    const stamped = dx7EditVoice(liveNode());
    expect(() => structuredClone(stamped), 'the buffer survives postMessage').not.toThrow();
    expect(Array.isArray(stamped.operators)).toBe(true);
    expect(stamped.operators).toHaveLength(DX7_OP_COUNT);
    expect(stamped.operators[0]!.r).toEqual(src.operators[0]!.r);
    expect(stamped.operators[3]!.l).toEqual(src.operators[3]!.l);
    expect(stamped.operators[2]!.ratio).toBeCloseTo(src.operators[2]!.ratio, 6);
    // Fields sendPatch's OWN unwrap drops — the reason deepUnwrapVoice is a
    // second function and not an extraction.
    expect(stamped.pitchEg.r).toHaveLength(4);
    expect(stamped.lfo.waveform).toBe(src.lfo.waveform);
    expect(stamped.transpose).toBe(src.transpose);
    expect(liveNode().params.algorithm).toBe(src.algorithm);
    expect(liveNode().params.feedback).toBe(src.feedback);
  });

  it('a cartridge voice SHADOWS a built-in of the same name', () => {
    makeLegacyNode();
    const shadow = { ...findBuiltinPatch('BASS 1')!, name: 'E.PIANO 1', algorithm: 21, feedback: 1 };
    seedUserPatch(shadow);
    selectDx7Preset(NID, 'E.PIANO 1');
    expect(liveNode().params.algorithm, 'the imported voice won, not the built-in').toBe(21);
    expect(liveNode().params.feedback).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2b. CARTRIDGE IMPORT — the second one is the one that used to break
// ---------------------------------------------------------------------------

describe('loadDx7SyxFile — stacking cartridges', () => {
  function syxFile(): File {
    return new File([readFileSync(AAAHGOOD_SYX)], 'AAAHGOOD.SYX');
  }

  it('a SECOND import appends instead of throwing "already occurs in the tree"', async () => {
    // The first import writes plain-JS voices, so it was always fine. The
    // SECOND one re-reads the roster (now Yjs proxies), spreads it into a new
    // array and assigns that back — re-integrating types the doc already owns.
    // Negative control (b) in the proxy suite above measures that exact throw.
    // The fix is to deep-unwrap `existing` first; this is the only test that
    // can see it, because nothing about the FIRST import is affected.
    makeLegacyNode();
    const first = await loadDx7SyxFile(NID, syxFile());
    expect(first.error).toBeNull();
    expect(dx7UserPatches(liveNode())).toHaveLength(32);

    const second = await loadDx7SyxFile(NID, syxFile());
    expect(second.error, 'the second import must not report a failure').toBeNull();
    expect(dx7UserPatches(liveNode()), 'both banks are on the roster').toHaveLength(64);
  });

  it('an import auto-selects the first new voice — through the STAMP', async () => {
    makeLegacyNode();
    await loadDx7SyxFile(NID, syxFile());
    const first = dx7UserPatches(liveNode())[0]!;
    expect(dx7PresetName(liveNode())).toBe(first.name);
    // The auto-select is a real stamp: buffer, mutes, rev and both params.
    expect(liveData().voice).toBeTruthy();
    expect(liveData().opOn).toEqual([true, true, true, true, true, true]);
    expect(dx7VoiceRev(liveNode())).toBeGreaterThan(0);
    expect(liveNode().params.algorithm).toBe(first.algorithm);
    expect(liveNode().params.feedback).toBe(first.feedback);
    expect(dx7IsDirty(liveNode()), 'a freshly imported voice is not dirty').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. READERS + THE MIGRATION THEY CARRY
// ---------------------------------------------------------------------------

describe('dx7 edit-buffer readers', () => {
  it('dx7EditVoice resolves a LEGACY node (no data.voice) to its preset', () => {
    makeLegacyNode('STRINGS 1');
    const v = dx7EditVoice(liveNode());
    expect(v.name).toBe('STRINGS 1');
    expect(v.algorithm).toBe(findBuiltinPatch('STRINGS 1')!.algorithm);
    // ...and READING it does NOT write anything back. A migration that rewrote
    // the rack on open could corrupt it; this one cannot, because it never
    // touches the store.
    expect(liveData().voice, 'reading did not migrate the node on disk').toBeUndefined();
    expect(undoManager.undoStack.length).toBe(0);
  });

  it('dx7EditVoice prefers the stored buffer once one exists', () => {
    makeLegacyNode('MARIMBA');
    selectDx7Preset(NID, 'MARIMBA');
    ydoc.transact(() => {
      (liveNode().data as Record<string, unknown>).voice = setOpField(liveData().voice, 0, 'level', 3);
    }, LOCAL_ORIGIN);
    expect(dx7EditVoice(liveNode()).operators[0]!.level, 'the EDIT, not the preset').toBe(3);
    expect(dx7PresetVoice(liveNode())!.operators[0]!.level, 'the ORIGIN is untouched')
      .toBe(findBuiltinPatch('MARIMBA')!.operators[0]!.level);
  });

  it('dx7EditVoice never returns undefined, even when the preset name is gone', () => {
    makeLegacyNode('A CARTRIDGE THAT WAS REMOVED');
    const v = dx7EditVoice(liveNode());
    expect(v.operators).toHaveLength(DX7_OP_COUNT);
    expect(v.algorithm).toBeGreaterThanOrEqual(1);
    expect(dx7PresetVoice(liveNode()), 'but the ORIGIN honestly reports missing').toBeUndefined();
  });

  it('dx7VoiceRev tolerates an absent voiceRev (every legacy rack)', () => {
    makeLegacyNode();
    expect(dx7VoiceRev(liveNode())).toBe(0);
    expect(dx7VoiceRev(undefined)).toBe(0);
    ydoc.transact(() => { (liveNode().data as Record<string, unknown>).voiceRev = 'nope'; }, LOCAL_ORIGIN);
    expect(dx7VoiceRev(liveNode()), 'a corrupt value reads as 0, not NaN').toBe(0);
  });

  it('dx7OpOn defaults to all-on and pads a short/malformed array', () => {
    makeLegacyNode();
    expect(dx7OpOn(liveNode())).toEqual([true, true, true, true, true, true]);
    ydoc.transact(() => { (liveNode().data as Record<string, unknown>).opOn = [false, false]; }, LOCAL_ORIGIN);
    expect(dx7OpOn(liveNode()), 'missing slots read as ON, never as undefined')
      .toEqual([false, false, true, true, true, true]);
  });

  it('dx7FindVoice covers built-ins, cartridge voices and neither', () => {
    makeLegacyNode();
    expect(dx7FindVoice(liveNode(), 'CALLIOPE')?.name).toBe('CALLIOPE');
    expect(dx7FindVoice(liveNode(), 'nope')).toBeUndefined();
    for (const p of DX7_BUILTIN_BANK) {
      expect(dx7FindVoice(liveNode(), p.name)?.name, `built-in ${p.name} resolves`).toBe(p.name);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. THE DIRTY CHIP — and the <select> it must not break
// ---------------------------------------------------------------------------

describe('dx7 dirty chip', () => {
  it('a freshly stamped voice is CLEAN', () => {
    makeLegacyNode();
    selectDx7Preset(NID, 'TUB BELLS');
    expect(dx7IsDirty(liveNode())).toBe(false);
    expect(dx7PresetChipLabel(liveNode())).toBe('TUB BELLS');
  });

  it('a LEGACY node (no buffer at all) is never dirty', () => {
    makeLegacyNode('BASS 1');
    expect(dx7IsDirty(liveNode()), 'nothing has been edited, so nothing has diverged').toBe(false);
    expect(dx7PresetChipLabel(liveNode())).toBe('BASS 1');
  });

  it('MIGRATION GUARD: every built-in stamps CLEAN — no false chip on any voice', () => {
    // The alias trap. The forward ratio law has 588 aliases among its 3200
    // (coarse, fine) pairs, and TUB BELLS authors op5 as COARSE 5 / FINE 40 =
    // x7.00, which the ratio inverse canonicalises to COARSE 7 / FINE 0. A
    // byte-keyed dirty check therefore lights the chip on a rack NOBODY
    // touched. Sweeping all nine is what makes this a guard rather than a
    // spot-check.
    for (const p of DX7_BUILTIN_BANK) {
      makeLegacyNode(p.name);
      selectDx7Preset(NID, p.name);
      expect(dx7IsDirty(liveNode()), `${p.name} must stamp clean`).toBe(false);
      expect(dx7PresetChipLabel(liveNode())).toBe(p.name);
      for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
    }
  });

  it('an operator edit lights the chip', () => {
    makeLegacyNode();
    selectDx7Preset(NID, 'BRASS 1');
    const lvl = (liveData().voice as DX7Voice).operators[2]!.level;
    ydoc.transact(() => {
      (liveNode().data as Record<string, unknown>).voice = setOpField(
        liveData().voice, 2, 'level', lvl === 0 ? 55 : 0,
      );
    }, LOCAL_ORIGIN);
    expect(dx7IsDirty(liveNode())).toBe(true);
    expect(dx7PresetChipLabel(liveNode())).toBe(`BRASS 1 ${DX7_DIRTY_MARK}`);
  });

  it('dx7PresetName stays PURE — the mark never leaks into the <select> value', () => {
    // Dx7Card.svelte binds `<select value={presetName}>` from dx7PresetName and
    // e2e/tests/dx7.spec.ts asserts toHaveValue('E.PIANO 1'). A <select> whose
    // bound value matches no <option> renders BLANK, so folding the mark into
    // this reader would empty the voice dropdown the instant anyone touched an
    // operator. The two readers are separate ON PURPOSE; this pins it.
    makeLegacyNode();
    selectDx7Preset(NID, 'E.PIANO 1');
    ydoc.transact(() => {
      (liveNode().data as Record<string, unknown>).voice = setOpField(liveData().voice, 0, 'r0', 3);
    }, LOCAL_ORIGIN);
    expect(dx7IsDirty(liveNode()), 'precondition: it IS dirty').toBe(true);
    expect(dx7PresetName(liveNode()), 'the <select> value is the bare name').toBe('E.PIANO 1');
    expect(dx7PresetName(liveNode())).not.toContain(DX7_DIRTY_MARK);
    expect(dx7PresetChipLabel(liveNode()), 'only the CHIP carries the mark')
      .toBe(`E.PIANO 1 ${DX7_DIRTY_MARK}`);
    // ...and the value the dropdown binds is one the dropdown actually offers.
    const optionValues = DX7_BUILTIN_BANK.map((p) => p.name);
    expect(optionValues).toContain(dx7PresetName(liveNode()));
  });
});
