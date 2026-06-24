// packages/web/src/lib/docs/io-explain.ts
//
// PURE PortDef/ParamDef → human-readable explanation layer for the docs
// site's auto-generated Inputs & Outputs section (the (c) section of the
// per-module doc page; see .myrobots/plans/docs-overhaul-plan-2026-06-23.md
// §3c / §4b).
//
// Truth flows FROM the defs: every field on a PortDef / ParamDef maps to a
// fixed human sentence here, so the I/O section can NEVER drift from the live
// module spec (unlike a hand-written table). The doc-page template renders
// these strings; the drift gate (module-manifest.test.ts) asserts that EVERY
// declared port + param produces a non-empty explanation, so a new/renamed
// port that this module doesn't understand fails CI.
//
// Why a standalone PURE module (no Svelte, no registry import): it must be
// unit-testable in isolation AND callable from BOTH the doc-page build path
// (which feeds it regex-parsed manifest ports) and the registry-driven drift
// gate (which feeds it live PortDef/ParamDef objects). It therefore takes a
// MINIMAL structural shape — the subset of PortDef/ParamDef fields the
// explanations key off — not the full graph types, so either caller can
// satisfy it.

/** The cable types the explainer recognises. Mirrors graph/types CableType
 *  but kept as a loose string so a future registered cable type still maps
 *  (it falls through to the raw type name rather than throwing). */
export type ExplainCableType = string;

/** The PortDef subset io-explain reads. Both the regex-parsed manifest port
 *  and a live graph PortDef structurally satisfy this. */
export interface ExplainPort {
  id: string;
  type: ExplainCableType;
  /** When set, a `cv` input routes to this AudioParam — "modulates X". */
  paramTarget?: string;
  /** CV scaling mode (linear / log / discrete / passthrough). */
  cvScale?: { mode: 'linear' | 'log' | 'discrete' | 'passthrough'; depth?: number };
  /** Extra source cable types this INPUT also accepts. */
  accepts?: readonly ExplainCableType[];
  /** Declared gate/trigger consumer semantic. */
  edge?: 'trigger' | 'gate';
  /** OUTPUT-only: emitted type mirrors whatever is patched into this input id. */
  adoptsUpstreamFrom?: string;
}

/** The ParamDef subset io-explain reads. */
export interface ExplainParam {
  id: string;
  label: string;
  defaultValue: number | null;
  min: number | null;
  max: number | null;
  curve: 'linear' | 'log' | 'exp' | 'discrete' | string;
  units?: string;
}

/** Per-field human fragments, lifted from the module-io survey (§12 of the
 *  plan). Kept as small composable phrases so explainPort can assemble a
 *  full sentence from whichever fields a port declares. */

/** Plain-language name for each cable type. */
function cableTypeLabel(type: ExplainCableType): string {
  switch (type) {
    case 'audio':
      return 'audio signal';
    case 'cv':
      return 'control voltage (CV)';
    case 'pitch':
      return 'V/oct pitch CV';
    case 'gate':
      return 'gate / trigger';
    case 'modsignal':
      return 'modulation (CV / gate / audio)';
    case 'polyPitchGate':
      return 'poly pitch+gate bus';
    case 'keys':
      return 'mono still image (keys)';
    case 'image':
      return 'RGB still image';
    case 'mono-video':
      return 'mono video stream';
    case 'video':
      return 'RGB video stream';
    default:
      return type;
  }
}

/** Human text for the cvScale mode (how a -1..+1 CV maps onto the target). */
export function explainCvScale(mode: string): string {
  switch (mode) {
    case 'linear':
      return 'additive offset — ±1 CV sweeps the full range, centered on the knob';
    case 'log':
      return 'multiplicative ≈ octaves — ±1 CV spans the param’s log range';
    case 'discrete':
      return 'integer buckets — CV selects a discrete step';
    case 'passthrough':
      return 'summed directly (the destination DSP scales it)';
    default:
      return mode;
  }
}

/** Human text for the edge (trigger vs gate) semantic. */
export function explainEdge(edge: 'trigger' | 'gate'): string {
  return edge === 'trigger'
    ? 'trigger — fires once per rising edge'
    : 'gate — acts while the level is high (reacts to both edges)';
}

