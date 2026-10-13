<script lang="ts">
  // An event's payloads as a log (ui.widget "log", DESIGN.md §4): one line
  // each, oldest at the top, in a box that stays scrolled to the end unless
  // the user scrolled up.
  import Icon from '../Icon.svelte';
  import { stringify } from '../client/json';
  import { useSession } from '../shared.svelte';
  import type { WidgetProps } from './types';
  let { leaf }: WidgetProps = $props();
  const session = useSession();
  const store = session.store;
  const entries = $derived(store.events[leaf.path] ?? []);

  let box: HTMLElement;
  let end = true;
  $effect(() => {
    void entries;
    if (end) box.scrollTop = box.scrollHeight;
  });
  const text = (b: unknown) => (typeof b === 'string' ? b : b === null ? '' : stringify(b));
  // ESP-IDF's level letter: "E (1234) tag: ...".
  const level = (s: string) => /^([EW]) \(/.exec(s)?.[1];
</script>

<div class="log">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex: scrollable with the keyboard -->
  <div class="lines" role="log" tabindex="0" bind:this={box} onscroll={() => (end = box.scrollTop + box.clientHeight >= box.scrollHeight - 4)}>
    {#each entries as e (e.n)}
      {@const s = text(e.body)}
      <div class={level(s)}>{s}</div>
    {:else}
      <span class="muted">{session.t('No events yet')}</span>
    {/each}
  </div>
  {#if entries.length}
    <button type="button" aria-label={session.t('Clear')} title={session.t('Clear')} onclick={() => (store.events[leaf.path] = [])}><Icon name="trash" /></button>
  {/if}
</div>

<style>
  /* A flex item of the row's control: without min-width, a long line would
     widen it past the card instead of scrolling. */
  .log {
    position: relative;
    min-width: 0;
  }
  .lines {
    height: 15em;
    overflow: auto;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 4px);
    font: 0.8em/1.45 ui-monospace, Menlo, Consolas, monospace;
    white-space: pre;
  }
  .E {
    color: var(--danger);
  }
  .W {
    color: var(--warn);
  }
  /* In the box's top right corner, its borders on the box's; see-through
     until pointed at. */
  .log button {
    position: absolute;
    top: 0;
    right: 0;
    border-radius: 0 calc(var(--radius) - 4px);
    background: color-mix(in srgb, var(--surface) 60%, transparent);
    opacity: 0.6;
  }
  .log button:hover,
  .log button:focus-visible {
    opacity: 1;
  }
</style>
