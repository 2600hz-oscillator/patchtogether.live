import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  bindingsFromPairs,
  clearPresentBindings,
  decideRestore,
  parsePresentSlotKey,
  presentAuthority,
  presentSlotKey,
  canDescribeBindings,
  mayPersist,
  planRestore,
  readPresentBindings,
  readPresentBindingsFromUpdate,
  rigMatchesSaved,
  writePresentBindings,
  type LiveScreen,
  type PresentBinding,
} from './present-bindings';
import { describeScreen, type ScreenDescriptor } from './screen-identity';

// The owner's actual rig, read off getScreenDetails() in Edge 151 on macOS
// (2026-08-26). The middle display reporting an EMPTY label is not a fixture
// convenience — it is what that hardware really returns, and it is why the
// match ladder cannot lean on labels alone.
const RETINA: ScreenDescriptor = {
  label: 'Built-in Retina Display', isInternal: true,
  width: 1512, height: 982, dpr: 2, left: 0, top: 0,
};
const UNLABELLED: ScreenDescriptor = {
  label: '', isInternal: false,
  width: 1920, height: 1080, dpr: 1, left: 1512, top: 0,
};
const WISE_LUCK: ScreenDescriptor = {
  label: 'Wise Luck', isInternal: false,
  width: 1280, height: 720, dpr: 1, left: 3432, top: 0,
};

const live = (...ds: ScreenDescriptor[]): LiveScreen[] =>
  ds.map((descriptor, i) => ({ id: i === 0 ? 'primary' : `display-${i}`, descriptor }));

const RIG = live(RETINA, UNLABELLED, WISE_LUCK);

describe('read/write round-trip', () => {
  it('survives an encode/decode of the whole doc, as a save does', () => {
    const doc = new Y.Doc();
    const bindings: PresentBinding[] = [
      { nodeId: 'out-a', screen: UNLABELLED },
      { nodeId: 'out-b', screen: WISE_LUCK },
    ];
    writePresentBindings(doc, bindings);

    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
    expect(readPresentBindings(reloaded)).toEqual(bindings);
  });

  it('returns [] for a patch saved before the feature existed', () => {
    expect(readPresentBindings(new Y.Doc())).toEqual([]);
  });

  it('drops malformed entries rather than throwing on a peer/legacy write', () => {
    const doc = new Y.Doc();
    doc.getMap('settings').set('presentBindings', [
      { nodeId: 'good', screen: WISE_LUCK },
      { nodeId: 'no-screen' },
      { screen: WISE_LUCK },
      { nodeId: 'bad-screen', screen: { label: 'x' } },
      null,
      'nonsense',
    ]);
    expect(readPresentBindings(doc).map((b) => b.nodeId)).toEqual(['good']);
  });
});

