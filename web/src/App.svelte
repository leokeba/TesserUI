<script lang="ts" module>
  import type { Applied } from './store/session.svelte';

  // A tab: a node of this UI's session (path), or of another connection of
  // a launcher's workspace, opened by `go` (DESIGN.md §6.5, §9.7.2).
  export interface Tab {
    key: string;
    label: string;
    path?: string;
    off?: boolean;
    title?: string;
    mark?: Applied;
    go?: () => void;
  }
</script>

<script lang="ts">
  import { setContext, untrack, type Snippet } from 'svelte';
  import { compareVersions, PLACE, provideSession } from './shared.svelte';
  import Icon from './Icon.svelte';
  import Item from './Item.svelte';
  import { buildMenu, parseRoute, viewHref, type MenuEntry } from './model/menu';
  import { isUnder } from './model/schema';
  import Menu from './Menu.svelte';
  import Page from './Page.svelte';
  import Toasts from './Toasts.svelte';
  import { connectScreen } from './widgets/registry.svelte';
  import SignIn from './SignIn.svelte';
  import type { Session } from './store/session.svelte';
  import { storageGet, storageSet } from './store/storage';
  import ViewPage from './ViewPage.svelte';

  // full: the UI is the whole page (the node's own), not embedded. A
  // launcher's workspace adds the other connections' tabs `around` this
  // one's, buttons to `add` a connection and `close` this one, and its own
  // `connect` screen, and what it shows over the page (`children`: the
  // claim step, §9.7.3).
  // Whoever mounts it draws Theme.svelte first (embed.ts, the launcher's
  // workspace), so that this component's own rules come after the theme's.
  let {
    session,
    full = false,
    around,
    add,
    close,
    connect,
    children,
  }: { session: Session; full?: boolean; around?: [Tab[], Tab[]]; add?: () => void; close?: () => void; connect?: Snippet; children?: Snippet } = $props();
  // svelte-ignore state_referenced_locally
  provideSession(session);
  // svelte-ignore state_referenced_locally
  const { config, store } = session;
  const t = (text: string, vars?: Record<string, string | number>) => session.t(text, vars);

  // The route (model/menu.ts, parseRoute). With memory routing, it stays
  // inside the UI and its links are intercepted; the page keeps its URL.
  const memory = config.routing === 'memory';
  // top: where the UI starts and doesn't go above.
  const top = config.path ?? '/';
  let hash = $state(memory ? '' : location.hash);
  if (!memory) {
    const changed = () => (hash = location.hash);
    addEventListener('hashchange', changed);
    $effect(() => () => removeEventListener('hashchange', changed));
  }
  function intercept(e: MouseEvent) {
    const href = (e.target as Element).closest?.('a')?.getAttribute('href');
    if (memory && href?.startsWith('#')) {
      e.preventDefault();
      hash = href;
    }
  }
  const route = $derived(parseRoute(hash, top));
  setContext(PLACE, {
    get sub() {
      return route.sub;
    },
    go: (href: string) => (memory ? (hash = href) : (location.hash = href)),
  });
  // svelte-ignore state_referenced_locally
  const menuOn = (config.menu ?? full) && config.header !== false;

  // Nodes as tabs (DESIGN.md §6.5): the node, then the remote nodes of its
  // tree. The tab the route is in is the node whose menu shows.
  const TABS = 'tesserui:tabs';
  const stored = storageGet(TABS);
  let tabsOn = $state(stored ? stored === '1' : config.tabs !== false);
  const own = $derived(menuOn && top === '/' && session.loaded ? session.tabs() : []);
  const nodes = $derived(own.slice(1));
  const tabs = $derived.by((): Tab[] | null => {
    void session.schemaVersion;
    const list = [
      ...(around?.[0] ?? []),
      ...(tabsOn || around ? own : []).map((path) => {
        const s = session.schemaAt(path)!;
        return { key: path, path, label: session.nodeLabel(path), off: s.online === false, title: [s.id, s.route].filter(Boolean).join(' · '), mark: session.all ? session.applied[path] : undefined };
      }),
      ...(around?.[1] ?? []),
    ];
    return list.length > (around ? 0 : 1) ? list : null;
  });
  const home = $derived(tabs?.findLast((n) => n.path && isUnder(route.path, n.path))?.path ?? top);
  // Remote nodes' labels are in their own root schemas, and their views at
  // their /_ui: each read once, a label once per advertised hash (a node
  // renamed advertises another).
  const asked = new Set<string>();
  $effect(() => {
    if (!tabs) return;
    const ui = home + '/_ui';
    const want = [ui, ...nodes.filter((p) => !session.schemaAt(p)?.tree && !session.isOffline(p))].filter((p) => p !== '//_ui');
    untrack(async () => {
      for (const p of want) {
        const key = p === ui ? p : p + ' ' + session.schemaAt(p)?.schema;
        if (asked.has(key)) continue;
        asked.add(key);
        if (p !== ui) await session.fetchSchema(p, 0);
        else if (await session.ensure(home, 1)) await session.loadViews(home);
        // Offline: no views until it's back (asked again then).
        else (session.views[home] = []), asked.delete(p);
      }
    });
  });

  const views = $derived(top === '/' ? session.views[home] : undefined);
  // The menu (DESIGN.md §6.3): views, the status, then one entry per
  // object or remote node of the start page, each a page of its own. It
  // waits for the views, which decide the landing page.
  const menu = $derived.by(() => {
    const s = menuOn && session.loaded && (views || top !== '/') ? session.pageSchema(home) : null;
    return s ? buildMenu(s, home, views ?? null, t) : null;
  });
  const all = (es: MenuEntry[]): MenuEntry[] => es.flatMap((e) => [e, ...all(e.children ?? [])]);
  const flat = $derived(menu ? all(menu).filter((e) => e.href) : []);
  // The entry shown: the deepest one the route is in.
  const current = $derived.by(() => {
    const at = route.view !== null ? viewHref(route.path, route.view) : `#${route.path}`;
    let best: MenuEntry | undefined;
    for (const e of flat) if ((at === e.href || at.startsWith(e.href + '/')) && e.href!.length > (best?.href!.length ?? 0)) best = e;
    return best;
  });
  let drawer = $state(false);
  // The node menu (DESIGN.md §6.7): the shown node's node-wide actions.
  const acts = $derived(session.loaded ? session.nodeActions(home) : []);
  let actsOpen = $state(false);
  $effect(() => {
    void [route, home];
    actsOpen = false;
  });
  // The tabs scroll sideways when they overflow (a narrow screen's second
  // row, §6.2): the current one is brought into view, centred, without
  // scrolling the page as scrollIntoView() would. An edge with more tabs
  // beyond it fades them out (--l, --r: the fade's width).
  let strip: HTMLElement | undefined = $state();
  function edges() {
    const s = strip;
    if (!s) return;
    s.style.setProperty('--l', s.scrollLeft > 1 ? '32px' : '0px');
    s.style.setProperty('--r', s.scrollLeft + s.clientWidth < s.scrollWidth - 1 ? '32px' : '0px');
  }
  $effect(() => {
    void [home, route];
    const a = strip?.querySelector('[aria-current]');
    if (!strip || !a) return;
    const n = strip.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    if (r.left < n.left || r.right > n.right) strip.scrollLeft += r.left - n.left - (n.width - r.width) / 2;
  });
  $effect(() => {
    void [tabs, views];
    edges();
  });
  addEventListener('resize', edges);
  $effect(() => () => removeEventListener('resize', edges));
  // Pages come in menu order: an empty route opens the first one, and so
  // does the start page when it has nothing of its own.
  const first = $derived(flat[0]?.href ?? (views?.length ? viewHref(home, views[0].id) : undefined));
  // A view that no longer exists (renamed, or gone with a firmware update)
  // lands there too.
  const landing = $derived(
    !hash ||
      (session.loaded && route.view !== null && !!views && !views.some((v) => v.id === route.view)) ||
      (!!menu && route.view === null && route.path === home && !flat.some((e) => e.href === `#${home}`)),
  );
  $effect(() => {
    if (!landing || !first) return;
    if (memory) hash = first;
    else location.replace(first);
  });
  // Errors are cleared by navigation (and only by it: untracked).
  $effect(() => {
    void route;
    untrack(() => store.clearErrors());
  });

  const deviceLabel = $derived.by(() => {
    void session.schemaVersion;
    return session.nodeLabel('/');
  });
  $effect(() => {
    if (full) document.title = deviceLabel;
  });
  const theme = Object.entries(config.theme ?? {})
    .map(([k, v]) => `--${k}:${v}`)
    .join(';');

  const stateText = $derived(
    session.state === 'open'
      ? t({ ws: 'Live', http: 'Polling', serial: 'USB', ble: 'Bluetooth' }[session.kind ?? 'ws'])
      : t(session.state === 'connecting' ? 'Connecting…' : 'Disconnected'),
  );
  const tooOld = $derived(!!config.minVersion && compareVersions(__VERSION__, config.minVersion) < 0);

