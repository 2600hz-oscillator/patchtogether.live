// art/setup/profile-coverage.ts
//
// Coverage lists for THE AUDIO-PROFILE GATE (owner decision §6b.1 —
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md): every
// audio-domain module def must have ≥1 committed ART audio-profile baseline
// (`art/baselines/<group>/*.f32`) UNLESS it is
//   (a) structurally excluded (ART_EXCLUDED — cannot be deterministically
//       profiled offline), or
//   (b) still on the backfill BACKLOG (ART_BACKLOG — a NAMED list that shrinks
//       batch by batch, enforced by scenarios/_meta/audio-profile-gate.test.ts;
//       there is no count, see the note at the bottom of this file).
//
// NEW modules are therefore gated IMMEDIATELY: adding an audio def without a
// profile (and without an explicit, reasoned exclusion) fails the ART lane.

/**
 * Structural exclusions (spec §4.4) — modules that CANNOT be deterministically
 * profiled offline. Every entry carries its reason. Adding to this list is a
 * design decision, not an escape hatch: prefer a profile wherever a
 * deterministic pure-TS render exists.
 *
 * (The spec's conditional/stretch ideas — seeded scripted-input game captures,
 * synthetic-input pass-through for mic/MIDI — are explicitly deferred.)
 */
export const ART_EXCLUDED: Readonly<Record<string, string>> = {
  audioIn: 'live getUserMedia mic — output is a pass-through of external signal; no offline source',
  es9: 'physical ES-9 hardware via the native-bridge WebSocket — outputs pass through external rack signal; no deterministic offline source (ring/scaling/policy math pinned by the dsp es9-bridge-core unit suite)',
  vstInstrument: 'a mounted AU plugin via the vst-bridge helper WebSocket — its audio IS the external plugin render; no deterministic offline source (poly-CV→MIDI conversion pinned by the dsp vst-bridge-core unit suite; wire codecs by vst-transport; real chain by the mocked-helper e2e vst-bridge.spec.ts)',
  vstFx: 'a mounted AU plugin via the vst-bridge helper WebSocket — same class as vstInstrument: the processed audio is the external plugin render, and the offline-reachable path (the not-connected local bypass, incl. its mono normal) is pinned by the dsp vst-bridge tests + the stereo-mono-normal e2e roster',
  cvBuddy: 'lane→ES-9 CV/gate/clock sender — its OUTPUT ports are cv/gate (auto-routed to the physical ES-9 jacks), not audio-family; the only audio is the ES-9 hardware RETURN (external rack signal, no deterministic offline source), same class as es9. Passthrough/slot/clock math pinned by the cv-buddy slot-alloc + clock-math + es9-reconcile unit suites',
  cvBuddyMini: 'same as cvBuddy — a lane→ES-9 CV/gate sender whose OUTPUT ports are cv/gate, not audio-family; it differs from cvBuddy only by dropping the velocity port, and it shares createCvBuddyHandle so there is no separate clock to capture. Slot/clock math pinned by the same cv-buddy slot-alloc + clock-math + es9-reconcile unit suites',
  gamepad: 'HID controller CV — no deterministic offline input',
  joystick: 'HID controller CV — no deterministic offline input',
  midiLane: 'live MIDIAccess device stream — no deterministic offline source',
  midiCvBuddy: 'live MIDIAccess device stream — no deterministic offline source',
  midiOutBuddy: 'terminal MIDI sink — no audio-family OUTPUT port to capture',
  midiclock: 'live MIDIAccess device stream — no deterministic offline source',
  trails: 'live MIDIAccess device stream from the Bela Trails touch pad — every OUTPUT port is cv/gate driven entirely by 14-bit CC, notes and MIDI clock arriving from external hardware, so there is no audio-family port to capture and no deterministic offline source to drive one. Same class as midiCvBuddy / midiLane / midiclock. The wire decode (14-bit assembly incl. MSB-only and out-of-order arrival, gate emission, clock division) is pinned by trails-decode.test.ts against golden byte vectors; the real chain (simulated device → x1 → VCA → SCOPE RMS) by the e2e trails.spec.ts',
  tempolock: 'beat-tracking clock utility — its OUTPUT ports are gate/cv (a generated clock pulse train, a DC bpm level, a DC lock level), not audio-family, and the tracker runs on the main-thread scheduler clock (getSchedulerClock + createEdgeCounter over an AnalyserNode tap), which does not exist in the offline ART render path. The tracking math is pure and exhaustively pinned by tempolock-tracker.test.ts (owner pattern verbatim + the real recorded onset train + ramp/jitter/dropout/octave fixtures); the wire path is pinned by tempolock.spec.ts (pulse source → tempolock → TIMELORDE CLOCK IN follow)',
  livecode: 'user-authored code evaluated at runtime — no fixed output to pin',
  pong: 'free-running game audio driven by RNG + gameplay state',
  modtris: 'free-running game audio driven by RNG + gameplay state',
  frogger: 'free-running game audio driven by RNG + gameplay state',
  skifree: 'free-running game audio driven by RNG + gameplay state',
  qbrt: 'free-running game audio driven by RNG + gameplay state',
  seqtris: 'an interactive 8×8 Tetris — every note it emits is a function of the piece bag, the player\'s button presses and the pulse count on an external clock jack, none of which exist in the offline render path (no scheduler-clock tick, no Launchpad, no presses), so the module sits on its opening piece and emits nothing there. Same class as modtris / pong. It is not silent for lack of coverage: the RULES are a pure seeded core pinned exhaustively by seqtris-engine.test.ts (piece set and the 2-row modifications, rotation as a rigid index-preserving transform, the tracked square incl. the leftmost tie-break and its immutability under rotation, collision, line clear + board drop, the divisor ladder, and the column→octave / row→descending-major note derivation), and the real chain — simulated Launchpad scene presses + a real clock through PIECE into a voice — by seqtris.spec.ts asserting audible SCOPE RMS',
  audioOut: 'terminal sink — no audio-family OUTPUT port to capture',
  clockedRunner: 'utility with no audio-family OUTPUT port to capture',
  chromaconsole: 'control surface for an EXTERNAL MIDI device (Hologram Chroma Console) — its only output is CC on a MIDI wire, and it has no audio-family OUTPUT port to capture; the pedal\'s audio never enters the graph (patched through the ES-9 by hand). Transmission is pinned by the midi/cc-out + cc-ramp unit suites and the bytes-on-the-wire e2e',
  ptzcam: 'control surface for an EXTERNAL PTZ camera (NexiGo P610 via the PT-PTZ MIDI→UVC helper) — its only output is sysex on a MIDI wire, and it has no audio-family OUTPUT port to capture; the camera\'s picture enters the rack through a normal camera input, never audio. The protocol is pinned by ptz-sysex.test.ts (hardware-captured caps-reply fixture) + ptz-control.test.ts, and the wire path by the bytes-on-the-wire e2e (ptzcam.spec.ts)',
  spectrograph: 'video-only outputs (analysis sink) — video belongs to VRT/WebGL-attest',
  dockscope: 'terminal visualiser (analysis sink) — no OUTPUT ports at all; nothing to capture',
};

