// packages/web/src/lib/mike/personality.ts
//
// Meticulous Mike — sibling personality to Rackspace Carl.
//
// Mike differs from Carl in three ways:
//
//   1. **Structured progression instead of weighted-random.** Mike walks
//      a fixed build order (drums → bass → melody → complexity) and
//      decides the next action by INSPECTING the current rack state to
//      see which step of that progression is still missing. This means
//      he resumes correctly mid-build if the user deletes one of his
//      modules and he's resilient to existing-rack scenarios (the
//      progression naturally jumps to "add melody" if the rack already
//      has drums + bass).
//
//   2. **Existing-rack mode.** When Mike spawns into a rack that already
//      has someone's patch running, he doesn't start a fresh drum kit —
//      he looks for an existing clock signal (TIMELORDE / sequencer
//      clock input) and adds a single tonal-melody line that's clocked
//      from that source.
//
//   3. **Music-theory aware.** When programming notes into a sequencer
//      he uses `music-theory.ts` to pick in-key offsets, not random
//      values. The "key" is derived from his seed so re-spawning at
//      the same seed produces the same melody.
//
// Pacing is left to the controller — Mike's `next()` returns intents
// with no time component; the controller adds the 5–15 s gap.
//
// The intent shape mirrors Carl's exactly so the same driver applies it.

import type { Intent } from '$lib/carl/intent';
import {
  type Catalog,
  type CatalogModule,
  isMikeSpawnable,
  pickByRole,
  pickByRoleExcluding,
} from './catalog';
import type { SeededRng } from '$lib/carl/rng';
import {
  findClockSource,
  generateChordToneMelody,
  generateInKeyNotes,
  isSequencerType,
  pickKey,
  type Key,
} from './music-theory';

export interface PersonalityPatchView {
  nodes: ReadonlyArray<{ id: string; type: string }>;
  edges: ReadonlyArray<{
    id: string;
    source: { nodeId: string; portId: string };
    target: { nodeId: string; portId: string };
  }>;
}

export interface MikeOptions {
  /** Hard cap on owned modules. Default 10 (Mike's progression naturally
   *  tops out around 8–10 — drums + bass + melody + effects + mixer +
   *  master clock + optional second drum/voice). */
  maxOwnedNodes?: number;
  /** ID prefix so Mike-owned modules can be evicted independently of
   *  Carl-owned modules (different prefix). Default 'mike'. */
  idPrefix?: string;
}

/**
 * Phase of Mike's structured build. We compute the current phase from
 * the patch state on every `next()` call rather than maintaining a
 * stateful counter — this way Mike correctly resumes if the user
 * deletes one of his modules and he gracefully handles existing-rack
 * spawns (where the rack already has a partial build).
 */
export type MikePhase =
  | 'spawn-drum-seq'
  | 'wire-drum-clock'
  | 'spawn-drum-voice'
  | 'wire-drum-voice'
  | 'spawn-mixer'
  | 'wire-drum-to-mixer'
  | 'spawn-output'
  | 'wire-mixer-to-output'
  | 'spawn-bass-seq'
  | 'spawn-bass-voice'
  | 'wire-bass-seq-to-voice'
  | 'wire-bass-voice-to-mixer'
  | 'spawn-melody-seq'
  | 'spawn-melody-voice'
  | 'spawn-melody-effect'
  | 'wire-melody-seq-to-voice'
  | 'wire-melody-voice-to-effect'
  | 'wire-melody-effect-to-mixer'
  | 'idle';

/**
 * Public output of personality.next(). Includes the intent AND the
 * personality's preferred POST-intent sleep range. Controller picks a
 * value inside [minSleepMs, maxSleepMs] before scheduling the next tick.
 */
export interface MikeIntent {
  intent: Intent;
  minSleepMs: number;
  maxSleepMs: number;
}

