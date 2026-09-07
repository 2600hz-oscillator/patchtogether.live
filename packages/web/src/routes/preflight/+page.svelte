<script lang="ts">
  // Pre-flight (Stage-1) rig setup — one row per device class. Each row shows
  // LIVE presence and a single control that writes the per-machine rig store
  // (device-slot-bindings.ts). Device access is reused from the app's own code
  // (screen-identity, the camera enumerate/getUserMedia pattern, the push2 /
  // launchpad / ptz-midi rosters); this screen never reinvents enumeration.
  //
  // Two backends behind the store: under the native shell it round-trips through
  // the `bindings.*` bridge ops (electron-store on disk); in a plain browser it
  // falls back to localStorage. So the same panel drives both, and "enter rack"
  // hands off through `preflight.done` (shell) or a client navigation (browser).
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { nativeAvailable } from '$lib/platform/native';
  import { testHooksEnabled } from '$lib/dev/test-hooks';
  import { rigBindings, type LaunchpadMode } from '$lib/graph/device-slot-bindings';
  import {
    CAMERA_SLOT_NAMES,
    OUTPUT_SLOT_NAMES,
    type CameraSlotName,
    type OutputSlotName,
  } from '$lib/graph/device-slots';
  import { screenKey } from '$lib/ui/modules/screen-identity';
  import {
    enumerateVideoInputs,
    enumerateLiveScreens,
    type LiveVideoInput,
    type LiveScreen,
  } from '$lib/graph/rig-relaunch-guard';
  import * as push2 from '$lib/control/push2/push2-device.svelte';
  import * as launchpad from '$lib/control/launchpad/launchpad-device.svelte';
  import { connectPtzMidi, listPtzOutputNames, ptzMidiVersion } from '$lib/audio/ptz-midi';

  interface PtNativeLike {
    command?: (
      op: string,
      payload?: unknown,
    ) => Promise<{ ok?: boolean; result?: unknown; error?: { retryable?: boolean; message?: string } }>;
    onEvent?: (topic: string, cb: (payload: unknown) => void) => () => void;
  }
  function ptNative(): PtNativeLike | null {
    const nat = (globalThis as unknown as { ptNative?: PtNativeLike }).ptNative;
    return nat && typeof nat.command === 'function' ? nat : null;
  }
  const shell = nativeAvailable();
  const store = rigBindings();
  const LAUNCHPAD_MODES: LaunchpadMode[] = ['tetris', 'launchcontrol', 'out-to-launch'];
  const ES9_POLICIES = ['auto', 'always', 'off'];

  // The rig snapshot, reactive: the store swaps the ref on every mutation, so a
  // plain re-read in the subscription re-renders the selects.
  let rig = $state(store.snapshot());

  // ── DISPLAYS ────────────────────────────────────────────────────────────
  let screens = $state<LiveScreen[]>([]);
  let screensDetected = $state(false);
  let screenError = $state<string | null>(null);
  async function detectDisplays(): Promise<void> {
    screenError = null;
    const live = await enumerateLiveScreens();
    if (live === null) {
      screenError = shell ? 'no displays reported' : 'this browser cannot enumerate displays';
      screens = [];
    } else {
      screens = live;
    }
    screensDetected = true;
  }
  function screenIdFor(slot: OutputSlotName): string {
    const bound = rig.outputs[slot]?.screen;
    if (!bound) return '';
    const key = screenKey(bound);
    return screens.find((s) => screenKey(s.descriptor) === key)?.id ?? '';
  }
  function displayMissing(slot: OutputSlotName): boolean {
    return !!rig.outputs[slot] && screensDetected && screenIdFor(slot) === '';
  }
  function pickDisplay(slot: OutputSlotName, id: string): void {
    if (id === '' || id === '__missing__') {
      if (id === '') store.setOutput(slot, null);
      return;
    }
    const hit = screens.find((s) => s.id === id);
    if (hit) store.setOutput(slot, { screen: hit.descriptor });
  }

  // ── CAMERAS ─────────────────────────────────────────────────────────────
  let cameras = $state<LiveVideoInput[]>([]);
  let cameraLabelsUnlocked = $state(false);
  let cameraError = $state<string | null>(null);
  async function refreshCameras(): Promise<void> {
    const list = await enumerateVideoInputs();
    cameras = list ?? [];
    cameraLabelsUnlocked = cameras.some((c) => c.label !== '');
  }
  async function grantCameraAccess(): Promise<void> {
    cameraError = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      // Only the grant was needed (it de-redacts labels); stop the tracks now.
      for (const t of stream.getTracks()) t.stop();
    } catch (e) {
      cameraError = (e as Error)?.message ?? 'camera access denied';
    }
    await refreshCameras();
  }
  function cameraMatchesBinding(slot: CameraSlotName): LiveVideoInput | null {
    const b = rig.cameras[slot];
    if (!b) return null;
    return (
      cameras.find((c) => b.deviceId !== '' && c.deviceId === b.deviceId) ??
      (b.deviceLabel ? cameras.find((c) => c.label === b.deviceLabel) : undefined) ??
      null
    );
  }
  function cameraSelectValue(slot: CameraSlotName): string {
    const b = rig.cameras[slot];
    if (!b) return '';
    return cameraMatchesBinding(slot)?.deviceId ?? b.deviceId; // stored id backs a synthetic option
  }
  function cameraMissing(slot: CameraSlotName): boolean {
    return !!rig.cameras[slot] && cameraMatchesBinding(slot) === null;
  }
  function pickCamera(slot: CameraSlotName, deviceId: string): void {
    if (deviceId === '') {
      store.setCamera(slot, null);
      return;
    }
    const hit = cameras.find((c) => c.deviceId === deviceId);
    store.setCamera(slot, { deviceId, deviceLabel: hit?.label || undefined });
  }

  // ── HELPERS (ES-9 + PTZ) — shell only ─────────────────────────────────────
  interface HS {
    id: string;
    state: string;
    detail: string | null;
  }
  let helperStatus = $state<Record<string, { state: string; detail: string | null }>>({});
  let helperCmdFailed = $state(false);
  let helperCmdRetryable = $state(false);
  async function refreshHelpers(): Promise<void> {
    const nat = ptNative();
    if (!nat?.command) return;
    try {
      const res = await nat.command('helpers.status');
      if (res && res.ok) {
        const r = res.result as { current?: HS[]; history?: HS[] };
        const map: Record<string, { state: string; detail: string | null }> = {};
        for (const s of r.history ?? []) map[s.id] = { state: s.state, detail: s.detail };
        for (const s of r.current ?? []) map[s.id] = { state: s.state, detail: s.detail };
        helperStatus = map;
        helperCmdFailed = false;
        helperCmdRetryable = false;
      } else {
        // The pre-flight retry affordance keys off `error.retryable`, not a
        // string match (bridge-protocol.ts).
        helperCmdFailed = true;
        helperCmdRetryable = res?.error?.retryable === true;
      }
    } catch {
      helperCmdFailed = true;
      helperCmdRetryable = true; // a thrown call is transient by nature
    }
  }
  let unsubHelpers: (() => void) | null = null;
  function setEs9Policy(pushPolicy: string): void {
    store.setEs9({ pushPolicy });
  }

  // ── PUSH 2 ────────────────────────────────────────────────────────────────
  let push2Ports = $derived.by(() => {
    push2.statusRune();
    return push2.hasAccess() ? push2.enumeratePush2Ports() : [];
  });
  let push2Scanned = $state(false);
  async function connectPush2(): Promise<void> {
    await push2.connect();
    push2Scanned = true;
  }
  function pickPush2(inputId: string): void {
    store.setPush(inputId === '' ? null : { deviceId: inputId });
  }
  function push2Present(): boolean {
    const b = rig.push;
    return !!b && push2Ports.some((p) => p.inputId === b.deviceId);
  }

  // ── LAUNCHPAD ─────────────────────────────────────────────────────────────
  let lpPorts = $derived.by(() => {
    launchpad.statusRune();
    return launchpad.hasAccess() ? launchpad.enumerateLaunchpadPorts() : [];
  });
  let lpScanned = $state(false);
  async function connectLaunchpad(): Promise<void> {
    await launchpad.connect();
    lpScanned = true;
  }
  function pickLaunchpad(inputId: string): void {
    if (inputId === '') {
      store.setLaunchpad(null);
      return;
    }
    store.setLaunchpad({ deviceId: inputId, mode: rig.launchpad?.mode ?? 'tetris' });
  }
  function setLaunchpadMode(mode: LaunchpadMode): void {
    const deviceId = rig.launchpad?.deviceId;
    if (deviceId) store.setLaunchpad({ deviceId, mode });
  }
  function launchpadPresent(): boolean {
    const b = rig.launchpad;
    return !!b && lpPorts.some((p) => p.inputId === b.deviceId);
  }

  // ── PTZ ─────────────────────────────────────────────────────────────────
  let ptzNames = $derived.by(() => {
    $ptzMidiVersion;
    return listPtzOutputNames();
  });
  let ptzScanned = $state(false);
  async function connectPtz(): Promise<void> {
    await connectPtzMidi();
    ptzScanned = true;
  }
  function pickPtz(name: string): void {
    store.setPtz(name === '' ? null : { deviceId: name });
  }
  function ptzPresent(): boolean {
    const b = rig.ptz;
    return !!b && ptzNames.includes(b.deviceId);
  }

  // ── GAMEPAD ───────────────────────────────────────────────────────────────
  let gamepads = $state<{ id: string; index: number }[]>([]);
  function pollGamepads(): void {
    const pads = (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p);
    gamepads = pads.map((p) => ({ id: p.id, index: p.index }));
  }
  function pickGamepad(indexStr: string): void {
    if (indexStr === '') {
      store.setGamepad(null);
      return;
    }
    const hit = gamepads.find((g) => g.index === Number(indexStr));
    if (hit) store.setGamepad({ id: hit.id, index: hit.index });
  }
  function gamepadSelectValue(): string {
    const b = rig.gamepad;
    if (!b) return '';
    const byId = gamepads.find((g) => g.id === b.id);
    return byId ? String(byId.index) : b.index !== undefined ? String(b.index) : '';
  }
  function gamepadPresent(): boolean {
    const b = rig.gamepad;
    return !!b && gamepads.some((g) => g.id === b.id);
  }
  function gamepadMissing(): boolean {
    return !!rig.gamepad && !gamepadPresent();
  }
  let gamepadTimer: ReturnType<typeof setInterval> | null = null;

  // ── LIFECYCLE ─────────────────────────────────────────────────────────────
  let unsubStore: (() => void) | null = null;
  const onDeviceChange = (): void => void refreshCameras();
  onMount(() => {
    unsubStore = store.subscribe(() => {
      rig = store.snapshot();
    });
    void store.whenReady().then(() => {
      rig = store.snapshot();
    });
    void refreshCameras();
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    pollGamepads();
    window.addEventListener('gamepadconnected', pollGamepads);
    window.addEventListener('gamepaddisconnected', pollGamepads);
    gamepadTimer = setInterval(pollGamepads, 500);
    if (shell) {
      void refreshHelpers();
      unsubHelpers =
        ptNative()?.onEvent?.('helpers.status', (payload) => {
          const s = payload as HS;
          if (s && typeof s.id === 'string') {
            helperStatus = { ...helperStatus, [s.id]: { state: s.state, detail: s.detail } };
          }
        }) ?? null;
    }
    if (testHooksEnabled()) {
      (globalThis as unknown as { __rigBindings?: () => unknown }).__rigBindings = () =>
        store.snapshot();
      (globalThis as unknown as { __preflightReady?: boolean }).__preflightReady = true;
    }
  });
  onDestroy(() => {
    unsubStore?.();
    unsubHelpers?.();
    navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
    window.removeEventListener?.('gamepadconnected', pollGamepads);
    window.removeEventListener?.('gamepaddisconnected', pollGamepads);
    if (gamepadTimer) clearInterval(gamepadTimer);
  });

  // ── ENTER RACK ────────────────────────────────────────────────────────────
  let entering = $state(false);
  async function enterRack(): Promise<void> {
    if (entering) return;
    entering = true;
    const nat = ptNative();
    if (shell && nat?.command) {
      try {
        await nat.command('preflight.done');
        return; // the shell is loading /rack; this document is going away
      } catch {
        /* fall through to a client navigation */
      }
    }
    await goto('/rack');
  }

  // helper state → lamp bucket (ok / down / wait / idle)
  function lamp(state: string | undefined): 'ok' | 'down' | 'wait' | 'idle' {
    if (!state) return 'idle';
    if (state === 'running') return 'ok';
    if (state === 'stopped' || state === 'crash-looped' || state === 'foreign-listener') return 'down';
    return 'wait';
  }
