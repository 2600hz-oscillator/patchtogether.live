// scripts/vrt-watch.test.ts
//
// The VRT capture watcher (#1821). The API interaction is stubbed — every
// function under test is pure, which is why the IO shell in `vrt-watch.mjs` is
// a thin wrapper around them.
//
// Three legs matter, and they are the three ways a watcher lies:
//
//   1. ZERO COMMITS reported as a pass. `--update-snapshots` only rewrites a
//      comparison that FAILED, so a wrong-but-in-tolerance baseline commits
//      nothing and the run still concludes `success`. This is the leg that has
//      to go LOUD, and it is asserted on the words, not just a boolean.
//   2. A 403 / empty body read as a run RESULT. An exhausted quota answers 403;
//      a watcher that maps that to "no failures" reports success on no data.
//   3. Polling forever. The cap is what makes the watch END.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CAP_MS,
  FAST_INTERVAL_MS,
  FAST_WINDOW_MS,
  LOW_WATER,
  SLOW_INTERVAL_MS,
  baselineFiles,
  classifyRun,
  nextDelayMs,
  rateLimitAction,
  summarize,
} from './vrt-watch.mjs';

describe('cadence — fast while a SCOPED capture could still be running, then a floor', () => {
  it('polls fast inside the window and backs off after it', () => {
    expect(nextDelayMs(0)).toBe(FAST_INTERVAL_MS);
    expect(nextDelayMs(FAST_WINDOW_MS - 1)).toBe(FAST_INTERVAL_MS);
    expect(nextDelayMs(FAST_WINDOW_MS)).toBe(SLOW_INTERVAL_MS);
    expect(nextDelayMs(50 * 60_000)).toBe(SLOW_INTERVAL_MS);
  });

  it('a low quota abandons the fast interval even inside the window', () => {
    expect(nextDelayMs(0, { lowQuota: true })).toBe(SLOW_INTERVAL_MS);
  });

  it('COSTS what the header claims — the number, not a vibe', () => {
    // The comparison that justifies this file: the hand-rolled 45 s loops cost
    // ~70 calls for a full capture. Derived here from the same constants the
    // watcher runs on, so the header cannot drift from the behaviour.
    const callsFor = (durationMs: number): number => {
      let t = 0;
      let n = 0;
      while (t < durationMs) {
        n += 1;
        t += nextDelayMs(t);
      }
      return n;
    };
    expect(callsFor(3 * 60_000), 'scoped capture').toBeLessThanOrEqual(8);
    expect(callsFor(50 * 60_000), 'full sweep').toBeLessThanOrEqual(20);
    expect(callsFor(DEFAULT_CAP_MS), 'the worst case the cap allows').toBeLessThanOrEqual(24);
  });
});

describe('rate limiting — ask (free), then decide', () => {
  it('healthy quota polls normally', () => {
    const a = rateLimitAction({ remaining: 4800, reset: 0, nowMs: 0 });
    expect(a.mode).toBe('ok');
    expect(a.wait).toBe(0);
    expect(a.lowQuota).toBe(false);
  });

  it('a LOW quota keeps polling but slowly', () => {
    const a = rateLimitAction({ remaining: LOW_WATER - 1, reset: 0, nowMs: 0 });
    expect(a.mode).toBe('low');
    expect(a.wait).toBe(0);
    expect(a.lowQuota).toBe(true);
  });

  it('an EXHAUSTED quota sleeps to the documented reset instead of spinning out 403s', () => {
    const now = 1_000_000;
    const reset = (now + 10 * 60_000) / 1000; // seconds, as GitHub reports it
    const a = rateLimitAction({ remaining: 0, reset, nowMs: now });
    expect(a.mode).toBe('exhausted');
    expect(a.wait).toBeGreaterThanOrEqual(10 * 60_000);
    expect(a.lowQuota).toBe(true);
  });

  it('an UNREADABLE quota assumes pressure — never headroom', () => {
    // Failing open here is how a watcher makes an outage worse.
    for (const bad of [undefined, NaN]) {
      const a = rateLimitAction({ remaining: bad as number, reset: undefined, nowMs: 0 });
      expect(a.lowQuota).toBe(true);
    }
  });
});