export class MeticulousMike {
  readonly maxOwnedNodes: number;
  readonly idPrefix: string;
  readonly catalog: Catalog;
  /** Subset of the catalog Mike will spawn from. */
  private readonly spawnable: CatalogModule[];
  private readonly key: Key;
  private nodeCounter = 0;
  private edgeCounter = 0;
  /** Sticky per-session: once we know a rack-mate already had a clock
   *  source when Mike arrived, we lock onto "existing-rack" mode for
   *  the whole session so deletions don't bounce Mike back into
   *  empty-rack mode mid-build. */
  private existingRackModeLocked = false;

  constructor(catalog: Catalog, options: MikeOptions = {}) {
    this.catalog = catalog;
    this.spawnable = catalog.filter(isMikeSpawnable);
    this.maxOwnedNodes = options.maxOwnedNodes ?? 10;
    this.idPrefix = options.idPrefix ?? 'mike';
    if (this.spawnable.length === 0) {
      throw new Error('MeticulousMike: catalog has no spawnable modules');
    }
    // Key picked once per session — deterministic from the rng seeded
    // by the same `seed` Carl uses. We can't take the rng as a ctor
    // arg because the controller hands it to `next()`; instead we
    // seed the key from a hard-coded sub-rng off the first scale roll
    // when next() runs. Default to C major until the first call.
    this.key = { root: 0, scale: 'major' };
  }

  /** Override the music-theory key (used by tests + sessions that want
   *  to display the key on the indicator). */
  setKey(rand: () => number): void {
    const k = pickKey(rand);
    (this.key as { root: number }).root = k.root;
    (this.key as { scale: typeof k.scale }).scale = k.scale;
  }

  getKey(): Key {
    return { root: this.key.root, scale: this.key.scale };
  }

  /**
   * Determine the current phase of Mike's structured build. Pure: same
   * patch view → same phase. The phase is whatever step Mike has NOT
   * yet completed.
   */
  determinePhase(patch: PersonalityPatchView): MikePhase {
    const owned = this.ownedNodes(patch);
    const ownedEdges = this.ownedEdges(patch);
    const drumSeq = owned.find((n) => this.catModule(n.type)?.category === 'sequencers' && this.isDrumSeq(n.type));
    const drumVoice = owned.find((n) => this.isDrumVoice(n.type));
    const mixer = owned.find((n) => this.catModule(n.type)?.type === 'mixer' || this.catModule(n.type)?.type === 'mixmstrs');
    // We don't spawn audioOut (it's a singleton), but we DO need one
    // present in the rack for Mike's chain to terminate. Look across
    // ALL nodes (foreign or owned) for audioOut.
    const audioOutNode = patch.nodes.find((n) => n.type === 'audioOut');
    const bassSeq = owned.find((n) =>
      isSequencerType(n.type) && (!drumSeq || n.id !== drumSeq.id) && !this.isDrumSeq(n.type),
    );
    const bassVoice = owned.find(
      (n) => this.isTonalVoice(n.type) && (!bassSeq || true),
    );
    // Identify second-tonal-voice = melody voice (after bass voice).
    const tonalVoices = owned.filter((n) => this.isTonalVoice(n.type));
    const melodyVoice = tonalVoices.length >= 2 ? tonalVoices[1]! : null;
    const melodySeqs = owned.filter((n) => isSequencerType(n.type) && !this.isDrumSeq(n.type));
    const melodySeq = melodySeqs.length >= 2 ? melodySeqs[1]! : null;
    const effects = owned.filter((n) => this.isEffect(n.type));
    const melodyEffect = effects.length >= 1 ? effects[0]! : null;

    // Step 1: drums
    if (!drumSeq) return 'spawn-drum-seq';
    if (!drumVoice) return 'spawn-drum-voice';
    if (!mixer) return 'spawn-mixer';
    if (!audioOutNode) return 'spawn-output';

    // Step 1 wires:
    if (drumSeq && drumVoice && !this.hasEdgeBetween(ownedEdges, drumSeq.id, drumVoice.id)) {
      return 'wire-drum-voice';
    }
    if (drumVoice && mixer && !this.hasEdgeBetween(ownedEdges, drumVoice.id, mixer.id)) {
      return 'wire-drum-to-mixer';
    }
    if (mixer && audioOutNode && !this.hasEdgeBetween(ownedEdges, mixer.id, audioOutNode.id)) {
      return 'wire-mixer-to-output';
    }

    // Step 2: bass line
    if (!bassSeq) return 'spawn-bass-seq';
    if (!bassVoice || bassVoice.id === drumVoice.id) return 'spawn-bass-voice';
    if (bassSeq && bassVoice && !this.hasEdgeBetween(ownedEdges, bassSeq.id, bassVoice.id)) {
      return 'wire-bass-seq-to-voice';
    }
    if (bassVoice && mixer && !this.hasEdgeBetween(ownedEdges, bassVoice.id, mixer.id)) {
      return 'wire-bass-voice-to-mixer';
    }

    // Step 3: melody line (with effects)
    if (!melodySeq) return 'spawn-melody-seq';
    if (!melodyVoice) return 'spawn-melody-voice';
    if (!melodyEffect) return 'spawn-melody-effect';
    if (melodySeq && melodyVoice && !this.hasEdgeBetween(ownedEdges, melodySeq.id, melodyVoice.id)) {
      return 'wire-melody-seq-to-voice';
    }
    if (melodyVoice && melodyEffect && !this.hasEdgeBetween(ownedEdges, melodyVoice.id, melodyEffect.id)) {
      return 'wire-melody-voice-to-effect';
    }
    if (melodyEffect && mixer && !this.hasEdgeBetween(ownedEdges, melodyEffect.id, mixer.id)) {
      return 'wire-melody-effect-to-mixer';
    }

    return 'idle';
  }

