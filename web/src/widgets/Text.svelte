<script lang="ts">
  import { useSession } from '../shared.svelte';
  import Secret from './Secret.svelte';
  import type { WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();
  const session = useSession();
  const text = $derived(typeof value === 'string' ? value : value == null ? '' : String(value));
</script>

{#if leaf.widget === 'textarea'}
  <textarea {id} rows="3" maxlength={leaf.maxLength} placeholder={leaf.placeholder} value={text} {disabled} onchange={(e) => set(e.currentTarget.value)}></textarea>
{:else if leaf.widget === 'password'}
  <span class="w">
    <Secret
      {id}
      show={session.t('Show password')}
      autocomplete="new-password"
      maxlength={leaf.maxLength}
      placeholder={leaf.placeholder ?? (leaf.secret ? '••••••••' : undefined)}
      value={text}
      {disabled}
      onchange={(e) => set(e.currentTarget.value)}
    />
  </span>
{:else}
  <input {id} type="text" autocomplete="off" maxlength={leaf.maxLength} placeholder={leaf.placeholder} value={text} {disabled} onchange={(e) => set(e.currentTarget.value)} />
{/if}

<style>
  input,
  .w {
    width: 100%;
    max-width: 16em;
  }
</style>
