import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  bindingsFromPairs,
  mayPersist,
  planRestore,
  readPresentBindings,
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