  /**
   * Decide the next intent. Branches on rack state:
   *   - Empty rack (no foreign nodes): walk Mike's structured progression.
   *   - Existing rack (foreign nodes present): add a melody line clocked
   *     by the existing clock source.
   */
  next(rng: SeededRng, patch: PersonalityPatchView): MikeIntent {
    if (this.key.root === 0 && this.key.scale === 'major' && this.nodeCounter === 0) {
      // First call — derive the key from the rng so successive sessions
      // with the same seed pick the same key.
      this.setKey(() => rng.next());
    }

    const owned = this.ownedNodes(patch);
    const foreign = patch.nodes.filter((n) => !n.id.startsWith(this.idPrefix + '-'));
    // Treat the rack as "existing" if there are foreign modules AND
    // none of Mike's own modules are present (we're just arriving) — OR
    // the existing-rack flag was latched on the very first call.
    if (
      this.existingRackModeLocked ||
      (foreign.length >= 3 && owned.length === 0 && this.hasExistingClockSource(patch))
    ) {
      this.existingRackModeLocked = true;
      return this.existingRackIntent(rng, patch);
    }

    if (owned.length >= this.maxOwnedNodes) {
      return this.sleepIntent(rng);
    }

    const phase = this.determinePhase(patch);
    return this.intentForPhase(rng, patch, phase);
  }

  // ---------------- phase → intent mapping ----------------

