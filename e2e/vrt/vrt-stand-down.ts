// e2e/vrt/vrt-stand-down.ts
//
// THE VRT LANE DECLARES THAT IT IS NOT A PARTICIPANT IN THE AUDIO GATE.
//
// ── THE BUG THIS EXISTS FOR (#1826 review) ─────────────────────────────────
//
// `AudioGate.svelte` raises a notice whenever the AudioContext is not running,
// and — since it must not eat the click it asks for — resumes the context on the
// first user gesture anywhere in the document.
//
// VRT's determinism device is `freezeAudioContext()`: it SUSPENDS the
// AudioContext on purpose so analyser-fed surfaces stop advancing. A suspended
// context is, correctly, "not running", so the gate comes up and arms its
// first-gesture listener — and the very next thing a dock scene does is CLICK
// (`openDock`). MEASURED, with `readAudioClock` either side of that click:
//
//     wavetableVco  suspended@0.4000  ->  running@0.4400
//     moog921b      suspended@0.0667  ->  running@0.0933
//     adsr          suspended@0.3467  ->  running@0.3600
//
// i.e. it happens on EVERY face, not on two of them. The scene re-freezes before
// capturing, so `assertFaceAudioFrozen` still passed and the failure never
// surfaced as "the graph is running" — it surfaced as PIXELS, because the
// analyser had been fed a later window of audio and the live trace's PHASE moved.
// Only the faces whose dock plate paints an analyser-driven waveform could show
// it, which is why `wavetableVco` and `moog921b` reddened vrt-strict while adsr,
// analogVco, attenumix and backdraft were byte-identical. A sample that happened
// to contain no live trace was structurally unable to see this.
//
// ── WHY A FLAG AND NOT A STYLESHEET ────────────────────────────────────────
//
// The first attempt hid the overlay with `toHaveScreenshot.stylePath`. That is
// strictly a PIXEL fix applied at the shutter, and the defect is BEHAVIOURAL and
// happens long before it: the click had already resumed the graph. A capture-time
// stylesheet cannot reach it, and believing it had was the whole miss.
//
// This flag makes the VRT lane behaviourally IDENTICAL to main — no overlay, no
// listener, no resume, no engine booted by a click that previously booted none —
// which is the actual requirement ("mounting the gate must not alter any VRT
// capture"), rather than a way of not seeing the difference.
//
// ── WHY localStorage, DELIVERED BY `use.storageState` ──────────────────────
//
// It has to be true BEFORE THE FIRST PAINT of every scene, and the VRT lane is 41
// spec files that all navigate themselves and import `test` straight from
// `@playwright/test` (no shared fixture to hook). `use.storageState` is the one
// place a Playwright CONFIG can seed page state for every context it creates, so
// this is one declaration per config instead of an edit in 41 files.
//
// ⚠ DELIVERY IS VERIFIED, NOT ASSUMED. `freezeAudioContext()` throws if the gate
// overlay is present in the page, so every freeze in the lane (~43 per run) is a
// live check that this actually arrived. This repo has twice shipped a config knob
// Playwright silently ignored; a flag whose absence is invisible would be the third.
//
// ⚠ WHAT THIS MAKES THE VRT LANE STRUCTURALLY UNABLE TO SEE: the audio-gate
// overlay, in any state, on any scene. That coverage lives in the functional lane
// — `e2e/tests/audio-gate-cold-rack.spec.ts` asserts the overlay is up on a cold,
// un-gestured `/rack`, that no engine exists behind it, that it is not the hit
// target, and that a real gesture clears it and boots an engine.

/** The localStorage key `AudioGate.svelte` reads at init. Must match the constant
 *  there; `vrt-stand-down.test.ts` asserts the two spellings agree, because a
 *  typo here disables nothing and looks exactly like success. */
export const AUDIO_GATE_STAND_DOWN_KEY = 'pt.e2e.audio-gate-stand-down';

/** `use.storageState` value that seeds the stand-down for `baseUrl`'s origin. */
export function vrtStandDownStorageState(baseUrl: string): {
  cookies: [];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
} {
  return {
    cookies: [],
    origins: [
      {
        origin: new URL(baseUrl).origin,
        localStorage: [{ name: AUDIO_GATE_STAND_DOWN_KEY, value: '1' }],
      },
    ],
  };
}
