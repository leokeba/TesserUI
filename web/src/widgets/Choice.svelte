<script lang="ts">
  import type { WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();
  const options = $derived(leaf.options ?? []);
</script>

{#if leaf.widget === 'segmented'}
  <div class="seg" role="radiogroup" aria-label={leaf.label} {id}>
    {#each options as o (o.value)}
      <button type="button" role="radio" aria-checked={value === o.value} {disabled} onclick={() => value !== o.value && set(o.value)}>
        {o.label}
      </button>
    {/each}
  </div>
{:else if leaf.widget === 'radio'}
  <div class="radio" role="radiogroup" aria-label={leaf.label} {id}>
    {#each options as o (o.value)}
      <label><input type="radio" name={leaf.path} checked={value === o.value} {disabled} onchange={() => set(o.value)} />{o.label}</label>
    {/each}
  </div>
{:else}
  <select {id} {disabled} onchange={(e) => set(e.currentTarget.value)}>
    {#if !options.some((o) => o.value === value)}<option value="" selected disabled>{value ?? ''}</option>{/if}
    {#each options as o (o.value)}<option value={o.value} selected={value === o.value}>{o.label}</option>{/each}
  </select>
{/if}

<style>
  .seg {
    display: inline-flex;
    flex-wrap: wrap;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 4px);
    overflow: hidden;
    max-width: 100%;
  }
  .seg button {
    border: 0;
    border-radius: 0;
    background: var(--surface-2);
    flex: 1 0 auto;
    padding: 0 10px;
  }
  .seg button + button {
    border-left: 1px solid var(--border);
  }
  .seg button[aria-checked='true'] {
    background: var(--accent);
    color: var(--on-accent);
  }
  .radio {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
  .radio label {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--control);
  }
  select {
    max-width: 100%;
  }
</style>