  private intentForPhase(rng: SeededRng, patch: PersonalityPatchView, phase: MikePhase): MikeIntent {
    switch (phase) {
      case 'spawn-drum-seq': {
        const mod = pickByRole(this.catalog, 'drumSequencers');
        if (!mod) return this.fallbackSpawn(rng);
        return this.spawn(mod);
      }
      case 'spawn-drum-voice': {
        const mod = pickByRole(this.catalog, 'drumVoices');
        if (!mod) return this.fallbackSpawn(rng);
        return this.spawn(mod);
      }
      case 'spawn-mixer': {
        const mod = pickByRole(this.catalog, 'mixers');
        if (!mod) return this.fallbackSpawn(rng);
        return this.spawn(mod);
      }
      case 'spawn-output': {
        // We never spawn audioOut directly (it's a singleton +
        // typically pre-spawned). Fall back to a sleep — the user
        // will add audioOut on their first interaction, or it
        // already exists.
        return this.sleepIntent(rng);
      }
      case 'wire-drum-voice':
        return this.wireBetweenRoles(rng, patch, 'drumSequencers', 'drumVoices', 'gate');
      case 'wire-drum-to-mixer':
        return this.wireBetweenRoles(rng, patch, 'drumVoices', 'mixers', 'audio');
      case 'wire-mixer-to-output':
        return this.wireMixerToOutput(rng, patch);
      case 'spawn-bass-seq': {
        // Pick a different sequencer than the drum sequencer for variety.
        const drumSeqType = this.findOwnedTypeInRole('drumSequencers', patch);
        const skip = new Set<string>(drumSeqType ? [drumSeqType] : []);
        const mod = pickByRoleExcluding(this.catalog, 'toneSequencers', skip);
        if (!mod) return this.fallbackSpawn(rng);
        return this.spawn(mod);
      }
      case 'spawn-bass-voice': {
        const mod = pickByRole(this.catalog, 'tonalVoices');
        if (!mod) return this.fallbackSpawn(rng);
        return this.spawn(mod);
      }
      case 'wire-bass-seq-to-voice':
        return this.wireBassOrMelodySeqToVoice(rng, patch, /* secondTonal */ false);
      case 'wire-bass-voice-to-mixer':
        return this.wireOwnedTonalVoiceToMixer(rng, patch, /* whichTonalIndex */ 0);
      case 'spawn-melody-seq': {
        const drumSeqType = this.findOwnedTypeInRole('drumSequencers', patch);
        const bassSeqType = this.findOwnedTypeInRole('toneSequencers', patch);
        const skip = new Set<string>(
          [drumSeqType, bassSeqType].filter((t): t is string => t != null),
        );
        const mod = pickByRoleExcluding(this.catalog, 'toneSequencers', skip)
          ?? pickByRole(this.catalog, 'toneSequencers');
        if (!mod) return this.fallbackSpawn(rng);
        return this.spawn(mod);
      }
      case 'spawn-melody-voice': {
        const mod = pickByRole(this.catalog, 'tonalVoices');
        if (!mod) return this.fallbackSpawn(rng);
        return this.spawn(mod);
      }
      case 'spawn-melody-effect': {
        const mod = pickByRole(this.catalog, 'effects');
        if (!mod) return this.fallbackSpawn(rng);
        return this.spawn(mod);
      }
      case 'wire-melody-seq-to-voice':
        return this.wireBassOrMelodySeqToVoice(rng, patch, /* secondTonal */ true);
      case 'wire-melody-voice-to-effect':
        return this.wireOwnedTonalVoiceToEffect(rng, patch);
      case 'wire-melody-effect-to-mixer':
        return this.wireOwnedEffectToMixer(rng, patch);
      case 'idle':
        return this.sleepIntent(rng);
      default:
        return this.sleepIntent(rng);
    }
  }

  // ---------------- existing-rack mode ----------------

  private hasExistingClockSource(patch: PersonalityPatchView): boolean {
    return findClockSource(patch.nodes, patch.edges) !== null;
  }

