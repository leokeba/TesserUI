<script lang="ts" module>
  // What the bridge lists (bridge/bridge.mjs): the nodes it found over mDNS,
  // with their device id when they give it, and serial ports.
  export interface Nearby {
    nodes: { id: string; device: string | null; label: string; host: string; api: string; ws: string | null }[];
    ports: { path: string; name: string; ws: string }[];
  }

  // The bridge as a macOS executable, on the latest release (bridge/scripts/macos.mjs).
  const BRIDGE = 'https://github.com/leokeba/TesserUI/releases/latest/download/tesserui-bridge-macos-';
</script>

<script lang="ts">
  // The launcher's own ways to a node (DESIGN.md §9.7), after USB and
  // Bluetooth: an address on the network, the bridge, and installing
  // firmware on a board (§9.7.1).
  import { FLASHER } from '../flash/firmware';
  import Icon from '../Icon.svelte';
  import { useSession } from '../shared.svelte';

  let {
    pick,
    ble,
    nearby,
    look,
    bridge,
    open,
  }: {
    pick: (choose: () => Promise<void>) => void;
    ble: () => void;
    nearby: Nearby | null;
    look: () => Promise<void>;
    bridge: string;
    open: (api: string, ws?: string | null) => void;
  } = $props();
  const session = useSession();
  const t = (text: string) => session.t(text);
  let address = $state('');
  let looking = $state(false);

  // "192.168.1.20", "node.local:8080" or a full API URL.
  function connect(e: SubmitEvent) {
    e.preventDefault();
    pick(async () => {
      const url = new URL(/^\w+:\/\//.test(address) ? address : `http://${address.trim()}`);
      if (url.pathname === '/') url.pathname = '/api';
      open(url.href.replace(/\/$/, ''));
      address = '';
    });
  }

  // Installing firmware: flash.js, next to the page, loads when asked for.
  // The board it installs is reached over the line the flasher opened.
  const firmware = session.config.firmware;
  let installing = $state(false);
  let host: HTMLElement | undefined = $state();
  $effect(() => {
    if (!host) return;
    let stop: (() => void) | undefined;
    let gone = false;
    pick(async () => {
      const m = await import(/* @vite-ignore */ new URL(firmware!.flasher ?? FLASHER, location.href).href);
      if (!gone) stop = m.mount(host, { firmware, t: session.t.bind(session), connect: (c: never) => session.useSerial(c), bluetooth: ble });
    });
    return () => {
      gone = true;
      stop?.();
    };
  });
</script>

{#if firmware && 'serial' in navigator}
  <div class="way">
    <Icon name="download" />
    <p><b>{t('Install')}</b>{t('A firmware on a board, over USB.')}</p>
    {#if installing}<div class="flash" bind:this={host}></div>{:else}<button onclick={() => (installing = true)}>{t('Install firmware')}</button>{/if}
  </div>
{/if}
<form class="way" onsubmit={connect}>
  <Icon name="wifi" />
  <p>
    <b>{t('Network')}</b>{t('The browser asks to allow local network access, and the node must allow this page (CORS).')}
  </p>
  <span class="address">
    <input required bind:value={address} placeholder="192.168.1.20, node.local" aria-label={t('Address')} />
    <button class="primary">{t('Connect')}</button>
  </span>
</form>
<div class="way">
  <Icon name="link" />
  <p>
    <b>{t('Nearby')}</b>
    {#if nearby}
      {nearby.nodes.length ? t('The nodes the bridge finds are tabs, live in any browser.') : t('The bridge finds no node yet.')}
    {:else}
      {t('The bridge finds the nodes on your network (mDNS) and serves them live:')} <code>npx tesserui-bridge</code>,
      {t('or for macOS:')} <a href="{BRIDGE}arm64.zip">Apple silicon</a>, <a href="{BRIDGE}x64.zip">Intel</a>
    {/if}
  </p>
  {#if !nearby}
    <button disabled={looking} onclick={async () => ((looking = true), await look(), (looking = false))}>{t('Look for the bridge')}</button>
  {/if}
</div>
{#if !('serial' in navigator)}
  {#each nearby?.ports ?? [] as p (p.path)}
    <button class="way port" onclick={() => open(`${bridge}/s`, p.ws)}><Icon name="usb" /><b>{p.name}</b><span class="muted">{t('bridge')}</span></button>
  {/each}
{/if}

<style>
  .flash {
    flex: 1 1 100%;
  }
  .address {
    display: flex;
    gap: 8px;
    flex: 1 1 100%;
  }
  .address input {
    flex: 1;
    min-width: 0;
  }
  .port b {
    flex: 1;
    text-align: left;
  }
</style>
