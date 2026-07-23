// packages/web/src/lib/ui/workflow/legacy-fallback.test.ts
//
// The legacy-fallback MIGRATION bridge (P0.3b) — pure derivation gate. Proves:
//   - preview OFF (default) is a strict NO-OP: every non-docked node → 'legacy'
//     (byte-identical to the pre-P0.3b render);
//   - the user-dock swap still wins (unchanged P2.5a contract);
//   - preview ON: un-migrated → placeholder, migrated → shell;
//   - the emitted node-type mapping + the swap-eligibility rule.

import { describe, it, expect } from 'vitest';
import {
  laneRenderKind,
  emittedTypeFor,
  isShellSwappable,
  NON_SHELL_LANE_TYPES,
  type LaneRenderInput,
} from './legacy-fallback';

/** A fully-swappable, workflow, preview-on, un-migrated baseline. */
const base: LaneRenderInput = {
  workflowMode: true,
  shellPreview: true,
  userDocked: false,
  type: 'tidyvco',
  hasCard: true,
  migrated: false,
};

describe('laneRenderKind — the pure bridge decision', () => {
  it('user-docked ALWAYS wins → stub (preview on or off, migrated or not)', () => {
    for (const shellPreview of [true, false]) {
      for (const migrated of [true, false]) {
        expect(laneRenderKind({ ...base, userDocked: true, shellPreview, migrated })).toBe('stub');
      }
    }
  });

  it('preview OFF is a strict no-op → legacy for every non-docked node', () => {
    expect(laneRenderKind({ ...base, shellPreview: false })).toBe('legacy');
    // even a migrated type renders legacy when the preview is off
    expect(laneRenderKind({ ...base, shellPreview: false, migrated: true })).toBe('legacy');
  });

  it('dawless mode → always legacy (shell is workflow-only)', () => {
    expect(laneRenderKind({ ...base, workflowMode: false })).toBe('legacy');
    expect(laneRenderKind({ ...base, workflowMode: false, migrated: true })).toBe('legacy');
  });

  it('preview ON + un-migrated + swappable → placeholder', () => {
    expect(laneRenderKind(base)).toBe('placeholder');
  });

  it('preview ON + migrated + swappable → shell', () => {
    expect(laneRenderKind({ ...base, migrated: true })).toBe('shell');
  });

  it('a non-card / snowflake type stays legacy even with preview on', () => {
    expect(laneRenderKind({ ...base, hasCard: false })).toBe('legacy');
    expect(laneRenderKind({ ...base, hasCard: false, migrated: true })).toBe('legacy');
  });
});

describe('emittedTypeFor — kind → xyflow node type', () => {
  it('maps each kind to its node type; legacy emits the module type', () => {
    expect(emittedTypeFor('stub', 'tidyvco')).toBe('dockStub');
    expect(emittedTypeFor('shell', 'tidyvco')).toBe('moduleShell');
    expect(emittedTypeFor('placeholder', 'tidyvco')).toBe('moduleShellPlaceholder');
    expect(emittedTypeFor('legacy', 'tidyvco')).toBe('tidyvco');
  });

  it('the full pipeline: preview-off round-trips to the legacy type', () => {
    const kind = laneRenderKind({ ...base, shellPreview: false });
    expect(emittedTypeFor(kind, base.type)).toBe(base.type);
  });
});

describe('isShellSwappable — eligibility', () => {
  it('requires a resolvable card', () => {
    expect(isShellSwappable('tidyvco', true)).toBe(true);
    expect(isShellSwappable('tidyvco', false)).toBe(false);
  });

  it('excludes the organizational / snowflake types', () => {
    for (const t of NON_SHELL_LANE_TYPES) {
      expect(isShellSwappable(t, true)).toBe(false);
    }
    // sanity: the excluded set is the snowflakes we intend to hold back
    expect(NON_SHELL_LANE_TYPES.has('group')).toBe(true);
    expect(NON_SHELL_LANE_TYPES.has('clipplayer')).toBe(true);
    expect(NON_SHELL_LANE_TYPES.has('tidyvco')).toBe(false);
  });
});
