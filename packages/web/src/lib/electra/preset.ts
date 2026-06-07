// packages/web/src/lib/electra/preset.ts
//
// PRESET GENERATOR — the pure heart of the integration.
//
// Given a patch snapshot (nodes + edges + a control-surface's bindings) and a
// ParamDef resolver, produce a deterministic 3-page Electra One preset (.epr
// JSON) plus an allocation table (key ↔ CC/page/pot). No Web MIDI, no DOM, no
// Yjs — so the whole thing is snapshot-unit-testable (known patch → expected
// .epr + allocation table).
//
//   Page 1 CONTROL    — the Control Surface's bindings (or a generic node walk),
//                       grouped by source module, as faders/lists. (control-surface.ts
//                       groupBindingsByModule order = first-seen.)
//   Page 2 MIXMASTER  — per-channel mixer controls + a read-only meter row.
//   Page 3 SYSTEM     — TIMELORDE tempo display + BPM tweak + tap-tempo pad
//                       (+ optional swing/mute).
//
// CC / note allocation is sequential + deterministic so a regenerate produces a
// stable map (feedback.ts and the inbound dispatch both consume the table). The
// allocation walks pages in order; within a page, control-set then pot.
//
// 12 pots/control set, up to 3 control sets/page = up to 36 controls/page.
//
// Dependency injection: the caller passes `resolveParamDef(moduleId, paramId)`
// (the app wires this to resolveSurfaceParam(...).def over the live patch) so the
// generator never imports the registries directly — keeping it pure + testable.

import type { KnobCurve } from '$lib/graph/types';
import type {
  ElectraAllocation,
  ElectraControl,
  ElectraDevice,
  ElectraGroup,
  ElectraOverlay,
  ElectraPage,
  ElectraPreset,
  ElectraValue,
  GeneratedPreset,
} from './types';

// ──────────────────────────── inputs ────────────────────────────

/** A control-surface binding, mirrored from control-surface.ts so the generator
 *  doesn't depend on the svelte store module. */
export interface SurfaceBinding {
  moduleId: string;
  paramId: string;
}

/** Minimal ParamDef the generator needs (a subset of graph/types ParamDef). */
export interface GenParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  curve: KnobCurve;
  units?: string;
}

/** Inputs to the generator. */
export interface PresetGenInput {
  /** Bindings to lay out on the CONTROL page, in the order they should appear
   *  (caller passes groupBindingsByModule's flattened, first-seen order). */
  surfaceBindings: SurfaceBinding[];
  /** moduleId → display label (for group headers + control names). */
  moduleLabel: (moduleId: string) => string;
  /** Resolve a binding's ParamDef; null if it can't (param gone / nested). */
  resolveParamDef: (moduleId: string, paramId: string) => GenParamDef | null;
  /** The MIXMASTER source: the mixmstrs node id (null → no MixMaster controls,
   *  just the page shell). */
  mixmstrsId: string | null;
  /** The SYSTEM source: the timelorde node id (null → no tempo controls). */
  timelordeId: string | null;
  /** Preset name (defaults to "patchtogether"). */
  name?: string;
}

// ──────────────────────────── constants ────────────────────────────

export const POTS_PER_SET = 12;
export const SETS_PER_PAGE = 3;
export const MAX_CONTROLS_PER_PAGE = POTS_PER_SET * SETS_PER_PAGE; // 36

export const DEVICE_CTRL = 1; // PT-CTRL, port 2, throttled for meters
export const DEVICE_PLAY = 2; // PT-PLAY, port 1, note/tap traffic

export const PAGE_CONTROL = 1;
export const PAGE_MIXMASTER = 2;
export const PAGE_SYSTEM = 3;

