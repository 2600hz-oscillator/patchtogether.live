// packages/web/src/lib/ui/modules/dx7-patch-actions.ts
//
// The DX7's two NON-PARAM controls — the PRESET/voice selector and the .syx
// cartridge import — as ONE shared implementation.
//
// Both are declared control families on the def (`dx7-preset-select`,
// `dx7-syx-input`) with no backing ParamDef: the loaded voice lives in
// `node.data.preset` and imported cartridges in `node.data.userPatches`, and
// the factory POLLS those (see dx7.ts) rather than exposing an engine API. The
// logic used to live inline in Dx7Card, which is why the RACKLINE ModuleShell
// could only render the two families as dead labels — there was nothing to
// call. Extracted here so the legacy card and the shell cell drive the
// IDENTICAL action/state (no second implementation to drift), per the P1
// batch-2 inert-cell fix.
//
// Reads take a node (pure projection — the caller owns reactivity, via
// `nodeVersion(id)` or a SyncedStore-tracked `$derived`); writes take a nodeId
// and mutate the live `patch` store.
//
// ==========================================================================
// THE VOICE EDIT BUFFER, AND WHY LOADING A PRESET IS A *STAMP*
// ==========================================================================
// Loading a voice used to be one write — `node.data.preset = name` — and the
// factory re-derived everything else from that name on its next poll. That is
// no longer enough, because the DX7 now has an EDIT BUFFER: the 78 operator
// values live in `node.data.voice`, and `algorithm` / `feedback` are real
// authoritative ParamDefs. Selecting a voice therefore has to move FIVE
// things at once:
//
//   data.preset    the ORIGIN voice name (a display label; the dirty chip
//                  compares the buffer against the voice of this name)
//   data.voice     the working edit buffer, DEEP-UNWRAPPED
//   data.opOn      the six per-operator mutes, reset to all-on
//   data.voiceRev  monotonic; the factory polls THIS, not the operator values
//   params.algorithm + params.feedback   the two authoritative params
//
// ALL FIVE IN ONE `mutateNode` TRANSACTION. Not tidiness — two things break
// if it is split. (1) UNDO: the UndoManager captures one entry per tracked
// TRANSACTION, so five writes would be five Cmd-Zs to get back, landing the
// rack in states that never existed (a BASS 1 label over an E.PIANO 1 buffer).
// (2) COLLAB: one transaction is one Y.Doc update, so a rack-mate applies the
// whole voice atomically instead of watching it arrive in pieces and briefly
// re-rendering against a half-loaded patch.
//
// ⚠ `deepUnwrapVoice` IS MANDATORY, NOT DEFENSIVE. A voice read out of
// `node.data.userPatches` is a Yjs PROXY whose `op.r` / `op.l` are Y.Array
// proxies. Writing one back into the Y.Doc as-is would try to re-integrate an
// already-integrated Y type ("Type already integrated"), and posting one to
// the worklet throws in `structuredClone` — which is the SHIPPED bug
// modules/dx7.ts:288-300 documents (every SYX-loaded voice silently failed to
// reach the engine while the plain-JS built-ins worked).
//
// The stamp helper lives HERE, not in `$lib/graph/mutate.ts`. The original
// reason was that `mutate.ts` sat in the collab-attest basis, so a dx7 helper
// parked in it forced a relay re-attest for a synth edit; that attest was
// deleted 2026-08-17 and the cost is gone. The placement stands on its own —
// this is dx7-specific patch surgery, not a general graph mutation — but it is
// no longer a hard constraint, so do not cite a re-attest to defend it.

