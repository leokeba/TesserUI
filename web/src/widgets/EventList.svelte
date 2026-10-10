<script lang="ts">
  import { stringify } from '../client/json';
  import type { EventEntry } from '../store/store.svelte';
  let { entries, base }: { entries: EventEntry[]; base: string } = $props();
  const time = (t: number) => new Date(t).toLocaleTimeString();
</script>

<ul class="events" aria-live="polite">
  {#each entries as e (e.t + e.path)}
    <li>
      <time>{time(e.t)}</time>
      {#if e.path !== base}<span class="muted">{e.path.slice(base.length + 1)}</span>{/if}
      {#if e.body !== null}<code>{stringify(e.body)}</code>{/if}
    </li>
  {/each}
</ul>

<style>
  .events {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 0.9em;
    display: grid;
    gap: 2px;
  }
  li {
    display: flex;
    gap: 8px;
    min-width: 0;
  }
  time {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  code {
    overflow-wrap: anywhere;
  }
</style>
