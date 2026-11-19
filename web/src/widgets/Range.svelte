<script lang="ts">
  import { formatValue } from '../model/format';
  import { useSession } from '../shared.svelte';
  import { asNumber, bounds, detent, fixed, onStep, parseNumber, type WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();
  const session = useSession();
  const n = $derived(asNumber(value));
  const b = $derived(bounds(leaf, value));
  // Pointer drags snap to 0 (the thumb too); arrow keys move freely.
  let dragging = false;
  function input(el: HTMLInputElement) {
    // Off the step (the device's value was), the slider moved freely.
    const v = onStep(Number(el.value), leaf);
    const snapped = dragging ? detent(v, leaf) : v;
    if (snapped !== v) el.value = String(snapped);
    set(snapped, true);
  }
</script>

<div class="range">
  <input
    {id}
    type="range"
    min={leaf.min}
    max={leaf.max}
    step={b.step}
    value={Number.isNaN(n) ? leaf.min : n}
    {disabled}
    aria-valuetext={formatValue(value, leaf)}
    onpointerdown={() => (dragging = true)}
    onpointerup={() => (dragging = false)}
    onpointercancel={() => (dragging = false)}
    oninput={(e) => input(e.currentTarget)}
  />
  <div class="value">
    <input
      class="entry"
      type="number"
      min={b.min}
      max={b.max}
      step={b.step}
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
</div>

<style>
  .range {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    container-type: inline-size;
  }
  input[type='range'] {
    flex: 1 1 60px;
    min-width: 60px;
  }
  .value {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .entry {
    width: 5.5em;
    text-align: right;
  }
  .unit {
    color: var(--muted);
  }
  @container (max-width: 240px) {
    input[type='range'] {
      flex-basis: 100%;
    }
  }
</style>
