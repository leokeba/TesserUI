<script lang="ts">
  import { untrack } from 'svelte';
  import { compareVersions, provideSession } from './shared.svelte';
  import Icon from './Icon.svelte';
  import { humanize } from './model/format';
  import { isUnder } from './model/schema';
  import Page from './Page.svelte';
  import type { Session } from './store/session.svelte';
  import ViewPage from './ViewPage.svelte';

  // full: the UI is the whole page (the node's own), not embedded.
  let { session, full = false }: { session: Session; full?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  provideSession(session);
  // svelte-ignore state_referenced_locally
  const { config, store } = session;
  const t = (text: string, vars?: Record<string, string | number>) => session.t(text, vars);

  // Routes: #/<path> is the page of the node at that path (#/peers/<name>
  // for a peer behind a UI host), #/v/<id> a view page (DESIGN.md §7.6, §8).
  // With memory routing, the route stays inside the UI and its links are
  // intercepted; the page keeps its URL.
  const memory = config.routing === 'memory';
  const home = config.path ?? '/';
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
  const views = $derived(home === '/' ? session.views : null);
  const route = $derived.by(() => {
    const h = decodeURIComponent(hash.slice(1));
    if (h.startsWith('/v/') && views) return { view: h.slice(3), path: home };
    const path = h.replace(/\/+$/, '') || home;
    return { view: null as string | null, path: isUnder(path, home) ? path : home };
  });
  // View pages come first: an empty route opens the first one.
  $effect(() => {
    if (hash || !views?.length) return;
    if (memory) hash = `#/v/${views[0].id}`;
    else location.replace(`#/v/${views[0].id}`);
  });
  // Errors are cleared by navigation (and only by it: untracked).
  $effect(() => {
    void route;
    untrack(() => store.clearErrors());
  });

  const deviceLabel = $derived.by(() => {
    void session.schemaVersion;
    return session.root.label ?? config.title ?? 'TesserUI';
  });
  $effect(() => {
    if (full) document.title = deviceLabel;
  });
  const theme = Object.entries(config.theme ?? {})
    .map(([k, v]) => `--${k}:${v}`)
    .join(';');

  const stateText = $derived(
    session.state === 'open'
      ? t({ ws: 'Live', http: 'Polling', serial: 'USB' }[session.kind ?? 'ws'])
      : t(session.state === 'connecting' ? 'Connecting…' : 'Disconnected'),
  );
  const tooOld = $derived(!!config.minVersion && compareVersions(__VERSION__, config.minVersion) < 0);

  let token = $state('');
  // The login action's text fields (DESIGN.md §7.4).
  const loginFields = $derived(
    Object.entries(session.login?.schema.params?.children ?? {})
      .filter(([, c]) => c.type === 'string')
      .map(([name, c]) => ({ name, label: c.label ?? humanize(name), secret: !!c.secret })),
  );
  let creds: Record<string, string> = $state({});
  let loginError = $state('');
  async function authenticate(e: SubmitEvent) {
    e.preventDefault();
    if (!session.login) return session.setToken(token);
    loginError = (await session.signIn(creds)) ?? '';
    if (!loginError) creds = {};
  }
  let serialError = $state('');
  const hasSerial = 'serial' in navigator;
  async function connectUsb() {
    try {
      const port = await (navigator as unknown as { serial: { requestPort(): Promise<never> } }).serial.requestPort();
      session.useSerial(port);
    } catch (e) {
      serialError = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="tesserui" class:full style={theme} onclick={intercept}>
  {#if config.header !== false}
    <header class="top">
      <a class="brand" href="#{home}">{deviceLabel}</a>
      {#if views?.length}
        <nav aria-label={t('Pages')}>
          {#each views as v (v.id)}
            <a href="#/v/{v.id}" aria-current={route.view === v.id ? 'page' : undefined}>{v.label}</a>
          {/each}
          <a href="#/" aria-current={route.view === null ? 'page' : undefined}>{t('Device')}</a>
        </nav>
      {/if}
      <span class="state {session.state}" role="status"><i></i>{stateText}</span>
      {#if session.signedIn}
        <button type="button" class="quiet" onclick={() => session.signOut()}><Icon name="lock" /> {t('Sign out')}</button>
      {:else if session.login}
        <button type="button" class="quiet" onclick={() => (session.needToken = true)}><Icon name="lock" /> {t('Sign in')}</button>
      {/if}
    </header>
  {/if}

  {#if tooOld}
    <p class="banner warn">
      <Icon name="alert" />
      {t('This node expects TesserUI {min} or later; this interface is {version}.', { min: config.minVersion!, version: __VERSION__ })}
    </p>
  {/if}
  {#if session.loaded && session.state !== 'open'}
    <p class="banner warn" role="alert"><Icon name="alert" /> {t('The connection to the node is lost. Reconnecting…')}</p>
  {/if}

  <main>
    {#if config.transport === 'serial' && !session.kind}
      <section class="card connect">
        <h2><Icon name="usb" /> {t('Connect a node over USB')}</h2>
        {#if hasSerial}
          <p>{t('Plug in a board running TesserAPI with a serial transport, then choose its port.')}</p>
          <button class="primary" onclick={connectUsb}>{t('Choose a port')}</button>
          {#if serialError}<p class="error">{serialError}</p>{/if}
        {:else}
          <p>{t('Web Serial needs a Chromium-based browser (Chrome, Edge, Opera).')}</p>
        {/if}
      </section>
    {:else if !session.loaded || (!hash && views?.length)}
      <p class="muted center">{session.state === 'open' ? t('Loading…') : stateText}</p>
    {:else if route.view !== null}
      {@const page = views?.find((v) => v.id === route.view)}
      {#if page}
        {#key page.id}<ViewPage {page} />{/key}
      {:else}
        <p class="muted center">{t('No view page named “{id}”.', { id: route.view })}</p>
      {/if}
    {:else}
      {#key route.path}<Page path={route.path} {home} />{/key}
    {/if}
  </main>

  {#if session.needToken}
    <div class="scrim"></div>
    <dialog open aria-labelledby="token-title">
      <form method="dialog" onsubmit={authenticate}>
        <h2 id="token-title"><Icon name="lock" /> {t('Authentication')}</h2>
        {#if session.login}
          {#each loginFields as f, i (f.name)}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              autofocus={i === 0}
              type={f.secret ? 'password' : 'text'}
              bind:value={creds[f.name]}
              placeholder={f.label}
              aria-label={f.label}
              autocomplete={f.secret ? 'current-password' : 'username'}
            />
          {/each}
          {#if loginError}<p class="error" role="alert">{loginError}</p>{/if}
        {:else}
          <p>{t('This node needs a token to make changes.')}</p>
          <input type="password" bind:value={token} aria-label={t('Token')} autocomplete="current-password" />
        {/if}
        <div class="actions">
          <button type="button" class="quiet" onclick={() => (session.needToken = false)}>{t('Cancel')}</button>
          <button class="primary">{session.login ? t('Sign in') : t('Save')}</button>
        </div>
      </form>
    </dialog>
  {/if}

  <div class="toasts" aria-live="polite">
    {#each store.toasts as toast (toast.id)}<div class="toast">{toast.text}</div>{/each}
  </div>
</div>

<style>
  :global {
    .tesserui {
      --bg: #f3f4f6;
      --surface: #fff;
      --surface-2: #eceef2;
      --text: #1a1d23;
      --muted: #5d6675;
      --border: #d9dde3;
      --accent: #2f5bd3;
      --on-accent: #fff;
      --danger: #c62f2f;
      --ok: #1f9d55;
      --warn: #b7791f;
      --radius: 10px;
      --gap: 16px;
      --control: 36px;
      color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
      .tesserui {
        --bg: #101318;
        --surface: #191d24;
        --surface-2: #232933;
        --text: #e5e8ed;
        --muted: #98a2b1;
        --border: #2d343f;
        --accent: #7393ff;
        --on-accent: #0c1022;
        --danger: #f06a6a;
        --ok: #4cc38a;
        --warn: #e0b04f;
        color-scheme: dark;
      }
    }
    @media (max-width: 640px) {
      .tesserui {
        --control: 44px;
      }
    }
    .tesserui,
    .tesserui * {
      box-sizing: border-box;
    }
    .tesserui {
      background: var(--bg);
      color: var(--text);
      font:
        15px/1.45 system-ui,
        -apple-system,
        'Segoe UI',
        Roboto,
        sans-serif;
      -webkit-text-size-adjust: 100%;
    }
    .tesserui.full {
      min-height: 100vh;
    }
    .tesserui a {
      color: var(--accent);
    }
    .tesserui h2,
    .tesserui h3 {
      margin: 0;
      font-size: 1rem;
    }
    .tesserui input,
    .tesserui select,
    .tesserui textarea,
    .tesserui button {
      font: inherit;
      color: inherit;
      min-height: var(--control);
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) - 4px);
      background: var(--surface-2);
      padding: 0 10px;
      min-width: 0;
    }
    .tesserui textarea {
      padding: 8px 10px;
      width: 100%;
      resize: vertical;
    }
    .tesserui input:focus-visible,
    .tesserui select:focus-visible,
    .tesserui textarea:focus-visible,
    .tesserui button:focus-visible,
    .tesserui a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .tesserui button {
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: var(--surface);
      white-space: nowrap;
    }
    .tesserui button:hover:not(:disabled) {
      border-color: var(--muted);
    }
    .tesserui button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--on-accent);
    }
    .tesserui button.danger {
      color: var(--danger);
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    }
    .tesserui button.danger:hover:not(:disabled) {
      background: var(--danger);
      border-color: var(--danger);
      color: #fff;
    }
    .tesserui button.quiet {
      background: none;
      border-color: transparent;
    }
    .tesserui :disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .tesserui input[type='range'] {
      accent-color: var(--accent);
      padding: 0;
      border: 0;
      background: none;
    }
    .tesserui input[type='checkbox'],
    .tesserui input[type='radio'] {
      accent-color: var(--accent);
      width: 20px;
      height: 20px;
      min-height: 0;
      margin: 0;
    }
    .tesserui input[role='switch'] {
      appearance: none;
      width: 44px;
      height: 26px;
      border-radius: 13px;
      background: var(--border);
      border: 0;
      position: relative;
      cursor: pointer;
      transition: background 0.15s;
    }
    .tesserui input[role='switch']::before {
      content: '';
      position: absolute;
      inset: 3px auto 3px 3px;
      width: 20px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px #0004;
      transition: transform 0.15s;
    }
    .tesserui input[role='switch']:checked {
      background: var(--accent);
    }
    .tesserui input[role='switch']:checked::before {
      transform: translateX(18px);
    }
    .tesserui .muted {
      color: var(--muted);
    }
    .tesserui .center {
      text-align: center;
      padding: 48px 16px;
    }
    .tesserui .error {
      color: var(--danger);
      font-size: 0.9em;
      margin: 4px 0 0;
    }
    .tesserui .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      min-width: 0;
    }
    .tesserui .banner {
      margin: 0;
      padding: 10px 16px;
      display: flex;
      gap: 8px;
      align-items: center;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }
    .tesserui .banner.warn {
      color: var(--warn);
    }
  }

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
    color: var(--text);
    text-decoration: none;
  }
  nav {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    flex: 1;
  }
  nav a {
    padding: 6px 10px;
    border-radius: 8px;
    color: var(--muted);
    text-decoration: none;
    white-space: nowrap;
  }
  nav a[aria-current] {
    background: var(--surface-2);
    color: var(--text);
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
  main {
    padding: var(--gap);
    max-width: 1400px;
    margin: 0 auto;
  }
  .connect {
    max-width: 440px;
    margin: 48px auto;
    display: grid;
    gap: 12px;
    justify-items: start;
  }
  .connect p {
    margin: 0;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 5;
    background: #0008;
    backdrop-filter: blur(2px);
  }
  dialog {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    width: min(360px, calc(100% - 32px));
    position: fixed;
    inset: 0;
    margin: auto;
    box-shadow: 0 10px 40px #0005;
    z-index: 6;
  }
  dialog form {
    display: grid;
    gap: 12px;
  }
  dialog p {
    margin: 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .toasts {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: grid;
    gap: 8px;
    z-index: 4;
    width: max-content;
    max-width: calc(100% - 32px);
  }
  .toast {
    background: var(--text);
    color: var(--bg);
    padding: 10px 16px;
    border-radius: var(--radius);
    box-shadow: 0 4px 16px #0004;
  }
</style>
