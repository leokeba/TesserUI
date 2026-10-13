<script lang="ts">
  // Choosing a node over USB or Bluetooth (DESIGN.md §9.7), on a node's page
  // with `serial: true`. The launcher adds its own ways (the network, the
  // bridge, installing firmware) as `children`, with the same `pick`.
  import type { Snippet } from 'svelte';
  import { NUS_SERVICE } from './client/envelope';
  import Icon from './Icon.svelte';
  import { useSession } from './shared.svelte';

  let { children }: { children?: Snippet<[(choose: () => Promise<void>) => void, () => void]> } = $props();
  const session = useSession();
  const t = (text: string) => session.t(text);
  const nav = navigator as unknown as {
    serial?: { requestPort(o: object): Promise<never> };
    bluetooth?: { requestDevice(o: object): Promise<never> };
  };
  // Serial ports include Bluetooth ones (SPP), paired with the system: the
  // only serial ports Chrome on Android can open.
  const SPP = '00001101-0000-1000-8000-00805f9b34fb';
  let error = $state('');

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
</script>

<section class="card connect">
  <h2>{t('Connect to a node')}</h2>
  {#if nav.serial}
    <div class="way">
      <Icon name="usb" />
      <p><b>USB</b>{t('A board on its serial port, or a NowTP gateway reaching the nodes around it.')}</p>
      <button class="primary" onclick={serial}>{t('Choose a port')}</button>
    </div>
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
  {@render children?.(pick, ble)}
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
  .connect :global(.way) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .connect :global(.way p) {
    flex: 1 1 200px;
    margin: 0;
  }
  .connect :global(.way b) {
    display: block;
  }
</style>
