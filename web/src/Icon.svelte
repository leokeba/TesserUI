<script lang="ts">
  import { ICONS } from './icons';
  let { name }: { name: string } = $props();
</script>

{#if ICONS[name]}
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name]} /></svg>
{/if}

<style>
  .icon {
    width: 1.15em;
    height: 1.15em;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    vertical-align: -0.2em;
  }
</style>
