// packages/web/src/lib/devices/device-descriptor.ts
//
// DEVICE DESCRIPTOR — a declarative description of an external MIDI device's
// control surface. DATA, not code: adding a second device must not require a
// second module, a second card, or a second contract-lock entry.
//
// ─────────────────────────── SERIALIZABLE, ALWAYS ───────────────────────────
//
// Every field here is JSON. No closures, no class instances, no functions.
// This is a hard rule with a specific history behind it: norns' device
// descriptors embed Lua formatter functions, which makes them impossible to
// ship over a wire, diff in review, import from another project's data, or
// validate without executing them. The moment ONE field is a function the whole
// structure stops being data.
//
// So where behaviour is genuinely per-control, it is named rather than
// embedded: `format` is a tag from a CLOSED vocabulary that the UI layer
// resolves to a renderer. Adding a device cannot add a formatter; adding a
// formatter is a deliberate, reviewable widening of `DeviceFormatSpec`.
//
// The same rule is why `ParamDef.format` is NOT used for device controls even
// though it exists — it is typed `(v: number) => string`, i.e. exactly the
// unserializable thing this file refuses.
//
// ─────────────────── SHAPED FOR IMPORT, NOT JUST FOR US ───────────────────
//
// `pencilresearch/midi` carries 419 device definitions across 124 manufacturers
// (CC-BY-SA-4.0) with `cc_msb`/`cc_lsb`, min/max/default, `section`, and a
// `usage` field that expresses enum-as-value-RANGE (`0-31: 16'; 32-63: 8'`).
// Nothing here is being imported yet — that is explicitly out of scope — but
// the shapes are chosen so an importer would be a mapping rather than a
// redesign. In particular `ranges` is a value-RANGE list, not a value list,
// because that is what real device documentation actually specifies.
//
// ────────────────────────── WHAT A DESCRIPTOR IS NOT ──────────────────────────
//
// It is not a claim that the app knows the device's state. `readBack` records
// whether the device can report anything at all, and for every device surveyed
// so far the answer is `'none'`. A descriptor describes what we can SAY, never
// what we can HEAR.

/** How a control behaves, which decides how it may be surfaced. */
export type DeviceControlRole =
  /** A continuous parameter. Safe to automate. */
  | 'continuous'
  /** A selector whose value RANGES name discrete states. Safe to automate. */
  | 'enum'
  /**
   * A momentary command — tap tempo, transport, a destructive menu entry.
   *
   * ⚠ An action is deliberately NOT eligible for an automatable slot. A slot is
   * backed by a real ParamDef, and a ParamDef write goes through `setNodeParam`,
   * which is UNDOABLE — so Cmd-Z would re-transmit the CC and re-fire the
   * action. For a continuous parameter that is merely redundant (it restores a
   * value); for CAPTURE-record or "enter calibration menu" it re-triggers a
   * destructive physical operation the user just undid. Actions are therefore
   * card-only immediate sends, which write no param and enter no undo stack.
   */
  | 'action';

/**
 * Named value-readout specs. CLOSED vocabulary — the UI resolves a tag to a
 * renderer, so a descriptor can never smuggle in code.
 */
export type DeviceFormatSpec =
  /** Print the raw 0..127 controller value. */
  | 'raw7'
  /** Print the raw 0..16383 controller value. */
  | 'raw14'
  /** Print as a percentage of full scale. */
  | 'percent'
  /** Print the enclosing `ranges` entry's label. */
  | 'enum'
  /**
   * Print the raw value AND mark it as device-quantized.
   *
   * For a control the hardware snaps to musical subdivisions where the
   * value→subdivision table is NOT PUBLISHED. Rendering such a control as a
   * smooth 0..127 knob is a lie the user can hear: the readout glides while the
   * sound steps. Until the table is measured on hardware, the honest display is
   * the raw value plus an explicit "the pedal snaps this" marker.
   */
  | 'stepped-unmeasured';

/** Where a control's numbers came from. Provenance is per-control because a
 *  single device's map is often part vendor-documented and part reverse
 *  engineered, and those deserve different levels of trust. */
