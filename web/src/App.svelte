<script lang="ts">
  import { untrack } from 'svelte';
  import { app, compareVersions } from './shared.svelte';
  import Icon from './Icon.svelte';
  import Page from './Page.svelte';
  import ViewPage from './ViewPage.svelte';

  const session = app.session;
  const store = session.store;

  // Routes: #/<path> is the page of the node at that path (#/peers/<name>
  // for a peer behind a UI host), #/v/<id> a view page (DESIGN.md §7.6, §8).
  let hash = $state(location.hash);
  addEventListener('hashchange', () => (hash = location.hash));
  const route = $derived.by(() => {
    const h = decodeURIComponent(hash.slice(1));
    if (h.startsWith('/v/')) return { view: h.slice(3), path: '/' };
    return { view: null as string | null, path: h.replace(/\/+$/, '') || '/' };
  });
  // View pages come first: an empty route opens the first one.
  $effect(() => {
    if (!hash && session.views?.length) location.replace(`#/v/${session.views[0].id}`);
  });
  // Errors are cleared by navigation (and only by it: untracked).
  $effect(() => {
    void route;
    untrack(() => store.clearErrors());
  });

  const deviceLabel = $derived.by(() => {
    void session.schemaVersion;
    return session.root.label ?? 'TesserUI';
  });
  $effect(() => {
    document.title = deviceLabel;
  });

  const stateText = $derived(
    session.state === 'open'
      ? { ws: 'Live', http: 'Polling', serial: 'USB' }[session.kind ?? 'ws']
      : session.state === 'connecting'
        ? 'Connecting…'
        : 'Disconnected',
  );
  const tooOld = $derived(!!session.config.minVersion && compareVersions(__VERSION__, session.config.minVersion) < 0);

  let token = $state('');
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

<header class="top">
  <a class="brand" href="#/">{deviceLabel}</a>
  {#if session.views?.length}
    <nav aria-label="Pages">
      {#each session.views as v (v.id)}
        <a href="#/v/{v.id}" aria-current={route.view === v.id ? 'page' : undefined}>{v.label}</a>
      {/each}
      <a href="#/" aria-current={route.view === null ? 'page' : undefined}>Device</a>
    </nav>
  {/if}
  <span class="state {session.state}" role="status"><i></i>{stateText}</span>
</header>

{#if tooOld}
  <p class="banner warn">
    <Icon name="alert" /> This node expects TesserUI {session.config.minVersion} or later; this interface is {__VERSION__}.
  </p>
{/if}

<main>
  {#if session.config.transport === 'serial' && !session.kind}
    <section class="card connect">
      <h2><Icon name="usb" /> Connect a node over USB</h2>
      {#if hasSerial}
        <p>Plug in a board running TesserAPI with a serial transport, then choose its port.</p>
        <button class="primary" onclick={connectUsb}>Choose a port</button>
        {#if serialError}<p class="error">{serialError}</p>{/if}
      {:else}
        <p>Web Serial needs a Chromium-based browser (Chrome, Edge, Opera).</p>
      {/if}
    </section>
  {:else if !session.loaded || (!hash && session.views?.length)}
    <p class="muted center">{session.state === 'open' ? 'Loading…' : stateText}</p>
  {:else if route.view !== null}
    {@const page = session.views?.find((v) => v.id === route.view)}
    {#if page}
      {#key page.id}<ViewPage {page} />{/key}
    {:else}
      <p class="muted center">No view page named “{route.view}”.</p>
    {/if}
  {:else}
    {#key route.path}<Page path={route.path} />{/key}
  {/if}
</main>

{#if session.needToken}
  <dialog open aria-labelledby="token-title">
    <form
      method="dialog"
      onsubmit={(e) => {
        e.preventDefault();
        session.setToken(token);
      }}
    >
      <h2 id="token-title"><Icon name="lock" /> Authentication</h2>
      <p>This node needs a token to make changes.</p>
      <input type="password" bind:value={token} aria-label="Token" autocomplete="current-password" />
      <div class="actions">
        <button type="button" class="quiet" onclick={() => (session.needToken = false)}>Cancel</button>
        <button class="primary">Save</button>
      </div>
    </form>
  </dialog>
{/if}

<div class="toasts" aria-live="polite">
  {#each store.toasts as t (t.id)}<div class="toast">{t.text}</div>{/each}
</div>

<style>
  :global {
    :root {
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
      :root {
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
      :root {
        --control: 44px;
      }
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
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
    a {
      color: var(--accent);
    }
    h2,
    h3 {
      margin: 0;
      font-size: 1rem;
    }
    input,
    select,
    textarea,
    button {
      font: inherit;
      color: inherit;
      min-height: var(--control);
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) - 4px);
      background: var(--surface-2);
      padding: 0 10px;
      min-width: 0;
    }
    textarea {
      padding: 8px 10px;
      width: 100%;
      resize: vertical;
    }
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible,
    button:focus-visible,
    a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    button {
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: var(--surface);
      white-space: nowrap;
    }
    button:hover:not(:disabled) {
      border-color: var(--muted);
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--on-accent);
    }
    button.danger {
      background: var(--danger);
      border-color: var(--danger);
      color: #fff;
    }
    button.quiet {
      background: none;
      border-color: transparent;
    }
    :disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    input[type='range'] {
      accent-color: var(--accent);
      padding: 0;
      border: 0;
      background: none;
    }
    input[type='checkbox'],
    input[type='radio'] {
      accent-color: var(--accent);
      width: 20px;
      height: 20px;
      min-height: 0;
      margin: 0;
    }
    input[role='switch'] {
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
    input[role='switch']::before {
      content: '';
      position: absolute;
      inset: 3px auto 3px 3px;
      width: 20px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px #0004;
      transition: transform 0.15s;
    }
    input[role='switch']:checked {
      background: var(--accent);
    }
    input[role='switch']:checked::before {
      transform: translateX(18px);
    }
    .muted {
      color: var(--muted);
    }
    .center {
      text-align: center;
      padding: 48px 16px;
    }
    .error {
      color: var(--danger);
      font-size: 0.9em;
      margin: 4px 0 0;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      min-width: 0;
    }
    .banner {
      margin: 0;
      padding: 10px 16px;
      display: flex;
      gap: 8px;
      align-items: center;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }
    .banner.warn {
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
    z-index: 5;
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
