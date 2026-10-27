<script lang="ts">
  // The menu (DESIGN.md §6.3): the entries of the node shown, a drawer on a
  // narrow screen, and the switch for nodes as tabs (§6.5) when `tabs` is
  // its state.
  import Icon from './Icon.svelte';
  import type { MenuEntry } from './model/menu';
  import { useSession } from './shared.svelte';

  let {
    menu,
    current,
    open,
    close,
    tabs,
    toggle,
  }: { menu: MenuEntry[]; current?: MenuEntry; open: boolean; close: () => void; tabs?: boolean; toggle: () => void } = $props();
  const session = useSession();
  const t = (text: string, vars?: Record<string, string | number>) => session.t(text, vars);
  const inside = (e: MenuEntry, x?: MenuEntry): boolean => !!e.children?.some((c) => c === x || inside(c, x));
  // An entry's sub-entries fold and unfold with its chevron; they start
  // unfolded while its page, or one of theirs, is open.
  const unfolded: Record<string, boolean> = $state({});
  const opened = (e: MenuEntry) => unfolded[e.href!] ?? (current === e || inside(e, current));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<nav class="side" class:open aria-label={t('Menu')} onclick={(e) => (e.target as Element).closest('a') && close()}>
  {@render list(menu, 0)}
  {#if tabs !== undefined}
    <hr />
    <label class="pref">
      <span class="ic"><Icon name="layers" /></span>{t('Nodes as tabs')}
      <input type="checkbox" role="switch" checked={tabs} onchange={toggle} />
    </label>
  {/if}
</nav>

<!-- Entries, a group's under its heading; sub-entries under their entry
     while it is unfolded. -->
{#snippet list(es: MenuEntry[], depth: number)}
  {#each es as e, i (i)}
    {#if !depth && i && es[i - 1].href?.startsWith('#/v/') && !e.href?.startsWith('#/v/')}<hr />{/if}
    {#if e.href}
      {@render entry(e)}
      {#if e.children && opened(e)}<div class="sub">{@render list(e.children, depth + 1)}</div>{/if}
    {:else}
      <p class="group">{e.label}</p>
      <div class="sub">{@render list(e.children!, depth + 1)}</div>
    {/if}
  {/each}
{/snippet}

{#snippet entry(e: MenuEntry)}
  <div class="ent">
    <a href={e.href} aria-current={current === e ? 'page' : undefined}>
      <span class="ic">{#if e.icon}<Icon name={e.icon} />{/if}</span>{e.label}
      {#if e.online === false}<i class="off" title={t('Offline')}></i>{/if}
    </a>
    {#if e.children}
      <button type="button" class="quiet" class:up={opened(e)} aria-expanded={opened(e)} aria-label={t('Sections of {label}', { label: e.label })} onclick={() => (unfolded[e.href!] = !opened(e))}><Icon name="down" /></button>
    {/if}
  </div>
{/snippet}

<style>
  .side {
    position: sticky;
    top: 52px;
    flex: none;
    width: 230px;
    height: calc(100vh - 52px);
    overflow-y: auto;
    padding: 12px 8px;
    background: var(--surface);
    border-right: 1px solid var(--border);
  }
  .side a {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 38px;
    padding: 0 10px;
    border-radius: 8px;
    color: var(--text);
    text-decoration: none;
  }
  .side a:hover {
    background: var(--surface-2);
  }
  .ent {
    display: flex;
  }
  .ent a {
    flex: 1;
    min-width: 0;
  }
  .ent button {
    min-height: 0;
    padding: 0 10px;
    color: var(--muted);
  }
  .ent .up :global(svg) {
    transform: rotate(180deg);
  }
  .side a[aria-current] {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
  .ic {
    width: 1.15em;
    display: flex;
  }
  .pref {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 38px;
    padding: 0 10px;
    cursor: pointer;
  }
  .pref input {
    margin-left: auto;
  }
  .sub a {
    padding-left: 38px;
    min-height: 34px;
  }
  .sub .sub a {
    padding-left: 56px;
  }
  .sub .group {
    margin-left: 38px;
  }
  .side hr {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 8px 10px;
  }
  .group {
    margin: 14px 10px 4px;
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .off {
    margin-left: auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  @media (max-width: 800px) {
    .side {
      position: fixed;
      left: 0;
      z-index: 6;
      transform: translateX(-100%);
      transition: transform 0.2s;
    }
    .side.open {
      transform: none;
      box-shadow: 0 10px 40px #0005;
    }
  }
  @media (max-width: 640px) {
    .side {
      top: 0;
      height: 100dvh;
    }
  }
</style>
