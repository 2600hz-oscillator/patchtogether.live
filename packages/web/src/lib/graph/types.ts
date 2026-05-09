// packages/web/src/lib/graph/types.ts
//
// Patch graph data model. Per D8 the patch graph lives in a Yjs doc accessed
// through SyncedStore. Per D18 the type system is registry-based, not closed,
// so future visual modules can register new domains and cable types without
// touching this file's union members.

// ---------------- Domain (D18) ----------------
// Phase 1 ships 'audio'. The video-domain spike (Phase 0 of the visual
// modules MVP) adds 'video' alongside; future domains (e.g. MIDI, OSC)
// follow the same pattern. The `(string & {})` open union preserves
// autocomplete on the well-known set while leaving the door open for
// runtime-registered domains.
type StandardDomain = 'audio' | 'video';
export type Domain = StandardDomain | (string & {});

// ---------------- Cable types (D6, D7, D18) ----------------
// `polyPitchGate` is the Stage-1 polyphony cable (10 audio channels packed
// (p0,g0,p1,g1,...,p4,g4) — 5 voice pairs). See packages/web/src/lib/audio/poly.ts
// and .myrobots/plans/dx7-and-polyphony.md §5 for the architecture.
//
// Video-domain cable types (Phase 0):
//   keys       — single-channel still mono image (no time axis)
//   image      — RGB still image (no time axis)
//   mono-video — single-channel animated video stream
//   video      — RGB animated video stream
// Implicit upcasting `keys → mono-video`, `image → video`, `keys → image`
// is allowed; the upcast is free at the shader layer. See `canConnect`.
type StandardCableType =
  | 'audio'
  | 'pitch'
  | 'gate'
  | 'cv'
  | 'polyPitchGate'
  | 'keys'
  | 'image'
  | 'mono-video'
  | 'video';
export type CableType = StandardCableType | (string & {});

/** True if `type` is one of the four video-domain cable types. */
export function isVideoCableType(type: CableType): boolean {
  return type === 'keys' || type === 'image' || type === 'mono-video' || type === 'video';
}

/**
 * Returns true if a cable of `srcType` may legally terminate on a port
 * declaring `dstType`. Equal types always pass; the explicit upcast set
 * (keys→mono-video, image→video, mono-video→video, keys→image) covers the
 * "free" video-domain conversions. Audio CV is allowed to terminate on a
 * video param input — the cross-domain bridge (frame-rate S&H) is wired in
 * Phase 1; for Phase 0 we permit the connection at the type level so the
 * wiring story doesn't change later.
 *
 * Strictly out: audio/pitch/gate/polyPitchGate → any video port; any video
 * stream → any audio port.
 */
export function canConnect(srcType: CableType, dstType: CableType): boolean {
  if (srcType === dstType) return true;

  const upcasts: Record<string, readonly string[]> = {
    keys: ['mono-video', 'image'],
    image: ['video'],
    'mono-video': ['video'],
  };
  const ok = upcasts[srcType as string];
  if (ok && ok.includes(dstType as string)) return true;

  // Audio CV → video param input (frame-rate sample-and-hold; deferred
  // bridge in Phase 1). Permit at the type level so the eventual bridge
  // doesn't change call-site type checks.
  if (srcType === 'cv' && isVideoCableType(dstType)) return true;

  return false;
}

// ---------------- Module types (D5) ----------------
type StandardModuleType =
  | 'audioOut'
  | 'analogVco'
  | 'wavetableVco'
  | 'adsr'
  | 'filter'
  | 'vca'
  | 'mixer'
  | 'sequencer'
  | 'reverb'
  | 'scope'
  | 'lfo'
  | 'cartesian'
  | 'destroy'
  | 'qbrt'
  | 'drummergirl'
  | 'meowbox'
  | 'mixmstrs'
  | 'timelorde'
  | 'charlottesEchos'
  | 'riotgirls'
  | 'score'
  | 'drumseqz'
  // Sister modules with built-in wavefolder + waveform-video output:
  | 'vizvco'
  | 'wavviz'
  // SWOLEVCO — Buchla 259-style complex VCO (primary + modulator + cross-mod
  // + symmetry morph + wavefolder + scope video out).
  | 'swolevco'
  // Video-domain modules (Phase 0 spike):
  | 'lines'
  | 'videoOut'
  // Video-domain modules (Phase 1 — .myrobots/plans/video-modules-mvp.md):
  | 'inwards'
  | 'picturebox'
  | 'destructor'
  | 'chroma'
  | 'luma'
  | 'colorizer'
  | 'feedback'
  | 'videoMixer'
  // CAMERA — webcam input (local-only). Spec: .myrobots/plans/module-camera-input.md.
  | 'cameraInput'
  // ILLOGIC — combined attenuverter / math / logic utility (audio domain).
  | 'illogic'
  // DX7 — pure-TypeScript 6-op FM synth with bundled factory-inspired patches.
  | 'dx7';
export type ModuleType = StandardModuleType | (string & {});

// ---------------- Port + parameter schemas ----------------
export interface PortDef {
  id: string;
  type: CableType;
  // Whether the input is an audio-rate node connection or a CV → AudioParam routing.
  // Outputs are always nodes; this hint lives on inputs only.
  paramTarget?: string; // when set, CV connections route to this AudioParam
}

export type KnobCurve = 'linear' | 'log' | 'exp' | 'discrete';

export interface ParamDef {
  id: string;
  label: string;
  defaultValue: number;
  min: number;
  max: number;
  curve: KnobCurve;
  units?: string;
}

export type ParamSchema = Readonly<ParamDef[]>;

// ---------------- Patch graph (D8) ----------------
export interface ModuleNode {
  id: string;
  type: ModuleType;
  domain: Domain; // 'audio' for all Phase 1 modules
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

export interface Edge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: CableType;
  targetType: CableType;
}

export interface PatchGraph {
  nodes: Record<string, ModuleNode>;
  edges: Record<string, Edge>;
}

// ---------------- Module registry shape (D18, D19) ----------------
export interface ModuleDef {
  type: ModuleType;
  domain: Domain;
  /** Human-readable name (palette + UI). */
  label: string;
  /** Palette grouping. */
  category: 'sources' | 'modulation' | 'filters' | 'effects' | 'utilities' | 'output' | string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamSchema;
  /** Bumped when params or data shape changes (D19). */
  schemaVersion: number;
  /** Migrate older saved data forward to the current schemaVersion. */
  migrate?: (data: unknown, fromVersion: number) => unknown;
}
