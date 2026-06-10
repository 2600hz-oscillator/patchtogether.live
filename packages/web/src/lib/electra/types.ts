// packages/web/src/lib/electra/types.ts
//
// Shared types for the Electra One MULTI-VIEW integration.
//
// The Electra One is a programmable MIDI controller (3 control sets × 12 pots
// per page, plus pads + a touch display). We drive it as a generated, named,
// auto-mapped "preset" (.epr JSON) plus an optional Lua layer (formatters,
// gating, custom VU). This file holds the preset-schema TypeScript shapes the
// pure generator (preset.ts) emits and the small DTOs the broker / feedback
// pump / autoconfig orchestrator pass around.
//
// The .epr schema mirrors the documented Electra One preset format (version 2):
// pages[], devices[], overlays[], groups[], controls[]. We model only the
// subset we generate. Everything is plain JSON so it serialises deterministically
// (the generator emits a minified, 7-bit-ASCII string at upload time).
//
// See docs/electra/INTEGRATION.md §5 for the full scheme.

import type { KnobCurve } from '$lib/graph/types';

// ──────────────────────────── preset (.epr) schema ────────────────────────────

/** Electra control message type. We use cc7 for continuous params + meters,
 *  and `note` for the momentary tap-tempo pad. */
export type ElectraMessageType = 'cc7' | 'cc14' | 'note' | 'nrpn';

/** A page on the device. Three in the MULTI-VIEW scheme:
 *  1 CONTROL (control-surface params), 2 MIXMASTER, 3 SYSTEM (tempo). */
export interface ElectraPage {
  id: number;
  name: string;
  /** Which of the 3 control sets is active when the page is shown. */
  defaultControlSetId?: number;
}

/** A logical MIDI device the preset talks to. Two: PT-CTRL (port 2, throttled
 *  for meters) and PT-PLAY (port 1, for note/tap traffic). */
export interface ElectraDevice {
  id: number;
  name: string;
  /** Electra hardware port index (1 = USB device port "PLAY", 2 = "CTRL"). */
  port: number;
  /** MIDI channel 1..16. */
  channel: number;
  /** Outbound rate limit (messages/sec). ~33 ≈ 30Hz for the meter stream. */
  rate?: number;
}

/** A discrete-value overlay (named choices) for list-style controls —
 *  swingSource (0..10), compEnable (0/1), INT/EXT source label. */
export interface ElectraOverlay {
  id: number;
  items: Array<{ value: number; label: string }>;
}

/** A visual group header on a page (CONTROL page groups params by source
 *  module; MIXMASTER groups by channel). */
export interface ElectraGroup {
  pageId: number;
  /** Inclusive control-slot range [from, to] the header spans. */
  controlSetId?: number;
  name: string;
  /** Lowest pot/slot index covered (1-based, page-local). */
  from: number;
  to: number;
  /** On-screen rectangle [x, y, width, height] — like controls, the firmware
   *  needs this to draw the group's header box. */
  bounds?: [number, number, number, number];
  /** Unique id (shares the control id space). Real presets always set it. */
  id?: number;
  /** Header style; real presets use 'highlighted'. */
  variant?: string;
  /** 6-digit hex RGB string (real presets set it, e.g. "FFFFFF"). */
  color?: string;
}

/** The MIDI message a control input/value binds to. */
export interface ElectraMessage {
  deviceId: number;
  type: ElectraMessageType;
  parameterNumber: number;
  min?: number;
  max?: number;
  /** For pads / notes: value sent on press / release. */
  onValue?: number;
  offValue?: number;
}

/** One value descriptor on a control (scaled range + optional Lua formatter). */
export interface ElectraValue {
  id?: string;
  message: ElectraMessage;
  /** Display range (param's natural min/max). */
  min?: number;
  max?: number;
  /** Default value to render at. */
  defaultValue?: number;
  /** Name of a Lua formatter fn uploaded in the Lua layer (e.g. 'fmtDb'). */
  formatter?: string;
  /** Overlay id for list/discrete controls. */
  overlayId?: number;
}

