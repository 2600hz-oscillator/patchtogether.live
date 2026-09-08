// packages/web/src/lib/audio/modules/dx7.test.ts
//
// Unit tests for the DX7 module's HOST-SIDE BRIDGE — what the factory posts to
// the worklet, and when.
//
// ==========================================================================
// WHY THESE ASSERT MESSAGE TYPES AND `startSample`, NEVER "is it still audible"
// ==========================================================================
// `{type:'patch'}` is the DESTRUCTIVE message: applyPatch zeroes `lastGate`,
// so a still-HIGH gate reads as a fresh rising edge on the very next block and
// the held note HARD-RETRIGGERS — a click and a new attack, not silence.
// Measured on the real processor (packages/dsp/src/dx7-messages.test.ts).
//
// The consequence for testing is the whole reason this file was rewritten:
// **a "the note is still making sound" assertion PASSES under the bug**,
// because the retrigger makes plenty of sound. Loudness is invariant to the
// exact thing under test. So the tests below discriminate on
//   (a) WHICH message the host posted — `algorithm` / `feedback` / `voice`
//       are non-destructive, `patch` is not — and
//   (b) for the algorithm knob, on the real worklet's `startSample` and
//       `envValue` CONTINUITY, driven end-to-end through `handle.setParam`.
// Both come with a negative control that fires the destructive path and shows
// the metric move, so neither can pass vacuously.
//
// REGRESSION (kept): the factory's setParam used to early-out for any paramId
// with no matching AudioParam (`if (!p) return;`). Neither `algorithm` nor
// `feedback` is an AudioParam — they travel via port.postMessage — so the
// early return silently no-op'd both knobs.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dx7Def, DX7_DEFAULT_PRESET, DX7_MIGRATION_ORIGIN, dx7VoiceSignature } from './dx7';
import { parseSyxBank } from '$lib/audio/dx7-syx';
import { findBuiltinPatch } from '$lib/audio/dx7-banks';
import { patch as graphPatch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { dx7EditVoice, selectDx7Preset } from '$lib/ui/modules/dx7-patch-actions';
import type { ModuleNode } from '$lib/graph/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AAAHGOOD_SYX = join(__dirname, '..', '__fixtures__', 'AAAHGOOD.SYX');

/** The factory's poll period (POLL_MS in dx7.ts) with slack for the runner. */
const POLL_WAIT = 220;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, POLL_WAIT));

// ---------------- host bridge integration test ----------------
//
// We mock just enough of Web Audio (AudioContext, AudioWorkletNode, port,
// AudioParam) to drive `dx7Def.factory(...)` end-to-end and observe what
// messages the host posts to the worklet under different setParam paths.

interface PostedMessage {
  type: string;
  value?: number;
  voice?: { algorithm: number; feedback: number; name: string };
}

/** Sink the mock port forwards every posted message to (the REAL processor, in
 *  the continuity suite; nothing, in the message-shape suites). */
type MessageSink = ((m: unknown) => void) | undefined;

function makeMockEnv(sink?: MessageSink) {
  const posted: PostedMessage[] = [];
  const portMock = {
    postMessage: vi.fn((m: PostedMessage) => { posted.push(m); sink?.(m); }),
    onmessage: null as unknown,
    close: vi.fn(),
  };
  const paramSet = new Map<string, { setValueAtTime: (v: number, t: number) => void; value: number }>();
  // The worklet declares voiceCount / level / transpose + the master ADSR as
  // AudioParams. `algorithm` and `feedback` are deliberately NOT parameters
  // (both are handled via port messages).
  for (const id of ['voiceCount', 'level', 'transpose', 'attack', 'decay', 'sustain', 'release']) {
    paramSet.set(id, {
      setValueAtTime: vi.fn(function (this: { value: number }, v: number) { this.value = v; }) as never,
      value: 0,
    });
  }
  class FakeAudioWorkletNode {
    port = portMock;
    parameters = {
      get: (k: string) => paramSet.get(k),
    };
    disconnect = vi.fn();
    constructor(_ctx: unknown, _name: string, _opts?: unknown) {}
  }
  const audioWorklet = {
    addModule: vi.fn(async (_url: string) => {}),
  };
  const ctx = {
    audioWorklet,
    currentTime: 0,
  };

  // Web Audio's AudioWorkletNode is referenced as a global constructor.
  (globalThis as unknown as { AudioWorkletNode: typeof FakeAudioWorkletNode }).AudioWorkletNode =
    FakeAudioWorkletNode;

  return { posted, ctx, paramSet };
}

function makeNode(params?: Record<string, number>): ModuleNode {
  return {
    id: 'dx-test',
    type: 'dx7',
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: params ?? {},
    data: {},
  };
}

/** Every posted message of a given type. */
const ofType = (posted: PostedMessage[], t: string): PostedMessage[] =>
  posted.filter((m) => m.type === t);

