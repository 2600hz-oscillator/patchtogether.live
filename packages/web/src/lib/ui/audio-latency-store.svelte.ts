// Audio-latency (AudioContext buffer) store — Svelte 5 runes. Singleton.
//
// R-1 of the ES-9 duplex-clicks fix. The dominant lever for "clicks get
// worse when I interact with the UI" is the AudioContext buffer size: a
// bigger buffer gives the audio render thread slack to ride out a
// main-thread CPU spike (canvas pan/drag event-storm, knob drag, video
// frame) without underrunning → no click. We expose a 4-step ladder that
// maps to the AudioContext `latencyHint` constructor option:
//
//   Low      'interactive'  — today's behavior: smallest buffer, lowest
//                             latency. For tight ES-9 jamming on a quiet rig.
//   Tight    0.012 s        — an in-between step the user explicitly asked
//                             for: a hair more slack than Low, still very low
//                             latency. DEFAULT.
//   Balanced 0.025 s        — comfortable headroom for normal patches.
//   Stable   0.045 s        — heavy / video-laden patches; most slack.
//
// IMPORTANT: `latencyHint` can ONLY be set when the AudioContext is
// CONSTRUCTED — it is not mutable on a live context. So this store
// PERSISTS the choice (localStorage; it's a per-machine audio-hardware
// preference, NOT per-rack/Yjs) and the engine reads it at boot. A
// mid-session change therefore applies on the next reload — the UI shows a
// small "applies on reload" hint when the live context's setting differs
// from the chosen one. (We deliberately do NOT live-rebuild the whole
// AudioContext + audio graph: a graceful teardown/reboot that re-creates
// every worklet node, re-wires the reconciler, and re-acquires the ES-9
// duplex stream is far riskier than a reload, and a half-rebuild that
// leaves dangling nodes is exactly the kind of click-source we're fixing.)
//
// SSR safety: construction is gated on `typeof localStorage`; under SSR the
// store holds the default in memory and skips storage.

export type AudioLatencyMode = 'low' | 'tight' | 'balanced' | 'stable';

export interface AudioLatencyOption {
  readonly id: AudioLatencyMode;
  readonly label: string;
  /** The value handed to `new AudioContext({ latencyHint })`. */
  readonly latencyHint: AudioContextLatencyCategory | number;
  /** Short human description for the tooltip. */
  readonly hint: string;
}

export const AUDIO_LATENCY_OPTIONS: readonly AudioLatencyOption[] = [
  {
    id: 'low',
    label: 'Low',
    latencyHint: 'interactive',
    hint: 'Smallest buffer, lowest latency — tight ES-9 jamming on a quiet rig (most click-prone under UI load).',
  },
  {
    id: 'tight',
    label: 'Tight',
    latencyHint: 0.012,
    hint: 'A hair more slack than Low, still very low latency. Default.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    latencyHint: 0.025,
    hint: 'Comfortable headroom — fewer clicks when dragging cards / knobs.',
  },
  {
    id: 'stable',
    label: 'Stable',
    latencyHint: 0.045,
    hint: 'Most slack — heavy / video-laden patches. Highest latency.',
  },
] as const;

const STORAGE_KEY = 'pt.audioLatency';

// DEFAULT — easily changed here. We default to 'tight' (NOT 'low'): it
// honors the user's low-latency preference while adding a touch of slack
// over today's click-prone 'interactive', which is the reported symptom.
export const DEFAULT_AUDIO_LATENCY_MODE: AudioLatencyMode = 'tight';

export function isAudioLatencyMode(v: unknown): v is AudioLatencyMode {
  return typeof v === 'string' && AUDIO_LATENCY_OPTIONS.some((o) => o.id === v);
}

export function getAudioLatencyOption(id: AudioLatencyMode): AudioLatencyOption {
  return (
    AUDIO_LATENCY_OPTIONS.find((o) => o.id === id) ??
    AUDIO_LATENCY_OPTIONS.find((o) => o.id === DEFAULT_AUDIO_LATENCY_MODE)!
  );
}

/** Map a mode id to the `latencyHint` value passed to the AudioContext. */
export function latencyHintFor(id: AudioLatencyMode): AudioContextLatencyCategory | number {
  return getAudioLatencyOption(id).latencyHint;
}

class AudioLatencyStore {
  /** The currently-CHOSEN mode (reactive). May differ from what the live
   *  AudioContext was actually constructed with until the next reload. */
  current = $state<AudioLatencyMode>(DEFAULT_AUDIO_LATENCY_MODE);

  /** The mode the LIVE AudioContext was actually booted with. The engine
   *  calls bootedWith() once it constructs the context; the UI compares it
   *  to `current` to decide whether to show the "applies on reload" hint. */
  booted = $state<AudioLatencyMode | null>(null);

  constructor() {
    if (typeof localStorage !== 'undefined') {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (isAudioLatencyMode(stored)) {
          this.current = stored;
        }
      } catch {
        // localStorage can throw in restricted contexts (Safari private,
        // sandboxed iframes). Fall through to default.
      }
    }
  }

  /**
   * Choose a latency mode. Persists to localStorage. Does NOT touch any
   * live AudioContext — the new hint applies at the next engine boot
   * (reload). The UI surfaces a "reload to apply" hint while `current`
   * differs from `booted`.
   */
  set(id: AudioLatencyMode, persist = true): void {
    const safe: AudioLatencyMode = isAudioLatencyMode(id) ? id : DEFAULT_AUDIO_LATENCY_MODE;
    this.current = safe;
    if (persist && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, safe);
      } catch {
        // Quota / disabled storage — non-fatal.
      }
    }
  }

  /** The engine records which mode the live context was constructed with. */
  bootedWith(id: AudioLatencyMode): void {
    this.booted = id;
  }

  /** The `latencyHint` for the currently-chosen mode — what the engine
   *  passes to `new AudioContext()` at boot. */
  get latencyHint(): AudioContextLatencyCategory | number {
    return latencyHintFor(this.current);
  }

  get currentOption(): AudioLatencyOption {
    return getAudioLatencyOption(this.current);
  }

  /** True when the chosen mode hasn't been applied to the live context yet
   *  (i.e. a reload is needed). False before boot (`booted` null) so we
   *  don't nag before the engine has even started. */
  get reloadPending(): boolean {
    return this.booted !== null && this.booted !== this.current;
  }

  list(): readonly AudioLatencyOption[] {
    return AUDIO_LATENCY_OPTIONS;
  }
}

/** Singleton — import + call `set()` from any component. */
export const audioLatencyStore = new AudioLatencyStore();

// Dev-only: expose on window so e2e tests can drive it without the footer UI.
if (
  typeof import.meta !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).env?.DEV &&
  typeof window !== 'undefined'
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__audioLatencyStore = audioLatencyStore;
}
