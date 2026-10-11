<script lang="ts">
  // Choosing a node (DESIGN.md §9.7): over USB or Bluetooth on any page, and
  // by address on a page that no node served (GitHub Pages), which also
  // lists the nodes it reached before.
  import { NUS_SERVICE } from './client/envelope';
  import Icon from './Icon.svelte';
  import { useSession } from './shared.svelte';
  import { recentNodes } from './store/session.svelte';

  const session = useSession();
  const t = (text: string) => session.t(text);
  const nav = navigator as unknown as {
    serial?: { requestPort(): Promise<never> };
    bluetooth?: { requestDevice(o: object): Promise<never> };
  };
  const recent = session.config.launcher ? recentNodes() : [];
  let error = $state('');
  let address = $state('');

  // The browser's chooser rejects with NotFoundError when it is dismissed.
  async function pick(choose: () => Promise<void>) {
    error = '';
    try {
      await choose();
    } catch (e) {
      if ((e as Error).name !== 'NotFoundError') error = (e as Error).message;
    }
  }

  // "192.168.1.20", "node.local:8080" or a full API URL.
  function open(e: SubmitEvent) {
    e.preventDefault();
    const url = new URL(/^\w+:\/\//.test(address) ? address : `http://${address.trim()}`);
    if (url.pathname === '/') url.pathname = '/api';
    location.search = `?api=${encodeURIComponent(url.href.replace(/\/$/, ''))}`;
  }
</script>

<section class="card connect">
  <h2>{t('Connect to a node')}</h2>
  {#if nav.serial}
    <div class="way">
      <Icon name="usb" />
      <p><b>USB</b>{t('A board on its serial port, or a NowTP gateway reaching the nodes around it.')}</p>
      <button class="primary" onclick={() => pick(async () => session.useSerial(await nav.serial!.requestPort()))}>{t('Choose a port')}</button>
    </div>
  {/if}
  {#if nav.bluetooth}
    <div class="way">
      <Icon name="bluetooth" />
      <p><b>Bluetooth</b>{t('A node nearby with a Bluetooth transport.')}</p>
      <button
        class="primary"
        onclick={() => pick(async () => session.useBle(await nav.bluetooth!.requestDevice({ filters: [{ services: [NUS_SERVICE] }] })))}
      >
        {t('Choose a device')}
      </button>
    </div>
  {/if}
  {#if !nav.serial || !nav.bluetooth}
    <p class="muted">{t('USB and Bluetooth need a Chromium-based browser (Chrome, Edge, Opera).')}</p>
  {/if}
  {#if session.config.launcher}
    <form class="way" onsubmit={open}>
      <Icon name="wifi" />
      <p>
        <b>{t('Network')}</b>{t('The browser asks to allow local network access, and the node must allow this page (CORS).')}
      </p>
      <span class="address">
        <input required bind:value={address} placeholder="192.168.1.20" aria-label={t('Address')} />
        <button class="primary">{t('Connect')}</button>
      </span>
    </form>
    {#each recent as r (r.api)}
      <a class="way recent" href="?api={encodeURIComponent(r.api)}"><Icon name="clock" /><b>{r.label}</b><span class="muted">{new URL(r.api).host}</span></a>
    {/each}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .connect {
    max-width: 480px;
    margin: 48px auto;
    display: grid;
    gap: 16px;
  }
  .connect > :global(*) {
    margin: 0;
  }
  .way {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .way p {
    flex: 1 1 200px;
    margin: 0;
  }
  .way b {
    display: block;
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
  .recent {
    color: inherit;
    text-decoration: none;
  }
  .recent b {
    flex: 1;
  }
</style>
