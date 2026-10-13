<script lang="ts">
  // Installing a firmware over USB (DESIGN.md §9.7.1): a release the site
  // publishes, or a file; then the board's first steps: Wi-Fi with
  // TesserKIT's service, and its page, over the same port.
  import { onDestroy } from 'svelte';
  import type { Client } from '../client/types';
  import type { EnvelopeClient } from '../client/envelope';
  import { connect as reach, release, restart, settle, write, type Board } from './esp';
  import {
    assetName,
    MANIFEST,
    releasesOf,
    save,
    scan,
    status,
    targetsOf,
    type Firmware,
    type Manifest,
    type Network,
  } from './firmware';
  import { handOver, openLine } from './line';

  interface Props {
    firmware: Firmware;
    t: (text: string, vars?: Record<string, string | number>) => string;
    // The launcher's session takes the line, or the user picks the board
    // over Bluetooth.
    connect: (client: Client) => void;
    bluetooth: () => void;
  }
  let { firmware, t, connect, bluetooth }: Props = $props();

  type Step = 'choose' | 'reaching' | 'confirm' | 'writing' | 'starting' | 'wifi' | 'joining' | 'joined' | 'done';
  let step: Step = $state('choose');
  let error = $state('');

  // The props are fixed for the flasher's life.
  // svelte-ignore state_referenced_locally
  const manifestUrl = new URL(firmware.manifest ?? MANIFEST, location.href);
  let manifest: Manifest | null = $state(null);
  let unpublished = $state(false);
  fetch(manifestUrl)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((m: Manifest) => (manifest = m))
    .catch(() => (unpublished = true));

  // An image's index in firmware.images, or -1 for a file.
  let choice = $state(0);
  const image = $derived(firmware.images[choice]);
  const releases = $derived(manifest && image ? releasesOf(manifest, image) : []);
  let tag = $state('');
  $effect(() => {
    if (!releases.some((r) => r.tag === tag)) tag = releases[0]?.tag ?? '';
  });
  let file: File | null = $state(null);
  let erase = $state(false);
  const ready = $derived(choice < 0 ? !!file : !!tag);

  let port: SerialPort | null = null;
  let board: Board | null = $state(null);
  let data: Promise<Uint8Array> | null = null;
  let progress = $state(0);
  let doing = $state('');
  let line: EnvelopeClient | null = null;

  const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

  async function start() {
    error = '';
    try {
      port = await navigator.serial.requestPort();
    } catch {
      return; // the chooser was dismissed
    }
    step = 'reaching';
    try {
      board = await reach(port, (l) => console.debug('esptool:', l));
    } catch (e) {
      step = 'choose';
      error = t('The board’s bootloader doesn’t answer ({error}). Hold its BOOT button while pressing RESET (EN), then try again.', {
        error: failure(e),
      });
      return;
    }
    if (choice < 0) {
      data = file!.arrayBuffer().then((b) => new Uint8Array(b));
    } else {
      const r = releases.find((r) => r.tag === tag)!;
      if (!targetsOf(r, image).includes(board.target)) {
        error = t('{tag} has no {label} for the {chip}.', { tag, label: image.label, chip: board.description });
        await cancel();
        return;
      }
      const url = new URL(`${tag}/${assetName(image.asset, board.target, tag)}`, manifestUrl);
      data = fetch(url).then(async (r) => {
        if (!r.ok) throw new Error(`${url.pathname}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      });
      data.catch(() => {});
    }
    step = 'confirm';
  }

  async function cancel() {
    if (board) await release(board.transport);
    board = null;
    step = 'choose';
  }

  async function install() {
    step = 'writing';
    progress = 0;
    doing = t('Downloading…');
    try {
      const bytes = await data!;
      doing = erase ? t('Erasing the flash, then writing…') : t('Writing…');
      await write(board!, bytes, erase, (p) => (progress = p));
      await restart(board!);
    } catch (e) {
      error = t('Installing failed: {error}', { error: failure(e) });
      await cancel();
      return;
    }
    board = null;
    if (choice >= 0 && image.transport === 'ble') {
      step = 'done';
      return;
    }
    step = 'starting';
    port = await settle(port!);
    line = await openLine(port);
    if (!line) {
      step = 'done';
      return;
    }
    try {
      const s = firmware.wifi ? await status(line, firmware.wifi) : null;
      if (!s) return finish();
      if (s.connected && s.ip) {
        joined = { ssid: s.ssid, ip: s.ip };
        step = 'joined';
      } else {
        step = 'wifi';
        look();
        watch();
      }
    } catch {
      finish();
    }
  }

  // The device's page over the line, in the launcher.
  function finish() {
    const c = line!;
    line = null;
    connect(handOver(c));
  }

  // --- Wi-Fi, through TesserKIT's service ---
  let networks: Network[] = $state([]);
  let scanning = $state(false);
  let ssid = $state('');
  let password = $state('');
  let joining = $state('');
  let joined = $state({ ssid: '', ip: '' });

  async function look() {
    scanning = true;
    try {
      networks = await scan(line!, firmware.wifi!);
      if (!ssid && networks.length) ssid = networks[0].ssid;
    } catch (e) {
      error = failure(e);
    }
    scanning = false;
  }

  // A device with saved networks joins one on its own, seconds after it
  // starts: then there's nothing to ask.
  async function watch() {
    while (step === 'wifi' && line) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = step === 'wifi' && line ? await status(line, firmware.wifi!).catch(() => null) : null;
      if (s?.connected && s.ip && step === 'wifi') {
        joined = { ssid: s.ssid, ip: s.ip };
        step = 'joined';
      }
    }
  }

  async function join(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    try {
      await save(line!, firmware.wifi!, ssid, password);
    } catch (err) {
      error = failure(err);
      return;
    }
    step = 'joining';
    joining = '';
    const end = Date.now() + 45000;
    while (step === 'joining' && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = line && (await status(line, firmware.wifi!).catch(() => null));
      if (!s) continue;
      joining = s.state;
      if (s.connected && s.ip && s.ssid === ssid) {
        joined = { ssid: s.ssid, ip: s.ip };
        step = 'joined';
        return;
      }
    }
    if (step === 'joining') {
      error = t('Not joined yet: {state}', { state: joining });
      back();
    }
  }

  function back() {
    step = 'wifi';
    watch();
  }

  function overNetwork() {
    line?.close();
    line = null;
    location.search = `?api=${encodeURIComponent(`http://${joined.ip}/api`)}`;
  }

  onDestroy(() => {
    line?.close();
    if (board) release(board.transport);
  });
</script>

<div class="flasher">
  {#if step === 'choose'}
    <label>
      <span>{t('Firmware')}</span>
      <select bind:value={choice}>
        {#each firmware.images as im, i (i)}<option value={i}>{im.label}</option>{/each}
        <option value={-1}>{t('A file on this computer')}</option>
      </select>
    </label>
    {#if choice >= 0}
      {#if image.description}<p class="muted">{image.description}</p>{/if}
      <label>
        <span>{t('Version')}</span>
        <select bind:value={tag} disabled={!releases.length}>
          {#each releases as r (r.tag)}<option value={r.tag}>{r.tag} · {new Date(r.date).toLocaleDateString()}</option>{/each}
        </select>
      </label>
      {#if unpublished || (manifest && !releases.length)}<p class="muted">{t('This site publishes no release of it yet.')}</p>{/if}
    {:else}
      <label>
        <span>{t('File')}</span>
        <input type="file" accept=".bin" onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)} />
      </label>
      <p class="muted">{t('A whole-flash image, written at 0x0 (a “factory” image).')}</p>
    {/if}
    <label class="check"><input type="checkbox" bind:checked={erase} />{t('Erase the whole flash first: its files too')}</label>
    <button class="primary" disabled={!ready} onclick={start}>{t('Choose a port and install')}</button>
  {:else if step === 'reaching'}
    <p>{t('Reaching the board’s bootloader…')}</p>
  {:else if step === 'confirm' && board}
    <p>
      {t('Found an {chip}, MAC {mac}.', { chip: board.description, mac: board.mac })}
      {choice < 0 ? t('Install {name} on it?', { name: file!.name }) : t('Install {label} {tag} on it?', { label: image.label, tag })}
      {t('This replaces the firmware it runs and resets its settings.')}
    </p>
    <span class="buttons">
      <button class="primary" onclick={install}>{t('Install')}</button>
      <button onclick={cancel}>{t('Cancel')}</button>
    </span>
  {:else if step === 'writing'}
    <p>{doing} <span class="muted">{t('Keep the board plugged in.')}</span></p>
    <progress value={progress}></progress>
  {:else if step === 'starting'}
    <p>{t('Installed. Starting the new firmware…')}</p>
  {:else if step === 'wifi'}
    <form onsubmit={join}>
      <p>{t('Installed. Which Wi-Fi network should it join?')}</p>
      <label>
        <span>{t('Network')}</span>
        <input required bind:value={ssid} list="tesserui-networks" autocomplete="off" />
        <datalist id="tesserui-networks">
          {#each networks as n (n.ssid)}<option value={n.ssid}>{n.rssi} dBm{n.secure ? '' : ` · ${t('open')}`}</option>{/each}
        </datalist>
      </label>
      <label>
        <span>{t('Password')}</span>
        <input type="password" bind:value={password} autocomplete="off" />
      </label>
      <span class="buttons">
        <button class="primary">{t('Join')}</button>
        <button type="button" onclick={look} disabled={scanning}>{scanning ? t('Scanning…') : t('Scan again')}</button>
        <button type="button" class="quiet" onclick={finish}>{t('Skip: stay on USB')}</button>
      </span>
    </form>
  {:else if step === 'joining'}
    <p>{t('Joining {ssid}…', { ssid })} <span class="muted">{joining}</span></p>
    <button onclick={back}>{t('Back')}</button>
  {:else if step === 'joined'}
    <p>{t('On {ssid}, at {ip}.', joined)}</p>
    <span class="buttons">
      <button class="primary" onclick={overNetwork}>{t('Open it over the network')}</button>
      <button onclick={finish}>{t('Stay on USB')}</button>
    </span>
  {:else if step === 'done'}
    {#if choice >= 0 && image.transport === 'ble'}
      <p>{t('Installed. The board now answers over Bluetooth.')}</p>
      <button class="primary" onclick={bluetooth}>{t('Choose a device')}</button>
    {:else}
      <p>{t('Installed. The new firmware doesn’t answer on its serial port: reach it another way.')}</p>
    {/if}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .flasher {
    display: grid;
    gap: 10px;
  }
  .flasher > *,
  form > * {
    margin: 0;
  }
  form {
    display: grid;
    gap: 10px;
  }
  label {
    display: grid;
    gap: 4px;
  }
  label span {
    font-size: 0.9em;
    color: var(--muted);
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  progress {
    width: 100%;
    accent-color: var(--accent);
  }
</style>