import { patch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import { DX7_DEFAULT_PRESET } from '$lib/audio/modules/dx7';
import { DX7_BUILTIN_BANK, findBuiltinPatch } from '$lib/audio/dx7-banks';
import { deepUnwrapVoice, isDirty } from '$lib/audio/dx7-voice-edit';
import { parseSyxBank, type DX7Voice } from '$lib/audio/dx7-syx';
import type { ModuleNode } from '$lib/graph/types';
import type { SelectorOption } from '$lib/ui/controls';

/** Operators per voice. Six, forever — it is a DX7. */
export const DX7_OP_COUNT = 6;

/** The mark the dirty chip appends to the origin voice name. NOT part of
 *  `dx7PresetName` — see `dx7PresetChipLabel`. */
export const DX7_DIRTY_MARK = '✱';

/** The `.syx` file-picker accept string (shared by the card input + the shell
 *  cell), so both take exactly the same file set. */
export const DX7_SYX_ACCEPT = '.syx,application/octet-stream';

/** One voice roster entry: a factory patch or an imported cartridge voice. */
export interface Dx7PatchEntry {
  name: string;
  kind: 'builtin' | 'user';
}

/** Cartridge voices imported into THIS node (empty when none). Pure read. */
export function dx7UserPatches(node: ModuleNode | undefined): DX7Voice[] {
  const d = node?.data as Record<string, unknown> | undefined;
  return Array.isArray(d?.userPatches) ? (d.userPatches as DX7Voice[]) : [];
}

/** The currently loaded voice name (the def's default when unset). Pure read. */
export function dx7PresetName(node: ModuleNode | undefined): string {
  const d = node?.data as Record<string, unknown> | undefined;
  return typeof d?.preset === 'string' && d.preset.length > 0 ? d.preset : DX7_DEFAULT_PRESET;
}

/** The full voice roster: the nine factory-inspired built-ins, then every
 *  imported cartridge voice in load order. Pure read. */
export function dx7PatchRoster(node: ModuleNode | undefined): Dx7PatchEntry[] {
  return [
    ...DX7_BUILTIN_BANK.map((p) => ({ name: p.name, kind: 'builtin' as const })),
    ...dx7UserPatches(node).map((p) => ({ name: p.name, kind: 'user' as const })),
  ];
}

/** The roster as <Selector> options — an unnamed imported voice still gets a
 *  stable, distinguishable label so the dropdown is never blank. Pure read. */
export function dx7SelectorOptions(node: ModuleNode | undefined): SelectorOption<string>[] {
  return dx7PatchRoster(node).map((p, i) => ({
    value: p.name,
    label: p.name || `(unnamed ${i + 1})`,
    title: p.kind === 'builtin' ? 'built-in (factory-inspired)' : 'loaded SYX',
  }));
}

/**
 * Resolve a voice NAME against this node's roster: imported cartridge voices
 * first (they are what the user just loaded), then the built-in bank. Returns
 * the RAW entry, which for a user patch is a Yjs proxy — unwrap before use.
 * `undefined` when the name is in neither roster. Pure read.
 */
export function dx7FindVoice(node: ModuleNode | undefined, name: string): DX7Voice | undefined {
  return dx7UserPatches(node).find((p) => p?.name === name) ?? findBuiltinPatch(name);
}

/**
 * The ORIGIN voice the edit buffer was stamped from — the voice named by
 * `node.data.preset`, as plain JS. `undefined` when that name resolves to
 * nothing (a rack whose cartridge was removed). Pure read.
 */
export function dx7PresetVoice(node: ModuleNode | undefined): DX7Voice | undefined {
  const raw = dx7FindVoice(node, dx7PresetName(node));
  return raw === undefined ? undefined : deepUnwrapVoice(raw);
}

/**
 * THE EDIT BUFFER, as plain JS — the 78 operator values the panels edit.
 *
 * MIGRATION LIVES HERE (`data.voice ?? the origin preset`). Every rack saved
 * before this PR has a `data.preset` name and NO `data.voice`, so a reader
 * that took `data.voice` straight would hand the panels an undefined voice on
 * every existing rack. Resolving on READ — rather than migrating on write —
 * means a saved rack is never rewritten by merely being opened, so the
 * migration cannot corrupt anything. The buffer only reaches disk once the
 * user actually stamps a preset (below) or edits an operator (PR 6).
 *
 * Falls back to the def's default voice when the preset name resolves to
 * nothing, so this never returns undefined and a pitch row built on it can
 * never come up empty. Pure read.
 */
export function dx7EditVoice(node: ModuleNode | undefined): DX7Voice {
  const d = node?.data as Record<string, unknown> | undefined;
  const stored = d?.voice;
  if (stored != null && typeof stored === 'object') return deepUnwrapVoice(stored);
  return deepUnwrapVoice(dx7FindVoice(node, dx7PresetName(node)) ?? DX7_BUILTIN_BANK[0]);
}

/**
 * The six per-operator ON/OFF flags — EDIT-BUFFER ONLY, deliberately not part
 * of `DX7Voice`. SYX parameter 155 (`OPERATOR ON/OFF`) is a front-panel state
 * the DX7 does NOT store in a cartridge voice, so mirroring that keeps a
 * STORE-then-export round trip byte-faithful. Defaults to all-on, and a
 * malformed/short array is padded rather than truncating the panel. Pure read.
 */
export function dx7OpOn(node: ModuleNode | undefined): boolean[] {
  const d = node?.data as Record<string, unknown> | undefined;
  const raw = d?.opOn;
  const out: boolean[] = [];
  for (let i = 0; i < DX7_OP_COUNT; i++) {
    const v = Array.isArray(raw) ? raw[i] : undefined;
    out.push(v === undefined ? true : Boolean(v));
  }
  return out;
}

/**
 * The monotonic edit-buffer revision the factory polls. `0` when absent — a
 * legacy rack has no `voiceRev` at all, and the poll MUST tolerate that rather
 * than reading `undefined !== undefined` as a change on every tick. Pure read.
 */
export function dx7VoiceRev(node: ModuleNode | undefined): number {
  const d = node?.data as Record<string, unknown> | undefined;
  const v = d?.voiceRev;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Has the edit buffer diverged from the voice it was stamped from? Compares
 * the SOUND, not the bytes (see `isDirty` / `canonicalVoice` in
 * dx7-voice-edit.ts — a byte comparison lights the chip on every migrated rack
 * holding an aliased ratio). A node with no buffer at all is never dirty.
 * Pure read.
 */
export function dx7IsDirty(node: ModuleNode | undefined): boolean {
  const d = node?.data as Record<string, unknown> | undefined;
  if (d?.voice == null) return false; // nothing has been edited yet
  const origin = dx7PresetVoice(node);
  if (!origin) return false; // nothing to have diverged FROM
  return isDirty(dx7EditVoice(node), origin);
}

/**
 * The voice name WITH the dirty mark — `E.PIANO 1 ✱` — for the patch-safety
 * chip in the operator panel's header.
 *
 * ⚠ THIS IS A SEPARATE READER ON PURPOSE; DO NOT FOLD IT INTO
 * `dx7PresetName`. That reader backs `<select value={presetName}>` in
 * Dx7Card.svelte AND the shell's selector cell, and `e2e/tests/dx7.spec.ts`
 * asserts `toHaveValue('E.PIANO 1')`. A `<select>` whose bound value matches
 * no `<option>` renders BLANK, so appending the mark inside `dx7PresetName`
 * would silently empty the voice dropdown the moment anybody touched an
 * operator. Pure read.
 */
export function dx7PresetChipLabel(node: ModuleNode | undefined): string {
  const name = dx7PresetName(node);
  return dx7IsDirty(node) ? `${name} ${DX7_DIRTY_MARK}` : name;
}

/**
 * LOAD A VOICE — the STAMP. One `mutateNode` transaction writing three
 * `data` keys and two params (see the edit-buffer block at the top of this
 * file for why the atomicity is load-bearing for undo AND for collab).
 *
 * An unknown name is REFUSED rather than stamping the fallback voice under a
 * bogus label: a stamp is destructive (it replaces the edit buffer and resets
 * the mutes), so "the roster does not have that voice" must not silently mean
 * "load E.PIANO 1 and call it BASS 1". Same discipline as
 * `selectSixstrumPreset`.
 *
 * Re-selecting the CURRENTLY loaded name is a legitimate REVERT — it restamps
 * the pristine voice and bumps the rev — so it is deliberately not debounced.
 */
export function selectDx7Preset(nodeId: string, name: string): void {
  mutateNode(nodeId, (live) => {
    const raw = dx7FindVoice(live, name);
    if (raw === undefined) return; // unknown voice → no-op (see above)
    // MANDATORY unwrap: `raw` may be a Yjs proxy out of `data.userPatches`.
    const voice = deepUnwrapVoice(raw);
    if (!live.data) live.data = {};
    live.data.preset = name;
    live.data.voice = voice;
    live.data.opOn = Array.from({ length: DX7_OP_COUNT }, () => true);
    live.data.voiceRev = dx7VoiceRev(live) + 1;
    // The two AUTHORITATIVE params. The voice's own algorithm/feedback fields
    // are a STAMP SOURCE and are never read at send time — see the authority
    // split in modules/dx7.ts.
    live.params.algorithm = voice.algorithm;
    live.params.feedback = voice.feedback;
  });
}

/** What a cartridge import reported back to the user. */
export interface Dx7SyxLoadResult {
  /** Human status line ('loaded 32 voices (1 warnings)'), or null on failure. */
  status: string | null;
  /** Parse failure message, or null on success. */
  error: string | null;
}

/**
 * Import a .syx cartridge into this node: parse the bank, APPEND its voices to
 * `node.data.userPatches` (never replace — several cartridges stack) and
 * auto-select the first newly-loaded voice. A bad header byte or checksum
 * mismatch is REPORTED as a warning, not rejected (parseSyxBank's contract);
 * only a hard parse throw comes back as `error`.
 */
export async function loadDx7SyxFile(nodeId: string, file: File): Promise<Dx7SyxLoadResult> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = parseSyxBank(bytes);
    const t = patch.nodes[nodeId];
    if (!t) return { status: null, error: 'module is gone' };
    if (!t.data) t.data = {};
    // DEEP-UNWRAP THE EXISTING ROSTER BEFORE RE-ASSIGNING IT. `existing`'s
    // entries are already-integrated Yjs types (this node's data map owns
    // them), and spreading them into a fresh array and assigning it back asks
    // Yjs to integrate the same types a second time — the
    // [[yjs-save-load-real-ydoc]] "Type already integrated" trap, and it fires
    // only on the SECOND cartridge import, which is why nothing noticed.
    // Unwrapping is also the migration seam: a bank imported before
    // `coarse`/`fine` existed gains them here, strictly additively (`ratio`,
    // `detuneFactor` and `fixedHz` are carried across untouched), so this
    // cannot move a sample of audio.
    const existing = dx7UserPatches(t as ModuleNode).map((v) => deepUnwrapVoice(v));
    (t.data as Record<string, unknown>).userPatches = [...existing, ...result.voices];
    if (result.voices[0]) selectDx7Preset(nodeId, result.voices[0].name);
    const warn = result.warnings.length ? ` (${result.warnings.length} warnings)` : '';
    return { status: `loaded ${result.voices.length} voices${warn}`, error: null };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}
