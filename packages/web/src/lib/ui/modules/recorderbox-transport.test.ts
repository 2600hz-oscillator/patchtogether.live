// packages/web/src/lib/ui/modules/recorderbox-transport.test.ts
//
// THE TRANSPORT SEAM, in the pure lane.
//
// What this file is FOR: the extraction that made a promoted recorderbox
// operable at all moved six things out of `RecorderboxCard.svelte`, and the one
// with real decision content is the RECONCILER. Everything else in the seam is
// orchestration over browser capabilities a node environment does not have; the
// decision is three booleans, so it is enumerated here rather than argued in a
// comment.
//
// ⚠ WHAT THIS FILE CANNOT SEE, stated so nobody reads it as coverage of the
// promotion:
//   * THAT A SURFACE ACTUALLY CALLS THE RECONCILER. That is
//     `recorderbox-face-model.test.ts` at the source and
//     `recorderbox-face.spec.ts` at runtime — the latter with NO card mounted
//     anywhere, which is the condition the whole extraction exists for.
//   * THAT A TAKE PRODUCES A FILE. No CI runner has an H.264 encoder that emits
//     chunks (the headless software runner reports `avc` as config-supported
//     and then emits ZERO chunks for real frames — measured in
//     `recorderbox.spec.ts`), so "bytes on disk" is the owner's hardware check.
//   * THE FOLDER / OVERWRITE / PERMISSION FLOW. `showDirectoryPicker`,
//     `FileSystemDirectoryHandle.requestPermission` and `confirm` do not exist
//     here. The pure policy half is already covered next door in
//     `recorderbox-present-policy.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  FOLDER_HINT_NO_PICKER,
  UNCHECKED_SUPPORT,
  changeRecorderboxFolder,
  folderDisplayName,
  formatElapsed,
  probeRecorderboxSupport,
  recorderboxFilename,
  recorderboxQuality,
  recorderboxRecording,
  scanRecoverableTakes,
  transportAction,
  type TransportAction,
} from './recorderbox-transport';
import type { ModuleNode } from '$lib/graph/types';

const nodeWith = (data: Record<string, unknown>): ModuleNode =>
  ({ id: 'r1', type: 'recorderbox', params: {}, data }) as unknown as ModuleNode;

describe('the transport DECISION is exhaustive over its three inputs', () => {
  // want × isLive × canRecord — all eight, written out. A table this small has
  // no excuse to be sampled.
  const CASES: readonly [boolean, boolean, boolean, TransportAction][] = [
    [false, false, false, null],
    [false, false, true, null],
    [false, true, false, 'stop'],
    [false, true, true, 'stop'],
    [true, false, false, null],
    [true, false, true, 'start'],
    [true, true, false, null],
    [true, true, true, null],
  ];

  it('every combination resolves the documented action', () => {
    for (const [want, isLive, canRecord, expected] of CASES) {
      expect(
        transportAction(want, isLive, canRecord),
        `want=${want} isLive=${isLive} canRecord=${canRecord}`,
      ).toBe(expected);
    }
  });

  // ⚠ THE TWO ROWS THAT ARE NOT BOOKKEEPING, called out because they are the
  // ones a "simplification" would collapse.
  it('`canRecord` gates START and must NOT gate STOP', () => {
    // A running take must be endable even when the capability answer says no —
    // a probe that has not landed yet, or an encoder that went away mid-session.
    // Folding canRecord into one condition makes an UN-STOPPABLE recording out
    // of a capability answer, and the registry deliberately offers no other exit
    // (no dispose, no release, no detach — see node-recorder-registry).
    expect(transportAction(false, true, false)).toBe('stop');
    // The negative control for the same clause: with nothing running, a false
    // capability answer really does refuse the start.
    expect(transportAction(true, false, false)).toBe(null);
  });

  it('an already-live take is never re-started (the registry is idempotent, but the effect must not lean on that)', () => {
    // `nodeRecorder.start` ignores a second call while one is live, so a
    // duplicate here would not destroy a take — but it WOULD re-run the folder
    // prompt and the encoder probe on every effect pass, which is a modal
    // dialog storm on a surface that merely re-rendered.
    expect(transportAction(true, true, true)).toBe(null);
  });
});

