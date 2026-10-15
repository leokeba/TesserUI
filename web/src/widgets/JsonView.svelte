<script lang="ts">
  // Custom nodes: read-only JSON, or a JSON editor when writable.
  import { parse, stringify } from '../client/json';
  import { useSession } from '../shared.svelte';
  import type { WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();

  const pretty = (v: unknown) => (v === undefined ? '' : stringify(v, 2));
  const session = useSession();
  const t = (text: string) => session.t(text);
  let editing = $state(false);
  let text = $state('');
  let bad = $state(false);
</script>

<div class="json">
  {#if editing}
    <textarea {id} rows="6" bind:value={text} spellcheck="false" aria-label={leaf.label}></textarea>
    {#if bad}<p class="error">{t('Not valid JSON')}</p>{/if}
    <div class="buttons">
      <button type="button" class="quiet" onclick={() => (editing = false)}>{t('Cancel')}</button>
      <button
        type="button"
        class="primary"
        {disabled}
        onclick={() => {
          try {
            set(parse(text));
            editing = false;
          } catch {
            bad = true;
          }
        }}>{t('Save')}</button>
    </div>
  {:else}
    <pre {id}>{pretty(value)}</pre>
    {#if leaf.editable}
      <div class="buttons">
        <button type="button" {disabled} onclick={() => ((text = pretty(value)), (bad = false), (editing = true))}>{t('Edit')}</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .json {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  pre,
  textarea {
    margin: 0;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  pre {
    background: var(--surface-2);
    border-radius: 6px;
    padding: 8px 10px;
    overflow: auto;
    max-height: 240px;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
