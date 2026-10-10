<script lang="ts">
  // A half-circle meter with a needle; needs min and max.
  import { formatValue } from '../model/format';
  import { asNumber, type WidgetProps } from './types';
  let { leaf, value }: WidgetProps = $props();

  const f = $derived(Math.min(Math.max((asNumber(value) - leaf.min!) / (leaf.max! - leaf.min! || 1), 0), 1) || 0);
  const at = (t: number, r: number) => {
    const a = Math.PI * (1 - t);
    return `${(60 + r * Math.cos(a)).toFixed(2)} ${(56 - r * Math.sin(a)).toFixed(2)}`;
  };
</script>

<div class="gauge" role="meter" aria-valuemin={leaf.min} aria-valuemax={leaf.max} aria-valuenow={asNumber(value) || 0} aria-label={leaf.label}>
  <svg viewBox="0 0 120 64" aria-hidden="true">
    <path class="track" d="M{at(0, 46)}A46 46 0 0 1 {at(1, 46)}" />
    {#if f > 0}<path class="fill" d="M{at(0, 46)}A46 46 0 0 1 {at(f, 46)}" />{/if}
    <path class="needle" d="M60 56L{at(f, 36)}" />
  </svg>
  <output>{formatValue(value, leaf)}</output>
</div>

<style>
  .gauge {
    width: 132px;
    display: grid;
    justify-items: center;
  }
  svg {
    width: 100%;
    fill: none;
    stroke-linecap: round;
  }
  .track,
  .fill {
    stroke-width: 10;
  }
  .track {
    stroke: var(--surface-2);
  }
  .fill {
    stroke: var(--accent);
  }
  .needle {
    stroke: var(--text);
    stroke-width: 3;
  }
  output {
    margin-top: -4px;
    font-variant-numeric: tabular-nums;
  }
</style>