describe('node.data readers default the way both surfaces paint them', () => {
  it('an EMPTY node reads the fresh-spawn faceplate', () => {
    // This is exactly the state a VRT face scene captures, so these three
    // defaults are what makes that baseline deterministic.
    const fresh = nodeWith({});
    expect(recorderboxFilename(fresh)).toBe('recording');
    expect(recorderboxRecording(fresh)).toBe(false);
    expect(recorderboxQuality(fresh)).toBe('balanced');
  });

  it('a MISSING node is safe — every reader answers rather than throwing', () => {
    // The node can be gone: deleted by a peer, not yet synced, swept. A surface
    // rendering one frame late must not take the page down.
    expect(recorderboxFilename(null)).toBe('recording');
    expect(recorderboxRecording(null)).toBe(false);
    expect(recorderboxQuality(null)).toBe('balanced');
  });

  it('real values come through, and an ILLEGAL quality is coerced rather than trusted', () => {
    expect(recorderboxFilename(nodeWith({ filename: 'take-7' }))).toBe('take-7');
    expect(recorderboxRecording(nodeWith({ recording: true }))).toBe(true);
    expect(recorderboxQuality(nodeWith({ quality: 'high' }))).toBe('high');
    // `data` is Y.Doc-synced, so a rack-mate on an older build (or a hand-edited
    // saved patch) can put anything here.
    expect(recorderboxQuality(nodeWith({ quality: 'enormous' }))).toBe('balanced');
  });
});

describe('the a11y formatters — where every deleted readout went', () => {
  it('elapsed is MM:SS and never negative', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(9.9)).toBe('00:09');
    expect(formatElapsed(61)).toBe('01:01');
    expect(formatElapsed(600)).toBe('10:00');
    expect(formatElapsed(3600)).toBe('60:00');
    // The registry computes elapsed from a clock; a backwards step must not
    // print `-1:-1` into an accessible name.
    expect(formatElapsed(-5)).toBe('00:00');
  });

  it('the folder name is read structurally, and absence is null not ""', () => {
    // The project's FileSystemDirectoryHandle typing does not surface `.name`;
    // every real handle has one. Null is what paints the empty state, so it must
    // not degrade to an empty string that renders as a blank row.
    expect(folderDisplayName({ name: 'takes' } as unknown as FileSystemDirectoryHandle)).toBe('takes');
    expect(folderDisplayName(null)).toBe(null);
    expect(folderDisplayName({} as unknown as FileSystemDirectoryHandle)).toBe(null);
  });
});

describe('the capability and recovery probes ANSWER in a node environment', () => {
  // Both were the tree's ONLY callers of their underlying store functions and
  // both run on mount, so a throw here is a dead faceplate rather than a missing
  // lamp. Neither browser API exists in this environment, which is precisely the
  // hostile case.
  it('the support probe resolves `checked` even with no WebCodecs at all', async () => {
    const s = await probeRecorderboxSupport(640, 480);
    expect(s.checked, 'the probe must always answer — `checked` is what enables the switch').toBe(true);
    expect(typeof s.canRecord).toBe('boolean');
    expect(typeof s.opfs).toBe('boolean');
    // …and the UNCHECKED sentinel the surfaces start from is the opposite state,
    // so "not asked yet" and "asked and refused" are distinguishable.
    expect(UNCHECKED_SUPPORT.checked).toBe(false);
    expect(UNCHECKED_SUPPORT.canRecord).toBe(false);
  });

  it('the recovery scan resolves EMPTY rather than throwing with no IndexedDB', async () => {
    // This is also the fact the VRT face scene rests on: an empty scan means the
    // recovery block never renders, so there is no before/after race in the
    // baseline.
    await expect(scanRecoverableTakes('r1')).resolves.toEqual([]);
  });

  it('a folder re-pick with NO picker reports the actionable sentence', async () => {
    // `showDirectoryPicker` is absent here, which is the Firefox/Safari case.
    // The seam owns the hint strings so the card and the faceplate cannot give
    // two different accounts of the same refusal.
    await expect(changeRecorderboxFolder('r1')).resolves.toBe(FOLDER_HINT_NO_PICKER);
  });
});
