<script lang="ts">
  // An integer as a set of bits, one checkbox each, labelled by ui.labels
  // (bit 0 first): the days of a timer (DESIGN.md §5.1).
  import { asNumber, type WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();
  const labels = $derived(String(leaf.schema.ui?.labels ?? '').split(',').map((l) => l.trim()).filter(Boolean));
  const bits = $derived(asNumber(value) || 0);
</script>

<div class="flags" {id} role="group">
  {#each labels as label, i (i)}
    <label>
      <input type="checkbox" checked={(bits & (1 << i)) !== 0} disabled={disabled || !leaf.editable} onchange={() => set(bits ^ (1 << i))} />
      {label}
    </label>
  {/each}
</div>

<style>
  .flags {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    justify-content: flex-end;
  }
  label {
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
</style>
