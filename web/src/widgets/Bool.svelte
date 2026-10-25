<script lang="ts">
  import type { WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();
</script>

<!-- Before its first value, neither on nor off: an "off" there would be a
     guess. -->
{#if leaf.widget === 'led'}
  <span class="led" class:on={value === true} class:unknown={value === undefined} role="img" aria-label={value === true ? 'On' : 'Off'}></span>
{:else}
  <input
    {id}
    type="checkbox"
    role={leaf.widget === 'toggle' ? 'switch' : undefined}
    checked={value === true}
    class:unknown={value === undefined}
    disabled={disabled || value === undefined}
    onchange={(e) => set(e.currentTarget.checked)}
  />
{/if}

<style>
  .unknown {
    visibility: hidden;
  }
  .led {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--border);
    box-shadow: inset 0 0 0 1px #0002;
  }
  .led.on {
    background: var(--ok);
    box-shadow: 0 0 8px var(--ok);
  }
</style>
