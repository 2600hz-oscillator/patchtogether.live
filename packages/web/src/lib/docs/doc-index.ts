// packages/web/src/lib/docs/doc-index.ts
//
// buildDocIndex(mod) — a FLAT, client-resolvable doc payload for the
// interactive "virtual module" doc page (the LEFT live card / RIGHT hover-pane
// redesign that replaces the numbered face as the PRIMARY view; the static face
// stays only as the no-JS/prerender fallback).
//
// WHY a separate flat index (vs. just shipping `mod.docs`):
//   - The hover action resolves a HOVERED element to a controlKey or a portId,
//     then needs an O(1) lookup of name / cable type / range / authored desc.
//     `mod.docs` is keyed by raw control/port ids but carries NO cable type,
//     NO numeric range, and NO param→CV dual link — those live on the def's
//     params / io / inputs. This module fuses all three (mod.docs + io-explain
//     + control-doc-resolver) into ONE map the client can index by key.
//   - It is PRERENDER-SAFE: derived purely from the regex-parsed ManifestModule
//     (no live-registry import, no fs, no Svelte), so +page.server.ts can return
//     it for the prerendered HTML, and the client reads it as plain data.
//
// THE CV→PARAM DUAL LINK (the whole point of the prototype on adsr): an INPUT
// with `paramTarget` (e.g. adsr `attack` cv → the `attack` param) carries the
// TARGET param's friendly name + authored control desc, so the pane can render
// "modulates Attack — {how the Attack fader behaves}" when you hover the CV
// jack. Both the faceplate control AND its CV jack therefore explain to the
// same authored prose, from two surfaces.

import type { ManifestModule, ManifestPort, ManifestParam } from './module-manifest';
import { explainInputPort, explainOutputPort, explainParamRange } from './io-explain';

/** One faceplate control entry (a knob / fader / family member / button). */
export interface DocControlEntry {
  /** Lookup key — the param id (`attack`) or a control key (`seq-gate-{n}`). */
  key: string;
  /** Friendly display name (ParamDef label, else humanized key). */
  name: string;
  /** Authored "what it does" prose, or null when undocumented. */
  desc: string | null;
  /** Coarse kind for the pane (param control vs. dynamic family). */
  kind: 'param' | 'family' | 'button';
  /** Numeric range string (e.g. "0.001..10 s"), present for real params. */
  range?: string;
  /** The param's default value, when this resolves to a real ParamDef. */
  defaultValue?: number | null;
}

/** One patch port entry (input or output). */
export interface DocPortEntry {
  /** The PortDef id (`gate`, `attack`, `env_inv`). */
  id: string;
  /** Friendly display name (humanized id). */
  name: string;
  /** Authored per-port prose, or null when undocumented. */
  desc: string | null;
  /** Cable type (`gate`, `cv`, `audio`, …). */
  cable: string;
  /** Auto-generated io-explain sentence (the GENERATED reference tier). */
  explain: string;
  /** For a CV INPUT routed to an AudioParam: the dual context to its control. */
  paramTarget?: {
    /** The target param id. */
    id: string;
    /** Friendly name of the target control. */
    name: string;
    /** Authored desc of the target control (so the pane shows what it shapes). */
    desc: string | null;
  };
}

export interface DocIndex {
  /** Module behavioral overview (the pane's empty / default state). */
  explanation: string | null;
  /** Faceplate controls, keyed by param id / control key. */
  controls: Record<string, DocControlEntry>;
  /** Patch INPUTS, keyed by port id. */
  inputs: Record<string, DocPortEntry>;
  /** Patch OUTPUTS, keyed by port id. */
  outputs: Record<string, DocPortEntry>;
}

/** Humanize a raw id for display (dashes/underscores → spaces, Title-cased,
 *  `-{n}` template marker preserved as " {n}"). Mirrors the +page.svelte
 *  `controlName` humanizer so the pane matches the legacy table. */
