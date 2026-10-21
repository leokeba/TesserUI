<script lang="ts">
  import { untrack } from 'svelte';
  import { useSession } from './shared.svelte';
  import Icon from './Icon.svelte';
  import { buildPage, placeCards } from './model/model';
  import { accessAt, parentPath } from './model/schema';
  import Item from './Item.svelte';
  import Section from './Section.svelte';

  // home: where the UI starts; back doesn't go above it.
  // menu: the menu leads to the start page's objects (DESIGN.md §6.3).
  let { path, home = '/', menu = false }: { path: string; home?: string; menu?: boolean } = $props();
  const session = useSession();
  const t = (text: string) => session.t(text);

  let failed = $state(false);
  let loading = false;
  async function load() {
    loading = true;
    failed = false;
    failed = !(await session.ensure(path, 3));
    loading = false;
  }
  load();

  const schema = $derived(session.pageSchema(path));
  // A remote node's tree goes when it advertises another hash (renamed,
  // updated: DESIGN.md §7.2): read again.
  $effect(() => {
    if (!schema && !failed && !loading) untrack(load);
  });
  const nodeRoot = $derived.by(() => {
    void session.schemaVersion;
    return session.nodeRoot(path);
  });
  // Schema loaded below the page (lazy groups, lists' items) is merged into
  // the same tree in place: the page is rebuilt on every merge.
  const page = $derived.by(() => {
    void session.schemaVersion;
    return schema ? buildPage(schema, path, nodeRoot, t, accessAt(session.root, parentPath(path)), menu && path === home) : null;
  });
  $effect(() => {
    if (page) session.showPage(page);
  });
  // Columns (DESIGN.md §6.2): as many 360 px ones as fit, at most the
  // page's; cards are placed from the model, so they move only when the
  // number of columns changes, not when a group opens.
  let width = $state(0);
  const n = $derived(page ? Math.max(1, Math.min(page.columns, width < 640 ? 1 : Math.floor((width + 16) / 376))) : 1);
  const columns = $derived(page ? placeCards(page.cards, n) : []);
  const offline = $derived(session.isOffline(path));
  // A peer that comes back online: load what couldn't be. Only then: a
  // page that fails for another reason would otherwise reload forever.
  $effect(() => {
    if (!offline) untrack(() => failed && load());
  });

  // Back goes to the nearest page above: a node's root, or an object with
  // ui.page (DESIGN.md §6.1).
  const back = $derived.by(() => {
    void session.schemaVersion;
    // The menu leads to the start page's entries.
    if (path === home || (menu && parentPath(path) === home)) return null;
    let p = parentPath(path);
    while (p !== '/' && p !== home) {
      const s = session.schemaAt(p);
      if (s?.type === 'remote' || s?.ui?.page === true || (menu && parentPath(p) === home)) break;
      p = parentPath(p);
    }
    return p;
  });
</script>

{#if path !== '/' || page?.actions.length}
  <div class="head">
    {#if back !== null}<a class="back" href="#{back}" aria-label={t('Back')}><Icon name="left" /></a>{/if}
    {#if path !== '/'}<h1>{page?.label ?? path.slice(path.lastIndexOf('/') + 1)}</h1>{/if}
    {#if nodeRoot === path && nodeRoot !== '/'}
      <span class="dot" class:off={offline}></span><span class="muted">{t(offline ? 'Offline' : 'Online')}</span>
    {/if}
    {#if page?.actions.length}<div class="actions">{#each page.actions as a (a.path)}<Item item={a} />{/each}</div>{/if}
  </div>
{/if}
{#if page?.description}<p class="muted desc">{page.description}</p>{/if}

{#if offline}
  <p class="banner warn card"><Icon name="alert" /> {t('This node is offline. Its controls come back when it is heard from again.')}</p>
{/if}

{#if page}
  <div class="grid" style="--n: {n}" bind:clientWidth={width}>
    {#each columns as col, j (j)}
      <div class="col">
        {#each col as card, i (card.path + i)}<Section sec={card} />{/each}
      </div>
    {/each}
  </div>
{:else if failed}
  <div class="center">
    <p class="muted">{t(offline ? 'This page could not be loaded: the node is offline.' : 'This page could not be loaded.')}</p>
    <button onclick={load}><Icon name="refresh" /> {t('Retry')}</button>
  </div>
{:else}
  <p class="muted center">{t('Loading…')}</p>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 12px;
  }
  h1 {
    font-size: 1.25rem;
    margin: 0;
  }
  .actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }
  .back {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--control);
    height: var(--control);
    border-radius: 8px;
    color: var(--text);
  }
  .back:hover {
    background: var(--surface-2);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
    margin-left: 6px;
  }
  .dot.off {
    background: var(--muted);
  }
  .desc {
    margin: -4px 0 12px;
  }
  .banner {
    margin-bottom: var(--gap);
  }
  .grid {
    display: grid;
    gap: var(--gap);
    align-items: start;
    grid-template-columns: repeat(var(--n), minmax(0, 1fr));
  }
  .col {
    display: grid;
    gap: var(--gap);
    min-width: 0;
  }
</style>