export type DeviceProvenance =
  /** Transcribed from the manufacturer's own published documentation. */
  | 'manual'
  /** Community-reported; plausible but unverified against a vendor source. */
  | 'community'
  /** Measured against physical hardware by us. */
  | 'measured';

/** One named span of controller values, the shape real device docs use. */
export interface DeviceEnumRange {
  label: string;
  /** Inclusive lower bound. */
  from: number;
  /** Inclusive upper bound. */
  to: number;
}

/** A device-side quantization the app cannot switch off. */
export interface DeviceQuantization {
  kind: 'tempo-subdivision';
  /** `'unmeasured'` = we know it snaps but not to what. Never guess a table. */
  table: 'unmeasured';
  /** What is known, and what still needs measuring. */
  note: string;
}

/** One addressable control on the device. */
export interface DeviceControl {
  /** Stable id, unique within the descriptor. */
  id: string;
  /** Display label. */
  label: string;
  /** Grouping for the card, mirroring the device's own documentation sections. */
  group: string;
  role: DeviceControlRole;
  /** Controller number. For `resolution: 14` this is the MSB; the LSB is
   *  implicitly `cc + 32` (see CC14_LSB_OFFSET). */
  cc: number;
  resolution: 7 | 14;
  /** Value the app assumes on spawn. NOT a claim about the hardware's state. */
  default: number;
  format: DeviceFormatSpec;
  /** Present iff `role === 'enum'`. */
  ranges?: readonly DeviceEnumRange[];
  /** Present when the device quantizes this control internally. */
  quantize?: DeviceQuantization;
  /** One-line behavioural note, surfaced in the card and the module docs. */
  doc: string;
  source: DeviceProvenance;
}

/** Whether the device can report its own state back to us. */
export type DeviceReadBack = 'none' | 'partial' | 'full';

/** A complete external device description. */
export interface DeviceDescriptor {
  /** Stable descriptor id, e.g. 'hologram-chroma-console'. */
  id: string;
  manufacturer: string;
  name: string;
  /**
   * Substrings to match against `MIDIOutput.name` for auto-detect, best first.
   *
   * ⚠ A HINT, never a requirement. Port names differ across OS, driver and
   * hub, and a device behind a generic USB-MIDI interface reports the
   * interface's name, not its own. Auto-detect that cannot be overridden by
   * hand is a device that is simply unusable for some users, so the manual
   * picker is the primary path and this only pre-selects.
   */
  portHints: readonly string[];
  /** 1-based MIDI channel the device listens on by default. */
  defaultChannel: number;
  readBack: DeviceReadBack;
  controls: readonly DeviceControl[];
  /**
   * Control ids to pre-load into the module's automatable slots, in order.
   * Length must not exceed the module's slot count.
   */
  defaultSlots: readonly string[];
  /** Program-change range, when the device recalls presets that way. */
  programChange?: { readonly count: number; readonly note: string };
  /** Anything a user or a future maintainer needs to know. */
  notes?: readonly string[];
}

// ───────────────────────────── pure helpers ─────────────────────────────

/** Look up a control by id. */
export function controlById(
  descriptor: DeviceDescriptor,
  id: string | undefined,
): DeviceControl | undefined {
  if (!id) return undefined;
  return descriptor.controls.find((c) => c.id === id);
}

/** Full-scale value for a control's resolution. */
export function controlMax(control: DeviceControl): number {
  return control.resolution === 14 ? 16383 : 127;
}

/** The enum range containing `value`, if any. */
export function enumRangeAt(
  control: DeviceControl,
  value: number,
): DeviceEnumRange | undefined {
  return control.ranges?.find((r) => value >= r.from && value <= r.to);
}

/**
 * The controller value that best represents an enum range — its midpoint.
 *
 * Midpoint rather than `from`, deliberately: a device whose documented
 * boundaries are off by one (or whose firmware rounds differently than its
 * manual) still lands solidly inside the intended state, whereas a boundary
 * value can fall into the neighbouring one.
 */