describe('dx7Def: factory + the incremental algorithm / feedback bridge', () => {
  beforeEach(() => {
    // Each test gets fresh module state — but the factory itself is
    // stateless aside from `loadedContexts`. Use a fresh ctx per test so
    // addModule is invoked.
  });

  it('factory posts an initial patch message with the requested algorithm', async () => {
    const { posted, ctx } = makeMockEnv();
    const node = makeNode({ algorithm: 5, feedback: 4 });
    await dx7Def.factory(ctx as unknown as AudioContext, node);
    // The factory's "initial send" is the ONE legitimate destructive message:
    // a fresh node has no voices to disturb.
    expect(posted.length).toBeGreaterThanOrEqual(1);
    const init = posted[0]!;
    expect(init.type).toBe('patch');
    expect(init.voice?.name).toBe(DX7_DEFAULT_PRESET);
    expect(init.voice?.algorithm).toBe(5);
    expect(init.voice?.feedback).toBe(4);
  });

  it('setParam("algorithm", 32) posts the NON-DESTRUCTIVE algorithm message — and NO patch', async () => {
    // THE regression, twice over. (1) `params.get('algorithm')` is undefined,
    // so an AudioParam early-out placed before this branch made the knob a
    // silent no-op. (2) the branch used to call sendPatch() — a whole-patch
    // re-send that hard-retriggers every held note. Asserting "a message was
    // posted" catches only the first; asserting the TYPE catches both.
    const { posted, ctx } = makeMockEnv();
    const node = makeNode({ algorithm: 5, feedback: 4 });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    const initialCount = posted.length;
    handle.setParam('algorithm', 32);
    expect(posted.length, 'exactly one message on an algo change').toBe(initialCount + 1);
    const last = posted[posted.length - 1]!;
    expect(last.type, 'the INCREMENTAL message, not a whole-patch re-send').toBe('algorithm');
    expect(last.value).toBe(32);
    expect(
      ofType(posted.slice(initialCount), 'patch'),
      'a destructive patch message would retrigger every held note',
    ).toHaveLength(0);
  });

  it('setParam("feedback", 7) posts the NON-DESTRUCTIVE feedback message — and NO patch', async () => {
    const { posted, ctx } = makeMockEnv();
    const handle = await dx7Def.factory(
      ctx as unknown as AudioContext,
      makeNode({ algorithm: 5, feedback: 4 }),
    );
    const initialCount = posted.length;
    handle.setParam('feedback', 7);
    expect(posted.length).toBe(initialCount + 1);
    const last = posted[posted.length - 1]!;
    expect(last.type).toBe('feedback');
    // The RAW 0..7 byte: the worklet owns the ÷7, exactly as applyPatch does.
    expect(last.value, 'raw byte, not pre-normalized').toBe(7);
    expect(ofType(posted.slice(initialCount), 'patch')).toHaveLength(0);
  });

  it('setParam with the same value does NOT re-post (both message params)', async () => {
    const { posted, ctx } = makeMockEnv();
    const handle = await dx7Def.factory(
      ctx as unknown as AudioContext,
      makeNode({ algorithm: 5, feedback: 4 }),
    );
    const initialCount = posted.length;
    handle.setParam('algorithm', 5);
    handle.setParam('feedback', 4);
    expect(posted.length, 'both are already at those values').toBe(initialCount);
  });

  it('setParam clamps + rounds algorithm to 1..32 and feedback to 0..7', async () => {
    const { posted, ctx } = makeMockEnv();
    const handle = await dx7Def.factory(
      ctx as unknown as AudioContext,
      makeNode({ algorithm: 5, feedback: 4 }),
    );
    const lastValue = (): number | undefined => posted[posted.length - 1]?.value;
    handle.setParam('algorithm', 99);
    expect(lastValue()).toBe(32);
    handle.setParam('algorithm', -3);
    expect(lastValue()).toBe(1);
    handle.setParam('algorithm', 5.4);
    expect(lastValue()).toBe(5);
    handle.setParam('algorithm', 5.7);
    expect(lastValue()).toBe(6);
    handle.setParam('feedback', 99);
    expect(lastValue()).toBe(7);
    handle.setParam('feedback', -2);
    expect(lastValue()).toBe(0);
    handle.setParam('feedback', 3.6);
    expect(lastValue()).toBe(4);
  });

  it('an algorithm sweep 1..32 posts 31 distinct algorithm messages and ZERO patch messages', async () => {
    const { posted, ctx } = makeMockEnv();
    const handle = await dx7Def.factory(
      ctx as unknown as AudioContext,
      makeNode({ algorithm: 1, feedback: 4 }),
    );
    const start = posted.length;
    for (let a = 2; a <= 32; a++) handle.setParam('algorithm', a);
    const sweep = posted.slice(start);
    expect(sweep, '31 algo changes → 31 messages').toHaveLength(31);
    expect(ofType(sweep, 'algorithm'), 'all of them incremental').toHaveLength(31);
    for (let a = 2; a <= 32; a++) expect(sweep[a - 2]!.value).toBe(a);
  });

  it('readParam returns the host shadow for BOTH message params', async () => {
    // `params.get()` is undefined for these two, so without the shadows the
    // motorized knob read and the shell's param cell both go
    // dead. This is the assertion the "retire currentAlgo" draft would have
    // broken.
    const { ctx } = makeMockEnv();
    const handle = await dx7Def.factory(
      ctx as unknown as AudioContext,
      makeNode({ algorithm: 5, feedback: 4 }),
    );
    expect(handle.readParam('algorithm')).toBe(5);
    expect(handle.readParam('feedback')).toBe(4);
    handle.setParam('algorithm', 17);
    handle.setParam('feedback', 2);
    expect(handle.readParam('algorithm')).toBe(17);
    expect(handle.readParam('feedback')).toBe(2);
  });

  it('non-message setParam still routes through the AudioParam path', async () => {
    const { ctx, paramSet } = makeMockEnv();
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, makeNode());
    handle.setParam('level', 1.5);
    expect(paramSet.get('level')?.value).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// THE STAMP → POLL PATH: which message a data change becomes
// ---------------------------------------------------------------------------

describe('dx7Def: voiceRev poll — preset LOAD vs operator EDIT', () => {
  const NID = 'dx7-poll-test';

  function spawn(params: Record<string, number> = {}, data: Record<string, unknown> = {}): ModuleNode {
    const node: ModuleNode = {
      id: NID, type: 'dx7', domain: 'audio',
      position: { x: 0, y: 0 }, params, data,
    };
    ydoc.transact(() => { graphPatch.nodes[NID] = node; }, LOCAL_ORIGIN);
    undoManager.clear();
    undoManager.stopCapturing();
    return graphPatch.nodes[NID] as ModuleNode;
  }

  beforeEach(() => {
    for (const id of Object.keys(graphPatch.nodes)) delete graphPatch.nodes[id];
    undoManager.clear();
    undoManager.stopCapturing();
  });

  it('a PRESET LOAD (the name changed) sends the DESTRUCTIVE patch message', async () => {
    const { posted, ctx } = makeMockEnv();
    const node = spawn({ algorithm: 5, feedback: 4 }, { preset: 'E.PIANO 1' });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    const start = posted.length;

    selectDx7Preset(NID, 'TUB BELLS'); // the real stamp
    await settle();

    const after = posted.slice(start);
    const patches = ofType(after, 'patch');
    expect(patches, 'a deliberate voice swap IS the destructive case').toHaveLength(1);
    expect(patches[0]!.voice?.name).toBe('TUB BELLS');
    // ...and the payload carries the voice's algorithm/feedback, which the
    // stamp had just written onto the params.
    const tub = findBuiltinPatch('TUB BELLS')!;
    expect(patches[0]!.voice?.algorithm).toBe(tub.algorithm);
    expect(patches[0]!.voice?.feedback).toBe(tub.feedback);
    expect(handle.readParam('algorithm'), 'the host shadow followed the stamp').toBe(tub.algorithm);
    expect(handle.readParam('feedback')).toBe(tub.feedback);
    handle.dispose();
  });

  it('an OPERATOR EDIT (buffer + voiceRev moved) sends the NON-DESTRUCTIVE voice message', async () => {
    // THE rack-mate case. A remote collaborator nudging one operator arrives
    // here as a replaced edit buffer plus a voiceRev bump (what dx7SetOpField
    // writes) — and sending `{type:'patch'}` for it would hard-retrigger every
    // note YOU are holding and chop every tail that is ringing out. There is
    // no louder or quieter about it; the discriminator is the message type,
    // which is why that is what we assert.
    const { posted, ctx } = makeMockEnv();
    const node = spawn({ algorithm: 5, feedback: 4 }, { preset: 'E.PIANO 1' });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    selectDx7Preset(NID, 'E.PIANO 1'); // establish a buffer + rev
    await settle();
    const start = posted.length;

    // A rack-mate's operator edit: the buffer and the rev move, the name does
    // not (a whole-buffer replacement, exactly like dx7SetOpField).
    const edited = { ...findBuiltinPatch('E.PIANO 1')! };
    edited.operators = edited.operators.map((o, i) => (i === 0 ? { ...o, level: 42 } : { ...o }));
    ydoc.transact(() => {
      const d = graphPatch.nodes[NID]!.data as Record<string, unknown>;
      d.voice = edited;
      d.voiceRev = (d.voiceRev as number) + 1;
    }, LOCAL_ORIGIN);
    await settle();

    const after = posted.slice(start);
    expect(ofType(after, 'voice'), 'non-destructive re-apply').toHaveLength(1);
    expect(
      ofType(after, 'patch'),
      'a patch here would stop a rack-mate’s edit from being survivable',
    ).toHaveLength(0);
    handle.dispose();
  });

  it('SAME-SESSION LOAD: a patch aliasing on (preset, voiceRev) with a DIFFERENT buffer still reaches the worklet', async () => {
    // THE REV-ALIASING CLASS (the warrensspectrum `wsBandsRev` fix, ported).
    // `voiceRev` is a per-node counter persisted INTO each patch, so two
    // patches saved after the same number of edits from the same preset hold
    // an IDENTICAL (preset, voiceRev) pair around different edit buffers. A
    // same-session load replaces every node in one transaction at REUSED ids
    // (loadEnvelopeIntoStore), the reconciler re-materializes nothing, and
    // THIS factory instance keeps polling — under a rev-based change test the
    // load aliased to "no change" and the worklet kept playing the previous
    // patch's voice.
    const { posted, ctx } = makeMockEnv();
    const vA = { ...findBuiltinPatch('E.PIANO 1')! };
    vA.operators = vA.operators.map((o, i) => (i === 0 ? { ...o, level: 10 } : { ...o }));
    spawn({ algorithm: 5, feedback: 4 }, { preset: 'E.PIANO 1', voice: vA, voiceRev: 3 });
    // ⚠ The factory gets a SNAPSHOT-shaped node (plain `id` string), exactly
    // what the reconciler hands it (buildPatchSnapshot copies `id`). Handing
    // it the live store proxy instead would detach `node.id` at the delete
    // below and every livePatch lookup would silently miss — a failure mode
    // the PRODUCT does not have.
    const factoryNode: ModuleNode = {
      id: NID, type: 'dx7', domain: 'audio', position: { x: 0, y: 0 },
      params: { algorithm: 5, feedback: 4 }, data: {},
    };
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, factoryNode);
    await settle();
    const start = posted.length;

    // Patch B — saved elsewhere after the same NUMBER of edits: same preset
    // name, same rev, different buffer. Loaded over patch A in one delete +
    // re-insert transaction, exactly as loadEnvelopeIntoStore does.
    const vB = { ...findBuiltinPatch('E.PIANO 1')! };
    vB.operators = vB.operators.map((o, i) => (i === 1 ? { ...o, ratio: 7.77 } : { ...o }));
    ydoc.transact(() => {
      delete graphPatch.nodes[NID];
      graphPatch.nodes[NID] = {
        id: NID, type: 'dx7', domain: 'audio', position: { x: 0, y: 0 },
        params: { algorithm: 5, feedback: 4 },
        data: { preset: 'E.PIANO 1', voice: vB, voiceRev: 3 },
      };
    }, LOCAL_ORIGIN);
    await settle();

    const after = posted.slice(start);
    const voices = ofType(after, 'voice');
    expect(
      voices,
      'the loaded buffer must reach the worklet even though (preset, voiceRev) aliased',
    ).toHaveLength(1);
    const ops = (voices[0]!.voice as unknown as { operators: Array<{ ratio: number }> }).operators;
    expect(ops[1]!.ratio, 'and it is the LOADED patch’s buffer, not the old one').toBe(7.77);
    expect(ofType(after, 'patch'), 'a same-name load stays non-destructive').toHaveLength(0);
    handle.dispose();
  });

  it('a voiceRev bump with an UNCHANGED buffer posts nothing (an identical payload is pure churn)', async () => {
    // The opOn-toggle shape: dx7ToggleOp bumps the rev but changes nothing
    // that crosses the worklet boundary. Under the content signature that is
    // a genuine no-op rather than a redundant whole-voice re-send.
    const { posted, ctx } = makeMockEnv();
    const node = spawn({ algorithm: 5, feedback: 4 }, { preset: 'E.PIANO 1' });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    selectDx7Preset(NID, 'E.PIANO 1');
    await settle();
    const start = posted.length;

    ydoc.transact(() => {
      const d = graphPatch.nodes[NID]!.data as Record<string, unknown>;
      d.voiceRev = (d.voiceRev as number) + 1;
    }, LOCAL_ORIGIN);
    await settle();

    expect(posted.slice(start), 'nothing on the wire moved, so nothing is sent').toHaveLength(0);
    handle.dispose();
  });

  it('a remote voiceRev bump does NOT revert the local feedback knob', async () => {
    // The bug the params-injection closes: the payload used to carry
    // `voice.feedback` (the STAMPED value), so any rack-mate's edit silently
    // dragged your feedback knob back to whatever the patch stored.
    const { posted, ctx } = makeMockEnv();
    const node = spawn({ algorithm: 5, feedback: 4 }, { preset: 'BASS 1' });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    selectDx7Preset(NID, 'BASS 1');
    await settle();

    // The player rides feedback to 1 — deliberately different from BASS 1's
    // stored value, which is what the old code would have re-sent.
    const stored = findBuiltinPatch('BASS 1')!.feedback;
    const ridden = stored === 1 ? 6 : 1;
    ydoc.transact(() => { graphPatch.nodes[NID]!.params.feedback = ridden; }, LOCAL_ORIGIN);
    handle.setParam('feedback', ridden); // what the reconciler does
    const start = posted.length;

    // The rack-mate's edit: buffer replaced + rev bumped (dx7SetOpField shape).
    const nudged = { ...findBuiltinPatch('BASS 1')! };
    nudged.operators = nudged.operators.map((o, i) => (i === 3 ? { ...o, level: 55 } : { ...o }));
    ydoc.transact(() => {
      const d = graphPatch.nodes[NID]!.data as Record<string, unknown>;
      d.voice = nudged;
      d.voiceRev = (d.voiceRev as number) + 1;
    }, LOCAL_ORIGIN);
    await settle();

    const voiceMsgs = ofType(posted.slice(start), 'voice');
    expect(voiceMsgs).toHaveLength(1);
    expect(
      voiceMsgs[0]!.voice?.feedback,
      'the payload carries the PARAM, not the stamped voice’s own field',
    ).toBe(ridden);
    expect(voiceMsgs[0]!.voice?.feedback).not.toBe(stored);
    expect(handle.readParam('feedback')).toBe(ridden);
    handle.dispose();
  });

  it('a saved rack with operator EDITS boots into the edit buffer, not the pristine preset', async () => {
    const { posted, ctx } = makeMockEnv();
    const edited = { ...findBuiltinPatch('MARIMBA')! };
    edited.operators = edited.operators.map((o, i) => (i === 0 ? { ...o, level: 7 } : { ...o }));
    const node = spawn({ algorithm: 3, feedback: 2 }, { preset: 'MARIMBA', voice: edited, voiceRev: 9 });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    const init = posted[0]!;
    expect(init.type).toBe('patch');
    expect(
      (init.voice as unknown as { operators: { level: number }[] }).operators[0]!.level,
      'the SAVED edit, not MARIMBA’s stored level',
    ).toBe(7);
    // the params win over the voice's own fields, even on boot
    expect(init.voice?.algorithm).toBe(3);
    expect(init.voice?.feedback).toBe(2);
    handle.dispose();
  });

  it('the factory and dx7EditVoice resolve the SAME buffer (the duplicated-reader gate)', async () => {
    // The factory keeps its OWN four-line node readers rather than importing
    // dx7-patch-actions (that would close an audio→ui→audio import cycle). A
    // duplicated reader nothing compares is how two implementations drift, so
    // this pins them against each other on both shapes that matter: a LEGACY
    // node resolving through its preset name, and a node with a stored buffer.
    for (const data of [
      { preset: 'HARMONICA' } as Record<string, unknown>,
      (() => {
        const v = { ...findBuiltinPatch('CALLIOPE')! };
        v.operators = v.operators.map((o, i) => (i === 2 ? { ...o, level: 11 } : { ...o }));
        return { preset: 'CALLIOPE', voice: v, voiceRev: 4 } as Record<string, unknown>;
      })(),
    ]) {
      for (const id of Object.keys(graphPatch.nodes)) delete graphPatch.nodes[id];
      const { posted, ctx } = makeMockEnv();
      const node = spawn({ algorithm: 5, feedback: 4 }, data);
      const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
      const uiView = dx7EditVoice(graphPatch.nodes[NID] as ModuleNode);
      const posting = posted[0]!.voice as unknown as {
        operators: Array<{ r: number[]; l: number[]; ratio: number; level: number }>;
        transpose: number;
      };
      expect(posting.operators.map((o) => o.level), `levels agree (${String(data.preset)})`)
        .toEqual(uiView.operators.map((o) => o.level));
      expect(posting.operators.map((o) => o.r)).toEqual(uiView.operators.map((o) => o.r));
      expect(posting.operators.map((o) => o.ratio)).toEqual(uiView.operators.map((o) => o.ratio));
      expect(posting.transpose).toBe(uiView.transpose);
      handle.dispose();
    }
  });

  it('MIGRATION: a legacy node with no params.feedback is hydrated from its voice', async () => {
    // Every rack saved before this PR: a preset NAME, no `params.feedback` and
    // often no `params.algorithm`. Without hydration the FEEDBACK cell would
    // render the def default (4) while the engine played BASS 1's stored value
    // — a control lying about its own range/value.
    const { ctx } = makeMockEnv();
    const node = spawn({}, { preset: 'BASS 1' }); // params EMPTY, like a legacy rack
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    await settle();

    const bass = findBuiltinPatch('BASS 1')!;
    expect(graphPatch.nodes[NID]!.params.algorithm).toBe(bass.algorithm);
    expect(graphPatch.nodes[NID]!.params.feedback).toBe(bass.feedback);
    // ...and it is NOT an undoable edit. A migration write on the Cmd-Z stack
    // would let a user "undo" a rack into the broken state it just left.
    expect(undoManager.undoStack, 'the hydration is deliberately non-undoable').toHaveLength(0);
    expect(DX7_MIGRATION_ORIGIN).not.toBe(LOCAL_ORIGIN);
    handle.dispose();
  });

  it('MIGRATION: an absent voiceRev does not fire a re-send on every tick', async () => {
    // `undefined !== undefined` is false, but `readVoiceRev` must still
    // normalize — a reader returning undefined and comparing it against a
    // number would re-send the whole patch ten times a second on every legacy
    // rack in existence.
    const { posted, ctx } = makeMockEnv();
    const node = spawn({ algorithm: 5, feedback: 4 }, { preset: 'E.PIANO 1' });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    const start = posted.length;
    await settle();
    await settle();
    expect(posted.length - start, 'an idle legacy node posts nothing').toBe(0);
    handle.dispose();
  });

  it('MIGRATION: params already present are LEFT ALONE (a saved override wins)', async () => {
    const { ctx } = makeMockEnv();
    const node = spawn({ algorithm: 21, feedback: 0 }, { preset: 'BASS 1' });
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    await settle();
    expect(graphPatch.nodes[NID]!.params.algorithm, 'the user’s override survives').toBe(21);
    expect(graphPatch.nodes[NID]!.params.feedback).toBe(0);
    handle.dispose();
  });
});

describe('dx7VoiceSignature — the poll’s content change test', () => {
  it('distinct buffers sign differently; a structural clone signs identically', () => {
    const base = { ...findBuiltinPatch('E.PIANO 1')! };
    const clone = {
      ...base,
      operators: base.operators.map((o) => ({ ...o, r: [...o.r], l: [...o.l] })),
    } as typeof base;
    expect(dx7VoiceSignature(clone), 'a clone must NOT read as a change').toBe(
      dx7VoiceSignature(base),
    );

    // One field, one operator — every wire field must move the signature.
    const movedLevel = { ...base, operators: base.operators.map((o, i) => (i === 4 ? { ...o, level: (Number(o.level) + 1) % 100 } : o)) };
    expect(dx7VoiceSignature(movedLevel)).not.toBe(dx7VoiceSignature(base));
    const movedRate = { ...base, operators: base.operators.map((o, i) => (i === 2 ? { ...o, r: [o.r[0], o.r[1], o.r[2], (Number(o.r[3]) + 1) % 100] as typeof o.r } : o)) };
    expect(dx7VoiceSignature(movedRate as typeof base)).not.toBe(dx7VoiceSignature(base));
    const movedFixedHz = { ...base, operators: base.operators.map((o, i) => (i === 0 ? { ...o, fixedMode: true, fixedHz: 123.4 } : o)) };
    expect(dx7VoiceSignature(movedFixedHz)).not.toBe(dx7VoiceSignature(base));
    const movedTranspose = { ...base, transpose: Number(base.transpose) + 1 };
    expect(dx7VoiceSignature(movedTranspose)).not.toBe(dx7VoiceSignature(base));
  });
});

// ---------------------------------------------------------------------------
// THE CONTINUITY PROOF — host setParam driven into the REAL worklet
// ---------------------------------------------------------------------------
//
// Everything above discriminates on message TYPE, which is only as good as the
// claim "the algorithm message is non-destructive". This suite removes the
// middleman: the mock port forwards straight into a real Dx7Processor
// instance, a note is held, and we read `startSample` / `envValue` off the
// live voice. A fresh note-on moves `startSample`; a continuing note does not.
//
// The negative control fires `{type:'patch'}` at the SAME processor in the
// SAME state and shows `startSample` move — so the probe is proven able to
// see the failure it is claiming does not happen.

interface VoiceStateView {
  active: boolean;
  startSample: number;
  envValue: Float32Array;
}
interface ProcInstance {
  port: { onmessage: ((e: { data: unknown }) => void) | null };
  process: (i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>) => boolean;
  patch: { algorithm: number; feedback: number };
  voices: VoiceStateView[];
}
type ProcCtor = new (options?: { processorOptions?: unknown }) => ProcInstance;

const SR = 48000;
const BLOCK = 128;

describe('dx7Def: setParam("algorithm") does not disturb a HELD note (real worklet)', () => {
  let Dx7Processor: ProcCtor | null = null;
  let savedGlobals: Record<string, unknown> = {};

  beforeAll(async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    // Save + restore: this vitest project runs single-fork, so leaking worklet
    // globals into unrelated web specs would be a cross-test hazard.
    savedGlobals = {
      sampleRate: g.sampleRate,
      AudioWorkletProcessor: g.AudioWorkletProcessor,
      registerProcessor: g.registerProcessor,
    };
    g.sampleRate = SR;
    g.AudioWorkletProcessor = class {
      port = { onmessage: null as unknown, postMessage: (): void => {} };
    };
    g.registerProcessor = (_n: string, ctor: ProcCtor) => { Dx7Processor = ctor; };
    // The worklet SOURCE, not the built dist: this asserts against the code in
    // THIS worktree rather than whatever dist happens to be lying around.
    await import('../../../../../dsp/src/dx7');
    if (!Dx7Processor) throw new Error('dx7 processor did not register');
  });

  afterAll(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(savedGlobals)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  });

  function makeParams(): Record<string, Float32Array> {
    return {
      voiceCount: new Float32Array([5]),
      level: new Float32Array([1]),
      transpose: new Float32Array([0]),
      attack: new Float32Array([0.001]),
      decay: new Float32Array([0.1]),
      sustain: new Float32Array([1]),
      release: new Float32Array([0.005]),
    };
  }
  /** 10-channel polyPitchGate block: lane 0 pitch 0 V (C4), lane 0 gate high. */
  function makeInputs(gate: number): Float32Array[][] {
    const poly: Float32Array[] = [];
    for (let ch = 0; ch < 10; ch++) poly.push(new Float32Array(BLOCK));
    poly[1]!.fill(gate);
    return [poly, [], []];
  }
  function render(p: ProcInstance, blocks: number, gate: number): void {
    const out = new Float32Array(BLOCK);
    const params = makeParams();
    const inputs = makeInputs(gate);
    for (let b = 0; b < blocks; b++) p.process(inputs, [[out]], params);
  }

  /** A processor wired to a real factory handle, with lane 0 mid-note: gate
   *  high for 8 blocks, so envelopes are running and phases have advanced. */
  async function bootHeldNote(): Promise<{
    proc: ProcInstance;
    handle: Awaited<ReturnType<typeof dx7Def.factory>>;
    posted: PostedMessage[];
  }> {
    const proc = new Dx7Processor!();
    const { ctx, posted } = makeMockEnv((m) => proc.port.onmessage?.({ data: m }));
    const handle = await dx7Def.factory(
      ctx as unknown as AudioContext,
      makeNode({ algorithm: 5, feedback: 4 }),
    );
    render(proc, 8, 1);
    return { proc, handle, posted };
  }

  /** Where the note is: its identity (`startSample` — a FRESH note-on gets a
   *  new one) and its exact envelope state, per operator. */
  const noteState = (p: ProcInstance) => ({
    active: p.voices[0]!.active,
    startSample: p.voices[0]!.startSample,
    envValue: Array.from(p.voices[0]!.envValue),
  });

  it('the algorithm knob re-wires the routing with ZERO voice disturbance', async () => {
    // A CONTROL processor that is left alone, advanced by the same one block.
    // Comparing against it — rather than against "is the envelope still
    // non-zero" — is what makes this an assertion about CONTINUITY: the
    // envelope has to be exactly where it would have been had nobody touched
    // the knob, not merely somewhere plausible.
    const control = await bootHeldNote();
    render(control.proc, 1, 1);
    const expected = noteState(control.proc);
    expect(expected.active, 'precondition: lane 0 really is mid-note').toBe(true);
    expect(Math.max(...expected.envValue), 'precondition: envelopes are open').toBeGreaterThan(0);

    const t = await bootHeldNote();
    t.handle.setParam('algorithm', 32); // THE GESTURE, through the real host path
    render(t.proc, 1, 1); // gate STILL high

    expect(t.proc.patch.algorithm, 'the engine took the new algorithm').toBe(32);
    expect(noteState(t.proc), 'the note continued as if nothing happened').toEqual(expected);

    control.handle.dispose();
    t.handle.dispose();
  });

  it('the feedback knob is likewise non-destructive, and lands NORMALIZED in the engine', async () => {
    const control = await bootHeldNote();
    render(control.proc, 1, 1);
    const expected = noteState(control.proc);

    const t = await bootHeldNote();
    t.handle.setParam('feedback', 7);
    render(t.proc, 1, 1);

    // The host sends the RAW byte; the worklet divides by 7. If the host ever
    // "helpfully" pre-normalized, this reads 1/7 and the assertion catches it.
    expect(t.proc.patch.feedback).toBeCloseTo(1, 6);
    expect(noteState(t.proc), 'the note continued as if nothing happened').toEqual(expected);

    control.handle.dispose();
    t.handle.dispose();
  });

  it('NEGATIVE CONTROL: a `patch` message in the same state DOES retrigger', async () => {
    // Without this, both assertions above could be passing because the probe
    // is blind — if `startSample` were latched, or the fixture were not really
    // mid-note, "unchanged" would be free. Fire the destructive message the
    // host must no longer send, in the same state, and watch the metric move.
    const control = await bootHeldNote();
    render(control.proc, 1, 1);
    const expected = noteState(control.proc);

    const t = await bootHeldNote();
    // Replay the factory's OWN initial patch payload — i.e. exactly what
    // `setParam('algorithm')` used to post before this PR.
    const initialPatch = t.posted[0]!;
    expect(initialPatch.type).toBe('patch');
    t.proc.port.onmessage?.({ data: initialPatch });
    render(t.proc, 1, 1); // gate STILL high

    const after = noteState(t.proc);
    expect(
      after.startSample,
      'the destructive path fires a FRESH note-on — the identity the probe reads',
    ).not.toBe(expected.startSample);
    expect(after, 'and the whole note state diverges from the undisturbed one')
      .not.toEqual(expected);

    // ⚠ AND THE POINT OF THE WHOLE SUITE: the coarse checks still pass here.
    // E.PIANO 1's attack is fast enough that one block after a hard retrigger
    // the envelope is back ABOVE where it was — measured, not assumed. So
    // "still active", "still audible" and even "envelope is high" are all
    // TRUE under the bug. Only the comparison against the control separates
    // them, which is why this file never asserts audibility.
    expect(after.active, 'still "playing" — a retrigger is loud, not silent').toBe(true);
    expect(Math.max(...after.envValue), 'still "audible"').toBeGreaterThan(0);

    control.handle.dispose();
    t.handle.dispose();
  });
});