describe('⚠ a 403 / empty body is NOT a run result', () => {
  it('every unreadable response classifies as UNKNOWN and does not end the watch', () => {
    for (const raw of [
      '',
      '   ',
      undefined as unknown as string,
      null as unknown as string,
      'poll-failed',
      'HTTP 403: API rate limit exceeded for user ID 273780048',
      'error: could not resolve run',
      'gh: command not found',
    ]) {
      const s = classifyRun(raw);
      expect(s.done, `"${String(raw).slice(0, 30)}" must not end the watch`).toBe(false);
      expect(s.status).toBe('unknown');
    }
  });

  it('a real in-flight status is reported but still not done', () => {
    for (const raw of ['queued ', 'in_progress ', 'waiting ']) {
      const s = classifyRun(raw);
      expect(s.done).toBe(false);
      expect(s.status).toBe(raw.trim());
    }
  });

  it('only `completed` is done, and it carries its conclusion', () => {
    expect(classifyRun('completed success')).toEqual({ done: true, status: 'completed', conclusion: 'success' });
    expect(classifyRun('completed failure')).toEqual({ done: true, status: 'completed', conclusion: 'failure' });
    // A completed run with no conclusion string is still done, but says so.
    expect(classifyRun('completed ')).toEqual({ done: true, status: 'completed', conclusion: 'unknown' });
  });
});

describe('committed files are DERIVED from the diff', () => {
  it('picks baseline PNGs out of a changed-file list and ignores everything else', () => {
    const changed = [
      'e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-videoOut-dock.png',
      'e2e/vrt/__screenshots__/vrt.spec.ts/adsr.png',
      'packages/web/src/lib/ui/Canvas.svelte',
      'e2e/vrt/vrt-exemptions.ts',
      'docs/testing/test-ledger.generated.md',
      'e2e/vrt/__screenshots__/notes.txt',
    ];
    expect(baselineFiles(changed)).toEqual([
      'e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-videoOut-dock.png',
      'e2e/vrt/__screenshots__/vrt.spec.ts/adsr.png',
    ]);
  });

  it('an empty diff yields an empty list, not a throw', () => {
    expect(baselineFiles([])).toEqual([]);
  });
});

describe('⚠ ZERO COMMITS IS RED — the leg this whole file exists for', () => {
  it('a SUCCESSFUL run that committed nothing is reported as a RED FLAG, in words', () => {
    const r = summarize({ conclusion: 'success', files: [], predicted: undefined });
    expect(r.verdict).toBe('RED FLAG');
    expect(r.count).toBe(0);
    const text = r.lines.join('\n');
    // Asserted on the WORDS, because the whole point is that a human reading
    // this output cannot mistake it for a pass.
    expect(text).toContain('ZERO BASELINES COMMITTED');
    expect(text).toContain('RED FLAG, NOT A PASS');
    // And it must say WHY zero can happen, or the reader cannot act on it.
    expect(text).toContain('only rewrites a comparison that FAILED');
  });

  it('NEGATIVE CONTROL: a run that committed files is NOT flagged', () => {
    // Without this, "always red" would pass the leg above.
    const r = summarize({
      conclusion: 'success',
      files: ['e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-videoOut-dock.png'],
      predicted: undefined,
    });
    expect(r.verdict).toBe('committed');
    expect(r.count).toBe(1);
    expect(r.lines.join('\n')).not.toContain('RED FLAG');
  });

  it('a PREDICTION mismatch is surfaced, and a match is silent', () => {
    const files = ['a/__screenshots__/x.png', 'b/__screenshots__/y.png'];
    expect(summarize({ conclusion: 'success', files, predicted: 2 }).lines.join('\n')).not.toContain('PREDICTED');
    const off = summarize({ conclusion: 'success', files, predicted: 6 }).lines.join('\n');
    expect(off).toContain('PREDICTED 6, COMMITTED 2');
  });

  it('the count is the DERIVED length, never a typed number', () => {
    // Property, not an example: whatever the diff contains is what is reported.
    for (const n of [0, 1, 5, 42]) {
      const files = Array.from({ length: n }, (_, i) => `e2e/vrt/__screenshots__/s/f${i}.png`);
      expect(summarize({ conclusion: 'success', files }).count).toBe(n);
    }
  });
});