function humanize(key: string): string {
  const pretty = key
    .replace(/-\{n\}$/, ' {n}')
    .replace(/[-_]/g, ' ')
    .trim();
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

/** Friendly name for a control key: a real param uses its ParamDef label;
 *  anything else (a family template, a button key) is humanized. */
function controlName(key: string, params: readonly ManifestParam[]): string {
  const param = params.find((p) => p.id === key);
  if (param) return param.label;
  return humanize(key);
}

/** Coarse kind for a control key. */
function controlKind(key: string, params: readonly ManifestParam[]): DocControlEntry['kind'] {
  if (params.some((p) => p.id === key)) return 'param';
  if (/-\{n\}$/.test(key)) return 'family';
  return 'button';
}

/** Build one DocControlEntry from a `docs.controls` key + its def context. */
function buildControlEntry(
  key: string,
  desc: string | null,
  params: readonly ManifestParam[],
): DocControlEntry {
  const param = params.find((p) => p.id === key);
  const entry: DocControlEntry = {
    key,
    name: controlName(key, params),
    desc,
    kind: controlKind(key, params),
  };
  if (param) {
    entry.range = explainParamRange(param);
    entry.defaultValue = param.defaultValue;
  }
  return entry;
}

/** Resolve the stereo-pair sibling of a port id (the manifest carries the
 *  tuples on `stereoPairs`, shared across inputs + outputs). */
function stereoPairOf(
  portId: string,
  pairs: ManifestModule['stereoPairs'],
): { sibling: string; side: 'L' | 'R' } | undefined {
  for (const [l, r] of pairs ?? []) {
    if (l === portId) return { sibling: r, side: 'L' };
    if (r === portId) return { sibling: l, side: 'R' };
  }
  return undefined;
}

/**
 * Build the flat, client-resolvable doc index for ONE module.
 *
 * Pure + prerender-safe: consumes only the ManifestModule (regex-parsed +
 * MODULE_DOCS-merged by buildModuleManifest) plus the pure io-explain layer.
 */
export function buildDocIndex(mod: ManifestModule): DocIndex {
  const params = mod.params;
  const docControls = mod.docs?.controls ?? {};
  const docInputs = mod.docs?.inputs ?? {};
  const docOutputs = mod.docs?.outputs ?? {};

  // --- Controls: union of authored control keys + every real param ----------
  // A param always gets an entry (so a hover on a faceplate control with no
  // authored prose still shows name + range); an authored-only key (a family
  // template, a button) also gets one.
  const controls: Record<string, DocControlEntry> = {};
  for (const p of params) {
    controls[p.id] = buildControlEntry(p.id, docControls[p.id] ?? null, params);
  }
  for (const [key, desc] of Object.entries(docControls)) {
    if (controls[key]) {
      controls[key].desc = desc; // already added as a param; attach prose
    } else {
      controls[key] = buildControlEntry(key, desc, params);
    }
  }

  // --- Inputs ---------------------------------------------------------------
  const inputs: Record<string, DocPortEntry> = {};
  for (const port of mod.inputs) {
    const pair = stereoPairOf(port.id, mod.stereoPairs);
    const explain = explainInputPort(port as ManifestPort, {
      stereoPair: pair?.sibling,
      stereoSide: pair?.side,
    });
    const entry: DocPortEntry = {
      id: port.id,
      name: humanize(port.id),
      desc: docInputs[port.id] ?? null,
      cable: port.type,
      explain,
    };
    // CV → param DUAL link: carry the target control's name + authored desc so
    // the pane can render "modulates {param} — {param desc}".
    if (port.paramTarget) {
      const target = controls[port.paramTarget];
      entry.paramTarget = {
        id: port.paramTarget,
        name: target?.name ?? controlName(port.paramTarget, params),
        desc: target?.desc ?? docControls[port.paramTarget] ?? null,
      };
    }
    inputs[port.id] = entry;
  }

  // --- Outputs --------------------------------------------------------------
  const outputs: Record<string, DocPortEntry> = {};
  for (const port of mod.outputs) {
    const pair = stereoPairOf(port.id, mod.stereoPairs);
    outputs[port.id] = {
      id: port.id,
      name: humanize(port.id),
      desc: docOutputs[port.id] ?? null,
      cable: port.type,
      explain: explainOutputPort(port as ManifestPort, { stereoPair: pair?.sibling }),
    };
  }

  return {
    explanation: mod.docs?.explanation ?? null,
    controls,
    inputs,
    outputs,
  };
}
