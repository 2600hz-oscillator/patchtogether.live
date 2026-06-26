// packages/web/src/lib/docs/control-doc-resolver.ts
//
// Resolve a module's NUMBERED card-face legend (number → stable test id, from
// e2e/vrt/__annotated__/{type}.legend.json) to per-number AUTHORED content
// (friendly name + the `docs.controls` "what it does" blob). This is the bridge
// that turns the numbered visual key on the doc page into authored docs — NOT
// raw test ids.
//
// Pure + browser-safe (no fs / no registry import) so BOTH the prerendered doc
// page (+page.server.ts) and the docs-lint gate (module-docs-lint.test.ts) use
// the SAME mapping — the gate then enforces that every numbered control on a
// STRICT module resolves to authored prose.
//
// Three resolution paths, in order:
//   1. `control-<paramId>`            → docs.controls[paramId]      (a Knob/Fader)
//   2. `<prefix>-{id}-<i>`            → docs.controls['<prefix>-{n}'] with {n}
//                                        substituted   (a control FAMILY member)
//   3. anything else (a static button) → docs.controls[<test id minus {id}>]
//
// The runtime nodeId is normalized to the literal `{id}` by the generator, so
// keys are stable handles independent of which node instance was screenshotted.

import type { ModuleDocs } from '$lib/graph/types';

export interface LegendEntry {
  n: number;
  /** Stable test id with the runtime nodeId normalized to the literal `{id}`. */
  testid: string;
  kind: string;
  /** Member count when this is a COLLAPSED control family (one callout for a
   *  whole repeated grid); absent for an individual control. */
  count?: number;
}

export interface ResolvedControl {
  n: number;
  /** Friendly display name: ParamDef label / "Seq gate 3" / humanized key. */
  name: string;
  /** Authored "what it does" (family templates have {n} substituted); null if
   *  the control has no authored entry (the gate flags this for STRICT modules). */
  desc: string | null;
  kind: string;
  /** The `docs.controls` key this resolved through (for the lint's diagnostics). */
  key: string;
  resolved: boolean;
}

const ID = '{id}';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** docs.controls keys shaped like a control-family template `<prefix>-{n}`,
 *  longest-prefix first so an overlapping shorter prefix never wins. */
function familyPrefixes(docs?: ModuleDocs): string[] {
  const out: string[] = [];
  for (const k of Object.keys(docs?.controls ?? {})) {
    const m = k.match(/^(.+)-\{n\}$/);
    if (m) out.push(m[1]);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Strip the `{id}` segment out of a static-button test id → stable doc key.
 *  `sequencer-{id}-prev` → `sequencer-prev`; `quicksave-mode-save-{id}` →
 *  `quicksave-mode-save`; `sequencer-snh-toggle` (no id) → unchanged. */
export function staticKey(testid: string): string {
  return testid
    .split(`-${ID}-`).join('-')
    .split(`-${ID}`).join('')
    .split(`${ID}-`).join('')
    .split(ID).join('');
}

function humanize(key: string): string {
  const pretty = key.replace(/[-_]/g, ' ').trim();
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

/** Resolve a whole module legend at once (needs all entries together to derive
 *  each family's index base — card test ids may be 0- or 1-based). */
export function resolveLegend(
  entries: readonly LegendEntry[],
  ctx: { params?: readonly { id: string; label?: string }[]; docs?: ModuleDocs },
): ResolvedControl[] {
  const params = ctx.params ?? [];
  const controls = ctx.docs?.controls ?? {};
  const prefixes = familyPrefixes(ctx.docs);

  const famMatch = (testid: string): { prefix: string; idx: number } | null => {
    for (const p of prefixes) {
      const m = testid.match(new RegExp(`^${escapeRe(p)}-\\{id\\}-(\\d+)$`));
      if (m) return { prefix: p, idx: Number(m[1]) };
    }
    return null;
  };

  // Per-family minimum trailing index → display numbers always start at 1.
  const famMin = new Map<string, number>();
  for (const e of entries) {
    const fm = famMatch(e.testid);
    if (fm) famMin.set(fm.prefix, Math.min(famMin.get(fm.prefix) ?? Infinity, fm.idx));
  }

  return entries.map((e): ResolvedControl => {
    // 1) control-<paramId>
    if (e.testid.startsWith('control-')) {
      const pid = e.testid.slice('control-'.length);
      const param = params.find((p) => p.id === pid);
      const desc = controls[pid] ?? null;
      return { n: e.n, name: param?.label || humanize(pid), desc, kind: e.kind, key: pid, resolved: !!desc };
    }
    // 2) control family `<prefix>-{id}-<i>`
    const fm = famMatch(e.testid);
    if (fm) {
      const key = `${fm.prefix}-{n}`;
      const tmpl = controls[key];
      // COLLAPSED family (one callout for the whole grid): "Seq gate ×16",
      // generic blob (template's {n} → "N").
      if (e.count && e.count > 1) {
        const desc = tmpl ? tmpl.split('{n}').join('N') : null;
        return { n: e.n, name: `${humanize(fm.prefix)} ×${e.count}`, desc, kind: e.kind, key, resolved: !!desc };
      }
      const num = fm.idx - (famMin.get(fm.prefix) ?? 0) + 1;
      const desc = tmpl ? tmpl.split('{n}').join(String(num)) : null;
      return { n: e.n, name: `${humanize(fm.prefix)} ${num}`, desc, kind: e.kind, key, resolved: !!desc };
    }
    // 3) static button
    const key = staticKey(e.testid);
    const desc = controls[key] ?? null;
    return { n: e.n, name: humanize(key), desc, kind: e.kind, key, resolved: !!desc };
  });
}
