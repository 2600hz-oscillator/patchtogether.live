import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RELAY_BOOT_ID } from './boot-id.js';
import {
  _resetRelayErrorCounters,
  formatRelayErrorLine,
  getUncaughtExceptionCount,
  getUnhandledRejectionCount,
  installRelayProcessGuards,
  logUncaught,
  logUnhandled,
} from './relay-error-handlers.js';

beforeEach(() => {
  _resetRelayErrorCounters();
});

// Collect the structured (machine-alertable) line each handler emits. Both
// logUncaught/logUnhandled emit the tagged line FIRST, then a human line.
function tagged(lines: string[]): string {
  const t = lines.find((l) => l.startsWith('event=relay_'));
  if (t === undefined) throw new Error(`no tagged line in:\n${lines.join('\n')}`);
  return t;
}

describe('formatRelayErrorLine — tagged, single-line, parseable', () => {
  it('emits one greppable line with event/level/stays_up/boot_id/msg/stack', () => {
    const err = new Error('boom');
    const line = formatRelayErrorLine('relay_uncaught_exception', err);
    expect(line).toContain('event=relay_uncaught_exception');
    expect(line).toContain('level=error');
    expect(line).toContain('stays_up=true');
    expect(line).toContain(`boot_id=${RELAY_BOOT_ID}`);
    expect(line).toContain('msg="boom"');
    expect(line).toContain('stack="');
    // Single line: no raw newlines (the stack's newlines are escaped to \n).
    expect(line).not.toMatch(/\n/);
  });

  it('uses the relay_unhandled_rejection tag for rejections', () => {
    const line = formatRelayErrorLine('relay_unhandled_rejection', new Error('nope'));
    expect(line).toContain('event=relay_unhandled_rejection');
  });

  it('collapses multi-line stacks into a single \\n-escaped field', () => {
    const err = new Error('multi');
    err.stack = 'Error: multi\n    at a (x.ts:1:1)\n    at b (y.ts:2:2)';
    const line = formatRelayErrorLine('relay_uncaught_exception', err);
    expect(line).not.toMatch(/\n/);
    expect(line).toContain('\\n    at a');
  });

  it('escapes embedded double-quotes so the field stays well-formed', () => {
    const line = formatRelayErrorLine('relay_uncaught_exception', new Error('say "hi"'));
    expect(line).toContain('msg="say \\"hi\\""');
  });

  it('handles a non-Error rejection reason (string)', () => {
    const line = formatRelayErrorLine('relay_unhandled_rejection', 'plain string reason');
    expect(line).toContain('msg="plain string reason"');
    expect(line).toContain('stack=""');
  });

  it('handles a non-Error rejection reason (object → JSON)', () => {
    const line = formatRelayErrorLine('relay_unhandled_rejection', { code: 'E', n: 7 });
    expect(line).toContain('msg="{\\"code\\":\\"E\\",\\"n\\":7}"');
  });
});

describe('logUncaught / logUnhandled — emit tagged line + count + stay up', () => {
  it('logUncaught emits the tagged line and increments the counter', () => {
    const lines: string[] = [];
    logUncaught(new Error('x'), (m) => lines.push(m));
    expect(tagged(lines)).toContain('event=relay_uncaught_exception');
    expect(getUncaughtExceptionCount()).toBe(1);
    expect(getUnhandledRejectionCount()).toBe(0);
  });

  it('logUnhandled emits the tagged line and increments the counter', () => {
    const lines: string[] = [];
    logUnhandled('rejected', (m) => lines.push(m));
    expect(tagged(lines)).toContain('event=relay_unhandled_rejection');
    expect(getUnhandledRejectionCount()).toBe(1);
    expect(getUncaughtExceptionCount()).toBe(0);
  });

  it('counters accumulate across repeated occurrences', () => {
    const sink = () => {};
    logUncaught(new Error('1'), sink);
    logUncaught(new Error('2'), sink);
    logUnhandled('r', sink);
    expect(getUncaughtExceptionCount()).toBe(2);
    expect(getUnhandledRejectionCount()).toBe(1);
  });

  it('also emits a human-readable companion line', () => {
    const lines: string[] = [];
    logUncaught(new Error('boom'), (m) => lines.push(m));
    expect(lines.some((l) => l.includes('relay stays up'))).toBe(true);
  });

  it('defaults to console.error when no logger is passed (and stays up)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logUncaught(new Error('default-sink'))).not.toThrow();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('event=relay_uncaught_exception'))).toBe(
      true,
    );
    spy.mockRestore();
  });
});

describe('installRelayProcessGuards — registers stay-up handlers', () => {
  it('wires both process events to the logging handlers WITHOUT crashing', () => {
    const registered: Record<string, (arg: unknown) => void> = {};
    const fakeProc = {
      on(event: string, handler: (arg: unknown) => void) {
        registered[event] = handler;
        return this;
      },
    } as unknown as NodeJS.Process;

    const lines: string[] = [];
    installRelayProcessGuards(fakeProc, (m) => lines.push(m));

    expect(typeof registered.uncaughtException).toBe('function');
    expect(typeof registered.unhandledRejection).toBe('function');

    // Invoking the handlers must NOT throw (stay-up semantics) and must
    // emit the tagged line + bump the counter.
    expect(() => registered.uncaughtException!(new Error('caught'))).not.toThrow();
    expect(() => registered.unhandledRejection!('rejected')).not.toThrow();
    expect(lines.filter((l) => l.startsWith('event=relay_uncaught_exception'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('event=relay_unhandled_rejection'))).toHaveLength(1);
    expect(getUncaughtExceptionCount()).toBe(1);
    expect(getUnhandledRejectionCount()).toBe(1);
  });
});
