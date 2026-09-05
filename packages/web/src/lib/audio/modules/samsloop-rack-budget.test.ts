// packages/web/src/lib/audio/modules/samsloop-rack-budget.test.ts
//
// THE RACK-CEILING PROOF. It lives here rather than in Playwright because the
// e2e version TIMED OUT ON CI — and the reason is worth stating, because it is
// not "the e2e was flaky".
//
// The feature worked. The failing run's own page snapshot showed the card
// rendering `0.00s max` and `rack sample budget: 12.5 / 12 MB used — no room
// to record` on exactly the right node. What blew the 30 s budget was the
// TEST's construction: proving this ceiling requires ~12 MB of base64 actually
// present in `node.data`, and materialising that in a live syncedStore doc
// costs 15-20 s on a CI runner (measured from the trace: 5.6 s + 11.3 s +
// 6.6 s = 23.5 s of payload churn, leaving 1.5 s for the assertion). That cost
// is intrinsic to the browser path, so the proof moved to where 12 MB is free.
//
// Three things have to be true for "over-budget is VISIBLE" to hold, and the
// three are tested in three different ways on purpose:
//
//   1. THE VALUES — ledger → seconds → refusal — computed from a REAL Y.Doc,
//      so this exercises the live syncedStore proxy shape (where `data` is a
//      Y.Map and reads go through a proxy) rather than a plain-object fixture.
//      Plain-object coverage of the same arithmetic is in
//      `samsloop-record.test.ts`; this file is about the LIVE shape.
//   2. THE WIRING — a source-anchored guard that SamsloopCard actually binds
//      those values to the DOM and subscribes to `docVersion()`. No runtime
//      gate can see a card that computes the right number and renders none of
//      it, which is the divergence class CLAUDE.md names; the repo's existing
//      answer is a source grep (`controlFamilies`→card-testid,
//      `card-range-source`) and this follows it.
//   3. THE EMPTY-RACK control — `samsloop-record.spec.ts` still asserts in the
//      browser that a free rack shows no note and records normally, so
//      "the button is always dead" cannot masquerade as a passing ceiling.
//
// ⚠ (2) IS NOT DECORATION. The first cut of this feature computed the ledger
// correctly and displayed a stale one: `$derived(samsloopRackLedger(...))`
// tracked nothing across nodes, so a sample committed on ANOTHER samsloop left
// the readout advertising 31.25 s on a full rack. The budget was right and only
// its visibility was broken — precisely the half that is not allowed to fail
// quietly. A guard on the subscription is what makes that unwritable again.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import {
  samsloopRackLedger,
  samsloopRackFullMessage,
  samsloopMaxSeconds,
  samsloopMaxSecondsExact,
  samsloopBindingCap,
  SAMSLOOP_RACK_RECORD_BUDGET_BYTES,
  SAMSLOOP_MIN_RECORD_SECONDS,
  SAMSLOOP_REC_DEFAULTS,
} from './samsloop-record';

const IDS = ['rack-budget-me', 'rack-budget-hog'];

function despawn(): void {
  ydoc.transact(() => {
    for (const id of IDS) if (patch.nodes[id]) delete patch.nodes[id];
  }, LOCAL_ORIGIN);
}

/** Spawn a samsloop into the REAL doc, optionally carrying a recording of
 *  `b64Bytes` base64 characters — the same shape the RECORD commit writes. */
