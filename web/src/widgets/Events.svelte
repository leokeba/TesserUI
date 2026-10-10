<script lang="ts">
  import { app } from '../shared.svelte';
  import EventList from './EventList.svelte';
  import type { WidgetProps } from './types';
  let { leaf }: WidgetProps = $props();
  const entries = $derived(app.session.store.events[leaf.path]);
</script>

{#if entries?.length}
  <EventList {entries} base={leaf.path} />
{:else}
  <span class="muted">No events yet</span>
{/if}
