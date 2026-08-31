// packages/web/src/lib/electra/transport-gate.ts
//
// THE TRANSPORT GATE for the Chromium-152 macOS SysEx regression (2026-08-29).
//
// Chromium 152 enabled the new UMP-based CoreMIDI backend (`MidiMacUmp`) on
// macOS, and its converter corrupts SysEx framing: every WebMIDI `send()`
// reports success while nothing (or garbage) reaches the device. Field
// signature, measured against a mk2 on fw 4.1.4: enumeration is fine, plain CC
// in from the hardware is fine, the console logs a complete outbound flash
// sequence — and a CoreMIDI tap on the device's response ports hears NOTHING.
// The same machine's out-of-browser CoreMIDI client got an identity reply in
// tens of ms. Relaunching Edge 152 with `--disable-features=MidiMacUmp`
// restored the whole pipeline (owner-verified). The upstream Chromium fix
// landed after the 152 branch cut.
//
// A web page cannot flip a browser feature flag, so the app's whole job here
// is to REFUSE TO PRETEND: detect the broken transport before anything
// mutating is sent, return a structured result, and name the exact recovery.
//
// The gate lives at the ELECTRA boundary (autoconfig.run), not in the shared
// MIDI-access layer: ordinary CC MIDI is healthy under the regression, and the
// evidence that decides the verdict (the identity probe, the Electra port
// presence, mangled Electra-manufacturer frames) is all Electra-specific.
//
// ⚠ THE UA CHECK NEVER DECIDES ALONE. A successful FRAMED identity reply
// always overrides it (Edge 152 relaunched with the flag, or a future 152
// backport, proceeds normally) — the caller only consults `isSuspectSysexEnv`
// AFTER the probe came back empty. That is the negative control against a
// brittle UA block.

/** True when the UA names the affected environment: macOS + Chromium-family
 *  major 152 (Chrome, Edge, Brave, … all carry `Chrome/152`). Version-exact by
 *  design — 153 carries the upstream fix, and earlier majors never shipped the
 *  backend — so a healthy future browser can never be refused by its UA
 *  string. A still-broken hypothetical build outside 152 is caught by the
 *  mangled-frame signature instead, which is version-independent. */
export function isSuspectSysexEnv(ua: string): boolean {
  const chromiumMajor = Number(/Chrome\/(\d+)/.exec(ua)?.[1] ?? NaN);
  return /Macintosh/.test(ua) && chromiumMajor === 152;
}

/** The exact relaunch that restores the legacy backend — owner-verified on
 *  Edge 152.0.4191.53 / macOS 26.4. Kept as ONE copyable line. */
export const LEGACY_MIDI_RELAUNCH_COMMAND =
  '"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ' +
  '--user-data-dir=/tmp/edge-electra-legacy-midi --disable-features=MidiMacUmp';

/** The operator-facing compatibility error for a `browser-sysex-regression`
 *  verdict. Reaches the flash outcome's `detail` (accessible name + title) and
 *  the console — the console is where this failure class was actually debugged
 *  from in the field, and the one place the command can be copied from. */
export function browserSysexRegressionAdvisory(): string {
  return (
    'This browser cannot reach the Electra: Chromium 152 on macOS ships a ' +
    'broken MIDI SysEx backend (MidiMacUmp) that reports success while ' +
    'sending nothing. Nothing was uploaded. Relaunch with the legacy backend: ' +
    `${LEGACY_MIDI_RELAUNCH_COMMAND} — or use a non-152 Chromium browser.`
  );
}