function spawn(id: string, b64Bytes = 0): void {
  ydoc.transact(() => {
    patch.nodes[id] = {
      id,
      type: 'samsloop',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: {},
      data: b64Bytes > 0
        ? {
            sample: {
              bytesB64: 'A'.repeat(b64Bytes),
              rate: 48_000, bits: 16, channels: 1,
              byteLength: Math.floor((b64Bytes / 4) * 3),
              durationSec: 1, recordedAt: 1,
            },
          }
        : {},
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
}

beforeEach(despawn);
afterEach(despawn);

const D = SAMSLOOP_REC_DEFAULTS;

describe('the rack ceiling, against a REAL Y.Doc', () => {
  it('an empty rack is invisible: full length, nothing binding but the per-take cap', () => {
    spawn(IDS[0]!);
    const ledger = samsloopRackLedger(patch.nodes, IDS[0]);
    expect(ledger.usedBytes).toBe(0);
    expect(ledger.freeBytes).toBe(SAMSLOOP_RACK_RECORD_BUDGET_BYTES);
    expect(samsloopMaxSeconds(D.rate, D.bits, D.channels, ledger.freeBytes)).toBeCloseTo(31.25, 2);
    expect(samsloopBindingCap(D.rate, D.bits, D.channels, ledger.freeBytes)).not.toBe('rack');
  });

  it('reads a payload written through the syncedStore PROXY, not just a fixture', () => {
    // The whole reason this file uses a real doc: `node.data` here is a Y.Map
    // behind a proxy, and `data.sample.bytesB64` is a nested read through it.
    // A ledger that worked on plain objects and not on the live shape would
    // pass `samsloop-record.test.ts` and fail in the app.
    spawn(IDS[0]!);
    spawn(IDS[1]!, 4_000_000);
    const ledger = samsloopRackLedger(patch.nodes, IDS[0]);
    expect(ledger.usedBytes).toBe(4_000_000);
    expect(ledger.nodeCount).toBe(2);
  });

  it('a PARTIALLY full rack SHRINKS the take and names the rack as the reason', () => {
    spawn(IDS[0]!);
    spawn(IDS[1]!, 11_000_000); // leaves 1 MB of base64 = 750 000 raw bytes
    const ledger = samsloopRackLedger(patch.nodes, IDS[0]);
    expect(ledger.freeBytes).toBe(1_000_000);

    const capped = samsloopMaxSeconds(D.rate, D.bits, D.channels, ledger.freeBytes);
    const uncapped = samsloopMaxSeconds(D.rate, D.bits, D.channels);
    expect(capped).toBeCloseTo(7.81, 2);
    expect(capped, 'the readout must SHRINK — that is the visible half').toBeLessThan(uncapped);
    expect(samsloopBindingCap(D.rate, D.bits, D.channels, ledger.freeBytes)).toBe('rack');
    // …and it is still usable, so the card must NOT refuse here.
    expect(capped).toBeGreaterThanOrEqual(SAMSLOOP_MIN_RECORD_SECONDS);
  });

  it('a FULL rack refuses, and the refusal carries the figures the card prints', () => {
    spawn(IDS[0]!);
    spawn(IDS[1]!, 12_500_000);
    const ledger = samsloopRackLedger(patch.nodes, IDS[0]);
    expect(ledger.overBudget).toBe(true);
    expect(ledger.freeBytes).toBe(0);

    // What the readout shows — `0.00s max`, the string the card renders.
    expect(samsloopMaxSeconds(D.rate, D.bits, D.channels, ledger.freeBytes).toFixed(2)).toBe('0.00');
    // What `startRecording`'s guard tests.
    expect(samsloopMaxSecondsExact(D.rate, D.bits, D.channels, ledger.freeBytes))
      .toBeLessThan(SAMSLOOP_MIN_RECORD_SECONDS);
    // What lands in the error line.
    const msg = samsloopRackFullMessage(ledger);
    expect(msg).toContain('12.5 MB of the 12.0 MB');
    expect(msg).toMatch(/delete|shorten/i);
  });

  it('a node NEVER counts its own payload — re-recording must not get harder', () => {
    spawn(IDS[0]!, 12_500_000); // I am the hog
    spawn(IDS[1]!);
    // From my own perspective there is a full budget of room, because my
    // bytes are about to be replaced.
    expect(samsloopRackLedger(patch.nodes, IDS[0]).freeBytes)
      .toBe(SAMSLOOP_RACK_RECORD_BUDGET_BYTES);
    // From the OTHER node's perspective the rack is full.
    expect(samsloopRackLedger(patch.nodes, IDS[1]).freeBytes).toBe(0);
  });

  it('NEGATIVE CONTROL: the reading tracks the doc in BOTH directions', () => {
    // A ledger returning a constant would satisfy every assertion above that
    // names a number. Add bytes → less room; remove them → the room comes back
    // (a ceiling you cannot get back under is a trap, not a budget).
    spawn(IDS[0]!);
    const before = samsloopRackLedger(patch.nodes, IDS[0]).freeBytes;
    spawn(IDS[1]!, 6_000_000);
    const during = samsloopRackLedger(patch.nodes, IDS[0]).freeBytes;
    expect(during).toBeLessThan(before);
    ydoc.transact(() => { delete patch.nodes[IDS[1]!]; }, LOCAL_ORIGIN);
    expect(samsloopRackLedger(patch.nodes, IDS[0]).freeBytes).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe('the SEAM binds the ceiling to the arm gesture — source-anchored', () => {
  // ⚠ THIS DESCRIBE READ `SamsloopCard.svelte`, and the reason it read SOURCE at
  // all is unchanged: a gate that reads only the logic cannot see a surface that
  // computes the right number and renders none of it.
  //
  // The card was the surface that rendered it. `samsloop-face-actions.ts` is the
  // seam the faceplate's REC cell drives, and it is where the arm-time
  // re-read, the refusal message and the capture sizing live now — so the legs
  // that were about the DECISION move here, and the legs that were about the
  // card's own DOM are recorded below as losses.
  const SEAM = new URL('../../ui/modules/samsloop-face-actions.ts', import.meta.url);
  const src = readFileSync(SEAM, 'utf8');

  it('the arm guard re-reads the ledger FRESH and prints the refusal', () => {
    // Trusting a cached derived here would let a peer's write race the press.
    expect(src, 'the seam must re-read the ledger at arm time')
      .toContain('samsloopRackLedger(patch.nodes, nodeId)');
    expect(src, 'the refusal must surface the shared message')
      .toContain('samsloopRackFullMessage');
    expect(src).toContain('SAMSLOOP_MIN_RECORD_SECONDS');
  });

  it('the capture buffer is sized with the rack allowance, so nothing is trimmed later', () => {
    expect(src).toMatch(/samsloopMaxCaptureFrames\([\s\S]{0,160}?liveLedger\.freeBytes/);
  });

  it('the max-seconds figure is fed the rack headroom, not just the settings', () => {
    // Computing from (rate, bits, channels) alone would produce a number this
    // rack cannot deliver, which is the whole point of the ledger.
    expect(src).toMatch(/liveLedger\.freeBytes/);
  });

  // ⚠ FOUR LEGS ARE GONE WITH THE CARD, AND TWO OF THEM ARE REAL LOSSES.
  //
  //   * "subscribes the rack ledger to docVersion()" — THE ONE THAT ACTUALLY
  //     BROKE. Without it the derived tracked nothing across nodes and the
  //     readout went stale on a full rack, silently. It was a property of a
  //     COMPONENT's `$derived.by`; the seam re-reads at arm time instead, which
  //     is asserted above and is strictly fresher.
  //   * "disables REC when full — but never while recording, or STOP is
  //     unreachable" — a `recButtonDisabled` derived on the card. The face's REC
  //     cell has no such disable, so the refusal path is what a player meets.
  //   * ⚠ NAMED COVERAGE LOSS: "renders the rack note, and only when the RACK is
  //     the binding cap" (`data-testid="samsloop-rack-budget-note"`) and "the
  //     max-seconds READOUT". Both were PAINTED on the card and are painted on
  //     no surviving surface — the face reports `delivered: false` with nowhere
  //     to show it, which is the gap the build brief's S1 "Samsloop REC refusal
  //     surface" item exists to close. Recorded here so the two halves are
  //     visibly the same finding.
});
