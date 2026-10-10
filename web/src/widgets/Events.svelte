<script lang="ts">
  import { useSession } from '../shared.svelte';
  import EventList from './EventList.svelte';
  import type { WidgetProps } from './types';
  let { leaf }: WidgetProps = $props();
  const session = useSession();
  const store = session.store;
  const entries = $derived(store.events[leaf.path]);
</script>

{#if entries?.length}
  <EventList {entries} base={leaf.path} />
{:else}
  <span class="muted">{session.t('No events yet')}</span>
{/if}
