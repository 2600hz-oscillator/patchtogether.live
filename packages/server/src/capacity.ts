// packages/server/src/capacity.ts
//
// Per-rackspace concurrent-connection cap. The product constraint is 4
// concurrent users per rackspace (1 owner + 3 others); the 5th visitor
// gets a friendly "full" page on the client. Slots free up on disconnect.
//
// This file holds the pure-data slot tracker and the capacity-check
// function. The Hocuspocus hooks in index.ts call into it; that
// separation makes the rule unit-testable without standing up a
// WebSocket harness.
//
// Race note: Hocuspocus's onAuthenticate runs BEFORE onConnect. We
// reserve a slot in onAuthenticate (the gate moment), then the same
// socketId is recorded in onConnect — both increments and decrements
// are keyed by socketId so we don't drift on a refused connection.

export const RACKSPACE_MAX_CONNECTIONS = 4;

export interface SlotTracker {
  /** Try to reserve a slot for `socketId` on `documentName`.
   *  Returns true on success, false if the doc is at capacity. */
  acquire(documentName: string, socketId: string): boolean;
  /** Release a slot. Idempotent — releasing a non-held slot is a no-op. */
  release(documentName: string, socketId: string): void;
  /** Number of currently held slots for `documentName`. */
  size(documentName: string): number;
  /** All known docs that have at least one held slot. Useful for tests. */
  docs(): string[];
}

export function createSlotTracker(limit = RACKSPACE_MAX_CONNECTIONS): SlotTracker {
  // documentName → set of held socketIds. Map ensures order-of-arrival is
  // consistent for tests; Set ensures idempotent acquire.
  const slots = new Map<string, Set<string>>();

  return {
    acquire(documentName, socketId) {
      let held = slots.get(documentName);
      if (!held) {
        held = new Set();
        slots.set(documentName, held);
      }
      if (held.has(socketId)) return true; // idempotent
      if (held.size >= limit) return false;
      held.add(socketId);
      return true;
    },
    release(documentName, socketId) {
      const held = slots.get(documentName);
      if (!held) return;
      held.delete(socketId);
      if (held.size === 0) slots.delete(documentName);
    },
    size(documentName) {
      return slots.get(documentName)?.size ?? 0;
    },
    docs() {
      return Array.from(slots.keys());
    },
  };
}

/** Standardized rejection message returned to the client when the cap
 *  is exceeded. The provider's `onAuthenticationFailed` handler keys off
 *  the `code` field to route to the friendly "full" page. */
export const CAPACITY_REJECTION = {
  code: 'rackspace-full',
  message: 'This rackspace is full.',
} as const;
