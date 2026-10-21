<script lang="ts">
  import { getContext, setContext } from 'svelte';
  import { useSession, reader, Draft, DRAFT, SHOWN } from './shared.svelte';
  import { isObject } from './client/json';
  import Icon from './Icon.svelte';
  import Item from './Item.svelte';
  import { holds } from './model/conditions';
  import type { Leaf, Section } from './model/model';
  import { segments } from './model/schema';
  import EventList from './widgets/EventList.svelte';

  // save: a new list element's draft (DESIGN.md §4): Save gives it the
  // element, Cancel null; `values` fill it to begin with.
  let { sec, save, values }: { sec: Section; save?: (patch: Record<string, unknown> | null) => unknown; values?: Record<string, unknown> } = $props();
  const session = useSession();
  const store = session.store;
  const t = (text: string, vars?: Record<string, string | number>) => session.t(text, vars);

  const get = reader(store, getContext<Draft | undefined>(DRAFT));
  const visible = $derived(!sec.visibleWhen || holds(sec.visibleWhen, get));
  const enabled = $derived(!sec.enabledWhen || holds(sec.enabledWhen, get));
  const foldable = $derived(sec.collapsed || sec.level >= 3);
  // Groups start open unless collapsed; one whose schema isn't loaded yet
  // (the page's depth cut it) loads when open.
  // svelte-ignore state_referenced_locally
  let open = $state(!sec.collapsed);
  $effect(() => {
    if (open && sec.lazy) session.ensure(sec.path, 2);
  });

  const events = $derived(store.events[sec.path]);
  const error = $derived(store.errors[sec.path]);

  let tab = $state(0);
  const tabs = $derived(sec.tabs ? sec.items.filter((i): i is Section => i.kind === 'section' && !i.hidden) : []);
  const plain = $derived(sec.tabs ? sec.items.filter((i) => i.kind !== 'section') : sec.items);

  // Forms (ui.form): rows edit a local draft; submit sends one patch with
  // the edited values and the submit action (DESIGN.md §7.4).
  // svelte-ignore state_referenced_locally
  const draft = sec.form || save ? new Draft() : null;
  if (draft) setContext(DRAFT, draft);
  // svelte-ignore state_referenced_locally
  if (draft && values) draft.values = values;
  // Shown: not inside a closed group (keep-alives stop there).
  const above = getContext<(() => boolean) | undefined>(SHOWN);
  setContext(SHOWN, () => (!foldable || open) && (above?.() ?? true));
  const submitAction = $derived(sec.form ? (sec.items.find((i) => i.kind === 'leaf' && i.submit) as Leaf | undefined) : undefined);
  let busy = $state(false);

  async function submit() {
    if (!draft) return;
    const patch: Record<string, unknown> = {};
    for (const [p, v] of Object.entries(draft.values)) {
      const names = segments(p.slice(sec.path === '/' ? 0 : sec.path.length));
      let o = patch;
      for (const n of names.slice(0, -1)) o = (o[n] ??= {}) as Record<string, unknown>;
      o[names[names.length - 1]] = v;
    }
    if (save) {
      busy = true;
      await save(patch);
      return void (busy = false);
    }
    if (submitAction) {
      if (submitAction.confirm && !confirm(submitAction.confirm)) return;
      patch[submitAction.name] = submitAction.value ?? null;
    }
    busy = true;
    const r = await store.call(sec.path, patch);
    busy = false;
    if (r.status !== 'ok') return;
    draft.values = {};
    if (isObject(r.body)) {
      // The reply is the patch read back; actions read back as null.
      if (submitAction) delete r.body[submitAction.name];
      store.apply(sec.path, r.body);
    }
  }
</script>

