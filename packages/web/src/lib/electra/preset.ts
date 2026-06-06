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
    // Control set 1: 4× channel fader + 4× send1 + 4× send2 (12).
    // Control set 2: 4× EQ-low + 4× EQ-mid + 4× EQ-hi (12).
    // Control set 3: 4× comp macro + master + a meter row (read-only vfaders).
    // (The exact 29 writable controls; meters fill the rest as read-only.)
    let s = 0;
    const pushMix = (paramId: string, label: string, min: number, max: number, curve: KnobCurve, units?: string) => {
      const csId = Math.floor(s / POTS_PER_SET) + 1;
      const potId = (s % POTS_PER_SET) + 1;
      const cc = alloc.nextCc();
      const def: GenParamDef = { id: paramId, label, min, max, defaultValue: 0, curve, units };
      controls.push({
        id: nextControlId(),
        pageId: PAGE_MIXMASTER,
        controlSetId: csId,
        potId,
        type: 'fader',
        name: label,
        inputs: [{ potId, valueId: 'value' }],
        values: [{
          message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: cc, min: 0, max: 127 },
          min, max, formatter: formatterFor(def),
        }],
      });
      allocations.push({
        key: `${mx}:${paramId}`,
        pageId: PAGE_MIXMASTER, controlSetId: csId, potId,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: cc,
        min, max, curve, role: 'rw',
      });
      s++;
    };
    // CS1 — faders + sends.
    for (const ch of [1, 2, 3, 4]) pushMix(`ch${ch}_volume`, `Ch${ch}`, 0, 1, 'linear');
    for (const ch of [1, 2, 3, 4]) pushMix(`ch${ch}_send1`, `S1.${ch}`, 0, 1, 'linear');
    for (const ch of [1, 2, 3, 4]) pushMix(`ch${ch}_send2`, `S2.${ch}`, 0, 1, 'linear');
    // CS2 — EQ.
    for (const ch of [1, 2, 3, 4]) pushMix(`ch${ch}_low`, `Lo${ch}`, -12, 12, 'linear', 'dB');
    for (const ch of [1, 2, 3, 4]) pushMix(`ch${ch}_mid`, `Md${ch}`, -12, 12, 'linear', 'dB');
    for (const ch of [1, 2, 3, 4]) pushMix(`ch${ch}_high`, `Hi${ch}`, -12, 12, 'linear', 'dB');
    // CS3 — comp macros + master.
    for (const ch of [1, 2, 3, 4]) pushMix(`comp${ch}`, `Cmp${ch}`, 0, 1, 'linear');
    pushMix('master_volume', 'Master', 0, 1, 'linear');

    // Meter row — per-channel + master read-only VU vfaders (app→device only).
    // These occupy the remaining CS3 slots; inbound CC is NOT routed to a param.
    const meterKeys: Array<{ key: string; label: string }> = [
      { key: `${mx}:meter:1`, label: 'VU1' },
      { key: `${mx}:meter:2`, label: 'VU2' },
      { key: `${mx}:meter:3`, label: 'VU3' },
      { key: `${mx}:meter:4`, label: 'VU4' },
      { key: `${mx}:meter:master`, label: 'VUM' },
    ];
    for (const m of meterKeys) {
      const csId = Math.floor(s / POTS_PER_SET) + 1;
      const potId = (s % POTS_PER_SET) + 1;
      const meterCc = alloc.nextCc();
      controls.push({
        id: nextControlId(),
        pageId: PAGE_MIXMASTER,
        controlSetId: csId,
        potId,
        type: 'vfader',
        variant: 'thin',
        readOnly: true,
        name: m.label,
        values: [{
          message: { deviceId: DEVICE_CTRL, type: 'cc7', parameterNumber: meterCc, min: 0, max: 127 },
          // dBFS readout for the VU; the bar fill animates off the same CC. The
          // app streams an already-dBFS-mapped meter CC (ampToMeterCc), so the
          // formatter just reverses that linear -60..0 dB map for the display.
          formatter: 'fmtMeterDb',
        }],
      });
      allocations.push({
        key: m.key,
        pageId: PAGE_MIXMASTER, controlSetId: csId, potId,
        deviceId: DEVICE_CTRL, messageType: 'cc7', number: meterCc,
        role: 'meter',
      });
      s++;
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
