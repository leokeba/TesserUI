<script lang="ts">
  import { formatValue } from '../model/format';
  import { useSession } from '../shared.svelte';
  import { asNumber, fixed, parseNumber, type WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();
  const session = useSession();
  const n = $derived(asNumber(value));
</script>

<div class="range">
  <input
    {id}
    type="range"
    min={leaf.min}
    max={leaf.max}
    step={leaf.step ?? 'any'}
    value={Number.isNaN(n) ? leaf.min : n}
    {disabled}
    aria-valuetext={formatValue(value, leaf)}
    oninput={(e) => set(Number(e.currentTarget.value), true)}
  />
  <input
    class="entry"
    type="number"
    min={leaf.min}
    max={leaf.max}
    step={leaf.step ?? 'any'}
    value={fixed(value, leaf.precision)}
    {disabled}
    aria-label={session.t('{label} value', { label: leaf.label })}
    onchange={(e) => {
      const v = parseNumber(e.currentTarget.value, leaf.type);
      if (v !== undefined) set(v);
    }}
  />
  {#if leaf.unit}<span class="unit">{leaf.unit}</span>{/if}
</div>

<style>
  .range {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  input[type='range'] {
    flex: 1;
    min-width: 60px;
  }
  .entry {
    width: 5.5em;
    text-align: right;
  }
  .unit {
    color: var(--muted);
  }
</style>