/**
 * Explain ONE input port — the full human sentence for the I/O table.
 *
 * `stereoPair` is the matching sibling port id when this port is a member of
 * the module's stereoPairs (resolved by the caller, which owns the def's
 * stereoPairs tuples). When the port is the LEFT side of a pair, we note the
 * auto-duplicate-to-R normaling behaviour.
 */
export function explainInputPort(
  port: ExplainPort,
  opts: { stereoPair?: string; stereoSide?: 'L' | 'R' } = {},
): string {
  const parts: string[] = [cableTypeLabel(port.type)];

  if (port.type === 'polyPitchGate') {
    parts.push('10-channel poly bus (5 pitch + 5 gate lanes)');
  }

  if (port.paramTarget) {
    const mode = port.cvScale?.mode ?? 'passthrough';
    parts.push(`modulates ${port.paramTarget} (${explainCvScale(mode)})`);
  }

  if (port.edge) {
    parts.push(explainEdge(port.edge));
  }

  if (port.accepts && port.accepts.length > 0) {
    parts.push(`also accepts: ${port.accepts.map(cableTypeLabel).join(', ')}`);
  }

  if (opts.stereoPair) {
    if (opts.stereoSide === 'L') {
      parts.push(`L/R stereo pair with ${opts.stereoPair} — L-only auto-duplicates to R`);
    } else {
      parts.push(`L/R stereo pair with ${opts.stereoPair}`);
    }
  }

  return parts.join('; ');
}

/**
 * Explain ONE output port. Outputs carry fewer fields (no paramTarget, no
 * cvScale on the read side), but an `adoptsUpstreamFrom` makes the emitted
 * type transparent, and a polyPitchGate / stereo-pair output is worth noting.
 */
export function explainOutputPort(
  port: ExplainPort,
  opts: { stereoPair?: string } = {},
): string {
  const parts: string[] = [cableTypeLabel(port.type)];

  if (port.type === 'polyPitchGate') {
    parts.push('10-channel poly bus (5 pitch + 5 gate lanes)');
  }

  if (port.adoptsUpstreamFrom) {
    parts.push(`type mirrors whatever is patched into ${port.adoptsUpstreamFrom}`);
  }

  if (port.edge) {
    parts.push(explainEdge(port.edge));
  }

  if (opts.stereoPair) {
    parts.push(`L/R stereo pair with ${opts.stereoPair}`);
  }

  return parts.join('; ');
}

/**
 * Direction-agnostic entry point used by the drift gate: produces a non-empty
 * explanation for ANY port (input or output). The doc-page template calls the
 * direction-specific helpers above so it can render the stereo normaling note
 * only on inputs; the gate just needs "every port explains to something".
 */
export function explainPort(
  port: ExplainPort,
  direction: 'input' | 'output',
  opts: { stereoPair?: string; stereoSide?: 'L' | 'R' } = {},
): string {
  return direction === 'input' ? explainInputPort(port, opts) : explainOutputPort(port, opts);
}

/** Format a param's numeric range + units for the table (e.g. "0.001..10 s"). */
export function explainParamRange(param: ExplainParam): string {
  const lo = param.min ?? '?';
  const hi = param.max ?? '?';
  const u = param.units ? ` ${param.units}` : '';
  return `${lo}..${hi}${u}`;
}

/** Human text for the knob curve. */
export function explainCurve(curve: string): string {
  switch (curve) {
    case 'linear':
      return 'linear';
    case 'log':
      return 'logarithmic';
    case 'exp':
      return 'exponential';
    case 'discrete':
      return 'stepped';
    default:
      return curve;
  }
}

/**
 * Explain ONE param — a one-line summary for the I/O / params table.
 * Always non-empty (label + range + curve), so the drift gate's "every param
 * explained" assertion can never false-negative on a well-formed ParamDef.
 */
export function explainParam(param: ExplainParam): string {
  const range = explainParamRange(param);
  const def = param.defaultValue ?? '—';
  return `${param.label}: ${range} (${explainCurve(param.curve)}), default ${def}`;
}
