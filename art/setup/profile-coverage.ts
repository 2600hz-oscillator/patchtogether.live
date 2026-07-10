// art/setup/profile-coverage.ts
//
// Coverage lists for THE AUDIO-PROFILE GATE (owner decision §6b.1 —
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md): every
// audio-domain module def must have ≥1 committed ART audio-profile baseline
// (`art/baselines/<group>/*.f32`) UNLESS it is
//   (a) structurally excluded (ART_EXCLUDED — cannot be deterministically
//       profiled offline), or
//   (b) still on the backfill RATCHET (ART_BACKLOG — shrinks batch by batch,
//       enforced by scenarios/_meta/audio-profile-gate.test.ts).
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
  gamepad: 'HID controller CV — no deterministic offline input',
  joystick: 'HID controller CV — no deterministic offline input',
  midiLane: 'live MIDIAccess device stream — no deterministic offline source',
  midiCvBuddy: 'live MIDIAccess device stream — no deterministic offline source',
  midiOutBuddy: 'terminal MIDI sink — no audio-family OUTPUT port to capture',
  midiclock: 'live MIDIAccess device stream — no deterministic offline source',
  livecode: 'user-authored code evaluated at runtime — no fixed output to pin',
  pong: 'free-running game audio driven by RNG + gameplay state',
  modtris: 'free-running game audio driven by RNG + gameplay state',
  frogger: 'free-running game audio driven by RNG + gameplay state',
  skifree: 'free-running game audio driven by RNG + gameplay state',
  qbrt: 'free-running game audio driven by RNG + gameplay state',
  audioOut: 'terminal sink — no audio-family OUTPUT port to capture',
  clockedRunner: 'utility with no audio-family OUTPUT port to capture',
  spectrograph: 'video-only outputs (analysis sink) — video belongs to VRT/WebGL-attest',
};

/**
 * THE RATCHET (owner: "gate", implemented like the behavioral quarantine
 * caps): the audio-domain modules that do not yet have an audio profile.
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
 *   - a module that gains a baseline MUST be removed from this list;
 *   - the list length can only SHRINK (≤ ART_BACKLOG_MAX);
 *   - entries must be real registry ids, unique, and never in ART_EXCLUDED.
 *
 * When a backfill batch lands: delete the profiled ids here AND lower
 * ART_BACKLOG_MAX to the new length. NEVER raise ART_BACKLOG_MAX.
 */
export const ART_BACKLOG: readonly string[] = [
  'buggles',
  'callsine',
  'cartesian',
  'clipplayer',
  'clouds',
  'cloudseed',
  'drummergirl',
  'drumseqz',
  'dx7',
  'foxy',
  'kria',
  'lfo',
  'macrooscillator',
  'macseq',
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
  'polyseqz',
  'rasterize',
  'rings',
  'samsloop',
  'score',
  'sequencer',
  'shimmershine',
  'swolevco',
  'timelorde',
  'twotracks',
  'warrenspectrum',
  'wavecel',
  'wavesculpt',
  'wavetableVco',
  'writeseq',
];

/** The ratchet cap. Lower it (to ART_BACKLOG.length) every time a batch
 *  removes entries; the gate fails if the list ever grows past it. */
export const ART_BACKLOG_MAX = 46;
