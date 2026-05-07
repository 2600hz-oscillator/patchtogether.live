// packages/server/src/snapshot-config.test.ts
//
// Bug 1 (B5): tighten the Hocuspocus snapshot debounce so a fully cold
// reload sees at most 5s of staleness rather than the library default 10s.
//
// We can't easily integration-test Hocuspocus's debouncer end-to-end
// without standing up a Postgres + WS server in-process, so this unit
// test instead asserts that the configured values exported from
// `index.ts` match the intended persistence policy. The integration
// behavior is covered by the existing collab e2e tests (which exercise
// the WS sync + persist path against a real Hocuspocus + Postgres).

import { describe, it, expect } from 'vitest';
import { SNAPSHOT_PERSISTENCE_CONFIG } from './snapshot-config.js';

describe('SNAPSHOT_PERSISTENCE_CONFIG', () => {
  it('debounce is 2s — matches expected edit rate', () => {
    expect(SNAPSHOT_PERSISTENCE_CONFIG.debounce).toBe(2000);
  });

  it('maxDebounce is 5s — tighter than library default 10s', () => {
    expect(SNAPSHOT_PERSISTENCE_CONFIG.maxDebounce).toBe(5000);
    // Sanity: must be >= debounce, otherwise the library coerces it.
    expect(SNAPSHOT_PERSISTENCE_CONFIG.maxDebounce).toBeGreaterThanOrEqual(
      SNAPSHOT_PERSISTENCE_CONFIG.debounce,
    );
  });

  it('unloadImmediately is true — flush pending writes on last disconnect', () => {
    expect(SNAPSHOT_PERSISTENCE_CONFIG.unloadImmediately).toBe(true);
  });
});