/** A control widget on a page. */
export interface ElectraControl {
  id: number;
  /** Page the control lives on. */
  pageId: number;
  /** Control-set (1..3) the control belongs to. */
  controlSetId: number;
  /** Pot/slot index within the control set (1..12). */
  potId?: number;
  type: 'fader' | 'vfader' | 'list' | 'pad';
  name: string;
  /** thin/outline variant — used for read-only meter vfaders. */
  variant?: 'thin' | 'outline' | 'default';
  /** Pads: momentary (tap) vs toggle (mute). */
  mode?: 'momentary' | 'toggle';
  /** App-side tag: this control is read-only (app→device only; inbound CC is
   *  NOT routed to a param). Meters set this. */
  readOnly?: boolean;
  inputs?: Array<{ potId: number; valueId: string }>;
  values: ElectraValue[];
  /** Accent colour as a 6-digit hex RGB string (e.g. "529DEC"), matching the
   *  Electra preset format. Every control in a real preset has one; a colorless
   *  control can fail to render. */
  color?: string;
  /** On-screen rectangle [x, y, width, height] in the 1024x600 layout space.
   *  REQUIRED by the firmware — a control with no bounds has no position and
   *  the device draws nothing for it (the page renders but is empty). */
  bounds?: [number, number, number, number];
  /** Explicit visibility (default true). Emitted so the firmware never
   *  defaults a control to hidden. */
  visible?: boolean;
}

/** The whole preset document. */
export interface ElectraPreset {
  version: 2;
  name: string;
  projectId?: string;
  pages: ElectraPage[];
  devices: ElectraDevice[];
  overlays: ElectraOverlay[];
  groups: ElectraGroup[];
  controls: ElectraControl[];
}

// ──────────────────────────── allocation table ────────────────────────────

/** What a single generated control maps to: the app-side param key + the CC
 *  (or note) it was assigned. Deterministic — the generator returns this table
 *  alongside the preset so feedback.ts (param→CC) + the inbound dispatch
 *  (CC→param) and the unit snapshot all share ONE source of truth. */
export interface ElectraAllocation {
  /** "moduleId:paramId" — the SAME key MIDI-learn / control-surface use. For
   *  meters this is "moduleId:meter:<n>"; for the tap pad "moduleId:tap". */
  key: string;
  pageId: number;
  controlSetId: number;
  potId?: number;
  deviceId: number;
  messageType: ElectraMessageType;
  /** CC number (cc7/cc14/nrpn) or note number (note). */
  number: number;
  /** Param natural range (for value↔CC scaling). Absent for pads/notes. */
  min?: number;
  max?: number;
  curve?: KnobCurve;
  /** Role of this allocation in the inbound/outbound dispatch:
   *  - 'rw'   : writable control (CC in → param write; param → CC out feedback)
   *  - 'meter': read-only (param/level → CC out only; inbound CC ignored)
   *  - 'tap'  : momentary note in → tap-tempo helper (NOT a param)
   *  - 'banner': app→device label only (info text / source banner)
   *  - 'button-momentary': momentary note pad (note in → bound button action via
   *             the host callback registry; mirrors the TAP pad).
   *  - 'button-toggle': toggle cc7 0..1 pad (cc in → bound button action on the
   *             rising edge via the host callback registry; mirrors the Mute pad
   *             geometry but routes to a button action, not a raw param write). */
  role: 'rw' | 'meter' | 'tap' | 'banner' | 'button-momentary' | 'button-toggle';
}

/** The generator's full output: the preset doc + its deterministic CC/page
 *  allocation table. */
export interface GeneratedPreset {
  preset: ElectraPreset;
  allocations: ElectraAllocation[];
}

// ──────────────────────────── broker DTOs ────────────────────────────

/** A device fingerprint from the Electra identity reply (02 7F → device info). */
export interface ElectraIdentity {
  manufacturerId: number[];
  /** Raw firmware version string if parseable. */
  firmware?: string;
  /** True if this looks like an Electra One (manufacturer 00 21 45). */
  isElectra: boolean;
}