// ---------------- SYX-load → SyncedStore → patch-message regression ----------------
//
// REGRESSION (PR fix/dx7-syx-bank-loading): the user reported that uploading a
// .syx cartridge made every patch sound like the bundled E.PIANO 1. Root
// cause: when SYX voices live in node.data.userPatches (which is backed by
// the SyncedStore Y.Doc), reading them returns Yjs PROXY objects — Y.Map
// for the voice + Y.Array for op.r/op.l. The previous sendPatch built a
// payload that referenced those proxies directly, then handed it to
// `worklet.port.postMessage`. structuredClone (which postMessage uses
// under the hood in real browsers) rejects Yjs proxies — so the worklet
// never received the new patch and kept playing whatever it last got
// (E.PIANO 1, sent on factory init from the plain-JS DX7_BUILTIN_BANK).
//
// The fix: deep-unwrap to plain JS in sendVoice — every primitive coerced
// via Number()/Boolean()/String(), every array materialized into a fresh
// Array<number>. This test asserts the posted payload structured-clones
// successfully and that the cloned operators carry through the SYX
// voice's actual ratios + levels (NOT the E.PIANO defaults).
describe('dx7Def: SYX upload → patch message survives structured-clone (the bug)', () => {
  beforeEach(() => {
    // Wipe any leftover nodes from previous tests.
    for (const id of Object.keys(graphPatch.nodes)) {
      delete graphPatch.nodes[id];
    }
  });

  it('after SYX upload+select, posted patch (a) clones cleanly and (b) carries SYX voice data', async () => {
    const { posted, ctx } = makeMockEnv();
    const nodeId = 'dx7-syx-regression';

    // Spawn the dx7 factory against the SHARED graphPatch (the same one
    // Dx7Card.svelte writes through).
    const node: ModuleNode = {
      id: nodeId, type: 'dx7', domain: 'audio',
      position: { x: 0, y: 0 }, params: {}, data: {},
    };
    graphPatch.nodes[nodeId] = node;
    const handle = await dx7Def.factory(ctx as unknown as AudioContext, node);
    // Initial post is the bundled default (no SYX yet).
    expect(posted[0]?.voice?.name).toBe(DX7_DEFAULT_PRESET);

    // Mimic the Card: parse a real cartridge + write the voices into
    // node.data.userPatches via the SyncedStore (NOT plain JS — this is
    // what triggers the Yjs-proxy wrapping), then STAMP the first voice
    // through the shared action the card and the shell both call.
    const bytes = new Uint8Array(readFileSync(AAAHGOOD_SYX));
    const result = parseSyxBank(bytes);
    expect(result.voices.length).toBe(32);
    const t = graphPatch.nodes[nodeId]!;
    if (!t.data) t.data = {};
    (t.data as Record<string, unknown>).userPatches = result.voices;
    const target = result.voices[0]!; // "Trombones" — algorithm 18
    selectDx7Preset(nodeId, target.name);

    // Wait for the dx7 factory's poll loop (POLL_MS = 100) to react.
    await settle();

    // The posted payload must (a) survive structuredClone — the actual
    // browser postMessage path, and (b) reflect the SYX voice fields.
    const lastPatch = [...posted].reverse().find((m) => m.type === 'patch');
    expect(lastPatch, 'a patch message was posted after SYX preset select').toBeDefined();
    // (a) survives structured-clone — this is the regression assertion.
    expect(() => structuredClone(lastPatch)).not.toThrow();
    const cloned = structuredClone(lastPatch) as typeof lastPatch & {
      voice?: {
        name: string;
        algorithm: number;
        feedback: number;
        operators?: Array<{ r: number[]; l: number[]; ratio: number; level: number }>;
      };
    };
    // (b) carries SYX voice data after the clone — operators are real
    // Array<number>s, ratios + levels match the parsed voice (NOT the
    // bundled E.PIANO 1 defaults).
    expect(cloned.voice?.name).toBe(target.name);
    expect(cloned.voice?.algorithm).toBe(target.algorithm);
    expect(cloned.voice?.feedback).toBe(target.feedback);
    const op0 = cloned.voice?.operators?.[0];
    expect(op0).toBeDefined();
    expect(Array.isArray(op0!.r)).toBe(true);
    expect(op0!.r).toEqual(target.operators[0]!.r);
    expect(op0!.l).toEqual(target.operators[0]!.l);
    expect(op0!.level).toBe(target.operators[0]!.level);
    // Spot-check op4 (where the SYX ratios diverge most from defaults).
    const op4 = cloned.voice?.operators?.[4];
    expect(op4!.ratio).toBeCloseTo(target.operators[4]!.ratio, 4);
    handle.dispose();
  }, 5000);
});
