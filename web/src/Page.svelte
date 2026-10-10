<script lang="ts">
  import { useSession } from './shared.svelte';
  import Icon from './Icon.svelte';
  import { buildPage } from './model/model';
  import { accessAt, parentPath } from './model/schema';
  import Section from './Section.svelte';

  // home: where the UI starts; back doesn't go above it.
  let { path, home = '/' }: { path: string; home?: string } = $props();
  const session = useSession();
  const t = (text: string) => session.t(text);

  let failed = $state(false);
  async function load() {
    failed = false;
    failed = !(await session.ensure(path, 3));
  }
  load();

  const schema = $derived(session.pageSchema(path));
  const nodeRoot = $derived.by(() => {
    void session.schemaVersion;
    return session.nodeRoot(path);
  });
  const page = $derived(schema ? buildPage(schema, path, nodeRoot, t, accessAt(session.root, parentPath(path))) : null);
  $effect(() => {
    if (page) session.showPage(page);
  });
  const offline = $derived(session.isOffline(path));
  // A peer that comes back online: load what couldn't be.
  $effect(() => {
    if (!offline && failed) load();
  });

  // Back goes to the nearest page above: a node's root, or an object with
  // ui.page (DESIGN.md §6.1).
  const back = $derived.by(() => {
    void session.schemaVersion;
    if (path === home) return null;
    let p = parentPath(path);
    while (p !== '/' && p !== home) {
      const s = session.schemaAt(p);
      if (s?.type === 'remote' || s?.ui?.page === true) break;
      p = parentPath(p);
    }
    return p;
  });
</script>

{#if path !== '/'}
  <div class="head">
    {#if back !== null}<a class="back" href="#{back}" aria-label={t('Back')}><Icon name="left" /></a>{/if}
    <h1>{page?.label ?? path.slice(path.lastIndexOf('/') + 1)}</h1>
    {#if nodeRoot === path && nodeRoot !== '/'}
      <span class="dot" class:off={offline}></span><span class="muted">{t(offline ? 'Offline' : 'Online')}</span>
    {/if}
  </div>
{/if}
{#if page?.description}<p class="muted desc">{page.description}</p>{/if}

{#if offline}
  <p class="banner warn card"><Icon name="alert" /> {t('This node is offline. Its controls come back when it is heard from again.')}</p>
{/if}

{#if page}
  <div class="grid" style="--cols: {page.columns}">
    {#each page.cards as card, i (card.path + i)}
      <Section sec={card} />
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
    /* As many 360 px columns as fit, at most --cols (DESIGN.md §6.2). */
    grid-template-columns: repeat(auto-fill, minmax(max(360px, (100% - (var(--cols) - 1) * var(--gap)) / var(--cols)), 1fr));
  }
  @media (max-width: 640px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
