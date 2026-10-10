<script lang="ts">
  import { asNumber, fixed, parseNumber, type WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();

  const step = $derived(leaf.step ?? 1);
  function bump(d: number) {
    const n = asNumber(value);
    const next = (Number.isNaN(n) ? (leaf.min ?? 0) : n) + d * step;
    set(Number(Math.min(Math.max(next, leaf.min ?? -Infinity), leaf.max ?? Infinity).toFixed(10)));
  }
</script>

<div class="num">
  {#if leaf.widget === 'stepper'}
    <button type="button" {disabled} aria-label="Decrease {leaf.label}" onclick={() => bump(-1)}>−</button>
  {/if}
  <input
    {id}
    type="number"
    min={leaf.min}
    max={leaf.max}
    step={leaf.step ?? (leaf.type === 'integer' ? 1 : 'any')}
    placeholder={leaf.placeholder}
    value={fixed(value, leaf.widget === 'stepper' ? leaf.precision : undefined)}
    {disabled}
    onchange={(e) => {
      const v = parseNumber(e.currentTarget.value, leaf.type);
      if (v !== undefined) set(v);
    }}
  />
  {#if leaf.widget === 'stepper'}
    <button type="button" {disabled} aria-label="Increase {leaf.label}" onclick={() => bump(1)}>+</button>
  {/if}
  {#if leaf.unit}<span class="unit">{leaf.unit}</span>{/if}
</div>

<style>
  .num {
    display: flex;
    flex: 1;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  input {
    width: 100%;
    max-width: 14em;
    min-width: 0;
    text-align: right;
  }
  button {
    width: var(--control);
    padding: 0;
    font-size: 1.1em;
  }
  .unit {
    color: var(--muted);
  }
</style>