  private existingRackIntent(rng: SeededRng, patch: PersonalityPatchView): MikeIntent {
    const owned = this.ownedNodes(patch);
    // Existing-rack sub-progression: melody-seq → melody-voice → wire
    // clock → wire seq → voice → effect (mixer optional — only if a
    // mixer already exists).
    const melodySeq = owned.find((n) => isSequencerType(n.type));
    const melodyVoice = owned.find((n) => this.isTonalVoice(n.type));
    const ownedEdges = this.ownedEdges(patch);

    if (!melodySeq) {
      const mod = pickByRole(this.catalog, 'toneSequencers');
      if (!mod) return this.fallbackSpawn(rng);
      return this.spawn(mod);
    }
    // Wire the clock source to the new sequencer's clock input.
    const clockSource = findClockSource(patch.nodes, patch.edges);
    if (
      clockSource &&
      !ownedEdges.some(
        (e) => e.source.nodeId === clockSource.nodeId && e.target.nodeId === melodySeq.id,
      )
    ) {
      const seqDef = this.catModule(melodySeq.type);
      // Post cable-collapse the clock input is typed `cv` with a gate/trigger
      // `edge`; match on id + the edge semantic (not the old `gate` cableType).
      const clockInput = seqDef?.inputs.find((p) => p.id === 'clock' && !!p.edge);
      if (clockInput) {
        return this.edge({
          sourceNodeId: clockSource.nodeId,
          sourcePortId: clockSource.portId,
          targetNodeId: melodySeq.id,
          targetPortId: clockInput.id,
          cableType: 'cv',
        });
      }
    }
    if (!melodyVoice) {
      const mod = pickByRole(this.catalog, 'tonalVoices');
      if (!mod) return this.fallbackSpawn(rng);
      return this.spawn(mod);
    }
    // Wire seq → voice (pitch + gate).
    if (!this.hasEdgeBetween(ownedEdges, melodySeq.id, melodyVoice.id)) {
      return this.wireSeqToVoice(rng, melodySeq, melodyVoice);
    }
    // After connecting the basic chain, sleep — user takes over.
    return this.sleepIntent(rng);
  }

  // ---------------- atomic intent builders ----------------

  private spawn(mod: CatalogModule): MikeIntent {
    return {
      intent: {
        kind: 'addNode',
        id: `${this.idPrefix}-n${this.nodeCounter++}-${mod.type}`,
        type: mod.type,
      },
      // Mike is slow. 5–15 s between actions.
      minSleepMs: 5000,
      maxSleepMs: 15000,
    };
  }

  private edge(opts: {
    sourceNodeId: string;
    sourcePortId: string;
    targetNodeId: string;
    targetPortId: string;
    cableType: string;
  }): MikeIntent {
    return {
      intent: {
        kind: 'addEdge',
        id: `${this.idPrefix}-e${this.edgeCounter++}`,
        sourceNodeId: opts.sourceNodeId,
        sourcePortId: opts.sourcePortId,
        targetNodeId: opts.targetNodeId,
        targetPortId: opts.targetPortId,
        sourceCableType: opts.cableType,
        targetCableType: opts.cableType,
      },
      minSleepMs: 5000,
      maxSleepMs: 15000,
    };
  }

  private sleepIntent(rng: SeededRng): MikeIntent {
    return {
      intent: { kind: 'sleep', ms: rng.int(8000, 15000) },
      minSleepMs: 8000,
      maxSleepMs: 15000,
    };
  }

  private fallbackSpawn(rng: SeededRng): MikeIntent {
    const mod = rng.pick(this.spawnable);
    return this.spawn(mod);
  }

  // ---------------- wiring helpers ----------------

