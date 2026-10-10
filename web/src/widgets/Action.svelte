<script lang="ts">
  // Actions (DESIGN.md §4): a button; a typed argument's input and a button;
  // raw JSON and a button; or a hold button (true on press, false on release).
  import { app } from '../shared.svelte';
  import { parse } from '../client/json';
  import { DEFERRED_TIMEOUT_MS } from '../client/types';
  import Icon from '../Icon.svelte';
  import { formatValue } from '../model/format';
  import Bool from './Bool.svelte';
  import Choice from './Choice.svelte';
  import Color from './Color.svelte';
  import Knob from './Knob.svelte';
  import Num from './Num.svelte';
  import Range from './Range.svelte';
  import Text from './Text.svelte';
  import type { WidgetProps } from './types';

  let { leaf, disabled, id }: WidgetProps = $props();
  const store = app.session.store;

  const FIELDS = { toggle: Bool, checkbox: Bool, slider: Range, knob: Knob, number: Num, stepper: Num, segmented: Choice, select: Choice, radio: Choice, text: Text, password: Text, textarea: Text, color: Color };
  const Field = $derived(leaf.field && leaf.field !== 'json' ? FIELDS[leaf.field as keyof typeof FIELDS] : null) as unknown as import('svelte').Component<WidgetProps> | null;
  // svelte-ignore state_referenced_locally
  let arg: unknown = $state(leaf.type === 'boolean' ? false : leaf.type === 'string' ? (leaf.options?.[0]?.value ?? '') : (leaf.min ?? 0));
  let json = $state('null');
  let busy = $state(false);
  let result: string | null = $state(null);
  let jsonError = $state('');

  async function run(value: unknown) {
    if (leaf.confirm && !confirm(leaf.confirm)) return;
    busy = true;
    result = null;
    const r = await store.call(leaf.path, value, leaf.deferred ? DEFERRED_TIMEOUT_MS : undefined);
    busy = false;
    if (r.status === 'ok' && (leaf.returns || leaf.field === 'json')) result = formatValue(r.body, { type: leaf.returns ?? '' });
  }

  function runJson() {
    try {
      jsonError = '';
      run(parse(json));
    } catch {
      jsonError = 'Not valid JSON';
    }
  }

  let held = false;
  function hold(on: boolean) {
    if (held === on || (on && disabled)) return;
    held = on;
    store.call(leaf.path, on);
  }
</script>

{#if leaf.widget === 'hold'}
  <button
    {id}
    type="button"
    class={leaf.style}
    {disabled}
    onpointerdown={(e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      hold(true);
    }}
    onpointerup={() => hold(false)}
    onpointercancel={() => hold(false)}
    onlostpointercapture={() => hold(false)}
    onkeydown={(e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && (e.preventDefault(), hold(true))}
    onkeyup={(e) => (e.key === ' ' || e.key === 'Enter') && hold(false)}
    oncontextmenu={(e) => e.preventDefault()}
    onblur={() => hold(false)}
  >
    {#if leaf.icon}<Icon name={leaf.icon} />{/if}{leaf.label}
  </button>
{:else}
  <div class="action" class:wide={leaf.field === 'json'} class:field={!!leaf.field}>
    {#if Field}
      <Field leaf={{ ...leaf, widget: leaf.field! }} value={arg} set={(v) => (arg = v)} {disabled} {id} />
    {:else if leaf.field === 'json'}
      <textarea {id} rows="2" bind:value={json} {disabled} spellcheck="false" aria-label="{leaf.label} argument (JSON)"></textarea>
    {/if}
    <button
      type="button"
      class={leaf.style}
      id={Field || leaf.field === 'json' ? undefined : id}
      disabled={disabled || busy}
      aria-busy={busy}
      onclick={() => (leaf.field === 'json' ? runJson() : run(leaf.field ? arg : (leaf.value ?? null)))}
    >
      {#if leaf.icon}<Icon name={leaf.icon} />{/if}
      {leaf.field ? 'Run' : leaf.label}{busy ? '…' : ''}
    </button>
    {#if result !== null}<output>→ {result}</output>{/if}
  </div>
  {#if jsonError}<p class="error">{jsonError}</p>{/if}
{/if}

<style>
  .action {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }
  .action.field {
    justify-content: flex-end;
  }
  .action > :global(:first-child:not(button)) {
    flex: 1;
    min-width: 0;
  }
  .action.wide {
    flex-direction: column;
    align-items: stretch;
  }
  .action.wide button {
    align-self: flex-end;
  }
  output {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
</style>
