// packages/server/src/rack-accounting.test.ts
//
// Per-rack memory accounting: threshold parsing, classification, the
// accounting model (snapshot base + churn, reset on snapshot), the
// level-latched alert-line emission (once per upward crossing, re-armed on
// the way down), eviction, and the /metrics roll-up shape.

import { describe, expect, it } from 'vitest';

import {
  classifyRackMb,
  createRackAccountant,
  formatRackMemLine,
  readRackMemThresholds,
  type RackMemThresholds,
} from './rack-accounting.js';

const MB = 1024 * 1024;
const T: RackMemThresholds = { warnMb: 16, critMb: 24 };

function makeAccountant(thresholds: RackMemThresholds = T) {
  const lines: Array<{ level: 'warn' | 'error'; msg: string }> = [];
  const acc = createRackAccountant({
    thresholds,
    log: (level, msg) => lines.push({ level, msg }),
    bootId: 'boot-test',
  });
  return { acc, lines };
}

describe('readRackMemThresholds', () => {
  it('defaults to warn=16 crit=24 (sized against the ~25MB/rack design ceiling)', () => {
    expect(readRackMemThresholds({})).toEqual({ warnMb: 16, critMb: 24 });
  });

  it('reads RELAY_RACK_WARN_MB / RELAY_RACK_CRIT_MB from env', () => {
    expect(
      readRackMemThresholds({ RELAY_RACK_WARN_MB: '4', RELAY_RACK_CRIT_MB: '8' }),
    ).toEqual({ warnMb: 4, critMb: 8 });
  });

  it('falls back on non-numeric / non-positive values', () => {
    expect(
      readRackMemThresholds({ RELAY_RACK_WARN_MB: 'nope', RELAY_RACK_CRIT_MB: '-3' }),
    ).toEqual({ warnMb: 16, critMb: 24 });
  });
});

describe('classifyRackMb', () => {
  it('ok at/below warn, warn above warn, crit above crit', () => {
    expect(classifyRackMb(16, T)).toBe('ok');
    expect(classifyRackMb(16.01, T)).toBe('warn');
    expect(classifyRackMb(24, T)).toBe('warn');
    expect(classifyRackMb(24.01, T)).toBe('crit');
  });
});

describe('createRackAccountant — accounting model', () => {
  it('tracks snapshot base + update churn per rack', () => {
    const { acc } = makeAccountant();
    acc.recordSnapshot('rack-a', 2 * MB);
    acc.recordUpdate('rack-a', 1 * MB);
    acc.recordUpdate('rack-a', 1 * MB);
    expect(acc.sizeMb('rack-a')).toBe(4);
    // Other racks are independent.
    expect(acc.sizeMb('rack-b')).toBe(0);
  });

  it('a snapshot resets churn (full encode = exact current size)', () => {
    const { acc } = makeAccountant();
    acc.recordUpdate('rack-a', 10 * MB);
    acc.recordSnapshot('rack-a', 3 * MB);
    expect(acc.sizeMb('rack-a')).toBe(3);
  });

  it('evict() stops tracking a rack', () => {
    const { acc } = makeAccountant();
    acc.recordSnapshot('rack-a', 30 * MB);
    acc.evict('rack-a');
    expect(acc.sizeMb('rack-a')).toBe(0);
    expect(acc.summary().rackCount).toBe(0);
  });

  it('ignores non-finite and non-positive update sizes', () => {
    const { acc } = makeAccountant();
    acc.recordUpdate('rack-a', NaN);
    acc.recordUpdate('rack-a', -5);
    acc.recordUpdate('rack-a', 0);
    expect(acc.summary().rackCount).toBe(0);
  });
});

describe('createRackAccountant — alert line emission (level latch)', () => {
  it('emits ONE tagged line per upward crossing, not per update', () => {
    const { acc, lines } = makeAccountant();
    acc.recordUpdate('rack-a', 17 * MB); // ok → warn
    acc.recordUpdate('rack-a', 1 * MB); // still warn — silent
    acc.recordUpdate('rack-a', 1 * MB); // still warn — silent
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(lines[0]!.msg).toContain('event=relay_rack_mem');
    expect(lines[0]!.msg).toContain('alert_state=warn');
    expect(lines[0]!.msg).toContain('rack="rack-a"');
    expect(lines[0]!.msg).toContain('boot_id=boot-test');
    // Single greppable line — the Better Stack log-alert convention.
    expect(lines[0]!.msg).not.toContain('\n');
  });

  it('escalates warn → crit with a second line at level=error', () => {
    const { acc, lines } = makeAccountant();
    acc.recordUpdate('rack-a', 17 * MB); // warn
    acc.recordUpdate('rack-a', 10 * MB); // crit
    expect(lines).toHaveLength(2);
    expect(lines[1]!.level).toBe('error');
    expect(lines[1]!.msg).toContain('alert_state=crit');
    expect(lines[1]!.msg).toContain('warn_mb=16');
    expect(lines[1]!.msg).toContain('crit_mb=24');
  });

  it('jumping straight past crit emits a single crit line (no warn spam)', () => {
    const { acc, lines } = makeAccountant();
    acc.recordSnapshot('rack-a', 30 * MB);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('error');
    expect(lines[0]!.msg).toContain('alert_state=crit');
  });

  it('re-arms after falling back below the threshold', () => {
    const { acc, lines } = makeAccountant();
    acc.recordUpdate('rack-a', 17 * MB); // warn (line 1)
    acc.recordSnapshot('rack-a', 1 * MB); // back to ok — silent re-arm
    expect(lines).toHaveLength(1);
    acc.recordUpdate('rack-a', 17 * MB); // warn again (line 2)
    expect(lines).toHaveLength(2);
  });

  it('escapes double quotes in the rack id field', () => {
    expect(formatRackMemLine('we"ird', 20, 'warn', T, 'b')).toContain('rack="we\\"ird"');
  });
});

describe('createRackAccountant — summary roll-up', () => {
  it('reports rack count, largest rack, over-threshold counts, worst level', () => {
    const { acc } = makeAccountant();
    acc.recordSnapshot('rack-ok', 1 * MB);
    acc.recordSnapshot('rack-warn', 20 * MB);
    acc.recordSnapshot('rack-crit', 30 * MB);
    expect(acc.summary()).toEqual({
      rackCount: 3,
      largestRackMb: 30,
      racksOverWarn: 2, // warn + crit racks both exceed warn
      racksOverCrit: 1,
      level: 'crit',
    });
  });

  it('is all-zero/ok when nothing is tracked', () => {
    const { acc } = makeAccountant();
    expect(acc.summary()).toEqual({
      rackCount: 0,
      largestRackMb: 0,
      racksOverWarn: 0,
      racksOverCrit: 0,
      level: 'ok',
    });
  });
});
