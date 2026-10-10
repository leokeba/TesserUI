<script lang="ts">
  import { getContext } from 'svelte';
  import { useSession, DRAFT, type Draft } from './shared.svelte';
  import Icon from './Icon.svelte';
  import { holds } from './model/conditions';
  import type { Leaf } from './model/model';
  import { widgetOf } from './widgets/registry';

  let { leaf }: { leaf: Leaf } = $props();
  const session = useSession();
  const store = session.store;
  const draft = getContext<Draft | undefined>(DRAFT);

  const get = (p: string) => store.get(p);
  const visible = $derived(!leaf.visibleWhen || holds(leaf.visibleWhen, get));
  const disabled = $derived(
    session.state !== 'open' || session.isOffline(leaf.path) || (!!leaf.enabledWhen && !holds(leaf.enabledWhen, get)),
  );
  const modified = $derived(!!draft && leaf.path in draft.values);
  const value = $derived(modified ? draft!.values[leaf.path] : store.get(leaf.path));
  const error = $derived(store.errors[leaf.path]);
  const id = $derived(`t${leaf.path.replace(/[^\w-]/g, '_')}`);

  // A declined confirmation re-renders the control with the device's value.
  let revert = $state(0);
  function set(v: unknown, drag = false) {
    if (draft) return void (draft.values[leaf.path] = v);
    if (leaf.confirm && !drag && !confirm(leaf.confirm)) return void revert++;
    if (drag) store.writeSoon(leaf.path, v);
    else store.write(leaf.path, v);
  }

  const widget = $derived(widgetOf(leaf));
  const Widget = $derived(widget.component);
  const layout = $derived(widget.layout);
</script>

{#if visible}
  <div class="row {layout}" class:modified>
    {#if layout !== 'bare' && leaf.label}
      <label for={leaf.editable ? id : undefined} title={leaf.description}>
        {#if leaf.icon}<Icon name={leaf.icon} />{/if}
        <span>{leaf.label}</span>
        {#if leaf.description}<span class="info" aria-hidden="true"><Icon name="info" /></span>{/if}
      </label>
    {/if}
    <div class="control">
      {#key revert}
        <Widget {leaf} {value} {set} {disabled} {id} />
      {/key}
      {#if store.pending[leaf.path]}<span class="busy" aria-label={session.t('Saving')}></span>{/if}
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
{/if}

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    align-items: center;
    gap: 4px 12px;
    padding: 5px 0;
  }
  .row.wide,
  .row.bare {
    grid-template-columns: minmax(0, 1fr);
  }
  .row.modified label {
    font-style: italic;
  }
  .row.modified label::after {
    content: '•';
    color: var(--accent);
  }
  label {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .info {
    color: var(--muted);
    font-size: 0.85em;
  }
  .control {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    justify-content: flex-end;
    position: relative;
  }
  .wide .control,
  .bare .control {
    justify-content: flex-start;
  }
  .wide .control > :global(*:first-child),
  .bare .control > :global(div:first-child) {
    flex: 1;
  }
  .error {
    grid-column: 1 / -1;
  }
  .busy {
    position: absolute;
    right: -10px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
  }
  @container (max-width: 300px) {
    .row {
      grid-template-columns: minmax(0, 1fr);
    }
    .control {
      justify-content: flex-start;
    }
  }
</style>
