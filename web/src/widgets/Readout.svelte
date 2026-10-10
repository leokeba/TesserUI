<script lang="ts">
  import { formatValue } from '../model/format';
  import { asNumber, type WidgetProps } from './types';
  let { leaf, value }: WidgetProps = $props();

  const text = $derived(formatValue(value, leaf));
  const options = $derived(leaf.options);
  const shown = $derived(options?.find((o) => o.value === value)?.label ?? text);
  const pct = $derived(
    leaf.widget === 'bar' ? Math.min(Math.max(((asNumber(value) - leaf.min!) / (leaf.max! - leaf.min! || 1)) * 100, 0), 100) || 0 : 0,
  );
</script>

{#if leaf.widget === 'bar'}
  <div class="bar" role="meter" aria-valuemin={leaf.min} aria-valuemax={leaf.max} aria-valuenow={asNumber(value) || 0} aria-label={leaf.label}>
    <div style="width: {pct}%"></div>
  </div>
{/if}
<output>{shown}</output>

<style>
  output {
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
    text-align: right;
  }
  .bar {
    flex: 1;
    height: 10px;
    border-radius: 5px;
    background: var(--surface-2);
    overflow: hidden;
    min-width: 60px;
  }
  .bar div {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }
</style>
