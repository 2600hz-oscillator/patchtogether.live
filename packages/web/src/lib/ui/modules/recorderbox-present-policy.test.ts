// packages/web/src/lib/ui/modules/recorderbox-present-policy.test.ts
//
// Regression guard for the presentation-safe record-start policy: starting a
// recording while in fullscreen presentation mode must NOT open a modal browser
// surface (folder picker / overwrite confirm), because Chrome resolves modal
// chrome by EXITING fullscreen — kicking the performer out + re-flashing the
// "is now full screen" overlay. Pure decisions → no DOM needed.

import { describe, it, expect } from 'vitest';
import {
  planRecordStartFolder,
  mayShowOverwriteConfirm,
} from './recorderbox-present-policy';

describe('recorderbox present-policy — no modal while presenting', () => {
  it('uses an already-chosen folder regardless of fullscreen (no prompt)', () => {
    expect(planRecordStartFolder(true, false)).toEqual({ action: 'use' });
    expect(planRecordStartFolder(true, true)).toEqual({ action: 'use' });
  });

  it('prompts for a folder when none is chosen AND not presenting', () => {
    expect(planRecordStartFolder(false, false)).toEqual({ action: 'prompt' });
  });

  it('THE FIX: no folder + presenting → download fallback, never the picker modal', () => {
    // showDirectoryPicker while fullscreen would make Chrome exit fullscreen.
    expect(planRecordStartFolder(false, true)).toEqual({ action: 'download' });
  });

  it('overwrite confirm() is allowed only when NOT presenting', () => {
    expect(mayShowOverwriteConfirm(false)).toBe(true);
    expect(mayShowOverwriteConfirm(true)).toBe(false);
  });
});
