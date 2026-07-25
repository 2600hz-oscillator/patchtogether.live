// packages/web/src/lib/control/push2/push2-types.ts
//
// Shared Launchpad-vocabulary TYPES the Push adapter speaks. The Push binds to
// the shipped Launchpad control brain by remapping its events into the EXACT
// Launchpad event vocabulary (decision A, plan §3), so these are re-exports of
// the Launchpad types — one import surface for the Push files, and a type-only
// dependency (no runtime coupling to the Launchpad device singleton).

export type { LaunchpadRxEvent } from '$lib/control/launchpad/launchpad-sysex';
export type {
  LaunchpadFrame,
  LaunchpadKeyEvent,
  LaunchpadUnit,
} from '$lib/control/launchpad/launchpad-device.svelte';
