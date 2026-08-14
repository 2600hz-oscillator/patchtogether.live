// The web app imports packages/dsp worklet SOURCES (worklet-URL imports for
// audioWorklet.addModule), so svelte-check's program compiles them too — and
// they rely on the AudioWorkletGlobalScope ambients declared ONCE in
// packages/dsp (#1604). Reference, never duplicate: one definition, two
// programs.
/// <reference path="../../dsp/src/worklet-globals.d.ts" />
