<script lang="ts">
  // Choosing a node (DESIGN.md §9.7): over USB or Bluetooth on any page, and
  // on a page that no node served (GitHub Pages), by address, among the
  // nodes the bridge finds on the network, or among those reached before.
  import { NUS_SERVICE } from './client/envelope';
  import { FLASHER } from './flash/firmware';
  import Icon from './Icon.svelte';
  import { useSession } from './shared.svelte';
  import { recentNodes } from './store/session.svelte';

  const session = useSession();
  const t = (text: string) => session.t(text);
  const nav = navigator as unknown as {
    serial?: { requestPort(o: object): Promise<never> };
    bluetooth?: { requestDevice(o: object): Promise<never> };
  };
  // Serial ports include Bluetooth ones (SPP), paired with the system: the
  // only serial ports Chrome on Android can open.
  const SPP = '00001101-0000-1000-8000-00805f9b34fb';
  const launcher = !!session.config.launcher;
  const recent = launcher ? recentNodes() : [];
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
  const serial = () => pick(async () => session.useSerial(await nav.serial!.requestPort({ allowedBluetoothServiceClassIds: [SPP] })));
  const ble = () => pick(async () => session.useBle(await nav.bluetooth!.requestDevice({ filters: [{ services: [NUS_SERVICE] }] })));

  // Installing firmware (§9.7.1): flash.js, next to the page, loads when
  // asked for, so nothing of it is in this bundle.
  const firmware = session.config.firmware;
  let host: HTMLElement | undefined = $state();
  $effect(() => {
    if (!host) return;
    let stop: (() => void) | undefined;
    let gone = false;
    import(/* @vite-ignore */ new URL(firmware!.flasher ?? FLASHER, location.href).href).then(
      (m) => {
        if (!gone) stop = m.mount(host, { firmware, t: session.t.bind(session), connect: (c: never) => session.useSerial(c), bluetooth: ble });
      },
      (e: Error) => (error = e.message),
    );
    return () => {
      gone = true;
      stop?.();
    };
  });
  let installing = $state(false);

  // A node's page in this launcher; ws: null means HTTP only.
  const link = (api: string, ws?: string | null) =>
    `?api=${encodeURIComponent(api)}${ws === undefined ? '' : `&ws=${encodeURIComponent(ws ?? '')}`}`;
  // Where a node is: its host, or the address behind the bridge's proxy.
  const where = (api: string) => {
    const m = api.match(/\/n\/([^/]+)\/api$/);
    return m ? `${decodeURIComponent(m[1]).replace(/:80$/, '')} · ${t('bridge')}` : new URL(api).host;
  };

  // "192.168.1.20", "node.local:8080" or a full API URL.
  function open(e: SubmitEvent) {
    e.preventDefault();
    const url = new URL(/^\w+:\/\//.test(address) ? address : `http://${address.trim()}`);
    if (url.pathname === '/') url.pathname = '/api';
    location.search = link(url.href.replace(/\/$/, ''));
  }

  // The bridge (tesserui-bridge, on this machine): the nodes it finds over
  // mDNS, and serial ports for browsers without Web Serial. A public page
  // reaching localhost makes Chrome ask first, so the first look is the
  // user's; after one answer, or on the bridge's own page, it is automatic.
  interface Nearby {
    nodes: { id: string; label: string; host: string; api: string; ws: string | null }[];
    ports: { path: string; name: string; ws: string }[];
  }
  const BRIDGE_KEY = 'tesserui:bridge';
  // The bridge's own page says so; elsewhere, ?bridge= or its default port.
  const own = !!document.querySelector('meta[name=tesserui-bridge]');
  const bridge = own ? location.origin : (new URLSearchParams(location.search).get('bridge') ?? 'http://localhost:8765');
  let nearby: Nearby | null = $state(null);
  let looking = $state(false);
  async function look() {
    looking = true;
    try {
      const r = await fetch(`${bridge}/nodes`, { signal: AbortSignal.timeout(3000) });
      nearby = await r.json();
      localStorage.setItem(BRIDGE_KEY, '1');
    } catch {
      nearby = null;
    }
    looking = false;
  }
  const remembered = (() => {
    try {
      return localStorage.getItem(BRIDGE_KEY) === '1';
    } catch {
      return false;
    }
  })();
  if (launcher && (remembered || own)) {
    $effect(() => {
      look();
      const timer = setInterval(look, 5000);
      return () => clearInterval(timer);
    });
  }
</script>

<section class="card connect">
  <h2>{t('Connect to a node')}</h2>
  {#if nav.serial}
    <div class="way">
      <Icon name="usb" />
      <p><b>USB</b>{t('A board on its serial port, or a NowTP gateway reaching the nodes around it.')}</p>
      <button class="primary" onclick={serial}>{t('Choose a port')}</button>
    </div>
    {#if firmware}
      <div class="way">
        <Icon name="download" />
        <p><b>{t('Install')}</b>{t('A firmware on a board, over USB.')}</p>
        {#if installing}<div class="flash" bind:this={host}></div>{:else}<button onclick={() => (installing = true)}>{t('Install firmware')}</button>{/if}
      </div>
    {/if}
  {/if}
  {#if nav.bluetooth}
    <div class="way">
      <Icon name="bluetooth" />
      <p><b>Bluetooth</b>{t('A node nearby with a Bluetooth transport.')}</p>
      <button class="primary" onclick={ble}>{t('Choose a device')}</button>
    </div>
  {/if}
  {#if !nav.serial || !nav.bluetooth}
    <p class="muted">{t('USB and Bluetooth need a Chromium-based browser (Chrome, Edge, Opera); the bridge brings serial ports to the others.')}</p>
  {/if}
  {#if launcher}
    <form class="way" onsubmit={open}>
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
          {nearby.nodes.length || nearby.ports.length ? t('Found by the bridge, live in any browser.') : t('The bridge finds no node yet.')}
        {:else}
          {t('The bridge finds the nodes on your network (mDNS) and serves them live:')} <code>npx tesserui-bridge</code>
        {/if}
      </p>
      {#if !nearby}
        <button onclick={look} disabled={looking}>{t('Look for the bridge')}</button>
      {/if}
    </div>
    {#each nearby?.nodes ?? [] as n (n.id)}
      <a class="way recent" href={link(n.api, n.ws)}><Icon name="wifi" /><b>{n.label}</b><span class="muted">{n.host}</span></a>
    {/each}
    {#if !nav.serial}
      {#each nearby?.ports ?? [] as p (p.path)}
        <a class="way recent" href={link(`${bridge}/s`, p.ws)}><Icon name="usb" /><b>{p.name}</b><span class="muted">{t('bridge')}</span></a>
      {/each}
    {/if}
    {#each recent as r (r.api)}
      <a class="way recent" href={link(r.api, r.ws)}><Icon name="clock" /><b>{r.label}</b><span class="muted">{where(r.api)}</span></a>
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
  .recent {
    color: inherit;
    text-decoration: none;
  }
  .recent b {
    flex: 1;
  }
</style>
