<script lang="ts">
  // "#rrggbb" strings, or 0xRRGGBB integers.
  import type { WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();
  const hex = $derived(
    typeof value === 'number' ? '#' + value.toString(16).padStart(6, '0') : typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000',
  );
</script>

<input
  {id}
  type="color"
  value={hex}
  {disabled}
  oninput={(e) => {
    const v = e.currentTarget.value;
    set(leaf.type === 'integer' ? parseInt(v.slice(1), 16) : v, true);
  }}
/>
<code>{hex}</code>

<style>
  input {
    width: 52px;
    padding: 2px;
  }
  code {
    color: var(--muted);
    font-size: 0.85em;
  }
</style>
