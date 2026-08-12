// packages/web/src/lib/midi/midi-input-ownership.test.ts
//
// WHO MAY TOUCH `MIDIInput.onmidimessage`, AND WHAT EACH SUBSCRIBER FILTERS ON.
//
// Supersedes the source-shape half of `push-midi-conflict.test.ts`'s
// ATTACH_LEDGER (surface 4), which recorded EIGHT direct claimants and ratcheted
// the destructive ones so they could not grow. They are now ZERO: every
// subsystem goes through `$lib/midi/input-attach`, and this file holds that
// line plus the thing the old ledger could not express — the FILTER each
// subscriber applies, which is what actually decides whether two devices
// collide.
//
// ── WHAT THIS FILE IS STRUCTURALLY UNABLE TO SEE ───────────────────────────
//
// Stated so a green run is not read as more than it is:
//   · It reads SOURCE TEXT under `packages/web/src/lib/**`. It says nothing
//     about `e2e/**` (whose MIDI doubles hand ONE shared `access` object to
//     every `requestMIDIAccess()` caller — deliberately the pessimistic world;
//     see `input-attach.test.ts`).
//   · It cannot execute a browser MIDI stack. Whether two separately-requested
//     `MIDIAccess` objects share `MIDIInput` instances was settled by
//     MEASUREMENT on real Chromium + CoreMIDI, recorded in `input-attach.ts`.
//     They do not.
//   · The FILTER column is a declaration checked against a source probe for the
//     two mechanical fields (does it read a channel? does it branch on status?).
//     "This filter is the RIGHT one for this device" is a judgement no gate
//     makes — which is why every row carries a `why`.

import { describe, it, expect } from 'vitest';

// Every TS + Svelte source under lib/, as raw text. Glob is relative to THIS
// file's dir (midi/), so a sibling comes back as `./x.ts` and anything else as
// `../<sub>/…`; normalise both to a stable lib-relative path.
const FILES = import.meta.glob('../**/*.{ts,svelte}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const libRel = (p: string): string => p.replace(/^\.\//, 'midi/').replace(/^\.\.\//, '');

/** Strip block + line comments before probing. Without this the gate reads
 *  ILLUSTRATIONS as code — `input-attach.ts` documents the destructive
 *  one-liner it exists to abolish, and the sweep probe duly flagged the seam
 *  itself on its first run. A commented-out sweep is not a sweep. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SOURCES: Record<string, string> = {};
for (const [path, src] of Object.entries(FILES)) {
  const key = libRel(path);
  if (/\.(test|spec)\.ts$/.test(key)) continue;
  SOURCES[key] = stripComments(src);
}

/** The ONE seam permitted to write the handler slot. */
const SEAM = 'midi/input-attach.ts';

/**
 * Does this source ASSIGN `onmidimessage`? The simulated-device getter/setter
 * pairs (`get onmidimessage()` / `set onmidimessage(h)`) DEFINE the property on
 * an in-memory fake rather than claim a real stream, so they are not assignment
 * sites — and neither is a `.onmidimessage` read.
 */
function assignsHandler(src: string): string[] {
  return src
    .split('\n')
    .filter((l) => /(?<![=!<>])\bonmidimessage\s*=(?!=)/.test(l))
    .filter((l) => !/^\s*(get|set)\s+onmidimessage/.test(l));
}

/**
 * The DESTRUCTIVE shape: writing the handler slot of every input a sweep over
 * `inputs.values()` yields. A bare `inputs.values()` loop is innocent — that is
 * how the device layers FILTER inputs by port name to find their own hardware.
 * (Probe inherited from push-midi-conflict.test.ts, negative-controlled below.)
 */
function sweepsEveryInput(src: string): boolean {
  const loop = /for\s*\(\s*const\s+(\w+)\s+of\s+[^)]*inputs\.values\(\)\s*\)/g;
  for (let m = loop.exec(src); m; m = loop.exec(src)) {
    const body = src.slice(m.index, m.index + 300);
    if (new RegExp(`\\b${m[1]}\\.onmidimessage\\s*=`).test(body)) return true;
  }
  return false;
}

