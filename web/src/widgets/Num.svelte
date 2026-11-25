<script lang="ts">
  import { useSession } from '../shared.svelte';
  import { asNumber, bounds, fixed, parseNumber, span, type WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();

  const session = useSession();
  const store = session.store;
  const step = $derived(leaf.step ?? 1);
  const r = $derived(span(leaf, (path) => store.get(path)));
  const b = $derived(bounds(leaf, value, r.min, r.max));
  function bump(d: number) {
    const n = asNumber(value);
    const next = (Number.isNaN(n) ? (r.min ?? 0) : n) + d * step;
    set(Number(Math.min(Math.max(next, r.min ?? -Infinity), r.max ?? Infinity).toFixed(10)));
  }
</script>

<div class="num">
  {#if leaf.widget === 'stepper'}
    <button type="button" {disabled} aria-label={session.t('Decrease {label}', { label: leaf.label })} onclick={() => bump(-1)}>−</button>
  {/if}
  <input
    {id}
    type="number"
    min={b.min}
    max={b.max}
    step={b.step}
    placeholder={leaf.placeholder}
    value={fixed(value, leaf.widget === 'stepper' ? leaf.precision : undefined)}
    {disabled}
    onchange={(e) => {
      const v = parseNumber(e.currentTarget.value, leaf.type);
      if (v !== undefined) set(v);
    }}
  />
  {#if leaf.widget === 'stepper'}
    <button type="button" {disabled} aria-label={session.t('Increase {label}', { label: leaf.label })} onclick={() => bump(1)}>+</button>
  {/if}
  {#if leaf.labels?.[String(value)] ?? leaf.unit}<span class="unit">{leaf.labels?.[String(value)] ?? leaf.unit}</span>{/if}
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
