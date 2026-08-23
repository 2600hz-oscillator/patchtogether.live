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
  beforeMark,
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

// ── ⚠ THE BEFORE MARK — the instrument bug that made the block above LIE ───
//
// Every assertion in the block above takes `files` as an INPUT, so all of them
// were green while the thing that PRODUCES `files` returned an empty list for a
// run that had committed two. That is the shape CLAUDE.md's "VALIDATE THE
// INSTRUMENT" section is about: the checks were correct and blind, because each
// one started downstream of the defect.
//
// Reproduced from run 32351143240 (`feat/mirrorpool-face`), which committed
// `face-mirrorpool-compact.png` and `face-mirrorpool-dock.png` and was reported
// as `baseline files committed: 0 — ⚠ ZERO BASELINES COMMITTED, THIS IS A RED
// FLAG`.
describe('⚠ the BEFORE mark is the RUN, never the branch tip at watcher-start', () => {
  const RUN_SHA = 'bfa5a625f477a28a7c10729bfb0940850bc1d142';
  const BOT_SHA = '73dee7db8f9a7f72715c5feb6aa9f005998f9509';

  it('ATTACH LATE — the bot has already pushed, and the mark still points at what the run built on', () => {
    // The exact failing case: the watcher's first fetch pulls the bot commit,
    // so the branch tip IS the bot commit and a tip-derived mark diffs against
    // itself.
    const m = beforeMark({ runHeadSha: RUN_SHA, branchTip: BOT_SHA });
    expect(m.sha, 'a late attach must not adopt the bot commit as its baseline').toBe(RUN_SHA);
    expect(m.sha).not.toBe(BOT_SHA);
  });

  it('ATTACH EARLY — the tip and the run agree, and the answer is unchanged', () => {
    // The instrument must read the SAME value in both worlds. This is the leg
    // that makes the one above a fix rather than a different arbitrary choice:
    // invariance to WHEN the watcher attached is the whole property.
    expect(beforeMark({ runHeadSha: RUN_SHA, branchTip: RUN_SHA }).sha).toBe(RUN_SHA);
  });

  it('NEGATIVE CONTROL: the OLD rule really did produce the false zero', () => {
    // Without this the fix is unfalsifiable — it would pass even if the bug had
    // never existed. `before === after` is exactly what emptied the diff.
    const oldMark = BOT_SHA; // what `rev-parse origin/<branch>` returned
    const after = BOT_SHA;
    expect(oldMark === after, 'the pre-fix mark equalled the post-run tip').toBe(true);
    expect(summarize({ conclusion: 'success', files: [], predicted: 2 }).verdict).toBe('RED FLAG');
  });

  it('falls back to the branch tip when gh cannot answer, and SAYS it is a fallback', () => {
    // Degrading to the old behaviour is right — a partial report beats none —
    // but silently degrading is how this class survives, so the source is
    // printed and names its own weakness.
    const m = beforeMark({ runHeadSha: '', branchTip: BOT_SHA });
    expect(m.sha).toBe(BOT_SHA);
    expect(m.source).toContain('fallback');
    expect(m.source).toContain('under-report');
  });

  it('reports NO mark rather than a wrong one when neither is readable', () => {
    expect(beforeMark({ runHeadSha: '', branchTip: '' }).sha).toBe('');
  });

  // ⚠ WHAT THIS FIX STILL CANNOT SEE, stated rather than implied. The diff is
  // `runHeadSha..tip`, so an UNRELATED baseline pushed to the branch while the
  // capture ran is counted here. That is over-reporting, and it surfaces as a
  // PREDICTED/COMMITTED mismatch the reader reconciles — the opposite and safe
  // direction from the silent zero this replaces.
  it('over-reports rather than under-reports when the branch moved for other reasons', () => {
    const files = [
      'e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-mirrorpool-dock.png',
      'e2e/vrt/__screenshots__/vrt.spec.ts/someone-elses.png',
    ];
    const r = summarize({ conclusion: 'success', files, predicted: 1 });
    expect(r.verdict).toBe('committed');
    expect(r.lines.join('\n')).toContain('PREDICTED 1, COMMITTED 2');
  });
});