describe('planRestore on the owner rig', () => {
  it('restores both externals when nothing changed', () => {
    const saved: PresentBinding[] = [
      { nodeId: 'out-a', screen: UNLABELLED },
      { nodeId: 'out-b', screen: WISE_LUCK },
    ];
    expect(planRestore(saved, RIG, ['out-a', 'out-b'])).toEqual([
      { nodeId: 'out-a', screenId: 'display-1' },
      { nodeId: 'out-b', screenId: 'display-2' },
    ]);
  });

  it('still resolves the UNLABELLED display after a rearrange, via its key', () => {
    const moved = live(RETINA, { ...WISE_LUCK, left: 1512 }, { ...UNLABELLED, left: 2792 });
    const saved: PresentBinding[] = [{ nodeId: 'out-a', screen: UNLABELLED }];
    expect(planRestore(saved, moved, ['out-a'])).toEqual([
      { nodeId: 'out-a', screenId: 'display-2' },
    ]);
  });

  it('falls through to POSITION when the projector renegotiates to 720p and collides with Wise Luck', () => {
    // The failure this rig is genuinely exposed to: the unlabelled 1080p panel
    // comes up at 1280x720, so its key, label, and geometry all now match
    // Wise Luck. Only the arrangement origin still separates them.
    const renegotiated = live(RETINA, { ...UNLABELLED, width: 1280, height: 720 }, WISE_LUCK);
    const saved: PresentBinding[] = [{ nodeId: 'out-a', screen: UNLABELLED }];
    expect(planRestore(saved, renegotiated, ['out-a'])).toEqual([
      { nodeId: 'out-a', screenId: 'display-1' },
    ]);
  });

  it('skips a binding whose module was deleted from the patch', () => {
    const saved: PresentBinding[] = [
      { nodeId: 'deleted', screen: UNLABELLED },
      { nodeId: 'out-b', screen: WISE_LUCK },
    ];
    expect(planRestore(saved, RIG, ['out-b'])).toEqual([
      { nodeId: 'out-b', screenId: 'display-2' },
    ]);
  });

  it('does not let a deleted module consume the display its neighbour wants', () => {
    const saved: PresentBinding[] = [
      { nodeId: 'deleted', screen: WISE_LUCK },
      { nodeId: 'out-b', screen: WISE_LUCK },
    ];
    expect(planRestore(saved, RIG, ['out-b'])).toEqual([
      { nodeId: 'out-b', screenId: 'display-2' },
    ]);
  });

  it('restores only what is attached when the projector is unplugged', () => {
    const saved: PresentBinding[] = [
      { nodeId: 'out-a', screen: UNLABELLED },
      { nodeId: 'out-b', screen: WISE_LUCK },
    ];
    expect(planRestore(saved, live(RETINA, UNLABELLED), ['out-a', 'out-b'])).toEqual([
      { nodeId: 'out-a', screenId: 'display-1' },
    ]);
  });
});

describe('rigMatchesSaved gates automatic restore', () => {
  const saved: PresentBinding[] = [
    { nodeId: 'out-a', screen: UNLABELLED },
    { nodeId: 'out-b', screen: WISE_LUCK },
  ];

  it('is true on the rig the patch was saved on', () => {
    expect(rigMatchesSaved(saved, RIG)).toBe(true);
  });

  it('is false for a rack-mate on a laptop with no externals', () => {
    expect(rigMatchesSaved(saved, live(RETINA))).toBe(false);
  });

  it('is false when only some of the saved displays are attached', () => {
    expect(rigMatchesSaved(saved, live(RETINA, WISE_LUCK))).toBe(false);
  });

  it('is false for a patch that never presented, so an empty set never auto-fires', () => {
    expect(rigMatchesSaved([], RIG)).toBe(false);
  });
});

describe('describeScreen feeds the ladder from a real ScreenDetailed shape', () => {
  it('reads the unlabelled panel without inventing a label', () => {
    const d = describeScreen({
      label: '', isInternal: false, width: 1920, height: 1080,
      devicePixelRatio: 1, left: 1512, top: 0,
    });
    expect(d).toEqual(UNLABELLED);
  });
});

describe('bindingsFromPairs', () => {
  it('records the descriptor of each lit display', () => {
    const pairs = [
      { nodeId: 'out-a', screenId: 'display-1' },
      { nodeId: 'out-b', screenId: 'display-2' },
    ];
    expect(bindingsFromPairs(pairs, RIG)).toEqual([
      { nodeId: 'out-a', screen: UNLABELLED },
      { nodeId: 'out-b', screen: WISE_LUCK },
    ]);
  });

  it('drops a pair whose display vanished between the present and the write', () => {
    const pairs = [{ nodeId: 'out-a', screenId: 'display-9' }];
    expect(bindingsFromPairs(pairs, RIG)).toEqual([]);
  });
});

describe('mayPersist', () => {
  it('stays disarmed before a restore pass has run', () => {
    expect(mayPersist({ attempted: false, expected: 0, opened: 0 })).toBe(false);
  });

  it('arms for a patch that had nothing saved', () => {
    expect(mayPersist({ attempted: true, expected: 0, opened: 0 })).toBe(true);
  });

  it('arms once a restore actually opened a projector', () => {
    expect(mayPersist({ attempted: true, expected: 2, opened: 2 })).toBe(true);
  });

  it('REFUSES to arm when the popup blocker ate every window', () => {
    // Arming here would write an empty set over the saved bindings and lose
    // the rig on the next save.
    expect(mayPersist({ attempted: true, expected: 2, opened: 0 })).toBe(false);
  });

  it('arms on a partial open — one blocked display must not veto the rest', () => {
    expect(mayPersist({ attempted: true, expected: 2, opened: 1 })).toBe(true);
  });
});

