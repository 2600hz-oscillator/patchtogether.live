// packages/web/src/lib/ui/rack-status.test.ts
//
// Pure-unit coverage for the persistence-hardening P1 + P2 state helpers.
// No browser: these are the timing/precedence decisions the /r/[id] page
// delegates to, proven deterministically here.

import { describe, it, expect } from 'vitest';
import {
  computeRackStatus,
  computeSaveStatus,
  shouldPromptUnsaved,
  DEFAULT_OFFLINE_AFTER_MS,
} from './rack-status';

describe('P1 — computeRackStatus', () => {
  it('is "ready" as soon as the local replica is seeded (warm refresh never flashes restoring)', () => {
    expect(computeRackStatus({ seeded: true, synced: false, elapsedMs: 0 })).toBe('ready');
    // ready wins over the offline timeout — a seeded rack is never offline.
    expect(
      computeRackStatus({ seeded: true, synced: false, elapsedMs: 10_000 }),
    ).toBe('ready');
  });

  it('is "ready" once the provider has synced', () => {
    expect(computeRackStatus({ seeded: false, synced: true, elapsedMs: 0 })).toBe('ready');
    expect(
      computeRackStatus({ seeded: false, synced: true, elapsedMs: 10_000 }),
    ).toBe('ready');
  });

  it('is "restoring" while neither seeded nor synced, inside the grace window', () => {
    expect(computeRackStatus({ seeded: false, synced: false, elapsedMs: 0 })).toBe(
      'restoring',
    );
    expect(
      computeRackStatus({ seeded: false, synced: false, elapsedMs: DEFAULT_OFFLINE_AFTER_MS - 1 }),
    ).toBe('restoring');
  });

  it('flips to "offline" once the grace window elapses with neither seeded nor synced', () => {
    expect(
      computeRackStatus({ seeded: false, synced: false, elapsedMs: DEFAULT_OFFLINE_AFTER_MS }),
    ).toBe('offline');
    expect(
      computeRackStatus({ seeded: false, synced: false, elapsedMs: DEFAULT_OFFLINE_AFTER_MS + 5_000 }),
    ).toBe('offline');
  });

  it('honours a custom offlineAfterMs threshold', () => {
    expect(
      computeRackStatus({ seeded: false, synced: false, elapsedMs: 200 }, 100),
    ).toBe('offline');
    expect(
      computeRackStatus({ seeded: false, synced: false, elapsedMs: 50 }, 100),
    ).toBe('restoring');
  });

  it('restoring strictly requires !seeded && !synced (the anti-flash gate)', () => {
    // Both signals absent → restoring; either present → ready. There is no
    // input combination that shows "restoring" once seeded or synced.
    for (const seeded of [false, true]) {
      for (const synced of [false, true]) {
        const status = computeRackStatus({ seeded, synced, elapsedMs: 0 });
        if (seeded || synced) expect(status).toBe('ready');
        else expect(status).toBe('restoring');
      }
    }
  });
});

describe('P2 — computeSaveStatus', () => {
  it('is "saving" whenever there are unsynced changes (even mid-initial-connect)', () => {
    expect(computeSaveStatus({ hasUnsyncedChanges: true, synced: false })).toBe('saving');
    expect(computeSaveStatus({ hasUnsyncedChanges: true, synced: true })).toBe('saving');
  });

  it('is "saved" when synced with nothing outstanding', () => {
    expect(computeSaveStatus({ hasUnsyncedChanges: false, synced: true })).toBe('saved');
  });

  it('is "idle" before the first sync with nothing outstanding (banner owns this phase)', () => {
    expect(computeSaveStatus({ hasUnsyncedChanges: false, synced: false })).toBe('idle');
  });
});

describe('P2 — shouldPromptUnsaved (strict beforeunload gate)', () => {
  it('prompts ONLY when there are unsynced changes', () => {
    expect(shouldPromptUnsaved({ hasUnsyncedChanges: true })).toBe(true);
  });

  it('never prompts a fully-synced user', () => {
    expect(shouldPromptUnsaved({ hasUnsyncedChanges: false })).toBe(false);
  });
});
