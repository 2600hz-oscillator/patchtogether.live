// packages/web/src/lib/blood/blood-log-routing.test.ts
//
// The severity router that fixed "module blood renders … no console errors"
// failing on a CLEAN CHECKOUT OF MAIN (#1548).
//
// NBlood logs through loguru, which writes INFO/WARN/ERROR alike to stderr;
// emscripten's default printErr is console.error, so a healthy boot's every
// line landed as a console ERROR and the render sweep's contract red-lit the
// moment the engine booted fast enough to log inside the spec's window (0.15 s
// on a native-speed machine; CI's green was the boot losing that race — the
// coverage was timing-dependent in BOTH directions). The router restores the
// severity the line already carries.

import { describe, expect, it } from 'vitest';
import { routeBloodLogLine } from './blood-runtime';

describe('routeBloodLogLine (#1548) — severity comes from the LINE, not the transport', () => {
  it('INFO lines are info — a healthy boot is not an error stream', () => {
    for (const l of [
      '2026-08-14 …  loguru.cpp:903  INFO| Started at 2026-08-14',
      '…  blood.cpp:1747 INFO| Initializing Build 3D engine',
      'no severity token at all',
    ]) {
      expect(routeBloodLogLine(l), l).toBe('info');
    }
  });

  it('WARN lines are warnings — shareware data is the DESIGNED distribution (ADR-007)', () => {
    for (const l of [
      '…  common.cpp:185  WARN| Could not find main data file "nblood.pk3"!',
      '…  weapon.cpp:239  WARN| weapon QAV 113 not in RFF (shareware data?) - skipping',
      '…   choke.cpp:65   WARN| choke QAV 518 not in RFF (shareware data?) - disabling',
    ]) {
      expect(routeBloodLogLine(l), l).toBe('warn');
    }
  });

  it('the ONE named downgrade: the emscripten gamma-ramp ERROR is a warn, with its why at the site', () => {
    expect(
      routeBloodLogLine(
        '… sdlayer.cpp:2293 ERROR| Failed setting window gamma ramp: That operation is not supported.',
      ),
    ).toBe('warn');
  });

  it('every OTHER ERROR| line stays a REAL console error — the sweep keeps its teeth', () => {
    // Permanent negative control on the same predicate the sink calls: a
    // genuine engine failure must still land on the error channel, or the
    // route is a filter wearing a router's clothes.
    for (const l of [
      '…  common.cpp:200  ERROR| Failed to open BLOOD.RFF',
      '… sdlayer.cpp:100  ERROR| GL context lost',
    ]) {
      expect(routeBloodLogLine(l), l).toBe('error');
    }
  });
});
