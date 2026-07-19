// packages/web/src/lib/ui/canvas/import-confirm.test.ts
//
// Pure-unit coverage for the P4 destructive-import guard decision.

import { describe, it, expect, vi } from 'vitest';
import { confirmDestructiveImport } from './import-confirm';

describe('P4 — confirmDestructiveImport', () => {
  it('proceeds WITHOUT prompting when the rack is empty', () => {
    const confirmFn = vi.fn(() => false);
    expect(confirmDestructiveImport(0, confirmFn)).toBe(true);
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('treats a negative/zero count as empty (defensive) — still no prompt', () => {
    const confirmFn = vi.fn(() => false);
    expect(confirmDestructiveImport(-1, confirmFn)).toBe(true);
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('aborts a non-empty destructive import when the user cancels', () => {
    const confirmFn = vi.fn(() => false);
    expect(confirmDestructiveImport(3, confirmFn)).toBe(false);
    expect(confirmFn).toHaveBeenCalledTimes(1);
  });

  it('proceeds with a non-empty import when the user confirms', () => {
    const confirmFn = vi.fn(() => true);
    expect(confirmDestructiveImport(3, confirmFn)).toBe(true);
    expect(confirmFn).toHaveBeenCalledTimes(1);
  });
});
