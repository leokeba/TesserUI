<script lang="ts">
  import type { WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();
  const text = $derived(typeof value === 'string' ? value : value == null ? '' : String(value));
</script>

{#if leaf.widget === 'textarea'}
  <textarea {id} rows="3" maxlength={leaf.maxLength} placeholder={leaf.placeholder} value={text} {disabled} onchange={(e) => set(e.currentTarget.value)}></textarea>
{:else}
  <input
    {id}
    type={leaf.widget === 'password' ? 'password' : 'text'}
    autocomplete={leaf.widget === 'password' ? 'new-password' : 'off'}
    maxlength={leaf.maxLength}
    placeholder={leaf.placeholder}
    value={text}
    {disabled}
    onchange={(e) => set(e.currentTarget.value)}
  />
{/if}

<style>
  input {
    width: 100%;
    max-width: 16em;
  }
</style>
