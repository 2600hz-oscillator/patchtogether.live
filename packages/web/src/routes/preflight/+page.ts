// The pre-flight (Stage-1) rig-setup screen the native shell loads before the
// rack on a first run (apps/desktop/src/main.ts). Fully client-rendered — it
// probes hardware (displays, cameras, WebMIDI) and the ptNative bridge, none of
// which exist under SSR. SPA-fallback served, exactly like /rack.
//
// The full per-slot setup panel: a row per device class (displays, cameras,
// ES-9, Push 2, Launchpad, PTZ, gamepad), each showing live presence and one
// control that writes the per-machine rig store (device-slot-bindings.ts). It
// also wires the launch swap end-to-end (Enter rack → `preflight.done`).
export const ssr = false;
export const csr = true;
export const prerender = false;
