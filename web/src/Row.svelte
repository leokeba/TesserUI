<script lang="ts">
  import { getContext, untrack } from 'svelte';
  import { useSession, reader, DRAFT, SHOWN, type Draft } from './shared.svelte';
  import Icon from './Icon.svelte';
  import { holds } from './model/conditions';
  import type { Leaf } from './model/model';
  import { widgetOf } from './widgets/registry.svelte';

  let { leaf }: { leaf: Leaf } = $props();
  const session = useSession();
  const store = session.store;
  const draft = getContext<Draft | undefined>(DRAFT);

  const get = reader(store, draft);
  const visible = $derived(!leaf.visibleWhen || holds(leaf.visibleWhen, get));
  const disabled = $derived(
    session.state !== 'open' ||
      session.isOffline(leaf.path) ||
      !session.can(leaf.access) ||
      (!!leaf.enabledWhen && !holds(leaf.enabledWhen, get)),
  );
  const modified = $derived(!!draft && leaf.path in draft.values);
  // Not refreshed for a while: the node is busy or doesn't answer (DESIGN.md §7.3).
  const stale = $derived(store.isStale(leaf.path));
  const value = $derived(modified ? draft!.values[leaf.path] : store.get(leaf.path));
  const error = $derived(store.errors[leaf.path]);
  const id = $derived(`t${leaf.path.replace(/[^\w-]/g, '_')}`);

  // Keep-alive (DESIGN.md §7.4): while shown, connected and enabled, a value
  // other than 0 or false is re-sent every leaf.keepalive ms, so a device's
  // dead-man timer (a motor's manual output) keeps it. An error stops it
  // until the next edit; a hidden tab pauses it.
  const shown = getContext<(() => boolean) | undefined>(SHOWN) ?? (() => true);
  let stalled = $state(false);
  $effect(() => {
    const ms = leaf.keepalive;
    if (!ms || !value || disabled || draft || !visible || stalled || !shown()) return;
    const v = value;
    const send = () =>
      untrack(() => {
        if (!store.pending[leaf.path]) store.resend(leaf.path, v).then((ok) => ok || (stalled = true));
      });
    let timer: ReturnType<typeof setInterval> | undefined;
    const run = () => {
      clearInterval(timer);
      if (!document.hidden) timer = setInterval(send, ms);
    };
    run();
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  });

  // A kept-alive number gets a button back to 0: stopping it by dragging
  // to exactly 0 is hard.
  const stoppable = $derived(!!leaf.keepalive && leaf.type !== 'boolean' && leaf.editable);

  // A declined confirmation re-renders the control with the device's value.
  let revert = $state(0);
  function set(v: unknown, drag = false) {
    stalled = false;
    if (draft) return void ((draft.values[leaf.path] = v), delete store.errors[leaf.path]);
    if (leaf.confirm && !drag && !confirm(leaf.confirm)) return void revert++;
    if (drag) store.writeSoon(leaf.path, v);
    else store.write(leaf.path, v);
  }

  const widget = $derived(widgetOf(leaf));
  const Widget = $derived(widget.component);
  const layout = $derived(widget.layout);
</script>

{#if visible}
  <div class="row {layout}" class:modified class:stale class:warning={leaf.style === 'warning'} title={stale ? session.t('Not up to date') : undefined}>
    {#if layout !== 'bare' && leaf.label}
      <label for={leaf.editable ? id : undefined} title={leaf.description}>
        {#if leaf.icon || leaf.style === 'warning'}<Icon name={leaf.icon ?? 'alert'} />{/if}
        <span>{leaf.label}</span>
        {#if leaf.description}<span class="info" aria-hidden="true"><Icon name="info" /></span>{/if}
      </label>
    {/if}
    <div class="control" class:stop={stoppable}>
      {#key revert}
        <Widget {leaf} {value} {set} {disabled} {id} />
      {/key}
      {#if stoppable}
        <button type="button" class="quiet" title={session.t('Set to 0')} aria-label={session.t('Set to 0')} disabled={disabled || !value} onclick={() => set(0)}><Icon name="stop" /></button>
      {/if}
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
  .row.stale {
    opacity: 0.6;
  }
  .row.warning {
    grid-template-columns: minmax(0, 1fr);
    margin: 4px 0;
    padding: 8px 10px;
    border: 1px solid var(--warn);
    border-radius: 6px;
    background: color-mix(in srgb, var(--warn) 12%, transparent);
  }
  .warning label {
    font-weight: 600;
  }
  .warning label :global(.icon) {
    color: var(--warn);
  }
  .warning > .control {
    justify-content: flex-start;
  }
  .warning > .control :global(output) {
    text-align: left;
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
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
    justify-content: flex-end;
    position: relative;
  }
  .stop > :global(*:first-child) {
    flex: 1 1 0;
  }
  .wide > .control,
  .bare > .control {
    justify-content: flex-start;
  }
  .wide > .control > :global(*:first-child),
  .bare > .control > :global(div:first-child) {
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