describe('canDescribeBindings', () => {
  it('refuses while projectors are live but the screen list is unpopulated', () => {
    // The defect this exists for: Canvas armed the write without ever calling
    // loadScreens(), so every first save wrote [] over a real rig.
    expect(canDescribeBindings([{ nodeId: 'out-a', screenId: 'display-1' }], [])).toBe(false);
  });

  it('allows an empty write, which is the user stopping the last projector', () => {
    expect(canDescribeBindings([], [])).toBe(true);
  });

  it('allows a normal write', () => {
    expect(canDescribeBindings([{ nodeId: 'out-a', screenId: 'display-1' }], RIG)).toBe(true);
  });
});

describe('readPresentBindingsFromUpdate', () => {
  const saved: PresentBinding[] = [{ nodeId: 'workflow-videoOut', screen: UNLABELLED }];

  function envelopeUpdate(bindings: PresentBinding[]): string {
    const doc = new Y.Doc();
    writePresentBindings(doc, bindings);
    return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  }

  it('reads bindings the live doc will never see', () => {
    // loadEnvelopeIntoStore applies the envelope to a THROWAWAY doc and copies
    // only nodes + edges across, so the live doc's settings map still belongs
    // to the previous patch. This is the owner's sc3ptperf.zip case: a correct
    // binding in the file, and "nothing saved" on load.
    expect(readPresentBindingsFromUpdate(envelopeUpdate(saved))).toEqual(saved);
  });

  it('returns [] for an envelope saved before the feature existed', () => {
    const doc = new Y.Doc();
    doc.getMap('nodes').set('n1', 'x');
    const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
    expect(readPresentBindingsFromUpdate(update)).toEqual([]);
  });

  it('returns [] rather than throwing on a corrupt update', () => {
    expect(readPresentBindingsFromUpdate('bm90LWEteWpzLXVwZGF0ZQ==')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WHO OWNS DISPLAY PLACEMENT
// ---------------------------------------------------------------------------
//
// ⚠ THE COLLISION THIS RULE EXISTS FOR. Two placement surfaces already exist:
// `settings.presentBindings`, which rides the SHARED doc into every save,
// .ptperf zip and peer sync and which Canvas restores automatically on three
// paths; and the native shell's display map, which is local and per-machine.
// Leave both live and an old patch reopens its legacy projectors while the shell
// creates its own sinks — same monitors, two window classes, opposite lifetimes,
// one of them swept on the next patch load. The rule below is absolute rather
// than a merge, and the tests come in pairs so "always defer" and "never defer"
// both go red.

describe('present authority — the shell and the patch cannot both place windows', () => {
  const saved: PresentBinding[] = [{ nodeId: 'out', screen: WISE_LUCK }];

  it('the browser answers PATCH; the shell answers SHELL', () => {
    expect(presentAuthority(false)).toBe('patch');
    expect(presentAuthority(true)).toBe('shell');
  });

  it('under the shell nothing is opened here, whatever the doc says', () => {
    const d = decideRestore({ native: true, saved, live: RIG });
    expect(d.action).toBe('defer-to-shell');
    expect(d.armWrite, 'and the write-back never arms, so the key stops growing back').toBe(false);
  });

  it('under the shell the doc copy is MIGRATED OUT exactly once', () => {
    // Not merged, not partially honoured, and not left in place to travel to
    // the next machine in a save file.
    expect(decideRestore({ native: true, saved, live: RIG }).migrateOut).toBe(true);
    expect(
      decideRestore({ native: true, saved: [], live: RIG }).migrateOut,
      'nothing to migrate once it is gone — the clear is not re-run every load',
    ).toBe(false);
  });

  it('a shell with NO displays resolved still defers — it does not fall back to the patch', () => {
    // "Restore them anyway if the shell has nothing yet" is how you get two
    // windows on one projector.
    expect(decideRestore({ native: true, saved, live: [] }).action).toBe('defer-to-shell');
  });

  it('POSITIVE CONTROL: the SAME inputs in a browser DO restore', () => {
    // Otherwise "defer always" passes every assertion above and silently kills
    // the browser feature.
    const d = decideRestore({ native: false, saved, live: RIG });
    expect(d.action).toBe('restore');
    expect(d.migrateOut).toBe(false);
  });
});

describe('present authority — an absent monitor is never answered with the primary one', () => {
  const saved: PresentBinding[] = [{ nodeId: 'out', screen: WISE_LUCK }];

  it('declines, keeps the bindings, and SAYS it did not relocate anything', () => {
    // A performer who loses a projector must be told, not quietly shown their
    // laptop screen. The reason string is the telling.
    const d = decideRestore({ native: false, saved, live: live(RETINA) });
    expect(d.action).toBe('decline');
    expect(d.migrateOut, 'a rig mismatch must not destroy the bindings').toBe(false);
    expect(d.armWrite, 'nor arm a write that would overwrite them with []').toBe(false);
    expect(d.reason).toMatch(/not attached/);
    expect(d.reason).toMatch(/primary display/);
  });

  it('no display list at all is a decline, not a restore onto nothing', () => {
    const d = decideRestore({ native: false, saved, live: [] });
    expect(d.action).toBe('decline');
    expect(d.armWrite).toBe(false);
  });

  it('nothing saved arms the write — the first save of a rig must be possible', () => {
    const d = decideRestore({ native: false, saved: [], live: RIG });
    expect(d.action).toBe('decline');
    expect(d.armWrite).toBe(true);
  });
});

describe('present slot keys — the discriminator the shell routes on', () => {
  it('round-trips a (node, display) pair', () => {
    const key = presentSlotKey('out', 'Wise Luck|1280x720|@1|ext');
    expect(parsePresentSlotKey(key)).toEqual({
      nodeId: 'out',
      screenId: 'Wise Luck|1280x720|@1|ext',
    });
  });

  it('is stable for the same pair, and distinct across pairs', () => {
    expect(presentSlotKey('a', 's')).toBe(presentSlotKey('a', 's'));
    expect(presentSlotKey('a', 's')).not.toBe(presentSlotKey('b', 's'));
    expect(presentSlotKey('a', 's1')).not.toBe(presentSlotKey('a', 's2'));
  });

  it('the separator is not a character a screen id contains', () => {
    // Screen ids are fingerprints built from `|`, `@`, `#` and `x`
    // (screen-identity.screenKey). A separator drawn from that set would split
    // in the wrong place and route a projector to the wrong display.
    const id = 'Built-in Retina Display|1512x982|@2|int#1';
    expect(parsePresentSlotKey(presentSlotKey('n', id))?.screenId).toBe(id);
  });

  it('rejects a slot that is not one, rather than guessing', () => {
    expect(parsePresentSlotKey('')).toBeNull();
    expect(parsePresentSlotKey('nodeonly')).toBeNull();
    expect(parsePresentSlotKey('::screen')).toBeNull();
    expect(parsePresentSlotKey('node::')).toBeNull();
  });
});

describe('clearPresentBindings — the migration removes the key, not its contents', () => {
  it('deletes the key so it stops riding saves and peer syncs', () => {
    // `[]` and absent read the same through readPresentBindings, but only one
    // of them stops the document claiming to own display placement.
    const doc = new Y.Doc();
    writePresentBindings(doc, [{ nodeId: 'out', screen: WISE_LUCK }]);
    expect(doc.getMap('settings').has('presentBindings')).toBe(true);
    clearPresentBindings(doc);
    expect(doc.getMap('settings').has('presentBindings')).toBe(false);
    expect(readPresentBindings(doc)).toEqual([]);
  });

  it('is a no-op on a doc that never had one', () => {
    const doc = new Y.Doc();
    expect(() => clearPresentBindings(doc)).not.toThrow();
    expect(readPresentBindings(doc)).toEqual([]);
  });
});
