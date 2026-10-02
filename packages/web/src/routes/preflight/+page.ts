// The pre-flight (Stage-1) rig-setup screen the native shell loads before the
// rack on every launch (apps/desktop/src/main.ts). Fully client-rendered — it
// probes hardware (cameras, WebMIDI, gamepads) and the ptNative bridge, none of
// which exist under SSR. SPA-fallback served, exactly like /rack.
//
// ⚠ SHELL-ONLY (owner ruling 2026-09-15). In a plain browser this route never
// renders: the web product binds every device IN THE RACK — the camera and
// display slot pickers, the master audio-out picker, ES-9 / Push 2 / Launchpad
// / LinnStrument CONNECT on their faces — and a browser has no helper
// supervisor, no electron-store and no window to swap. The universal `load`
// below (client-side only, since `ssr = false`) redirects to `/rack` BEFORE the
// page component mounts, so nothing of this screen paints on the web. The
// shell (`window.ptNative` present) keeps the page exactly as it is.
//
// The per-slot setup panel: a row per device class the rack actually READS
// from the rig store (cameras, Push 2, Launchpad, PTZ, LinnStrument, TRAILS,
// gamepad), each showing live presence and one control that writes the
// per-machine record (device-slot-bindings.ts), plus the ES-9 and PTZ helper
// STATUS rows (read-only). Displays are deliberately absent: the shell opens no
// output windows (docs/design/native-shell.md "Not built"), so a display pick
// here would be applied by nobody — outputs are presented from the rack. It
// also wires the launch swap end-to-end (Enter rack → `preflight.done`, with
// a one-shot skip of the relaunch guard so the splash never bounces straight
// back to itself).
import { redirect } from '@sveltejs/kit';
import { nativeAvailable } from '$lib/platform/native';

export const ssr = false;
export const csr = true;
export const prerender = false;

/** Gate: the rig-setup page exists only inside the native shell. */
export function load(): void {
  if (!nativeAvailable()) redirect(307, '/rack');
}
