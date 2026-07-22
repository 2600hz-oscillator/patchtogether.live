<script lang="ts">
  // AddModuleSheet — the full-screen [+] picker (spec §3 RACK · Add).
  // Hardcoded MOBILE_MODULE_TYPES grouped Sound/Shape/Sequence/Mix/Video.
  // Cap-blocked tiles disabled with "N/N" (wouldExceedCap; cameraInput max 4,
  // timelorde max 1). One-liners are mobile-local copy: the desktop
  // DESCRIPTIONS map is not exported and lives in the ?raw-parsing manifest
  // module, which has no business in the phone bundle.
  import { lookupDefWithDomain, typeAtCap, typeCount } from '$lib/mobile/mobile-host';

  interface Props {
    open: boolean;
    onclose: () => void;
    onadd: (type: string) => void;
  }
  let { open, onclose, onadd }: Props = $props();

  interface Tile {
    type: string;
    blurb: string;
  }
  const GROUPS: { label: string; tiles: Tile[] }[] = [
    {
      label: 'Sound',
      tiles: [
        { type: 'analogVco', blurb: 'analog-style oscillator — saw / square / triangle / sine' },
        { type: 'drummergirl', blurb: 'gate-triggered drum voice (kick / snare / hat morph)' },
        { type: 'audioIn', blurb: 'your mic or line input as a source' },
      ],
    },
    {
      label: 'Shape',
      tiles: [
        { type: 'adsr', blurb: 'gate-triggered envelope — shapes notes over time' },
        { type: 'vca', blurb: 'voltage-controlled amp — the envelope’s hand on the volume' },
        { type: 'delay', blurb: 'echoes. time / feedback / mix' },
        { type: 'reverb', blurb: 'algorithmic space. size / damp / mix' },
      ],
    },
    {
      label: 'Sequence',
      tiles: [
        { type: 'sequencer', blurb: '32-step sequencer with its own clock' },
        { type: 'timelorde', blurb: 'the master clock — one per rack' },
      ],
    },
    {
      label: 'Mix',
      tiles: [
        { type: 'mixmstrs', blurb: '6-channel mixer with EQ, comp and sends (the MIX tab)' },
        { type: 'audioOut', blurb: 'the speakers. patch master L/R here' },
      ],
    },
    {
      label: 'Video',
      tiles: [
        { type: 'cameraInput', blurb: 'your camera as a video source' },
        { type: 'bentbox', blurb: 'CRT video bender — the glitch cam engine' },
      ],
    },
  ];

  function capLabel(type: string): string | null {
    const { def } = lookupDefWithDomain(type);
    if (def?.maxInstances === undefined) return null;
    return `${typeCount(type)}/${def.maxInstances}`;
  }

  function labelFor(type: string): string {
    const { def } = lookupDefWithDomain(type);
    return def?.label ?? type.toLowerCase();
  }
</script>

{#if open}
  <div class="sheet" data-testid="m-add-sheet">
    <header class="sheet-head">
      <span class="sheet-title">add a module</span>
      <button class="close-btn" onclick={onclose} data-testid="m-add-close">close</button>
    </header>
    <div class="groups">
      {#each GROUPS as group (group.label)}
        <section>
          <h3>{group.label}</h3>
          <div class="tiles">
            {#each group.tiles as tile (tile.type)}
              {@const atCap = typeAtCap(tile.type)}
              <button
                class="tile"
                disabled={atCap}
                onclick={() => onadd(tile.type)}
                data-testid={`m-add-${tile.type}`}
              >
                <span class="tile-label">
                  {labelFor(tile.type)}
                  {#if atCap}<span class="cap">{capLabel(tile.type)}</span>{/if}
                </span>
                <span class="tile-blurb">{tile.blurb}</span>
              </button>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  </div>
{/if}

<style>
  .sheet {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: #0e1116;
    display: flex;
    flex-direction: column;
    padding-top: env(safe-area-inset-top);
  }
  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #2a2f3a;
  }
  .sheet-title {
    font-size: 16px;
    font-weight: 700;
    color: #dbe2ee;
  }
  .close-btn {
    min-height: 44px;
    padding: 0 16px;
    border-radius: 22px;
    border: 1px solid #2a2f3a;
    background: none;
    color: #8b93a3;
    font-size: 14px;
  }
  .groups {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px calc(24px + env(safe-area-inset-bottom));
  }
  h3 {
    margin: 14px 4px 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #8b93a3;
  }
  .tiles {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    min-height: 60px;
    padding: 10px 14px;
    border-radius: 12px;
    border: 1px solid #2a2f3a;
    background: rgba(255, 255, 255, 0.03);
    color: #dbe2ee;
    text-align: left;
  }
  .tile:disabled {
    opacity: 0.4;
  }
  .tile-label {
    font-size: 15px;
    font-weight: 700;
    text-transform: lowercase;
  }
  .cap {
    margin-left: 8px;
    font-size: 12px;
    color: #ff8b8b;
    font-weight: 600;
  }
  .tile-blurb {
    font-size: 12.5px;
    color: #8b93a3;
  }
</style>