export function enumRangeValue(range: DeviceEnumRange): number {
  return Math.round((range.from + range.to) / 2);
}

/**
 * Render a control's value using its declared format spec.
 *
 * This is where a named tag becomes text. It is a FUNCTION taking the tag, not
 * a function stored ON the descriptor — which is the entire serializability
 * argument in one line.
 */
export function formatControlValue(control: DeviceControl, value: number): string {
  switch (control.format) {
    case 'percent':
      return `${Math.round((value / controlMax(control)) * 100)}%`;
    case 'enum': {
      const range = enumRangeAt(control, value);
      return range ? range.label : String(Math.round(value));
    }
    case 'stepped-unmeasured':
      // The bullet is not decoration — it is the only signal the user gets that
      // the number they are reading is not the number the pedal is using.
      return `${Math.round(value)} ·snap`;
    case 'raw14':
    case 'raw7':
    default:
      return String(Math.round(value));
  }
}

/** A slot's resolved state. */
export interface ResolvedSlot {
  /** The module ParamDef id backing this slot (`slot1`…). */
  slotId: string;
  /** The assigned control id, if any. */
  controlId: string | undefined;
  /** The resolved control, if the id exists in the descriptor. */
  control: DeviceControl | undefined;
  /**
   * True when an id IS assigned but does NOT resolve — a descriptor changed
   * under a saved patch.
   *
   * This must be loud rather than silent. A stale slot that quietly behaved
   * like an empty one would leave a lane in a saved rack that transmits
   * nothing, with automation still writing to it and no indication anywhere
   * that the link is broken. Reported, never swallowed.
   */
  stale: boolean;
}

/**
 * Resolve every slot against the descriptor and the saved assignment.
 *
 * `assign` is the persisted `node.data` map (slotId → controlId). Missing keys
 * fall back to `descriptor.defaultSlots` by position, so a freshly spawned
 * module is useful immediately and an explicitly-cleared slot stays cleared.
 */
export function resolveSlots(
  descriptor: DeviceDescriptor,
  slotIds: readonly string[],
  assign: Readonly<Record<string, string>> | undefined,
): ResolvedSlot[] {
  return slotIds.map((slotId, index) => {
    const assigned = assign && slotId in assign ? assign[slotId] : descriptor.defaultSlots[index];
    const controlId = assigned === '' ? undefined : assigned;
    const control = controlById(descriptor, controlId);
    return {
      slotId,
      controlId,
      control,
      stale: controlId !== undefined && control === undefined,
    };
  });
}

/** Controls eligible to occupy an automatable slot. See `DeviceControlRole`. */
export function slottableControls(descriptor: DeviceDescriptor): DeviceControl[] {
  return descriptor.controls.filter((c) => c.role !== 'action');
}

/** Controls that are card-only immediate commands. */
export function actionControls(descriptor: DeviceDescriptor): DeviceControl[] {
  return descriptor.controls.filter((c) => c.role === 'action');
}

/**
 * Pick the best output port for a descriptor from a list of port names.
 * Returns the index into `ports`, or -1 when nothing matches.
 *
 * Case-insensitive substring match against `portHints`, earliest hint wins.
 * Deliberately conservative: a wrong auto-selection silently sends a pedal's
 * CCs to somebody's synth, which is worse than selecting nothing.
 */
export function matchPortByHint(
  descriptor: DeviceDescriptor,
  ports: readonly { id: string; name?: string | null }[],
): number {
  for (const hint of descriptor.portHints) {
    const needle = hint.toLowerCase();
    const index = ports.findIndex((p) => (p.name ?? '').toLowerCase().includes(needle));
    if (index >= 0) return index;
  }
  return -1;
}

// ───────────────────────── descriptor validation ─────────────────────────

/**
 * Structural problems with a descriptor, as human-readable lines.
 *
 * DENY BY DEFAULT: the unit gate asserts this returns `[]` for every registered
 * descriptor, so a malformed one cannot ship. The checks are the ones that
 * would otherwise fail silently at runtime — a duplicate CC quietly making two
 * controls fight over one parameter, an enum with no ranges rendering as a bare
 * number, a `defaultSlots` entry naming a control that does not exist.
 */