</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="tesserui" class:full style={theme} onclick={intercept}>
  {#if config.header !== false}
    <header class="top">
      {#if menu}
        <button type="button" class="quiet burger" aria-label={t('Menu')} aria-expanded={drawer} onclick={() => (drawer = !drawer)}><Icon name="menu" /></button>
      {/if}
      {#if tabs}
        <!-- On a narrow screen, the shown node's label, and the tabs below. -->
        <span class="node">{tabs.find((n) => n.path === home)?.label}</span>
        <div class="bar">
        <nav class="tabs" aria-label={t('Nodes')} bind:this={strip} onscroll={edges}>
          {#each tabs as n (n.key)}
            {@const a = n.mark}
            <a
              href="#{n.path ?? ''}"
              class:brand={n.path === '/'}
              title={n.title || undefined}
              aria-current={home === n.path ? 'page' : undefined}
              onclick={(e) => n.go && (e.preventDefault(), n.go())}
            >
              {n.label}{#if n.off}<i class="off" title={t('Offline')}></i>{/if}
              {#if a && a.state !== 'offline'}<span class="mark {a.state}" title={a.text ?? t(a.state === 'done' ? 'Applied' : 'Absent')}><Icon name={{ done: 'check', absent: 'minus', refused: 'x' }[a.state]} /></span>{/if}
            </a>
          {/each}
        </nav>
        {#if add}<button type="button" class="quiet" title={t('Another node')} aria-label={t('Another node')} onclick={add}><Icon name="plus" /></button>{/if}
        <!-- Apply to all (DESIGN.md §6.6): highlighted while on. -->
        <button type="button" class="quiet all" aria-pressed={session.all} title={t('Apply to all')} aria-label={t('Apply to all')} onclick={() => ((session.all = !session.all), (session.applied = {}))}><Icon name="broadcast" /></button>
        </div>
      {:else}
        <a class="brand" href={first ?? `#${top}`}>{deviceLabel}</a>
      {/if}
      {#if views?.length && !menu}
        <nav class="tabs bar" aria-label={t('Pages')} bind:this={strip} onscroll={edges}>
          {#each views as v (v.id)}
            <a href="#/v/{v.id}" aria-current={route.view === v.id ? 'page' : undefined}>{v.label}</a>
          {/each}
          <a href="#/" aria-current={route.view === null ? 'page' : undefined}>{t('Device')}</a>
        </nav>
      {/if}
      {#if session.kind}
        {@const quiet = session.store.noEvents && session.state === 'open'}
        <span class="state {session.state}" class:quiet role="status" title={session.store.noEvents ? t('The node refused its events subscription (other pages hold its streams): toasts from outside this page wait for one. Asked again every minute.') : undefined}>
          <i></i><span class="lab">{stateText}{#if quiet}, {t('no events')}{/if}</span>
        </span>
      {/if}
      {#if close && session.kind}
        <button type="button" class="quiet" title={t('Close this connection')} aria-label={t('Close this connection')} onclick={close}><Icon name="x" /></button>
      {/if}
      {#if session.signedIn}
        <button type="button" class="quiet" onclick={() => session.signOut()}><Icon name="lock" /> <span class="lab">{t('Sign out')}</span></button>
      {:else if session.login}
        <button type="button" class="quiet" onclick={() => (session.needToken = true)}><Icon name="lock" /> <span class="lab">{t('Sign in')}</span></button>
      {/if}
      {#if acts.length}
        <button type="button" class="quiet more" aria-label={t('Node actions')} title={t('Node actions')} aria-expanded={actsOpen} onclick={() => (actsOpen = !actsOpen)}><Icon name="more" /></button>
        {#if actsOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="veil" onclick={() => (actsOpen = false)}></div>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="acts" onclick={(e) => (e.target as Element).closest('button') && (actsOpen = false)}>{#each acts as a (a.path)}<Item item={a} />{/each}</div>
        {/if}
      {/if}
    </header>
  {/if}

  {#if tooOld}
    <p class="banner warn">
      <Icon name="alert" />
      {t('This node expects TesserUI {min} or later; this interface is {version}.', { min: config.minVersion!, version: __VERSION__ })}
    </p>
  {/if}
  {#if session.restarting}
    <div class="scrim"></div>
    <p class="restarting card" role="alert"><Icon name="refresh" /> {t('Restarting… reconnecting')}</p>
  {:else if session.loaded && session.state !== 'open'}
    <p class="banner warn" role="alert"><Icon name="alert" /> {t('The connection to the node is lost. Reconnecting…')}</p>
  {/if}

  <div class="body">
  {#if menu}
    <Menu {menu} {current} open={drawer} close={() => (drawer = false)} tabs={nodes.length && !around ? tabsOn : undefined} toggle={() => storageSet(TABS, (tabsOn = !tabsOn) ? '1' : '0')} />
    {#if drawer}<div class="scrim drawer" onclick={() => (drawer = false)}></div>{/if}
  {/if}
  <main>
    {#if !session.kind && (config.transport === 'serial' || config.transport === 'ble')}
      {#if connect}{@render connect()}{:else}{@const Connect = connectScreen()}<Connect />{/if}
    {:else if !session.loaded || (landing && first) || (!!tabs && !views)}
      <p class="muted center">{session.state === 'open' ? t('Loading…') : stateText}</p>
    {:else if route.view !== null}
      {@const page = views?.find((v) => v.id === route.view)}
      {#if page}
        {#key page}<ViewPage {page} node={home} />{/key}
      {:else}
        <p class="muted center">{t('No view page named “{id}”.', { id: route.view })}</p>
      {/if}
    {:else}
      {#key route.path}<Page path={route.path} {home} menu={!!menu} />{/key}
    {/if}
  </main>
  </div>

  {#if session.needToken}
    <div class="scrim"></div>
    <SignIn />
  {/if}

  {@render children?.()}
  <Toasts />
</div>

<style>
  .top {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    min-height: 52px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .brand {
    font-weight: 650;
  }
  .top > .brand {
    color: var(--text);
    text-decoration: none;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }
  .tabs {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    min-width: 0;
    mask-image: linear-gradient(90deg, #0000, #000 var(--l, 0px), #000 calc(100% - var(--r, 0px)), #0000);
  }
  .all {
    margin-left: auto;
  }
  .node {
    display: none;
  }
  .state.quiet i {
    outline: 2px solid var(--warn);
    outline-offset: 1px;
  }
  .tabs a {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 8px;
    color: var(--muted);
    text-decoration: none;
    white-space: nowrap;
  }
  .tabs a[aria-current] {
    background: var(--surface-2);
    color: var(--text);
  }
  .veil {
    position: fixed;
    inset: 0;
  }
  .acts {
    position: absolute;
    top: calc(100% + 4px);
    right: 8px;
    display: grid;
    gap: 8px;
    min-width: 180px;
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 10px 30px #0003;
  }
  .acts :global(button) {
    width: 100%;
  }
  .state {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
    color: var(--muted);
  }
  .state i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--danger);
  }
  .state.open i {
    background: var(--ok);
  }
  .state.connecting i {
    background: var(--warn);
  }
  .body {
    display: flex;
    align-items: flex-start;
  }
  main {
    padding: var(--gap);
    max-width: 1400px;
    margin: 0 auto;
    flex: 1;
    min-width: 0;
  }
  .top [aria-pressed='true'] {
    color: var(--accent);
  }
  .top .all[aria-pressed='true'] {
    background: var(--accent);
    color: var(--on-accent);
  }
  .mark {
    display: flex;
    color: var(--ok);
  }
  .mark.absent {
    color: var(--muted);
  }
  .mark.refused {
    color: var(--danger);
  }
  .off {
    margin-left: auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  .burger {
    display: none;
    padding: 0 8px;
  }
  @media (max-width: 800px) {
    .burger {
      display: inline-flex;
      align-items: center;
    }
  }
  /* A phone: the header's first row is the menu, the node shown and the
     connection (a dot, its text for screen readers); the tabs get the
     second, full width (DESIGN.md §6.2). */
  @media (max-width: 640px) {
    .top {
      gap: 8px;
      padding: 0 8px;
    }
    .node {
      display: block;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 650;
    }
    .bar {
      order: 1;
      flex-basis: calc(100% + 16px);
      margin: 0 -8px;
      padding: 0 8px 6px;
    }
    .tabs {
      scrollbar-width: none;
    }
    .lab {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 5;
    background: #0008;
    backdrop-filter: blur(2px);
  }
  .restarting {
    position: fixed;
    inset: 40% 16px auto;
    z-index: 6;
    margin: 0 auto;
    max-width: 320px;
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;
  }
</style>
