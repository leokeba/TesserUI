<script lang="ts">
  // Dispatches a model item to its component (the design's Node.svelte).
  import type { Item } from './model/model';
  import Row from './Row.svelte';
  import Section from './Section.svelte';
  import Link from './widgets/Link.svelte';

  let { item }: { item: Item } = $props();
</script>

{#if item.hidden}
  <!-- read, never shown -->
{:else if item.kind === 'section'}
  <Section sec={item} />
{:else if item.kind === 'link'}
  <Link link={item} />
{:else}
  <Row leaf={item} />
{/if}
