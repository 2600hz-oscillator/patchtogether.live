// packages/web/src/lib/graph/singleton-cleanup-registry.test.ts
//
// REGISTRY-DRIVEN coverage gate for Phase 4c singleton cleanup.
//
// The unrecoverable-ghost bug is specifically about modules that are BOTH
// `maxInstances: 1` AND `undeletable: true`: a merge-duplicate of such a module
// can never be removed by the user, so the post-merge cleanup pass is the ONLY
// thing that recovers it. This test enumerates the REAL module registries and
// asserts that EVERY such module is in-scope for the cleanup
// (`isTypeLevelCapped(def) === true`). If a future module ships
// maxInstances:1 + undeletable:true but lands on the per-user exclusion list (or
// otherwise drops out of scope), this fails — preventing a new ghost.
//
// It also asserts the broader invariant that every type-level capped module
// (any finite maxInstances that ISN'T a per-user cap) is covered, and documents
// the per-user-capped types that are deliberately excluded.

import { describe, it, expect } from 'vitest';

// Side-effect barrel imports so the registries are populated.
import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';

import {
  isTypeLevelCapped,
  PER_USER_CAPPED_TYPES,
  type CleanupDef,
} from './singleton-cleanup';

interface RegDef {
  type: string;
  maxInstances?: number;
  undeletable?: boolean;
}

function allDefs(): RegDef[] {
  return [
    ...(listModuleDefs() as unknown as RegDef[]),
    ...(listVideoModuleDefs() as unknown as RegDef[]),
    ...(listMetaModuleDefs() as unknown as RegDef[]),
  ];
}

describe('singleton cleanup registry coverage', () => {
  it('the registries actually loaded (sanity)', () => {
    expect(allDefs().length).toBeGreaterThan(50);
  });

  it('EVERY maxInstances:1 + undeletable:true module is covered by the cleanup', () => {
    const ghostable = allDefs().filter(
      (d) => d.maxInstances === 1 && d.undeletable === true,
    );
    // There must be at least one (TIMELORDE) — if this drops to zero the test
    // has stopped guarding anything (e.g. registries failed to load).
    expect(ghostable.length).toBeGreaterThanOrEqual(1);
    expect(ghostable.map((d) => d.type)).toContain('timelorde');

    for (const d of ghostable) {
      expect(
        isTypeLevelCapped(d as CleanupDef),
        `module "${d.type}" is maxInstances:1 + undeletable:true but is NOT covered ` +
          `by the singleton cleanup — a merge-duplicate would be an unrecoverable ghost. ` +
          `Either remove it from PER_USER_CAPPED_TYPES or give it a deletable affordance.`,
      ).toBe(true);
    }
  });

  it('every TYPE-LEVEL capped module (finite cap, not per-user) is in scope', () => {
    for (const d of allDefs()) {
      const cap = d.maxInstances;
      if (cap === undefined) continue; // uncapped → out of scope by design
      if (PER_USER_CAPPED_TYPES.has(d.type)) {
        // Per-user types are deliberately excluded even with a numeric cap.
        expect(isTypeLevelCapped(d as CleanupDef)).toBe(false);
      } else {
        expect(
          isTypeLevelCapped(d as CleanupDef),
          `type-level capped module "${d.type}" (maxInstances:${cap}) must be in cleanup scope`,
        ).toBe(true);
      }
    }
  });

  it('the per-user exclusion list only names types that actually exist (no dead entries)', () => {
    const known = new Set(allDefs().map((d) => d.type));
    for (const t of PER_USER_CAPPED_TYPES) {
      expect(known.has(t), `PER_USER_CAPPED_TYPES names "${t}" but no such module def exists`).toBe(
        true,
      );
    }
  });
});
