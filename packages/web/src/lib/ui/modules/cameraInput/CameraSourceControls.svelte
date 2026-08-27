<script lang="ts">
  // The three things a CAMERA needs that are not ParamDefs — the DEVICE PICKER,
  // the capture LAMP and the ACQUIRE gesture — as one component both of the
  // module's surfaces mount.
  //
  // ⚠ IT EXISTS BECAUSE THESE WERE REACHABLE ONLY WHEN EXPANDED. The extension
  // filled `fullViewBody` and nothing else, so the picker and — far worse — the
  // only clickable route to `getUserMedia` lived in the DOCK FULL VIEW alone. On
  // the lane tile the module had no way to choose a camera and no way to START
  // one, which read to the owner as "the card has no way to pick sources" and
  // "no video on the thumbnail until it's expanded". Those are one bug: the
  // thumbnail was honest, there was simply no stream to show.
  //
  // ⚠ IT IS NOT A SECOND OWNER, and that constraint is inherited whole from
  // `CameraInputOutputBody`. `getUserMedia`, the MediaStream and the permission
  // state machine stay on `CameraInputCard`. This READS a published status and
  // INVOKES a registered command through `$lib/ui/media/camera-status-registry`
  // — a remote control, not a second machine. Two callers would be two owners,
  // and whichever tore down last would strand the survivor. It ENUMERATES
  // devices (which needs no permission and no stream) and it WRITES the shared
  // `node.data.deviceId` the card already re-acquires from; it never calls
  // `getUserMedia` itself.
  //
  // ⚠ `testidPrefix` IS NOT COSMETIC. A faced module's lane tile and its dock
  // full view can be on screen AT THE SAME TIME, so a single hardcoded testid
  // would resolve to two elements and every Playwright strict locator over it
  // would throw. Each mount site passes its own prefix.

  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import { cameraStatus, type CameraStatus } from '$lib/ui/media/camera-status-registry';

  interface Props {
    nodeId: string;
    /** Distinguishes this mount's testids from the module's other surface. */
    testidPrefix: string;
    /** Tile mounts drop the error/rebind prose — there is no room for a
     *  paragraph at 192px, and the full view carries it verbatim. The LAMP still
     *  reports the state, and its title is the same sentence. */
    compact?: boolean;
  }
  let { nodeId, testidPrefix, compact = false }: Props = $props();

  // ── DEVICE PICKER ─────────────────────────────────────────────────────────
  //
  // ⚠ ENUMERATION ONLY — this never calls `getUserMedia`. Without permission the
  // browser returns ids with EMPTY labels, which is why the fallback name below
  // is the id prefix rather than a blank row.
  let devices = $state<{ deviceId: string; label: string }[]>([]);
  let enumerateFailed = $state(false);

  let savedDeviceId = $derived<string | null>(
    (patch.nodes[nodeId]?.data?.deviceId as string | undefined) ?? null,
  );

  async function refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
      enumerateFailed = false;
    } catch {
      devices = [];
      enumerateFailed = true;
    }
  }

  $effect(() => {
    void refreshDevices();
    // Labels de-redact the moment permission lands, and the roster changes when
    // hardware is plugged in — both arrive as `devicechange`.
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.addEventListener) return;
    const onChange = () => void refreshDevices();
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  });

  function pickDevice(deviceId: string): void {
    if (!deviceId) return;
    // ⚠ WRITES THE SHARED KEY THE CARD ALREADY READS. The card re-acquires from
    // it, so the pick reaches the stream without this touching `getUserMedia`.
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.deviceId = deviceId;
    });
  }

  // ── LAMP / ERROR / ACQUIRE ────────────────────────────────────────────────
  let live = $state<CameraStatus | null>(null);
  let commandable = $state(false);

  $effect(() => {
    const id = nodeId;
    const sync = (): void => {
      live = cameraStatus.read(id);
      commandable = cameraStatus.hasCommands(id);
    };
    sync();
    return cameraStatus.subscribe(id, sync);
  });

  let enabled = $derived<boolean>(
    ((patch.nodes[nodeId]?.params?.enabled as number | undefined) ?? 1) > 0.5,
  );

  type Lamp = 'no-card' | 'no-device' | 'paused' | 'requesting' | 'error' | 'armed' | 'streaming';
  let lamp = $derived<Lamp>(
    !live ? 'no-card'
      : live.state === 'streaming' ? 'streaming'
      : live.state === 'requesting' ? 'requesting'
      : live.state === 'paused' || !enabled ? 'paused'
      : live.state === 'idle' ? (savedDeviceId ? 'armed' : 'no-device')
      : 'error',
  );

  const LAMP_TITLE: Record<Lamp, string> = {
    'no-card': 'No CAMERA surface is mounted for this node yet — nothing has reported a capture state.',
    'no-device': 'No camera chosen yet — pick one from the list.',
    paused: 'Capture is paused (the ON control is off). The device stays selected and the hardware is released.',
    requesting: 'Asking the browser for the camera…',
    error: 'Capture is not running — see the message below.',
    armed: 'A camera is selected and capture is on, but no frames are arriving yet. Use REQUEST ACCESS to grant permission.',
    streaming: 'Capture is running: frames are arriving and feeding OUT.',
  };

  let errorMsg = $derived<string | null>(live?.errorMsg ?? null);
  let rebindNotice = $derived<string | null>(live?.rebindNotice ?? null);

  /**
   * ⚠ THE ONLY ROUTE TO getUserMedia IN THE DEFAULT SHELL. The card's button is
   * off-screen and `pointer-events: none`; this is the gesture that reaches it.
   * It must stay a real click on a real `<button>` — the browser grants a first
   * permission only from a genuine activation context.
   */
  function requestAccess(): void {
    const res = cameraStatus.request(nodeId);
    if (!res.delivered) {
      console.warn('[cameraInput] REQUEST ACCESS reached no card for node', nodeId);
    }
  }

  let canRequest = $derived<boolean>(
    commandable && (live?.deviceCount ?? 0) > 0 && live?.state !== 'requesting',
  );
