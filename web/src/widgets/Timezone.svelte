<script lang="ts">
  // A POSIX TZ string chosen by IANA name (DESIGN.md §5.1): the device
  // stores what tzset() reads, the user picks a city.
  import { posixTz } from '../model/tz';
  import { useSession } from '../shared.svelte';
  import type { WidgetProps } from './types';
  let { value, set, disabled, id }: WidgetProps = $props();
  const session = useSession();
  const zones: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>

<select {id} {disabled} onchange={(e) => e.currentTarget.value && set(posixTz(e.currentTarget.value))}>
  <option value="" selected>{typeof value === 'string' && value ? value : session.t('Not set')}</option>
  {#if here}<option value={here}>{session.t('This device: {zone}', { zone: here })}</option>{/if}
  {#each zones as z (z)}<option value={z}>{z.replace(/_/g, ' ')}</option>{/each}
</select>

<style>
  select {
    width: 100%;
    max-width: 16em;
  }
</style>
