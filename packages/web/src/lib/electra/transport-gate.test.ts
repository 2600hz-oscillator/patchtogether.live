// packages/web/src/lib/electra/transport-gate.test.ts
//
// The UA predicate for the Chromium-152 macOS SysEx regression. The predicate
// NEVER decides alone (a framed identity reply overrides it — asserted in
// autoconfig.test.ts where the caller lives); here: exactly which environments
// it names, both directions.
import { describe, it, expect } from 'vitest';
import {
  isSuspectSysexEnv,
  browserSysexRegressionAdvisory,
  LEGACY_MIDI_RELAUNCH_COMMAND,
} from './transport-gate';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)';

describe('isSuspectSysexEnv', () => {
  it('names macOS Chromium-152 across the family (Edge, Chrome, Brave)', () => {
    expect(isSuspectSysexEnv(`${MAC} Chrome/152.0.4191.53 Safari/537.36 Edg/152.0.4191.53`)).toBe(true);
    expect(isSuspectSysexEnv(`${MAC} Chrome/152.0.4191.20 Safari/537.36`)).toBe(true);
  });

  it('does NOT name other majors, other platforms, or non-Chromium', () => {
    expect(isSuspectSysexEnv(`${MAC} Chrome/151.0.4188.90 Safari/537.36`)).toBe(false);
    expect(isSuspectSysexEnv(`${MAC} Chrome/153.0.4200.10 Safari/537.36`)).toBe(false);
    expect(isSuspectSysexEnv(`${WIN} Chrome/152.0.4191.53 Safari/537.36 Edg/152.0.4191.53`)).toBe(false);
    expect(isSuspectSysexEnv(`${MAC} Version/26.0 Safari/605.1.15`)).toBe(false);
    expect(isSuspectSysexEnv('')).toBe(false);
  });
});

describe('browserSysexRegressionAdvisory', () => {
  it('carries the exact owner-verified relaunch command and says nothing was uploaded', () => {
    const text = browserSysexRegressionAdvisory();
    expect(text).toContain(LEGACY_MIDI_RELAUNCH_COMMAND);
    expect(LEGACY_MIDI_RELAUNCH_COMMAND).toContain('--disable-features=MidiMacUmp');
    expect(text).toContain('Nothing was uploaded');
  });
});
