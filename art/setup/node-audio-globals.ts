// art/setup/node-audio-globals.ts
//
// Installs the browser AudioWorklet globals so an ART scenario can drive a REAL
// module factory — the shipped `AudioModuleDef.factory`, worklet and all —
// instead of hand-rebuilding its graph or falling back to a pure-TS mirror.
//
// A factory does `new AudioWorkletNode(ctx, name, …)`, i.e. it reads a BROWSER
// GLOBAL. node-web-audio-api only exports the class, so without this the
// construction throws and (for audio-out) the factory quietly takes its
// degraded fallback path — a green scenario measuring the wrong topology.
//
// ⚠ Several older scenario headers state that "node-web-audio-api can't host
// AudioWorkletNodes" (analog-logic-maths, charlottes-echos, wavecel, score).
// That was true of the version those were written against; it is NOT true of
// the pinned one — `ctx.audioWorklet.addModule('packages/dsp/dist/<name>.js')`
// followed by `new AudioWorkletNode(...)` renders correctly today, and
// audio-out's master limiter is the first scenario to rely on it. Those
// scenarios still drive their cores directly, which is fine and often
// preferable (a pure core is the sharper unit); the comments are simply stale.
//
// The other half of the seam is `workletFsUrl()` in art/vitest.config.ts, which
// turns Vite's browser-facing `?url` asset path into the filesystem path
// `addModule()` needs.

import { AudioWorkletNode } from 'node-web-audio-api';

const g = globalThis as { AudioWorkletNode?: unknown };
g.AudioWorkletNode ??= AudioWorkletNode;