// ── Control LAYOUT grid (FW 3.0.5+, 1024x600 mk2 display) ──────────────────
// Every control + group REQUIRES an on-screen `bounds` [x,y,w,h]; the firmware
// does NO auto-positioning, so a control with no bounds renders nothing (the
// page appears but is empty). These are the canonical Electra grid constants
// (cross-confirmed by docs.electra.one preset format + the xot/ElectraOne
// reference dumper): 6 columns x 6 rows of 146x56 cells. A page holds 3 control
// sets stacked as 2-row bands; potId 1..6 = a band's top row, 7..12 = bottom.
const CTRL_W = 146;
const CTRL_H = 56;
const COL_X = [20, 187, 354, 521, 688, 855] as const; // 6 column origins (pitch 167)
const ROW_Y = [28, 118, 208, 298, 388, 478] as const; // 6 row origins (pitch 90)

/** Bounds for a control at potId (1..12) within controlSetId (1..3). */
function boundsForPotSet(potId: number, controlSetId: number): [number, number, number, number] {
  const col = (potId - 1) % 6;
  const row = (controlSetId - 1) * 2 + Math.floor((potId - 1) / 6);
  return [COL_X[col] ?? 20, ROW_Y[Math.min(row, 5)] ?? 28, CTRL_W, CTRL_H];
}

