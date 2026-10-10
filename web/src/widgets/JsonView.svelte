<script lang="ts">
  // Custom nodes: read-only JSON, or a JSON editor when writable.
  import { parse, stringify } from '../client/json';
  import type { WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();

  const pretty = (v: unknown) => (v === undefined ? '' : JSON.stringify(JSON.parse(stringify(v)), null, 2));
  let editing = $state(false);
  let text = $state('');
  let bad = $state(false);
</script>

<div class="json">
  {#if editing}
    <textarea {id} rows="6" bind:value={text} spellcheck="false" aria-label={leaf.label}></textarea>
    {#if bad}<p class="error">Not valid JSON</p>{/if}
    <div class="buttons">
      <button type="button" class="quiet" onclick={() => (editing = false)}>Cancel</button>
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
        }}>Save</button>
    </div>
  {:else}
    <pre {id}>{pretty(value)}</pre>
    {#if leaf.editable}
      <div class="buttons">
        <button type="button" {disabled} onclick={() => ((text = pretty(value)), (bad = false), (editing = true))}>Edit</button>
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