/**
 * THE BACKFILL BACKLOG (owner: "gate"): the audio-domain modules that do not
 * yet have an audio profile, named one by one.
 * Seeded 2026-07-01 from the live registry (126 audio defs − 7 already
 * covered − 16 structural exclusions = 103), minus the 2 Phase-0 pilots
 * (the since-retired chowkick, plus adsr) profiled in the same PR → 101 committed entries.
 * Batch 1 (#1001) −6 → 95; batch 2 (#1002) −6 → 89; batch 3 (#1005) −6 → 83;
 * batch 4 −8 → 75; batch 5 −8 → 67 (noise, scaler, polarizer, depolarizer,
 * negativity, illogic, delay, veils); batch 6 −8 → 59 — the tier-crossing
 * batch: a FAUST-IN-NODE harness (art/setup/faust-offline.ts) makes compiled
 * Faust `.dsp` modules ART-profilable (vca, filter, mixer, reverb, destroy,
 * mixmstrs) alongside the last easy TS ones (stereovca worklet, scope
 * offline-def). Deleting the helm/polyhelm/hydrogen modules removed those
 * 3 backlog ids −3 → 56.
 *
 * RULES (enforced by audio-profile-gate.test.ts):
 *   - a module that gains a baseline MUST be removed from this list (the
 *     "a module with a baseline must NOT stay in ART_BACKLOG" assertion);
 *   - entries must be real registry ids, unique, and never in ART_EXCLUDED
 *     (the "lists are well-formed" artifact anchor — an id that no longer
 *     names an audio-domain registry module is RED);
 *   - a NEW audio module may never join this list: it is not on it, so the
 *     deny-by-default `missing → toEqual([])` assertion reddens on it
 *     immediately unless it ships a profile or a reasoned ART_EXCLUDED entry.
 *
 * When a backfill batch lands: delete the profiled ids here. Nothing else.
 */