/** Bounding box for a group spanning page-local slots [from..to] (1-based). */
function boundsForSlotRange(from: number, to: number): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let s = from; s <= to; s++) {
    const csId = Math.floor((s - 1) / POTS_PER_SET) + 1;
    const potId = ((s - 1) % POTS_PER_SET) + 1;
    const [x, y, w, h] = boundsForPotSet(potId, csId);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

/** MIXMSTRS channel count surfaced on the Electra mixer page. The N leftmost
 *  pots of each row map to channels 1..N. NOTE: the audio module is still 4
 *  channels until the 6-channel expansion lands — ch5/ch6 controls render but
 *  are inert (read/write no-op) until then. */
const MIX_CHANNELS = [1, 2, 3, 4, 5, 6] as const;

// ──────────────────────────── formatter selection ────────────────────────────

/** Pick the Lua formatter fn name for a param def (uploaded in the Lua layer). */
export function formatterFor(def: GenParamDef): string | undefined {
  if (def.units === 'dB') return 'fmtDb';
  if (def.units === 'bpm') return 'fmtBpm';
  if (def.id.includes('ratio')) return 'fmtRatio';
  return undefined;
}

// ──────────────────────────── allocation ────────────────────────────

/** A small sequential allocator: hands out CC numbers (one stream) and note
 *  numbers (separate stream) so meters + controls never collide. */
class Allocator {
  private cc = 0;
  private note = 0;
  nextCc(): number {
    // 0..119 are safe generic CCs; skip the channel-mode block (120..127).
    const n = this.cc++;
    return n; // generator stays well under 120 for our scheme
  }
  nextNote(): number {
    return this.note++;
  }
}

// ──────────────────────────── generator ────────────────────────────

/**
 * Build the 3-page preset + allocation table from a patch snapshot. Pure +
 * deterministic.
 */
export function generatePreset(input: PresetGenInput): GeneratedPreset {
  const alloc = new Allocator();
  const controls: ElectraControl[] = [];
  const groups: ElectraGroup[] = [];
  const overlays: ElectraOverlay[] = [];
  const allocations: ElectraAllocation[] = [];

  let controlId = 0;
  const nextControlId = () => ++controlId;

  // Overlay ids are assigned lazily; reuse one INT/EXT overlay across pages.
  let overlayId = 0;
  const nextOverlayId = () => ++overlayId;

  // ── Page 1: CONTROL (surface bindings) ──
  const page1Resolved = input.surfaceBindings
    .map((b) => ({ b, def: input.resolveParamDef(b.moduleId, b.paramId) }))
    .filter((x): x is { b: SurfaceBinding; def: GenParamDef } => x.def !== null)
    .slice(0, MAX_CONTROLS_PER_PAGE); // surface has no ordering beyond first-seen

  let lastModule: string | null = null;
  let groupStartSlot = 0;
  let slot = 0; // 0-based running control index on page 1
  for (const { b, def } of page1Resolved) {
    const csId = Math.floor(slot / POTS_PER_SET) + 1; // 1..3
    const potId = (slot % POTS_PER_SET) + 1; // 1..12

    // Group header at each new source module.
    if (b.moduleId !== lastModule) {
      if (lastModule !== null) {
        groups.push({
          pageId: PAGE_CONTROL,
          name: input.moduleLabel(lastModule),
          from: groupStartSlot + 1,
          to: slot,
        });
      }
      lastModule = b.moduleId;
      groupStartSlot = slot;
    }

    const cc = alloc.nextCc();
    const key = `${b.moduleId}:${b.paramId}`;
    const isDiscrete = def.curve === 'discrete';
    let ovId: number | undefined;
    if (isDiscrete) {
      ovId = nextOverlayId();
      overlays.push({
        id: ovId,
        items: discreteItems(def),
      });
    }
    const value: ElectraValue = {
      message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: cc, min: 0, max: 127 },
      min: def.min,
      max: def.max,
      defaultValue: def.defaultValue,
      formatter: formatterFor(def),
      overlayId: ovId,
    };
    controls.push({
      id: nextControlId(),
      pageId: PAGE_CONTROL,
      controlSetId: csId,
      potId,
      type: isDiscrete ? 'list' : 'fader',
      name: controlName(input.moduleLabel(b.moduleId), def.label),
      inputs: [{ potId, valueId: 'value' }],
      values: [value],
    });
    allocations.push({
      key,
      pageId: PAGE_CONTROL,
      controlSetId: csId,
      potId,
      deviceId: DEVICE_CTRL,
      messageType: 'cc7',
      number: cc,
      min: def.min,
      max: def.max,
      curve: def.curve,
      role: 'rw',
    });
    slot++;
  }
  // Close the final group on page 1.
  if (lastModule !== null && slot > groupStartSlot) {
    groups.push({
      pageId: PAGE_CONTROL,
      name: input.moduleLabel(lastModule),
      from: groupStartSlot + 1,
      to: slot,
    });
  }

  // ── Page 2: MIXMASTER ──
  if (input.mixmstrsId) {
    const mx = input.mixmstrsId;
    // Per-channel mixer grid mapped to the Electra's 3 control sets (2 rows
    // each). The N LEFTMOST pots of every row = channels 1..N; pots 1-6 = the
    // top row, 7-12 = the bottom row. MID EQ + COMP are intentionally NOT on
    // this page; master volume + the VU meters live on the SYSTEM page.
    //   Set 1: VOL (top, pots 1-6)  | PAN (bottom, pots 7-12) — RESERVED
    //   Set 2: LOW EQ (top)         | HIGH EQ (bottom)
    //   Set 3: SEND1 (top)          | SEND2 (bottom)
    const pushMixAt = (
      paramId: string, label: string, csId: number, potId: number,
      min: number, max: number, curve: KnobCurve, units?: string,
    ) => {
      const cc = alloc.nextCc();
      const def: GenParamDef = { id: paramId, label, min, max, defaultValue: 0, curve, units };
      controls.push({
        id: nextControlId(), pageId: PAGE_MIXMASTER, controlSetId: csId, potId,
        type: 'fader', name: label,
        inputs: [{ potId, valueId: 'value' }],
        values: [{
          message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: cc, min: 0, max: 127 },
          min, max, formatter: formatterFor(def),
        }],
      });
      allocations.push({
        key: `${mx}:${paramId}`, pageId: PAGE_MIXMASTER, controlSetId: csId, potId,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: cc, min, max, curve, role: 'rw',
      });
    };
    for (const ch of MIX_CHANNELS) {
      pushMixAt(`ch${ch}_volume`, `Ch${ch}`, 1, ch, 0, 1, 'linear');            // set 1 top: VOL
      // PAN → set 1 bottom (pot 6+ch) RESERVED until the module has a pan param.
      pushMixAt(`ch${ch}_low`, `Lo${ch}`, 2, ch, -12, 12, 'linear', 'dB');       // set 2 top: LOW EQ
      pushMixAt(`ch${ch}_high`, `Hi${ch}`, 2, 6 + ch, -12, 12, 'linear', 'dB');  // set 2 bottom: HIGH EQ
      pushMixAt(`ch${ch}_send1`, `S1.${ch}`, 3, ch, 0, 1, 'linear');             // set 3 top: SEND1
      pushMixAt(`ch${ch}_send2`, `S2.${ch}`, 3, 6 + ch, 0, 1, 'linear');         // set 3 bottom: SEND2
    }
  }

  // ── Page 3: SYSTEM (TIMELORDE) ──
  if (input.timelordeId) {
    const tl = input.timelordeId;
    let s = 0;
    const csId = () => Math.floor(s / POTS_PER_SET) + 1;
    const potId = () => (s % POTS_PER_SET) + 1;

    // BPM encoder — writable + feedback (reflects external lock). Log curve.
    {
      const cc = alloc.nextCc();
      const cs = csId(); const pot = potId();
      controls.push({
        id: nextControlId(), pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        type: 'fader', name: 'BPM',
        inputs: [{ potId: pot, valueId: 'value' }],
        values: [{
          message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: cc, min: 0, max: 127 },
          min: 10, max: 300, defaultValue: 120, formatter: 'fmtBpm',
        }],
      });
      allocations.push({
        key: `${tl}:bpm`, pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: cc,
        min: 10, max: 300, curve: 'log', role: 'rw',
      });
      s++;
    }

    // TAP pad — momentary note on PT-PLAY; inbound only, routed to tap helper.
    {
      const note = alloc.nextNote();
      const cs = csId(); const pot = potId();
      controls.push({
        id: nextControlId(), pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        type: 'pad', mode: 'momentary', name: 'TAP',
        values: [{
          message: { deviceId: DEVICE_PLAY, type: 'note', parameterNumber: note, onValue: 127, offValue: 0 },
        }],
      });
      allocations.push({
        key: `${tl}:tap`, pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        deviceId: DEVICE_PLAY, messageType: 'note', number: note, role: 'tap',
      });
      s++;
    }

    // SRC banner — read-only list (INT/EXT) driven by an app-pushed CC + overlay.
    {
      const cc = alloc.nextCc();
      const ovId = nextOverlayId();
      overlays.push({ id: ovId, items: [{ value: 0, label: 'INT' }, { value: 1, label: 'EXT' }] });
      const cs = csId(); const pot = potId();
      controls.push({
        id: nextControlId(), pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        type: 'list', readOnly: true, name: 'SRC',
        values: [{
          message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: cc, min: 0, max: 1 },
          overlayId: ovId,
        }],
      });
      allocations.push({
        key: `${tl}:source`, pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: cc, role: 'banner',
      });
      s++;
    }

    // Swing amount (0..90), swing source (discrete list), mute toggle.
    {
      const cc = alloc.nextCc();
      const cs = csId(); const pot = potId();
      controls.push({
        id: nextControlId(), pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        type: 'fader', name: 'Swing',
        inputs: [{ potId: pot, valueId: 'value' }],
        values: [{ message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: cc, min: 0, max: 127 }, min: 0, max: 90 }],
      });
      allocations.push({
        key: `${tl}:swingAmount`, pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: cc, min: 0, max: 90, curve: 'linear', role: 'rw',
      });
      s++;
    }
    {
      const cc = alloc.nextCc();
      const ovId = nextOverlayId();
      overlays.push({ id: ovId, items: Array.from({ length: 11 }, (_, i) => ({ value: i, label: String(i) })) });
      const cs = csId(); const pot = potId();
      controls.push({
        id: nextControlId(), pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        type: 'list', name: 'SwSrc',
        inputs: [{ potId: pot, valueId: 'value' }],
        values: [{ message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: cc, min: 0, max: 10 }, overlayId: ovId }],
      });
      allocations.push({
        key: `${tl}:swingSource`, pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: cc, min: 0, max: 10, curve: 'discrete', role: 'rw',
      });
      s++;
    }
    {
      const cc = alloc.nextCc();
      const cs = csId(); const pot = potId();
      controls.push({
        id: nextControlId(), pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        type: 'pad', mode: 'toggle', name: 'Mute',
        values: [{ message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: cc, min: 0, max: 1, onValue: 127, offValue: 0 } }],
      });
      allocations.push({
        key: `${tl}:muteOutputs`, pageId: PAGE_SYSTEM, controlSetId: cs, potId: pot,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: cc, min: 0, max: 1, curve: 'discrete', role: 'rw',
      });
      s++;
    }
  }

  // ── Page 3 (cont.): master volume + the mix-bus VU meters ──
  // Master is the "odd duck" that doesn't fit the per-channel mixer grid, so it
  // lives on SYSTEM next to the master tempo; the per-channel + master VU meters
  // ride along here (read-only). Placed in control sets 2 (master) + 3 (meters)
  // so the timelorde controls keep control set 1. Independent of the timelorde
  // gate above so master/meters still show on a rack with no clock.
  if (input.mixmstrsId) {
    const mx = input.mixmstrsId;
    {
      const cc = alloc.nextCc();
      const def: GenParamDef = { id: 'master_volume', label: 'Master', min: 0, max: 1, defaultValue: 0, curve: 'linear' };
      controls.push({
        id: nextControlId(), pageId: PAGE_SYSTEM, controlSetId: 2, potId: 1,
        type: 'fader', name: 'Master',
        inputs: [{ potId: 1, valueId: 'value' }],
        values: [{ message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: cc, min: 0, max: 127 }, min: 0, max: 1, formatter: formatterFor(def) }],
      });
      allocations.push({
        key: `${mx}:master_volume`, pageId: PAGE_SYSTEM, controlSetId: 2, potId: 1,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: cc, min: 0, max: 1, curve: 'linear', role: 'rw',
      });
    }
    // Master VU + per-channel VUs on control set 3 (read-only; app→device only).
    const meterRow = [
      { key: `${mx}:meter:master`, label: 'VUM' },
      ...MIX_CHANNELS.map((ch) => ({ key: `${mx}:meter:${ch}`, label: `VU${ch}` })),
    ];
    meterRow.forEach((m, i) => {
      const potId = i + 1; // cs3 pots 1..7
      const meterCc = alloc.nextCc();
      controls.push({
        id: nextControlId(), pageId: PAGE_SYSTEM, controlSetId: 3, potId,
        type: 'vfader', variant: 'thin', readOnly: true, name: m.label,
        values: [{ message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: meterCc, min: 0, max: 127 }, formatter: 'fmtMeterDb' }],
      });
      allocations.push({
        key: m.key, pageId: PAGE_SYSTEM, controlSetId: 3, potId,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: meterCc, role: 'meter',
      });
    });
  }

  // Fill the REQUIRED on-screen rectangle for every control + group from its
  // pot/control-set position. Without bounds the device builds the controls but
  // draws nothing (the pages render empty) — this is the single field whose
  // omission caused the blank-page bug on real hardware.
  // Per-page accent colours (valid Electra palette hex). Every control in a
  // real preset carries a colour; a colorless control can fail to render.
  const PAGE_COLOR: Record<number, string> = {
    [PAGE_CONTROL]: '529DEC',   // blue
    [PAGE_MIXMASTER]: '03A598', // teal
    [PAGE_SYSTEM]: 'F49500',    // orange
  };
  for (const c of controls) {
    if (!c.bounds && c.potId) c.bounds = boundsForPotSet(c.potId, c.controlSetId);
    if (c.visible === undefined) c.visible = true;
    if (c.color === undefined) c.color = PAGE_COLOR[c.pageId] ?? 'FFFFFF';
    for (const v of c.values) {
      // Each value's `id` must match the input's `valueId` ('value') or the pot
      // won't drive the control — confirmed against a real exported .epr.
      if (v.id === undefined) v.id = 'value';
      // FADER RESOLUTION: the Electra fader's step count = its display value
      // range's integer span. A unit-less 0..1 level therefore collapses to ~2
      // detents (on/off) on the device. Rescale such small-span, formatter-less
      // continuous faders to a smooth 0..100 DISPLAY range; the real CC->param
      // mapping is independent (it lives in the allocation's min/max/curve, and
      // the device always sends the full 0..127 CC). Params with a unit
      // formatter (dB/BPM/…) or an already-wide range keep their real range.
      if (
        c.type === 'fader' && !v.formatter &&
        typeof v.min === 'number' && typeof v.max === 'number' &&
        Math.abs(v.max - v.min) < 24
      ) {
        v.min = 0;
        v.max = 100;
      }
    }
    // Interactive controls (incl. pads) need an `inputs` pot binding; real
    // pads carry it too. Read-only meters/banner stay input-less (app→device).
    if (!c.readOnly && c.potId && !c.inputs) c.inputs = [{ potId: c.potId, valueId: 'value' }];
  }
  for (const g of groups) {
    if (!g.bounds) g.bounds = boundsForSlotRange(g.from, g.to);
    if (g.id === undefined) g.id = nextControlId(); // unique in the shared id space
    if (g.variant === undefined) g.variant = 'highlighted';
    if (g.color === undefined) g.color = 'FFFFFF';
  }

  const pages: ElectraPage[] = [
    { id: PAGE_CONTROL, name: 'CONTROL', defaultControlSetId: 1 },
    { id: PAGE_MIXMASTER, name: 'MIXMSTRS', defaultControlSetId: 1 },
    { id: PAGE_SYSTEM, name: 'SYSTEM', defaultControlSetId: 1 },
  ];
  const devices: ElectraDevice[] = [
    { id: DEVICE_CTRL, name: 'PT-CTRL', port: 2, channel: 1, rate: 33 },
    { id: DEVICE_PLAY, name: 'PT-PLAY', port: 1, channel: 1 },
  ];

  const preset: ElectraPreset = {
    version: 2,
    name: input.name ?? 'patchtogether',
    pages,
    devices,
    overlays,
    groups,
    controls,
  };

  return { preset, allocations };
}

