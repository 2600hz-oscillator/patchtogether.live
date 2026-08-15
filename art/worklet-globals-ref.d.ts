// ART scenarios import packages/dsp worklet SOURCES directly (profile drivers
// pass `() => import('../../packages/dsp/src/<name>')`), so this program
// compiles them too — and they rely on the AudioWorkletGlobalScope ambients
// declared ONCE in packages/dsp (#1604). Reference, never duplicate: one
// definition, three programs (dsp, web, art).
/// <reference path="../packages/dsp/src/worklet-globals.d.ts" />