</script>

{#if !compact && errorMsg}
  <p class="error" role="alert" data-testid="{testidPrefix}-error">{errorMsg}</p>
{/if}

{#if !compact && rebindNotice}
  <p class="rebind" role="status" data-testid="{testidPrefix}-rebind">{rebindNotice}</p>
{/if}

<div class="picker-row" class:compact>
  <span
    class="lamp"
    data-testid="{testidPrefix}-lamp"
    data-lamp={lamp}
    role="img"
    aria-label={LAMP_TITLE[lamp]}
    title={LAMP_TITLE[lamp]}
  ></span>
  <select
    class="device-select nodrag"
    data-testid="{testidPrefix}-device-select"
    value={savedDeviceId ?? ''}
    onchange={(e) => pickDevice((e.currentTarget as HTMLSelectElement).value)}
    disabled={devices.length === 0}
    aria-label="Camera device"
  >
    {#if enumerateFailed}
      <option value="">cameras unavailable</option>
    {:else if devices.length === 0}
      <option value="">no cameras</option>
    {:else}
      {#if !savedDeviceId}
        <option value="" disabled selected>pick a camera</option>
      {/if}
      {#each devices as d (d.deviceId)}
        <option value={d.deviceId} selected={d.deviceId === savedDeviceId}>
          {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
        </option>
      {/each}
    {/if}
  </select>

  <button
    type="button"
    class="acquire nodrag"
    onclick={requestAccess}
    disabled={!canRequest}
    data-testid="{testidPrefix}-request-access"
    data-can-request={canRequest ? 'true' : 'false'}
    title={canRequest
      ? 'Ask the browser for this camera. Grants permission on first use, and retries after a failure.'
      : 'Unavailable: no camera surface is mounted for this node, no camera was found, or a request is already in flight.'}
  >{live?.state === 'permission-denied'
      ? (compact ? 'RETRY' : 'RETRY IN SETTINGS')
      : live?.state === 'streaming'
        ? (compact ? 'RE-ACQ' : 'RE-ACQUIRE')
        : (compact ? 'ENABLE' : 'REQUEST ACCESS')}</button>
</div>

<style>
  .picker-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    max-width: 480px;
  }
  .picker-row.compact {
    gap: 4px;
    max-width: 100%;
  }
  .lamp {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--text-dim);
    opacity: 0.5;
  }
  .lamp[data-lamp='streaming'] { background: var(--accent); opacity: 1; box-shadow: 0 0 4px var(--accent); }
  .lamp[data-lamp='armed'] { background: var(--accent); opacity: 0.75; }
  .lamp[data-lamp='requesting'],
  .lamp[data-lamp='paused'] { background: var(--warn, #c9a227); opacity: 1; }
  .lamp[data-lamp='error'] { background: #dc2626; opacity: 1; }
  /* `no-card` / `no-device` keep the dim default — nothing is wrong, nothing is
     running. A red lamp for "you have not picked a camera yet" would cry wolf. */

  .rebind {
    margin: 4px 0 0;
    font-size: 0.6rem;
    line-height: 1.35;
    color: var(--text-dim);
    border-left: 2px solid var(--cable-video);
    padding-left: 6px;
  }
  .error {
    margin: 0;
    width: 100%;
    max-width: 480px;
    font-size: 0.65rem;
    color: #fca5a5;
    background: rgba(220, 38, 38, 0.08);
    border: 1px solid rgba(220, 38, 38, 0.3);
    padding: 4px 6px;
    border-radius: 2px;
    line-height: 1.3;
  }
  .acquire {
    flex: 0 0 auto;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border: 1px solid var(--cable-video, var(--border));
    border-radius: 2px;
    background: rgba(244, 114, 182, 0.12);
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
  }
  .picker-row.compact .acquire { font-size: 0.5rem; padding: 2px 5px; letter-spacing: 0.04em; }
  .acquire:hover:not(:disabled) { background: rgba(244, 114, 182, 0.2); }
  .acquire:disabled { opacity: 0.4; cursor: not-allowed; }
  .acquire:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .device-select {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.6rem;
    padding: 2px 4px;
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 2px;
  }
  .picker-row.compact .device-select { font-size: 0.55rem; padding: 1px 3px; }
</style>
