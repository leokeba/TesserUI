<script lang="ts">
  // A remote node (a peer behind a UI host) or a sub-page.
  import Icon from '../Icon.svelte';
  import { formatValue } from '../model/format';
  import { buildLeaf, type LinkItem } from '../model/model';
  import { parentPath } from '../model/schema';
  import { useSession } from '../shared.svelte';
  let { link }: { link: LinkItem } = $props();
  const session = useSession();
  // Its summary (ui.summary): the value as its own readout would show it.
  const summary = $derived.by(() => {
    const p = link.summary;
    const v = p && session.store.get(p);
    const s = p && session.schemaAt(p);
    if (v === undefined || v === null || v === '') return '';
    if (typeof v === 'boolean') return session.t(v ? 'On' : 'Off');
    if (!s) return String(v);
    const leaf = buildLeaf(p.slice(p.lastIndexOf('/') + 1), p, s, parentPath(p));
    return leaf.options?.find((o) => o.value === v)?.label ?? formatValue(v, leaf);
  });
</script>

<a class="link" href="#{link.path}" title={link.description}>
  {#if link.icon}<Icon name={link.icon} />{/if}
  <span class="name">
    {link.label}
    {#if link.remote && link.label !== link.name}<small>{link.name}</small>{/if}
    {#if summary}<small class="desc">{summary}</small>{/if}
    {#if link.description && !summary}<small class="desc">{link.description}</small>{/if}
  </span>
  {#if link.remote}
    <span class="dot" class:off={!link.online}></span><span class="status">{session.t(link.online ? 'online' : 'offline')}</span>
  {/if}
  <Icon name="right" />
</a>

<style>
  .link {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--control);
    padding: 4px 6px;
    margin: 0 -6px;
    border-radius: 8px;
    color: var(--text);
    text-decoration: none;
  }
  .link:hover {
    background: var(--surface-2);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  small {
    color: var(--muted);
    margin-left: 4px;
  }
  .desc {
    display: block;
    margin: 0;
    font-size: 0.85em;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
  }
  .dot.off {
    background: var(--muted);
  }
  .status {
    color: var(--muted);
    font-size: 0.85em;
  }
</style>