  /**
   * Find an owned module whose role-preferred-type list contains it,
   * and wire its appropriate output to the first matching input on a
   * module from the target role. cableType picks the cable color.
   */
  private wireBetweenRoles(
    rng: SeededRng,
    patch: PersonalityPatchView,
    sourceRole: 'drumSequencers' | 'drumVoices' | 'mixers' | 'tonalVoices' | 'effects',
    targetRole: 'drumVoices' | 'mixers' | 'tonalVoices' | 'effects',
    cableType: string,
  ): MikeIntent {
    const owned = this.ownedNodes(patch);
    const src = owned.find((n) => this.isInRole(n.type, sourceRole));
    const tgt = owned.find((n) => this.isInRole(n.type, targetRole));
    if (!src || !tgt) return this.sleepIntent(rng);
    const srcDef = this.catModule(src.type);
    const tgtDef = this.catModule(tgt.type);
    if (!srcDef || !tgtDef) return this.sleepIntent(rng);
    const srcPort = srcDef.outputs.find((p) => p.cableType === cableType);
    // Find an unoccupied target input of matching cable type.
    const occupiedTargets = new Set<string>(
      patch.edges.map((e) => `${e.target.nodeId}::${e.target.portId}`),
    );
    const tgtPort = tgtDef.inputs.find(
      (p) => p.cableType === cableType && !occupiedTargets.has(`${tgt.id}::${p.id}`),
    );
    if (!srcPort || !tgtPort) return this.sleepIntent(rng);
    return this.edge({
      sourceNodeId: src.id,
      sourcePortId: srcPort.id,
      targetNodeId: tgt.id,
      targetPortId: tgtPort.id,
      cableType,
    });
  }

  private wireMixerToOutput(rng: SeededRng, patch: PersonalityPatchView): MikeIntent {
    const owned = this.ownedNodes(patch);
    const mixer = owned.find((n) => n.type === 'mixer' || n.type === 'mixmstrs');
    const audioOutNode = patch.nodes.find((n) => n.type === 'audioOut');
    if (!mixer || !audioOutNode) return this.sleepIntent(rng);
    const mixerDef = this.catModule(mixer.type);
    const outDef = this.catModule('audioOut');
    if (!mixerDef || !outDef) return this.sleepIntent(rng);
    const out = mixerDef.outputs.find((p) => p.cableType === 'audio');
    const inL = outDef.inputs.find((p) => p.cableType === 'audio');
    if (!out || !inL) return this.sleepIntent(rng);
    const occupiedTargets = new Set<string>(
      patch.edges.map((e) => `${e.target.nodeId}::${e.target.portId}`),
    );
    if (occupiedTargets.has(`${audioOutNode.id}::${inL.id}`)) return this.sleepIntent(rng);
    return this.edge({
      sourceNodeId: mixer.id,
      sourcePortId: out.id,
      targetNodeId: audioOutNode.id,
      targetPortId: inL.id,
      cableType: 'audio',
    });
  }

  private wireBassOrMelodySeqToVoice(
    rng: SeededRng,
    patch: PersonalityPatchView,
    secondTonal: boolean,
  ): MikeIntent {
    const owned = this.ownedNodes(patch);
    const toneSeqs = owned.filter((n) => isSequencerType(n.type) && !this.isDrumSeq(n.type));
    const tonalVoices = owned.filter((n) => this.isTonalVoice(n.type));
    const seq = secondTonal ? toneSeqs[1] : toneSeqs[0];
    const voice = secondTonal ? tonalVoices[1] : tonalVoices[0];
    if (!seq || !voice) return this.sleepIntent(rng);
    return this.wireSeqToVoice(rng, seq, voice);
  }