export function validateDescriptor(descriptor: DeviceDescriptor): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenCcs = new Map<number, string>();

  if (descriptor.defaultChannel < 1 || descriptor.defaultChannel > 16) {
    problems.push(`defaultChannel ${descriptor.defaultChannel} is outside 1..16`);
  }

  for (const c of descriptor.controls) {
    if (seenIds.has(c.id)) problems.push(`duplicate control id '${c.id}'`);
    seenIds.add(c.id);

    if (c.cc < 0 || c.cc > 127) problems.push(`${c.id}: CC ${c.cc} is outside 0..127`);

    const clash = seenCcs.get(c.cc);
    if (clash) problems.push(`${c.id} and ${clash} both use CC ${c.cc}`);
    seenCcs.set(c.cc, c.id);

    if (c.resolution === 14) {
      if (c.cc > 31) {
        problems.push(
          `${c.id}: CC ${c.cc} cannot be 14-bit (its LSB at ${c.cc + 32} is a defined function)`,
        );
      }
      const lsb = c.cc + 32;
      const lsbClash = descriptor.controls.find((o) => o !== c && o.cc === lsb);
      if (lsbClash) {
        problems.push(`${c.id}: its 14-bit LSB (CC ${lsb}) collides with ${lsbClash.id}`);
      }
    }

    if (c.default < 0 || c.default > controlMax(c)) {
      problems.push(`${c.id}: default ${c.default} is outside 0..${controlMax(c)}`);
    }

    if (c.role === 'enum') {
      if (!c.ranges || c.ranges.length === 0) {
        problems.push(`${c.id}: role 'enum' but no ranges declared`);
      } else {
        for (const r of c.ranges) {
          if (r.from > r.to) problems.push(`${c.id}: range '${r.label}' has from > to`);
          if (r.from < 0 || r.to > controlMax(c)) {
            problems.push(`${c.id}: range '${r.label}' escapes 0..${controlMax(c)}`);
          }
        }
        // Overlaps would make the readout ambiguous — enumRangeAt returns the
        // first match and the user would see a label that is only half true.
        const sorted = [...c.ranges].sort((a, b) => a.from - b.from);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i]!.from <= sorted[i - 1]!.to) {
            problems.push(
              `${c.id}: ranges '${sorted[i - 1]!.label}' and '${sorted[i]!.label}' overlap`,
            );
          }
        }
        // A default that lands in no range renders as a bare number on a
        // control whose whole point is that its numbers have names — the one
        // state the user is guaranteed to see first would be the unlabelled
        // one.
        if (!enumRangeAt(c, c.default)) {
          problems.push(`${c.id}: default ${c.default} falls in no declared range`);
        }
      }
    } else if (c.ranges) {
      problems.push(`${c.id}: ranges declared but role is '${c.role}', not 'enum'`);
    }

    if (c.format === 'enum' && c.role !== 'enum') {
      problems.push(`${c.id}: format 'enum' requires role 'enum'`);
    }
    if (c.quantize && c.format !== 'stepped-unmeasured') {
      problems.push(
        `${c.id}: declares device quantization but formats as '${c.format}' — a quantized ` +
          `control rendered as a smooth value disagrees with what the user hears`,
      );
    }
    if (!c.doc.trim()) problems.push(`${c.id}: empty doc`);
  }

  for (const slotControlId of descriptor.defaultSlots) {
    const control = controlById(descriptor, slotControlId);
    if (!control) {
      problems.push(`defaultSlots names '${slotControlId}', which is not a control`);
    } else if (control.role === 'action') {
      problems.push(
        `defaultSlots names '${slotControlId}', an ACTION — actions are not slottable ` +
          `(an undo would re-fire them)`,
      );
    }
  }
  if (new Set(descriptor.defaultSlots).size !== descriptor.defaultSlots.length) {
    problems.push('defaultSlots contains duplicates');
  }

  if (descriptor.portHints.length === 0) problems.push('no portHints declared');

  return problems;
}