{#snippet body()}
  {#if sec.description && sec.level > 0}<p class="help">{sec.description}</p>{/if}
  {#if sec.lazy}
    <p class="muted">{t('Loading…')}</p>
  {:else}
    <div class="items" class:inline={sec.inline}>
      {#each plain as item (item.path)}
        {#if !(item.kind === 'leaf' && item.submit && sec.form)}<Item {item} />{/if}
      {/each}
    </div>
    {#if tabs.length}
      <div class="tabs" role="tablist">
        {#each tabs as t, i (t.path)}
          <button role="tab" class="quiet" aria-selected={tab === i} onclick={() => (tab = i)}>{t.label}</button>
        {/each}
      </div>
      {#if tabs[tab]}
        {@const t = tabs[tab]}
        <div role="tabpanel">
          {#key t.path}<Item item={{ ...t, level: Math.max(t.level, 2), label: '', collapsed: false }} />{/key}
        </div>
      {/if}
    {/if}
  {/if}
  {#if sec.advancedItems.length && !plain.length && !tabs.length}
    <!-- Nothing else to show (or nothing else this client may read): no fold. -->
    <div class="items">
      {#each sec.advancedItems as item (item.path)}<Item {item} />{/each}
    </div>
  {:else if sec.advancedItems.length}
    <details class="adv">
      <summary>{t('Advanced')}</summary>
      <div class="items">
        {#each sec.advancedItems as item (item.path)}<Item {item} />{/each}
      </div>
    </details>
  {/if}
  {#if draft}
    <div class="form-actions">
      {#if draft.size && !save}<span class="muted">{t('{n} modified', { n: draft.size })}</span>{/if}
      <button class="quiet" disabled={!save && (!draft.size || busy)} onclick={() => (save ? save(null) : (draft.values = {}))}>{t(save ? 'Cancel' : 'Reset')}</button>
      <button class={submitAction?.style ?? 'primary'} disabled={busy || session.state !== 'open' || !enabled || !session.can(submitAction?.access ?? sec.access) || (save && !draft.size)} onclick={submit}>
        {save ? t('Save') : (submitAction?.label ?? t('Apply'))}
      </button>
    </div>
  {/if}
  {#if events?.length}<EventList entries={events} base={sec.path} />{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
{/snippet}

{#snippet title()}
  {#if sec.level === 1}
    <h2 class="title" title={sec.description}>{#if sec.icon}<Icon name={sec.icon} />{/if}{sec.label}</h2>
  {:else}
    <h3 class="title" title={sec.description}>{#if sec.icon}<Icon name={sec.icon} />{/if}{sec.label}</h3>
  {/if}
{/snippet}

{#if visible}
  <fieldset class="sec l{Math.min(sec.level, 3)}" class:card={sec.level === 1} disabled={!enabled}>
    {#if foldable}
      <details bind:open>
        <summary>{@render title()}</summary>
        {@render body()}
      </details>
    {:else}
      {#if sec.label}{@render title()}{/if}
      {@render body()}
    {/if}
  </fieldset>
{/if}

<style>
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .card {
    padding: 14px 16px;
    border: 1px solid var(--border);
    container-type: inline-size;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .l2,
  .l3 {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .l1 > .title,
  .l1 > details > summary .title {
    font-size: 1rem;
  }
  .l2 .title {
    font-size: 0.95rem;
    color: var(--muted);
  }
  summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    min-height: var(--control);
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::after {
    content: '';
    margin-left: auto;
    width: 7px;
    height: 7px;
    border: solid var(--muted);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
    transition: transform 0.15s;
  }
  details[open] > summary::after {
    transform: rotate(-135deg);
  }
  summary .title {
    margin: 0;
  }
  .items {
    display: grid;
  }
  .items.inline {
    grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
    gap: 8px;
  }
  .items.inline :global(.row) {
    grid-template-columns: minmax(0, 1fr);
  }
  .items.inline :global(.control) {
    justify-content: flex-start;
  }
  .help {
    margin: -2px 0 6px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .adv {
    margin-top: 8px;
    border-top: 1px dashed var(--border);
  }
  .adv > summary {
    color: var(--muted);
    font-size: 0.9em;
  }
  .tabs {
    display: flex;
    gap: 4px;
    margin-top: 8px;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .tabs button {
    border-radius: 6px 6px 0 0;
    color: var(--muted);
  }
  .tabs button[aria-selected='true'] {
    color: var(--text);
    box-shadow: inset 0 -2px var(--accent);
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .form-actions span {
    margin-right: auto;
    font-size: 0.9em;
  }
</style>