export const ART_BACKLOG: readonly string[] = [
  'buggles',
  'cartesian',
  'clipplayer',
  'clouds',
  'cloudseed',
  'drummergirl',
  'dx7',
  'foxy',
  'kria',
  'lfo',
  'macrooscillator',
  'marbles',
  'meowbox',
  'moog902',
  'moog903a',
  'moog912',
  'moog921a',
  'moog921b',
  'moog923',
  'moog956',
  'moog961',
  'moog984',
  'moog992',
  'moog993',
  'moog994',
  'moog995',
  'numpadPlus',
  'pentemelodica',
  'rasterize',
  'rings',
  'samsloop',
  'score',
  'shimmershine',
  'swolevco',
  'timelorde',
  'twotracks',
  'wavecel',
  'wavesculpt',
  'wavetableVco',
];

/*
 * ⚠ `ART_BACKLOG_MAX` (44) IS GONE (2026-08-12, the no-ratchets sweep) — P0 owner directive, "ratchets
 * are an anti pattern; remove all ratchets".
 *
 * WHAT IT WAS: a hand-typed copy of `ART_BACKLOG.length`, asserted `<=` and
 * then asserted `=== ART_BACKLOG.length` verbatim in the same test. A literal
 * whose only correct value is a quantity already sitting one screen above it,
 * in a file every backfill batch edits — precisely the construct that
 * auto-merged WRONG in three concurrent branches on the edge ledger.
 *
 * WHAT IT PROTECTED: "the backlog only ever shrinks — a new audio module can
 * never join it." That protection SURVIVES IN FULL, carried by three
 * assertions in art/scenarios/_meta/audio-profile-gate.test.ts, none of which
 * is a count:
 *   1. DENY BY DEFAULT — 'every audio module has ≥1 audio-profile baseline…'
 *      lists every audio id that has no baseline, no ART_EXCLUDED entry and no
 *      ART_BACKLOG membership, and asserts `toEqual([])`. A new module is by
 *      construction not on the backlog, so it reddens there the moment it
 *      lands. That is what actually stopped the list growing; the cap only
 *      re-stated it for the case where someone ALSO edited this file, which is
 *      a change a reviewer sees in the diff anyway.
 *   2. ARTIFACT ANCHOR — 'lists are well-formed…' rejects any backlog id that
 *      is not a live audio-domain id in the contract golden, plus duplicates
 *      and ART_EXCLUDED overlap. A name is checkable against the tree; a
 *      number never was.
 *   3. SHRINK-ON-COVERAGE — 'a module with a baseline must NOT stay in
 *      ART_BACKLOG' forces removal the moment a profile is committed, which is
 *      the "batches must lower it" behaviour the cap was credited with.
 *
 * NOTHING WAS DROPPED. The equality assertion could only fail if this file's
 * two literals disagreed with each other; it measured the list against a copy
 * of itself, never against the tree.
 */