  private wireSeqToVoice(
    rng: SeededRng,
    seq: { id: string; type: string },
    voice: { id: string; type: string },
  ): MikeIntent {
    const seqDef = this.catModule(seq.type);
    const voiceDef = this.catModule(voice.type);
    if (!seqDef || !voiceDef) return this.sleepIntent(rng);
    // Prefer pitch/cv outputs first, then fall back to a gate connection.
    // Post cable-collapse pitch + gate are BOTH the `cv` cableType; a
    // gate/trigger port is the one with an `edge` semantic, a pitch/cv port
    // is a `cv` port WITHOUT an edge (or the canonical pitch ids). So match a
    // pitch by id/(cv && !edge), and a gate by its `edge` declaration.
    const occupiedTargets = new Set<string>();
    const isPitchPort = (p: { id: string; cableType: string; edge?: string }) =>
      p.id === 'pitch1' || p.id === 'pitch'
      || (p.cableType === 'cv' && !p.edge && /pitch/i.test(p.id));
    const pitchOut = seqDef.outputs.find(isPitchPort);
    const pitchIn = voiceDef.inputs.find(isPitchPort);
    if (pitchOut && pitchIn) {
      return this.edge({
        sourceNodeId: seq.id,
        sourcePortId: pitchOut.id,
        targetNodeId: voice.id,
        targetPortId: pitchIn.id,
        cableType: 'cv',
      });
    }
    const gateOut = seqDef.outputs.find((p) => !!p.edge);
    const gateIn = voiceDef.inputs.find((p) => !!p.edge);
    if (gateOut && gateIn && !occupiedTargets.has(`${voice.id}::${gateIn.id}`)) {
      return this.edge({
        sourceNodeId: seq.id,
        sourcePortId: gateOut.id,
        targetNodeId: voice.id,
        targetPortId: gateIn.id,
        cableType: 'cv',
      });
    }
    return this.sleepIntent(rng);
  }

  private wireOwnedTonalVoiceToMixer(
    rng: SeededRng,
    patch: PersonalityPatchView,
    whichTonalIndex: number,
  ): MikeIntent {
    const owned = this.ownedNodes(patch);
    const tonalVoices = owned.filter((n) => this.isTonalVoice(n.type));
    const voice = tonalVoices[whichTonalIndex];
    const mixer = owned.find((n) => n.type === 'mixer' || n.type === 'mixmstrs');
    if (!voice || !mixer) return this.sleepIntent(rng);
    return this.wireAudioBetween(rng, patch, voice, mixer);
  }

  private wireOwnedEffectToMixer(rng: SeededRng, patch: PersonalityPatchView): MikeIntent {
    const owned = this.ownedNodes(patch);
    const effect = owned.find((n) => this.isEffect(n.type));
    const mixer = owned.find((n) => n.type === 'mixer' || n.type === 'mixmstrs');
    if (!effect || !mixer) return this.sleepIntent(rng);
    return this.wireAudioBetween(rng, patch, effect, mixer);
  }

  private wireOwnedTonalVoiceToEffect(rng: SeededRng, patch: PersonalityPatchView): MikeIntent {
    const owned = this.ownedNodes(patch);
    const tonalVoices = owned.filter((n) => this.isTonalVoice(n.type));
    const voice = tonalVoices[1] ?? tonalVoices[0];
    const effect = owned.find((n) => this.isEffect(n.type));
    if (!voice || !effect) return this.sleepIntent(rng);
    return this.wireAudioBetween(rng, patch, voice, effect);
  }

  private wireAudioBetween(
    rng: SeededRng,
    patch: PersonalityPatchView,
    src: { id: string; type: string },
    tgt: { id: string; type: string },
  ): MikeIntent {
    const srcDef = this.catModule(src.type);
    const tgtDef = this.catModule(tgt.type);
    if (!srcDef || !tgtDef) return this.sleepIntent(rng);
    const out = srcDef.outputs.find((p) => p.cableType === 'audio');
    const occupiedTargets = new Set<string>(
      patch.edges.map((e) => `${e.target.nodeId}::${e.target.portId}`),
    );
    const inp = tgtDef.inputs.find(
      (p) => p.cableType === 'audio' && !occupiedTargets.has(`${tgt.id}::${p.id}`),
    );
    if (!out || !inp) return this.sleepIntent(rng);
    return this.edge({
      sourceNodeId: src.id,
      sourcePortId: out.id,
      targetNodeId: tgt.id,
      targetPortId: inp.id,
      cableType: 'audio',
    });
  }

  // ---------------- in-key sequence programming ----------------

