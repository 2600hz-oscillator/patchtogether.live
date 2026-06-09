<script lang="ts">
  // PolyhelmCard — UI for POLYHELM (HELM + a polyphonic poly-bus input).
  //
  // Same dense Helm-style panel as HelmCard (osc / filter / 3 envelopes / LFOs /
  // step sequencer), plus a POLY input port (10-channel polyPitchGate) so a
  // chord from MIDI LANE / POLYSEQZ plays POLYHELM polyphonically. The gear icon
  // opens the same MIDI settings panel (device picker + per-channel rx).
  //
  // POLYHELM reuses HELM's card API + state types (HelmCardApi / HelmMidiState /
  // HelmMidiData) verbatim — only the type id, default label, testids, and the
  // extra POLY input differ from HelmCard.

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import type {
    HelmCardApi,
    HelmMidiState,
    HelmMidiData,
  } from '$lib/audio/modules/helm';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  function paramVal(key: string, fb: number): number {
    const v = node?.params?.[key];
    return typeof v === 'number' ? v : fb;
  }
  const set = (k: string) => (v: number) => setNodeParam(id, k, v);
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // ---------------- MIDI state ----------------
  let cardState = $state<HelmMidiState>({
    connected: false,
    permissionDenied: false,
    devices: [],
    selectedDeviceId: null,
    channels: null,
    lastNote: null,
    activeNotes: [],
    settingsOpen: false,
    seqOn: false,
    currentStep: -1,
  });

  let savedData = $derived(((node?.data ?? {}) as Partial<HelmMidiData>));

  function getApi(): HelmCardApi | null {
    const e = engineCtx.get();
    if (!e || !node) return null;
    return (e.read(node, 'card-api') as HelmCardApi | undefined) ?? null;
  }

  let settingsOpen = $state(false);

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const _ = id;
    const api = getApi();
    if (!api) return;
    unsubscribe?.();
    unsubscribe = api.subscribe((s) => {
      cardState = { ...s, settingsOpen };
    });
    return () => {
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  onDestroy(() => { unsubscribe?.(); });

  async function onClickConnect(): Promise<void> {
    const api = getApi();
    if (!api) return;
    await api.connect();
  }

  function writeData(payload: Partial<HelmMidiData>): void {
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    for (const [k, v] of Object.entries(payload)) {
      (t.data as Record<string, unknown>)[k] = v as unknown;
    }
  }

  function onChangeDevice(ev: Event): void {
    const sel = (ev.currentTarget as HTMLSelectElement).value || null;
    getApi()?.selectDevice(sel);
    writeData({ lastDeviceId: sel });
  }

  function toggleChannel(ch: number): void {
    const current = (savedData.channels ?? null) as number[] | null;
    let next: number[] | null;
    if (current === null) {
      next = [ch];
    } else if (current.includes(ch)) {
      next = current.filter((c) => c !== ch);
      if (next.length === 0) next = null;
    } else {
      next = [...current, ch].sort((a, b) => a - b);
    }
    getApi()?.setChannels(next);
    writeData({ channels: next });
  }

  function setAllChannels(): void {
    getApi()?.setChannels(null);
    writeData({ channels: null });
  }

  function toggleSettings(): void {
    settingsOpen = !settingsOpen;
    getApi()?.setSettingsOpen(settingsOpen);
  }

  function isChannelOn(ch: number): boolean {
    const c = savedData.channels;
    return c === null || c === undefined || c.includes(ch);
  }

  // ---------------- I/O ports ----------------
  // POLY first (the headline polyphonic input), then the mono fallbacks + MIDI,
  // then the step-sequencer reset gate (so every declared input port renders a
  // handle — the per-module-per-port handle-presence net).
  const inputs: PortDescriptor[] = [
    { id: 'poly',      label: 'POLY',  cable: 'polyPitchGate' },
    { id: 'pitch_cv',  label: 'V/OCT', cable: 'cv' },
    { id: 'gate',      label: 'GATE',  cable: 'gate' },
    { id: 'midi_in',   label: 'MIDI',  cable: 'cv' },
    { id: 'seq_reset', label: 'S.RST', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out_l', label: 'L', cable: 'audio' },
    { id: 'out_r', label: 'R', cable: 'audio' },
  ];

  // ---------------- Step sequencer pattern (lives in node.data.steps) ----------------
  let stepValues = $derived.by((): number[] => {
    const d = (node?.data ?? {}) as { steps?: unknown };
    if (Array.isArray(d.steps)) {
      const arr: number[] = [];
      for (let i = 0; i < 16; i++) {
        const v = d.steps[i];
        arr.push(typeof v === 'number' ? Math.max(-1, Math.min(1, v)) : 0);
      }
      return arr;
    }
    const arr: number[] = [];
    for (let i = 0; i < 16; i++) arr.push(i / 15 * 2 - 1);
    return arr;
  });

  function setStep(idx: number, val: number): void {
    const t = patch.nodes[id];
    if (!t) return;
    if (!t.data) t.data = {};
    const existing = stepValues.slice();
    existing[idx] = Math.max(-1, Math.min(1, val));
    (t.data as Record<string, unknown>).steps = existing;
    getApi()?.setSteps(existing);
  }

  // ---------------- Sequencer on/off + reset ----------------
  function toggleSeqOn(): void {
    const next = !cardState.seqOn;
    getApi()?.setSeqOn(next);
    writeData({ seqOn: next });
  }
  function onClickReset(): void {
    getApi()?.resetSeq();
  }
</script>

<div class="mod-card polyhelm-card" data-testid="polyhelm-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="POLYHELM" inline />
    <button
      type="button"
      class="gear-btn"
      aria-label="MIDI settings"
      data-testid="polyhelm-gear-btn"
      onclick={toggleSettings}>
      <!-- gear icon -->
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="8" cy="8" r="2.2"/>
        <path d="M8 1v2 M8 13v2 M1 8h2 M13 8h2 M3 3l1.5 1.5 M11.5 11.5L13 13 M3 13l1.5-1.5 M11.5 4.5L13 3"/>
      </svg>
    </button>
  </header>
  <div class="subtitle">POLYPHONIC SYNTHESIZER · POLY BUS IN · PORT OF HELM BY MATT TYTEL</div>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">

      {#if settingsOpen}
        <!-- ============ MIDI SETTINGS PANEL ============ -->
        <div class="settings" data-testid="polyhelm-settings">
          <div class="settings-head">
            <span>MIDI Settings</span>
            <button type="button" class="close-btn" onclick={toggleSettings} aria-label="Close settings">×</button>
          </div>
          {#if !cardState.connected}
            <button class="connect-btn" type="button" onclick={onClickConnect} data-testid="polyhelm-midi-connect">
              Connect MIDI…
            </button>
            {#if cardState.permissionDenied}
              <div class="hint err">Permission denied or browser unsupported.</div>
            {:else}
              <div class="hint">Click to grant MIDI access (one-time per origin).</div>
            {/if}
          {:else}
            <label class="row">
              <span class="lbl">DEVICE</span>
              <select onchange={onChangeDevice} value={cardState.selectedDeviceId ?? ''} data-testid="polyhelm-midi-device">
                <option value="" disabled>(pick one)</option>
                {#each cardState.devices as d (d.id)}
                  <option value={d.id}>{d.name}</option>
                {/each}
              </select>
            </label>

            <div class="ch-section">
              <div class="ch-head">
                <span class="lbl">CHANNELS RX</span>
                <button type="button" class="all-btn" onclick={setAllChannels} data-testid="polyhelm-midi-all-ch">ALL</button>
              </div>
              <div class="ch-grid">
                {#each Array(16) as _, i (i)}
                  <button
                    type="button"
                    class="ch-btn"
                    class:on={isChannelOn(i)}
                    onclick={() => toggleChannel(i)}
                    data-testid={`polyhelm-ch-${i + 1}`}
                  >{i + 1}</button>
                {/each}
              </div>
            </div>

            <div class="readout">
              <div class="readout-row">
                <span class="lbl">LAST NOTE</span>
                <span class="val">{cardState.lastNote ?? '—'}</span>
              </div>
              <div class="readout-row">
                <span class="lbl">ACTIVE</span>
                <span class="val">{cardState.activeNotes.length}</span>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <!-- ============ MAIN PANEL ============ -->

        <!-- Top row: 3 sections — OSC1, OSC2, SUB+NOISE -->
        <div class="row sections">
          <!-- OSC 1 -->
          <div class="section osc">
            <div class="section-title">OSC 1</div>
            <div class="knob-grid">
              <Knob value={paramVal('osc1Wave', 0)}   min={0} max={3} defaultValue={0}   label="Wav"  curve="discrete" onchange={set('osc1Wave')} moduleId={id} paramId="osc1Wave"   readLive={live('osc1Wave')} />
              <Knob value={paramVal('osc1Trans', 0)}  min={-24} max={24} defaultValue={0} label="Tr"   curve="linear"   onchange={set('osc1Trans')} moduleId={id} paramId="osc1Trans"  readLive={live('osc1Trans')} />
              <Knob value={paramVal('osc1Tune', 0)}   min={-100} max={100} defaultValue={0} label="Tu" curve="linear"   onchange={set('osc1Tune')} moduleId={id} paramId="osc1Tune"   readLive={live('osc1Tune')} />
              <Knob value={paramVal('osc1Unison', 1)} min={1} max={7} defaultValue={1}    label="Uni"  curve="discrete" onchange={set('osc1Unison')} moduleId={id} paramId="osc1Unison" readLive={live('osc1Unison')} />
              <Knob value={paramVal('osc1Detune', 10)} min={0} max={50} defaultValue={10} label="Det"  curve="linear"   onchange={set('osc1Detune')} moduleId={id} paramId="osc1Detune" readLive={live('osc1Detune')} />
              <Knob value={paramVal('osc1Vol', 0.8)}  min={0} max={1} defaultValue={0.8}  label="Vol"  curve="linear"   onchange={set('osc1Vol')} moduleId={id} paramId="osc1Vol"    readLive={live('osc1Vol')} />
            </div>
          </div>

          <!-- OSC 2 -->
          <div class="section osc">
            <div class="section-title">OSC 2</div>
            <div class="knob-grid">
              <Knob value={paramVal('osc2Wave', 1)}    min={0} max={3} defaultValue={1}   label="Wav"  curve="discrete" onchange={set('osc2Wave')} moduleId={id} paramId="osc2Wave"   readLive={live('osc2Wave')} />
              <Knob value={paramVal('osc2Trans', 0)}   min={-24} max={24} defaultValue={0} label="Tr"  curve="linear"   onchange={set('osc2Trans')} moduleId={id} paramId="osc2Trans"  readLive={live('osc2Trans')} />
              <Knob value={paramVal('osc2Tune', 7)}    min={-100} max={100} defaultValue={7} label="Tu" curve="linear"  onchange={set('osc2Tune')} moduleId={id} paramId="osc2Tune"   readLive={live('osc2Tune')} />
              <Knob value={paramVal('osc2Unison', 1)}  min={1} max={7} defaultValue={1}    label="Uni" curve="discrete" onchange={set('osc2Unison')} moduleId={id} paramId="osc2Unison" readLive={live('osc2Unison')} />
              <Knob value={paramVal('osc2Detune', 10)} min={0} max={50} defaultValue={10}  label="Det" curve="linear"   onchange={set('osc2Detune')} moduleId={id} paramId="osc2Detune" readLive={live('osc2Detune')} />
              <Knob value={paramVal('osc2Vol', 0.6)}   min={0} max={1} defaultValue={0.6}  label="Vol" curve="linear"   onchange={set('osc2Vol')} moduleId={id} paramId="osc2Vol"    readLive={live('osc2Vol')} />
            </div>
          </div>

          <!-- SUB + NOISE -->
          <div class="section subnoise">
            <div class="section-title">SUB / NOISE</div>
            <div class="knob-grid">
              <Knob value={paramVal('subWave', 3)}  min={0} max={3} defaultValue={3}  label="Sub W" curve="discrete" onchange={set('subWave')} moduleId={id} paramId="subWave"  readLive={live('subWave')} />
              <Knob value={paramVal('subVol', 0.4)} min={0} max={1} defaultValue={0.4} label="Sub"  curve="linear"   onchange={set('subVol')} moduleId={id} paramId="subVol"   readLive={live('subVol')} />
              <Knob value={paramVal('noiseVol', 0)} min={0} max={1} defaultValue={0}  label="Noise" curve="linear"  onchange={set('noiseVol')} moduleId={id} paramId="noiseVol" readLive={live('noiseVol')} />
              <Knob value={paramVal('volume', 0.7)} min={0} max={2} defaultValue={0.7} label="VOL"  curve="linear"   onchange={set('volume')} moduleId={id} paramId="volume"   readLive={live('volume')} />
              <Knob value={paramVal('voiceCount', 6)} min={1} max={8} defaultValue={6} label="Vcs"  curve="discrete" onchange={set('voiceCount')} moduleId={id} paramId="voiceCount" readLive={live('voiceCount')} />
              <Knob value={paramVal('spread', 0.3)} min={0} max={1} defaultValue={0.3} label="Spr"   curve="linear"   onchange={set('spread')} moduleId={id} paramId="spread"   readLive={live('spread')} />
            </div>
          </div>
        </div>

        <!-- Middle row: FILTER + 3 envelopes -->
        <div class="row sections">
          <!-- FILTER -->
          <div class="section filter">
            <div class="section-title">FILTER</div>
            <div class="knob-grid">
              <Knob value={paramVal('filterCutoff', 4000)}  min={20} max={20000} defaultValue={4000} label="Cut"  curve="log"      onchange={set('filterCutoff')} moduleId={id} paramId="filterCutoff"  readLive={live('filterCutoff')} />
              <Knob value={paramVal('filterRes', 1)}        min={0.5} max={16} defaultValue={1}      label="Res"  curve="linear"   onchange={set('filterRes')} moduleId={id} paramId="filterRes"     readLive={live('filterRes')} />
              <Knob value={paramVal('filterBlend', 0)}      min={0} max={2} defaultValue={0}         label="Mode" curve="linear"   onchange={set('filterBlend')} moduleId={id} paramId="filterBlend"   readLive={live('filterBlend')} />
              <Knob value={paramVal('filterStyle', 0)}      min={0} max={1} defaultValue={0}         label="Pole" curve="discrete" onchange={set('filterStyle')} moduleId={id} paramId="filterStyle"   readLive={live('filterStyle')} />
              <Knob value={paramVal('filterDrive', 1)}      min={0.5} max={6} defaultValue={1}       label="Drv"  curve="linear"   onchange={set('filterDrive')} moduleId={id} paramId="filterDrive"   readLive={live('filterDrive')} />
              <Knob value={paramVal('filterKeyTrack', 0)}   min={-1} max={1} defaultValue={0}        label="Key"  curve="linear"   onchange={set('filterKeyTrack')} moduleId={id} paramId="filterKeyTrack" readLive={live('filterKeyTrack')} />
            </div>
          </div>

          <!-- AMP ENV -->
          <div class="section env">
            <div class="section-title">AMP ENV</div>
            <div class="knob-grid">
              <Knob value={paramVal('ampAttack', 0.005)} min={0} max={8} defaultValue={0.005} label="A" curve="linear" onchange={set('ampAttack')} moduleId={id} paramId="ampAttack"  readLive={live('ampAttack')} />
              <Knob value={paramVal('ampDecay', 0.2)}    min={0} max={8} defaultValue={0.2}   label="D" curve="linear" onchange={set('ampDecay')} moduleId={id} paramId="ampDecay"   readLive={live('ampDecay')} />
              <Knob value={paramVal('ampSustain', 0.6)}  min={0} max={1} defaultValue={0.6}   label="S" curve="linear" onchange={set('ampSustain')} moduleId={id} paramId="ampSustain" readLive={live('ampSustain')} />
              <Knob value={paramVal('ampRelease', 0.3)}  min={0} max={8} defaultValue={0.3}   label="R" curve="linear" onchange={set('ampRelease')} moduleId={id} paramId="ampRelease" readLive={live('ampRelease')} />
            </div>
          </div>

          <!-- FILTER ENV -->
          <div class="section env">
            <div class="section-title">FILT ENV</div>
            <div class="knob-grid">
              <Knob value={paramVal('filAttack', 0.005)} min={0} max={8} defaultValue={0.005} label="A"   curve="linear" onchange={set('filAttack')} moduleId={id} paramId="filAttack"   readLive={live('filAttack')} />
              <Knob value={paramVal('filDecay', 0.5)}    min={0} max={8} defaultValue={0.5}   label="D"   curve="linear" onchange={set('filDecay')} moduleId={id} paramId="filDecay"    readLive={live('filDecay')} />
              <Knob value={paramVal('filSustain', 0)}    min={0} max={1} defaultValue={0}     label="S"   curve="linear" onchange={set('filSustain')} moduleId={id} paramId="filSustain"  readLive={live('filSustain')} />
              <Knob value={paramVal('filRelease', 0.3)}  min={0} max={8} defaultValue={0.3}   label="R"   curve="linear" onchange={set('filRelease')} moduleId={id} paramId="filRelease"  readLive={live('filRelease')} />
              <Knob value={paramVal('filEnvDepth', 0)}   min={-1} max={1} defaultValue={0}    label="Amt" curve="linear" onchange={set('filEnvDepth')} moduleId={id} paramId="filEnvDepth" readLive={live('filEnvDepth')} />
            </div>
          </div>

          <!-- MOD ENV -->
          <div class="section env">
            <div class="section-title">MOD ENV</div>
            <div class="knob-grid">
              <Knob value={paramVal('modAttack', 0.005)} min={0} max={8} defaultValue={0.005} label="A"   curve="linear" onchange={set('modAttack')} moduleId={id} paramId="modAttack"   readLive={live('modAttack')} />
              <Knob value={paramVal('modDecay', 0.5)}    min={0} max={8} defaultValue={0.5}   label="D"   curve="linear" onchange={set('modDecay')} moduleId={id} paramId="modDecay"    readLive={live('modDecay')} />
              <Knob value={paramVal('modSustain', 0)}    min={0} max={1} defaultValue={0}     label="S"   curve="linear" onchange={set('modSustain')} moduleId={id} paramId="modSustain"  readLive={live('modSustain')} />
              <Knob value={paramVal('modRelease', 0.3)}  min={0} max={8} defaultValue={0.3}   label="R"   curve="linear" onchange={set('modRelease')} moduleId={id} paramId="modRelease"  readLive={live('modRelease')} />
              <Knob value={paramVal('modEnvDepth', 0)}   min={-1} max={1} defaultValue={0}    label="Amt" curve="linear" onchange={set('modEnvDepth')} moduleId={id} paramId="modEnvDepth" readLive={live('modEnvDepth')} />
            </div>
          </div>
        </div>

        <!-- Bottom row: LFOs + STEP SEQ -->
        <div class="row sections">
          <div class="section lfo">
            <div class="section-title">LFO 1 → CUT</div>
            <div class="knob-grid">
              <Knob value={paramVal('lfo1Wave', 3)} min={0} max={3} defaultValue={3}      label="Wav" curve="discrete" onchange={set('lfo1Wave')} moduleId={id} paramId="lfo1Wave" readLive={live('lfo1Wave')} />
              <Knob value={paramVal('lfo1Freq', 1)} min={0.01} max={30} defaultValue={1}  label="Hz"  curve="log"      onchange={set('lfo1Freq')} moduleId={id} paramId="lfo1Freq" readLive={live('lfo1Freq')} />
              <Knob value={paramVal('lfo1Amp', 0)}  min={0} max={1} defaultValue={0}      label="Amt" curve="linear"   onchange={set('lfo1Amp')} moduleId={id} paramId="lfo1Amp"  readLive={live('lfo1Amp')} />
            </div>
          </div>
          <div class="section lfo">
            <div class="section-title">LFO 2 → O2 P</div>
            <div class="knob-grid">
              <Knob value={paramVal('lfo2Wave', 3)} min={0} max={3} defaultValue={3}      label="Wav" curve="discrete" onchange={set('lfo2Wave')} moduleId={id} paramId="lfo2Wave" readLive={live('lfo2Wave')} />
              <Knob value={paramVal('lfo2Freq', 4)} min={0.01} max={30} defaultValue={4}  label="Hz"  curve="log"      onchange={set('lfo2Freq')} moduleId={id} paramId="lfo2Freq" readLive={live('lfo2Freq')} />
              <Knob value={paramVal('lfo2Amp', 0)}  min={0} max={1} defaultValue={0}      label="Amt" curve="linear"   onchange={set('lfo2Amp')} moduleId={id} paramId="lfo2Amp"  readLive={live('lfo2Amp')} />
            </div>
          </div>
          <div class="section step">
            <div class="section-title">STEP SEQ → O2 T</div>
            <div class="knob-grid">
              <Knob value={paramVal('stepNumSteps', 8)} min={1} max={16} defaultValue={8}    label="N"   curve="discrete" onchange={set('stepNumSteps')} moduleId={id} paramId="stepNumSteps" readLive={live('stepNumSteps')} />
              <Knob value={paramVal('stepRate', 4)}     min={0.1} max={30} defaultValue={4}  label="Hz"  curve="log"      onchange={set('stepRate')} moduleId={id} paramId="stepRate"     readLive={live('stepRate')} />
              <Knob value={paramVal('stepSmooth', 0)}   min={0} max={1} defaultValue={0}     label="Sm"  curve="linear"   onchange={set('stepSmooth')} moduleId={id} paramId="stepSmooth"   readLive={live('stepSmooth')} />
              <Knob value={paramVal('stepDepth', 0)}    min={-1} max={1} defaultValue={0}    label="Amt" curve="linear"   onchange={set('stepDepth')} moduleId={id} paramId="stepDepth"    readLive={live('stepDepth')} />
            </div>
            <!-- Sequencer transport: on/off + reset (gate-clocked v2). -->
            <div class="seq-transport">
              <button
                type="button"
                class="seq-onoff-btn"
                class:on={cardState.seqOn}
                onclick={toggleSeqOn}
                data-testid="polyhelm-seq-onoff"
                aria-pressed={cardState.seqOn}
              >SEQ {cardState.seqOn ? 'ON' : 'OFF'}</button>
              <button
                type="button"
                class="seq-reset-btn"
                onclick={onClickReset}
                data-testid="polyhelm-seq-reset"
                aria-label="Reset sequencer"
              >RST</button>
            </div>
            <!-- Step pattern -->
            <div class="step-grid" data-testid="polyhelm-step-grid">
              {#each stepValues as v, i (i)}
                <div
                  class="step-cell"
                  class:active={cardState.seqOn && cardState.currentStep === i}
                  data-testid={`polyhelm-step-cell-${i}`}
                  data-current={cardState.seqOn && cardState.currentStep === i ? 'true' : 'false'}
                >
                  <input
                    type="range"
                    class="step-slider"
                    min={-1} max={1} step={0.01}
                    value={v}
                    oninput={(e) => setStep(i, parseFloat((e.currentTarget as HTMLInputElement).value))}
                    aria-label={`Step ${i + 1}`}
                    data-testid={`polyhelm-step-${i}`}
                  />
                  {#if cardState.seqOn && cardState.currentStep === i}
                    <span class="step-dot" data-testid={`polyhelm-step-dot-${i}`}></span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        </div>
      {/if}

    </div>
  </PatchPanel>
</div>

<style>
  .polyhelm-card {
    width: 720px;
  }
  .polyhelm-card .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-right: 8px;
  }
  .polyhelm-card .gear-btn {
    background: transparent;
    border: 1px solid #2a2f3a;
    color: var(--text-dim, #8a90a0);
    border-radius: 3px;
    padding: 2px 5px;
    cursor: pointer;
    line-height: 0;
  }
  .polyhelm-card .gear-btn:hover {
    color: var(--text, #d8dde6);
    border-color: #5a6172;
  }
  .polyhelm-card .subtitle {
    font-size: 0.55rem;
    color: var(--text-dim);
    text-align: center;
    letter-spacing: 0.08em;
    margin-top: 2px;
  }
  .polyhelm-card .body {
    margin-top: 10px;
    padding: 0 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .polyhelm-card .row.sections {
    display: flex;
    gap: 8px;
  }
  .polyhelm-card .section {
    flex: 1;
    background: #0d1118;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .polyhelm-card .section-title {
    font-size: 0.55rem;
    color: var(--text-dim);
    letter-spacing: 0.08em;
    text-align: center;
    text-transform: uppercase;
  }
  .polyhelm-card .knob-grid {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .polyhelm-card .seq-transport {
    display: flex;
    gap: 4px;
    margin-top: 4px;
  }
  .polyhelm-card .seq-onoff-btn,
  .polyhelm-card .seq-reset-btn {
    background: #0a0c11;
    color: var(--text-dim, #888);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 2px 8px;
    font-size: 0.6rem;
    cursor: pointer;
    font-weight: 600;
    letter-spacing: 0.05em;
  }
  .polyhelm-card .seq-onoff-btn.on {
    background: var(--cable-audio, #6cc);
    color: #000;
    border-color: var(--cable-audio, #6cc);
  }
  .polyhelm-card .seq-onoff-btn:hover,
  .polyhelm-card .seq-reset-btn:hover {
    color: var(--text, #d8dde6);
    border-color: #5a6172;
  }
  .polyhelm-card .seq-onoff-btn.on:hover { color: #000; }
  .polyhelm-card .step-grid {
    display: grid;
    grid-template-columns: repeat(16, 1fr);
    gap: 1px;
    margin-top: 4px;
  }
  .polyhelm-card .step-cell {
    position: relative;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .polyhelm-card .step-slider {
    -webkit-appearance: slider-vertical;
    appearance: slider-vertical;
    writing-mode: vertical-lr;
    height: 36px;
    width: 12px;
    background: #1a1f2a;
  }
  .polyhelm-card .step-dot {
    position: absolute;
    top: -3px;
    left: 50%;
    transform: translateX(-50%);
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4ade80; /* green-400 */
    box-shadow: 0 0 4px rgba(74, 222, 128, 0.6);
    pointer-events: none;
  }
  /* ---------------- Settings panel ---------------- */
  .polyhelm-card .settings {
    padding: 10px;
    background: #0d1118;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .polyhelm-card .settings-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.7rem;
    color: var(--text, #d8dde6);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-bottom: 1px solid #2a2f3a;
    padding-bottom: 4px;
  }
  .polyhelm-card .close-btn {
    background: transparent;
    border: none;
    color: var(--text-dim, #8a90a0);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 4px;
  }
  .polyhelm-card .close-btn:hover { color: var(--text, #d8dde6); }
  .polyhelm-card .connect-btn {
    padding: 8px 12px;
    background: var(--cable-audio, #6cc);
    color: #000;
    border: none;
    border-radius: 3px;
    font-weight: 600;
    cursor: pointer;
    font-size: 12px;
  }
  .polyhelm-card .hint {
    font-size: 10px;
    color: var(--text-dim, #888);
    margin-top: 4px;
    line-height: 1.3;
  }
  .polyhelm-card .hint.err { color: #d66; }
  .polyhelm-card .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  .polyhelm-card .row .lbl {
    min-width: 60px;
    color: var(--text-dim, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .polyhelm-card .row select {
    flex: 1;
    font-size: 10px;
    padding: 2px 4px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .polyhelm-card .ch-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .polyhelm-card .ch-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .polyhelm-card .ch-head .lbl {
    color: var(--text-dim, #aaa);
    font-size: 10px;
    letter-spacing: 0.5px;
    font-weight: 600;
  }
  .polyhelm-card .all-btn {
    background: transparent;
    color: var(--text-dim, #888);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 1px 6px;
    font-size: 0.55rem;
    cursor: pointer;
  }
  .polyhelm-card .all-btn:hover { color: var(--text, #d8dde6); border-color: #5a6172; }
  .polyhelm-card .ch-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 3px;
  }
  .polyhelm-card .ch-btn {
    background: #0a0c11;
    color: var(--text-dim, #666);
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 4px 2px;
    font-size: 0.6rem;
    cursor: pointer;
    text-align: center;
  }
  .polyhelm-card .ch-btn.on {
    background: var(--cable-audio, #6cc);
    color: #000;
    border-color: var(--cable-audio, #6cc);
    font-weight: 600;
  }
  .polyhelm-card .readout {
    margin-top: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .polyhelm-card .readout-row {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    font-family: var(--mono, ui-monospace, monospace);
  }
  .polyhelm-card .readout-row .val {
    color: var(--fg, #eee);
    font-weight: 600;
  }
</style>
