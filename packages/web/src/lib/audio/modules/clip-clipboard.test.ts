// packages/web/src/lib/audio/modules/clip-clipboard.test.ts
//
// The clip clipboard is ONE buffer shared by every surface that copies a clip —
// the Launchpad, Push 2 (which runs through the Launchpad singleton) and the
// card's note right-click menu. This file pins that it is genuinely ONE, because
// the failure mode is silent: two independent buffers behave perfectly on each
// surface alone, and only "copy on the card, paste on the Launchpad" reveals
// them. A test that exercised one surface at a time could not see it.
//
// The strongest available form is a CROSS-MODULE identity: write through this
// module and read through the LAUNCHPAD's own test seam, which was reading its
// private `let` before the extraction. If the buffer ever forks again, the
// launchpad seam keeps returning null while this module reports a loaded clip.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clipboardBuffer,
  setClipboardBuffer,
  clearClipboard,
  clipboardClip,
  clipboardClipAuto,
  clipboardKind,
  clipboardLoaded,
  clipboardSourceIndex,
  __test_resetClipboard,
} from './clip-clipboard.svelte';
import { __test_copyBuffer } from '$lib/control/launchpad/launchpad-control.svelte';
import { defaultNoteClip, type NoteClipRecord, type AutoClipRecord } from './clip-types';

const clipWith = (midi: number): NoteClipRecord => ({
  ...defaultNoteClip(),
  steps: [{ step: 0, midi }],
});

describe('clip clipboard — the shared typed buffer', () => {
  beforeEach(() => __test_resetClipboard());

  it('starts empty, and an empty clipboard offers nothing to paste', () => {
    expect(clipboardBuffer()).toBeNull();
    expect(clipboardLoaded()).toBe(false);
    expect(clipboardClip()).toBeNull();
    expect(clipboardClipAuto()).toBeNull();
    expect(clipboardKind()).toBeNull();
    expect(clipboardSourceIndex()).toBeNull();
  });

  it('a CLIP buffer exposes its clip, its automation and its source index', () => {
    const auto: AutoClipRecord = { tracks: {} };
    setClipboardBuffer({ kind: 'clip', clip: clipWith(64), auto }, 7);
    expect(clipboardKind()).toBe('clip');
    expect(clipboardLoaded()).toBe(true);
    expect(clipboardClip()?.steps[0].midi).toBe(64);
    expect(clipboardClipAuto()).toBe(auto);
    expect(clipboardSourceIndex()).toBe(7);
  });

  it('a SCENE buffer yields NO single clip — the type gate, not a caller check', () => {
    // Every single-clip paste path reads clipboardClip(), so a scene buffer can
    // never paste onto one clip even if a caller forgot `pasteApplies`.
    setClipboardBuffer({ kind: 'scene', clips: [], autos: [] }, null);
    expect(clipboardKind()).toBe('scene');
    expect(clipboardLoaded()).toBe(true);
    expect(clipboardClip()).toBeNull();
    expect(clipboardClipAuto()).toBeNull();
    expect(clipboardSourceIndex()).toBeNull(); // a scene has no single source pad
  });

  it('clearing empties it', () => {
    setClipboardBuffer({ kind: 'clip', clip: clipWith(60), auto: null }, 3);
    clearClipboard();
    expect(clipboardLoaded()).toBe(false);
    expect(clipboardSourceIndex()).toBeNull();
  });

  // ── THE PARITY LEG: one buffer, two surfaces. ────────────────────────────────
  describe('the card and the Launchpad are the SAME clipboard', () => {
    it('a clip written here is visible through the LAUNCHPAD seam', () => {
      expect(__test_copyBuffer()).toBeNull(); // both read empty to start
      setClipboardBuffer({ kind: 'clip', clip: clipWith(72), auto: null }, 2);
      const seen = __test_copyBuffer();
      expect(seen, 'the launchpad reads the buffer the card wrote').not.toBeNull();
      expect(seen?.kind).toBe('clip');
      expect(seen?.kind === 'clip' ? seen.clip.steps[0].midi : null).toBe(72);
      // Identity, not just equality — a copy would mean two buffers kept in sync
      // by luck, which is exactly the state this test exists to forbid.
      expect(seen).toBe(clipboardBuffer());
    });

    it('NEGATIVE CONTROL: clearing here empties what the Launchpad sees', () => {
      // Without this leg the test above would still pass if the launchpad seam
      // merely snapshotted the buffer once. Both directions of the identity have
      // to hold for "one buffer" to be the thing being proven.
      setClipboardBuffer({ kind: 'clip', clip: clipWith(48), auto: null }, 1);
      expect(__test_copyBuffer()).not.toBeNull();
      clearClipboard();
      expect(__test_copyBuffer()).toBeNull();
    });
  });
});
