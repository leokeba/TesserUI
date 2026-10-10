<script lang="ts">
  // Actions (DESIGN.md §4): a button; a typed argument's input and a button;
  // an object argument's inputs and a button; raw JSON and a button; or a
  // hold button (true on press, false on release).
  import { useSession } from '../shared.svelte';
  import { parse } from '../client/json';
  import { DEFERRED_TIMEOUT_MS } from '../client/types';
  import Icon from '../Icon.svelte';
  import { formatValue } from '../model/format';
  import { fieldOf } from './registry';
  import type { WidgetProps } from './types';

  let { leaf, disabled, id }: WidgetProps = $props();
  const session = useSession();
  const store = session.store;

  const Field = $derived(fieldOf(leaf.field));
  // svelte-ignore state_referenced_locally
  let arg: unknown = $state(leaf.type === 'boolean' ? false : leaf.type === 'string' ? (leaf.options?.[0]?.value ?? '') : (leaf.min ?? 0));
  let json = $state('null');
  // An object argument's fields, by path relative to it; untouched ones are
  // left out, so the device uses its defaults.
  let params: Record<string, unknown> = $state({});
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

  function paramsValue() {
    const out: Record<string, unknown> = {};
    for (const [p, v] of Object.entries(params)) {
      const names = p.split('/');
      let o = out;
      for (const n of names.slice(0, -1)) o = (o[n] ??= {}) as Record<string, unknown>;
      o[names[names.length - 1]] = v;
    }
    return out;
  }
  const fixedArg = () => (leaf.value === '$now' ? Date.now() : (leaf.value ?? null));

  function runJson() {
    try {
      jsonError = '';
      run(parse(json));
    } catch {
      jsonError = session.t('Not valid JSON');
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
  <div class="action" class:wide={leaf.field === 'json' || !!leaf.params} class:field={!!leaf.field}>
    {#if leaf.params}
      <div class="params">
        {#each leaf.params as p (p.path)}
          {@const F = fieldOf(p.widget)}
          {#if F}
            {@const pid = `${id}_${p.path.replace(/\W/g, '_')}`}
            <label for={pid}>{p.label}</label>
            <F leaf={p} value={params[p.path]} set={(v) => (params[p.path] = v)} {disabled} id={pid} />
          {/if}
        {/each}
      </div>
    {:else if Field}
      <Field leaf={{ ...leaf, widget: leaf.field! }} value={arg} set={(v) => (arg = v)} {disabled} {id} />
    {:else if leaf.field === 'json'}
      <textarea {id} rows="2" bind:value={json} {disabled} spellcheck="false" aria-label={session.t('{label} argument (JSON)', { label: leaf.label })}></textarea>
    {/if}
    <button
      type="button"
      class={leaf.style}
      id={Field || leaf.field === 'json' ? undefined : id}
      disabled={disabled || busy}
      aria-busy={busy}
      onclick={() => (leaf.field === 'json' ? runJson() : run(leaf.params ? paramsValue() : leaf.field ? arg : fixedArg()))}
    >
      {#if leaf.icon}<Icon name={leaf.icon} />{/if}
      {leaf.field ? session.t('Run') : leaf.label}{busy ? '…' : ''}
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
  .params {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    align-items: center;
    gap: 6px 12px;
  }
  output {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
</style>
