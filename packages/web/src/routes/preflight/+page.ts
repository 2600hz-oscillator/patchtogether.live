// The pre-flight (Stage-1) rig-setup screen the native shell loads before the
// rack on a first run (apps/desktop/src/main.ts). Fully client-rendered — it
// probes hardware (displays, cameras, WebMIDI) and the ptNative bridge, none of
// which exist under SSR. SPA-fallback served, exactly like /rack.
//
// This is the PLACEHOLDER: it wires the launch swap end-to-end (Enter rack →
// `preflight.done`) so Part-1 persistence is testable in the native app. The
// full per-slot setup panel (displays, cameras, ES-9, Push, Launchpad, PTZ)
// lands in Part 2.
export const ssr = false;
export const csr = true;
export const prerender = false;
