<script lang="ts">
  // A view page (DESIGN.md §8): items from anywhere in the tree, peers
  // included, laid out as cards.
  import { useSession } from './shared.svelte';
  import Item from './Item.svelte';
  import { isElement, type Section as SectionModel } from './model/model';
  import Row from './Row.svelte';
  import { buildView, viewModelItems, type ViewItem, type ViewPage } from './model/views';
  import Section from './Section.svelte';

  let { page }: { page: ViewPage } = $props();
  const session = useSession();

  const view = $derived.by(() => {
    void session.schemaVersion;
    return buildView(page, session.root);
  });
  // Fetch the schemas the view needs; each path once.
  const tried = new Set<string>();
  const failed: Record<string, boolean> = $state({});
  $effect(() => {
    for (const p of view.missing) {
      if (tried.has(p)) continue;
      tried.add(p);
      session.ensure(p).then((ok) => ok || (failed[p] = true));
    }
  });
  $effect(() => session.show(viewModelItems(view.items), view.specs, '/'));

  // Top-level subtrees are cards; other consecutive items share one.
  type Block = ({ card: string; items: ViewItem[] } | { section: SectionModel }) & { wide?: boolean };
  const blocks = $derived.by(() => {
    const out: Block[] = [];
    for (const i of view.items) {
      if (i.kind === 'card') out.push({ card: i.label, items: i.items, wide: i.wide });
      else if (i.kind === 'node' && i.item?.kind === 'section') out.push({ section: { ...i.item, level: 1 }, wide: i.wide });
      else {
        const last = out[out.length - 1];
        if (last && 'card' in last && last.card === '') last.items.push(i);
        else out.push({ card: '', items: [i] });
      }
    }
    return out;
  });

  // A view of one custom element is a custom page: the element, full width.
  const custom = $derived.by(() => {
    const [only, ...rest] = view.items;
    return !rest.length && only?.kind === 'node' && only.item?.kind === 'leaf' && isElement(only.item.widget) ? { ...only.item, label: '' } : null;
  });

  // **bold** is the only markup.
  const parts = (text: string) => text.split('**');
</script>

{#snippet items(list: ViewItem[])}
  {#each list as i, n (n)}
    {#if i.kind === 'text'}
      <p class="text">
        {#each parts(i.text) as part, k (k)}{#if k % 2}<strong>{part}</strong>{:else}{part}{/if}{/each}
      </p>
    {:else if i.kind === 'row'}
      <div class="tiles">{@render items(i.items)}</div>
    {:else if i.kind === 'card'}
      <div class="sub"><h3>{i.label}</h3>{@render items(i.items)}</div>
    {:else if i.item}
      <Item item={i.item} />
    {:else}
      <p class="muted">{i.path}: {session.t(session.isOffline(i.path) ? 'offline' : failed[i.path] ? 'unavailable' : 'loading…')}</p>
    {/if}
  {/each}
{/snippet}

{#if custom}
  <div class="custom"><Row leaf={custom} /></div>
{:else}
<div class="grid">
  {#each blocks as b, n (n)}
    {#if 'section' in b && b.wide}
      <div class="wide"><Section sec={b.section} /></div>
    {:else if 'section' in b}
      <Section sec={b.section} />
    {:else}
      <section class="card" class:wide={b.wide}>
        {#if b.card}<h2>{b.card}</h2>{/if}
        {@render items(b.items)}
      </section>
    {/if}
  {/each}
</div>
{/if}

<style>
  .grid {
    display: grid;
    gap: var(--gap);
    align-items: start;
    grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr));
  }
  .card {
    container-type: inline-size;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .custom {
    container-type: inline-size;
  }
  h2 {
    margin-bottom: 6px;
  }
  .text {
    margin: 4px 0;
  }
  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    padding: 6px 0;
  }
  .tiles > :global(*) {
    flex: 1 1 120px;
  }
  .tiles :global(.row) {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
    text-align: center;
  }
  .sub {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .sub h3 {
    color: var(--muted);
    font-size: 0.95rem;
  }
</style>