describe('1 — exactly ONE file assigns MIDIInput.onmidimessage', () => {
  const assigners = Object.entries(SOURCES)
    .filter(([, src]) => assignsHandler(src).length > 0)
    .map(([k]) => k)
    .sort();

  it('the glob actually loaded the tree (a broken glob must be RED, not a silent pass)', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(500);
    expect(SOURCES[SEAM], 'the seam itself must be in the glob').toBeTruthy();
  });

  it('DENY BY DEFAULT — no source outside the seam writes the slot', () => {
    const offenders = assigners.filter((k) => k !== SEAM);
    expect(
      offenders,
      `these files assign MIDIInput.onmidimessage directly. Route them through
${SEAM} (createMidiInputClaim) so a release can never evict a handler it did
not install:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('ANCHORED TO THE ARTIFACT — the seam must still be an assignment site', () => {
    // If input-attach.ts ever stopped assigning the slot, the rule above would
    // be trivially satisfiable by a codebase that no longer works at all.
    expect(assignsHandler(SOURCES[SEAM]!).length, 'the seam assigns the slot').toBeGreaterThan(0);
    expect(assigners, 'the seam is the sole assigner').toEqual([SEAM]);
  });
});

describe('2 — the destructive every-input sweep is extinct', () => {
  const sweepers = Object.entries(SOURCES)
    .filter(([, src]) => sweepsEveryInput(src))
    .map(([k]) => k)
    .sort();

  // ⚠ `SWEEPERS_CEILING` (0) IS GONE (2026-08-12, the no-ratchets sweep). It
  // was a ceiling of zero next to an `toEqual([])` on the SAME array: a cap at
  // zero measures nothing the unconditional assertion below does not already
  // measure, and the "no slack" twin was `0 - 0 === 0`. Deleting it drops no
  // protection — the offender list is still asserted EMPTY, and the probe that
  // builds it is negative-controlled in both directions on every run below.
  it('no source clears handler slots across an input sweep', () => {
    expect(
      sweepers,
      `these files run "for (const inp of access.inputs.values()) inp.onmidimessage = …",
which writes slots the file never installed:\n${sweepers.join('\n')}`,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL for the probe — it still separates the two shapes', () => {
    // At zero offenders the check above is only as good as the probe. If the
    // probe returned false for everything it would be permanently, silently
    // green. Feed it both shapes directly, every run.
    expect(
      sweepsEveryInput('for (const inp of access.inputs.values()) inp.onmidimessage = null;'),
      'the destructive one-liner must be DETECTED',
    ).toBe(true);
    expect(
      sweepsEveryInput('for (const inp of access.inputs.values()) {\n  inp.onmidimessage = null;\n}'),
      'the block form the three audio modules used must be DETECTED',
    ).toBe(true);
    expect(
      sweepsEveryInput('for (const inp of access.inputs.values()) {\n  if (isPortName(inp.name)) ins.push(inp);\n}'),
      'a name-filtering sweep must be INNOCENT',
    ).toBe(false);
  });

  it('NEGATIVE CONTROL for the comment stripper — a documented sweep is not a sweep, a real one is', () => {
    const documented = `/** for (const inp of access.inputs.values()) inp.onmidimessage = null; */\nconst x = 1;`;
    const real = `for (const inp of access.inputs.values()) inp.onmidimessage = null;`;
    expect(sweepsEveryInput(stripComments(documented)), 'an illustration in a comment').toBe(false);
    expect(sweepsEveryInput(stripComments(real)), 'the same text as CODE').toBe(true);
  });

  it('NEGATIVE CONTROL for the assignment probe — it separates claim from definition', () => {
    expect(assignsHandler('  inp.onmidimessage = handle;').length).toBe(1);
    expect(assignsHandler('  input.onmidimessage = (ev) => f(ev);').length).toBe(1);
    expect(
      assignsHandler('    get onmidimessage() { return h; }\n    set onmidimessage(fn) { h = fn; }').length,
      'a simulated-device accessor pair is NOT a claim',
    ).toBe(0);
    expect(
      assignsHandler('    if (inp.onmidimessage === mine) drop();').length,
      'a comparison is NOT a claim',
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3 — THE SUBSCRIBER LEDGER.
//
// Every subsystem that takes a claim, and what it filters on. This is the
// column the old ATTACH_LEDGER could not express and the one that decides real
// device collisions: with the slot no longer contested, EVERY subscriber
// receives everything on the ports it holds, so "which ports" and "which
// messages" are the whole story.
// ---------------------------------------------------------------------------

interface SubscriberRow {
  /** Which ports of its access the subscriber listens on. */
  ports: 'own-port' | 'named-device' | 'every-port';
  /** Does it discriminate by DEVICE (port identity or name)? */
  device: 'selected-id' | 'name-match' | 'none';
  /** Does it discriminate by MIDI CHANNEL? */
  channel: 'user-set' | 'none';
  /** Which status bytes it acts on. */
  messages: string;
  why: string;
}

const SUBSCRIBER_LEDGER: Record<string, SubscriberRow> = {
  'audio/modules/midi-lane.ts': {
    ports: 'own-port',
    device: 'selected-id',
    channel: 'user-set',
    messages: 'note on/off, CC, pitch-bend (0x80-0xE0); system bytes dropped',
    why: 'the card picks ONE input id; laneChannelMatches() gates every channel-voice message on the user channel set',
  },
  'audio/modules/midi-cv-buddy.ts': {
    ports: 'own-port',
    device: 'selected-id',
    channel: 'user-set',
    messages: 'note on/off, pitch-bend; system bytes (0xF0+) bypass the channel gate',
    why: 'the card picks ONE input id; channelMatches() gates channel-voice messages',
  },
  'audio/modules/midiclock.ts': {
    ports: 'own-port',
    device: 'selected-id',
    channel: 'none',
    messages: 'system real-time only: 0xF8 clock, 0xFA start, 0xFC stop',
    why: 'MIDI clock is channel-less by definition; the card picks ONE input id',
  },
  'midi/midi-clock-source.ts': {
    ports: 'every-port',
    device: 'none',
    channel: 'none',
    messages: 'system real-time only: 0xF8 / 0xFA / 0xFC',
    why: 'EVERY-PORT BY DESIGN — a clock master can be any device, and clock bytes cannot be confused with anything else. Reads only data[0].',
  },
  'midi/midi-learn.svelte.ts': {
    ports: 'every-port',
    device: 'none',
    channel: 'none',
    messages: 'CC (0xB0) and note on/off (0x90/0x80)',
    why: 'EVERY-PORT BY DESIGN — learn binds whatever the user physically touches. ⚠ Control surfaces are NOT excluded: arming a learn and touching a Push encoder captures THAT control. Whether learn should skip bound surfaces is an OWNER DECISION, deliberately not taken here.',
  },
  'electra/broker.ts': {
    ports: 'named-device',
    device: 'name-match',
    channel: 'none',
    messages: 'sysex (0xF0), CC (0xB0), note on/off',
    why: 'scoped to inputs named /electra/i (mirroring resolvePorts() on the output side), falling back to every input when none is named. Fixes real crosstalk: autoconfig.handleCc() WRITES a rack param from a CC number, and the generated allocations overlap the Push map (CC 15, 20-27, 71-79) and CC 1.',
  },
  'control/push2/push2-device.svelte.ts': {
    ports: 'own-port',
    device: 'name-match',
    channel: 'none',
    messages: 'everything except a sysex echo — decodePush2Message classifies',
    why: 'binds ONLY the enumerated Push 2 LIVE port (pushPortRole name matcher)',
  },
  'control/launchpad/launchpad-device.svelte.ts': {
    ports: 'own-port',
    device: 'name-match',
    channel: 'none',
    messages: 'note (pads) + CC (top row / scene column)',
    why: 'binds ONLY the enumerated Launchpad port(s), one claim per L/R unit so a pairing swap releases only its own slot',
  },
};

/** Ratchet, both directions. `every-port` subscribers may only SHRINK. */
const EVERY_PORT_SUBSCRIBERS = 2;

describe('3 — every subscriber declares its filter', () => {
  const claimants = Object.entries(SOURCES)
    .filter(([k, src]) => k !== SEAM && /createMidiInputClaim\s*\(/.test(src))
    .map(([k]) => k)
    .sort();

  it('DENY BY DEFAULT — a file that takes a claim is in the ledger', () => {
    const undeclared = claimants.filter((k) => !SUBSCRIBER_LEDGER[k]);
    expect(
      undeclared,
      `these subsystems subscribe to MIDI input and declare no filter:\n${undeclared.join('\n')}`,
    ).toEqual([]);
  });

  it('ANCHORED TO THE ARTIFACT — a ledger row for a non-subscriber is RED', () => {
    const stale = Object.keys(SUBSCRIBER_LEDGER)
      .filter((k) => !claimants.includes(k))
      .sort();
    expect(stale, `stale SUBSCRIBER_LEDGER rows:\n${stale.join('\n')}`).toEqual([]);
  });

  it('every row states a reason', () => {
    for (const [file, row] of Object.entries(SUBSCRIBER_LEDGER)) {
      expect(row.why.length, `${file} needs a stated reason`).toBeGreaterThan(30);
    }
  });

  it('the DECLARED channel filter matches the source', () => {
    // Mechanical cross-check: a row claiming a channel filter must actually
    // call one of the two channel gates; a row claiming none must not.
    const CHANNEL_GATE = /\b(channelMatches|laneChannelMatches)\s*\(/;
    for (const [file, row] of Object.entries(SUBSCRIBER_LEDGER)) {
      const src = SOURCES[file]!;
      expect(
        CHANNEL_GATE.test(src),
        `${file} declares channel='${row.channel}' but the source says otherwise`,
      ).toBe(row.channel === 'user-set');
    }
  });

  it('the DECLARED port scope matches the source', () => {
    for (const [file, row] of Object.entries(SUBSCRIBER_LEDGER)) {
      const src = SOURCES[file]!;
      const takesAll = /attachOnly\(\s*\[\s*\.\.\.\s*(this\.)?access\.inputs\.values\(\)\s*\]/.test(src);
      expect(
        takesAll,
        `${file} declares ports='${row.ports}' but its attach says otherwise`,
      ).toBe(row.ports === 'every-port');
    }
  });

  it('RATCHET (both directions) — every-port subscribers may only shrink', () => {
    const n = Object.values(SUBSCRIBER_LEDGER).filter((r) => r.ports === 'every-port').length;
    expect(n).toBeLessThanOrEqual(EVERY_PORT_SUBSCRIBERS);
    expect(EVERY_PORT_SUBSCRIBERS - n, 'lower EVERY_PORT_SUBSCRIBERS in the same commit').toBe(0);
  });

  it('the two every-port subscribers are the two that are every-port ON PURPOSE', () => {
    const everyPort = Object.entries(SUBSCRIBER_LEDGER)
      .filter(([, r]) => r.ports === 'every-port')
      .map(([k]) => k)
      .sort();
    expect(everyPort).toEqual(['midi/midi-clock-source.ts', 'midi/midi-learn.svelte.ts']);
  });
});
