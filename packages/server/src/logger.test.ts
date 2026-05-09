// packages/server/src/logger.test.ts
//
// Pin down the structured-log shape so an Axiom search like
// `component=="hocuspocus" and msg=="connect"` keeps working across
// refactors. Asserts:
//   - JSON-parseable single line per call (one event = one line, line
//     terminator owned by console.log)
//   - mandatory fields: ts, level, component, boot_id, msg
//   - error-level routes to stderr; everything else to stdout
//   - boot_id is stable across calls within the same process

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initBootId, getBootId, log } from './logger.js';

describe('logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a JSON line on stdout for info level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log({ msg: 'connect', doc: 'r_abc', count: 1 });
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0][0];
    expect(typeof line).toBe('string');
    const parsed = JSON.parse(line as string);
    expect(parsed.msg).toBe('connect');
    expect(parsed.doc).toBe('r_abc');
    expect(parsed.count).toBe(1);
    expect(parsed.level).toBe('info');
    expect(parsed.component).toBe('hocuspocus');
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof parsed.boot_id).toBe('string');
    expect(parsed.boot_id.length).toBeGreaterThan(8);
  });

  it('routes error level to stderr', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    log({ msg: 'oops', level: 'error', reason: 'failure' });
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledOnce();
    const parsed = JSON.parse(err.mock.calls[0][0] as string);
    expect(parsed.level).toBe('error');
    expect(parsed.reason).toBe('failure');
  });

  it('boot_id is stable across calls', () => {
    const a = getBootId();
    const b = getBootId();
    expect(a).toBe(b);
  });

  it('initBootId regenerates and returns the new id', () => {
    const before = getBootId();
    const refreshed = initBootId();
    expect(refreshed).not.toBe(before);
    expect(getBootId()).toBe(refreshed);
  });
});