// ──────────────────────────── emit ────────────────────────────

/**
 * Minify + 7-bit-ASCII-clamp the preset to the string uploaded at runtime
 * (F0 00 21 45 01 01 <json> F7). Any non-ASCII char in a name is stripped so the
 * SysEx data bytes stay 7-bit-clean (the device rejects high-bit bytes mid-SysEx).
 */
export function emitPresetJson(preset: ElectraPreset): string {
  const json = JSON.stringify(preset); // already compact (no spaces)
  // Replace any code point > 0x7E with '?' so the upload is 7-bit clean.
  let out = '';
  for (const ch of json) {
    const c = ch.codePointAt(0)!;
    out += c >= 0x20 && c <= 0x7e ? ch : '?';
  }
  return out;
}

// ──────────────────────────── helpers ────────────────────────────

function controlName(moduleLabel: string, paramLabel: string): string {
  // Keep names short — the device renders ~14 chars.
  const name = `${moduleLabel} ${paramLabel}`.trim();
  return name.length > 14 ? name.slice(0, 14) : name;
}

function discreteItems(def: GenParamDef): Array<{ value: number; label: string }> {
  const items: Array<{ value: number; label: string }> = [];
  const lo = Math.round(def.min);
  const hi = Math.round(def.max);
  for (let v = lo; v <= hi; v++) {
    items.push({ value: v, label: String(v) });
  }
  return items;
}