  /**
   * Emit a `setParam` intent that writes an in-key pitch to a sequencer
   * step. Mike uses this AFTER all the structural wiring is done, in
   * the "complexity" stage, to make his sequencers sound tonal instead
   * of buzzy-default. Tests inspect the returned value to confirm it
   * lands on a scale degree.
   */
  programInKeyStep(
    rng: SeededRng,
    nodeId: string,
    paramId: string,
    paramMin: number,
    paramMax: number,
    centerSemitone: number = 0,
    chordTonesOnly: boolean = false,
  ): Intent {
    const rand = () => rng.next();
    const notes = chordTonesOnly
      ? generateChordToneMelody(this.key, 1, centerSemitone, rand)
      : generateInKeyNotes(this.key, 1, centerSemitone, rand);
    const semis = notes[0]!;
    // Clamp into the sequencer's param range so the engine accepts it.
    const clamped = Math.max(paramMin, Math.min(paramMax, semis));
    return { kind: 'setParam', nodeId, paramId, value: clamped };
  }

  // ---------------- helpers / membership ----------------

  private ownedNodes(patch: PersonalityPatchView): Array<{ id: string; type: string }> {
    return patch.nodes.filter((n) => n.id.startsWith(this.idPrefix + '-'));
  }

  private ownedEdges(
    patch: PersonalityPatchView,
  ): Array<{ id: string; source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }> {
    return patch.edges.filter((e) => e.id.startsWith(this.idPrefix + '-'));
  }

  private catModule(type: string): CatalogModule | undefined {
    return this.catalog.find((m) => m.type === type);
  }

  private isDrumSeq(type: string): boolean {
    return type === 'drumseqz';
  }

  private isDrumVoice(type: string): boolean {
    return ['drummergirl', 'riotgirls', 'meowbox', 'noise'].includes(type);
  }

  private isTonalVoice(type: string): boolean {
    return ['analogVco', 'macrooscillator', 'wavetableVco', 'swolevco'].includes(type);
  }

  private isEffect(type: string): boolean {
    return ['reverb', 'cloudseed', 'shimmershine', 'clouds', 'charlottesEchos'].includes(type);
  }

  private isInRole(type: string, role: 'drumSequencers' | 'drumVoices' | 'mixers' | 'tonalVoices' | 'effects'): boolean {
    switch (role) {
      case 'drumSequencers': return this.isDrumSeq(type);
      case 'drumVoices':     return this.isDrumVoice(type);
      case 'mixers':         return type === 'mixer' || type === 'mixmstrs';
      case 'tonalVoices':    return this.isTonalVoice(type);
      case 'effects':        return this.isEffect(type);
      default:               return false;
    }
  }

  private findOwnedTypeInRole(
    role: 'drumSequencers' | 'toneSequencers' | 'drumVoices' | 'tonalVoices' | 'effects',
    patch: PersonalityPatchView,
  ): string | null {
    const owned = this.ownedNodes(patch);
    for (const n of owned) {
      if (role === 'drumSequencers' && this.isDrumSeq(n.type)) return n.type;
      if (role === 'toneSequencers' && isSequencerType(n.type) && !this.isDrumSeq(n.type)) return n.type;
      if (role === 'drumVoices' && this.isDrumVoice(n.type)) return n.type;
      if (role === 'tonalVoices' && this.isTonalVoice(n.type)) return n.type;
      if (role === 'effects' && this.isEffect(n.type)) return n.type;
    }
    return null;
  }

  /**
   * Returns true if any owned edge has both endpoints among the given
   * source/target node-id pair (in either direction). Used as a "have
   * we already wired these two?" guard so determinePhase doesn't loop.
   */
  private hasEdgeBetween(
    edges: ReadonlyArray<{ source: { nodeId: string }; target: { nodeId: string } }>,
    a: string,
    b: string,
  ): boolean {
    for (const e of edges) {
      if (
        (e.source.nodeId === a && e.target.nodeId === b) ||
        (e.source.nodeId === b && e.target.nodeId === a)
      ) {
        return true;
      }
    }
    return false;
  }
}