</script>

<svelte:head><title>rig setup · patchtogether</title></svelte:head>

<main class="preflight" data-testid="preflight-panel">
  <header class="head">
    <h1>rig setup</h1>
    <p class="lede">
      Connect your rig before the rack opens. What you bind here is per-machine —
      it survives a File→New, a reload, and a relaunch.
    </p>
  </header>

  <!-- DISPLAYS -->
  <section class="group" data-testid="preflight-section-displays">
    <div class="group-head">
      <h2>displays</h2>
      <button class="ghost" data-testid="preflight-displays-detect" onclick={detectDisplays}>
        detect displays
      </button>
    </div>
    {#if screenError}<p class="err" data-testid="preflight-displays-error">{screenError}</p>{/if}
    {#each OUTPUT_SLOT_NAMES as slot (slot)}
      {@const bound = screenIdFor(slot) !== ''}
      {@const missing = displayMissing(slot)}
      <div class="row" data-testid="preflight-output-row" data-slot={slot}>
        <span class="label">{slot}</span>
        <span
          class="lamp"
          data-testid="preflight-output-presence"
          data-slot={slot}
          data-state={missing ? 'down' : bound ? 'ok' : 'idle'}
        >
          {missing ? 'not connected' : bound ? 'connected' : screensDetected ? 'unbound' : 'not scanned'}
        </span>
        <select
          class="control"
          data-testid="preflight-output-select"
          data-slot={slot}
          value={missing ? '__missing__' : screenIdFor(slot)}
          onchange={(e) => pickDisplay(slot, e.currentTarget.value)}
        >
          <option value="">— none —</option>
          {#if missing}
            <option value="__missing__" disabled
              >bound: {rig.outputs[slot]?.screen.label || 'display'} (not connected)</option
            >
          {/if}
          {#each screens as s (s.id)}
            <option value={s.id}>{s.descriptor.label || 'unnamed display'} · {s.descriptor.width}×{s.descriptor.height}</option>
          {/each}
        </select>
      </div>
    {/each}
  </section>

  <!-- CAMERAS -->
  <section class="group" data-testid="preflight-section-cameras">
    <div class="group-head">
      <h2>cameras</h2>
      <button class="ghost" data-testid="preflight-cameras-grant" onclick={grantCameraAccess}>
        {cameraLabelsUnlocked ? 'rescan cameras' : 'grant camera access'}
      </button>
    </div>
    {#if cameraError}<p class="err" data-testid="preflight-cameras-error">{cameraError}</p>{/if}
    {#each CAMERA_SLOT_NAMES as slot (slot)}
      {@const present = !!rig.cameras[slot] && !cameraMissing(slot)}
      {@const missing = cameraMissing(slot)}
      <div class="row" data-testid="preflight-camera-row" data-slot={slot}>
        <span class="label">{slot}</span>
        <span
          class="lamp"
          data-testid="preflight-camera-presence"
          data-slot={slot}
          data-state={missing ? 'down' : present ? 'ok' : 'idle'}
        >
          {missing ? 'not connected' : present ? 'connected' : 'unbound'}
        </span>
        <select
          class="control"
          data-testid="preflight-camera-select"
          data-slot={slot}
          value={cameraSelectValue(slot)}
          onchange={(e) => pickCamera(slot, e.currentTarget.value)}
        >
          <option value="">— none —</option>
          {#if missing}
            <option value={rig.cameras[slot]?.deviceId} disabled
              >bound: {rig.cameras[slot]?.deviceLabel || 'camera'} (not connected)</option
            >
          {/if}
          {#each cameras as c (c.deviceId)}
            <option value={c.deviceId}>{c.label || `camera ${c.deviceId.slice(0, 6)}`}</option>
          {/each}
        </select>
      </div>
    {/each}
  </section>

  <!-- ES-9 -->
  <section class="group" data-testid="preflight-section-es9">
    <div class="group-head"><h2>es-9</h2></div>
    {#if !shell}
      <div class="row">
        <span class="label">es-9</span>
        <span class="lamp" data-testid="preflight-es9-state" data-state="idle">native shell only</span>
      </div>
    {:else}
      {@const es9 = helperStatus['es9']}
      <div class="row">
        <span class="label">helper</span>
        <span class="lamp" data-testid="preflight-es9-state" data-state={lamp(es9?.state)}>
          {es9 ? es9.state : helperCmdFailed ? 'unknown' : 'checking…'}{es9?.detail
            ? ` — ${es9.detail}`
            : ''}
        </span>
        {#if helperCmdFailed && helperCmdRetryable}
          <button class="ghost" data-testid="preflight-es9-retry" onclick={refreshHelpers}>retry</button>
        {/if}
      </div>
      <div class="row">
        <span class="label">output push</span>
        <span class="lamp" data-state={rig.es9 ? 'ok' : 'idle'}>{rig.es9 ? 'configured' : 'default'}</span>
        <select
          class="control"
          data-testid="preflight-es9-config"
          value={rig.es9?.pushPolicy ?? 'auto'}
          onchange={(e) => setEs9Policy(e.currentTarget.value)}
        >
          {#each ES9_POLICIES as p (p)}<option value={p}>{p}</option>{/each}
        </select>
      </div>
    {/if}
  </section>

  <!-- PUSH 2 -->
  <section class="group" data-testid="preflight-section-push2">
    <div class="group-head">
      <h2>push 2</h2>
      <button class="ghost" data-testid="preflight-push2-connect" onclick={connectPush2}>
        {push2.hasAccess() ? 'rescan' : 'enable midi'}
      </button>
    </div>
    <div class="row">
      <span class="label">push 2</span>
      <span
        class="lamp"
        data-testid="preflight-push2-presence"
        data-state={rig.push && !push2Present() ? 'down' : push2Ports.length > 0 ? 'ok' : 'idle'}
      >
        {rig.push && !push2Present()
          ? 'not connected'
          : push2Ports.length > 0
            ? 'connected'
            : push2Scanned
              ? 'not found'
              : 'not scanned'}
      </span>
      <select
        class="control"
        data-testid="preflight-push2-select"
        value={rig.push?.deviceId ?? ''}
        onchange={(e) => pickPush2(e.currentTarget.value)}
      >
        <option value="">— none —</option>
        {#if rig.push && !push2Present()}
          <option value={rig.push.deviceId} disabled>bound (not connected)</option>
        {/if}
        {#each push2Ports as p (p.inputId)}<option value={p.inputId}>{p.name}</option>{/each}
      </select>
    </div>
  </section>

  <!-- LAUNCHPAD -->
  <section class="group" data-testid="preflight-section-launchpad">
    <div class="group-head">
      <h2>launchpad</h2>
      <button class="ghost" data-testid="preflight-launchpad-connect" onclick={connectLaunchpad}>
        {launchpad.hasAccess() ? 'rescan' : 'enable midi'}
      </button>
    </div>
    <div class="row">
      <span class="label">launchpad</span>
      <span
        class="lamp"
        data-testid="preflight-launchpad-presence"
        data-state={rig.launchpad && !launchpadPresent() ? 'down' : lpPorts.length > 0 ? 'ok' : 'idle'}
      >
        {rig.launchpad && !launchpadPresent()
          ? 'not connected'
          : lpPorts.length > 0
            ? 'connected'
            : lpScanned
              ? 'not found'
              : 'not scanned'}
      </span>
      <select
        class="control"
        data-testid="preflight-launchpad-select"
        value={rig.launchpad?.deviceId ?? ''}
        onchange={(e) => pickLaunchpad(e.currentTarget.value)}
      >
        <option value="">— none —</option>
        {#if rig.launchpad && !launchpadPresent()}
          <option value={rig.launchpad.deviceId} disabled>bound (not connected)</option>
        {/if}
        {#each lpPorts as p (p.inputId)}<option value={p.inputId}>{p.name}</option>{/each}
      </select>
    </div>
    <div class="row">
      <span class="label">mode</span>
      <span class="lamp" data-state="idle"></span>
      <select
        class="control"
        data-testid="preflight-launchpad-mode"
        value={rig.launchpad?.mode ?? 'tetris'}
        disabled={!rig.launchpad}
        onchange={(e) => setLaunchpadMode(e.currentTarget.value as LaunchpadMode)}
      >
        {#each LAUNCHPAD_MODES as m (m)}<option value={m}>{m}</option>{/each}
      </select>
    </div>
  </section>

  <!-- PTZ -->
  <section class="group" data-testid="preflight-section-ptz">
    <div class="group-head">
      <h2>ptz camera</h2>
      <button class="ghost" data-testid="preflight-ptz-connect" onclick={connectPtz}>
        enable midi
      </button>
    </div>
    {#if shell}
      {@const ptzHelper = helperStatus['ptz']}
      <div class="row">
        <span class="label">helper</span>
        <span class="lamp" data-testid="preflight-ptz-state" data-state={lamp(ptzHelper?.state)}>
          {ptzHelper ? ptzHelper.state : helperCmdFailed ? 'unknown' : 'checking…'}{ptzHelper?.detail
            ? ` — ${ptzHelper.detail}`
            : ''}
        </span>
        {#if helperCmdFailed && helperCmdRetryable}
          <button class="ghost" data-testid="preflight-ptz-retry" onclick={refreshHelpers}>retry</button>
        {/if}
      </div>
    {/if}
    <div class="row">
      <span class="label">visca port</span>
      <span
        class="lamp"
        data-testid="preflight-ptz-presence"
        data-state={rig.ptz && !ptzPresent() ? 'down' : ptzNames.length > 0 ? 'ok' : 'idle'}
      >
        {rig.ptz && !ptzPresent()
          ? 'not connected'
          : ptzNames.length > 0
            ? 'connected'
            : ptzScanned
              ? 'no PT-PTZ port'
              : 'not scanned'}
      </span>
      <select
        class="control"
        data-testid="preflight-ptz-select"
        value={rig.ptz?.deviceId ?? ''}
        onchange={(e) => pickPtz(e.currentTarget.value)}
      >
        <option value="">— none —</option>
        {#if rig.ptz && !ptzPresent()}
          <option value={rig.ptz.deviceId} disabled>bound (not connected)</option>
        {/if}
        {#each ptzNames as n (n)}<option value={n}>{n}</option>{/each}
      </select>
    </div>
  </section>

  <!-- GAMEPAD -->
  <section class="group" data-testid="preflight-section-gamepad">
    <div class="group-head"><h2>gamepad</h2></div>
    <div class="row">
      <span class="label">gamepad</span>
      <span
        class="lamp"
        data-testid="preflight-gamepad-presence"
        data-state={gamepadMissing() ? 'down' : gamepads.length > 0 ? 'ok' : 'idle'}
      >
        {gamepadMissing()
          ? 'not connected'
          : gamepads.length > 0
            ? 'connected'
            : 'press a button'}
      </span>
      <select
        class="control"
        data-testid="preflight-gamepad-select"
        value={gamepadSelectValue()}
        onchange={(e) => pickGamepad(e.currentTarget.value)}
      >
        <option value="">— none —</option>
        {#if gamepadMissing()}
          <option value={String(rig.gamepad?.index ?? '')} disabled>bound: {rig.gamepad?.id} (not connected)</option>
        {/if}
        {#each gamepads as g (g.index)}<option value={String(g.index)}>{g.id}</option>{/each}
      </select>
    </div>
  </section>

  <footer class="foot">
    <button class="enter" data-testid="preflight-enter" onclick={enterRack} disabled={entering}>
      {entering ? 'opening rack…' : 'enter rack'}
    </button>
  </footer>
</main>

<style>
  .preflight {
    min-height: 100vh;
    padding: 2rem;
    background: #0d0f14;
    color: #e7e9ee;
    font: 14px/1.5 system-ui, -apple-system, sans-serif;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 44rem;
    margin: 0 auto;
    box-sizing: border-box;
  }
  .head h1 {
    margin: 0 0 0.35rem;
    font-size: 1.5rem;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .lede {
    margin: 0;
    color: #8b93a1;
    font-size: 13px;
  }
  .group {
    background: #161a22;
    border: 1px solid #262c38;
    border-radius: 12px;
    padding: 0.85rem 1rem 1rem;
  }
  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.4rem;
  }
  .group-head h2 {
    margin: 0;
    font-size: 0.82rem;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #a7b0c0;
  }
  .row {
    display: grid;
    grid-template-columns: 6.5rem 9.5rem 1fr;
    align-items: center;
    gap: 0.6rem;
    padding: 0.28rem 0;
  }
  .label {
    color: #c3c8d2;
    font-variant-numeric: tabular-nums;
  }
  .lamp {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 12px;
    color: #8b93a1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lamp::before {
    content: '';
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3a4150;
  }
  .lamp[data-state='ok']::before {
    background: #3ecf8e;
  }
  .lamp[data-state='down']::before {
    background: #f2617a;
  }
  .lamp[data-state='wait']::before {
    background: #e6b450;
  }
  .lamp[data-state='ok'] {
    color: #bfe9d4;
  }
  .lamp[data-state='down'] {
    color: #f4b3bf;
  }
  .control {
    appearance: none;
    width: 100%;
    background: #0f131b;
    color: #e7e9ee;
    border: 1px solid #2c3444;
    border-radius: 7px;
    padding: 0.4rem 0.55rem;
    font: inherit;
    font-size: 13px;
  }
  .control:disabled {
    opacity: 0.5;
  }
  .ghost {
    appearance: none;
    background: #1d2330;
    color: #cdd3de;
    border: 1px solid #2c3444;
    border-radius: 7px;
    padding: 0.3rem 0.7rem;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .ghost:hover {
    background: #262d3c;
  }
  .err {
    margin: 0.1rem 0 0.4rem;
    color: #f4b3bf;
    font-size: 12px;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    padding-top: 0.25rem;
  }
  .enter {
    appearance: none;
    border: 0;
    border-radius: 8px;
    padding: 0.7rem 1.5rem;
    font: inherit;
    font-weight: 600;
    color: #0d0f14;
    background: #7c5cff;
    cursor: pointer;
  }
  .enter:hover:not(:disabled) {
    background: #8f72ff;
  }
  .enter:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
